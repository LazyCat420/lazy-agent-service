/**
 * RunsAdapter: bridges `/v1/runs` (RunExecutionEngine) onto the CoreLoop.
 * The engine's `context` object is translated into `CoreLoopOptions`; the
 * CoreModel adapter replays the BaseAgenticHarness provider-call recipe
 * (role normalization → function-call expansion → session-state block →
 * streaming call with one context-overflow retry).
 */
import type { ChatMessage } from "../../types/ProviderTypes.ts";
import type { ChatMessage as AdminChatMessage } from "../../types/admin.ts";
import type { StreamChunk } from "../../types/provider.ts";
import type { ConversationMessage } from "../../services/harnesses/types.ts";
import { normalizeRoleAlternation } from "../../services/RoleAlternation.ts";
import { expandMessagesForFunctionCall } from "../../utils/FunctionCallingUtilities.ts";
import { sessionStateContextBlock, type SessionState } from "../../services/SessionState.ts";
import {
  parseContextOverflowError,
  reducedMaxTokensForOverflow,
} from "../../utils/ProviderStreamResilience.ts";
import {
  OUTPUT_TOKEN_CLAMP_FIXED_HEADROOM_TOKENS,
  MINIMUM_CLAMPED_OUTPUT_TOKENS,
} from "../../constants/TokenBudgetDefaults.ts";
import { runCoreLoop } from "./CoreLoop.ts";
import type {
  CoreFinalizeReason,
  CoreLoopEvent,
  CoreLoopResult,
  CoreModel,
  CoreModelRequest,
  CoreTool,
  CoreToolContext,
} from "./types.ts";

/** The engine's run context, narrowed to the fields the adapter uses. */
export interface RunsAdapterContext {
  options: {
    maxIterations?: number;
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: string;
  };
  messages: ChatMessage[];
  provider: {
    generateTextStream(
      messages: ChatMessage[],
      model: string,
      options: Record<string, unknown>,
    ): AsyncIterable<StreamChunk>;
  };
  resolvedModel: string;
  signal: AbortSignal;
  runtimeTools: { finalTools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> };
  runtimeToolExecutor(call: { id: string; name: string; args: Record<string, unknown> }, signal?: AbortSignal): Promise<unknown>;
  finalizeRequested?: { reason: string };
  finalizeSignal?: AbortSignal;
  /** Final-pass time limit (ms); see CoreLoopOptions.finalPassTimeoutMs. */
  finalPassTimeoutMs?: number;
  /** Test seam: builds each tool's timeout signal (forwarded to CoreLoop's timeoutSignalFor). */
  timeoutSignalFor?: (toolName: string, ms: number) => AbortSignal;
  /** Run token budget; the final pass must be allowed to spend its reserve. */
  canonicalBudget?: { allowFinalPass(): void };
  emit(event: { type: string; content?: string; data?: unknown }): void;
  sessionState?: SessionState;
}

/** Same clamp ReActHarness applies to `options.maxIterations`; default 25 (MAX_TOOL_ITERATIONS). */
const resolveMaxSteps = (maxIterations: number | undefined): number =>
  maxIterations ? Math.min(100, Math.max(1, maxIterations)) : 25;

const shouldFinalizeOf = (context: RunsAdapterContext): (() => CoreFinalizeReason | null) => () =>
  context.finalizeRequested
    ? context.finalizeRequested.reason === "DEADLINE_SOFT"
      ? "DEADLINE_SOFT"
      : "TOKEN_BUDGET"
    : null;

/** The CoreModel adapter: one provider stream per CoreModelRequest. */
const coreModelFor = (context: RunsAdapterContext): CoreModel => {
  const baseOptions = {
    ...(typeof context.options.temperature === "number"
      ? { temperature: context.options.temperature }
      : {}),
    ...(typeof context.options.reasoningEffort === "string"
      ? { reasoningEffort: context.options.reasoningEffort }
      : {}),
  };

  return (request: CoreModelRequest): AsyncIterable<StreamChunk> =>
    (async function* () {
      if (request.finalPass) context.canonicalBudget?.allowFinalPass();
      let maxTokens = context.options.maxTokens;
      for (let attempt = 0; ; attempt++) {
        // Role alternation first (internal format), then function-call expansion —
        // the same order BaseAgenticHarness.createProviderStream uses.
        // The two casts bridge legacy harness message types to the provider ChatMessage;
        // the shapes are structurally identical for the fields the providers read.
        const internalMessages: ConversationMessage[] = request.messages as unknown as ConversationMessage[];
        const normalized = normalizeRoleAlternation(internalMessages);
        const expandedMessages = expandMessagesForFunctionCall(normalized.messages as unknown as AdminChatMessage[], {
          filterDeleted: false,
        });
        const expanded: ChatMessage[] = expandedMessages as unknown as ChatMessage[];

        // Ambient session state: ephemeral trailing block, never persisted.
        if (context.sessionState) {
          expanded.push({
            role: "user",
            content: sessionStateContextBlock(context.sessionState),
          });
        }

        let stream: AsyncIterable<StreamChunk>;
        let yielded = false;
        try {
          stream = context.provider.generateTextStream(expanded, context.resolvedModel, {
            ...baseOptions,
            maxTokens,
            tools: request.tools,
            toolChoice: request.toolChoice,
            ...(request.finalPass ? { thinkingEnabled: false } : {}),
            signal: request.signal,
          });
          for await (const chunk of stream) {
            yielded = true;
            yield chunk;
          }
          return;
        } catch (error) {
          // Context overflow before any output: shrink the output budget and retry once.
          if (attempt === 0 && !yielded) {
            const overflow = parseContextOverflowError(error);
            const reduced = overflow
              ? reducedMaxTokensForOverflow(
                  maxTokens,
                  overflow,
                  MINIMUM_CLAMPED_OUTPUT_TOKENS,
                  OUTPUT_TOKEN_CLAMP_FIXED_HEADROOM_TOKENS,
                )
              : null;
            if (reduced !== null) {
              maxTokens = reduced;
              continue;
            }
          }
          throw error;
        }
      }
    })();
};

/** CoreLoopEvent → engine emit (the engine maps these to RunEventType). */
const forwardEvent = (context: RunsAdapterContext, event: CoreLoopEvent): void => {
  if (event.type === "text.delta") {
    context.emit({ type: "chunk", content: event.text });
  } else if (event.type === "warning") {
    context.emit({ type: "run.warning", data: { code: event.code, message: event.message } });
  } else if (event.type === "finalize") {
    context.emit({
      type: "run.warning",
      data: { code: "FINALIZE", reason: event.reason, message: "Answering with the information gathered so far." },
    });
  }
  // thinking.delta, usage, model.start, tool.start, tool.end: not emitted —
  // usage is already counted by accounting.wrap(provider) and tool.* events
  // are emitted by the runtime tool executor itself.
};

const toCoreTools = (context: RunsAdapterContext): CoreTool[] =>
  context.runtimeTools.finalTools.map((schema) => ({
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
    execute: async (args: Record<string, unknown>, toolContext: CoreToolContext) =>
      // ToolRunner stringifies and caps the observation; return it raw.
      context.runtimeToolExecutor({ id: toolContext.toolCallId, name: schema.name, args }, toolContext.signal),
  }));

export async function runCoreLoopForRun(
  context: RunsAdapterContext,
): Promise<{ messages: ChatMessage[]; result: CoreLoopResult }> {
  const generator = runCoreLoop({
    model: coreModelFor(context),
    tools: toCoreTools(context),
    messages: context.messages,
    signal: context.signal,
    finalizeSignal: context.finalizeSignal,
    finalPassTimeoutMs: context.finalPassTimeoutMs,
    timeoutSignalFor: context.timeoutSignalFor,
    // B8 compaction: blocked — manageContextPressure requires a full AgenticContext
    // (AgentHooks, modelDefinition, AgenticLoopState, emit) plus a harness label;
    // the adapter has only messages and cannot build a harness.
    maxSteps: resolveMaxSteps(context.options.maxIterations),
    shouldFinalize: shouldFinalizeOf(context),
  });

  for (;;) {
    const next = await generator.next();
    if (next.done === true) {
      const result: CoreLoopResult = next.value;
      if (result.status === "completed") return { messages: result.messages, result };
      if (result.status === "cancelled") {
        context.signal.throwIfAborted();
        throw Object.assign(new Error("Run cancelled"), { code: "RUN_CANCELLED" });
      }
      throw Object.assign(new Error(result.error?.message ?? "Run failed"), {
        code: result.error?.code ?? "PROVIDER_ERROR",
      });
    }
    forwardEvent(context, next.value);
  }
}
