/**
 * Shared fakes for the core-loop stress suite (S1–S18).
 *
 * `scriptedModel` streams a scripted list of chunk-lists, one per model call, and records every
 * `CoreModelRequest` it receives (deep-cloned messages/tools). Fakes must never use real timers:
 * hanging tools settle via `AbortSignal` listeners or never settle at all.
 */
import type { ChatMessage } from "../../../types/ProviderTypes.ts";
import type { StreamChunk } from "../../../types/provider.ts";
import type { CoreModel, CoreModelRequest, CoreTool } from "../types.ts";

/** One scripted turn: the chunks to stream, or `{ throw }` to make the model call reject. */
export type ScriptedTurn = StreamChunk[] | { throw: Error };

export interface CountingTool extends CoreTool {
  /** One entry per executed call, in execution order. */
  calls: Array<{ id: string; args: Record<string, unknown> }>;
}

export function scriptedModel(turns: ScriptedTurn[]): CoreModel & { calls: CoreModelRequest[] } {
  const calls: CoreModelRequest[] = [];
  let step = 0;
  const model = ((request: CoreModelRequest): AsyncIterable<StreamChunk> => {
    calls.push({
      ...request,
      messages: structuredClone(request.messages) as ChatMessage[],
      tools: structuredClone(request.tools),
    });
    const turn = turns[step];
    step += 1;
    return (async function* () {
      if (turn !== undefined && "throw" in turn) {
        throw turn.throw;
      }
      if (turn !== undefined) {
        for (const chunk of turn) {
          yield chunk;
        }
        return;
      }
      // Script exhausted: keep answering so the loop can always finish.
      yield "fallback answer";
    })();
  }) as CoreModel & { calls: CoreModelRequest[] };
  model.calls = calls;
  return model;
}

export function okTool(name: string, value: string): CoreTool {
  return {
    name,
    description: `always succeeds, returns a fixed string (${name})`,
    parameters: { type: "object", properties: {} },
    execute: async () => value,
  };
}

export function throwingTool(name: string, message: string): CoreTool {
  return {
    name,
    description: `always throws: ${message}`,
    parameters: { type: "object", properties: {} },
    execute: async () => {
      throw new Error(message);
    },
  };
}

export function hangingTool(name: string): CoreTool {
  return {
    name,
    description: "hangs forever unless its context signal aborts",
    parameters: { type: "object", properties: {} },
    execute: (_args, context) => {
      const { promise, resolve } = Promise.withResolvers<string>();
      context.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      return promise;
    },
  };
}

export function deafHangingTool(name: string): CoreTool {
  return {
    name,
    description: "hangs forever, even if its context signal aborts",
    parameters: { type: "object", properties: {} },
    execute: () => new Promise(() => {}),
  };
}

export function hugeTool(name: string, size: number): CoreTool {
  return {
    name,
    description: `returns ${size} characters`,
    parameters: { type: "object", properties: {} },
    execute: async () => "x".repeat(size),
  };
}

export function countingTool(name: string, result?: string): CountingTool {
  const calls: Array<{ id: string; args: Record<string, unknown> }> = [];
  const tool: CountingTool = {
    name,
    description: "records every call and returns a fixed string",
    parameters: { type: "object", properties: {} },
    calls,
    execute: async (args, context) => {
      calls.push({ id: context.toolCallId, args });
      return result ?? `count-ok:${name}`;
    },
  };
  return tool;
}

export function alwaysThrowingModel(error: Error): CoreModel & { calls: CoreModelRequest[] } {
  const calls: CoreModelRequest[] = [];
  const model = ((request: CoreModelRequest): AsyncIterable<StreamChunk> => {
    calls.push({
      ...request,
      messages: structuredClone(request.messages) as ChatMessage[],
      tools: structuredClone(request.tools),
    });
    return (async function* () {
      yield* [];
      throw error;
    })();
  }) as CoreModel & { calls: CoreModelRequest[] };
  model.calls = calls;
  return model;
}
