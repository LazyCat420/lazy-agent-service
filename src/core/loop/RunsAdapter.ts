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
import {
  sessionStateContextBlock,
  type SessionState,
} from "../../services/SessionState.ts";
import {
  parseContextOverflowError,
  reducedMaxTokensForOverflow,
} from "../../utils/ProviderStreamResilience.ts";
import {
  OUTPUT_TOKEN_CLAMP_FIXED_HEADROOM_TOKENS,
  MINIMUM_CLAMPED_OUTPUT_TOKENS,
} from "../../constants/TokenBudgetDefaults.ts";
import { runCoreLoop } from "./CoreLoop.ts";
import {
  compactMessages,
  DEFAULT_COMPACT_TOKEN_BUDGET,
} from "./MessageCompactor.ts";
import type {
  CoreFinalizeReason,
  CoreLoopEvent,
  CoreLoopHooks,
  CoreLoopResult,
  CoreModel,
  CoreModelRequest,
  CoreTool,
  CoreToolContext,
} from "./types.ts";

/** The engine's run context, narrowed to the fields the adapter uses. */
export interface RunsAdapterContext {
  project?: string | null;
  skipMemoryExtraction?: boolean;
  skipWorkflowExtraction?: boolean;
  options: {
    maxIterations?: number;
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: string;
    systemPrompt?: string;
    compactionBudgetTokens?: number;
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
  runtimeTools: {
    finalTools: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>;
  };
  runtimeToolExecutor(
    call: { id: string; name: string; args: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<unknown>;
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
  hooks?: CoreLoopHooks;
  getSteeringMessages?: () => Promise<ChatMessage[]> | ChatMessage[];
  getFollowUpMessages?: () => Promise<ChatMessage[]> | ChatMessage[];
}

/**
 * B4: Returns true when memory and workflow learning extraction must be skipped
 * (always skipped for `vllm-trading-bot` or when explicit skip flags are set).
 */
export function shouldSkipTradingLearning(context: {
  project?: string | null;
  skipMemoryExtraction?: boolean;
  skipWorkflowExtraction?: boolean;
}): boolean {
  return (
    context.project === "vllm-trading-bot" ||
    context.skipMemoryExtraction === true ||
    context.skipWorkflowExtraction === true
  );
}

/**
 * H1: Strip `thinking` and `reasoning_content` from historical assistant turns
 * prior to the active user turn while preserving `thinking` and `reasoning_content`
 * on all assistant messages within the active turn (e.g. interleaved tool-call steps).
 */
export function stripHistoricalReasoning(
  messages: ChatMessage[],
  activeTurnStartIndex?: number,
): ChatMessage[] {
  let cutoffIndex = activeTurnStartIndex;
  if (cutoffIndex === undefined) {
    cutoffIndex = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        cutoffIndex = i;
        break;
      }
    }
  }

  return messages.map((msg, idx) => {
    if (
      idx < cutoffIndex! &&
      msg.role === "assistant" &&
      (msg.thinking !== undefined || msg.reasoning_content !== undefined)
    ) {
      const { thinking: _thinking, reasoning_content: _reasoning, ...rest } = msg;
      return rest;
    }
    return msg;
  });
}

/**
 * H8: Format a `<system-reminder>` describing mid-run tool loadout changes
 * without re-sorting or mutating the prefix tool schema cache.
 */
export function formatToolLoadoutDelta(
  previousNames: ReadonlySet<string> | string[],
  currentTools: ReadonlyArray<{ name: string; description?: string }>,
): string | null {
  const prevSet =
    previousNames instanceof Set ? previousNames : new Set(previousNames);
  const currentSorted = [...currentTools].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const currentSet = new Set(currentSorted.map((t) => t.name));

  const added = currentSorted.filter((t) => !prevSet.has(t.name));
  const removed = [...prevSet].filter((name) => !currentSet.has(name)).sort();

  if (added.length === 0 && removed.length === 0) {
    return null;
  }

  const lines: string[] = ["<system-reminder>", "Tool loadout updated:"];
  for (const tool of added) {
    const desc = tool.description ? ` — ${tool.description}` : "";
    lines.push(`+ ${tool.name}${desc}`);
  }
  for (const name of removed) {
    lines.push(`- ${name}`);
  }
  lines.push("</system-reminder>");
  return lines.join("\n");
}

/** Same clamp ReActHarness applies to `options.maxIterations`; default 25 (MAX_TOOL_ITERATIONS). */
const resolveMaxSteps = (maxIterations: number | undefined): number =>
  maxIterations ? Math.min(100, Math.max(1, maxIterations)) : 25;

const shouldFinalizeOf =
  (context: RunsAdapterContext): (() => CoreFinalizeReason | null) =>
  () =>
    context.finalizeRequested
      ? context.finalizeRequested.reason === "DEADLINE_SOFT"
        ? "DEADLINE_SOFT"
        : "TOKEN_BUDGET"
      : null;

/** The CoreModel adapter: one provider stream per CoreModelRequest. */
const coreModelFor = (context: RunsAdapterContext): CoreModel => {
  const baseOptions = {
    ...(typeof context.options.systemPrompt === "string" &&
    context.options.systemPrompt
      ? { systemPrompt: context.options.systemPrompt }
      : {}),
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
        const internalMessages: ConversationMessage[] =
          request.messages as unknown as ConversationMessage[];
        const normalized = normalizeRoleAlternation(internalMessages);
        const expandedMessages = expandMessagesForFunctionCall(
          normalized.messages as unknown as AdminChatMessage[],
          {
            filterDeleted: false,
          },
        );
        const expanded: ChatMessage[] =
          expandedMessages as unknown as ChatMessage[];

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
          stream = context.provider.generateTextStream(
            expanded,
            context.resolvedModel,
            {
              ...baseOptions,
              maxTokens,
              tools: request.tools,
              toolChoice: request.toolChoice,
              ...(request.finalPass ? { thinkingEnabled: false } : {}),
              signal: request.signal,
            },
          );
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
const forwardEvent = (
  context: RunsAdapterContext,
  event: CoreLoopEvent,
): void => {
  if (event.type === "text.delta") {
    context.emit({ type: "chunk", content: event.text });
  } else if (event.type === "warning") {
    context.emit({
      type: "run.warning",
      data: { code: event.code, message: event.message },
    });
  } else if (event.type === "finalize") {
    context.emit({
      type: "run.warning",
      data: {
        code: "FINALIZE",
        reason: event.reason,
        message: "Answering with the information gathered so far.",
      },
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
    execute: async (
      args: Record<string, unknown>,
      toolContext: CoreToolContext,
    ) =>
      // ToolRunner stringifies and caps the observation; return it raw.
      context.runtimeToolExecutor(
        { id: toolContext.toolCallId, name: schema.name, args },
        toolContext.signal,
      ),
  }));

export async function runCoreLoopForRun(
  context: RunsAdapterContext,
): Promise<{ messages: ChatMessage[]; result: CoreLoopResult }> {
  // Determine the active turn's starting user message index so historical reasoning
  // before this run is stripped while active tool-turn reasoning is preserved (H1).
  let activeTurnStartIndex = 0;
  for (let i = context.messages.length - 1; i >= 0; i--) {
    if (context.messages[i]?.role === "user") {
      activeTurnStartIndex = i;
      break;
    }
  }

  let seenToolNames = new Set(
    context.runtimeTools.finalTools.map((t) => t.name),
  );
  const budgetTokens =
    context.options.compactionBudgetTokens ?? DEFAULT_COMPACT_TOKEN_BUDGET;

  const builtInBeforeModelCall = (
    msgs: ChatMessage[],
    step: number,
  ): ChatMessage[] => {
    // H1: Strip historical reasoning before activeTurnStartIndex; keep active tool-turn reasoning.
    let prepared = stripHistoricalReasoning(msgs, activeTurnStartIndex);
    // H6 / B8: Tool-pair-atomic compaction when estimated tokens exceed budgetTokens.
    prepared = compactMessages(prepared, { budgetTokens });
    // H8: Emit a <system-reminder> if tools were dynamically unlocked mid-run.
    if (step > 0) {
      const deltaReminder = formatToolLoadoutDelta(
        seenToolNames,
        context.runtimeTools.finalTools,
      );
      if (deltaReminder !== null) {
        seenToolNames = new Set(
          context.runtimeTools.finalTools.map((t) => t.name),
        );
        prepared = [...prepared, { role: "user", content: deltaReminder }];
      }
    }
    return prepared;
  };

  const mergedHooks: CoreLoopHooks = {
    beforeModelCall: [
      builtInBeforeModelCall,
      ...(context.hooks?.beforeModelCall ?? []),
    ],
    beforeToolCall: context.hooks?.beforeToolCall,
    afterToolCall: context.hooks?.afterToolCall,
  };

  const generator = runCoreLoop({
    model: coreModelFor(context),
    tools: toCoreTools(context),
    messages: context.messages,
    signal: context.signal,
    finalizeSignal: context.finalizeSignal,
    finalPassTimeoutMs: context.finalPassTimeoutMs,
    timeoutSignalFor: context.timeoutSignalFor,
    hooks: mergedHooks,
    getSteeringMessages: context.getSteeringMessages,
    getFollowUpMessages: context.getFollowUpMessages,
    maxSteps: resolveMaxSteps(context.options.maxIterations),
    shouldFinalize: shouldFinalizeOf(context),
  });

  for (;;) {
    const next = await generator.next();
    if (next.done === true) {
      const result: CoreLoopResult = next.value;
      if (result.status === "completed")
        return { messages: result.messages, result };
      if (result.status === "cancelled") {
        context.signal.throwIfAborted();
        throw Object.assign(new Error("Run cancelled"), {
          code: "RUN_CANCELLED",
        });
      }
      throw Object.assign(new Error(result.error?.message ?? "Run failed"), {
        code: result.error?.code ?? "PROVIDER_ERROR",
      });
    }
    forwardEvent(context, next.value);
  }
}
