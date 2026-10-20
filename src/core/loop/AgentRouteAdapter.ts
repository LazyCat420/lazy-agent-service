/**
 * AgentRouteAdapter (Option B): bridges `POST /agent` onto `CoreLoop` (`runCoreLoop`)
 * with an instant `LAS_AGENT_LOOP=legacy` rollback switch.
 *
 * Unifies `/v1/runs` and `/agent` onto the same hardened `CoreLoop` engine
 * (`H1–H10`), enforces the `vllm-trading-bot` learning boundary (`B4`), and
 * disables thinking on final synthesis turns (`B25`).
 */
import type { ChatMessage } from "../../types/ProviderTypes.ts";
import type { ChatMessage as AdminChatMessage } from "../../types/admin.ts";
import type { StreamChunk } from "../../types/provider.ts";
import type { ConversationMessage } from "../../services/harnesses/types.ts";
import type { TokenUsage } from "../../types/admin.ts";
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
import ToolOrchestratorService from "../../services/ToolOrchestratorService.ts";
import { getPricing, TYPES } from "../../config.ts";
import {
  mergeUsage,
  createUsageAccumulator,
  calculateTextCost,
  withTotalInputTokens,
} from "../../utils/CostCalculator.ts";
import {
  SERVER_SENT_EVENT_TYPES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { runCoreLoop } from "./CoreLoop.ts";
import {
  compactMessages,
  DEFAULT_COMPACT_TOKEN_BUDGET,
} from "./MessageCompactor.ts";
import {
  formatToolLoadoutDelta,
  shouldSkipTradingLearning,
  stripHistoricalReasoning,
} from "./RunsAdapter.ts";
import type {
  CoreFinalizeReason,
  CoreLoopEvent,
  CoreLoopHooks,
  CoreLoopResult,
  CoreModel,
  CoreModelRequest,
  CoreTool,
  CoreToolContext,
  StopGateDecision,
} from "./types.ts";

export interface AgentRouteAdapterContext {
  project?: string | null;
  username?: string | null;
  agent?: string | null;
  conversationId?: string | null;
  agentConversationId?: string | null;
  traceId?: string | null;
  workspaceRoot?: string | null;
  skipMemoryExtraction?: boolean;
  skipWorkflowExtraction?: boolean;
  options: {
    maxIterations?: number;
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: string;
    systemPrompt?: string;
    compactionBudgetTokens?: number;
    harness?: string;
    thoughtStructure?: string;
    planFirst?: boolean;
    [key: string]: unknown;
  };
  messages: ChatMessage[];
  provider: {
    generateTextStream?(
      messages: ChatMessage[],
      model: string,
      options: Record<string, unknown>,
    ): AsyncIterable<StreamChunk>;
    generateText?(
      messages: ChatMessage[],
      model: string,
      options: Record<string, unknown>,
    ): Promise<{
      text?: string;
      thinking?: string;
      toolCalls?: Array<{
        id?: string;
        name: string;
        args?: Record<string, unknown>;
      }>;
      usage?: Record<string, number>;
    }>;
  };
  providerName?: string;
  resolvedModel: string;
  signal: AbortSignal;
  runtimeTools: {
    finalTools: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>;
  };
  runtimeToolExecutor?(
    call: { id: string; name: string; args: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<unknown>;
  finalizeRequested?: { reason?: string } | null;
  finalizeSignal?: AbortSignal;
  finalPassTimeoutMs?: number;
  timeoutSignalFor?: (toolName: string, ms: number) => AbortSignal;
  canonicalBudget?: { allowFinalPass(): void };
  emit(event: { type: string; [key: string]: unknown }): void;
  sessionState?: SessionState;
  hooks?: CoreLoopHooks;
  getSteeringMessages?: () => Promise<ChatMessage[]> | ChatMessage[];
  getFollowUpMessages?: () => Promise<ChatMessage[]> | ChatMessage[];
  beforeFinish?: (ctx: {
    text: string;
    messages: readonly ChatMessage[];
    toolsCalled: ReadonlySet<string>;
    attempt: number;
  }) => Promise<StopGateDecision> | StopGateDecision;
  maxStopGateRetries?: number;
  /** Optional post-response hook (e.g. MemoryExtractor / WorkflowMemoryService); skipped when B4 applies. */
  afterResponseHook?: (payload: {
    text: string;
    messages: ChatMessage[];
    toolCalls: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
      result: string;
    }>;
  }) => Promise<void> | void;
}

/**
 * Rollback switch for `POST /agent`:
 * - Returns `false` when `LAS_AGENT_LOOP=legacy`
 * - Returns `true` when `LAS_AGENT_LOOP=coreloop`
 * - When `options.isTrading` is provided, defaults to `true` for trading (`vllm-trading-bot`)
 *   and `false` for non-trading unless `LAS_AGENT_LOOP=coreloop`
 * - Defaults to `true` for standard single-agent ReAct turns when `options` is omitted
 */
export function shouldUseCoreLoopForAgent(
  env: Record<string, string | undefined> = process.env,
  options?: {
    harness?: string;
    thoughtStructure?: string;
    planFirst?: boolean;
    isTrading?: boolean;
    unattended?: boolean;
  },
): boolean {
  const mode = (env.LAS_AGENT_LOOP || "").trim().toLowerCase();
  if (mode === "legacy") return false;
  if (mode === "coreloop") return true;

  if (options?.planFirst === true) return false;
  if (
    options?.thoughtStructure === "tree_of_thoughts" ||
    options?.thoughtStructure === "graph_of_thoughts"
  ) {
    return false;
  }
  if (options?.harness && options.harness !== "standard") {
    return false;
  }
  if (options && options.isTrading !== undefined) {
    return options.isTrading === true;
  }
  return true;
}

const resolveMaxSteps = (maxIterations: number | undefined): number =>
  maxIterations ? Math.min(100, Math.max(1, maxIterations)) : 25;

const shouldFinalizeOf =
  (context: AgentRouteAdapterContext): (() => CoreFinalizeReason | null) =>
  () =>
    context.finalizeRequested
      ? context.finalizeRequested.reason === "DEADLINE_SOFT"
        ? "DEADLINE_SOFT"
        : "TOKEN_BUDGET"
      : null;

/**
 * Ensures the initial `role: "user"` message (whose SHA-256 digest is pinned by
 * `TradingLearningBoundary`) is never followed by another non-system `role: "user"`
 * message that `normalizeRoleAlternation` would `.join("\n\n")` into it.
 */
export function protectInitialUserBriefFromMerge(
  messages: ConversationMessage[],
): ConversationMessage[] {
  const firstUserIdx = messages.findIndex((m) => m.role === "user");
  if (firstUserIdx === -1) return messages;

  let nextNonSystemIdx = -1;
  for (let i = firstUserIdx + 1; i < messages.length; i++) {
    if (messages[i]?.role !== "system") {
      nextNonSystemIdx = i;
      break;
    }
  }

  if (nextNonSystemIdx !== -1 && messages[nextNonSystemIdx]?.role === "user") {
    return [
      ...messages.slice(0, firstUserIdx + 1),
      { role: "assistant", content: "(continuing)" } as ConversationMessage,
      ...messages.slice(firstUserIdx + 1),
    ];
  }
  return messages;
}

const coreModelForAgent = (context: AgentRouteAdapterContext): CoreModel => {
  const baseOptions: Record<string, unknown> = {
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
    ...(typeof context.options.thinkingEnabled === "boolean"
      ? { thinkingEnabled: context.options.thinkingEnabled }
      : {}),
    ...(typeof context.options.topP === "number"
      ? { topP: context.options.topP }
      : {}),
    ...(typeof context.options.topK === "number"
      ? { topK: context.options.topK }
      : {}),
    ...(typeof context.options.minP === "number"
      ? { minP: context.options.minP }
      : {}),
    ...(typeof context.options.repeatPenalty === "number"
      ? { repeatPenalty: context.options.repeatPenalty }
      : {}),
    ...(Array.isArray(context.options.stopSequences)
      ? { stopSequences: context.options.stopSequences }
      : {}),
    ...(typeof context.options.seed === "number"
      ? { seed: context.options.seed }
      : {}),
    ...(typeof context.options.presencePenalty === "number"
      ? { presencePenalty: context.options.presencePenalty }
      : {}),
    ...(typeof context.options.frequencyPenalty === "number"
      ? { frequencyPenalty: context.options.frequencyPenalty }
      : {}),
  };

  return (request: CoreModelRequest): AsyncIterable<StreamChunk> =>
    (async function* () {
      if (request.finalPass) context.canonicalBudget?.allowFinalPass();
      let maxTokens = context.options.maxTokens;
      for (let attempt = 0; ; attempt++) {
        const internalMessages: ConversationMessage[] =
          request.messages as unknown as ConversationMessage[];
        const guardedMessages =
          protectInitialUserBriefFromMerge(internalMessages);
        const normalized = normalizeRoleAlternation(guardedMessages);
        const expandedMessages = expandMessagesForFunctionCall(
          normalized.messages as unknown as AdminChatMessage[],
          {
            filterDeleted: false,
          },
        );
        const expanded: ChatMessage[] =
          expandedMessages as unknown as ChatMessage[];

        if (context.sessionState) {
          if (expanded[expanded.length - 1]?.role === "user") {
            expanded.push({
              role: "assistant",
              content: "(continuing)",
            });
          }
          expanded.push({
            role: "user",
            content: sessionStateContextBlock(context.sessionState),
          });
        }

        const providerCallOptions: Record<string, unknown> = {
          ...baseOptions,
          maxTokens,
          tools: request.tools,
          toolChoice: request.toolChoice,
          ...(request.finalPass ? { thinkingEnabled: false } : {}),
          signal: request.signal,
        };

        let yielded = false;
        try {
          if (typeof context.provider.generateTextStream === "function") {
            const stream = context.provider.generateTextStream(
              expanded,
              context.resolvedModel,
              providerCallOptions,
            );
            for await (const chunk of stream) {
              yielded = true;
              yield chunk;
            }
            return;
          }

          if (typeof context.provider.generateText === "function") {
            const response = await context.provider.generateText(
              expanded,
              context.resolvedModel,
              providerCallOptions,
            );
            if (response.thinking) {
              yielded = true;
              yield { type: "thinking", content: response.thinking };
            }
            if (response.text) {
              yielded = true;
              yield response.text;
            }
            if (Array.isArray(response.toolCalls)) {
              for (const tc of response.toolCalls) {
                yielded = true;
                yield {
                  type: "toolCall",
                  id: tc.id ?? null,
                  name: tc.name,
                  args: tc.args ?? {},
                };
              }
            }
            if (response.usage) {
              yield {
                type: "usage",
                usage: {
                  inputTokens: response.usage.inputTokens ?? 0,
                  outputTokens: response.usage.outputTokens ?? 0,
                },
              };
            }
            return;
          }

          throw new Error("Provider supports neither generateTextStream nor generateText");
        } catch (error) {
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

const toCoreToolsForAgent = (
  context: AgentRouteAdapterContext,
): CoreTool[] =>
  context.runtimeTools.finalTools.map((schema) => ({
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
    execute: async (
      args: Record<string, unknown>,
      toolContext: CoreToolContext,
    ) => {
      if (typeof context.runtimeToolExecutor === "function") {
        return context.runtimeToolExecutor(
          { id: toolContext.toolCallId, name: schema.name, args },
          toolContext.signal,
        );
      }
      return ToolOrchestratorService.executeTool(schema.name, args, {
        project: context.project || "default",
        username: context.username || "anonymous",
        agent: context.agent || null,
        agentConversationId: context.agentConversationId || "",
        conversationId: context.conversationId || undefined,
        traceId: context.traceId || null,
        signal: toolContext.signal,
        workspaceRoot: context.workspaceRoot || undefined,
      });
    },
  }));

export type AgentRouteCoreLoopInput = AgentRouteAdapterContext;
export interface AgentRouteCoreLoopOutput {
  messages: ChatMessage[];
  result: CoreLoopResult;
  learningSkipped: boolean;
  toolCalls: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result: string;
  }>;
  /** Cumulative token usage across all model calls (L1). */
  usage: Required<Omit<TokenUsage, "totalTokens">> & { requests: number };
}

export async function runCoreLoopForAgent(
  context: AgentRouteAdapterContext,
): Promise<AgentRouteCoreLoopOutput> {
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
    let prepared = stripHistoricalReasoning(msgs, activeTurnStartIndex);
    prepared = compactMessages(prepared, { budgetTokens });
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

  const executedToolCalls: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result: string;
  }> = [];

  // Cumulative token usage across all model calls in this run (L1).
  const usageAccumulator = createUsageAccumulator();
  let modelCalls = 0;

  const forwardAgentEvent = (event: CoreLoopEvent): void => {
    if (event.type === "model.start") {
      modelCalls += 1;
    } else if (event.type === "text.delta") {
      context.emit({ type: "chunk", content: event.text });
    } else if (event.type === "usage") {
      mergeUsage(usageAccumulator, event.usage);
      const usage = { ...usageAccumulator, requests: modelCalls };
      const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[
        context.resolvedModel
      ];
      const estimatedCost = calculateTextCost(usage, pricing);
      context.emit({
        type: SERVER_SENT_EVENT_TYPES.USAGE_UPDATE,
        usage: withTotalInputTokens(usage),
        estimatedCost,
      });
    } else if (event.type === "thinking.delta") {
      context.emit({ type: "thinking", content: event.text });
    } else if (event.type === "tool.start") {
      context.emit({
        type: "tool_execution",
        tool: {
          id: event.call.id,
          name: event.call.name,
          args: event.call.args,
        },
        status: "calling",
      });
    } else if (event.type === "tool.end") {
      executedToolCalls.push({
        id: event.call.id,
        name: event.call.name,
        args: event.call.args,
        result: event.result.content,
      });
      context.emit({
        type: "tool_execution",
        tool: {
          id: event.call.id,
          name: event.call.name,
          args: event.call.args,
          result: event.result.content,
          durationMs: event.result.durationMs,
        },
        status: event.result.isError ? "error" : "done",
      });
    } else if (event.type === "warning") {
      context.emit({
        type: "status",
        code: event.code,
        message: event.message,
      });
    } else if (event.type === "finalize") {
      context.emit({
        type: "status",
        code: "FINALIZE",
        reason: event.reason,
        message: "Answering with the information gathered so far.",
      });
    }
  };

  const generator = runCoreLoop({
    model: coreModelForAgent(context),
    tools: toCoreToolsForAgent(context),
    messages: context.messages,
    signal: context.signal,
    finalizeSignal: context.finalizeSignal,
    finalPassTimeoutMs: context.finalPassTimeoutMs,
    timeoutSignalFor: context.timeoutSignalFor,
    hooks: mergedHooks,
    getSteeringMessages: context.getSteeringMessages,
    getFollowUpMessages: context.getFollowUpMessages,
    beforeFinish: context.beforeFinish,
    maxStopGateRetries: context.maxStopGateRetries,
    maxSteps: resolveMaxSteps(context.options.maxIterations),
    shouldFinalize: shouldFinalizeOf(context),
  });

  for (;;) {
    const next = await generator.next();
    if (next.done === true) {
      const result: CoreLoopResult = next.value;
      if (result.status === "completed") {
        const learningSkipped = shouldSkipTradingLearning(context);
        if (!learningSkipped && typeof context.afterResponseHook === "function") {
          await context.afterResponseHook({
            text: result.text,
            messages: result.messages,
            toolCalls: executedToolCalls,
          });
        }
        return {
          messages: result.messages,
          result,
          learningSkipped,
          toolCalls: executedToolCalls,
          usage: { ...usageAccumulator, requests: modelCalls },
        };
      }
      if (result.status === "cancelled") {
        context.signal.throwIfAborted();
        throw Object.assign(new Error("Agent run cancelled"), {
          code: "RUN_CANCELLED",
        });
      }
      throw Object.assign(
        new Error(result.error?.message ?? "Agent run failed"),
        {
          code: result.error?.code ?? "PROVIDER_ERROR",
        },
      );
    }
    forwardAgentEvent(next.value);
  }
}

/**
 * Dispatcher helper for `POST /agent` that routes to `coreLoopRunner` by default
 * and falls back to `legacyRunner` when `LAS_AGENT_LOOP=legacy` (or when specialized
 * non-standard harness modes are requested).
 */
export async function dispatchAgentRouteWithRollback<T>(
  options: {
    env?: Record<string, string | undefined>;
    agentOptions?: {
      harness?: string;
      thoughtStructure?: string;
      planFirst?: boolean;
    };
    runCoreLoopPath: () => Promise<T>;
    runLegacyPath: () => Promise<T>;
  },
): Promise<{ pathUsed: "coreloop" | "legacy"; value: T }> {
  if (shouldUseCoreLoopForAgent(options.env ?? process.env, options.agentOptions)) {
    const value = await options.runCoreLoopPath();
    return { pathUsed: "coreloop", value };
  }
  const value = await options.runLegacyPath();
  return { pathUsed: "legacy", value };
}
