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
import { createToolCallHistory, runToolBatch } from "./ToolRunner.ts";
import { SpillBuffer } from "./SpillBuffer.ts";
import {
  RUNAWAY_RECOVERY_NUDGE,
  RunawayStreamWatch,
} from "./RunawayStreamWatch.ts";
import {
  substituteToolBatchPlaceholders,
  substituteToolOutputTokens,
} from "./ToolOutputSubstituter.ts";

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

function fillMissingCancelledToolMessages(messages: ChatMessage[]): void {
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
      messages.push({
        role: "tool",
        tool_call_id: id,
        name: call.name,
        content: '{"error":"cancelled"}',
      });
    }
  }
}

function makeCancelledLoopResult(
  messages: ChatMessage[],
  lastAssistantText: string,
  modelCalls: number,
  toolCalls: number,
): CoreLoopResult {
  fillMissingCancelledToolMessages(messages);
  return {
    status: "cancelled",
    text: lastAssistantText,
    messages,
    modelCalls,
    toolCalls,
    answerSource: "model",
    error: { code: "RUN_CANCELLED", message: "cancelled" },
  };
}

function checkLoopFinalizeCondition(
  finalizeReason: CoreFinalizeReason | undefined,
  finalizeCut: () => boolean,
  options: CoreLoopOptions,
  modelCalls: number,
): CoreFinalizeReason | undefined {
  if (finalizeReason !== undefined) return finalizeReason;
  if (finalizeCut()) return options.shouldFinalize?.() ?? "DEADLINE_SOFT";
  const fromHook = options.shouldFinalize?.() ?? null;
  if (fromHook !== null) return fromHook;
  if (modelCalls >= options.maxSteps) return "STEP_LIMIT";
  return undefined;
}

async function* runBeforeModelCallHooks(
  messages: ChatMessage[],
  hooks: CoreLoopOptions["hooks"],
  modelCalls: number,
): AsyncGenerator<CoreLoopEvent, ChatMessage[]> {
  let hooked = messages;
  if (!hooks?.beforeModelCall) return hooked;
  for (const hook of hooks.beforeModelCall) {
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
  return hooked;
}

interface SingleModelTurnState {
  text: string;
  thinking: string;
  cutOff: boolean;
  runawayTripped: boolean;
  runawayReason: string | null;
  calls: CoreToolCall[];
}

async function* consumeSingleModelStream(
  stream: AsyncIterable<StreamChunk>,
  step: number,
  state: SingleModelTurnState,
  runawayWatch: RunawayStreamWatch,
  streamAbort: AbortController,
): AsyncGenerator<CoreLoopEvent, void> {
  for await (const chunk of stream) {
    if (typeof chunk === "string") {
      state.text += chunk;
      yield { type: "text.delta", text: chunk };
      if (runawayWatch.feedText(chunk)) {
        state.runawayTripped = true;
        state.runawayReason = runawayWatch.reason;
        state.text = runawayWatch.cleanText(state.text);
        streamAbort.abort();
        await closeStream(stream);
        break;
      }
    } else if (chunk.type === "thinking") {
      state.thinking += chunk.content;
      yield { type: "thinking.delta", text: chunk.content };
      if (runawayWatch.feedThinking(chunk.content)) {
        state.runawayTripped = true;
        state.runawayReason = runawayWatch.reason;
        state.thinking = runawayWatch.cleanThinking(state.thinking);
        streamAbort.abort();
        await closeStream(stream);
        break;
      }
    } else if (chunk.type === "toolCall") {
      const id = chunk.id ?? `call_${step}_${state.calls.length}`;
      const args = typeof chunk.args === "string" ? { __raw: chunk.args } : chunk.args;
      state.calls.push({ id, name: chunk.name, args });
    } else if (chunk.type === "usage") {
      yield { type: "usage", usage: { ...chunk.usage } };
    } else if (chunk.type === "stopReason" && chunk.stopReason === "length") {
      state.cutOff = true;
    }
  }
}

async function* runModelTurnWithRetries(
  options: CoreLoopOptions,
  hooked: ChatMessage[],
  schemas: CoreToolSchema[],
  workSignal: AbortSignal,
  finalizeCut: () => boolean,
  providerRetries: number,
  initialStep: number,
): AsyncGenerator<
  CoreLoopEvent,
  {
    turn: SingleModelTurnState;
    modelCallsDelta: number;
    finalizeReason?: CoreFinalizeReason;
    cutText?: string;
    cancelled?: boolean;
  }
> {
  let modelCallsDelta = 0;
  const turn: SingleModelTurnState = {
    text: "",
    thinking: "",
    cutOff: false,
    runawayTripped: false,
    runawayReason: null,
    calls: [],
  };

  for (let attempt = 0; attempt <= providerRetries; attempt++) {
    turn.text = "";
    turn.thinking = "";
    turn.cutOff = false;
    turn.runawayTripped = false;
    turn.runawayReason = null;
    turn.calls.length = 0;
    const runawayWatch = new RunawayStreamWatch();
    const streamAbort = new AbortController();
    const turnSignal = AbortSignal.any([workSignal, streamAbort.signal]);

    yield { type: "model.start", step: initialStep, finalPass: false };
    modelCallsDelta++;
    let stream: AsyncIterable<StreamChunk> | undefined;
    try {
      stream = options.model({
        messages: hooked,
        tools: schemas,
        toolChoice: "auto",
        signal: turnSignal,
        finalPass: false,
      });
      yield* consumeSingleModelStream(stream, initialStep, turn, runawayWatch, streamAbort);
      break;
    } catch (caught) {
      await closeStream(stream);
      if (runawayWatch.tripped) {
        turn.runawayTripped = true;
        turn.runawayReason = runawayWatch.reason;
        turn.text = runawayWatch.cleanText(turn.text);
        turn.thinking = runawayWatch.cleanThinking(turn.thinking);
        break;
      }
      const failure = errorOf(caught);
      if (failure.code === "TOKEN_BUDGET_FINALIZE") {
        return { turn, modelCallsDelta, finalizeReason: "TOKEN_BUDGET" };
      }
      if (finalizeCut()) {
        return {
          turn,
          modelCallsDelta,
          cutText: turn.calls.length === 0 ? turn.text : undefined,
          finalizeReason: options.shouldFinalize?.() ?? "DEADLINE_SOFT",
        };
      }
      if (options.signal.aborted) {
        return { turn, modelCallsDelta, cancelled: true };
      }
      if (attempt === providerRetries) {
        yield { type: "warning", code: failure.code, message: failure.message };
        return { turn, modelCallsDelta, finalizeReason: "PROVIDER_ERROR" };
      }
      yield { type: "warning", code: "PROVIDER_RETRY", message: failure.message };
    }
  }
  return { turn, modelCallsDelta };
}

function appendRunawayAssistantMessage(
  messages: ChatMessage[],
  text: string,
  thinking: string,
): void {
  const cleanAssistant: ChatMessage = { role: "assistant", content: text };
  if (thinking.length > 0) {
    cleanAssistant.thinking = thinking;
    cleanAssistant.reasoning_content = thinking;
  }
  messages.push(cleanAssistant);
}

function buildTurnAssistantMessage(
  text: string,
  thinking: string,
  calls: CoreToolCall[],
  completedToolOutputs: Map<string, string>,
): ChatMessage {
  const assistant: ChatMessage = { role: "assistant", content: text };
  if (thinking.length > 0 && (calls.length > 0 || text.trim() !== "")) {
    assistant.thinking = thinking;
    assistant.reasoning_content = thinking;
  }
  const substitutedCalls = substituteToolBatchPlaceholders(calls, completedToolOutputs);
  for (let i = 0; i < calls.length; i++) {
    calls[i] = substitutedCalls[i]!;
  }
  if (calls.length > 0) {
    assistant.toolCalls = calls.map((call) => ({
      id: call.id,
      name: call.name,
      args: call.args,
    }));
  }
  return assistant;
}

async function* emitCutOffToolCalls(
  calls: CoreToolCall[],
  messages: ChatMessage[],
): AsyncGenerator<CoreLoopEvent, void> {
  for (const call of calls) {
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      name: call.name,
      content: CUT_OFF_NOTE,
    });
    yield {
      type: "tool.end",
      call,
      result: {
        toolCallId: call.id,
        name: call.name,
        content: CUT_OFF_NOTE,
        isError: true,
        errorCode: "REPLY_CUT_OFF",
        durationMs: 0,
      },
    };
  }
}

async function* evaluateNoToolCompletion(
  text: string,
  assistant: ChatMessage,
  messages: ChatMessage[],
  toolsCalled: Set<string>,
  options: CoreLoopOptions,
  stopGateState: { attempts: number; maxRetries: number; nudged: boolean },
  modelCalls: number,
  toolCalls: number,
  finalizeReason: CoreFinalizeReason | undefined,
): AsyncGenerator<
  CoreLoopEvent,
  { action: "continue" } | { action: "finalize"; reason: CoreFinalizeReason } | { action: "return"; result: CoreLoopResult }
> {
  if (text.trim() === "") {
    if (!stopGateState.nudged) {
      stopGateState.nudged = true;
      messages.push({ role: "user", content: EMPTY_REPLY_NUDGE });
      return { action: "continue" };
    }
    return { action: "finalize", reason: "EMPTY_REPLY" };
  }
  if (options.getFollowUpMessages) {
    const followUps = await options.getFollowUpMessages();
    if (Array.isArray(followUps) && followUps.length > 0) {
      messages.push(...followUps);
      return { action: "continue" };
    }
  }
  if (options.beforeFinish && stopGateState.attempts < stopGateState.maxRetries) {
    stopGateState.attempts += 1;
    const gate = await options.beforeFinish({
      text,
      messages,
      toolsCalled,
      attempt: stopGateState.attempts,
    });
    const accepted =
      "ok" in gate && typeof gate.ok === "boolean"
        ? gate.ok
        : Boolean((gate as { accept?: boolean }).accept);
    if (!accepted && "retryPrompt" in gate && gate.retryPrompt) {
      yield {
        type: "warning",
        code: "STOP_GATE_REJECTED",
        message: gate.retryPrompt,
      };
      messages.push({ role: "user", content: gate.retryPrompt });
      return { action: "continue" };
    }
  }
  const finalResolvedText = substituteToolOutputTokens(text, messages);
  assistant.content = finalResolvedText;
  return {
    action: "return",
    result: {
      status: "completed",
      text: finalResolvedText,
      messages,
      modelCalls,
      toolCalls,
      finalizeReason,
      answerSource: "model",
    },
  };
}

async function* consumeFinalPassStream(
  options: CoreLoopOptions,
  hooked: ChatMessage[],
  schemas: CoreToolSchema[],
  finalSignal: AbortSignal,
  finalTimeout: AbortSignal | undefined,
): AsyncGenerator<
  CoreLoopEvent,
  { finalText: string; finalThinking: string; finalError: unknown; finalTimedOut: boolean; cancelled: boolean }
> {
  let finalText = "";
  let finalThinking = "";
  let finalError: unknown;
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
          finalThinking += chunk.content;
          yield { type: "thinking.delta", text: chunk.content };
        } else if (chunk.type === "usage") {
          yield { type: "usage", usage: { ...chunk.usage } };
        }
      }
      finalError = undefined;
      break;
    } catch (error) {
      await closeStream(stream);
      finalError = error;
      if (options.signal.aborted) {
        return { finalText, finalThinking, finalError, finalTimedOut, cancelled: true };
      }
      if (finalTimeout?.aborted) {
        finalTimedOut = true;
        break;
      }
    }
  }
  if (finalTimedOut) {
    yield {
      type: "warning",
      code: "FINAL_PASS_TIMEOUT",
      message: "The final answer pass ran out of time.",
    };
    finalError = undefined;
  }
  return { finalText, finalThinking, finalError, finalTimedOut, cancelled: false };
}

async function* resolveFinalPassOutcome(
  finalText: string,
  finalThinking: string,
  finalError: unknown,
  cutText: string,
  lastAssistantText: string,
  usableToolResults: Array<{ name: string; content: string }>,
  messages: ChatMessage[],
  modelCalls: number,
  toolCalls: number,
  finalizeReason: CoreFinalizeReason | undefined,
): AsyncGenerator<CoreLoopEvent, CoreLoopResult> {
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
      return { status: "completed", text: cutText, messages, modelCalls, toolCalls, finalizeReason, answerSource: "model" };
    }
    yield { type: "text.delta", text: synthetic };
    messages.push({ role: "assistant", content: synthetic });
    return { status: "completed", text: synthetic, messages, modelCalls, toolCalls, finalizeReason, answerSource: "synthetic" };
  }
  if (finalError !== undefined) {
    if (cutText.trim() !== "") {
      return { status: "completed", text: cutText, messages, modelCalls, toolCalls, finalizeReason, answerSource: "model" };
    }
    return {
      status: "failed",
      text: lastAssistantText,
      messages,
      modelCalls,
      toolCalls,
      finalizeReason,
      answerSource: "model",
      error: errorOf(finalError),
    };
  }
  if (finalText.trim() !== "") {
    const resolvedFinalOnly = substituteToolOutputTokens(finalText, messages);
    const resolvedCombined = substituteToolOutputTokens(cutText + finalText, messages);
    const finalAssistant: ChatMessage = { role: "assistant", content: resolvedFinalOnly };
    if (finalThinking.length > 0) {
      finalAssistant.thinking = finalThinking;
      finalAssistant.reasoning_content = finalThinking;
    }
    messages.push(finalAssistant);
    return { status: "completed", text: resolvedCombined, messages, modelCalls, toolCalls, finalizeReason, answerSource: "model" };
  }
  if (cutText.trim() !== "") {
    return { status: "completed", text: cutText, messages, modelCalls, toolCalls, finalizeReason, answerSource: "model" };
  }
  yield { type: "text.delta", text: synthetic };
  messages.push({ role: "assistant", content: synthetic });
  return { status: "completed", text: synthetic, messages, modelCalls, toolCalls, finalizeReason, answerSource: "synthetic" };
}

async function* executeCoreLoopToolBatch(
  calls: CoreToolCall[],
  toolsCalled: Set<string>,
  options: CoreLoopOptions,
  toolMap: Map<string, CoreLoopOptions["tools"][number]>,
  workSignal: AbortSignal,
  defaultToolTimeoutMs: number,
  toolOutputCap: number,
  toolErrorCap: number,
  maxConsecutiveToolErrors: number,
  failureStreak: Map<string, number>,
  callHistory: ReturnType<typeof createToolCallHistory>,
  spillBuffer: SpillBuffer,
  parallelToolMaxConcurrency: number,
  now: () => number,
  messages: ChatMessage[],
  usableToolResults: Array<{ name: string; content: string }>,
  completedToolOutputs: Map<string, string>,
): AsyncGenerator<CoreLoopEvent, void> {
  for (const call of calls) {
    toolsCalled.add(call.name);
    yield { type: "tool.start", call };
  }
  const results = await runToolBatch(calls, {
    tools: toolMap,
    hooks: options.hooks,
    signal: workSignal,
    defaultToolTimeoutMs,
    toolOutputCap,
    toolErrorCap,
    maxConsecutiveToolErrors,
    failureStreak,
    callHistory,
    spillBuffer,
    parallelToolMaxConcurrency,
    now,
    timeoutSignalFor: options.timeoutSignalFor,
  });
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index]!;
    const result = results[index]!;
    messages.push({
      role: "tool",
      tool_call_id: result.toolCallId,
      name: result.name,
      content: result.content,
    });
    if (!result.isError && result.content.trim() !== "") {
      usableToolResults.push({ name: result.name, content: result.content });
      completedToolOutputs.set(result.toolCallId, result.content);
      completedToolOutputs.set(result.name, result.content);
    }
    yield { type: "tool.end", call, result };
  }
  if (options.getSteeringMessages) {
    const steering = await options.getSteeringMessages();
    if (Array.isArray(steering) && steering.length > 0) {
      messages.push(...steering);
    }
  }
}

async function* runFinalAnswerPass(
  options: CoreLoopOptions,
  messages: ChatMessage[],
  schemas: CoreToolSchema[],
  cutText: string,
  lastAssistantText: string,
  usableToolResults: Array<{ name: string; content: string }>,
  modelCalls: number,
  toolCalls: number,
  finalizeReason: CoreFinalizeReason | undefined,
): AsyncGenerator<CoreLoopEvent, CoreLoopResult> {
  yield { type: "finalize", reason: finalizeReason! };
  if (cutText.trim() !== "") {
    messages.push({ role: "assistant", content: cutText });
    messages.push({ role: "user", content: CONTINUE_CUT_INSTRUCTION });
  } else {
    messages.push({ role: "user", content: FINAL_PASS_INSTRUCTION });
  }

  const hooked = yield* runBeforeModelCallHooks(messages, options.hooks, modelCalls);
  yield { type: "model.start", step: modelCalls, finalPass: true };
  const nextModelCalls = modelCalls + 1;

  const finalTimeout =
    options.finalPassTimeoutMs === undefined
      ? undefined
      : (options.finalPassSignalFor ?? ((ms: number) => AbortSignal.timeout(ms)))(options.finalPassTimeoutMs);
  const finalSignal = finalTimeout
    ? AbortSignal.any([options.signal, finalTimeout])
    : options.signal;

  const finalPass = yield* consumeFinalPassStream(options, hooked, schemas, finalSignal, finalTimeout);
  if (finalPass.cancelled) {
    return makeCancelledLoopResult(messages, lastAssistantText, nextModelCalls, toolCalls);
  }

  return yield* resolveFinalPassOutcome(
    finalPass.finalText,
    finalPass.finalThinking,
    finalPass.finalError,
    cutText,
    lastAssistantText,
    usableToolResults,
    messages,
    nextModelCalls,
    toolCalls,
    finalizeReason,
  );
}

function resolveCoreLoopConfig(options: CoreLoopOptions) {
  const defaultToolTimeoutMs = options.defaultToolTimeoutMs ?? 60_000;
  const toolOutputCap = options.toolOutputCap ?? 16_000;
  const toolErrorCap = options.toolErrorCap ?? 2_048;
  const providerRetries = options.providerRetries ?? 2;
  const maxConsecutiveToolErrors = options.maxConsecutiveToolErrors ?? 3;
  const parallelToolMaxConcurrency = options.parallelToolMaxConcurrency ?? 8;
  const now = options.now ?? Date.now;
  const workSignal = options.finalizeSignal
    ? AbortSignal.any([options.signal, options.finalizeSignal])
    : options.signal;
  const finalizeCut = (): boolean =>
    options.finalizeSignal?.aborted === true && !options.signal.aborted;
  const toolMap = new Map(options.tools.map((tool) => [tool.name, tool]));
  const schemas: CoreToolSchema[] = options.tools
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    defaultToolTimeoutMs,
    toolOutputCap,
    toolErrorCap,
    providerRetries,
    maxConsecutiveToolErrors,
    parallelToolMaxConcurrency,
    now,
    workSignal,
    finalizeCut,
    toolMap,
    schemas,
  };
}

/** State carried out of a runaway turn. */
interface RunawayTurnOutcome {
  nudged: boolean;
  lastAssistantText: string;
  cutText: string;
  /** True when the loop nudged the model and should retry the turn. */
  recovered: boolean;
}

/** Inputs for one runaway turn. */
interface RunawayTurnInput {
  text: string;
  thinking: string;
  runawayReason: string | null | undefined;
  messages: ChatMessage[];
  runawayNudged: boolean;
  lastAssistantText: string;
  cutText: string;
}

/**
 * Emit the runaway warning and apply the runaway-recovery policy for one turn:
 * the first trip nudges the model and retries; a second trip finalizes.
 */
async function* _handleRunawayTurn(
  input: RunawayTurnInput,
): AsyncGenerator<CoreLoopEvent, RunawayTurnOutcome> {
  yield {
    type: "warning",
    code: "RUNAWAY_GENERATION",
    message: input.runawayReason ?? "Runaway token repetition detected",
  };
  appendRunawayAssistantMessage(input.messages, input.text, input.thinking);
  let nextLastAssistantText = input.lastAssistantText;
  if (input.text.trim() !== "") nextLastAssistantText = input.text;
  if (!input.runawayNudged) {
    input.messages.push({ role: "user", content: RUNAWAY_RECOVERY_NUDGE });
    return {
      nudged: true,
      lastAssistantText: nextLastAssistantText,
      cutText: input.cutText,
      recovered: true,
    };
  }
  let nextCutText = input.cutText;
  if (input.text.trim() !== "") nextCutText = input.text;
  return {
    nudged: input.runawayNudged,
    lastAssistantText: nextLastAssistantText,
    cutText: nextCutText,
    recovered: false,
  };
}

/** State carried out of a cut-off turn. */
interface CutOffOutcome {
  cutOffs: number;
  finalizeReason: CoreFinalizeReason | undefined;
}

/** Append the cut-off tool results and count it; finalize on the second cut-off. */
async function* _handleCutOffTurn(
  calls: CoreToolCall[],
  messages: ChatMessage[],
  cutOffs: number,
  finalizeReason: CoreFinalizeReason | undefined,
): AsyncGenerator<CoreLoopEvent, CutOffOutcome> {
  yield* emitCutOffToolCalls(calls, messages);
  const nextCutOffs = cutOffs + 1;
  return {
    cutOffs: nextCutOffs,
    finalizeReason: nextCutOffs >= 2 ? "CUT_OFF_TWICE" : finalizeReason,
  };
}

export async function* runCoreLoop(
  options: CoreLoopOptions,
): AsyncGenerator<CoreLoopEvent, CoreLoopResult> {
  const {
    defaultToolTimeoutMs,
    toolOutputCap,
    toolErrorCap,
    providerRetries,
    maxConsecutiveToolErrors,
    parallelToolMaxConcurrency,
    now,
    workSignal,
    finalizeCut,
    toolMap,
    schemas,
  } = resolveCoreLoopConfig(options);

  const messages: ChatMessage[] = [...options.messages];

  const failureStreak = new Map<string, number>();
  const callHistory = createToolCallHistory();
  const spillBuffer = new SpillBuffer(options.spillMaxTotalBytes);
  const completedToolOutputs = new Map<string, string>();
  const toolsCalled = new Set<string>();
  const stopGateState = { attempts: 0, maxRetries: options.maxStopGateRetries ?? 2, nudged: false };

  let modelCalls = 0;
  let toolCalls = 0;
  let runawayNudged = false;
  let cutOffs = 0;
  let finalizeReason: CoreFinalizeReason | undefined;
  let cutText = "";
  let lastAssistantText = "";
  const usableToolResults: Array<{ name: string; content: string }> = [];

  try {
    while (true) {
      if (options.signal.aborted) {
        return makeCancelledLoopResult(messages, lastAssistantText, modelCalls, toolCalls);
      }

      finalizeReason = checkLoopFinalizeCondition(finalizeReason, finalizeCut, options, modelCalls);
      if (finalizeReason !== undefined) break;

      const hooked = yield* runBeforeModelCallHooks(messages, options.hooks, modelCalls);
      const turnOutcome = yield* runModelTurnWithRetries(
        options,
        hooked,
        schemas,
        workSignal,
        finalizeCut,
        providerRetries,
        modelCalls,
      );
      modelCalls += turnOutcome.modelCallsDelta;
      if (turnOutcome.cancelled) {
        return makeCancelledLoopResult(messages, lastAssistantText, modelCalls, toolCalls);
      }
      if (turnOutcome.cutText !== undefined) cutText = turnOutcome.cutText;
      if (turnOutcome.finalizeReason !== undefined) {
        finalizeReason = turnOutcome.finalizeReason;
        continue;
      }

      const { text, thinking, cutOff, runawayTripped, runawayReason, calls } = turnOutcome.turn;

      if (runawayTripped) {
        const runaway = yield* _handleRunawayTurn({
          text,
          thinking,
          runawayReason,
          messages,
          runawayNudged,
          lastAssistantText,
          cutText,
        });
        runawayNudged = runaway.nudged;
        lastAssistantText = runaway.lastAssistantText;
        cutText = runaway.cutText;
        if (runaway.recovered) continue;
        finalizeReason = "RUNAWAY_GENERATION";
        continue;
      }

      const assistant = buildTurnAssistantMessage(text, thinking, calls, completedToolOutputs);
      messages.push(assistant);
      if (text.trim() !== "") lastAssistantText = text;

      if (cutOff && calls.length > 0) {
        const cutOffOutcome = yield* _handleCutOffTurn(
          calls,
          messages,
          cutOffs,
          finalizeReason,
        );
        cutOffs = cutOffOutcome.cutOffs;
        finalizeReason = cutOffOutcome.finalizeReason;
        continue;
      }

      if (calls.length === 0) {
        const noToolOutcome = yield* evaluateNoToolCompletion(
          text,
          assistant,
          messages,
          toolsCalled,
          options,
          stopGateState,
          modelCalls,
          toolCalls,
          finalizeReason,
        );
        if (noToolOutcome.action === "return") return noToolOutcome.result;
        if (noToolOutcome.action === "finalize") finalizeReason = noToolOutcome.reason;
        continue;
      }

      yield* executeCoreLoopToolBatch(
        calls,
        toolsCalled,
        options,
        toolMap,
        workSignal,
        defaultToolTimeoutMs,
        toolOutputCap,
        toolErrorCap,
        maxConsecutiveToolErrors,
        failureStreak,
        callHistory,
        spillBuffer,
        parallelToolMaxConcurrency,
        now,
        messages,
        usableToolResults,
        completedToolOutputs,
      );
      toolCalls += calls.length;
      if (options.signal.aborted) {
        return makeCancelledLoopResult(messages, lastAssistantText, modelCalls, toolCalls);
      }

      if (callHistory.finalizeNow && callHistory.finalizeReason) {
        finalizeReason = callHistory.finalizeReason;
      }
    }

    return yield* runFinalAnswerPass(
      options,
      messages,
      schemas,
      cutText,
      lastAssistantText,
      usableToolResults,
      modelCalls,
      toolCalls,
      finalizeReason,
    );
  } finally {
    spillBuffer.clear();
  }
}
