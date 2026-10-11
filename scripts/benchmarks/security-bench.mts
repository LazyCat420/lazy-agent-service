#!/usr/bin/env node
/**
 * Security regression benchmark for the 2026-10-11 audit fixes.
 *
 * Deterministic (no model, no GPU): attacks the guards directly and fails
 * (exit 1) if any attack lands. Sections:
 *   1. code_interpreter escapes — a random canary is planted in process.env;
 *      no payload may return it, reach `process`/`require`, or stall the host
 *      event loop (lag is measured while each payload runs).
 *   2. SSRF corpus — literal encodings, private-resolving names, mixed DNS
 *      answers, redirect hops, credentials-in-URL; public hosts must pass.
 *   3. /execute key — open when unset, enforced (constant-time) when set.
 *   4. Offload store — results written by one instance are found by another.
 *   5. Reasoning round-trip — the tool turn carries reasoning_content.
 * --live adds real-DNS SSRF probes (nip.io / localtest.me) and a public fetch.
 *
 *   testrun -- pnpm exec tsx scripts/benchmarks/security-bench.mts [--live] [--out file.json]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { executeJavaScript } from "../../src/services/harnesses/CodeInterpreter.ts";
import { assertPublicUrl, safeFetch, UnsafeUrlError } from "../../src/utils/UrlSafety.ts";
import { isBlockedHost } from "../../src/services/WebExtractService.ts";
import { requireExecuteKey } from "../../src/routes/ExecuteRoutes.ts";
import { OffloadStore } from "../../src/platform/offload/OffloadStore.ts";
import { prepareOpenAICompatMessages } from "../../src/utils/openai-compat.ts";

const live = process.argv.includes("--live");
const outIndex = process.argv.indexOf("--out");
const outFile = outIndex > 0 ? process.argv[outIndex + 1] : null;

interface Check { section: string; name: string; pass: boolean; detail: string; ms?: number }
const checks: Check[] = [];
const record = (section: string, name: string, pass: boolean, detail: string, ms?: number) =>
  checks.push({ section, name, pass, detail, ...(ms !== undefined ? { ms: Math.round(ms) } : {}) });

// ── 1. code_interpreter ─────────────────────────────────────────────
const canary = `canary_${crypto.randomBytes(12).toString("hex")}`;
process.env.SECURITY_BENCH_CANARY = canary;

const escapes: Array<[string, string]> = [
  ["computed process", 'return globalThis["proc" + "ess"]?.env?.SECURITY_BENCH_CANARY ?? "none";'],
  ["this.constructor chain", 'return this?.constructor?.constructor?.("return process")()?.env;'],
  ["console Function ctor", 'return console.log.constructor("return process")().env;'],
  ["async Function ctor", 'return (async () => {}).constructor("return process")();'],
  ["generator Function ctor", 'return (function*(){}).constructor("return process")().next();'],
  ["eval import", 'return eval("imp" + "ort(\\"node:fs\\")");'],
  ["indirect eval", 'return (0, eval)("1+1");'],
  ["prepareStackTrace callsites", 'Error.prepareStackTrace = (e, s) => s; const s = new Error().stack; return s.map((c) => String(c.getThis && c.getThis()));'],
  ["WebAssembly compile", 'return WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0]));'],
  ["globals enumeration", 'return Object.getOwnPropertyNames(globalThis).filter((k) => /process|require|module|Buffer|fetch/.test(k));'],
  ["thenable callback ctor", 'return { then(ok) { ok(ok.constructor("return globalThis[\'pro\'+\'cess\']")()?.env?.SECURITY_BENCH_CANARY); } };'],
  ["overridden Promise.then", 'const o = Promise.prototype.then; Promise.prototype.then = function (a, b) { try { a(a.constructor("return globalThis[\'pro\'+\'cess\']")().env.SECURITY_BENCH_CANARY); } catch {} return o.call(this, a, b); }; return Promise.resolve(1);'],
  ["swap boundary helper", "globalThis.__settle = (v) => v; return 1;"],
  ["sync infinite loop", "while (true) {}"],
  ["Atomics.wait block", "const b = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(b, 0, 0); return 1;"],
  ["memory bomb", "const a = []; while (true) a.push(new Array(1e6).fill(1));"],
  ["string bomb", 'let s = "x"; while (true) s += s;'],
  ["deep recursion", "const f = (n) => f(n + 1) + 1; return f(0);"],
  ["never-settling promise", "return new Promise(() => {});"],
  ["microtask flood", "const spin = () => Promise.resolve().then(spin); spin(); return new Promise(() => {});"],
];

for (const [name, code] of escapes) {
  let maxLag = 0;
  let last = performance.now();
  const ticker = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - last - 10);
    last = now;
  }, 10);
  const started = performance.now();
  const result = await executeJavaScript(code, 1_500);
  const elapsed = performance.now() - started;
  clearInterval(ticker);
  const text = JSON.stringify(result);
  const leaked = text.includes(canary);
  const hostReached = /"(env|versions|pid|mainModule)"/.test(text) || /\[object process\]/.test(text);
  const bounded = elapsed < 6_000;
  const responsive = maxLag < 250;
  record(
    "code_interpreter",
    name,
    !leaked && !hostReached && bounded && responsive,
    `${result.success ? "ran" : `refused/failed: ${String(result.message).slice(0, 70)}`}; host loop lag max ${Math.round(maxLag)} ms`,
    elapsed,
  );
}
const pure = await executeJavaScript("return [1, 2, 3].map((n) => n * n).reduce((a, b) => a + b);");
record("code_interpreter", "pure computation still works", pure.success && pure.returned === 14, JSON.stringify(pure.returned));

// ── 2. SSRF ─────────────────────────────────────────────────────────
const dns: Record<string, string[]> = {
  "public.example.com": ["93.184.215.14"],
  "127.0.0.1.nip.io": ["127.0.0.1"],
  "metadata.attacker.example": ["169.254.169.254"],
  "mixed.attacker.example": ["8.8.8.8", "10.0.0.16"],
  "v6loop.attacker.example": ["::1"],
  "mapped.attacker.example": ["::ffff:127.0.0.1"],
  "cgnat.attacker.example": ["100.64.0.7"],
  "zero.attacker.example": ["0.0.0.0"],
};
const resolve = async (host: string) => {
  const hit = dns[host];
  if (!hit) throw new Error("NXDOMAIN");
  return hit;
};
const mustBlock = [
  "http://127.0.0.1:5591/health", "http://0.0.0.0:5591/", "http://0x7f000001/", "http://2130706433/",
  "http://017700000001/", "http://127.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/",
  "http://[0:0:0:0:0:ffff:7f00:1]/", "http://[64:ff9b::7f00:1]/", "http://169.254.169.254/latest/meta-data/",
  "http://[fd00::1]/", "http://[fe80::1]/", "http://100.64.0.1/", "http://192.168.1.1/", "http://10.0.0.16:8001/",
  "http://172.16.0.1/", "http://localhost/", "http://foo.localhost/", "http://nas.local/", "http://intranet/",
  "http://metadata.google.internal/", "https://127.0.0.1.nip.io/", "https://metadata.attacker.example/",
  "https://mixed.attacker.example/", "https://v6loop.attacker.example/", "https://mapped.attacker.example/",
  "https://cgnat.attacker.example/", "https://zero.attacker.example/", "https://nxdomain.attacker.example/",
  "file:///etc/passwd", "gopher://127.0.0.1:6379/", "ftp://public.example.com/", "https://user:pw@public.example.com/",
];
for (const url of mustBlock) {
  let blocked = false;
  let why = "";
  try {
    await assertPublicUrl(url, { resolve });
  } catch (error) {
    blocked = error instanceof UnsafeUrlError;
    why = (error as Error).message;
  }
  record("ssrf", `blocks ${url}`, blocked, why || "ALLOWED");
}
for (const url of ["https://public.example.com/a?b=c", "http://93.184.215.14/", "https://[2606:4700::1111]/"]) {
  let ok = true;
  let why = "allowed";
  try {
    await assertPublicUrl(url, { resolve });
  } catch (error) {
    ok = false;
    why = (error as Error).message;
  }
  record("ssrf", `allows ${url}`, ok, why);
}
// WebExtract's literal-host check (before DNS) must agree on encodings.
for (const url of ["https://0x7f000001/", "https://[::ffff:a9fe:a9fe]/", "https://100.64.0.1/", "https://0.0.0.0/"]) {
  record("ssrf", `isBlockedHost ${url}`, isBlockedHost(url), "literal check");
}
// Redirect hop to a private target.
{
  const fetchImpl = async () =>
    new Response(null, { status: 302, headers: { location: "http://[::ffff:a9fe:a9fe]/latest/" } });
  let blocked = false;
  try {
    await safeFetch("https://public.example.com/", { resolve, fetchImpl });
  } catch (error) {
    blocked = error instanceof UnsafeUrlError;
  }
  record("ssrf", "redirect to metadata (mapped v6) refused", blocked, "safeFetch per-hop check");
}
// Redirect loop is bounded.
{
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: "https://public.example.com/again" } });
  let bounded = false;
  try {
    await safeFetch("https://public.example.com/", { resolve, fetchImpl, maxRedirects: 3 });
  } catch (error) {
    bounded = /too many redirects/.test((error as Error).message);
  }
  record("ssrf", "redirect loop bounded", bounded, "maxRedirects 3");
}
// Body cap.
{
  const fetchImpl = async () => new Response("z".repeat(5_000_000), { status: 200 });
  const result = await safeFetch("https://public.example.com/", { resolve, fetchImpl, maxBytes: 100_000 });
  record("ssrf", "response body capped", result.text.length === 100_000 && result.truncated, `${result.text.length} bytes kept`);
}
if (live) {
  for (const url of ["http://127.0.0.1.nip.io:5591/health", "http://localtest.me/", "http://169.254.169.254.nip.io/"]) {
    let blocked = false;
    let why = "";
    try {
      await safeFetch(url, { maxBytes: 1_000 });
    } catch (error) {
      blocked = error instanceof UnsafeUrlError;
      why = (error as Error).message;
    }
    record("ssrf-live", `real DNS blocks ${url}`, blocked, why || "ALLOWED");
  }
  try {
    const result = await safeFetch("https://example.com/", { maxBytes: 2_000 });
    record("ssrf-live", "real public fetch works", result.ok, `HTTP ${result.status}`);
  } catch (error) {
    record("ssrf-live", "real public fetch works", false, (error as Error).message);
  }
}

// ── 3. /execute key ─────────────────────────────────────────────────
const callGate = (headers: Record<string, string>, body: Record<string, unknown> = {}) => {
  let passed = false;
  let status = 200;
  requireExecuteKey(
    { headers, body } as never,
    { status: (code: number) => { status = code; return { json: () => {} }; }, json: () => {} } as never,
    () => { passed = true; },
  );
  return { passed, status };
};
delete process.env.EXECUTE_API_KEY;
record("execute-key", "open when EXECUTE_API_KEY unset (back-compat)", callGate({}).passed, "LAN-open default");
const key = `auth_${crypto.randomBytes(16).toString("hex")}`;
process.env.EXECUTE_API_KEY = key;
record("execute-key", "no key → 401", callGate({}).status === 401, "");
record("execute-key", "wrong key → 401", callGate({ "x-api-key": key.slice(0, -1) + "0" }).status === 401, "");
record("execute-key", "wrong length → 401", callGate({ "x-api-key": "short" }).status === 401, "");
record("execute-key", "x-api-key accepted", callGate({ "x-api-key": key }).passed, "");
record("execute-key", "Bearer accepted", callGate({ authorization: `Bearer ${key}` }).passed, "");
delete process.env.EXECUTE_API_KEY;

// ── 4. Offload store ────────────────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "security-bench-offload-"));
  const writer = new OffloadStore({ dir });
  const reader = new OffloadStore({ dir });
  const a = await writer.put({ tool_name: "t", full_result: "A" });
  const gotA = await reader.get(a.offload_id);
  const b = await writer.put({ tool_name: "t", full_result: "B" });
  const gotB = await reader.get(b.offload_id);
  const traversal = await reader.get("../../../etc/passwd");
  record("offload", "offload A, retrieve A, offload B, retrieve B", gotA?.full_result === "A" && gotB?.full_result === "B", "two instances, one dir");
  record("offload", "path-traversal id refused", traversal === undefined, "ids must match tr_<hex24>");
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 5. Reasoning round-trip ─────────────────────────────────────────
{
  const prepared = prepareOpenAICompatMessages([
    { role: "user", content: "q" },
    { role: "assistant", content: "", thinking: "plan: call the tool", toolCalls: [{ id: "c1", name: "t", args: {} }] },
    { role: "tool", tool_call_id: "c1", content: "r" },
  ]) as Array<Record<string, unknown>>;
  record("reasoning", "tool turn carries reasoning_content", prepared[1].reasoning_content === "plan: call the tool", "DeepSeek thinking-mode contract");
}

// ── Report ──────────────────────────────────────────────────────────
delete process.env.SECURITY_BENCH_CANARY;
const failed = checks.filter((c) => !c.pass);
const bySection = new Map<string, { pass: number; total: number }>();
for (const c of checks) {
  const s = bySection.get(c.section) ?? { pass: 0, total: 0 };
  s.total++;
  if (c.pass) s.pass++;
  bySection.set(c.section, s);
}
for (const [section, s] of bySection) console.log(`${s.pass === s.total ? "PASS" : "FAIL"}  ${section.padEnd(18)} ${s.pass}/${s.total}`);
for (const c of failed) console.log(`  ✗ [${c.section}] ${c.name} — ${c.detail}`);
const interp = checks.filter((c) => c.section === "code_interpreter" && c.ms !== undefined);
console.log(`code_interpreter: slowest payload ${Math.max(...interp.map((c) => c.ms ?? 0))} ms (deadline 1500 ms)`);
const report = {
  generated_at: new Date().toISOString(),
  live,
  total: checks.length,
  passed: checks.length - failed.length,
  failed: failed.length,
  sections: Object.fromEntries(bySection),
  checks,
};
if (outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report → ${outFile}`);
}
process.exit(failed.length === 0 ? 0 : 1);
