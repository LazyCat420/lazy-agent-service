/**
 * Graph of Thoughts (GoT) Thought Structure
 *
 * Paper: "Graph of Thoughts: Solving Elaborate Problems
 * with Large Language Models" (arxiv.org/abs/2308.09687)
 *
 * Generates N parallel branches, scores each, then synthesizes
 * the best aspects of ALL branches into a unified response
 * (aggregation > selection). Core differentiator from ToT.
 *
 * Branch generation, scoring and the shared validation plumbing live
 * in ./shared.ts; this file keeps the GoT-specific synthesis pass.
 *
 * See ThoughtStructureRegistry.ts → THOUGHT_STRUCTURE_DEFINITIONS
 * (id: "graph_of_thoughts") for full paper-alignment metadata.
 */
import type AgentHooks from "../../AgentHooks.ts";
import type BaseAgenticHarness from "../BaseAgenticHarness.ts";
import type AgenticLoopState from "../../AgenticLoopState.ts";
import type {
  ConversationMessage,
  ToolSchema,
  ToolResult,
  PassState,
  EmitFunction,
} from "../types.ts";
import { SERVER_SENT_EVENT_TYPES, STATUS_MESSAGES } from "@rodrigo-barraza/utilities-library/taxonomy";
import logger from "../../../utils/logger.ts";
import PromptLocaleService from "../../PromptLocaleService.ts";
import { createStandardHooks } from "../lifecycle/HookInitializer.ts";
import { executeToolBatch } from "../lifecycle/ToolExecutor.ts";
import {
  emitPostExecutionStatus,
  processToolResultMedia,
  trackToolErrors,
} from "../lifecycle/PostExecutionEmitter.ts";
import { runExhaustionRecoveryPass } from "../lifecycle/ExhaustionRecovery.ts";
import {
  runPlanningPhase,
  checkForPlanModeEntry,
} from "../lifecycle/PlanModeController.ts";
import { validateAfterToolExecution } from "../lifecycle/ValidationInterceptor.ts";
import { buildToolRetryGuidance } from "../lifecycle/ToolRetryInterceptor.ts";
import {
  isOutputTruncated,
  isAtOutputCeiling,
  injectContinuationContext,
  injectErrorAsConversationMessage,
  buildExhaustedRecoveryMessage,
  buildProviderErrorMessage,
  MAX_OUTPUT_TRUNCATION_RECOVERIES,
} from "../lifecycle/OutputTruncationRecovery.ts";
import { manageContextPressure } from "../lifecycle/ContextPressureManager.ts";
import { logKVCacheHitRate } from "../lifecycle/KVCacheReporter.ts";
import { injectToolDiscoveryNudge } from "../lifecycle/ToolDiscoveryNudge.ts";
import { finalizePassTracker } from "../lifecycle/TrackerFinalizer.ts";
import { handleCodexPlanningResponse } from "../lifecycle/CodexPlanningDetector.ts";
import { maybeInjectSystemReminder, cleanupReminderCache } from "../lifecycle/SystemReminderInjector.ts";
import { checkCostBudget } from "../lifecycle/CostBudgetEnforcer.ts";
import { createSandboxCheckpoint } from "../lifecycle/SandboxExecutor.ts";
import {
  MAX_CONSECUTIVE_TOOL_ERRORS,
  MAX_PROACTIVE_BACKTRACKS,
  applyProactiveBacktrack,
  buildToolCallAssistantMessage,
  exploreBfsBranches,
  formatValidationErrorBlock,
  resolveBranchConfig,
  resolveMaxIterations,
  restoreCheckpointIfPresent,
  runBeforePromptPhase,
  type IterationPassOptions,
  type ScoredBranch,
} from "./shared.ts";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Public API — called by ReActHarness when thoughtStructure === "graph_of_thoughts"
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function handleGoTProactiveBacktrack(
  state: AgenticLoopState,
  scoredBranches: ScoredBranch[],
  valueThreshold: number,
  currentMessages: ConversationMessage[],
  context: BaseAgenticHarness["context"],
): void {
  applyProactiveBacktrack({
    state,
    emit: context.emit,
    currentMessages,
    options: context.options,
    localeKey: "harness.graphOfThoughts.proactiveBacktrack",
    branchIndex: -1,
    bestScore: scoredBranches[0]?.score ?? 0,
    threshold: valueThreshold,
    logPrefix: "[GraphOfThoughts]",
  });
}

function appendGoTCompletedToolMessages(
  synthesizedPass: PassState,
  results: ToolResult[],
  currentMessages: ConversationMessage[],
  state: AgenticLoopState,
  context: BaseAgenticHarness["context"],
  harness: BaseAgenticHarness,
): ConversationMessage[] {
  currentMessages.push(buildToolCallAssistantMessage(synthesizedPass, results));

  const retryGuidanceMessage = buildToolRetryGuidance(
    synthesizedPass.pendingToolCalls,
    results,
    state,
    MAX_CONSECUTIVE_TOOL_ERRORS,
    context.options?.locale as string | undefined,
  );
  if (retryGuidanceMessage) {
    currentMessages.push(retryGuidanceMessage);
  }

  const filtered = currentMessages.filter(
    (message) =>
      !(
        message.role === "assistant" &&
        !message.content?.trim() &&
        (!message.toolCalls || message.toolCalls.length === 0)
      ),
  );

  injectToolDiscoveryNudge(synthesizedPass.pendingToolCalls, results, filtered, context);
  harness.checkAndApplyToolSetChanges(filtered);
  return filtered;
}

async function handleGoTToolExecution(
  harness: BaseAgenticHarness,
  synthesizedPass: PassState,
  scoredBranches: ScoredBranch[],
  currentMessages: ConversationMessage[],
  hooks: AgentHooks,
): Promise<{ messages: ConversationMessage[]; earlyReturn: boolean }> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const tools = harness["tools"];
  const { options, workspaceRoot, emit } = context;

  context._currentMessages = currentMessages;
  const sandboxCheckpointReference = options.enableSandbox
    ? createSandboxCheckpoint(workspaceRoot, emit)
    : null;

  const results: ToolResult[] = await executeToolBatch(
    synthesizedPass.pendingToolCalls,
    context,
    tools,
    hooks,
    state,
  );

  await processToolResultMedia(
    synthesizedPass.pendingToolCalls,
    results,
    state,
    synthesizedPass,
    emit,
    context,
  );

  trackToolErrors(
    synthesizedPass.pendingToolCalls,
    results,
    state,
    MAX_CONSECUTIVE_TOOL_ERRORS,
    emit,
  );

  emitPostExecutionStatus(synthesizedPass.pendingToolCalls, emit);

  const validationFeedback = await validateAfterToolExecution(
    synthesizedPass.pendingToolCalls,
    results,
    context,
    tools,
  );

  if (validationFeedback.length > 0) {
    state.branchesBacktracked++;
    const errorBlock = formatValidationErrorBlock(validationFeedback);

    restoreCheckpointIfPresent(workspaceRoot, sandboxCheckpointReference, emit);

    currentMessages.push({
      role: "system",
      content: PromptLocaleService.get(
        (options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale(),
        "harness.graphOfThoughts.synthesizedValidationError",
        {
          errorCount: String(validationFeedback.length),
          errorBlock,
          branchCount: String(scoredBranches.length),
        },
      ),
    });

    harness.logIteration(synthesizedPass, currentMessages);
    return { messages: currentMessages, earlyReturn: false };
  }

  harness.logIteration(synthesizedPass, currentMessages);

  await checkForPlanModeEntry(
    synthesizedPass.pendingToolCalls,
    currentMessages,
    state,
    emit,
    options?.locale as string | undefined,
  );

  if (state.planModeActive) {
    const { planApproved } = await runPlanningPhase(harness, currentMessages, "GraphOfThoughts");
    if (!planApproved) return { messages: currentMessages, earlyReturn: true };
  }

  const updated = appendGoTCompletedToolMessages(
    synthesizedPass,
    results,
    currentMessages,
    state,
    context,
    harness,
  );
  return { messages: updated, earlyReturn: false };
}

function handleGoTTruncatedPass(
  harness: BaseAgenticHarness,
  synthesizedPass: PassState,
  currentMessages: ConversationMessage[],
  truncationRecoveryCount: number,
): { shouldContinue: boolean; truncationRecoveryCount: number } {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const nextCount = truncationRecoveryCount + 1;
  const configuredMaxTokens = context.options.maxTokens || "default";
  const modelOutputCeiling = context.modelDefinition?.maxOutputTokens as number | undefined;
  logger.warn(
    `[GraphOfThoughts] Max tokens truncation detected on iteration ${state.iterations} — ` +
      `Recovery attempt ${nextCount}/${MAX_OUTPUT_TRUNCATION_RECOVERIES}.`,
  );

  const alreadyAtCeiling =
    typeof configuredMaxTokens === "number" &&
    isAtOutputCeiling(configuredMaxTokens, modelOutputCeiling);

  if (!alreadyAtCeiling && nextCount <= MAX_OUTPUT_TRUNCATION_RECOVERIES) {
    const escalatedMaxTokens = injectContinuationContext(
      currentMessages,
      synthesizedPass,
      context,
      nextCount,
    );
    context.options.maxTokens = escalatedMaxTokens;
    harness.logIteration(synthesizedPass, currentMessages);
    return { shouldContinue: true, truncationRecoveryCount: nextCount };
  }

  if (alreadyAtCeiling) {
    logger.warn(
      `[GraphOfThoughts] Skipping truncation recovery — maxTokens (${configuredMaxTokens}) ` +
        `is already at or above model ceiling (${modelOutputCeiling}). Escalation would be pointless.`,
    );
  }
  const exhaustionMessage = buildExhaustedRecoveryMessage(
    alreadyAtCeiling ? 0 : MAX_OUTPUT_TRUNCATION_RECOVERIES,
    configuredMaxTokens,
    context.options?.locale as string | undefined,
  );
  injectErrorAsConversationMessage(currentMessages, exhaustionMessage, context);
  harness.logIteration(synthesizedPass, currentMessages);
  return { shouldContinue: false, truncationRecoveryCount: nextCount };
}

function handleGoTNoToolPass(
  harness: BaseAgenticHarness,
  synthesizedPass: PassState,
  currentMessages: ConversationMessage[],
  truncationRecoveryCount: number,
): { shouldBreak: boolean; hasCleanTextBreak: boolean; truncationRecoveryCount: number } {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const tools = harness["tools"];

  if (synthesizedPass.streamedText) {
    const codexResult = handleCodexPlanningResponse(
      synthesizedPass,
      currentMessages,
      context,
      state,
      tools.finalTools,
      "GraphOfThoughts",
    );
    harness.logIteration(synthesizedPass, currentMessages);
    if (codexResult.shouldContinueLoop) {
      return { shouldBreak: false, hasCleanTextBreak: false, truncationRecoveryCount };
    }
    return { shouldBreak: true, hasCleanTextBreak: true, truncationRecoveryCount };
  }

  if (synthesizedPass.streamedThinking.trim()) {
    logger.warn(
      `[GraphOfThoughts] Thinking-only response on iteration ${state.iterations} — ` +
        `thinking=${synthesizedPass.streamedThinking.length}chars, text=0. ` +
        `Injecting continuation prompt.`,
    );
    currentMessages.push({
      role: "assistant",
      content: "",
      thinking: synthesizedPass.streamedThinking.trim(),
      ...(synthesizedPass.thinkingSignature && {
        thinkingSignature: synthesizedPass.thinkingSignature,
      }),
    });
    currentMessages.push({
      role: "user",
      content:
        "[System: Your previous response contained only internal reasoning " +
        "without producing any visible output. Your thinking has been preserved. " +
        "Now respond concisely with your actual answer, analysis, or tool calls. " +
        "Do not repeat your reasoning — act on it.]",
      _isSystemWarning: true,
    });
    harness.logIteration(synthesizedPass, currentMessages);
    return { shouldBreak: false, hasCleanTextBreak: false, truncationRecoveryCount };
  }

  if (isOutputTruncated(synthesizedPass)) {
    const recovery = handleGoTTruncatedPass(
      harness,
      synthesizedPass,
      currentMessages,
      truncationRecoveryCount,
    );
    return {
      shouldBreak: !recovery.shouldContinue,
      hasCleanTextBreak: false,
      truncationRecoveryCount: recovery.truncationRecoveryCount,
    };
  }

  logger.warn(`[GraphOfThoughts] Empty model output on iteration ${state.iterations}. Breaking.`);
  harness.logIteration(synthesizedPass, currentMessages);
  return { shouldBreak: true, hasCleanTextBreak: false, truncationRecoveryCount };
}

function finalizeGoTSynthesizedBranches(
  harness: BaseAgenticHarness,
  synthesizedPass: PassState,
  branchesToSynthesize: ScoredBranch[],
  currentMessages: ConversationMessage[],
  state: AgenticLoopState,
): void {
  state.finalStreamedText = synthesizedPass.finalStreamedText;
  state.streamedThinking = synthesizedPass.streamedThinking;
  finalizePassTracker(synthesizedPass, synthesizedPass.requestId || "");
  for (const branch of branchesToSynthesize) {
    if (branch.pass.requestId) {
      finalizePassTracker(branch.pass, branch.pass.requestId);
      harness.logIteration(branch.pass, currentMessages);
    }
  }
  logKVCacheHitRate(synthesizedPass.usage, state.iterations, "GraphOfThoughts");
  harness.emitGenerationProgress();
  harness.emitUsageUpdate();
}

async function handleGoTLoopError(
  loopError: unknown,
  harness: BaseAgenticHarness,
  currentMessages: ConversationMessage[],
  hooks: AgentHooks,
): Promise<never> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  logger.error(
    `[GraphOfThoughts] Loop error on iteration ${state.iterations}: ${loopError instanceof Error ? loopError.message : String(loopError)}. Persisting ${currentMessages.length - state.originalMessageCount} accumulated message(s).`,
  );
  injectErrorAsConversationMessage(
    currentMessages,
    buildProviderErrorMessage(loopError, state.iterations, context.options?.locale as string | undefined),
    context,
  );
  state.conversationOutcome = "error";
  try {
    await harness["finalize"](currentMessages, hooks);
  } catch (persistError: unknown) {
    logger.error(
      `[GraphOfThoughts] Failed to persist messages on error path: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
    );
  }
  throw loopError;
}

/** Branch count for this GoT iteration. */
function resolveAdaptiveGoTBranchCount(
  iteration: number,
  initialBranchCount: number,
): number {
  return iteration === 1
    ? initialBranchCount
    : Math.max(2, Math.ceil(initialBranchCount * 0.6));
}

/** Emit the branch-selected status for this GoT iteration. */
function emitGoTBranchSelected(
  scoredBranches: ScoredBranch[],
  adaptiveBranchCount: number,
  emit: EmitFunction,
): void {
  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.BRANCH_SELECTED,
    branchCount: adaptiveBranchCount,
    scores: scoredBranches.map((branch) => ({
      index: branch.branchIndex,
      score: branch.score,
      criteria: branch.criteriaScores,
    })),
    synthesizing: true,
  });
}

/** Trigger a proactive backtrack when every branch scored below threshold. */
function maybeGoTProactiveBacktrack(
  state: AgenticLoopState,
  scoredBranches: ScoredBranch[],
  valueThreshold: number,
  currentMessages: ConversationMessage[],
  context: BaseAgenticHarness["context"],
): boolean {
  const activeBranches = scoredBranches.filter((branch) => branch.score >= valueThreshold);
  if (
    activeBranches.length === 0 &&
    state.iterations > 1 &&
    state.proactiveBacktracks < MAX_PROACTIVE_BACKTRACKS
  ) {
    handleGoTProactiveBacktrack(
      state,
      scoredBranches,
      valueThreshold,
      currentMessages,
      context,
    );
    return true;
  }
  return false;
}

/** Pick the branches to synthesize: the qualifying ones, else the best one. */
function selectBranchesToSynthesize(
  activeBranches: ScoredBranch[],
  scoredBranches: ScoredBranch[],
): ScoredBranch[] {
  return activeBranches.length > 0 ? activeBranches : [scoredBranches[0]];
}

/** Synthesize the selected branches and finalize/cost-check the pass. */
async function runGoTSynthesisPhase(
  harness: BaseAgenticHarness,
  branchesToSynthesize: ScoredBranch[],
  currentMessages: ConversationMessage[],
  passOptions: IterationPassOptions,
  allowedToolNames: Set<string>,
): Promise<{ synthesizedPass: PassState; shouldBreak: boolean }> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const { options, emit, signal } = context;

  const synthesizedPass = await synthesizeBranches(
    harness,
    branchesToSynthesize,
    currentMessages,
    passOptions,
    allowedToolNames,
  );

  if (signal?.aborted) return { synthesizedPass, shouldBreak: true };

  finalizeGoTSynthesizedBranches(
    harness,
    synthesizedPass,
    branchesToSynthesize,
    currentMessages,
    state,
  );

  if (
    await checkCostBudget(
      state,
      context.resolvedModel,
      options.maxCostDollars,
      emit,
      context.conversationId,
      {
        signal: context.signal,
        pauseTimeoutMs: options.budgetPauseTimeoutMs,
      },
    )
  ) {
    return { synthesizedPass, shouldBreak: true };
  }

  return { synthesizedPass, shouldBreak: false };
}

interface GoTIterationParams {
  harness: BaseAgenticHarness;
  initialBranchCount: number;
  valueThreshold: number;
  maxIterations: number;
  currentMessages: ConversationMessage[];
  truncationRecoveryCount: number;
  hooks: AgentHooks;
}

interface GoTIterationOutcome {
  messages: ConversationMessage[];
  action: "continue" | "break" | "return";
  hasCleanTextBreak: boolean;
  truncationRecoveryCount: number;
}

/** Run one Graph-of-Thoughts iteration and report what the loop should do next. */
async function runGoTIteration(
  params: GoTIterationParams,
): Promise<GoTIterationOutcome> {
  const {
    harness,
    initialBranchCount,
    valueThreshold,
    maxIterations,
    truncationRecoveryCount,
    hooks,
  } = params;
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const tools = harness["tools"];
  const { options, project, username, agent, emit } = context;
  let currentMessages = params.currentMessages;

  state.iterations++;

  const adaptiveBranchCount = resolveAdaptiveGoTBranchCount(
    state.iterations,
    initialBranchCount,
  );

  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.ITERATION_PROGRESS,
    iteration: state.iterations,
    maxIterations,
    harness: "graph_of_thoughts",
    branchCount: adaptiveBranchCount,
  });

  await maybeInjectSystemReminder(currentMessages, state, context);

  const passOptions: IterationPassOptions = {
    ...options,
    project,
    agent,
    username,
    tools: tools.finalTools,
  };

  const pressureResult = await manageContextPressure(
    currentMessages,
    context,
    state,
    "GraphOfThoughts",
  );
  currentMessages = pressureResult.messages;
  currentMessages = harness.enforceContextWindow(currentMessages, tools.finalTools.length);

  const allowedToolNames = new Set(tools.finalTools.map((tool: ToolSchema) => tool.name));

  const bfsOutcome = await exploreBfsBranches(
    harness,
    adaptiveBranchCount,
    currentMessages,
    passOptions,
    allowedToolNames,
    undefined,
    undefined,
    "[GraphOfThoughts]",
  );
  if (bfsOutcome.aborted) {
    return {
      messages: currentMessages,
      action: "break",
      hasCleanTextBreak: false,
      truncationRecoveryCount,
    };
  }
  const scoredBranches = bfsOutcome.scoredBranches;
  state.selectedBranchScores.push(scoredBranches[0]?.score ?? 0);

  emitGoTBranchSelected(scoredBranches, adaptiveBranchCount, emit);

  logger.info(
    `[GraphOfThoughts] Iteration ${state.iterations}: scored ${adaptiveBranchCount} branches — ` +
      `scores: [${scoredBranches.map((branch) => branch.score.toFixed(1)).join(", ")}]`,
  );

  if (
    maybeGoTProactiveBacktrack(
      state,
      scoredBranches,
      valueThreshold,
      currentMessages,
      context,
    )
  ) {
    return {
      messages: currentMessages,
      action: "continue",
      hasCleanTextBreak: false,
      truncationRecoveryCount,
    };
  }

  const activeBranches = scoredBranches.filter((branch) => branch.score >= valueThreshold);
  const branchesToSynthesize = selectBranchesToSynthesize(activeBranches, scoredBranches);

  const { synthesizedPass, shouldBreak } = await runGoTSynthesisPhase(
    harness,
    branchesToSynthesize,
    currentMessages,
    passOptions,
    allowedToolNames,
  );

  if (shouldBreak) {
    return {
      messages: currentMessages,
      action: "break",
      hasCleanTextBreak: false,
      truncationRecoveryCount,
    };
  }

  if (synthesizedPass.pendingToolCalls.length > 0) {
    const toolTurn = await handleGoTToolExecution(
      harness,
      synthesizedPass,
      scoredBranches,
      currentMessages,
      hooks,
    );
    currentMessages = toolTurn.messages;
    if (toolTurn.earlyReturn) {
      return {
        messages: currentMessages,
        action: "return",
        hasCleanTextBreak: false,
        truncationRecoveryCount,
      };
    }
    return {
      messages: currentMessages,
      action: "continue",
      hasCleanTextBreak: false,
      truncationRecoveryCount,
    };
  }

  const noToolOutcome = handleGoTNoToolPass(
    harness,
    synthesizedPass,
    currentMessages,
    truncationRecoveryCount,
  );

  return {
    messages: currentMessages,
    action: noToolOutcome.shouldBreak ? "break" : "continue",
    hasCleanTextBreak: noToolOutcome.hasCleanTextBreak,
    truncationRecoveryCount: noToolOutcome.truncationRecoveryCount,
  };
}

export async function runGraphOfThoughts(
  harness: BaseAgenticHarness,
): Promise<{ messages: ConversationMessage[] }> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const {
    options,
    agentConversationId,
    workspaceRoot,
    signal,
  } = context;

  const resolvedAgentConversationId = agentConversationId || "";
  const { initialBranchCount, valueThreshold } = resolveBranchConfig(options);
  const resolvedMaxIterations = resolveMaxIterations(options.maxIterations);

  let currentMessages: ConversationMessage[] = [...context.messages];
  let truncationRecoveryCount = 0;
  let hasCleanTextBreak = false;

  const { hooks } = createStandardHooks({
    workspaceRoot: workspaceRoot || undefined,
    enableCriticGate: options.enableCriticGate === true,
    criticModel: options.criticModel || undefined,
  });

  await runBeforePromptPhase(harness, currentMessages, hooks, resolvedAgentConversationId);

  if (state.planModeActive) {
    const { planApproved } = await runPlanningPhase(harness, currentMessages, "GraphOfThoughts");
    if (!planApproved) return { messages: currentMessages };
  }

  try {
    while (state.iterations < resolvedMaxIterations) {
      const outcome = await runGoTIteration({
        harness,
        initialBranchCount,
        valueThreshold,
        maxIterations: resolvedMaxIterations,
        currentMessages,
        truncationRecoveryCount,
        hooks,
      });
      currentMessages = outcome.messages;
      truncationRecoveryCount = outcome.truncationRecoveryCount;
      if (outcome.hasCleanTextBreak) hasCleanTextBreak = true;
      if (outcome.action === "return") return { messages: currentMessages };
      if (outcome.action === "break") break;
    }

    if (!hasCleanTextBreak && state.streamedToolCalls.length > 0 && !signal?.aborted) {
      state.conversationOutcome = "exhausted";
      await runExhaustionRecoveryPass(harness, context, state, currentMessages);
    }

    logger.info(
      `[GraphOfThoughts] Session complete: ${state.iterations} iterations, ` +
        `${state.branchesExplored} branches explored, ` +
        `${state.branchesBacktracked} backtracked`,
    );

    cleanupReminderCache(resolvedAgentConversationId);
    await harness["finalize"](currentMessages, hooks);
    return { messages: currentMessages };
  } catch (loopError: unknown) {
    return await handleGoTLoopError(loopError, harness, currentMessages, hooks);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Synthesis pass — merges branch outputs into a unified response
//  (The core GoT differentiator vs ToT's pick-winner)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function synthesizeBranches(
  harness: BaseAgenticHarness,
  scoredBranches: ScoredBranch[],
  currentMessages: ConversationMessage[],
  passOptions: IterationPassOptions,
  allowedToolNames: Set<string>,
): Promise<PassState> {
  const state: AgenticLoopState = harness["state"];
  const context = harness["context"];

  // If only one branch, skip synthesis — use it directly (same as ToT)
  if (scoredBranches.length <= 1) {
    logger.info(`[GraphOfThoughts] Single branch — skipping synthesis, using directly.`);
    return scoredBranches[0].pass;
  }

  // Build a synthesis prompt that presents all branch outputs with their scores
  const branchSummaries = scoredBranches
    .map((branch) => {
      const textContent = (branch.text || branch.thinking || "(no output)")
        .slice(0, 1500)
        .trim();
      const toolCallDescriptions = branch.pass.pendingToolCalls
        .map((toolCall) => {
          const argumentsSummary = typeof toolCall.args === "string"
            ? (toolCall.args as string).slice(0, 300)
            : JSON.stringify(toolCall.args).slice(0, 300);
          return `  - ${toolCall.name}(${argumentsSummary})`;
        })
        .join("\n");

      return (
        `── Branch ${branch.branchIndex + 1} ` +
        `(score: ${branch.score.toFixed(1)} — ` +
        `correctness=${branch.criteriaScores.correctness}, ` +
        `risk=${branch.criteriaScores.risk}, ` +
        `efficiency=${branch.criteriaScores.efficiency}, ` +
        `completeness=${branch.criteriaScores.completeness}) ──\n` +
        `Reasoning:\n${textContent}\n` +
        (toolCallDescriptions
          ? `Tool calls:\n${toolCallDescriptions}`
          : "(no tool calls)")
      );
    })
    .join("\n\n");

  const synthesisInstruction: ConversationMessage = {
    role: "user",
    content:
      `[GRAPH-OF-THOUGHTS SYNTHESIS PASS]\n\n` +
      `${scoredBranches.length} parallel reasoning branches were generated and scored. ` +
      `Your task is to produce a single, optimal response that SYNTHESIZES the best ` +
      `aspects of all branches — combining the strongest tool calls, the safest ` +
      `approaches, and the most complete coverage into one unified action.\n\n` +
      `RULES:\n` +
      `1. Do NOT simply repeat the highest-scoring branch. Merge complementary strengths.\n` +
      `2. If multiple branches propose different tool calls that are COMPLEMENTARY ` +
      `   (non-conflicting), include all of them.\n` +
      `3. If branches disagree on approach, prefer the one with highest CORRECTNESS ` +
      `   score, then RISK score.\n` +
      `4. Incorporate defensive measures (error handling, validation) from the ` +
      `   THOROUGH branch even if using a MINIMAL branch's core approach.\n` +
      `5. Produce your merged response with tool calls as if you are executing the task.\n\n` +
      `── BRANCH OUTPUTS ──\n\n` +
      branchSummaries,
  };

  const synthesisMessages = [...currentMessages, synthesisInstruction];

  context.emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.SYNTHESIS_STARTED,
    branchCount: scoredBranches.length,
    iteration: state.iterations,
  });

  logger.info(
    `[GraphOfThoughts] Starting synthesis pass from ${scoredBranches.length} branches.`,
  );

  const synthesisPass = harness.createPassState(passOptions);
  const { agentConversationId } = context;
  const resolvedAgentConversationId = agentConversationId || "";
  const requestIdBase = context.requestId || resolvedAgentConversationId || crypto.randomUUID();
  const passRequestId = `${requestIdBase}-iter-${state.iterations}-synthesis`;
  synthesisPass.requestId = passRequestId;
  harness.registerTrackerRequest(passRequestId);

  const synthesisStream = await harness.createProviderStream(synthesisMessages, passOptions);
  await harness.consumeStream(synthesisStream, synthesisPass, allowedToolNames);

  logger.info(
    `[GraphOfThoughts] Synthesis complete — ` +
      `${synthesisPass.pendingToolCalls.length} tool call(s), ` +
      `${(synthesisPass.streamedText || "").length} chars text output.`,
  );

  return synthesisPass;
}
