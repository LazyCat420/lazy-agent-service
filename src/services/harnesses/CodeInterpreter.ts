import logger from "../../utils/logger.ts";

import type { ToolCall, ToolResult, ToolSchema } from "./types.ts";

/**
 * CodeInterpreter — Hermes-pattern `code_interpreter` escape hatch.
 *
 * When a model emits a tool call named `code_interpreter` and NO sandboxed
 * code-execution tool is registered, the harness evaluates the fenced code
 * block locally instead of failing with an unknown-tool error:
 *   - ```javascript / ```js blocks run via `new Function(code)` with a 5s
 *     timeout (Promise race — the repo's standard deadline pattern) and a
 *     sandboxed console shim that captures output.
 *   - ```python blocks return a structured "not available on this runtime"
 *     observation (this runtime has no Python).
 *   - Static guard scans refuse code that touches require/import/process/
 *     fs/child_process with a structured refusal observation.
 *
 * If a real code-execution tool IS registered, callers must dispatch to it
 * instead (see partitionCodeInterpreterCalls).
 *
 * Reference: docs/harness-research/PLAN_hermes.md §4. This is NOT a security
 * sandbox — the guard is a best-effort static scan; `new Function` runs on
 * the host with the harness's own privileges. Synchronous infinite loops
 * cannot be interrupted (the 5s deadline races async completion only).
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
 * Execute a ```javascript block: `new Function(code)` with a sandboxed
 * console shim and a 5s completion deadline (Promise race — the repo's
 * standard deadline pattern, cf. McpAdapter.raceToolDeadline).
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

  const logs: string[] = [];
  const format = (value: unknown): string => {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  };
  const sandboxConsole = {
    log: (...args: unknown[]) => logs.push(args.map(format).join(" ")),
    info: (...args: unknown[]) => logs.push(args.map(format).join(" ")),
    warn: (...args: unknown[]) => logs.push(args.map(format).join(" ")),
    error: (...args: unknown[]) => logs.push(args.map(format).join(" ")),
    debug: () => {},
    trace: () => {},
  };

  let deadlineReject: ((reason: Error) => void) | undefined;
  const timer = setTimeout(() => {
    deadlineReject?.(new Error(`code_interpreter timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const deadline = new Promise<never>((_, reject) => {
    deadlineReject = reject;
  });
  let returned: unknown;
  try {
    // eslint-disable-next-line no-new-func -- escape hatch by design; guard scanned above
    const fn = new Function("console", `"use strict";\n${code}`);
    const invocation = Promise.resolve(fn(sandboxConsole));
    returned = await Promise.race([invocation, deadline]);
  } catch (executionError) {
    clearTimeout(timer);
    const message =
      executionError instanceof Error
        ? executionError.message
        : String(executionError);
    logger.warn(`[CodeInterpreter] javascript block failed: ${message}`);
    return {
      success: false,
      error: "CODE_INTERPRETER_ERROR",
      message,
      output: logs,
    };
  }
  clearTimeout(timer);
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
