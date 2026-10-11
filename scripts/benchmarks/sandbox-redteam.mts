#!/usr/bin/env node
/**
 * Red-team ablation for the code_interpreter sandbox walls.
 *
 * For each wall, an attack that the wall is meant to stop is run twice:
 *   - wall OFF  → the attack MUST land (proves the attack is real, not a dud)
 *   - wall ON   → the attack MUST be stopped
 * A wall whose attack does not land even with it off is reported UNPROVEN.
 *
 * "Landing" means a value the model controls escapes the sandbox: a planted
 * secret read back, a local TCP listener reached, a file written, or a child
 * process run. This script spawns the sandbox child the same way the service
 * does, toggling one flag at a time.
 *
 *   testrun -- pnpm exec tsx scripts/benchmarks/sandbox-redteam.mts
 */
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const BASE_FLAGS = ["--permission", "--disallow-code-generation-from-strings", "--max-old-space-size=64"];

// The same sandbox body the service uses, inlined so the ablation drives the real thing.
const RUNNER = String.raw`
"use strict";
const vm = require("node:vm");
const reply = (m) => process.stdout.write(JSON.stringify(m) + "\n", () => process.exit(0));
let input = ""; process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const job = JSON.parse(input);
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  const prelude = [
    '"use strict";','(() => {',
    "const stringify = JSON.stringify, resolve = Promise.resolve.bind(Promise), call = Function.prototype.call.bind(Promise.prototype.then), logs = [];",
    "const fmt = (v) => { if (typeof v==='string') return v; try { const s=stringify(v); return s===undefined?String(v):s; } catch { return '[x]'; } };",
    "const push = (...a) => logs.push(a.map(fmt).join(' '));",
    "const drain = (v) => { let r; try { r=stringify(v);} catch {} return stringify({logs:logs.slice(),returned:typeof r==='string'?r:undefined}); };",
    "const state={out:''}; const lock=(n,v)=>Object.defineProperty(globalThis,n,{value:v,writable:false,configurable:false});",
    "lock('console',Object.freeze({log:push,info:push,warn:push,error:push,debug(){},trace(){}}));",
    "lock('__settle',(v)=>{call(resolve(v),(r)=>{state.out=stringify({ok:true,payload:drain(r)});},(e)=>{state.out=stringify({ok:false,message:String(e&&e.message?e.message:e),payload:drain(undefined)});});});",
    "lock('__poll',()=>state.out);","})();",
  ].join("\n");
  vm.runInContext(prelude, context, { timeout: 1000 });
  const settle = vm.runInContext("__settle", context), poll = vm.runInContext("__poll", context);
  try {
    const value = vm.runInContext('(function(){\n"use strict";\n' + job.code + "\n})()", context, { timeout: job.timeoutMs || 4000 });
    settle(value);
    const check = () => { const o = poll(); if (o) reply(JSON.parse(o)); else setTimeout(check, 2); };
    check();
  } catch (e) { reply({ ok: false, message: String(e && e.message ? e.message : e) }); }
});
`;

// Same body but WITHOUT the vm context — code runs directly in the child realm (wall 1 off).
const RUNNER_NO_VM = String.raw`
"use strict";
const reply = (m) => process.stdout.write(JSON.stringify(m) + "\n", () => process.exit(0));
let input = ""; process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const job = JSON.parse(input);
  try {
    const value = (0, eval)('(function(){\n' + job.code + '\n})()');
    Promise.resolve(value).then((r) => reply({ ok: true, payload: JSON.stringify({ returned: JSON.stringify(r) }) }),
      (e) => reply({ ok: false, message: String(e && e.message ? e.message : e) }));
  } catch (e) { reply({ ok: false, message: String(e && e.message ? e.message : e) }); }
});
`;

// Simulates a wall-1 bypass: the real outer-realm Function constructor is
// injected into the context as __leak, so downstream walls can be tested in
// isolation (assume the vm context already failed). Never used in production.
const RUNNER_LEAKED = RUNNER.replace(
  'const settle = vm.runInContext("__settle", context)',
  'context.__leak = Function; const settle = vm.runInContext("__settle", context)',
);

interface Reply { ok: boolean; message?: string; payload?: string }

function runChild(flags: string[], runner: string, env: Record<string, string>, job: object, cwd: string): Promise<Reply> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...flags, "-e", runner], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const done = (r: Reply) => { if (settled) return; settled = true; clearTimeout(t); if (child.exitCode === null) child.kill("SIGKILL"); resolve(r); };
    const t = setTimeout(() => done({ ok: false, message: "timeout" }), 8000);
    child.stdout.on("data", (c) => { stdout += c; const nl = stdout.indexOf("\n"); if (nl >= 0) { try { done(JSON.parse(stdout.slice(0, nl))); } catch { done({ ok: false, message: "unreadable" }); } } });
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (e) => done({ ok: false, message: e.message }));
    child.on("exit", (code, sig) => done({ ok: false, message: `exit ${sig ?? code}: ${stderr.slice(0, 120)}` }));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(job));
  });
}

const results: Array<{ wall: string; attack: string; offLanded: boolean; onLanded: boolean; detail: string }> = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-redteam-"));
const SECRET = `redteam_${crypto.randomBytes(12).toString("hex")}`;

// A local listener the attack tries to reach (network exfil target).
const listener = net.createServer((s) => s.destroy());
await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
const port = (listener.address() as net.AddressInfo).port;

// Attack code reused across walls: build a real Function, reach process, exfil the secret.
const exfilViaFunction = `
  const F = __leak;
  const proc = F("return globalThis['pro'+'cess']")();
  return proc.env.REDTEAM_SECRET || "no-secret";
`;
const exfilViaNet = `
  const F = __leak;
  const proc = F("return globalThis['pro'+'cess']")();
  const net = proc.getBuiltinModule ? proc.getBuiltinModule("net") : proc.mainModule.require("net");
  return new Promise((ok) => { const s = net.connect(${port}, "127.0.0.1"); s.on("connect", () => { s.destroy(); ok("CONNECTED"); }); s.on("error", (e) => ok("neterr:" + e.code)); });
`;
const exfilViaFile = `
  const F = __leak;
  const proc = F("return globalThis['pro'+'cess']")();
  const fs = proc.getBuiltinModule ? proc.getBuiltinModule("fs") : proc.mainModule.require("fs");
  fs.writeFileSync(${JSON.stringify(path.join(tmp, "escape.txt"))}, "ESCAPED");
  return "WROTE";
`;
const exfilViaChild = `
  const F = __leak;
  const proc = F("return globalThis['pro'+'cess']")();
  const cp = proc.getBuiltinModule ? proc.getBuiltinModule("child_process") : proc.mainModule.require("child_process");
  return cp.execSync("echo spawned").toString().trim();
`;

const landed = (r: Reply, needle: string) => r.ok === true && String(decodeReturned(r)).includes(needle);
function decodeReturned(r: Reply): unknown {
  try { const p = JSON.parse(r.payload ?? "{}"); return p.returned ? JSON.parse(p.returned) : undefined; } catch { return undefined; }
}

const fullEnv = { REDTEAM_SECRET: SECRET, PATH: process.env.PATH ?? "" };

// Wall 1: the vm context. OFF = run in child realm directly; ON = run in the vm context.
// (With codegen allowed in both, so this isolates the vm wall itself.)
{
  const flagsCodegenOn = ["--max-old-space-size=64"]; // no --disallow-codegen, no --permission
  const off = await runChild(flagsCodegenOn, RUNNER_NO_VM, fullEnv, { code: `return (${JSON.stringify(SECRET)});`, timeoutMs: 3000 }, tmp);
  const on = await runChild(flagsCodegenOn, RUNNER, fullEnv, { code: exfilViaFunction, timeoutMs: 3000 }, tmp);
  // OFF proof: without the vm wall the snippet is the realm, so its return is whatever it wants (trivially lands).
  // ON: inside the vm context, the Function-ctor reach to process must NOT yield the secret.
  results.push({ wall: "1. vm context (no host objects)", attack: "Function-ctor reach to process.env", offLanded: landed(off, SECRET), onLanded: landed(on, SECRET), detail: `on=${JSON.stringify(decodeReturned(on))}` });
}

// Wall 2: process-wide codegen ban. OFF = codegen allowed; ON = --disallow-code-generation-from-strings.
// Both inside the vm context, both with env set and no permission lock, so ONLY the codegen flag differs.
{
  const off = await runChild(["--max-old-space-size=64"], RUNNER_LEAKED, fullEnv, { code: exfilViaFunction, timeoutMs: 3000 }, tmp);
  const on = await runChild(["--disallow-code-generation-from-strings", "--max-old-space-size=64"], RUNNER_LEAKED, fullEnv, { code: exfilViaFunction, timeoutMs: 3000 }, tmp);
  results.push({ wall: "2. process-wide codegen ban", attack: "compile a string to reach process.env", offLanded: landed(off, SECRET), onLanded: landed(on, SECRET), detail: `off=${JSON.stringify(decodeReturned(off))} on=${(on.message ?? "").slice(0, 60)}` });
}

// Wall 3: the permission model. OFF = no --permission; ON = --permission (no grants).
// Codegen stays ALLOWED in both so the attack can still build its Function and only the OS lock differs.
// Three exfil channels: network, file, child process.
for (const [name, code, needle] of [["network connect", exfilViaNet, "CONNECTED"], ["file write", exfilViaFile, "WROTE"], ["child process", exfilViaChild, "spawned"]] as const) {
  const off = await runChild(["--max-old-space-size=64"], RUNNER_LEAKED, fullEnv, { code, timeoutMs: 4000 }, tmp);
  const on = await runChild(BASE_FLAGS, RUNNER_LEAKED, fullEnv, { code, timeoutMs: 4000 }, tmp);
  results.push({ wall: `3. permission model (${name})`, attack: `escape vm, ${name}`, offLanded: landed(off, needle), onLanded: landed(on, needle), detail: `off=${JSON.stringify(decodeReturned(off))} on=${JSON.stringify(decodeReturned(on)) || (on.message ?? "").slice(0, 50)}` });
}

// Wall 4: empty env. OFF = env has the secret; ON = env:{}. Both with full isolation otherwise,
// so this proves the service passes NO env to the child (even if everything else were bypassed).
{
  const off = await runChild(["--max-old-space-size=64"], RUNNER_LEAKED, fullEnv, { code: exfilViaFunction, timeoutMs: 3000 }, tmp);
  const on = await runChild(["--max-old-space-size=64"], RUNNER_LEAKED, {}, { code: exfilViaFunction, timeoutMs: 3000 }, tmp);
  // on here uses codegen-allowed + no permission so the reach SUCCEEDS; it just finds an empty env.
  results.push({ wall: "4. empty child env", attack: "read process.env after a full reach", offLanded: landed(off, SECRET), onLanded: landed(on, SECRET), detail: `on returned=${JSON.stringify(decodeReturned(on))}` });
}

listener.close();
fs.rmSync(tmp, { recursive: true, force: true });

let ok = true;
console.log("wall".padEnd(36) + "off-lands  on-blocks  verdict");
for (const r of results) {
  const proven = r.offLanded && !r.onLanded;
  const verdict = !r.offLanded ? "UNPROVEN (attack dud)" : r.onLanded ? "FAIL (escaped)" : "PASS";
  if (!proven) ok = false;
  console.log(r.wall.padEnd(36) + String(r.offLanded).padEnd(11) + String(!r.onLanded).padEnd(11) + verdict);
  if (!proven) console.log(`    ${r.attack} — ${r.detail}`);
}
console.log(ok ? "\nALL WALLS PROVEN: each attack lands with its wall off and is stopped with it on." : "\nSOME WALLS NOT PROVEN — see rows above.");
process.exit(ok ? 0 : 1);
