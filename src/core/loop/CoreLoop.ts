/**
 * Core loop: model call → tool calls → paired results → repeat; one final toolless pass on any
 * budget/limit, then either the model's final answer or a synthetic summary of tool output.
 */
import type { ChatMessage } from "../../types/ProviderTypes.ts";
import type { StreamChunk } from "../../types/provider.ts";
import type {
  CoreFinalizeReason,
  CoreLoopEvent,
  CoreLoopOptions,
  CoreLoopResult,
  CoreToolCall,
  CoreToolSchema,
} from "./types.ts";
import { runToolBatch } from "./ToolRunner.ts";

const EMPTY_REPLY_NUDGE = "Your last reply was empty. Answer the user's question now.";
const FINAL_PASS_INSTRUCTION =
  "Time, budget or step limit reached. Do not call tools. Answer the user now using only the information already gathered, and say briefly what you could not check.";
const CONTINUE_CUT_INSTRUCTION =
  "Your previous reply was cut off by the time limit. Do not call tools. Continue the answer from exactly where it stopped, without repeating what you already wrote.";
const CUT_OFF_NOTE =
  '{"error":"Your reply was cut off before the tool call was complete. Call fewer tools or use shorter arguments."}';

const errorOf = (error: unknown): { code: string; message: string } => ({
  code:
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "PROVIDER_ERROR",
  message: error instanceof Error ? error.message : String(error),
});

/** Generator hygiene: only ever leaves a stream open when close itself fails. */
const closeStream = async (stream: AsyncIterable<StreamChunk> | undefined): Promise<void> => {
  if (!stream) return;
  // Well-known protocol shape: an async generator exposes `return`; other iterables need nothing.
  const generator = stream as AsyncGenerator;
  if (typeof generator.return !== "function") return;
  try {
    await generator.return(undefined);
  } catch {
    // stream already dead; nothing to close
  }
};

export async function* runCoreLoop(
  options: CoreLoopOptions,
): AsyncGenerator<CoreLoopEvent, CoreLoopResult> {
  const defaultToolTimeoutMs = options.defaultToolTimeoutMs ?? 60_000;
  const toolOutputCap = options.toolOutputCap ?? 16_000;
  const toolErrorCap = options.toolErrorCap ?? 2_048;
  const providerRetries = options.providerRetries ?? 2;
  const maxConsecutiveToolErrors = options.maxConsecutiveToolErrors ?? 3;
  const now = options.now ?? Date.now;

  const workSignal = options.finalizeSignal ? AbortSignal.any([options.signal, options.finalizeSignal]) : options.signal;
  const finalizeCut = (): boolean => options.finalizeSignal?.aborted === true && !options.signal.aborted;

  const messages: ChatMessage[] = [...options.messages];
  const toolMap = new Map(options.tools.map((tool) => [tool.name, tool]));
  const schemas: CoreToolSchema[] = options.tools
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const failureStreak = new Map<string, number>();
  let modelCalls = 0;
  let toolCalls = 0;
  let nudged = false;
  let cutOffs = 0;
  let finalizeReason: CoreFinalizeReason | undefined;
  let cutText = "";
  let lastAssistantText = "";
  /** Non-error tool results seen in the run, for the synthetic fallback summary. */
  const usableToolResults: Array<{ name: string; content: string }> = [];

  const makeCancelled = (): CoreLoopResult => {
    // I3: every assistant toolCall id must have a tool message; fill in the missing ones.
    const seen = new Set(
      messages
        .filter((message) => message.role === "tool" && typeof message.tool_call_id === "string")
        .map((message) => message.tool_call_id as string),
    );
    for (const message of messages) {
      if (message.role !== "assistant" || !Array.isArray(message.toolCalls)) continue;
      for (const call of message.toolCalls) {
        const id = call.id;
        if (typeof id !== "string" || id === "" || seen.has(id)) continue;
        seen.add(id);
        messages.push({ role: "tool", tool_call_id: id, name: call.name, content: '{"error":"cancelled"}' });
      }
    }
    return {
      status: "cancelled",
      text: lastAssistantText,
      messages,
      modelCalls,
      toolCalls,
      answerSource: "model",
      error: { code: "RUN_CANCELLED", message: "cancelled" },
    };
  };

  while (true) {
    if (options.signal.aborted) return makeCancelled();

    if (finalizeReason === undefined) {
      if (finalizeCut()) finalizeReason = options.shouldFinalize?.() ?? "DEADLINE_SOFT";
    }
    if (finalizeReason === undefined) {
      const fromHook = options.shouldFinalize?.() ?? null;
      if (fromHook !== null) finalizeReason = fromHook;
      else if (modelCalls >= options.maxSteps) finalizeReason = "STEP_LIMIT";
    }
    if (finalizeReason !== undefined) break;

    let hooked = messages;
    if (options.hooks?.beforeModelCall) {
      for (const hook of options.hooks.beforeModelCall) {
        try {
          hooked = await hook(hooked, modelCalls);
        } catch (error) {
          yield {
            type: "warning",
            code: "HOOK_FAILED",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }

    const step = modelCalls;
    let text = "";
    let cutOff = false;
    const calls: CoreToolCall[] = [];

    for (let attempt = 0; attempt <= providerRetries; attempt++) {
      text = "";
      cutOff = false;
      calls.length = 0;
      yield { type: "model.start", step, finalPass: false };
      modelCalls++;
      let stream: AsyncIterable<StreamChunk> | undefined;
      try {
        stream = options.model({
          messages: hooked,
          tools: schemas,
          toolChoice: "auto",
          signal: workSignal,
          finalPass: false,
        });
        for await (const chunk of stream) {
          if (typeof chunk === "string") {
            text += chunk;
            yield { type: "text.delta", text: chunk };
          } else if (chunk.type === "thinking") {
            yield { type: "thinking.delta", text: chunk.content };
          } else if (chunk.type === "toolCall") {
            const id = chunk.id ?? `call_${step}_${calls.length}`;
            const args = typeof chunk.args === "string" ? { __raw: chunk.args } : chunk.args;
            calls.push({ id, name: chunk.name, args });
          } else if (chunk.type === "usage") {
            yield { type: "usage", usage: { ...chunk.usage } };
          } else if (chunk.type === "stopReason" && chunk.stopReason === "length") {
            cutOff = true;
          }
        }
        break;
      } catch (caught) {
        await closeStream(stream);
        const code = errorOf(caught).code;
        if (code === "TOKEN_BUDGET_FINALIZE") {
          finalizeReason = "TOKEN_BUDGET";
          break;
        }
        if (finalizeCut()) {
          if (calls.length === 0) cutText = text;
          finalizeReason = options.shouldFinalize?.() ?? "DEADLINE_SOFT";
          break;
        }
        if (options.signal.aborted) return makeCancelled();
        if (attempt === providerRetries) {
          const failure = errorOf(caught);
          finalizeReason = "PROVIDER_ERROR";
          yield { type: "warning", code: failure.code, message: failure.message };
          break;
        }
        yield { type: "warning", code: "PROVIDER_RETRY", message: errorOf(caught).message };
      }
    }
    if (finalizeReason !== undefined) continue;

    const assistant: ChatMessage = { role: "assistant", content: text };
    if (calls.length > 0) {
      assistant.toolCalls = calls.map((call) => ({ id: call.id, name: call.name, args: call.args }));
    }
    messages.push(assistant);
    if (text.trim() !== "") lastAssistantText = text;

    if (cutOff && calls.length > 0) {
      for (const call of calls) {
        messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: CUT_OFF_NOTE });
        yield {
          type: "tool.end",
          call,
          result: { toolCallId: call.id, name: call.name, content: CUT_OFF_NOTE, isError: true, errorCode: "REPLY_CUT_OFF", durationMs: 0 },
        };
      }
      cutOffs++;
      if (cutOffs >= 2) finalizeReason = "CUT_OFF_TWICE";
      continue;
    }

    if (calls.length === 0) {
      if (text.trim() !== "") {
        return {
          status: "completed",
          text,
          messages,
          modelCalls,
          toolCalls,
          finalizeReason,
          answerSource: "model",
        };
      }
      if (!nudged) {
        nudged = true;
        messages.push({ role: "user", content: EMPTY_REPLY_NUDGE });
        continue;
      }
      finalizeReason = "EMPTY_REPLY";
      continue;
    }

    for (const call of calls) yield { type: "tool.start", call };
    const results = await runToolBatch(calls, {
      tools: toolMap,
      hooks: options.hooks,
      signal: workSignal,
      defaultToolTimeoutMs,
      toolOutputCap,
      toolErrorCap,
      maxConsecutiveToolErrors,
      failureStreak,
      now,
      timeoutSignalFor: options.timeoutSignalFor,
    });
    toolCalls += calls.length;
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index]!;
      const result = results[index]!;
      messages.push({ role: "tool", tool_call_id: result.toolCallId, name: result.name, content: result.content });
      if (!result.isError && result.content.trim() !== "") {
        usableToolResults.push({ name: result.name, content: result.content });
      }
      yield { type: "tool.end", call, result };
    }
    if (options.signal.aborted) return makeCancelled();
  }

  // Final pass: one toolless turn (runs at most once).
  yield { type: "finalize", reason: finalizeReason! };
  if (cutText.trim() !== "") {
    messages.push({ role: "assistant", content: cutText });
    messages.push({ role: "user", content: CONTINUE_CUT_INSTRUCTION });
  } else {
    messages.push({ role: "user", content: FINAL_PASS_INSTRUCTION });
  }

  let hooked = messages;
  if (options.hooks?.beforeModelCall) {
    for (const hook of options.hooks.beforeModelCall) {
      try {
        hooked = await hook(hooked, modelCalls);
      } catch (error) {
        yield {
          type: "warning",
          code: "HOOK_FAILED",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  yield { type: "model.start", step: modelCalls, finalPass: true };
  modelCalls++;
  let finalText = "";
  let finalError: unknown;
  const finalTimeout =
    options.finalPassTimeoutMs === undefined
      ? undefined
      : (options.finalPassSignalFor ?? ((ms: number) => AbortSignal.timeout(ms)))(options.finalPassTimeoutMs);
  const finalSignal = finalTimeout ? AbortSignal.any([options.signal, finalTimeout]) : options.signal;
  let finalTimedOut = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    let stream: AsyncIterable<StreamChunk> | undefined;
    try {
      stream = options.model({
        messages: hooked,
        tools: schemas,
        toolChoice: "none",
        finalPass: true,
        signal: finalSignal,
      });
      for await (const chunk of stream) {
        if (typeof chunk === "string") {
          finalText += chunk;
          yield { type: "text.delta", text: chunk };
        } else if (chunk.type === "thinking") {
          yield { type: "thinking.delta", text: chunk.content };
        } else if (chunk.type === "usage") {
          yield { type: "usage", usage: { ...chunk.usage } };
        }
        // Tool calls in the final pass are ignored: not run, not recorded.
      }
      finalError = undefined;
      break;
    } catch (error) {
      await closeStream(stream);
      finalError = error;
      if (options.signal.aborted) return makeCancelled();
      if (finalTimeout?.aborted) {
        finalTimedOut = true;
        break;
      }
    }
  }

  if (finalTimedOut) {
    yield { type: "warning", code: "FINAL_PASS_TIMEOUT", message: "The final answer pass ran out of time." };
    finalError = undefined;
  }

  const synthetic =
    usableToolResults.length === 0
      ? "I couldn't finish an answer and no tool returned usable results."
      : `I couldn't finish a full answer. Here is what the tools returned:\n${usableToolResults
          .map((entry) => `- ${entry.name}: ${entry.content.slice(0, 300)}`)
          .join("\n")}`;

  if (finalError !== undefined && usableToolResults.length > 0) {
    const failure = errorOf(finalError);
    yield { type: "warning", code: failure.code, message: failure.message };
    if (cutText.trim() !== "") {
      lastAssistantText = cutText;
      return {
        status: "completed",
        text: cutText,
        messages,
        modelCalls,
        toolCalls,
        finalizeReason,
        answerSource: "model",
      };
    }
    yield { type: "text.delta", text: synthetic };
    messages.push({ role: "assistant", content: synthetic });
    return {
      status: "completed",
      text: synthetic,
      messages,
      modelCalls,
      toolCalls,
      finalizeReason,
      answerSource: "synthetic",
    };
  }

  if (finalError !== undefined) {
    if (cutText.trim() !== "") {
      lastAssistantText = cutText;
      return {
        status: "completed",
        text: cutText,
        messages,
        modelCalls,
        toolCalls,
        finalizeReason,
        answerSource: "model",
      };
    }
    const error = errorOf(finalError);
    return {
      status: "failed",
      text: lastAssistantText,
      messages,
      modelCalls,
      toolCalls,
      finalizeReason,
      answerSource: "model",
      error,
    };
  }

  if (finalText.trim() !== "") {
    lastAssistantText = cutText + finalText;
    messages.push({ role: "assistant", content: finalText });
    return {
      status: "completed",
      text: cutText + finalText,
      messages,
      modelCalls,
      toolCalls,
      finalizeReason,
      answerSource: "model",
    };
  }

  if (cutText.trim() !== "") {
    lastAssistantText = cutText;
    return {
      status: "completed",
      text: cutText,
      messages,
      modelCalls,
      toolCalls,
      finalizeReason,
      answerSource: "model",
    };
  }

  yield { type: "text.delta", text: synthetic };
  messages.push({ role: "assistant", content: synthetic });
  return {
    status: "completed",
    text: synthetic,
    messages,
    modelCalls,
    toolCalls,
    finalizeReason,
    answerSource: "synthetic",
  };
}
