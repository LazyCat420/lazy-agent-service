import crypto from "node:crypto";
import type {
  CoreTool,
  CoreToolCall,
  CoreToolResult,
  RunToolBatch,
  ToolBatchOptions,
  ToolCallHistory,
} from "./types.ts";
import { READ_TOOL_SPILL_NAME } from "./SpillBuffer.ts";
import { stripMcpPrefix } from "../../services/McpPrefix.ts";

export const DEFAULT_PARALLEL_TOOL_CONCURRENCY = 8;

/** Test seam: lets tests inject an abortable signal instead of AbortSignal.timeout's real timer. */
type ToolRunnerOptions = ToolBatchOptions & {
  timeoutSignalFor?: (toolName: string, ms: number) => AbortSignal;
};

interface InternalHistoryEntry {
  name: string;
  fingerprint: string;
  isError: boolean;
  wasStall?: boolean;
  stalledCount?: number;
}

const defaultHistoryByStreak = new WeakMap<Map<string, number>, ToolCallHistory>();

export function createToolCallHistory(): ToolCallHistory {
  return {
    entries: [],
    finalizeNow: false,
  };
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) {
        out[k] = canonicalizeValue(v);
      }
    }
    return out;
  }
  return value;
}

/**
 * H2: Deterministic SHA-256 fingerprint of `(toolName, canonicalArgs)`.
 */
export function computeToolCallFingerprint(
  name: string,
  args: unknown,
): string {
  let serialized = "";
  try {
    serialized = JSON.stringify(canonicalizeValue(args ?? {}));
  } catch {
    serialized = String(args);
  }
  const digest = crypto
    .createHash("sha256")
    .update(`${name}:${serialized}`)
    .digest("hex")
    .slice(0, 24);
  return `${name}:${digest}`;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const typeChecks: Record<string, (value: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
};

/**
 * F1: Coerce string-encoded values to their schema types before validation.
 * Models frequently send JSON-encoded strings for structured params
 * (e.g. `"filters": "[{\"field\":\"pe\"}]"`, `"limit": "10"`). Only
 * top-level properties are coerced, and only when the parse/convert result
 * matches the schema type — anything else is left for validateArgs to reject.
 */
const coerceArgs = (
  tool: CoreTool,
  args: Record<string, unknown>,
): Record<string, unknown> => {
  const params = tool.parameters as {
    properties?: Record<string, { type?: string }>;
  };
  const properties = params.properties ?? {};
  const coerced: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(args)) {
    const expected = properties[key]?.type;
    if (!expected) continue;
    if (expected === "array" || expected === "object") {
      if (typeof value !== "string") continue;
      try {
        const parsed: unknown = JSON.parse(value);
        if (typeChecks[expected](parsed)) coerced[key] = parsed;
      } catch {
        // Not valid JSON — leave for validateArgs to reject.
      }
    } else if (expected === "integer" || expected === "number") {
      if (typeof value !== "string" || value.trim() === "") continue;
      const n = Number(value);
      if (!Number.isNaN(n)) coerced[key] = n;
    }
  }
  return coerced;
};

const validateArgs = (tool: CoreTool, args: Record<string, unknown>): string[] => {
  const problems: string[] = [];
  const params = tool.parameters as {
    required?: unknown;
    properties?: Record<string, { type?: string }>;
  };
  const required = Array.isArray(params.required)
    ? (params.required as string[])
    : [];
  const properties = params.properties ?? {};
  for (const key of required) {
    if (args[key] === undefined) problems.push(`missing required "${key}"`);
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const expected = properties[key]?.type;
    if (!expected) continue;
    const check = typeChecks[expected];
    if (check && !check(value)) problems.push(`"${key}" must be ${expected}`);
  }
  return problems;
};

/** One repair attempt: strip a ```json fence, drop trailing commas, JSON.parse. */
const repairJson = (raw: string): Record<string, unknown> | undefined => {
  let s = raw.trim();
  if (s.startsWith("```json")) s = s.slice(7);
  else if (s.startsWith("```")) s = s.slice(3);
  if (s.endsWith("```")) s = s.slice(0, -3);
  s = s.replace(/,\s*([}\]])/g, "$1").trim();
  try {
    const parsed: unknown = JSON.parse(s);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

const notFoundContent = (name: string, available: string[]): string => {
  let content = `Tool "${name}" not found. Available tools: ${available.join(", ")}.`;
  let best: string | undefined;
  let bestDistance = 4;
  for (const candidate of available) {
    const lowerName = name.toLowerCase();
    const lowerCandidate = candidate.toLowerCase();
    // Inline Levenshtein: containment counts as distance 0.
    const distance =
      lowerCandidate.includes(lowerName) || lowerName.includes(lowerCandidate)
        ? 0
        : (() => {
            const a = lowerName;
            const b = lowerCandidate;
            let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
            for (let i = 1; i <= a.length; i++) {
              const curr = [i];
              for (let j = 1; j <= b.length; j++) {
                curr[j] = Math.min(
                  prev[j] + 1,
                  curr[j - 1] + 1,
                  prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
                );
              }
              prev = curr;
            }
            return prev[b.length];
          })();
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  if (best !== undefined) content += ` Did you mean "${best}"?`;
  return content;
};

function resolveCallHistory(opts: ToolRunnerOptions): ToolCallHistory {
  if (opts.callHistory) return opts.callHistory;
  let existing = defaultHistoryByStreak.get(opts.failureStreak);
  if (!existing) {
    existing = createToolCallHistory();
    defaultHistoryByStreak.set(opts.failureStreak, existing);
  }
  return existing;
}

/**
 * H2: Check whether calling `(call.name, fingerprint)` triggers an immediate
 * consecutive-duplicate stall or a 3-cycle A<->B oscillation in the last 6 calls.
 */
function checkSemanticStallOrOscillation(
  history: ToolCallHistory,
  callName: string,
  fingerprint: string,
): {
  blocked: boolean;
  errorCode?: "TOOL_STALL" | "TOOL_OSCILLATION";
  content?: string;
  stalledCount?: number;
} {
  const entries = history.entries as InternalHistoryEntry[];
  const last = entries.length > 0 ? entries[entries.length - 1] : undefined;

  // 1. Consecutive identical tool+args check (for parameterized calls after a successful call or prior stall)
  const hasArgs = fingerprint !== computeToolCallFingerprint(callName, {});
  if (
    hasArgs &&
    last &&
    last.fingerprint === fingerprint &&
    (!last.isError || last.wasStall === true)
  ) {
    const prevStalls = last.stalledCount ?? 0;
    if (prevStalls === 0) {
      // 2nd consecutive identical call -> block with structured guidance
      return {
        blocked: true,
        errorCode: "TOOL_STALL",
        stalledCount: 1,
        content: JSON.stringify({
          code: "TOOL_STALL",
          error: `Duplicate tool call blocked: "${callName}" was just called with identical arguments.`,
          retry_guidance: `"${callName}" with identical arguments already succeeded in the previous call. Reuse the existing result from your context or change the arguments.`,
        }),
      };
    }
    // 3rd+ consecutive identical call -> block AND force finalization
    history.finalizeNow = true;
    history.finalizeReason = `repeated_tool_call:${callName}`;
    return {
      blocked: true,
      errorCode: "TOOL_STALL",
      stalledCount: prevStalls + 1,
      content: JSON.stringify({
        code: "TOOL_STALL",
        error: `Repeated tool call limit reached for "${callName}" (3 consecutive identical calls). Forcing final synthesis.`,
        finalizeReason: `repeated_tool_call:${callName}`,
      }),
    };
  }

  // 2. 3rd A<->B alternating cycle in the last 6 calls: [A, B, A, B, A] + current B
  if (entries.length >= 5) {
    const w0 = entries[entries.length - 5];
    const w1 = entries[entries.length - 4];
    const w2 = entries[entries.length - 3];
    const w3 = entries[entries.length - 2];
    const w4 = entries[entries.length - 1];
    const isAlternatingAB =
      w0.fingerprint !== w1.fingerprint &&
      w0.fingerprint === w2.fingerprint &&
      w2.fingerprint === w4.fingerprint &&
      w1.fingerprint === w3.fingerprint &&
      w3.fingerprint === fingerprint;

    if (isAlternatingAB) {
      return {
        blocked: true,
        errorCode: "TOOL_OSCILLATION",
        stalledCount: 1,
        content: JSON.stringify({
          code: "TOOL_OSCILLATION",
          error: `Oscillation detected: tool calls are alternating repeatedly between "${w4.name}" and "${callName}" (3 A<->B cycles in the last 6 calls).`,
          retry_guidance: `Stop alternating between "${w4.name}" and "${callName}". Synthesize an answer from the outputs you already have or try a different approach.`,
        }),
      };
    }
  }

  return { blocked: false };
}

/**
 * Map a bare tool name to its MCP-namespaced registration when exactly one
 * tool in the run's map strips to it. cycle-v3-1792387891: nemotron35 called
 * `whiteboard_read` for `mcp__lazy-agent-service__whiteboard_read` and got
 * TOOL_NOT_FOUND, a wasted turn. Ambiguous or unknown names stay as called and
 * still answer TOOL_NOT_FOUND. The map is already the run's whitelist, and the
 * resolved name is what hooks, history and the result carry.
 */
function resolveBareToolName(tools: ReadonlyMap<string, CoreTool>, name: string): string {
  if (tools.has(name)) return name;
  let match: string | undefined;
  for (const key of tools.keys()) {
    if (key === name || stripMcpPrefix(key) !== name) continue;
    if (match !== undefined) return name;
    match = key;
  }
  return match ?? name;
}

export const runToolBatch: RunToolBatch = async (requestedCalls, options) => {
  const opts = options as ToolRunnerOptions;
  const calls = requestedCalls.map((call) => {
    const name = resolveBareToolName(opts.tools, call.name);
    return name === call.name ? call : { ...call, name };
  });
  const timeoutSignalFor =
    typeof opts.timeoutSignalFor === "function"
      ? opts.timeoutSignalFor
      : (_toolName: string, ms: number) => AbortSignal.timeout(ms);
  const hooks = opts.hooks;
  const history = resolveCallHistory(opts);
  const results: CoreToolResult[] = new Array(calls.length);

  const processCall = async (
    call: CoreToolCall,
    index: number,
    onExecSettled?: () => Promise<void>,
  ): Promise<void> => {
    const start = opts.now();
    let result: CoreToolResult | undefined;

    let args = call.args;
    if (
      args !== null &&
      typeof args === "object" &&
      !Array.isArray(args) &&
      Object.keys(args).length === 1 &&
      typeof args.__raw === "string"
    ) {
      const raw = args.__raw;
      const repaired = repairJson(raw);
      if (repaired === undefined) {
        result = {
          toolCallId: call.id,
          name: call.name,
          content: `Arguments were not valid JSON: ${raw.slice(0, 200)}`,
          isError: true,
          errorCode: "TOOL_BAD_ARGS",
          durationMs: opts.now() - start,
        };
      } else {
        args = repaired;
      }
    }

    // H5: Built-in handling of `read_tool_spill` when SpillBuffer is attached and no custom tool overrides it
    const tool = opts.tools.get(call.name);
    if (
      result === undefined &&
      tool === undefined &&
      call.name === READ_TOOL_SPILL_NAME &&
      opts.spillBuffer !== undefined
    ) {
      const spillId =
        typeof args?.spill_id === "string" ? args.spill_id.trim() : "";
      if (!spillId) {
        result = {
          toolCallId: call.id,
          name: call.name,
          content:
            'Invalid arguments for "read_tool_spill": missing required "spill_id".',
          isError: true,
          errorCode: "TOOL_BAD_ARGS",
          durationMs: opts.now() - start,
        };
      } else {
        const offset = typeof args.offset === "number" ? args.offset : 0;
        const length = typeof args.length === "number" ? args.length : 8_000;
        const readOutcome = opts.spillBuffer.read(spillId, offset, length);
        if (readOutcome.ok === false) {
          const errText = (readOutcome as { ok: false; error: string }).error;
          result = {
            toolCallId: call.id,
            name: call.name,
            content: JSON.stringify({ error: errText }),
            isError: true,
            errorCode: "TOOL_BAD_ARGS",
            durationMs: opts.now() - start,
          };
        } else {
          result = {
            toolCallId: call.id,
            name: call.name,
            content: JSON.stringify(readOutcome),
            isError: false,
            durationMs: opts.now() - start,
          };
        }
      }
    }

    if (result === undefined && tool === undefined) {
      const available = [...opts.tools.keys()];
      if (opts.spillBuffer !== undefined && !available.includes(READ_TOOL_SPILL_NAME)) {
        available.push(READ_TOOL_SPILL_NAME);
      }
      result = {
        toolCallId: call.id,
        name: call.name,
        content: notFoundContent(call.name, available.sort()),
        isError: true,
        errorCode: "TOOL_NOT_FOUND",
        durationMs: opts.now() - start,
      };
    }

    if (result === undefined && tool !== undefined) {
      args = coerceArgs(tool, args);
      const problems = validateArgs(tool, args);
      if (problems.length > 0) {
        result = {
          toolCallId: call.id,
          name: call.name,
          content: `Invalid arguments for "${call.name}": ${problems.join("; ")}.`,
          isError: true,
          errorCode: "TOOL_BAD_ARGS",
          durationMs: opts.now() - start,
        };
      }
    }

    if (result === undefined) {
      const streak = opts.failureStreak.get(call.name) ?? 0;
      if (streak >= opts.maxConsecutiveToolErrors) {
        result = {
          toolCallId: call.id,
          name: call.name,
          content: `"${call.name}" failed ${streak} times in a row; stop calling it and answer with what you have or use another tool.`,
          isError: true,
          errorCode: "TOOL_REPEATED_FAILURE",
          durationMs: opts.now() - start,
        };
      }
    }

    // H2: Semantic stall & oscillation check before executing the tool
    const fingerprint = computeToolCallFingerprint(call.name, args);
    let stallRecord:
      | { wasStall: boolean; stalledCount: number }
      | undefined;

    if (result === undefined) {
      const stallCheck = checkSemanticStallOrOscillation(
        history,
        call.name,
        fingerprint,
      );
      if (stallCheck.blocked) {
        stallRecord = {
          wasStall: true,
          stalledCount: stallCheck.stalledCount ?? 1,
        };
        result = {
          toolCallId: call.id,
          name: call.name,
          content: (stallCheck.content ?? '{"error":"tool call stalled"}').slice(
            0,
            opts.toolErrorCap,
          ),
          isError: true,
          errorCode: stallCheck.errorCode ?? "TOOL_STALL",
          durationMs: opts.now() - start,
        };
      }
    }

    if (result === undefined) {
      for (const hook of hooks?.beforeToolCall ?? []) {
        try {
          const decision = await hook({ ...call, args }, opts.signal);
          if (decision.action === "deny") {
            result = {
              toolCallId: call.id,
              name: call.name,
              content: `Tool call denied: ${decision.reason}`,
              isError: true,
              errorCode: "TOOL_DENIED",
              durationMs: opts.now() - start,
            };
            break;
          }
          if (decision.args !== undefined) args = decision.args;
        } catch (error) {
          result = {
            toolCallId: call.id,
            name: call.name,
            content: `Tool call denied: policy check failed: ${errorMessage(error)}`,
            isError: true,
            errorCode: "TOOL_DENIED",
            durationMs: opts.now() - start,
          };
          break;
        }
      }
    }

    if (result === undefined && opts.signal.aborted) {
      result = {
        toolCallId: call.id,
        name: call.name,
        content: '{"error":"cancelled"}',
        isError: true,
        errorCode: "TOOL_CANCELLED",
        durationMs: 0,
      };
    }

    if (result === undefined && tool !== undefined) {
      const timeoutMs = tool.timeoutMs ?? opts.defaultToolTimeoutMs;
      const timeoutSignal = timeoutSignalFor(tool.name, timeoutMs);
      const signal = AbortSignal.any([opts.signal, timeoutSignal]);
      let outcome:
        | { ok: true; value: unknown }
        | { ok: false; error: unknown }
        | undefined;
      const exec = tool.execute(args, { toolCallId: call.id, signal }).then(
        (value) => {
          outcome = { ok: true, value };
        },
        (error: unknown) => {
          outcome = { ok: false, error };
        },
      );
      const aborted = Promise.withResolvers<"abort">();
      if (signal.aborted) aborted.resolve("abort");
      else
        signal.addEventListener("abort", () => aborted.resolve("abort"), {
          once: true,
        });
      const winner = await Promise.race([
        exec.then(() => "exec" as const),
        aborted.promise,
      ]);

      if (opts.signal.aborted) {
        result = {
          toolCallId: call.id,
          name: call.name,
          content: '{"error":"cancelled"}',
          isError: true,
          errorCode: "TOOL_CANCELLED",
          durationMs: opts.now() - start,
        };
      } else if (timeoutSignal.aborted) {
        result = {
          toolCallId: call.id,
          name: call.name,
          content: `{"error":"timed out after ${timeoutMs} ms"}`,
          isError: true,
          errorCode: "TOOL_TIMEOUT",
          durationMs: opts.now() - start,
        };
      } else if (winner === "exec" && outcome !== undefined && outcome.ok) {
        const raw =
          typeof outcome.value === "string"
            ? outcome.value
            : outcome.value === undefined || outcome.value === null
              ? ""
              : JSON.stringify(outcome.value);
        let content = raw === "" ? "(tool returned no output)" : raw;
        if (content.length > opts.toolOutputCap) {
          const fullLength = content.length;
          const spillId = opts.spillBuffer?.store(content) ?? null;
          const head = Math.floor(opts.toolOutputCap * 0.7);
          if (spillId !== null) {
            const prelimTail = Math.max(100, opts.toolOutputCap - head - 240);
            const cut = fullLength - head - prelimTail;
            const note = `\n…[cut ${cut} chars of ${fullLength} — full output stored in spill_id="${spillId}"; call read_tool_spill({"spill_id":"${spillId}","offset":${head},"length":8000}) to read middle sections]…\n`;
            const tail = Math.max(100, opts.toolOutputCap - head - note.length);
            content =
              content.slice(0, head) + note + content.slice(fullLength - tail);
          } else {
            const tail = opts.toolOutputCap - head - 120;
            const cut = fullLength - head - tail;
            content =
              content.slice(0, head) +
              `\n…[cut ${cut} chars of ${fullLength}; ask for a narrower range if you need the middle]…\n` +
              content.slice(fullLength - tail);
          }
        }
        result = {
          toolCallId: call.id,
          name: call.name,
          content,
          isError: false,
          durationMs: opts.now() - start,
        };
      } else if (
        winner === "exec" &&
        outcome !== undefined &&
        outcome.ok === false
      ) {
        // H4: Fission-GRPO Structured Tool-Failure Retry Guidance
        const errMsg = errorMessage(outcome.error);
        const attempt = (opts.failureStreak.get(call.name) ?? 0) + 1;
        let compactArgs = "{}";
        try {
          compactArgs = JSON.stringify(args ?? {}).slice(0, 160);
        } catch {
          compactArgs = "{}";
        }
        const retryGuidance = `Attempt ${attempt}/${opts.maxConsecutiveToolErrors} failed for ${call.name} with args ${compactArgs}: ${errMsg.slice(0, 200)}. Identify which argument caused this error and modify it, or use a different tool. Do not repeat identical arguments.`;
        const payload = JSON.stringify({
          error: errMsg,
          retry_guidance: retryGuidance,
        });
        result = {
          toolCallId: call.id,
          name: call.name,
          content: payload.slice(0, opts.toolErrorCap),
          isError: true,
          errorCode: "TOOL_THREW",
          durationMs: opts.now() - start,
        };
      } else {
        result = {
          toolCallId: call.id,
          name: call.name,
          content: '{"error":"cancelled"}',
          isError: true,
          errorCode: "TOOL_CANCELLED",
          durationMs: opts.now() - start,
        };
      }
    }

    if (result === undefined) {
      result = {
        toolCallId: call.id,
        name: call.name,
        content: '{"error":"cancelled"}',
        isError: true,
        errorCode: "TOOL_CANCELLED",
        durationMs: opts.now() - start,
      };
    }

    // Record into H2 history for semantic stall / oscillation detection
    if (
      result.errorCode !== "TOOL_CANCELLED" &&
      result.errorCode !== "TOOL_DENIED"
    ) {
      (history.entries as InternalHistoryEntry[]).push({
        name: call.name,
        fingerprint: computeToolCallFingerprint(call.name, args),
        isError: result.isError,
        wasStall: stallRecord?.wasStall ?? false,
        stalledCount: stallRecord?.stalledCount ?? 0,
      });
    }

    if (
      result.isError &&
      result.errorCode !== "TOOL_DENIED" &&
      result.errorCode !== "TOOL_CANCELLED" &&
      result.errorCode !== "TOOL_STALL" &&
      result.errorCode !== "TOOL_OSCILLATION"
    ) {
      opts.failureStreak.set(
        call.name,
        (opts.failureStreak.get(call.name) ?? 0) + 1,
      );
    } else if (!result.isError) {
      opts.failureStreak.delete(call.name);
    }

    if (onExecSettled) {
      await onExecSettled();
    }

    for (const hook of hooks?.afterToolCall ?? []) {
      try {
        result = (await hook(call, result)) ?? result;
      } catch {
        // A throwing after-hook leaves the result unchanged.
      }
    }

    results[index] = result;
  };

  // H10: Bounded concurrency semaphore for parallel non-exclusive tool calls
  const maxConcurrency = Math.max(
    1,
    opts.parallelToolMaxConcurrency ?? DEFAULT_PARALLEL_TOOL_CONCURRENCY,
  );
  const exclusiveIndices: number[] = [];
  const parallelIndices: number[] = [];

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const tool = opts.tools.get(call.name);
    if (tool?.exclusive === true) exclusiveIndices.push(i);
    else parallelIndices.push(i);
  }

  if (parallelIndices.length > 0) {
    let activeCount = 0;
    const waitQueue: Array<() => void> = [];
    let unenteredCount = parallelIndices.length;

    const acquireSlot = async (): Promise<void> => {
      if (activeCount < maxConcurrency) {
        activeCount += 1;
        unenteredCount -= 1;
        return;
      }
      await new Promise<void>((resolve) => {
        waitQueue.push(resolve);
      });
      unenteredCount -= 1;
    };

    const releaseSlotAndYieldIfQueued = async (): Promise<void> => {
      const next = waitQueue.shift();
      if (next) {
        next();
      } else {
        activeCount = Math.max(0, activeCount - 1);
      }
      // If later calls in the batch had not yet entered execute() because of the
      // concurrency cap, yield one tick so they enter execute() before afterToolCall runs.
      if (unenteredCount > 0 || next !== undefined) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };

    await Promise.all(
      parallelIndices.map(async (callIndex) => {
        await acquireSlot();
        await processCall(calls[callIndex], callIndex, releaseSlotAndYieldIfQueued);
      }),
    );
  }

  for (const i of exclusiveIndices) {
    await processCall(calls[i], i);
  }

  return results;
};
