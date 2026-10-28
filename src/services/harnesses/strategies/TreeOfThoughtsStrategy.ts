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
 * See ThoughtStructureRegistry.ts → THOUGHT_STRUCTURE_DEFINITIONS
 * (id: "tree_of_thoughts") for full paper-alignment metadata.
 */
import type BaseAgenticHarness from "../BaseAgenticHarness.ts";
import type AgenticLoopState from "../../AgenticLoopState.ts";
import type {
  ConversationMessage,
  ToolCall,
  ToolSchema,
  ToolResult,
  AgenticOptions,
  PassState,
  BeforePromptHookContext,
  EmitFunction,
} from "../types.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  MAX_TOOL_ITERATIONS,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import logger from "../../../utils/logger.ts";
import PromptLocaleService from "../../PromptLocaleService.ts";
import { getErrorMessage } from "../../../utils/ErrorHelpers.ts";
import RequestLogger from "../../RequestLogger.ts";
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
import { createSandboxCheckpoint, restoreSandboxCheckpoint } from "../lifecycle/SandboxExecutor.ts";

interface IterationPassOptions extends AgenticOptions {
  project: string;
  agent?: string | null;
  username: string;
}

const MAX_CONSECUTIVE_TOOL_ERRORS = 3;
const DEFAULT_BRANCH_COUNT = 3;
const MAX_BACKTRACK_ATTEMPTS_PER_ITERATION = 2;
const DEFAULT_VALUE_THRESHOLD = 5.0;
const MAX_PROACTIVE_BACKTRACKS = 3;
const DEFAULT_BFS_BEAM_WIDTH = 2;

interface ScoredBranch {
  branchIndex: number;
  text: string;
  thinking: string;
  thinkingSignature: string;
  score: number;
  criteriaScores: CriteriaScores;
  pass: PassState;
}

interface CriteriaScores {
  correctness: number;
  risk: number;
  efficiency: number;
  completeness: number;
}

type SearchStrategy = "bfs" | "dfs";

const BRANCH_STRATEGY_DESCRIPTORS = [
  "",
  "Focus on a MINIMAL approach — use the fewest tools and smallest changes possible. " +
    "Prefer precision over coverage. Choose the simplest solution that could work.",
  "Focus on a THOROUGH approach — maximize correctness and safety. " +
    "Add validation, error handling, and defensive checks even if it means more steps.",
  "Focus on an ALTERNATIVE ARCHITECTURE — if branch 1 would modify code in place, " +
    "consider creating new files. If branch 1 would iterate, consider a batch approach. " +
    "Deliberately diverge from the obvious first solution.",
  "Focus on RISK MINIMIZATION — what approach has the lowest chance of breaking " +
    "existing functionality? Prefer reversible, incremental changes over large rewrites.",
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Public API — called by ReActHarness when thoughtStructure === "tree_of_thoughts"
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function resolveToTSearchConfig(options: AgenticOptions) {
  const searchStrategy: SearchStrategy = (options.searchStrategy as SearchStrategy) || "bfs";
  const initialBranchCount = Math.min(Math.max(1, options.branchCount || DEFAULT_BRANCH_COUNT), 5);
  const valueThreshold = options.valueThreshold ?? DEFAULT_VALUE_THRESHOLD;
  const bfsBeamWidth = Math.min(DEFAULT_BFS_BEAM_WIDTH, initialBranchCount);
  const clientMaxIterations = options.maxIterations;
  const resolvedMaxIterations =
    clientMaxIterations === 0
      ? Infinity
      : clientMaxIterations
        ? Math.min(100, Math.max(1, clientMaxIterations))
        : MAX_TOOL_ITERATIONS;
  return { searchStrategy, initialBranchCount, valueThreshold, bfsBeamWidth, resolvedMaxIterations };
}

async function runToTBeforePromptHook(
  harness: BaseAgenticHarness,
  currentMessages: ConversationMessage[],
  hooks: ReturnType<typeof createStandardHooks>["hooks"],
  resolvedAgentConversationId: string,
): Promise<void> {
  const context = harness["context"];
  const tools = harness["tools"];
  const { options, conversationId, traceId, project, username, agent, workspaceRoot, emit } = context;

  const hookContext: BeforePromptHookContext = {
    messages: currentMessages,
    project,
    username,
    agent,
    traceId,
    conversationId,
    agentConversationId: resolvedAgentConversationId,
    parentAgentConversationId: context.parentAgentConversationId,
    agentContext: options.agentContext,
    enabledTools: tools.resolvedEnabledTools,
    resolvedToolNames: tools.finalTools.map((tool: ToolSchema) => tool.name),
    workspaceRoot: workspaceRoot || undefined,
    workspaceEnabled: options.workspaceEnabled as boolean | undefined,
    locale: options.locale as string | undefined,
  };
  await hooks.run("beforePrompt", hookContext);

  if (hookContext._assembledSystemPrompt) {
    const assembledPrompt = hookContext._assembledSystemPrompt as string;
    context.conversationMeta = {
      ...(context.conversationMeta || {}),
      systemPrompt: assembledPrompt,
    };
    if (!options.systemPrompt) {
      options.systemPrompt = assembledPrompt;
    }
  }
  if (Array.isArray(hookContext._injectedSkills) && hookContext._injectedSkills.length > 0) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.SKILLS_INJECTED,
      skills: hookContext._injectedSkills,
    });
  }
}

async function exploreDfsBranches(
  harness: BaseAgenticHarness,
  adaptiveBranchCount: number,
  valueThreshold: number,
  currentMessages: ConversationMessage[],
  passOptions: IterationPassOptions,
  allowedToolNames: Set<string>,
  failedApproachDescriptions: string[],
): Promise<{ scoredBranches: ScoredBranch[]; selectedBranch: ScoredBranch }> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const { emit, signal } = context;

  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.BRANCHING_STARTED,
    branchCount: adaptiveBranchCount,
    iteration: state.iterations,
    searchStrategy: "dfs",
  });

  let acceptedBranch: ScoredBranch | null = null;
  const exploredSiblings: ScoredBranch[] = [];

  for (let siblingAttempt = 0; siblingAttempt < adaptiveBranchCount; siblingAttempt++) {
    if (signal?.aborted) break;
    const branch = await generateBranch(
      harness,
      siblingAttempt,
      adaptiveBranchCount,
      currentMessages,
      passOptions,
      allowedToolNames,
      failedApproachDescriptions,
    );
    state.branchesExplored++;

    const [scoredSibling] = await scoreBranchesMultiCriteria(harness, [branch], currentMessages);
    exploredSiblings.push(scoredSibling);

    if (scoredSibling.score >= valueThreshold) {
      acceptedBranch = scoredSibling;
      logger.info(
        `[TreeOfThoughts/DFS] Sibling ${siblingAttempt + 1}/${adaptiveBranchCount} accepted (score: ${scoredSibling.score.toFixed(1)} >= threshold: ${valueThreshold})`,
      );
      break;
    }

    state.branchesBacktracked++;
    failedApproachDescriptions.push((scoredSibling.text || scoredSibling.thinking || "").slice(0, 300));
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
      branchIndex: scoredSibling.branchIndex,
      reason: "dfs_sibling_pruned",
      score: scoredSibling.score,
      threshold: valueThreshold,
      siblingAttempt: siblingAttempt + 1,
      maxSiblings: adaptiveBranchCount,
    });
    logger.info(
      `[TreeOfThoughts/DFS] Sibling ${siblingAttempt + 1}/${adaptiveBranchCount} pruned (score: ${scoredSibling.score.toFixed(1)} < threshold: ${valueThreshold})`,
    );
  }

  exploredSiblings.sort((branchA, branchB) => branchB.score - branchA.score);
  if (!acceptedBranch) {
    acceptedBranch = exploredSiblings[0];
    logger.info(
      `[TreeOfThoughts/DFS] No sibling above threshold — accepting best available (score: ${acceptedBranch.score.toFixed(1)})`,
    );
  }
  return { scoredBranches: exploredSiblings, selectedBranch: acceptedBranch };
}

async function exploreBfsBranches(
  harness: BaseAgenticHarness,
  adaptiveBranchCount: number,
  bfsBeamWidth: number,
  currentMessages: ConversationMessage[],
  passOptions: IterationPassOptions,
  allowedToolNames: Set<string>,
  failedApproachDescriptions: string[],
): Promise<{ scoredBranches: ScoredBranch[]; selectedBranch: ScoredBranch; aborted: boolean }> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const { emit, signal } = context;

  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.BRANCHING_STARTED,
    branchCount: adaptiveBranchCount,
    iteration: state.iterations,
    searchStrategy: "bfs",
  });

  const branchResults = await Promise.all(
    Array.from({ length: adaptiveBranchCount }, (_, branchIndex) =>
      generateBranch(
        harness,
        branchIndex,
        adaptiveBranchCount,
        currentMessages,
        passOptions,
        allowedToolNames,
        failedApproachDescriptions,
      ),
    ),
  );

  if (signal?.aborted) {
    return { scoredBranches: [], selectedBranch: branchResults[0], aborted: true };
  }

  state.branchesExplored += adaptiveBranchCount;
  const scoredBranches = await scoreBranchesMultiCriteria(harness, branchResults, currentMessages);
  scoredBranches.sort((branchA, branchB) => branchB.score - branchA.score);
  const selectedBranch = scoredBranches[0];

  state.frontierCandidates = scoredBranches.slice(1, bfsBeamWidth).map((branch) => ({
    pass: branch.pass,
    score: branch.score,
    branchIndex: branch.branchIndex,
    criteriaScores: branch.criteriaScores,
  }));

  return { scoredBranches, selectedBranch, aborted: false };
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
  state.proactiveBacktracks++;
  state.branchesBacktracked++;

  const failedSummary = (selectedBranch.text || selectedBranch.thinking || "").slice(0, 300).trim();
  if (failedSummary) failedApproachDescriptions.push(failedSummary);

  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
    branchIndex: selectedBranch.branchIndex,
    reason: "proactive_value_threshold",
    bestScore: selectedBranch.score,
    threshold: valueThreshold,
    proactiveBacktracks: state.proactiveBacktracks,
    maxProactiveBacktracks: MAX_PROACTIVE_BACKTRACKS,
  });

  logger.info(
    `[TreeOfThoughts] Proactive backtrack — best score ${selectedBranch.score.toFixed(1)} < threshold ${valueThreshold}. Re-branching (${state.proactiveBacktracks}/${MAX_PROACTIVE_BACKTRACKS}).`,
  );

  currentMessages.push({
    role: "system",
    content: PromptLocaleService.get(
      (options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale(),
      "harness.treeOfThoughts.proactiveBacktrack",
      {
        branchCount: String(scoredBranches.length),
        bestScore: selectedBranch.score.toFixed(1),
        threshold: String(valueThreshold),
      },
    ),
  });
  return true;
}

function handleToTValidationFailure(
  harness: BaseAgenticHarness,
  selectedBranch: ScoredBranch,
  scoredBranches: ScoredBranch[],
  validationFeedback: Array<{ filePath: string; validatorType: string; rawOutput: string }>,
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
  const errorBlock = validationFeedback
    .map((feedback) => `### ${feedback.filePath} (${feedback.validatorType})\n${feedback.rawOutput}`)
    .join("\n\n");

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
  restoreSandboxCheckpoint(workspaceRoot, sandboxCheckpointReference, emit);

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
  if (sandboxCheckpointReference) {
    restoreSandboxCheckpoint(workspaceRoot, sandboxCheckpointReference, emit);
  }
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

  const assistantMessage: ConversationMessage = {
    role: "assistant",
    content: selectedPass.streamedText || "",
    ...(selectedPass.streamedThinking.trim() && {
      thinking: selectedPass.streamedThinking.trim(),
    }),
    ...(selectedPass.thinkingSignature && {
      thinkingSignature: selectedPass.thinkingSignature,
    }),
    toolCalls: selectedPass.pendingToolCalls.map((toolCall: ToolCall) => {
      const matchingResult = results.find((result) => result.id === toolCall.id);
      return {
        id: toolCall.id || null,
        responsesItemId: toolCall.responsesItemId || undefined,
        name: toolCall.name,
        args: toolCall.args,
        thoughtSignature: toolCall.thoughtSignature || undefined,
        reasoningItem: toolCall.reasoningItem || undefined,
        result: matchingResult ? matchingResult.result : null,
        durationMs: matchingResult?.durationMs,
      };
    }),
  };
  currentMessages.push(assistantMessage);

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

function parseToTMultiCriteriaScores(scoreResponseText: string, branches: ScoredBranch[]): void {
  const linePattern =
    /(\d+)\s*:\s*correctness\s*=\s*(\d+(?:\.\d+)?)\s*,\s*risk\s*=\s*(\d+(?:\.\d+)?)\s*,\s*efficiency\s*=\s*(\d+(?:\.\d+)?)\s*,\s*completeness\s*=\s*(\d+(?:\.\d+)?)/gi;
  let lineMatch: RegExpExecArray | null;
  while ((lineMatch = linePattern.exec(scoreResponseText)) !== null) {
    const candidateIndex = parseInt(lineMatch[1], 10) - 1;
    if (candidateIndex >= 0 && candidateIndex < branches.length) {
      const criteria: CriteriaScores = {
        correctness: Math.min(10, Math.max(0, parseFloat(lineMatch[2]))),
        risk: Math.min(10, Math.max(0, parseFloat(lineMatch[3]))),
        efficiency: Math.min(10, Math.max(0, parseFloat(lineMatch[4]))),
        completeness: Math.min(10, Math.max(0, parseFloat(lineMatch[5]))),
      };
      branches[candidateIndex].criteriaScores = criteria;
      branches[candidateIndex].score =
        criteria.correctness * 0.4 +
        criteria.risk * 0.25 +
        criteria.efficiency * 0.15 +
        criteria.completeness * 0.2;
    }
  }
}

function parseToTSimpleFallbackScores(scoreResponseText: string, branches: ScoredBranch[]): void {
  const hasMultiCriteriaScores = branches.some((branch) => branch.criteriaScores.correctness > 0);
  if (!hasMultiCriteriaScores) {
    const simpleScorePattern = /(\d+)\s*:\s*(\d+(?:\.\d+)?)/g;
    let simpleMatch: RegExpExecArray | null;
    while ((simpleMatch = simpleScorePattern.exec(scoreResponseText)) !== null) {
      const candidateIndex = parseInt(simpleMatch[1], 10) - 1;
      const candidateScore = parseFloat(simpleMatch[2]);
      if (candidateIndex >= 0 && candidateIndex < branches.length && candidateScore >= 0 && candidateScore <= 10) {
        branches[candidateIndex].score = candidateScore;
        branches[candidateIndex].criteriaScores = {
          correctness: candidateScore,
          risk: candidateScore,
          efficiency: candidateScore,
          completeness: candidateScore,
        };
      }
    }
  }
  for (const branch of branches) {
    if (branch.score === 0) {
      branch.score = 5;
      branch.criteriaScores = { correctness: 5, risk: 5, efficiency: 5, completeness: 5 };
    }
  }
}

async function executeToTToolCalls(
  harness: BaseAgenticHarness,
  selectedBranch: ScoredBranch,
  scoredBranches: ScoredBranch[],
  currentMessages: ConversationMessage[],
  hooks: ReturnType<typeof createStandardHooks>["hooks"],
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
  hooks: ReturnType<typeof createStandardHooks>["hooks"],
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

  if (options.planFirst) {
    emit({ type: SERVER_SENT_EVENT_TYPES.STATUS, message: STATUS_MESSAGES.PLAN_MODE_ENTERED });
  }

  await runToTBeforePromptHook(harness, currentMessages, hooks, resolvedAgentConversationId);

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
        );
        scoredBranches = dfsOutcome.scoredBranches;
        selectedBranch = dfsOutcome.selectedBranch;
      } else {
        const bfsOutcome = await exploreBfsBranches(
          harness,
          adaptiveBranchCount,
          bfsBeamWidth,
          currentMessages,
          passOptions,
          allowedToolNames,
          failedApproachDescriptions,
        );
        if (bfsOutcome.aborted) break;
        scoredBranches = bfsOutcome.scoredBranches;
        selectedBranch = bfsOutcome.selectedBranch;
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Branch generation with structured diversity
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function generateBranch(
  harness: BaseAgenticHarness,
  branchIndex: number,
  totalBranches: number,
  currentMessages: ConversationMessage[],
  passOptions: IterationPassOptions,
  allowedToolNames: Set<string>,
  failedApproaches: string[],
): Promise<ScoredBranch> {
  const state: AgenticLoopState = harness["state"];
  const context = harness["context"];

  const branchMessages = [...currentMessages];

  if (branchIndex > 0 || failedApproaches.length > 0) {
    const strategyDescriptor =
      BRANCH_STRATEGY_DESCRIPTORS[
        branchIndex % BRANCH_STRATEGY_DESCRIPTORS.length
      ] || BRANCH_STRATEGY_DESCRIPTORS[1];

    let diversityInstruction =
      `[BRANCH ${branchIndex + 1}/${totalBranches}] ` + strategyDescriptor;

    if (failedApproaches.length > 0) {
      const failedSummaries = failedApproaches
        .map((approach, index) => `  ${index + 1}. ${approach}`)
        .join("\n");
      diversityInstruction +=
        `\n\nThe following approach(es) have already been tried and FAILED:\n` +
        `${failedSummaries}\n` +
        `You MUST use a fundamentally different strategy.`;
    }

    branchMessages.push({
      role: "user",
      content: diversityInstruction,
    });
  }

  const pass = harness.createPassState(passOptions);
  const { agentConversationId } = context;
  const resolvedAgentConversationId = agentConversationId || "";
  const requestIdBase =
    context.requestId ||
    resolvedAgentConversationId ||
    crypto.randomUUID();
  const passRequestId = `${requestIdBase}-iter-${state.iterations}-branch-${branchIndex}`;
  pass.requestId = passRequestId;
  harness.registerTrackerRequest(passRequestId);

  const stream = await harness.createProviderStream(branchMessages, passOptions);
  await harness.consumeStream(stream, pass, allowedToolNames);

  return {
    branchIndex,
    text: pass.streamedText,
    thinking: pass.streamedThinking,
    thinkingSignature: pass.thinkingSignature,
    score: 0,
    criteriaScores: {
      correctness: 0,
      risk: 0,
      efficiency: 0,
      completeness: 0,
    },
    pass,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Multi-criteria scoring (§2.1.2)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function formatCandidateSummariesForToT(branches: ScoredBranch[]): string {
  return branches
    .map((branch, index) => {
      const textPreview = (branch.text || branch.thinking || "(no output)").slice(0, 500).trim();
      const toolCallCount = branch.pass.pendingToolCalls.length;
      const toolCallNames = branch.pass.pendingToolCalls.map((toolCall) => toolCall.name).join(", ");
      return (
        `[Candidate ${index + 1}] ` +
        `${toolCallCount} tool call(s)${toolCallNames ? ` (${toolCallNames})` : ""}.\n` +
        `Output: ${textPreview}`
      );
    })
    .join("\n\n");
}

async function scoreBranchesMultiCriteria(
  harness: BaseAgenticHarness,
  branches: ScoredBranch[],
  _currentMessages: ConversationMessage[],
): Promise<ScoredBranch[]> {
  if (branches.length <= 1) {
    if (branches[0]) {
      branches[0].score = 10;
      branches[0].criteriaScores = { correctness: 10, risk: 10, efficiency: 10, completeness: 10 };
    }
    return branches;
  }

  const context = harness["context"];

  try {
    const candidateSummaries = formatCandidateSummariesForToT(branches);
    const scoringPrompt = [
      "Rate each candidate approach on 4 criteria (1-10 each):",
      "- CORRECTNESS: Will this produce the right result?",
      "- RISK: How safe is this? (10=very safe, 1=destructive)",
      "- EFFICIENCY: Does it minimize unnecessary steps?",
      "- COMPLETENESS: Does it address all parts of the task?",
      "",
      "Respond ONLY in this exact format (one line per candidate):",
      "1: correctness=8, risk=7, efficiency=6, completeness=9",
      "2: correctness=5, risk=9, efficiency=8, completeness=4",
      "",
      candidateSummaries,
    ].join("\n");

    const scoringMessages = [{ role: "user" as const, content: scoringPrompt }];
    const scoringOptions = {
      maxTokens: 200,
      temperature: 0,
      signal: AbortSignal.timeout(15_000),
    };

    let scoreResponseText = "";
    const scoringRequestStartMs = performance.now();
    const scoringStream = context.provider.generateTextStream(
      scoringMessages,
      context.resolvedModel,
      scoringOptions,
    );

    for await (const chunk of scoringStream) {
      if (typeof chunk === "string") {
        scoreResponseText += chunk;
      }
    }

    RequestLogger.logBackgroundLlmCall({
      requestId: `${context.requestId || context.agentConversationId || "unknown"}-scoring-iter-${harness["state"].iterations}`,
      endpoint: "/agent",
      operation: "agent:scoring",
      project: context.project,
      username: context.username,
      agent: context.agent || null,
      provider: context.providerName,
      model: context.resolvedModel,
      traceId: context.traceId || null,
      agentConversationId: context.agentConversationId || null,
      aiMessages: scoringMessages as Parameters<typeof RequestLogger.logBackgroundLlmCall>[0]["aiMessages"],
      resultText: scoreResponseText,
      success: true,
      errorMessage: null,
      requestStartMs: scoringRequestStartMs,
    }).catch((scoringLogError: unknown) =>
      logger.error(`[TreeOfThoughts] Failed to log scoring request: ${getErrorMessage(scoringLogError)}`),
    );

    parseToTMultiCriteriaScores(scoreResponseText, branches);
    parseToTSimpleFallbackScores(scoreResponseText, branches);

    logger.info(
      `[TreeOfThoughts] Branch scores: ${branches.map((branch, index) => `${index + 1}:${branch.score.toFixed(1)}`).join(", ")}`,
    );
  } catch (scoringError: unknown) {
    logger.warn(`[TreeOfThoughts] Scoring failed: ${getErrorMessage(scoringError)}. Using equal scores.`);
    for (const branch of branches) {
      branch.score = 5;
      branch.criteriaScores = { correctness: 5, risk: 5, efficiency: 5, completeness: 5 };
    }
  }

  return branches;
}
