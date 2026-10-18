import type {
  CoreTool,
  CoreToolCall,
  CoreToolResult,
  RunToolBatch,
  ToolBatchOptions,
} from "./types.ts";

/** Test seam: lets tests inject an abortable signal instead of AbortSignal.timeout's real timer. */
type ToolRunnerOptions = ToolBatchOptions & {
  timeoutSignalFor?: (toolName: string, ms: number) => AbortSignal;
};

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

const validateArgs = (tool: CoreTool, args: Record<string, unknown>): string[] => {
  const problems: string[] = [];
  const params = tool.parameters as { required?: unknown; properties?: Record<string, { type?: string }> };
  const required = Array.isArray(params.required) ? (params.required as string[]) : [];
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

export const runToolBatch: RunToolBatch = async (calls, options) => {
  const opts = options as ToolRunnerOptions;
  const timeoutSignalFor =
    typeof opts.timeoutSignalFor === "function"
      ? opts.timeoutSignalFor
      : (_toolName: string, ms: number) => AbortSignal.timeout(ms);
  const hooks = opts.hooks;
  const results: CoreToolResult[] = new Array(calls.length);

  const processCall = async (call: CoreToolCall, index: number): Promise<void> => {
    const start = opts.now();
    let result: CoreToolResult | undefined;
    const tool = opts.tools.get(call.name);

    if (tool === undefined) {
      result = {
        toolCallId: call.id,
        name: call.name,
        content: notFoundContent(call.name, [...opts.tools.keys()].sort()),
        isError: true,
        errorCode: "TOOL_NOT_FOUND",
        durationMs: opts.now() - start,
      };
    }

    let args = call.args;
    if (
      result === undefined &&
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

    if (result === undefined) {
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

    if (result === undefined) {
      const timeoutMs = tool.timeoutMs ?? opts.defaultToolTimeoutMs;
      const timeoutSignal = timeoutSignalFor(tool.name, timeoutMs);
      const signal = AbortSignal.any([opts.signal, timeoutSignal]);
      let outcome: { ok: true; value: unknown } | { ok: false; error: unknown } | undefined;
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
      else signal.addEventListener("abort", () => aborted.resolve("abort"), { once: true });
      const winner = await Promise.race([exec.then(() => "exec" as const), aborted.promise]);

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
          const head = Math.floor(opts.toolOutputCap * 0.7);
          const tail = opts.toolOutputCap - head - 120;
          const cut = content.length - head - tail;
          content =
            content.slice(0, head) +
            `\n…[cut ${cut} chars of ${content.length}; ask for a narrower range if you need the middle]…\n` +
            content.slice(content.length - tail);
        }
        result = {
          toolCallId: call.id,
          name: call.name,
          content,
          isError: false,
          durationMs: opts.now() - start,
        };
      } else if (winner === "exec" && outcome !== undefined && outcome.ok === false) {
        result = {
          toolCallId: call.id,
          name: call.name,
          content: `{"error":${JSON.stringify(errorMessage(outcome.error))}}`.slice(0, opts.toolErrorCap),
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

    if (result.isError && result.errorCode !== "TOOL_DENIED" && result.errorCode !== "TOOL_CANCELLED") {
      opts.failureStreak.set(call.name, (opts.failureStreak.get(call.name) ?? 0) + 1);
    } else if (!result.isError) {
      opts.failureStreak.delete(call.name);
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

  const exclusiveIndices: number[] = [];
  const parallel: Promise<void>[] = [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const tool = opts.tools.get(call.name);
    if (tool?.exclusive === true) exclusiveIndices.push(i);
    else parallel.push(processCall(call, i));
  }
  await Promise.all(parallel);
  for (const i of exclusiveIndices) await processCall(calls[i], i);

  return results;
};
