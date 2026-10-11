import { Worker } from "node:worker_threads";

import logger from "../../utils/logger.ts";

import type { ToolCall, ToolResult, ToolSchema } from "./types.ts";

/**
 * CodeInterpreter — Hermes-pattern `code_interpreter` escape hatch.
 *
 * When a model emits a tool call named `code_interpreter` and NO sandboxed
 * code-execution tool is registered, the harness evaluates the fenced code
 * block locally instead of failing with an unknown-tool error:
 *   - ```javascript / ```js blocks run in a `worker_threads` Worker (empty
 *     env, resource limits) inside a host-object-free `vm` context; the 5s
 *     deadline terminates the worker, so sync loops are killed too.
 *   - ```python blocks return a structured "not available on this runtime"
 *     observation (this runtime has no Python).
 *   - Static guard scans refuse code that touches require/import/process/
 *     fs/child_process with a structured refusal observation.
 *
 * If a real code-execution tool IS registered, callers must dispatch to it
 * instead (see partitionCodeInterpreterCalls).
 *
 * Reference: docs/harness-research/PLAN_hermes.md §4. Isolation comes from
 * the worker + vm context, not the static scan (which is only a fast-path
 * refusal). Interpreter calls still pass the approval gate in the harness.
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
 * Worker body. Runs the snippet in a fresh `vm` context that holds NO host
 * objects, with string code generation off. The boundary rule: NO
 * worker-realm function is ever handed to an object the snippet controls
 * (a worker function's .constructor is the worker's real Function, which
 * compiles strings and reaches the real process — the classic thenable
 * escape found in the 2026-10-11 security review). So settling a returned
 * promise, formatting errors and serializing results all happen inside the
 * context through closures captured before the snippet runs; the worker only
 * passes context values back in and reads a JSON string out. The worker is
 * spawned with an empty env and resource limits and is terminated by the
 * parent on deadline, so a synchronous `while(true){}` cannot block the
 * service event loop.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const context = vm.createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false },
});
const prelude = \`
  "use strict";
  (() => {
    const stringify = JSON.stringify;
    const resolve = Promise.resolve.bind(Promise);
    const then = Promise.prototype.then;
    const call = Function.prototype.call.bind(then);
    const logs = [];
    const fmt = (v) => { if (typeof v === "string") return v; try { const s = stringify(v); return s === undefined ? String(v) : s; } catch { return "[unserializable]"; } };
    const push = (...a) => { logs.push(a.map(fmt).join(" ")); };
    const drain = (value) => { let r; try { r = stringify(value); } catch { r = undefined; } return stringify({ logs: logs.slice(), returned: typeof r === "string" ? r : undefined }); };
    const describe = (e) => { try { const m = e && e.message !== undefined ? e.message : e; return typeof m === "string" ? m : String(m); } catch { return "error"; } };
    const state = { out: "" };
    const lock = (name, value) => Object.defineProperty(globalThis, name, { value, writable: false, configurable: false, enumerable: false });
    lock("console", Object.freeze({ log: push, info: push, warn: push, error: push, debug() {}, trace() {} }));
    lock("__settle", (v) => {
      call(resolve(v),
        (r) => { state.out = stringify({ ok: true, payload: drain(r) }); },
        (e) => { state.out = stringify({ ok: false, message: describe(e), payload: drain(undefined) }); });
    });
    lock("__fail", (e) => stringify({ ok: false, message: describe(e), payload: drain(undefined) }));
    lock("__poll", () => state.out);
  })();
\`;
const send = (msg) => parentPort.postMessage(msg);
const parse = (text) => {
  try {
    const m = JSON.parse(String(text));
    return { ok: m.ok === true, message: typeof m.message === "string" ? m.message : undefined, payload: typeof m.payload === "string" ? m.payload : undefined };
  } catch { return { ok: false, message: "code_interpreter produced an unreadable result" }; }
};
vm.runInContext(prelude, context, { timeout: 1000 });
// Captured before the snippet runs; non-writable, so the snippet cannot swap them.
const settle = vm.runInContext("__settle", context);
const fail = vm.runInContext("__fail", context);
const poll = vm.runInContext("__poll", context);
try {
  const wrapped = '(function(){\\n"use strict";\\n' + workerData.code + '\\n})()';
  const value = vm.runInContext(wrapped, context, { timeout: workerData.timeoutMs });
  settle(value);
  const check = () => {
    const out = poll();
    if (typeof out === "string" && out) send(parse(out));
    else setTimeout(check, 2);
  };
  check();
} catch (e) {
  let out;
  try { out = fail(e); } catch { out = undefined; }
  send(typeof out === "string" ? parse(out) : { ok: false, message: "code_interpreter failed" });
}
`;

interface WorkerReply {
  ok: boolean;
  message?: string;
  payload?: string;
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
 * Execute a ```javascript block in an isolated worker (see WORKER_SOURCE).
 * The deadline is enforced by `worker.terminate()`, which also kills
 * synchronous infinite loops.
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

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    env: {},
    argv: [],
    execArgv: [],
    stdout: true,
    stderr: true,
    workerData: { code, timeoutMs },
    resourceLimits: {
      maxOldGenerationSizeMb: 64,
      maxYoungGenerationSizeMb: 16,
      codeRangeSizeMb: 16,
      stackSizeMb: 4,
    },
  });

  const reply = await new Promise<WorkerReply>((resolve) => {
    let settled = false;
    const settle = (value: WorkerReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(value);
    };
    const timer = setTimeout(
      () => settle({ ok: false, message: `code_interpreter timed out after ${timeoutMs}ms` }),
      timeoutMs,
    );
    worker.once("message", (msg: WorkerReply) => settle(msg));
    worker.once("error", (err: Error) => settle({ ok: false, message: err.message }));
    worker.once("exit", (exitCode) =>
      // Exit without a message = the event loop drained with the snippet's
      // promise still pending: it can never settle, so report the deadline.
      settle({
        ok: false,
        message:
          exitCode === 0
            ? `code_interpreter timed out after ${timeoutMs}ms (promise never settled)`
            : `code_interpreter worker exited (code ${exitCode})`,
      }),
    );
  });

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
