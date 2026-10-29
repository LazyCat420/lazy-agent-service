/**
 * Tree of Thoughts (ToT) Thought Structure
 *
 * Paper: "Tree of Thoughts: Deliberate Problem Solving
 * with Large Language Models" (arxiv.org/abs/2305.10601)
 *
 * Two search strategies, both with value-threshold pruning:
 *
 *   BFS (Algorithm 1): Generate N branches in parallel, score,
 *   retain top-b as frontier. Execute the best; on validation
 *   failure, fall back to the next frontier candidate before
 *   re-branching.
 *
 *   Note on BFS Frontier Fallback: BFS frontier fallback (switching to the next-best
 *   pre-scored candidate upon validation failure) requires sandbox execution to be active
 *   (options.enableSandbox === true) to safely roll back any file changes from the failed branch
 *   before executing the next sibling. Without a sandbox, frontier fallback is bypassed to avoid
 *   running siblings on a dirty filesystem.
 *
 *   DFS (Algorithm 2): Explore siblings sequentially — generate
 *   one branch, score it, accept if above threshold. If below,
 *   try the next sibling. Accept best available after exhausting
 *   the sibling budget.
 *
 * Proactive backtracking: If all branches score below the value
 * threshold (default 5.0), the iteration is discarded and a
 * reflexion prompt is injected before re-branching — matching
 * the paper's state evaluator V(s) pruning.
 *
 * Branch generation, scoring, exploration wrappers and the shared
 * validation/reflexion plumbing live in ./shared.ts.
 *
 * See ThoughtStructureRegistry.ts → THOUGHT_STRUCTURE_DEFINITIONS
 * (id: "tree_of_thoughts") for full paper-alignment metadata.
 */
import type AgentHooks from "../../AgentHooks.ts";
import type BaseAgenticHarness from "../BaseAgenticHarness.ts";
import type AgenticLoopState from "../../AgenticLoopState.ts";
import type {
  ConversationMessage,
  ToolCall,
  ToolSchema,
  ToolResult,
  AgenticOptions,
  PassState,
  EmitFunction,
  ValidationFeedback,
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
  DEFAULT_BFS_BEAM_WIDTH,
  MAX_CONSECUTIVE_TOOL_ERRORS,
  MAX_PROACTIVE_BACKTRACKS,
  applyProactiveBacktrack,
  buildToolCallAssistantMessage,
  exploreBfsBranches,
  exploreDfsBranches,
  formatValidationErrorBlock,
  resolveBranchConfig,
  resolveMaxIterations,
  restoreCheckpointIfPresent,
  runBeforePromptPhase,
  type IterationPassOptions,
  type ScoredBranch,
  type SearchStrategy,
} from "./shared.ts";

const MAX_BACKTRACK_ATTEMPTS_PER_ITERATION = 2;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Public API — called by ReActHarness when thoughtStructure === "tree_of_thoughts"
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function resolveToTSearchConfig(options: AgenticOptions) {
  const searchStrategy: SearchStrategy = (options.searchStrategy as SearchStrategy) || "bfs";
  const { initialBranchCount, valueThreshold } = resolveBranchConfig(options);
  const bfsBeamWidth = Math.min(DEFAULT_BFS_BEAM_WIDTH, initialBranchCount);
  const resolvedMaxIterations = resolveMaxIterations(options.maxIterations);
  return { searchStrategy, initialBranchCount, valueThreshold, bfsBeamWidth, resolvedMaxIterations };
}

function handleProactiveToTBacktrack(
  selectedBranch: ScoredBranch,
  scoredBranches: ScoredBranch[],
  valueThreshold: number,
  state: AgenticLoopState,
  currentMessages: ConversationMessage[],
  failedApproachDescriptions: string[],
  options: AgenticOptions,
  emit: EmitFunction,
): boolean {
  if (
    selectedBranch.score >= valueThreshold ||
    state.iterations <= 1 ||
    state.proactiveBacktracks >= MAX_PROACTIVE_BACKTRACKS
  ) {
    return false;
  }

  const failedSummary = (selectedBranch.text || selectedBranch.thinking || "").slice(0, 300).trim();
  if (failedSummary) failedApproachDescriptions.push(failedSummary);

  applyProactiveBacktrack({
    state,
    emit,
    currentMessages,
    options,
    localeKey: "harness.treeOfThoughts.proactiveBacktrack",
    branchIndex: selectedBranch.branchIndex,
    bestScore: selectedBranch.score,
    threshold: valueThreshold,
    extraLocaleVars: { branchCount: String(scoredBranches.length) },
    logPrefix: "[TreeOfThoughts]",
  });
  return true;
}

function handleToTValidationFailure(
  harness: BaseAgenticHarness,
  selectedBranch: ScoredBranch,
  scoredBranches: ScoredBranch[],
  validationFeedback: ValidationFeedback[],
  results: ToolResult[],
  preExecutionSnapshot: ConversationMessage[],
  sandboxCheckpointReference: string | null,
  searchStrategy: SearchStrategy,
  failedApproachDescriptions: string[],
): ConversationMessage[] {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const { options, workspaceRoot, emit } = context;
  const selectedPass = selectedBranch.pass;
  const locale = (options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale();

  state.branchesBacktracked++;
  const errorBlock = formatValidationErrorBlock(validationFeedback);

  const failedApproachSummary = (selectedPass.streamedText || selectedPass.streamedThinking || "")
    .slice(0, 300)
    .trim();
  if (failedApproachSummary) {
    failedApproachDescriptions.push(failedApproachSummary);
  }

  if (searchStrategy === "bfs" && state.frontierCandidates.length > 0 && sandboxCheckpointReference) {
    return applyBfsFrontierFallback(
      harness,
      selectedBranch,
      selectedPass,
      validationFeedback.length,
      errorBlock,
      preExecutionSnapshot,
      sandboxCheckpointReference,
      locale,
    );
  }

  const shouldRestoreCheckpoint =
    state.branchesBacktracked <= MAX_BACKTRACK_ATTEMPTS_PER_ITERATION && scoredBranches.length > 1;
  const nextMessages = shouldRestoreCheckpoint
    ? applyToTCheckpointRestore(
        selectedBranch,
        validationFeedback.length,
        errorBlock,
        preExecutionSnapshot,
        sandboxCheckpointReference,
        workspaceRoot,
        emit,
        locale,
      )
    : applyToTBudgetExhaustedFallback(
        selectedBranch,
        selectedPass,
        validationFeedback.length,
        errorBlock,
        results,
        context._currentMessages || preExecutionSnapshot,
        emit,
        locale,
      );

  harness.logIteration(selectedPass, nextMessages);
  return nextMessages;
}

function applyBfsFrontierFallback(
  harness: BaseAgenticHarness,
  selectedBranch: ScoredBranch,
  selectedPass: PassState,
  errorCount: number,
  errorBlock: string,
  preExecutionSnapshot: ConversationMessage[],
  sandboxCheckpointReference: string,
  locale: string,
): ConversationMessage[] {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const { workspaceRoot, emit } = context;
  const fallbackCandidate = state.frontierCandidates.shift()!;
  const currentMessages = [...preExecutionSnapshot];
  restoreCheckpointIfPresent(workspaceRoot, sandboxCheckpointReference, emit);

  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
    branchIndex: selectedBranch.branchIndex,
    validationErrors: errorCount,
    restoredCheckpoint: true,
    reason: "frontier_fallback",
    fallbackBranchIndex: fallbackCandidate.branchIndex,
    fallbackScore: fallbackCandidate.score,
  });

  logger.info(
    `[TreeOfThoughts/BFS] Branch ${selectedBranch.branchIndex + 1} failed validation. Falling back to frontier candidate ${fallbackCandidate.branchIndex + 1} (score: ${fallbackCandidate.score.toFixed(1)}).`,
  );

  currentMessages.push({
    role: "system",
    content: PromptLocaleService.get(locale, "harness.treeOfThoughts.frontierFallback", {
      branchIndex: String(selectedBranch.branchIndex + 1),
      errorCount: String(errorCount),
      errorBlock,
    }),
  });

  harness.logIteration(selectedPass, currentMessages);
  if (fallbackCandidate.pass.streamedText) {
    currentMessages.push({
      role: "assistant",
      content: fallbackCandidate.pass.streamedText,
      ...(fallbackCandidate.pass.streamedThinking.trim() && {
        thinking: fallbackCandidate.pass.streamedThinking.trim(),
      }),
    });
  }
  return currentMessages;
}

function applyToTCheckpointRestore(
  selectedBranch: ScoredBranch,
  errorCount: number,
  errorBlock: string,
  preExecutionSnapshot: ConversationMessage[],
  sandboxCheckpointReference: string | null,
  workspaceRoot: string | null | undefined,
  emit: EmitFunction,
  locale: string,
): ConversationMessage[] {
  const currentMessages = [...preExecutionSnapshot];
  restoreCheckpointIfPresent(workspaceRoot, sandboxCheckpointReference, emit);
  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
    branchIndex: selectedBranch.branchIndex,
    validationErrors: errorCount,
    restoredCheckpoint: true,
  });
  logger.info(
    `[TreeOfThoughts] Branch ${selectedBranch.branchIndex + 1} failed validation. Restored checkpoint. Injecting reflexion prompt for self-correction.`,
  );
  currentMessages.push({
    role: "system",
    content: PromptLocaleService.get(locale, "harness.treeOfThoughts.reflexion", {
      branchIndex: String(selectedBranch.branchIndex + 1),
      errorCount: String(errorCount),
      errorBlock,
    }),
  });
  return currentMessages;
}

function applyToTBudgetExhaustedFallback(
  selectedBranch: ScoredBranch,
  selectedPass: PassState,
  errorCount: number,
  errorBlock: string,
  results: ToolResult[],
  currentMessages: ConversationMessage[],
  emit: EmitFunction,
  locale: string,
): ConversationMessage[] {
  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
    branchIndex: selectedBranch.branchIndex,
    validationErrors: errorCount,
    restoredCheckpoint: false,
  });
  currentMessages.push({
    role: "assistant",
    content: selectedPass.streamedText || "",
    ...(selectedPass.streamedThinking.trim() && {
      thinking: selectedPass.streamedThinking.trim(),
    }),
    toolCalls: selectedPass.pendingToolCalls.map((toolCall: ToolCall) => {
      const matchingResult = results.find((result) => result.id === toolCall.id);
      return {
        id: toolCall.id || null,
        name: toolCall.name,
        args: toolCall.args,
        result: matchingResult ? matchingResult.result : null,
        durationMs: matchingResult?.durationMs,
      };
    }),
  });
  currentMessages.push({
    role: "system",
    content: PromptLocaleService.get(locale, "harness.treeOfThoughts.budgetExhausted", { errorBlock }),
  });
  return currentMessages;
}

async function commitValidatedToTToolBranch(
  harness: BaseAgenticHarness,
  selectedPass: PassState,
  results: ToolResult[],
  currentMessages: ConversationMessage[],
): Promise<{ messages: ConversationMessage[]; planAborted: boolean }> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const { options, emit } = context;

  harness.logIteration(selectedPass, currentMessages);

  await checkForPlanModeEntry(
    selectedPass.pendingToolCalls,
    currentMessages,
    state,
    emit,
    options?.locale as string | undefined,
  );

  if (state.planModeActive) {
    const { planApproved } = await runPlanningPhase(harness, currentMessages, "TreeOfThoughts");
    if (!planApproved) return { messages: currentMessages, planAborted: true };
  }

  currentMessages.push(buildToolCallAssistantMessage(selectedPass, results));

  const retryGuidanceMessage = buildToolRetryGuidance(
    selectedPass.pendingToolCalls,
    results,
    state,
    MAX_CONSECUTIVE_TOOL_ERRORS,
    options?.locale as string | undefined,
  );
  if (retryGuidanceMessage) {
    currentMessages.push(retryGuidanceMessage);
  }

  const filteredMessages = currentMessages.filter(
    (message) =>
      !(
        message.role === "assistant" &&
        !message.content?.trim() &&
        (!message.toolCalls || message.toolCalls.length === 0)
      ),
  );

  injectToolDiscoveryNudge(selectedPass.pendingToolCalls, results, filteredMessages, context);
  harness.checkAndApplyToolSetChanges(filteredMessages);
  return { messages: filteredMessages, planAborted: false };
}

function handleToTNonToolPass(
  harness: BaseAgenticHarness,
  selectedPass: PassState,
  currentMessages: ConversationMessage[],
  truncationState: { count: number },
): "continue" | "clean_break" | "break" {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const tools = harness["tools"];
  const { options } = context;

  if (selectedPass.streamedText) {
    const codexResult = handleCodexPlanningResponse(
      selectedPass,
      currentMessages,
      context,
      state,
      tools.finalTools,
      "TreeOfThoughts",
    );
    harness.logIteration(selectedPass, currentMessages);
    return codexResult.shouldContinueLoop ? "continue" : "clean_break";
  }

  if (selectedPass.streamedThinking.trim()) {
    logger.warn(
      `[TreeOfThoughts] Thinking-only response on iteration ${state.iterations} — thinking=${selectedPass.streamedThinking.length}chars, text=0. Injecting continuation prompt.`,
    );
    currentMessages.push({
      role: "assistant",
      content: "",
      thinking: selectedPass.streamedThinking.trim(),
      ...(selectedPass.thinkingSignature && { thinkingSignature: selectedPass.thinkingSignature }),
    });
    currentMessages.push({
      role: "user",
      content:
        "[System: Your previous response contained only internal reasoning without producing any visible output. Your thinking has been preserved. Now respond concisely with your actual answer, analysis, or tool calls. Do not repeat your reasoning — act on it.]",
      _isSystemWarning: true,
    });
    harness.logIteration(selectedPass, currentMessages);
    return "continue";
  }

  if (isOutputTruncated(selectedPass)) {
    return handleToTTruncationRecovery(harness, selectedPass, currentMessages, truncationState, options);
  }

  logger.warn(`[TreeOfThoughts] Empty model output on iteration ${state.iterations}. Breaking.`);
  harness.logIteration(selectedPass, currentMessages);
  return "break";
}

function handleToTTruncationRecovery(
  harness: BaseAgenticHarness,
  selectedPass: PassState,
  currentMessages: ConversationMessage[],
  truncationState: { count: number },
  options: AgenticOptions,
): "continue" | "break" {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  truncationState.count++;
  const configuredMaxTokens = context.options.maxTokens || "default";
  const modelOutputCeiling = context.modelDefinition?.maxOutputTokens as number | undefined;
  logger.warn(
    `[TreeOfThoughts] Max tokens truncation detected on iteration ${state.iterations} — Recovery attempt ${truncationState.count}/${MAX_OUTPUT_TRUNCATION_RECOVERIES}.`,
  );

  const alreadyAtCeiling =
    typeof configuredMaxTokens === "number" && isAtOutputCeiling(configuredMaxTokens, modelOutputCeiling);
  if (!alreadyAtCeiling && truncationState.count <= MAX_OUTPUT_TRUNCATION_RECOVERIES) {
    context.options.maxTokens = injectContinuationContext(
      currentMessages,
      selectedPass,
      context,
      truncationState.count,
    );
    harness.logIteration(selectedPass, currentMessages);
    return "continue";
  }

  if (alreadyAtCeiling) {
    logger.warn(
      `[TreeOfThoughts] Skipping truncation recovery — maxTokens (${configuredMaxTokens}) is already at or above model ceiling (${modelOutputCeiling}). Escalation would be pointless.`,
    );
  }
  const exhaustionMessage = buildExhaustedRecoveryMessage(
    alreadyAtCeiling ? 0 : MAX_OUTPUT_TRUNCATION_RECOVERIES,
    configuredMaxTokens,
    options?.locale as string | undefined,
  );
  injectErrorAsConversationMessage(currentMessages, exhaustionMessage, context);
  harness.logIteration(selectedPass, currentMessages);
  return "break";
}

async function executeToTToolCalls(
  harness: BaseAgenticHarness,
  selectedBranch: ScoredBranch,
  scoredBranches: ScoredBranch[],
  currentMessages: ConversationMessage[],
  hooks: AgentHooks,
  searchStrategy: SearchStrategy,
  failedApproachDescriptions: string[],
): Promise<{ messages: ConversationMessage[]; planAborted: boolean; clearedFailed: boolean }> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const tools = harness["tools"];
  const { options, workspaceRoot, emit } = context;
  const selectedPass = selectedBranch.pass;

  const preExecutionSnapshot = currentMessages.map((message) => ({ ...message }));
  context._currentMessages = currentMessages;
  const sandboxCheckpointReference = options.enableSandbox
    ? createSandboxCheckpoint(workspaceRoot, emit)
    : null;

  const results: ToolResult[] = await executeToolBatch(
    selectedPass.pendingToolCalls,
    context,
    tools,
    hooks,
    state,
  );
  await processToolResultMedia(selectedPass.pendingToolCalls, results, state, selectedPass, emit, context);
  trackToolErrors(selectedPass.pendingToolCalls, results, state, MAX_CONSECUTIVE_TOOL_ERRORS, emit);
  emitPostExecutionStatus(selectedPass.pendingToolCalls, emit);

  const validationFeedback = await validateAfterToolExecution(
    selectedPass.pendingToolCalls,
    results,
    context,
    tools,
  );
  if (validationFeedback.length > 0) {
    const updated = handleToTValidationFailure(
      harness,
      selectedBranch,
      scoredBranches,
      validationFeedback,
      results,
      preExecutionSnapshot,
      sandboxCheckpointReference,
      searchStrategy,
      failedApproachDescriptions,
    );
    return { messages: updated, planAborted: false, clearedFailed: false };
  }

  const committed = await commitValidatedToTToolBranch(harness, selectedPass, results, currentMessages);
  return { messages: committed.messages, planAborted: committed.planAborted, clearedFailed: true };
}

async function handleToTLoopError(
  loopError: unknown,
  harness: BaseAgenticHarness,
  currentMessages: ConversationMessage[],
  hooks: AgentHooks,
): Promise<never> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  logger.error(
    `[TreeOfThoughts] Loop error on iteration ${state.iterations}: ${loopError instanceof Error ? loopError.message : String(loopError)}. Persisting ${currentMessages.length - state.originalMessageCount} accumulated message(s).`,
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
      `[TreeOfThoughts] Failed to persist messages on error path: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
    );
  }
  throw loopError;
}

export async function runTreeOfThoughts(
  harness: BaseAgenticHarness,
): Promise<{ messages: ConversationMessage[] }> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const tools = harness["tools"];
  const { options, agentConversationId, project, username, agent, workspaceRoot, emit, signal } = context;
  const resolvedAgentConversationId = agentConversationId || "";
  const { searchStrategy, initialBranchCount, valueThreshold, bfsBeamWidth, resolvedMaxIterations } =
    resolveToTSearchConfig(options);

  let currentMessages: ConversationMessage[] = [...context.messages];
  const truncationState = { count: 0 };
  let hasCleanTextBreak = false;
  let failedApproachDescriptions: string[] = [];

  const { hooks } = createStandardHooks({
    workspaceRoot: workspaceRoot || undefined,
    enableCriticGate: options.enableCriticGate === true,
    criticModel: options.criticModel || undefined,
  });

  await runBeforePromptPhase(harness, currentMessages, hooks, resolvedAgentConversationId);

  if (state.planModeActive) {
    const { planApproved } = await runPlanningPhase(harness, currentMessages, "TreeOfThoughts");
    if (!planApproved) return { messages: currentMessages };
  }

  try {
    while (state.iterations < resolvedMaxIterations) {
      state.iterations++;
      const adaptiveBranchCount =
        searchStrategy === "dfs" || state.iterations === 1
          ? initialBranchCount
          : Math.max(1, Math.ceil(initialBranchCount * 0.6));

      emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.ITERATION_PROGRESS,
        iteration: state.iterations,
        maxIterations: resolvedMaxIterations,
        harness: "tree_of_thought",
        searchStrategy,
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

      const pressureResult = await manageContextPressure(currentMessages, context, state, "TreeOfThoughts");
      currentMessages = harness.enforceContextWindow(pressureResult.messages, tools.finalTools.length);
      const allowedToolNames = new Set(tools.finalTools.map((tool: ToolSchema) => tool.name));

      let scoredBranches: ScoredBranch[];
      let selectedBranch: ScoredBranch;
      if (searchStrategy === "dfs") {
        const dfsOutcome = await exploreDfsBranches(
          harness,
          adaptiveBranchCount,
          valueThreshold,
          currentMessages,
          passOptions,
          allowedToolNames,
          failedApproachDescriptions,
          "[TreeOfThoughts]",
        );
        scoredBranches = dfsOutcome.scoredBranches;
        selectedBranch = dfsOutcome.selectedBranch;
      } else {
        const bfsOutcome = await exploreBfsBranches(
          harness,
          adaptiveBranchCount,
          currentMessages,
          passOptions,
          allowedToolNames,
          failedApproachDescriptions,
          "bfs",
          "[TreeOfThoughts]",
        );
        if (bfsOutcome.aborted) break;
        scoredBranches = bfsOutcome.scoredBranches;
        selectedBranch = bfsOutcome.selectedBranch;
        state.frontierCandidates = scoredBranches.slice(1, bfsBeamWidth).map((branch) => ({
          pass: branch.pass,
          score: branch.score,
          branchIndex: branch.branchIndex,
          criteriaScores: branch.criteriaScores,
        }));
      }

      state.selectedBranchScores.push(selectedBranch.score);
      state.finalStreamedText = selectedBranch.pass.finalStreamedText;
      state.streamedThinking = selectedBranch.pass.streamedThinking;

      emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.BRANCH_SELECTED,
        branchIndex: selectedBranch.branchIndex,
        score: selectedBranch.score,
        branchCount: adaptiveBranchCount,
        criteriaScores: selectedBranch.criteriaScores,
        searchStrategy,
        frontierSize: state.frontierCandidates.length,
        scores: scoredBranches.map((branch) => ({
          index: branch.branchIndex,
          score: branch.score,
          criteria: branch.criteriaScores,
        })),
      });

      if (
        handleProactiveToTBacktrack(
          selectedBranch,
          scoredBranches,
          valueThreshold,
          state,
          currentMessages,
          failedApproachDescriptions,
          options,
          emit,
        )
      ) {
        continue;
      }

      const selectedPass = selectedBranch.pass;
      finalizePassTracker(selectedPass, selectedPass.requestId || "");
      for (const branch of scoredBranches) {
        if (branch !== selectedBranch && branch.pass.requestId) {
          finalizePassTracker(branch.pass, branch.pass.requestId);
          harness.logIteration(branch.pass, currentMessages);
        }
      }

      logKVCacheHitRate(selectedPass.usage, state.iterations, "TreeOfThoughts");
      harness.emitGenerationProgress();
      harness.emitUsageUpdate();

      if (
        await checkCostBudget(state, context.resolvedModel, options.maxCostDollars, emit, context.conversationId, {
          signal: context.signal,
          pauseTimeoutMs: options.budgetPauseTimeoutMs,
        })
      ) {
        break;
      }

      if (selectedPass.pendingToolCalls.length > 0) {
        const toolTurn = await executeToTToolCalls(
          harness,
          selectedBranch,
          scoredBranches,
          currentMessages,
          hooks,
          searchStrategy,
          failedApproachDescriptions,
        );
        currentMessages = toolTurn.messages;
        if (toolTurn.clearedFailed) failedApproachDescriptions = [];
        if (toolTurn.planAborted) return { messages: currentMessages };
        continue;
      }

      const nonToolAction = handleToTNonToolPass(harness, selectedPass, currentMessages, truncationState);
      if (nonToolAction === "continue") continue;
      if (nonToolAction === "clean_break") hasCleanTextBreak = true;
      break;
    }

    if (!hasCleanTextBreak && state.streamedToolCalls.length > 0 && !signal?.aborted) {
      state.conversationOutcome = "exhausted";
      await runExhaustionRecoveryPass(harness, context, state, currentMessages);
    }

    logger.info(
      `[TreeOfThoughts] Session complete: ${state.iterations} iterations, ${state.branchesExplored} branches explored, ${state.branchesBacktracked} backtracked (${state.proactiveBacktracks} proactive), strategy: ${searchStrategy}`,
    );

    cleanupReminderCache(resolvedAgentConversationId);
    await harness["finalize"](currentMessages, hooks);
    return { messages: currentMessages };
  } catch (loopError: unknown) {
    return await handleToTLoopError(loopError, harness, currentMessages, hooks);
  }
}
