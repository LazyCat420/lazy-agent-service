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
import { HarnessInstrumenter } from "../platform/trace/HarnessInstrumenter.ts";
import { TraceContext } from "../platform/trace/TraceContext.ts";
import { DEFAULT_CONTEXT_BUDGET } from "../platform/context/ContextBudget.ts";
import { SkillRegistry } from "../platform/skills/SkillRegistry.ts";
import { enforceVerificationContract, type VerificationResult } from "../platform/verify/VerificationContract.ts";
import { TAKE_NOTE_TOOL_SCHEMA } from "../platform/memory/NoteStore.ts";
import { applyModelProfile } from "../platform/models/applyModelProfile.ts";
import { retrieveOffloadedContentTool } from "../platform/offload/retrieveOffloadedContent.ts";
import { OffloadStore } from "../platform/offload/OffloadStore.ts";
import { GoalStore, type Goal } from "../platform/goals/GoalStore.ts";
import { evaluateGoal } from "../platform/goals/GoalGate.ts";
import type { VerifierResult } from "../platform/verify/DeterministicVerifiers.ts";
import { TurnMailbox, formatTurnNotice } from "../platform/questions/TurnMailbox.ts";
import { NonBlockingQuestionRegistry } from "../platform/questions/NonBlockingQuestion.ts";

import type { AgenticContext, ConversationMessage } from "./harnesses/types.ts";

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

// ── Turn input mailbox + non-blocking questions (prism harness_next) ──
// Process-wide: mid-turn inputs and question answers land here and are
// surfaced to the model at the next drain boundary instead of blocking.
const sharedTurnMailbox = new TurnMailbox();
const sharedQuestionRegistry = new NonBlockingQuestionRegistry(sharedTurnMailbox);

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
export default class AgenticLoopService {
  /** Shared turn-input mailbox (mid-turn inputs, question answers). */
  static get turnMailbox(): TurnMailbox {
    return sharedTurnMailbox;
  }

  /** Shared non-blocking question registry (ask_user without blocking). */
  static get questionRegistry(): NonBlockingQuestionRegistry {
    return sharedQuestionRegistry;
  }

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

    const optTrace = typeof (options as any)?.traceId === "string" ? String((options as any).traceId) : undefined;
    const ctxTrace = typeof context.traceId === "string" ? context.traceId : undefined;
    const optRole = typeof (options as any)?.agentRole === "string" ? String((options as any).agentRole) : "assistant";
    const resolvedRole = typeof agent === "string" ? agent : (agent as any)?.name || optRole;
    const resolvedModelName = context.resolvedModel || (modelDefinition && (modelDefinition as any).model) || "default";

    const optParentSpanId = typeof (options as any)?.parentSpanId === "string" ? String((options as any).parentSpanId) : undefined;
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

    // Open this run's mailbox slot so mid-turn inputs and question answers
    // have somewhere to land (prism harness_next); closed in the finally.
    sharedTurnMailbox.open(instrumenter.runManifest.run_id);
    (context as any).turnMailbox = sharedTurnMailbox;
    (context as any).questionRegistry = sharedQuestionRegistry;

    // Load any persisted tool state from MongoDB (e.g. after server restart or previous turn)
    await ToolContext.ensureLoaded(resolvedAgentConversationId);

    // 1. Resolve tools (passing agentConversationId so dynamicEnabledTools is merged)
    const resolvedTools = context.runtimeTools || await AgenticToolResolver.resolve({
      options,
      agent: agent || undefined,
      project,
      username,
      modelDefinition: modelDefinition || undefined,
      agentConversationId: resolvedAgentConversationId,
      providerName: context.providerName,
      resolvedModel: context.resolvedModel,
    });

    // If dynamicEnabledTools is not in ToolContext, populate it with the resolved tools
    const toolContextStore = ToolContext.getStore(resolvedAgentConversationId);

    // ── Inject internal tools (skill_read, take_note) ──────────
    // skill_read: bodies load from <repoRoot>/skills/<name>/SKILL.md on
    //   demand (handled in harnesses/lifecycle/ToolExecutor.ts).
    // take_note: persists per-run notes to <repoRoot>/data/notes/<runId>.md
    //   (handled in harnesses/lifecycle/ToolExecutor.ts).
    try {
      const hasSkills = new SkillRegistry().discover().length > 0;
      const internalTools: Array<{ name: string }> = [];
      if (hasSkills) internalTools.push({ ...SKILL_READ_TOOL_SCHEMA });
      internalTools.push({ ...TAKE_NOTE_TOOL_SCHEMA });
      internalTools.push({ ...retrieveOffloadedContentTool(new OffloadStore()).definition });
      if (internalTools.length > 0) {
        resolvedTools.finalTools = [...resolvedTools.finalTools, ...internalTools];
      }
    } catch (skillErr: unknown) {
      logger.debug(`[AgenticLoop] Skill discovery failed: ${skillErr instanceof Error ? skillErr.message : String(skillErr)}`);
    }

    if (!toolContextStore.has("dynamicEnabledTools")) {
      const initialNames =
        resolvedTools.resolvedEnabledTools ||
        resolvedTools.finalTools.map((tool) => tool.name);
      ToolContext.set(resolvedAgentConversationId, "dynamicEnabledTools", initialNames);
    }

    // ── Model profile: per-model sampling/tool budgets + lightweight preset ──
    // Local <=14B models get a 12-tool budget (discovery tools count inside),
    // no sub-agent tools, a stripped system prompt, and an output clamp —
    // prism's ModelProfiles port. Sanitized sampling parameters are written
    // back onto options; the clamped tool list is applied to finalTools.
    try {
      const toolNames = resolvedTools.finalTools.map((tool: { name: string }) => tool.name);
      const applied = applyModelProfile(
        String(resolvedModelName),
        options as unknown as Record<string, unknown>,
        { toolNames },
      );
      const sanitized = applied.options as Record<string, unknown> | undefined;
      if (sanitized && sanitized !== (options as unknown)) {
        for (const key of ["temperature", "topP", "topK", "presencePenalty", "frequencyPenalty", "reasoningEffort", "thinkingLevel", "toolChoice", "maxTokens", "toolNames"]) {
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
      logger.debug(`[AgenticLoop] Model profile application skipped: ${profileErr instanceof Error ? profileErr.message : String(profileErr)}`);
    }

    // If this is a top-level agent request with an existing conversation,
    // all messages except the last one (the triggering input) are already
    // persisted in the database. For new conversations (e.g. Discord channel
    // history passed as ephemeral context), nothing has been persisted yet.
    if (!options.isSubAgent && !context.isNewConversation && messages.length > 0) {
      for (let i = 0; i < messages.length - 1; i++) {
        (messages[i] as any)._alreadyPersisted = true;
      }
    }

    // 2. Initialize shared state
    const state = new AgenticLoopState({
      originalMessageCount: messages.length,
      planModeActive: !!options.planFirst,
    });

    // When the request carries an explicit tool set, pre-load it so the tools
    // are sent to the provider natively from iteration 1 — the describe_tools
    // lazy-loading dance is for catalog browsing, not for small explicit sets
    // the caller already committed to. "Explicit" means either enabledTools on
    // the request (e.g. HTML-Notes' mcp__lazy-tool-service__* widget tools) or
    // a persona's non-wildcard availableTools (resolvedEnabledTools) — a
    // tailor-made client persona is exactly as committed as a request list,
    // and without this a persona-only caller regresses into the discovery
    // dance that small local models never complete.
    const explicitToolList: string[] | null =
      Array.isArray(options.enabledTools) && options.enabledTools.length > 0
        ? (options.enabledTools as string[])
        : Array.isArray(resolvedTools.resolvedEnabledTools) &&
            resolvedTools.resolvedEnabledTools.length > 0
          ? resolvedTools.resolvedEnabledTools
          : null;
    if (explicitToolList) {
      const explicitlyEnabled = new Set(
        explicitToolList.map((name: string) =>
          name.replace(/^(mcp__[a-zA-Z0-9_-]+__)/, ""),
        ),
      );
      for (const tool of resolvedTools.finalTools) {
        const cleanName = tool.name.replace(/^(mcp__[a-zA-Z0-9_-]+__)/, "");
        if (explicitlyEnabled.has(cleanName)) {
          state.loadedTools.add(cleanName);
        }
      }
    }

    // 3. Select harness, topology, and thought structure
    let harnessId = options.harness;
    let topologyId = options.topology;
    let thoughtStructure = options.thoughtStructure;
    if (!harnessId || !topologyId || !thoughtStructure || options.enableCriticGate === undefined) {
      try {
        const { default: SettingsService } =
          await import("./SettingsService.js");
        const agentSettings = await SettingsService.getSection("agents");
        if (!harnessId) harnessId = agentSettings?.harness || "standard";
        if (!topologyId)
          topologyId = agentSettings?.topology || DEFAULT_TOPOLOGY;
        if (!thoughtStructure)
          thoughtStructure = (agentSettings?.thoughtStructure as string) || DEFAULT_THOUGHT_STRUCTURE;

        // CriticGate: auto-enable from settings when a critic model is configured
        // and the request didn't explicitly set enableCriticGate.
        if (
          options.enableCriticGate === undefined &&
          agentSettings?.criticModel
        ) {
          options.enableCriticGate = true;
          options.criticModel =
            options.criticModel || agentSettings.criticModel;
        }

        // SystemReminderInjector: auto-populate from settings when a reminder model is configured
        if (agentSettings?.reminderModel) {
          options.reminderModel =
            (options.reminderModel as string) || agentSettings.reminderModel;
          options.reminderProvider =
            (options.reminderProvider as string) || agentSettings.reminderProvider;
        }
      } catch {
        if (!harnessId) harnessId = "standard";
        if (!topologyId) topologyId = DEFAULT_TOPOLOGY;
        if (!thoughtStructure) thoughtStructure = DEFAULT_THOUGHT_STRUCTURE;
      }
    }

    options.harness = harnessId;
    options.topology = topologyId;
    options.thoughtStructure = thoughtStructure;
    const HarnessClass = HarnessRegistry.get(harnessId)!;
    logger.info(
      `[AgenticLoop] Using harness: "${HarnessClass.id}" (${HarnessClass.label}), thoughtStructure: "${thoughtStructure}"`,
    );

    // 4. Instantiate and run
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
          return await harness.run();
        },
      );

      // ── Verification contract (omp pattern) at the loop exit point ──
      // Soft mode: warn + attach verification status. Strict mode
      // (options.requireEvidence): grant ONE evidence-demand turn.
      try {
        const verificationInput = {
          messages: runResult.messages,
          options: options as Record<string, unknown>,
          warn: (message: string) => logger.warn(message),
          ...(options.requireEvidence === true
            ? {
                runExtraTurn: async (currentMessages: ConversationMessage[]) => {
                  const extraContext: AgenticContext = {
                    ...context,
                    messages: currentMessages,
                  };
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
          logger.warn(
            `[AgenticLoop] Verification contract: ${outcome.verification.reason}`,
          );
        }

        // ── Conversation goal gate (prism goals, adapted) ──
        // Evaluate active goals for this conversation against the run's
        // verifier outcome; achieved/budget_exhausted update the store,
        // off_track appends a corrective directive for the next turn.
        try {
          const goalConversationId = resolvedAgentConversationId || conversationId;
          if (goalConversationId) {
            const goalStore = new GoalStore();
            const activeGoals: Goal[] = (await goalStore.listByConversation(goalConversationId))
              .filter((goal) => goal.status === "active");
            for (const goal of activeGoals) {
              const verifierResults: VerifierResult[] = [
                {
                  passed: outcome.verification.status === "verified",
                  verifier_name: "verification_contract",
                  reason:
                    outcome.verification.status === "verified"
                      ? undefined
                      : ("reason" in outcome.verification ? outcome.verification.reason : undefined),
                  evidence_refs: outcome.verification.evidence.map((ref) =>
                    typeof ref === "string" ? ref : JSON.stringify(ref),
                  ),
                },
              ];
              const gate = evaluateGoal(goal, { verifierResults, toolEvents: [] });
              await goalStore.addBudgetSpend(goal.goal_id, 1);
              if (gate.verdict === "achieved") {
                await goalStore.achieve(goal.goal_id);
                logger.info(`[AgenticLoop] Goal ${goal.goal_id} achieved`);
              } else if (gate.verdict === "budget_exhausted") {
                await goalStore.updateStatus(goal.goal_id, "paused");
                logger.warn(`[AgenticLoop] Goal ${goal.goal_id} budget exhausted — paused`);
              }
              if (gate.directive) {
                outcome.messages = [
                  ...outcome.messages,
                  {
                    role: "system",
                    content: `<goal-directive goal_id="${goal.goal_id}" verdict="${gate.verdict}">\n${gate.directive}\n</goal-directive>`,
                  } as ConversationMessage,
                ];
              }
            }
          }
        } catch (goalErr: unknown) {
          logger.debug(`[AgenticLoop] Goal gate skipped: ${goalErr instanceof Error ? goalErr.message : String(goalErr)}`);
        }

        return { ...runResult, messages: outcome.messages, verification: outcome.verification };
      } catch (verifyErr: unknown) {
        logger.debug(
          `[AgenticLoop] Verification contract check failed (non-blocking): ${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`,
        );
        return runResult;
      }
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
      try {
        if (context.signal?.aborted && runStatus !== "cancelled") {
          runStatus = "cancelled";
          stopReason = "Execution cancelled by client";
        }
        instrumenter.complete(runStatus, stopReason);
      } catch (instErr: unknown) {
        logger.debug(`[HarnessInstrumenter] Run completion export failed: ${instErr}`);
      }
      // Clean up in-memory cache keyed by agentConversationId (keeps MongoDB state for next turn)
      ToolContext.cleanupInMemory(resolvedAgentConversationId);

      // Clean up in-memory state keyed by conversationId (client-facing)
      pendingApprovals.delete(conversationId);
      pendingQuestions.delete(conversationId);

      // Close this run's mailbox slot; late inputs get no_active_run and the
      // caller queues them as next-turn input instead of a lost write.
      try {
        sharedTurnMailbox.close(instrumenter.runManifest.run_id);
      } catch {
        /* mailbox slot already gone */
      }

      // Always clean up per-session tracker entries to prevent memory leaks —
      // sub-agent sessions have their own agentConversationId that must be released.
      ConversationGenerationTracker.cleanup(resolvedAgentConversationId);

      // Only clean up orchestrator state for root sessions — sub-agents are
      // cleaned by the parent session's OrchestratorService.cleanupConversation().
      if (!resolvedParentAgentConversationId) {
        try {
          const { default: OrchestratorService } =
            await import("./OrchestratorService.js");
          OrchestratorService.cleanupConversation(resolvedAgentConversationId);
        } catch {
          /* OrchestratorService may not be used */
        }
      }
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
    { shouldApproveAll = false }: { shouldApproveAll?: boolean } = {},
  ): boolean {
    const entry = pendingApprovals.get(conversationId);
    if (!entry) return false;

    if (entry.type === "plan") {
      entry.resolve(isApproved);
    } else {
      entry.resolve({
        isApproved,
        shouldApproveAll,
        reason: isApproved ? "user_approved" : "user_rejected",
      });
    }
    return true;
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

  /** Resolve a pending question for a conversation. */
  static resolveUserQuestion(
    conversationId: string,
    answers: QuestionAnswer[],
  ): boolean {
    const entry = pendingQuestions.get(conversationId);
    if (!entry) return false;
    pendingQuestions.delete(conversationId);
    entry.resolve({ answers });
    return true;
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
}
