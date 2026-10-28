import { DEFAULT_TOPOLOGY, DEFAULT_THOUGHT_STRUCTURE } from "@rodrigo-barraza/utilities-library/taxonomy";
import AgenticToolResolver from "./AgenticToolResolver.ts";
import AgenticLoopState from "./AgenticLoopState.ts";
import HarnessRegistry from "./harnesses/HarnessRegistry.ts";
import {
  pendingApprovals,
  pendingQuestions,
  type PendingToolCallSummary,
  type QuestionDefinition,
  type QuestionAnswer,
} from "./ApprovalRegistry.ts";
import ConversationGenerationTracker from "./ConversationGenerationTracker.ts";
import ToolContext from "./ToolContext.ts";
import logger from "../utils/logger.ts";
import { pendingApprovalStore } from "./PendingApprovalStore.ts";
import { validateToolArgs } from "../utils/ToolArgsValidator.ts";
import { PENDING_DECISIONS } from "../constants.ts";
import { HarnessInstrumenter } from "../platform/trace/HarnessInstrumenter.ts";
import { TraceContext } from "../platform/trace/TraceContext.ts";
import { DEFAULT_CONTEXT_BUDGET } from "../platform/context/ContextBudget.ts";
import { SkillRegistry } from "../platform/skills/SkillRegistry.ts";
import { enforceVerificationContract, type VerificationResult } from "../platform/verify/VerificationContract.ts";
import { TAKE_NOTE_TOOL_SCHEMA } from "../platform/memory/NoteStore.ts";
import { ASK_USER_TOOL_SCHEMA } from "./harnesses/lifecycle/AskUserTool.ts";
import { applyModelProfile } from "../platform/models/applyModelProfile.ts";
import { retrieveOffloadedContentTool } from "../platform/offload/retrieveOffloadedContent.ts";
import { getSharedOffloadStore } from "../platform/offload/OffloadStore.ts";

import type { AgenticContext, ConversationMessage, ResolvedTools } from "./harnesses/types.ts";
import RequestLogger from "./RequestLogger.ts";
import { getPricing, TYPES } from "../config.ts";
import { calculateTextCost } from "../utils/CostCalculator.ts";
import { createStandardHooks } from "./harnesses/lifecycle/HookInitializer.ts";
import {
  shouldUseCoreLoopForAgent,
  runCoreLoopForAgent,
  type AgentRouteCoreLoopInput,
  type AgentRouteCoreLoopOutput,
} from "../core/loop/AgentRouteAdapter.ts";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Loop resilience helpers (compaction pressure + overflow recovery)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface CompactionPressureOptions {
  /** Context budget in characters (default: DEFAULT_CONTEXT_BUDGET.totalMaxChars). */
  totalMaxChars?: number;
  /** Fraction of the budget that triggers compaction (default: 0.6). */
  pressureRatio?: number;
  /** Compact regardless of the pressure threshold. */
  force?: boolean;
  /** Most recent tool turns left untouched (default: 3). */
  keepLastNTurns?: number;
  /** Original user request text (from run options) for the plan summary. */
  originalRequest?: string;
  /**
   * Duck-typed AgentHooks instance. When plan-summary compaction fires,
   * a `postCompact` hook event is emitted (fire-and-forget) with
   * `{ turnCount, toolsUsed, openItemCount }`. Accepts any object with a
   * `run(event, payload)` method, so it works before and after the
   * preCompact/postCompact AgentHooks event-type upgrade.
   */
  hooks?: unknown;
}

const COMPACTION_SUMMARY_PREFIX = "[compacted]";
const DEFAULT_PRESSURE_RATIO = 0.6;
const DEFAULT_KEEP_LAST_N_TURNS = 3;

/** Rough character size of the message history. */
function estimateMessagesChars(messages: ConversationMessage[]): number {
  return JSON.stringify(messages).length;
}

/** First 120 chars of a tool result, as a one-line summary. */
function summarizeToolResult(toolName: string, result: unknown): string {
  const text =
    typeof result === "string" ? result : JSON.stringify(result) ?? "";
  const flattened = text.replace(/\s+/g, " ").trim();
  return `${COMPACTION_SUMMARY_PREFIX} ${toolName} result summary: ${flattened.slice(0, 120)}`;
}

/**
 * Replace tool results older than the last N turns with one-line summaries
 * when the assembled context exceeds the pressure threshold.
 *
 * Returns a new array; the input is never mutated.
 */
export function compactToolResultsForPressure(
  messages: ConversationMessage[],
  options: CompactionPressureOptions = {},
): ConversationMessage[] {
  const totalMaxChars = options.totalMaxChars ?? DEFAULT_CONTEXT_BUDGET.totalMaxChars;
  const pressureRatio = options.pressureRatio ?? DEFAULT_PRESSURE_RATIO;
  const keepLastNTurns = options.keepLastNTurns ?? DEFAULT_KEEP_LAST_N_TURNS;
  const threshold = totalMaxChars * pressureRatio;

  if (!options.force && estimateMessagesChars(messages) <= threshold) {
    return messages;
  }

  const toolTurnIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].toolCalls && messages[i].toolCalls!.length > 0) {
      toolTurnIndices.push(i);
    }
  }

  const keepFull = new Set(toolTurnIndices.slice(-keepLastNTurns));
  if (toolTurnIndices.every((index) => keepFull.has(index))) {
    return messages;
  }

  return messages.map((message, index) => {
    if (keepFull.has(index) || !message.toolCalls || message.toolCalls.length === 0) {
      return message;
    }
    return {
      ...message,
      toolCalls: message.toolCalls.map((toolCall) => {
        const prior = toolCall.result;
        const priorSuccess =
          typeof prior === "object" &&
          prior !== null &&
          "success" in prior &&
          typeof prior.success === "boolean"
            ? prior.success
            : true;
        return {
          ...toolCall,
          result: {
            success: priorSuccess ?? true,
            compacted: true,
            message: summarizeToolResult(toolCall.name, prior),
          },
        };
      }),
    };
  });
}

/** Truncate a string to `max` chars on a single line. */
function excerptLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

interface PlanSummaryFacts {
  turnCount: number;
  toolsUsed: string[];
  openItems: string[];
  lastAssistantExcerpt: string | null;
}

/**
 * Mechanically derive run facts from the message list — no LLM call,
 * fully deterministic. Open items are tool calls that were issued but
 * never received a result; when every call is resolved, the latest
 * assistant statement stands in as the current focus.
 */
function derivePlanSummaryFacts(messages: ConversationMessage[]): PlanSummaryFacts {
  const toolsUsed = new Set<string>();
  const openItems: string[] = [];
  let turnCount = 0;
  let lastAssistantExcerpt: string | null = null;

  for (const message of messages) {
    if (message.role === "assistant" && typeof message.content === "string" && message.content.trim()) {
      lastAssistantExcerpt = excerptLine(message.content, 200);
    }
    if (!message.toolCalls || message.toolCalls.length === 0) continue;
    turnCount += 1;
    for (const toolCall of message.toolCalls) {
      toolsUsed.add(toolCall.name);
      if (toolCall.result === undefined) {
        openItems.push(`${toolCall.name}(${excerptLine(JSON.stringify(toolCall.args ?? {}), 80)}) — no result recorded`);
      }
    }
  }

  return { turnCount, toolsUsed: [...toolsUsed].sort(), openItems, lastAssistantExcerpt };
}

/**
 * Build the deterministic plan-summary system message that is prepended
 * when compaction fires: original request (when available), current run
 * state, and open items — all derived from the message list itself.
 */
function buildPlanSummaryMessage(
  messages: ConversationMessage[],
  options: CompactionPressureOptions,
): ConversationMessage {
  const facts = derivePlanSummaryFacts(messages);
  const lines = [
    "[plan summary] Context compaction fired for this run. The summary below is mechanically derived; older tool results above are one-line placeholders.",
    `- Original request: ${options.originalRequest ? excerptLine(options.originalRequest, 400) : "(not provided)"}`,
    `- Run state: ${facts.turnCount} tool turn(s) so far; tools used: ${facts.toolsUsed.length > 0 ? facts.toolsUsed.join(", ") : "(none)"}`,
    `- Open items: ${facts.openItems.length > 0 ? facts.openItems.join("; ") : "none — all issued tool calls have results"}`,
  ];
  if (facts.openItems.length === 0 && facts.lastAssistantExcerpt) {
    lines.push(`- Current focus (latest assistant statement): ${facts.lastAssistantExcerpt}`);
  }
  return { role: "system", content: lines.join("\n") };
}

/** Fire-and-forget `postCompact` hook emission (duck-typed AgentHooks). */
function firePostCompact(hooks: unknown, payload: Record<string, unknown>): void {
  const run = (hooks as { run?: (event: string, p?: unknown) => unknown } | null)?.run;
  if (typeof run !== "function") return;
  try {
    const outcome = run.call(hooks, "postCompact", payload);
    if (outcome && typeof (outcome as Promise<unknown>).catch === "function") {
      (outcome as Promise<unknown>).catch(() => {
        /* hook errors are non-blocking */
      });
    }
  } catch {
    /* hook errors are non-blocking */
  }
}

/**
 * Plan-style compaction (omp pattern): when pressure compaction fires,
 * ALSO prepend one deterministic system message summarizing the run's
 * original request, current state, and open items. Returns the input
 * array unchanged when compaction does not fire.
 */
export function compactWithPlanSummary(
  messages: ConversationMessage[],
  options: CompactionPressureOptions = {},
): ConversationMessage[] {
  const compacted = compactToolResultsForPressure(messages, options);
  if (compacted === messages) return messages;

  const facts = derivePlanSummaryFacts(messages);
  firePostCompact(options.hooks, {
    turnCount: facts.turnCount,
    toolsUsed: facts.toolsUsed,
    openItemCount: facts.openItems.length,
  });
  return [buildPlanSummaryMessage(messages, options), ...compacted];
}

const CONTEXT_WINDOW_ERROR_SIGNATURES =
  /context_length_exceeded|context length|context window|maximum context length|prompt is too long|input length exceeds|too many input tokens|request too large|\b413\b/i;

/**
 * Whether a thrown error represents a context-window overflow (as opposed
 * to a network, auth, or unknown provider failure).
 */
export function isContextWindowError(err: unknown): boolean {
  if (!err) return false;
  const code =
    typeof err === "object" && err !== null
      ? ((err as { code?: unknown }).code as string | undefined)
      : undefined;
  if (typeof code === "string" && CONTEXT_WINDOW_ERROR_SIGNATURES.test(code)) {
    return true;
  }
  const message =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : typeof err === "object" && err !== null
          ? String((err as { message?: unknown }).message ?? "")
          : "";
  return CONTEXT_WINDOW_ERROR_SIGNATURES.test(message);
}

/** Schema for the built-in `skill_read` internal tool. */
export const SKILL_READ_TOOL_SCHEMA = {
  name: "skill_read",
  description:
    "Load the full markdown body of an available skill by name. Use after checking the Available Skills section of the system prompt.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Skill name exactly as listed in Available Skills.",
      },
    },
    required: ["name"],
  },
} as const;

/**
 * AgenticLoopService — public façade for agentic loop execution.
 *
 * Orchestrates:
 *   1. Tool resolution (AgenticToolResolver)
 *   2. State initialization (AgenticLoopState)
 *   3. Harness selection and instantiation (HarnessRegistry)
 *   4. Thought structure resolution (Chain of Thought / Tree of Thoughts / Graph of Thoughts)
 *   5. Cleanup (approvals, questions, session tracking)
 *
 * Also exposes approval/question resolution APIs used by AgentRoutes.
 */
const APPROVAL_KINDS = ["tool", "plan"] as const;

function readOptionalStringProp(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const val = (obj as Record<string, unknown>)[key];
  return typeof val === "string" ? val : undefined;
}

function resolveInstrumenterRoleAndModel(context: AgenticContext) {
  const { options, agent, modelDefinition } = context;
  const optRole = readOptionalStringProp(options, "agentRole") || "assistant";
  const resolvedRole = typeof agent === "string" ? agent : readOptionalStringProp(agent, "name") || optRole;
  const resolvedModelName =
    context.resolvedModel || readOptionalStringProp(modelDefinition, "model") || "default";
  return { resolvedRole, resolvedModelName };
}

function startAgenticRunInstrumenter(
  context: AgenticContext,
  resolvedAgentConversationId: string,
  resolvedParentAgentConversationId: string | null,
) {
  const { options, project, conversationId } = context;
  const optTrace = readOptionalStringProp(options, "traceId");
  const ctxTrace = typeof context.traceId === "string" ? context.traceId : undefined;
  const { resolvedRole, resolvedModelName } = resolveInstrumenterRoleAndModel(context);
  const optParentSpanId = readOptionalStringProp(options, "parentSpanId");

  const instrumenter = HarnessInstrumenter.startRun({
    runId: (context as any).runId,
    traceId: optTrace || ctxTrace,
    conversationId: resolvedAgentConversationId || conversationId || undefined,
    parentRunId: resolvedParentAgentConversationId || null,
    parentSpanId: optParentSpanId || (context as any).parentSpanId || null,
    project: project || "default",
    agentRole: String(resolvedRole),
    environment: process.env.NODE_ENV || "production",
    model: String(resolvedModelName),
  });
  context.traceId = instrumenter.runManifest.trace_id;
  context.runId = instrumenter.runManifest.run_id;
  (context as any).rootSpan = instrumenter.rootSpan;
  return { instrumenter, resolvedModelName, optParentSpanId };
}

function injectInternalAgenticTools(resolvedTools: ResolvedTools, resolvedAgentConversationId: string): void {
  const toolContextStore = ToolContext.getStore(resolvedAgentConversationId);
  try {
    const hasSkills = new SkillRegistry().discover().length > 0;
    const internalTools: Array<{ name: string }> = [];
    if (hasSkills) internalTools.push({ ...SKILL_READ_TOOL_SCHEMA });
    internalTools.push({ ...TAKE_NOTE_TOOL_SCHEMA });
    internalTools.push({ ...ASK_USER_TOOL_SCHEMA });
    internalTools.push({ ...retrieveOffloadedContentTool(getSharedOffloadStore()).definition });
    if (internalTools.length > 0) {
      resolvedTools.finalTools = [...resolvedTools.finalTools, ...(internalTools as any)];
    }
  } catch (skillErr: unknown) {
    logger.debug(
      `[AgenticLoop] Skill discovery failed: ${skillErr instanceof Error ? skillErr.message : String(skillErr)}`,
    );
  }
  if (!toolContextStore.has("dynamicEnabledTools")) {
    const initialNames =
      resolvedTools.resolvedEnabledTools || resolvedTools.finalTools.map((tool) => tool.name);
    ToolContext.set(resolvedAgentConversationId, "dynamicEnabledTools", initialNames);
  }
}

function applyAgenticModelProfile(
  resolvedModelName: unknown,
  options: AgenticContext["options"],
  resolvedTools: ResolvedTools,
): void {
  try {
    const toolNames = resolvedTools.finalTools.map((tool: { name: string }) => tool.name);
    const applied = applyModelProfile(
      String(resolvedModelName),
      options as unknown as Record<string, unknown>,
      { toolNames },
    );
    const sanitized = applied.options as Record<string, unknown> | undefined;
    if (sanitized && sanitized !== (options as unknown)) {
      const keys = [
        "temperature",
        "topP",
        "topK",
        "presencePenalty",
        "frequencyPenalty",
        "reasoningEffort",
        "thinkingLevel",
        "toolChoice",
        "maxTokens",
        "toolNames",
      ];
      for (const key of keys) {
        if (key in sanitized) (options as Record<string, unknown>)[key] = sanitized[key];
      }
    }
    if (applied.clampOutputTo !== undefined) {
      options.maxTokens = Math.min(options.maxTokens ?? applied.clampOutputTo, applied.clampOutputTo);
    }
    if (applied.strippedPrompt) {
      (options as Record<string, unknown>).lightweightPrompt = true;
    }
    if (applied.maxTools !== null && toolNames.length > applied.maxTools) {
      const kept = new Set((sanitized?.toolNames as string[] | undefined) ?? toolNames.slice(0, applied.maxTools));
      resolvedTools.finalTools = resolvedTools.finalTools.filter(
        (tool: { name: string }) => kept.has(tool.name) || kept.has(tool.name.replace(/^(mcp__[a-zA-Z0-9_-]+__)/, "")),
      );
      logger.info(
        `[AgenticLoop] Model profile (${resolvedModelName}): trimmed tool catalog to ${resolvedTools.finalTools.length} (budget ${applied.maxTools})`,
      );
    }
  } catch (profileErr: unknown) {
    logger.debug(
      `[AgenticLoop] Model profile application skipped: ${profileErr instanceof Error ? profileErr.message : String(profileErr)}`,
    );
  }
}

function preloadExplicitToolsIntoState(
  options: AgenticContext["options"],
  resolvedTools: ResolvedTools,
  state: AgenticLoopState,
): void {
  const explicitToolList: string[] | null =
    Array.isArray(options.enabledTools) && options.enabledTools.length > 0
      ? (options.enabledTools as string[])
      : Array.isArray(resolvedTools.resolvedEnabledTools) && resolvedTools.resolvedEnabledTools.length > 0
        ? resolvedTools.resolvedEnabledTools
        : null;
  if (!explicitToolList) return;
  const explicitlyEnabled = new Set(
    explicitToolList.map((name: string) => name.replace(/^(mcp__[a-zA-Z0-9_-]+__)/, "")),
  );
  for (const tool of resolvedTools.finalTools) {
    const cleanName = tool.name.replace(/^(mcp__[a-zA-Z0-9_-]+__)/, "");
    if (explicitlyEnabled.has(cleanName)) {
      state.loadedTools.add(cleanName);
    }
  }
}

function applyAgentSettingsModelsToOptions(
  options: AgenticContext["options"],
  agentSettings: Record<string, any> | null | undefined,
): void {
  if (!agentSettings) return;
  if (options.enableCriticGate === undefined && agentSettings.criticModel) {
    options.enableCriticGate = true;
    options.criticModel = options.criticModel || agentSettings.criticModel;
  }
  if (agentSettings.reminderModel) {
    options.reminderModel = (options.reminderModel as string) || agentSettings.reminderModel;
    options.reminderProvider = (options.reminderProvider as string) || agentSettings.reminderProvider;
  }
}

async function resolveAgenticHarnessSettings(options: AgenticContext["options"]) {
  let harnessId = options.harness;
  let topologyId = options.topology;
  let thoughtStructure = options.thoughtStructure;
  const needsSettingsLookup = Boolean(
    !harnessId || !topologyId || !thoughtStructure || options.enableCriticGate === undefined,
  );
  if (needsSettingsLookup) {
    try {
      const { default: SettingsService } = await import("./SettingsService.js");
      const agentSettings = await SettingsService.getSection("agents");
      harnessId = harnessId || agentSettings?.harness || "standard";
      topologyId = topologyId || agentSettings?.topology || DEFAULT_TOPOLOGY;
      thoughtStructure =
        thoughtStructure || (agentSettings?.thoughtStructure as string) || DEFAULT_THOUGHT_STRUCTURE;
      applyAgentSettingsModelsToOptions(options, agentSettings);
    } catch {
      harnessId = harnessId || "standard";
      topologyId = topologyId || DEFAULT_TOPOLOGY;
      thoughtStructure = thoughtStructure || DEFAULT_THOUGHT_STRUCTURE;
    }
  }
  options.harness = harnessId;
  options.topology = topologyId;
  options.thoughtStructure = thoughtStructure;
  return { harnessId, thoughtStructure };
}

async function executeCoreLoopAdapterPath(
  context: AgenticContext,
  options: AgenticContext["options"],
  state: AgenticLoopState,
  resolvedTools: ResolvedTools,
  harness: unknown,
  resolvedParentAgentConversationId: string | null,
): Promise<{ messages: ConversationMessage[] }> {
  const coreOut = await runCoreLoopForAgent({
    project: context.project,
    username: context.username,
    agent: context.agent,
    conversationId: context.conversationId,
    agentConversationId: context.agentConversationId,
    traceId: context.traceId,
    workspaceRoot: context.workspaceRoot,
    skipMemoryExtraction: (context as any).skipMemoryExtraction,
    skipWorkflowExtraction: (context as any).skipWorkflowExtraction,
    options: options as Record<string, unknown>,
    messages: context.messages as any,
    provider: context.provider as any,
    providerName: context.providerName,
    resolvedModel: String(context.resolvedModel),
    signal: context.signal || new AbortController().signal,
    runtimeTools: resolvedTools as any,
    runtimeToolExecutor: (context as any).runtimeToolExecutor,
    finalizeRequested: context.finalizeRequested as { reason?: string } | null | undefined,
    finalizeSignal: (context as any).finalizeSignal,
    finalPassTimeoutMs: (context as any).finalPassTimeoutMs,
    timeoutSignalFor: (context as any).timeoutSignalFor,
    canonicalBudget: context.canonicalBudget as any,
    emit: context.emit as any,
    sessionState: (context as any).sessionState,
  });
  state.finalStreamedText = coreOut.result.text;
  state.iterations = coreOut.result.modelCalls;
  state.overallUsage = coreOut.usage;
  state.overallGenerationEnd = performance.now();
  state.streamedToolCalls = coreOut.toolCalls.map((tc) => ({
    id: tc.id,
    name: tc.name,
    args: tc.args,
    result: tc.result,
  })) as any;
  const { hooks } = createStandardHooks({
    workspaceRoot: context.workspaceRoot || undefined,
    enableCriticGate: Boolean(options.enableCriticGate),
    criticModel: options.criticModel as string | undefined,
  });
  const preFinalMessages =
    coreOut.messages.length > 0 && coreOut.messages[coreOut.messages.length - 1]?.role === "assistant"
      ? (coreOut.messages.slice(0, -1) as unknown as ConversationMessage[])
      : (coreOut.messages as unknown as ConversationMessage[]);
  const agentRunText = coreOut.result.text;
  RequestLogger.logChatGeneration({
    requestId: `${context.requestId ?? "unknown"}-${coreOut.result.modelCalls}`,
    endpoint: "/agent",
    operation: "agent:iteration",
    project: context.project,
    username: context.username,
    clientIp: context.clientIp ?? null,
    agent: context.agent ?? null,
    harness: "coreloop",
    provider: context.providerName,
    model: String(context.resolvedModel),
    conversationId: context.conversationId ?? null,
    agentConversationId: context.agentConversationId ?? null,
    parentAgentConversationId: resolvedParentAgentConversationId,
    traceId: context.traceId ?? null,
    success: true,
    usage: coreOut.usage,
    estimatedCost: calculateTextCost(
      coreOut.usage,
      getPricing(TYPES.TEXT, TYPES.TEXT)[String(context.resolvedModel)],
    ),
    tokensPerSec: coreOut.usage.tokensPerSec ?? null,
    options: options as Record<string, unknown>,
    messages: preFinalMessages,
    text: agentRunText,
    toolCalls: coreOut.toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      args: tc.args,
      result: tc.result,
    })),
    outputCharacters: agentRunText.length,
    agenticIteration: coreOut.result.modelCalls,
  }).catch((error: unknown) =>
    logger.error(
      `[AgenticLoopService] Failed to log CoreLoop /agent request: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
  await (harness as any).finalize(preFinalMessages, hooks);
  return { messages: preFinalMessages };
}

async function runLoopVerificationContract(
  runResult: { messages: ConversationMessage[] },
  context: AgenticContext,
  options: AgenticContext["options"],
  HarnessClass: NonNullable<ReturnType<typeof HarnessRegistry.get>>,
  resolvedTools: ResolvedTools,
): Promise<{ messages: ConversationMessage[]; verification?: VerificationResult }> {
  try {
    const verificationInput = {
      messages: runResult.messages,
      options: options as Record<string, unknown>,
      warn: (message: string) => logger.warn(message),
      ...(options.requireEvidence === true
        ? {
            runExtraTurn: async (currentMessages: ConversationMessage[]) => {
              const extraContext: AgenticContext = { ...context, messages: currentMessages };
              const extraState = new AgenticLoopState({
                originalMessageCount: currentMessages.length,
                planModeActive: false,
              });
              const continuationHarness = new HarnessClass(extraContext, extraState, resolvedTools);
              const extra = await continuationHarness.run();
              return extra.messages;
            },
          }
        : {}),
    };
    const outcome = await enforceVerificationContract(verificationInput);
    if (outcome.verification.status === "no-evidence") {
      logger.warn(`[AgenticLoop] Verification contract: ${outcome.verification.reason}`);
    }
    return { ...runResult, messages: outcome.messages, verification: outcome.verification };
  } catch (verifyErr: unknown) {
    logger.debug(
      `[AgenticLoop] Verification contract check failed (non-blocking): ${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`,
    );
    return runResult;
  }
}

async function cleanupAgenticRunFinally(
  context: AgenticContext,
  instrumenter: ReturnType<typeof HarnessInstrumenter.startRun>,
  runStatus: "completed" | "failed" | "cancelled" | "setup_error",
  stopReason: string | undefined,
  resolvedAgentConversationId: string,
  conversationId: string,
  resolvedParentAgentConversationId: string | null,
): Promise<void> {
  try {
    if (context.signal?.aborted && runStatus !== "cancelled") {
      runStatus = "cancelled";
      stopReason = "Execution cancelled by client";
    }
    instrumenter.complete(runStatus, stopReason);
  } catch (instErr: unknown) {
    logger.debug(`[HarnessInstrumenter] Run completion export failed: ${instErr}`);
  }
  ToolContext.cleanupInMemory(resolvedAgentConversationId);
  pendingApprovals.delete(conversationId);
  pendingQuestions.delete(conversationId);
  try {
    await pendingApprovalStore.cancelPending(conversationId, "turn_ended");
  } catch (storeError: unknown) {
    logger.warn(`[Approvals] Could not cancel pending approvals for ${conversationId}: ${storeError}`);
  }
  ConversationGenerationTracker.cleanup(resolvedAgentConversationId);
  if (!resolvedParentAgentConversationId) {
    try {
      const { default: OrchestratorService } = await import("./OrchestratorService.js");
      OrchestratorService.cleanupConversation(resolvedAgentConversationId);
    } catch {
      /* OrchestratorService may not be used */
    }
  }
}

async function resolveEmptyPendingApprovalStatus(
  conversationId: string,
  toolCallId?: string,
): Promise<{ status: "already_decided" } | { status: "not_found" }> {
  if (toolCallId) {
    const settled = await pendingApprovalStore.findByItem(conversationId, toolCallId);
    if (settled) return { status: "already_decided" };
  }
  return (await pendingApprovalStore.hasSettled(conversationId, APPROVAL_KINDS))
    ? { status: "already_decided" }
    : { status: "not_found" };
}

async function validateTargetApprovalSelection(
  conversationId: string,
  input: {
    isApproved: boolean;
    toolCallId?: string;
    batchWide?: boolean;
    editedArgs?: Record<string, unknown>;
  },
  pending: Awaited<ReturnType<typeof pendingApprovalStore.listPending>>,
  type: "tool" | "plan",
): Promise<
  | {
      ok: false;
      outcome:
        | { status: "already_decided" }
        | { status: "not_found" }
        | { status: "ambiguous"; pendingToolCallIds: string[] }
        | { status: "invalid"; error: string };
    }
  | {
      ok: true;
      pendingIds: string[];
      target: (typeof pending)[number] | undefined;
    }
> {
  const pendingIds = pending.map((record) => record.itemId);
  if (input.toolCallId) {
    const settled = await pendingApprovalStore.findByItem(conversationId, input.toolCallId);
    if (settled && settled.status !== "pending") return { ok: false, outcome: { status: "already_decided" } };
    if (!pendingIds.includes(input.toolCallId)) return { ok: false, outcome: { status: "not_found" } };
  } else if (!input.batchWide && pending.length > 1) {
    return { ok: false, outcome: { status: "ambiguous", pendingToolCallIds: pendingIds } };
  }
  const target = input.toolCallId
    ? pending.find((record) => record.itemId === input.toolCallId)
    : pending.length === 1
      ? pending[0]
      : undefined;

  if (input.editedArgs !== undefined) {
    if (!input.isApproved) {
      return { ok: false, outcome: { status: "invalid", error: "editedArgs can only accompany an allow" } };
    }
    if (type === "plan") {
      return { ok: false, outcome: { status: "invalid", error: "a plan's arguments cannot be edited" } };
    }
    if (!target) return { ok: false, outcome: { status: "invalid", error: "editedArgs needs a toolCallId" } };
    const validation = validateToolArgs(target.argsSchema, input.editedArgs);
    if (validation.ok === false) {
      return { ok: false, outcome: { status: "invalid", error: `editedArgs rejected: ${validation.error}` } };
    }
  }
  return { ok: true, pendingIds, target };
}

export default class AgenticLoopService {
  /** Run an agentic loop using the specified (or default) harness. */
  static async runAgenticLoop(
    context: AgenticContext,
  ): Promise<{ messages: ConversationMessage[]; verification?: VerificationResult }> {
    const {
      options,
      agent,
      project,
      username,
      modelDefinition,
      messages,
      agentConversationId,
      conversationId,
      parentAgentConversationId,
    } = context;

    const resolvedAgentConversationId = agentConversationId || "";
    const resolvedParentAgentConversationId = parentAgentConversationId || null;

    const { instrumenter, resolvedModelName, optParentSpanId } = startAgenticRunInstrumenter(
      context,
      resolvedAgentConversationId,
      resolvedParentAgentConversationId,
    );

    await ToolContext.ensureLoaded(resolvedAgentConversationId);

    const resolvedTools = (context.runtimeTools ||
      (await AgenticToolResolver.resolve({
        options,
        agent: agent || undefined,
        project,
        username,
        modelDefinition: modelDefinition || undefined,
        agentConversationId: resolvedAgentConversationId,
        providerName: context.providerName,
        resolvedModel: context.resolvedModel,
      }))) as ResolvedTools;

    injectInternalAgenticTools(resolvedTools, resolvedAgentConversationId);
    applyAgenticModelProfile(resolvedModelName, options, resolvedTools);

    if (!options.isSubAgent && !context.isNewConversation && messages.length > 0) {
      for (let i = 0; i < messages.length - 1; i++) {
        (messages[i] as any)._alreadyPersisted = true;
      }
    }

    const state = new AgenticLoopState({
      originalMessageCount: messages.length,
      planModeActive: !!options.planFirst,
    });
    preloadExplicitToolsIntoState(options, resolvedTools, state);

    const { harnessId, thoughtStructure } = await resolveAgenticHarnessSettings(options);
    const HarnessClass = HarnessRegistry.get(harnessId)!;
    logger.info(
      `[AgenticLoop] Using harness: "${HarnessClass.id}" (${HarnessClass.label}), thoughtStructure: "${thoughtStructure}"`,
    );

    const harness = new HarnessClass(context, state, resolvedTools);
    let runStatus: "completed" | "failed" | "cancelled" | "setup_error" = "completed";
    let stopReason: string | undefined;
    try {
      const runResult = await TraceContext.run(
        {
          trace_id: instrumenter.runManifest.trace_id,
          run_id: instrumenter.runManifest.run_id,
          currentSpan: instrumenter.rootSpan,
          current_span_id: instrumenter.rootSpan.span_id,
          parentSpanId: optParentSpanId || (context as any).parentSpanId || null,
          conversation_id: resolvedAgentConversationId || conversationId || undefined,
        },
        async () => {
          if (
            shouldUseCoreLoopForAgent(process.env, {
              harness: harnessId,
              thoughtStructure,
              planFirst: options.planFirst,
              isTrading: context.project === "vllm-trading-bot",
              unattended: (options as Record<string, unknown>).unattended === true,
            })
          ) {
            return executeCoreLoopAdapterPath(
              context,
              options,
              state,
              resolvedTools,
              harness,
              resolvedParentAgentConversationId,
            );
          }
          return await harness.run();
        },
      );

      return await runLoopVerificationContract(runResult, context, options, HarnessClass, resolvedTools);
    } catch (err: unknown) {
      if (context.signal?.aborted) {
        runStatus = "cancelled";
        stopReason = "Execution cancelled by client";
      } else {
        runStatus = "failed";
        stopReason = err instanceof Error ? err.message : String(err);
      }
      throw err;
    } finally {
      await cleanupAgenticRunFinally(
        context,
        instrumenter,
        runStatus,
        stopReason,
        resolvedAgentConversationId,
        conversationId,
        resolvedParentAgentConversationId,
      );
    }
  }

  // ── Approval Resolution API ─────────────────────────────
  // Keyed by conversationId — the client-facing conversation identifier.
  // Only one agentic run is active per conversation at a time, so there
  // is no collision risk.

  /** Resolve a pending approval for a conversation. */
  static resolveApproval(
    conversationId: string,
    isApproved: boolean,
    {
      shouldApproveAll = false,
      reason,
      denialReason,
      editedArgs,
    }: {
      shouldApproveAll?: boolean;
      reason?: string;
      denialReason?: string;
      editedArgs?: Record<string, Record<string, unknown>>;
    } = {},
  ): boolean {
    const entry = pendingApprovals.get(conversationId);
    if (!entry) return false;

    if (entry.type === "plan") {
      entry.resolve(isApproved);
    } else {
      entry.resolve({
        isApproved,
        shouldApproveAll,
        reason: reason ?? (isApproved ? "user_approved" : "user_rejected"),
        ...(denialReason ? { denialReason } : {}),
        ...(editedArgs ? { editedArgs } : {}),
      });
    }
    return true;
  }

  /**
   * Decide the pending approval with the checks the HTTP route needs.
   * Tool approvals are durable (PendingApprovalStore): the decision is a
   * conditional write on the stored record, so it works after a restart
   * (`delivered: false` — no live turn took it) and a second decision on the
   * same call is `already_decided`. `invalid` is a bad `editedArgs`.
   * ported from prism-service AgenticLoopService.decideApproval /
   * ApprovalRegistry.decide, narrowed to this service's single pending batch
   * per conversation.
   */
  static async decideApproval(
    conversationId: string,
    input: {
      isApproved: boolean;
      toolCallId?: string;
      batchWide?: boolean;
      reason?: string;
      editedArgs?: Record<string, unknown>;
    },
  ): Promise<
    | { status: "decided"; type: "tool" | "plan"; decidedToolCallIds: string[]; delivered: boolean }
    | { status: "not_found" }
    | { status: "already_decided" }
    | { status: "invalid"; error: string }
    | { status: "ambiguous"; pendingToolCallIds: string[] }
  > {
    const entry = pendingApprovals.get(conversationId);
    const pending = await pendingApprovalStore.listPending(conversationId, APPROVAL_KINDS);

    if (pending.length === 0) {
      return resolveEmptyPendingApprovalStatus(conversationId, input.toolCallId);
    }
    const type = pending[0].kind === "plan" ? "plan" : "tool";

    const selection = await validateTargetApprovalSelection(conversationId, input, pending, type);
    if (!selection.ok) {
      return (selection as { ok: false; outcome: any }).outcome;
    }
    const { pendingIds, target } = selection;

    const reason = input.isApproved
      ? undefined
      : input.reason?.trim().slice(0, PENDING_DECISIONS.MAX_REASON_CHARS) || undefined;
    const scope = input.batchWide ? "batch" : "call";
    const delivered = entry?.type === type;
    const ordered = target ? [target, ...pending.filter((record) => record !== target)] : pending;
    for (const [index, record] of ordered.entries()) {
      const isTarget = record === target;
      const settled = await pendingApprovalStore.settle(record.id, {
        status: "decided",
        delivered,
        decision: {
          decision: input.isApproved ? "allow" : "deny",
          scope,
          source: "user",
          ...(reason ? { reason } : {}),
          ...(isTarget && input.editedArgs !== undefined ? { editedArgs: input.editedArgs } : {}),
        },
      });
      if (!settled && index === 0) return { status: "already_decided" };
    }

    if (delivered) {
      AgenticLoopService.resolveApproval(conversationId, input.isApproved, {
        shouldApproveAll: input.batchWide === true && input.isApproved,
        reason: input.reason,
        ...(reason ? { denialReason: reason } : {}),
        ...(target && input.editedArgs !== undefined
          ? { editedArgs: { [target.itemId]: input.editedArgs } }
          : {}),
      });
    }
    return {
      status: "decided",
      type,
      decidedToolCallIds: target ? [target.itemId] : pendingIds,
      delivered,
    };
  }

  /** Check if a conversation has a pending approval. */
  static getPendingApproval(conversationId: string): {
    isPending: boolean;
    type?: string;
    tools?: string[];
    toolCalls?: PendingToolCallSummary[];
  } {
    const entry = pendingApprovals.get(conversationId);
    if (!entry) return { isPending: false };
    return {
      isPending: true,
      type: entry.type,
      tools: entry.tools,
      toolCalls: entry.toolCalls,
    };
  }

  // ── Ask User Question — Resolution API ─────────────────

  /** Store a pending question resolver (called by ToolOrchestratorService). */
  static _setPendingQuestion(
    conversationId: string,
    entry: {
      resolve: (value: {
        answers: QuestionAnswer[] | null;
        isTimedOut?: boolean;
      }) => void;
      question?: string;
      questions?: QuestionDefinition[];
      choices?: string[];
    },
  ): void {
    pendingQuestions.set(conversationId, entry);
  }

  /**
   * Resolve a pending question for a conversation. Questions are durable
   * (PendingApprovalStore): the answer is a conditional write on the stored
   * record, so an answer to a card whose turn died (a restart) is stored and
   * reported `delivered: false`, and a second answer to the same card is
   * `already_answered`. With `questionId` only that card is answered: a
   * different id is `unknown_question`. ported from prism-service
   * AgenticLoopService.resolveUserQuestion / QuestionRegistry.
   */
  static async resolveUserQuestion(
    conversationId: string,
    answers: QuestionAnswer[],
    { questionId }: { questionId?: string } = {},
  ): Promise<
    | { resolved: true; questionId: string | undefined; delivered: boolean; reason?: undefined }
    | {
        resolved: false;
        reason: "no_pending_question" | "unknown_question" | "already_answered";
        questionId?: string;
      }
  > {
    const entry = pendingQuestions.get(conversationId);
    const pending = await pendingApprovalStore.listPending(conversationId, ["question"]);
    const target = questionId
      ? pending.find((record) => record.itemId === questionId)
      : pending[pending.length - 1];
    if (!target) {
      if (questionId) {
        const settled = await pendingApprovalStore.findByItem(conversationId, questionId);
        if (settled?.kind === "question") {
          return { resolved: false, reason: "already_answered", questionId };
        }
      }
      return {
        resolved: false,
        reason: questionId ? "unknown_question" : "no_pending_question",
        ...(questionId ? { questionId } : {}),
      };
    }
    if (questionId && entry?.questionId && entry.questionId !== questionId) {
      return { resolved: false, reason: "unknown_question", questionId };
    }
    const delivered = entry !== undefined && entry.questionId === target.itemId;
    const won = await pendingApprovalStore.settle(target.id, { status: "decided", answers, delivered });
    if (!won) return { resolved: false, reason: "already_answered", questionId: target.itemId };
    if (delivered) {
      pendingQuestions.delete(conversationId);
      entry.resolve({ answers });
    }
    return { resolved: true, questionId: target.itemId, delivered };
  }

  /** Check if a conversation has a pending question. */
  static getPendingQuestion(conversationId: string): {
    isPending: boolean;
    question?: string;
    questions?: QuestionDefinition[];
    choices?: string[];
  } {
    const entry = pendingQuestions.get(conversationId);
    if (!entry) return { isPending: false };
    return {
      isPending: true,
      question: entry.question,
      questions: entry.questions,
      choices: entry.choices,
    };
  }

  // ── Harness Discovery API ──────────────────────────────

  /** List available harnesses for the settings UI. */
  static listHarnesses(): Array<{
    id: string;
    label: string;
    description: string;
  }> {
    return HarnessRegistry.list() as Array<{
      id: string;
      label: string;
      description: string;
    }>;
  }

  /**
   * Returns true when `POST /agent` should route onto `CoreLoop` (Option B),
   * or false when `LAS_AGENT_LOOP=legacy` rollback switch is active.
   */
  static shouldUseCoreLoop(env?: NodeJS.ProcessEnv): boolean {
    return shouldUseCoreLoopForAgent(env);
  }

  /**
   * Execute an agent turn through `CoreLoop` via `AgentRouteAdapter` (Option B).
   */
  static async runViaCoreLoop(input: AgentRouteCoreLoopInput): Promise<AgentRouteCoreLoopOutput> {
    return runCoreLoopForAgent(input);
  }
}

