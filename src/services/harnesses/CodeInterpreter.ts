import { spawn } from "node:child_process";
import os from "node:os";

import logger from "../../utils/logger.ts";

import type { ToolCall, ToolResult, ToolSchema } from "./types.ts";

/**
 * CodeInterpreter — Hermes-pattern `code_interpreter` escape hatch.
 *
 * When a model emits a tool call named `code_interpreter` and NO sandboxed
 * code-execution tool is registered, the harness evaluates the fenced code
 * block locally instead of failing with an unknown-tool error:
 *   - ```javascript / ```js blocks run in a separate, locked-down `node`
 *     process (see SANDBOX_RUNNER / executeJavaScript) inside a
 *     host-object-free `vm` context; the deadline SIGKILLs the process.
 *   - ```python blocks return a structured "not available on this runtime"
 *     observation (this runtime has no Python).
 *   - Static guard scans refuse code that touches require/import/process/
 *     fs/child_process with a structured refusal observation.
 *
 * If a real code-execution tool IS registered, callers must dispatch to it
 * instead (see partitionCodeInterpreterCalls).
 *
 * Reference: docs/harness-research/PLAN_hermes.md §4. Isolation layers, any
 * one of which stops an escape: (1) the vm context holds no host objects and
 * forbids string codegen; (2) the child process runs with
 * --disallow-code-generation-from-strings, so even a leaked outer-realm
 * Function cannot compile; (3) the Node permission model (--permission, no
 * --allow-* grants) denies filesystem, network, DNS, child processes,
 * workers, addons and native bindings, with an EMPTY environment. A startup
 * probe verifies (3) on this runtime and fails closed if it does not hold
 * (Node < 26 has no network permission). The static scan is only a fast-path
 * refusal; interpreter calls still pass the approval gate in the harness.
 */

export const CODE_INTERPRETER_TOOL_NAME = "code_interpreter";
export const CODE_INTERPRETER_TIMEOUT_MS = 5_000;

export interface CodeInterpreterResult {
  success: boolean;
  /** Structured error code — absent on success. */
  error?: string;
  message?: string;
  /** Captured console output lines (javascript execution). */
  output?: string[];
  /** Completion value of the executed snippet, if any. */
  returned?: unknown;
}

export interface ExtractedCode {
  /** Fence info string, normalized to python | javascript | null. */
  language: "python" | "javascript" | null;
  code: string;
}

const CODE_INTERPRETER_REFUSAL_MESSAGE =
  "Refused: the submitted code touches a forbidden capability. Only pure " +
  "computation is allowed — no imports, no require(), no process access, " +
  "no filesystem, no child processes.";

/** Static guard scan: returns the first forbidden capability found, or null. */
export function scanForForbiddenCode(code: string): string | null {
  if (code.includes("require(")) return "require(";
  if (/\bimport\s|\bimport\(/.test(code)) return "import";
  if (code.includes("process.")) return "process.";
  // Word boundary: a bare "fs" substring would false-positive on
  // "offset"/"shift" while still refusing `import fs` / `fs.readFileSync`.
  if (/\bfs\b/.test(code)) return "fs";
  if (code.includes("child_process")) return "child_process";
  return null;
}

/** Extract the first fenced code block: ```lang\n...``` . */
export function extractCodeFence(text: string): { info: string; code: string } | null {
  const match = /```([a-zA-Z0-9_+-]*)[^\n]*\n([\s\S]*?)```/.exec(text);
  if (!match) return null;
  return { info: match[1], code: match[2] };
}

export function normalizeCodeLanguage(
  info: string | null | undefined,
): "python" | "javascript" | null {
  if (!info) return null;
  switch (info.toLowerCase()) {
    case "py":
    case "python":
      return "python";
    case "js":
    case "javascript":
    case "node":
    case "nodejs":
      return "javascript";
    default:
      return null;
  }
}

/** Pull the code payload out of code_interpreter tool-call arguments. */
function extractArgumentCode(args: Record<string, unknown>): string {
  for (const key of ["code", "source", "script"]) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return "";
}

/** Crude heuristic for unfenced code: python-ish signatures → python. */
function guessLanguage(code: string): "python" | "javascript" {
  if (/^\s*(def |print\(|import \w|from \w+ import|elif )/m.test(code)) return "python";
  return "javascript";
}

/** Resolve the (language, code) pair for an interpreter call. */
export function resolveInterpreterCode(
  args: Record<string, unknown>,
): { language: "python" | "javascript"; code: string } | { language: null; code: string } {
  const raw = extractArgumentCode(args);
  const fence = extractCodeFence(raw);
  const argLanguage = typeof args.language === "string" ? args.language : null;
  const language =
    normalizeCodeLanguage(fence?.info) ??
    normalizeCodeLanguage(argLanguage) ??
    (fence ? null : guessLanguage(raw));
  return { language, code: fence ? fence.code : raw };
}

/**
 * Sandbox process body (run with `node -e`). Reads `{code, timeoutMs}` as
 * JSON on stdin and writes ONE JSON line `{ok, message?, payload?}` to
 * stdout. The snippet runs in a fresh `vm` context that holds NO host
 * objects. Boundary rule: no outer-realm function is ever handed to an
 * object the snippet controls (the thenable escape from the 2026-10-11
 * security review) — promise settling, error formatting and serialization
 * happen inside the context through closures captured before the snippet
 * runs and locked as non-writable globals; the outer side only reads a
 * JSON string.
 */
const SANDBOX_RUNNER = String.raw`
"use strict";
const vm = require("node:vm");
const reply = (msg) => { process.stdout.write(JSON.stringify(msg) + "\n", () => process.exit(0)); };
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let job;
  try { job = JSON.parse(input); } catch { return reply({ ok: false, message: "sandbox received no job" }); }
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  const prelude = [
    '"use strict";',
    "(() => {",
    "  const stringify = JSON.stringify;",
    "  const resolve = Promise.resolve.bind(Promise);",
    "  const call = Function.prototype.call.bind(Promise.prototype.then);",
    "  const logs = [];",
    "  const fmt = (v) => { if (typeof v === 'string') return v; try { const s = stringify(v); return s === undefined ? String(v) : s; } catch { return '[unserializable]'; } };",
    "  const push = (...a) => { if (logs.length < 1000) logs.push(a.map(fmt).join(' ').slice(0, 10000)); };",
    "  const drain = (value) => { let r; try { r = stringify(value); } catch { r = undefined; } return stringify({ logs: logs.slice(), returned: typeof r === 'string' ? r : undefined }); };",
    "  const describe = (e) => { try { const m = e && e.message !== undefined ? e.message : e; return typeof m === 'string' ? m : String(m); } catch { return 'error'; } };",
    "  const state = { out: '' };",
    "  const lock = (name, value) => Object.defineProperty(globalThis, name, { value, writable: false, configurable: false, enumerable: false });",
    "  lock('console', Object.freeze({ log: push, info: push, warn: push, error: push, debug() {}, trace() {} }));",
    "  lock('__settle', (v) => { call(resolve(v), (r) => { state.out = stringify({ ok: true, payload: drain(r) }); }, (e) => { state.out = stringify({ ok: false, message: describe(e), payload: drain(undefined) }); }); });",
    "  lock('__fail', (e) => stringify({ ok: false, message: describe(e), payload: drain(undefined) }));",
    "  lock('__poll', () => state.out);",
    "})();",
  ].join("\n");
  vm.runInContext(prelude, context, { timeout: 1000 });
  const settle = vm.runInContext("__settle", context);
  const fail = vm.runInContext("__fail", context);
  const poll = vm.runInContext("__poll", context);
  const parse = (text) => {
    try {
      const m = JSON.parse(String(text));
      return { ok: m.ok === true, message: typeof m.message === "string" ? m.message : undefined, payload: typeof m.payload === "string" ? m.payload : undefined };
    } catch { return { ok: false, message: "code_interpreter produced an unreadable result" }; }
  };
  try {
    const wrapped = '(function(){\n"use strict";\n' + String(job.code) + "\n})()";
    const value = vm.runInContext(wrapped, context, { timeout: Number(job.timeoutMs) || 5000 });
    settle(value);
    const check = () => {
      const out = poll();
      if (typeof out === "string" && out) reply(parse(out));
      else setTimeout(check, 2);
    };
    check();
  } catch (e) {
    let out;
    try { out = fail(e); } catch { out = undefined; }
    reply(typeof out === "string" ? parse(out) : { ok: false, message: "code_interpreter failed" });
  }
});
`;

/** Process flags: permission model with NO grants, no string codegen, small heap. */
const SANDBOX_FLAGS = [
  "--permission",
  "--disallow-code-generation-from-strings",
  "--max-old-space-size=64",
  "--max-semi-space-size=4",
  "--stack-size=984",
];
const MAX_SANDBOX_OUTPUT_BYTES = 1_000_000;
const MAX_CONCURRENT_SANDBOXES = Math.max(1, Number(process.env.CODE_INTERPRETER_MAX_CONCURRENCY) || 2);
let activeSandboxes = 0;

interface SandboxReply {
  ok: boolean;
  message?: string;
  payload?: string;
}

/** Run one job in a fresh sandbox process; never throws. */
function runInSandbox(job: { code: string; timeoutMs: number } | { probe: true }, timeoutMs: number): Promise<SandboxReply> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...SANDBOX_FLAGS, "-e", "probe" in job ? PROBE_RUNNER : SANDBOX_RUNNER], {
      env: {},
      cwd: os.tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (value: SandboxReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve(value);
    };
    const timer = setTimeout(
      () => settle({ ok: false, message: `code_interpreter timed out after ${timeoutMs}ms` }),
      timeoutMs,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_SANDBOX_OUTPUT_BYTES) return settle({ ok: false, message: "code_interpreter output exceeded 1 MB" });
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      try {
        const msg = JSON.parse(stdout.slice(0, newline)) as SandboxReply;
        settle({
          ok: msg.ok === true,
          message: typeof msg.message === "string" ? msg.message : undefined,
          payload: typeof msg.payload === "string" ? msg.payload : undefined,
        });
      } catch {
        settle({ ok: false, message: "code_interpreter produced an unreadable result" });
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4_000) stderr += chunk;
    });
    child.on("error", (error) => settle({ ok: false, message: `code_interpreter sandbox failed to start: ${error.message}` }));
    child.on("exit", (code, signal) => {
      if (settled) return;
      const oom = /heap out of memory|Allocation failed/i.test(stderr);
      settle({
        ok: false,
        message: oom
          ? "code_interpreter sandbox reached its memory limit"
          : `code_interpreter sandbox exited (${signal ?? `code ${code}`}) without a result`,
      });
    });
    child.stdin.on("error", () => {}); // child may die before reading stdin
    child.stdin.end(JSON.stringify(job));
  });
}

/**
 * Self-check run once per process: inside the sandbox, every capability
 * that would matter after an escape must be DENIED. If any is allowed
 * (e.g. an older Node without network permission), the interpreter is
 * unavailable rather than half-isolated.
 */
const PROBE_RUNNER = String.raw`
"use strict";
const out = {};
const tryIt = (name, f) => { try { f(); out[name] = "ALLOWED"; } catch (e) { out[name] = e && e.code === "ERR_ACCESS_DENIED" ? "denied" : "denied:" + (e && (e.code || e.message)); } };
tryIt("fs", () => require("node:fs").readFileSync("/etc/hostname"));
tryIt("child_process", () => require("node:child_process").spawnSync("true"));
tryIt("worker", () => new (require("node:worker_threads").Worker)("0", { eval: true }).terminate());
tryIt("binding", () => process.binding("fs"));
tryIt("codegen", () => Function("return 1")());
out.env = Object.keys(process.env).length;
// Network and DNS denials arrive asynchronously (error event / callback).
const asyncCheck = (name, start) => new Promise((done) => {
  const verdict = (err) => { out[name] = err && err.code === "ERR_ACCESS_DENIED" ? "denied" : "ALLOWED"; done(); };
  try { start(verdict); } catch (e) { verdict(e); }
  setTimeout(() => { if (!(name in out)) { out[name] = "ALLOWED"; done(); } }, 3000);
});
Promise.all([
  asyncCheck("net", (v) => { const s = require("node:net").connect(9, "127.0.0.1"); s.on("error", v); s.on("connect", () => { s.destroy(); v(null); }); }),
  asyncCheck("dns", (v) => require("node:dns").lookup("localhost", (err) => v(err))),
]).then(() => process.stdout.write(JSON.stringify({ ok: true, payload: JSON.stringify(out) }) + "\n", () => process.exit(0)));
`;

export interface SandboxCheck {
  available: boolean;
  reason?: string;
  capabilities?: Record<string, unknown>;
}
let sandboxCheck: Promise<SandboxCheck> | null = null;

/** Verify (once) that the sandbox denies fs/net/dns/processes/workers/bindings/codegen and has an empty env. */
export function checkSandbox(): Promise<SandboxCheck> {
  sandboxCheck ??= (async () => {
    const reply = await runInSandbox({ probe: true }, 10_000);
    if (!reply.ok || !reply.payload) return { available: false, reason: reply.message ?? "sandbox probe failed" };
    return evaluateSandboxProbe(JSON.parse(reply.payload) as Record<string, unknown>);
  })();
  return sandboxCheck;
}

const REQUIRED_DENIALS = ["fs", "net", "dns", "child_process", "worker", "binding", "codegen"];

/** Probe verdict: every required capability denied and an empty env, or unavailable (fail closed). */
export function evaluateSandboxProbe(caps: Record<string, unknown>): SandboxCheck {
  const leaks = REQUIRED_DENIALS.filter((k) => caps[k] !== "denied" && !String(caps[k] ?? "").startsWith("denied"));
  if (caps.env !== 0) leaks.push("env");
  if (leaks.length > 0) {
    return {
      available: false,
      reason: `sandbox does not isolate on ${process.version} (not denied: ${leaks.join(", ")}); Node >= 26 with the permission model is required`,
      capabilities: caps,
    };
  }
  return { available: true, capabilities: caps };
}

/** Test hook: forget the cached probe. */
export function __resetSandboxCheckForTests(): void {
  sandboxCheck = null;
}

function decodePayload(payload: string | undefined): { logs: string[]; returned: unknown } {
  if (!payload) return { logs: [], returned: undefined };
  try {
    const parsed = JSON.parse(payload) as { logs?: unknown; returned?: string };
    const logs = Array.isArray(parsed.logs) ? parsed.logs.map(String) : [];
    const returned = typeof parsed.returned === "string" ? JSON.parse(parsed.returned) : undefined;
    return { logs, returned };
  } catch {
    return { logs: [], returned: undefined };
  }
}

/**
 * Execute a ```javascript block in a fresh sandbox process (see the module
 * comment for the isolation layers). The deadline SIGKILLs the process, so
 * synchronous infinite loops are killed too and never touch the service's
 * event loop. Fails closed (CODE_INTERPRETER_UNAVAILABLE) when the startup
 * probe shows the runtime cannot isolate.
 */
export async function executeJavaScript(
  code: string,
  timeoutMs: number = CODE_INTERPRETER_TIMEOUT_MS,
): Promise<CodeInterpreterResult> {
  const forbidden = scanForForbiddenCode(code);
  if (forbidden !== null) {
    logger.warn(
      `[CodeInterpreter] Refused javascript block using forbidden capability: ${forbidden}`,
    );
    return {
      success: false,
      error: "CODE_INTERPRETER_REFUSED",
      message: `${CODE_INTERPRETER_REFUSAL_MESSAGE} (found: ${forbidden})`,
    };
  }

  const check = await checkSandbox();
  if (!check.available) {
    logger.warn(`[CodeInterpreter] sandbox unavailable: ${check.reason}`);
    return { success: false, error: "CODE_INTERPRETER_UNAVAILABLE", message: `code_interpreter is unavailable: ${check.reason}` };
  }
  if (activeSandboxes >= MAX_CONCURRENT_SANDBOXES) {
    return { success: false, error: "CODE_INTERPRETER_BUSY", message: "code_interpreter is busy; try again shortly" };
  }
  activeSandboxes++;
  let reply: SandboxReply;
  try {
    // Process start-up (~50 ms) must not eat the snippet's own budget.
    reply = await runInSandbox({ code, timeoutMs }, timeoutMs + 1_000);
  } finally {
    activeSandboxes--;
  }

  const { logs, returned } = decodePayload(reply.payload);
  if (!reply.ok) {
    const message = reply.message ?? "code_interpreter failed";
    logger.warn(`[CodeInterpreter] javascript block failed: ${message}`);
    return { success: false, error: "CODE_INTERPRETER_ERROR", message, output: logs };
  }
  return { success: true, output: logs, returned };
}

/**
 * Top-level code_interpreter fallback: resolve the fenced block and run it.
 * The returned structured object becomes a normal tool observation.
 */
export async function runCodeInterpreter(
  args: Record<string, unknown>,
): Promise<CodeInterpreterResult> {
  const resolved = resolveInterpreterCode(args);
  if (!resolved.code.trim()) {
    return {
      success: false,
      error: "CODE_INTERPRETER_EMPTY",
      message:
        "code_interpreter received no code to run. Pass the program as the 'code' argument, ideally as a fenced ```javascript or ```python block.",
    };
  }
  if (resolved.language === "python") {
    return {
      success: false,
      error: "PYTHON_UNAVAILABLE",
      message: "python execution is not available on this runtime",
    };
  }
  if (resolved.language === "javascript") return executeJavaScript(resolved.code);
  return {
    success: false,
    error: "CODE_INTERPRETER_UNSUPPORTED_LANGUAGE",
    message:
      "Unsupported code fence. Use ```javascript (executed here) or ```python (not available on this runtime).",
  };
}

/**
 * Partition a tool-call batch: calls named `code_interpreter` that have NO
 * registered backing tool are intercepted for local evaluation; everything
 * else dispatches through the normal executor.
 */
export function partitionCodeInterpreterCalls(
  toolCalls: ToolCall[],
  registeredTools: ToolSchema[],
): { dispatchable: ToolCall[]; interpreterCalls: ToolCall[] } {
  const hasRegisteredCodeInterpreter = registeredTools.some(
    (tool) => tool.name === CODE_INTERPRETER_TOOL_NAME,
  );
  if (hasRegisteredCodeInterpreter) return { dispatchable: toolCalls, interpreterCalls: [] };
  const interpreterCalls = toolCalls.filter(
    (toolCall) => toolCall.name === CODE_INTERPRETER_TOOL_NAME,
  );
  if (interpreterCalls.length === 0) return { dispatchable: toolCalls, interpreterCalls: [] };
  return {
    dispatchable: toolCalls.filter((toolCall) => toolCall.name !== CODE_INTERPRETER_TOOL_NAME),
    interpreterCalls,
  };
}

/** Run intercepted code_interpreter calls and wrap them as ToolResults. */
export async function runCodeInterpreterCalls(
  toolCalls: ToolCall[],
): Promise<ToolResult[]> {
  return Promise.all(
    toolCalls.map(async (toolCall) => {
      const started = Date.now();
      const result = await runCodeInterpreter(toolCall.args);
      if (!result.success) {
        logger.warn(
          `[CodeInterpreter] ${toolCall.id ?? "unid"}: ${result.error ?? "failed"} — ${result.message ?? ""}`,
        );
      }
      return {
        name: toolCall.name,
        id: toolCall.id,
        result,
        durationMs: Date.now() - started,
      };
    }),
  );
}
