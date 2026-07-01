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
} from "../types.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  TOOL_NAMES,
  MAX_TOOL_ITERATIONS,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import logger from "../../../utils/logger.ts";
import PromptLocaleService from "../../PromptLocaleService.ts";
import { getErrorMessage } from "../../../utils/ErrorHelpers.ts";
import RequestLogger from "../../RequestLogger.ts";
import { createStandardHooks } from "../lifecycle/HookInitializer.ts";
import { executeToolBatch } from "../lifecycle/ToolExecutor.ts";
import { checkAndWaitForApproval } from "../lifecycle/ApprovalGate.ts";
import {
  emitPostExecutionStatus,
  processToolResultMedia,
  trackToolErrors,
} from "../lifecycle/PostExecutionEmitter.ts";
import { runExhaustionRecoveryPass } from "../lifecycle/ExhaustionRecovery.ts";
import {
  handleExitPlanMode,
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
import PlanningModeService from "../../PlanningModeService.ts";

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

export async function runTreeOfThoughts(
  harness: BaseAgenticHarness,
): Promise<{ messages: ConversationMessage[] }> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const tools = harness["tools"];
  const {
    options,
    conversationId,
    agentConversationId,
    traceId,
    project,
    username,
    agent,
    workspaceRoot,
    emit,
    signal,
  } = context;

  const resolvedAgentConversationId = agentConversationId || "";

  const searchStrategy: SearchStrategy =
    (options.searchStrategy as SearchStrategy) || "bfs";
  const initialBranchCount = Math.min(
    Math.max(1, options.branchCount || DEFAULT_BRANCH_COUNT),
    5,
  );
  const valueThreshold = options.valueThreshold ?? DEFAULT_VALUE_THRESHOLD;
  const bfsBeamWidth = Math.min(DEFAULT_BFS_BEAM_WIDTH, initialBranchCount);

  const clientMaxIterations = options.maxIterations;
  const resolvedMaxIterations =
    clientMaxIterations === 0
      ? Infinity
      : clientMaxIterations
        ? Math.min(100, Math.max(1, clientMaxIterations))
        : MAX_TOOL_ITERATIONS;

  let currentMessages: ConversationMessage[] = [...context.messages];
  let truncationRecoveryCount = 0;
  let hasCleanTextBreak = false;
  let failedApproachDescriptions: string[] = [];

  const { hooks, approvalEngine } = createStandardHooks({
    workspaceRoot: workspaceRoot || undefined,
    autoApprove: options.autoApprove === true,
    policies: options.policies,
    enableCriticGate: options.enableCriticGate === true,
    criticModel: options.criticModel || undefined,
  });

  if (options.planFirst) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.PLAN_MODE_ENTERED,
    });
  }

  // ── beforePrompt hook (once) ──────────────────────────
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
    resolvedToolNames: tools.finalTools.map(
      (tool: ToolSchema) => tool.name,
    ),
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

  if (
    Array.isArray(hookContext._injectedSkills) &&
    hookContext._injectedSkills.length > 0
  ) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.SKILLS_INJECTED,
      skills: hookContext._injectedSkills,
    });
  }

  // ── Pre-loop planning phase ─────────────────────────────
  if (state.planModeActive) {
    const { planApproved } = await runPlanningPhase(harness, currentMessages);
    if (!planApproved) return { messages: currentMessages };
  }

  // ── Main loop ────────────────────────────────────────────
  try {
    while (state.iterations < resolvedMaxIterations) {
      state.iterations++;

      const adaptiveBranchCount =
        searchStrategy === "dfs"
          ? initialBranchCount
          : state.iterations === 1
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

      // ── Instruction fade-out countermeasure ─────────────────
      await maybeInjectSystemReminder(
        currentMessages,
        state,
        context,
      );

      const passOptions: IterationPassOptions = {
        ...options,
        project,
        agent,
        username,
        tools: tools.finalTools,
      };

      // ── Context pressure management ──────────────────────────
      const pressureResult = await manageContextPressure(
        currentMessages,
        context,
        state,
        "TreeOfThoughts",
      );
      currentMessages = pressureResult.messages;

      // ── Context window enforcement ─────────────────────────
      currentMessages = harness.enforceContextWindow(
        currentMessages,
        tools.finalTools.length,
      );

      const allowedToolNames = new Set(
        tools.finalTools.map((tool: ToolSchema) => tool.name),
      );

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  PHASE 1+2: Generate, score, and select — strategy-aware
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      let scoredBranches: ScoredBranch[];
      let selectedBranch: ScoredBranch;

      if (searchStrategy === "dfs") {
        // ── True DFS: sequential sibling exploration (Paper Algorithm 2) ──
        // Generate one branch at a time, score it, accept if above
        // threshold. Try up to `initialBranchCount` siblings before
        // accepting the best available.
        emit({
          type: SERVER_SENT_EVENT_TYPES.STATUS,
          message: STATUS_MESSAGES.BRANCHING_STARTED,
          branchCount: adaptiveBranchCount,
          iteration: state.iterations,
          searchStrategy,
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

          const [scoredSibling] = await scoreBranchesMultiCriteria(
            harness,
            [branch],
            currentMessages,
          );
          exploredSiblings.push(scoredSibling);

          if (scoredSibling.score >= valueThreshold) {
            acceptedBranch = scoredSibling;
            logger.info(
              `[TreeOfThoughts/DFS] Sibling ${siblingAttempt + 1}/${adaptiveBranchCount} accepted ` +
                `(score: ${scoredSibling.score.toFixed(1)} >= threshold: ${valueThreshold})`,
            );
            break;
          }

          state.branchesBacktracked++;
          failedApproachDescriptions.push(
            (scoredSibling.text || scoredSibling.thinking || "").slice(0, 300),
          );

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
            `[TreeOfThoughts/DFS] Sibling ${siblingAttempt + 1}/${adaptiveBranchCount} pruned ` +
              `(score: ${scoredSibling.score.toFixed(1)} < threshold: ${valueThreshold})`,
          );
        }

        if (!acceptedBranch) {
          exploredSiblings.sort((branchA, branchB) => branchB.score - branchA.score);
          acceptedBranch = exploredSiblings[0];
          logger.info(
            `[TreeOfThoughts/DFS] No sibling above threshold — accepting best available ` +
              `(score: ${acceptedBranch.score.toFixed(1)})`,
          );
        }

        scoredBranches = exploredSiblings.sort((branchA, branchB) => branchB.score - branchA.score);
        selectedBranch = acceptedBranch;
      } else {
        // ── BFS: parallel generation + frontier retention (Paper Algorithm 1) ──
        emit({
          type: SERVER_SENT_EVENT_TYPES.STATUS,
          message: STATUS_MESSAGES.BRANCHING_STARTED,
          branchCount: adaptiveBranchCount,
          iteration: state.iterations,
          searchStrategy,
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

        if (signal?.aborted) break;

        state.branchesExplored += adaptiveBranchCount;

        scoredBranches = await scoreBranchesMultiCriteria(
          harness,
          branchResults,
          currentMessages,
        );

        scoredBranches.sort(
          (branchA, branchB) => branchB.score - branchA.score,
        );

        selectedBranch = scoredBranches[0];

        // ── Retain top-b candidates as frontier (Paper Algorithm 1: "b best states") ──
        state.frontierCandidates = scoredBranches
          .slice(1, bfsBeamWidth)
          .map((branch) => ({
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

      logger.info(
        `[TreeOfThoughts] Iteration ${state.iterations}: selected branch ${selectedBranch.branchIndex + 1}/${adaptiveBranchCount} ` +
          `(score: ${selectedBranch.score.toFixed(1)}, correctness: ${selectedBranch.criteriaScores.correctness}, ` +
          `risk: ${selectedBranch.criteriaScores.risk}, efficiency: ${selectedBranch.criteriaScores.efficiency}, ` +
          `completeness: ${selectedBranch.criteriaScores.completeness})`,
      );

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  PHASE 2.5: Proactive value-threshold pruning (Paper §2.1)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      if (
        selectedBranch.score < valueThreshold &&
        state.iterations > 1 &&
        state.proactiveBacktracks < MAX_PROACTIVE_BACKTRACKS
      ) {
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
          `[TreeOfThoughts] Proactive backtrack — best score ${selectedBranch.score.toFixed(1)} ` +
            `< threshold ${valueThreshold}. Re-branching (${state.proactiveBacktracks}/${MAX_PROACTIVE_BACKTRACKS}).`,
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

        continue;
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  PHASE 3: Execute selected branch with backtracking
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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

      // ── Cost budget enforcement ────────────────────────────
      if (checkCostBudget(state, context.resolvedModel, options.maxCostDollars, emit)) {
        break;
      }

      // ── Tool execution from selected branch ─────────────────
      if (selectedPass.pendingToolCalls.length > 0) {
        const preExecutionSnapshot = currentMessages.map((message) => ({
          ...message,
        }));

        const { isApproved, shouldApproveAll } =
          await checkAndWaitForApproval(
            selectedPass.pendingToolCalls,
            context,
            approvalEngine,
          );

        let results: ToolResult[] = [];
        let sandboxCheckpointReference: string | null = null;
        if (!isApproved) {
          results = selectedPass.pendingToolCalls.map((toolCall) => ({
            name: toolCall.name,
            id: toolCall.id,
            result: {
              success: false,
              error: "USER_REJECTED",
              message: "Tool execution was manually rejected by the user.",
            },
          }));
        } else {
          if (shouldApproveAll) {
            options.autoApprove = true;
          }

          context._currentMessages = currentMessages;

          // ── Sandbox checkpoint (git-based rollback) ────────────
          sandboxCheckpointReference = options.enableSandbox
            ? createSandboxCheckpoint(workspaceRoot, emit)
            : null;

          results = await executeToolBatch(
            selectedPass.pendingToolCalls,
            context,
            tools,
            hooks,
            state,
          );
        }

        // ── Post-execution processing ─────────────────────────
        await processToolResultMedia(
          selectedPass.pendingToolCalls,
          results,
          state,
          selectedPass,
          emit,
          context,
        );

        trackToolErrors(
          selectedPass.pendingToolCalls,
          results,
          state,
          MAX_CONSECUTIVE_TOOL_ERRORS,
          emit,
        );

        emitPostExecutionStatus(selectedPass.pendingToolCalls, emit);

        // ── Validation + reflexion-based backtracking ──────────
        const validationFeedback = await validateAfterToolExecution(
          selectedPass.pendingToolCalls,
          results,
          context,
          state,
        );

        if (validationFeedback.length > 0) {
          state.branchesBacktracked++;

          const errorBlock = validationFeedback
            .map(
              (feedback) =>
                `### ${feedback.filePath} (${feedback.validatorType})\n${feedback.rawOutput}`,
            )
            .join("\n\n");

          const failedApproachSummary = (
            selectedPass.streamedText ||
            selectedPass.streamedThinking ||
            ""
          )
            .slice(0, 300)
            .trim();
          if (failedApproachSummary) {
            failedApproachDescriptions.push(failedApproachSummary);
          }

          const backtrackAttemptsThisIteration = state.branchesBacktracked;

          // ── BFS frontier fallback (Paper Algorithm 1: try next-best state) ──
          // Before re-branching from scratch, try the next frontier candidate
          // that was already scored but not executed.
          if (
            searchStrategy === "bfs" &&
            state.frontierCandidates.length > 0 &&
            sandboxCheckpointReference
          ) {
            const fallbackCandidate = state.frontierCandidates.shift()!;

            currentMessages = preExecutionSnapshot;
            restoreSandboxCheckpoint(workspaceRoot, sandboxCheckpointReference, emit);

            emit({
              type: SERVER_SENT_EVENT_TYPES.STATUS,
              message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
              branchIndex: selectedBranch.branchIndex,
              validationErrors: validationFeedback.length,
              restoredCheckpoint: true,
              reason: "frontier_fallback",
              fallbackBranchIndex: fallbackCandidate.branchIndex,
              fallbackScore: fallbackCandidate.score,
            });

            logger.info(
              `[TreeOfThoughts/BFS] Branch ${selectedBranch.branchIndex + 1} failed validation. ` +
                `Falling back to frontier candidate ${fallbackCandidate.branchIndex + 1} ` +
                `(score: ${fallbackCandidate.score.toFixed(1)}).`,
            );

            currentMessages.push({
              role: "system",
              content: PromptLocaleService.get(
                (options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale(),
                "harness.treeOfThoughts.frontierFallback",
                {
                  branchIndex: String(selectedBranch.branchIndex + 1),
                  errorCount: String(validationFeedback.length),
                  errorBlock,
                },
              ),
            });

            // Re-enter the main execution path with the fallback candidate's pass
            // by replacing the selected branch and re-executing the tool phase
            // on the next iteration with the fallback's tool calls.
            harness.logIteration(selectedPass, currentMessages);

            // Inject the fallback branch's reasoning as context for the next iteration
            if (fallbackCandidate.pass.streamedText) {
              currentMessages.push({
                role: "assistant",
                content: fallbackCandidate.pass.streamedText,
                ...(fallbackCandidate.pass.streamedThinking.trim() && {
                  thinking: fallbackCandidate.pass.streamedThinking.trim(),
                }),
              });
            }

            continue;
          }

          const shouldRestoreCheckpoint =
            backtrackAttemptsThisIteration <=
              MAX_BACKTRACK_ATTEMPTS_PER_ITERATION &&
            scoredBranches.length > 1;

          if (shouldRestoreCheckpoint) {
            currentMessages = preExecutionSnapshot;

            // Restore filesystem to pre-execution state alongside conversation
            if (sandboxCheckpointReference) {
              restoreSandboxCheckpoint(workspaceRoot, sandboxCheckpointReference, emit);
            }

            emit({
              type: SERVER_SENT_EVENT_TYPES.STATUS,
              message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
              branchIndex: selectedBranch.branchIndex,
              validationErrors: validationFeedback.length,
              restoredCheckpoint: true,
            });

            logger.info(
              `[TreeOfThoughts] Branch ${selectedBranch.branchIndex + 1} failed validation. ` +
                `Restored checkpoint. Injecting reflexion prompt for self-correction.`,
            );

            currentMessages.push({
              role: "system",
              content: PromptLocaleService.get(
                (options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale(),
                "harness.treeOfThoughts.reflexion",
                {
                  branchIndex: String(selectedBranch.branchIndex + 1),
                  errorCount: String(validationFeedback.length),
                  errorBlock,
                },
              ),
            });
          } else {
            emit({
              type: SERVER_SENT_EVENT_TYPES.STATUS,
              message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
              branchIndex: selectedBranch.branchIndex,
              validationErrors: validationFeedback.length,
              restoredCheckpoint: false,
            });

            currentMessages.push({
              role: "assistant",
              content: selectedPass.streamedText || "",
              ...(selectedPass.streamedThinking.trim() && {
                thinking: selectedPass.streamedThinking.trim(),
              }),
              toolCalls: selectedPass.pendingToolCalls.map(
                (toolCall: ToolCall) => {
                  const matchingResult = results.find(
                    (result) => result.id === toolCall.id,
                  );
                  return {
                    id: toolCall.id || null,
                    name: toolCall.name,
                    args: toolCall.args,
                    result: matchingResult ? matchingResult.result : null,
                    durationMs: matchingResult?.durationMs,
                  };
                },
              ),
            });

            currentMessages.push({
              role: "system",
              content: PromptLocaleService.get(
                (options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale(),
                "harness.treeOfThoughts.budgetExhausted",
                { errorBlock },
              ),
            });
          }

          harness.logIteration(selectedPass, currentMessages);
          continue;
        }

        // ── No validation errors — commit this branch ──────────

        harness.logIteration(selectedPass, currentMessages);

        failedApproachDescriptions = [];

        await checkForPlanModeEntry(
          selectedPass.pendingToolCalls,
          currentMessages,
          state,
          emit,
          options?.locale as string | undefined,
        );

        if (state.planModeActive) {
          const { planApproved } = await runPlanningPhase(harness, currentMessages);
          if (!planApproved) return { messages: currentMessages };
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
          toolCalls: selectedPass.pendingToolCalls.map(
            (toolCall: ToolCall) => {
              const matchingResult = results.find(
                (result) => result.id === toolCall.id,
              );
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
            },
          ),
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

        currentMessages = currentMessages.filter(
          (message) =>
            !(
              message.role === "assistant" &&
              !message.content?.trim() &&
              (!message.toolCalls || message.toolCalls.length === 0)
            ),
        );

        injectToolDiscoveryNudge(
          selectedPass.pendingToolCalls,
          results,
          currentMessages,
          context,
        );

        harness.checkAndApplyToolSetChanges(currentMessages);

        continue;
      }

      // ── No tools — final text response ──────────────────────
      // Text present → clean text break. Thinking-only → continuation.
      if (selectedPass.streamedText) {
        const codexResult = handleCodexPlanningResponse(
          selectedPass,
          currentMessages,
          context,
          state,
          tools.finalTools,
          "TreeOfThoughts",
        );
        if (codexResult.shouldContinueLoop) {
          harness.logIteration(selectedPass, currentMessages);
          continue;
        }

        harness.logIteration(selectedPass, currentMessages);
        hasCleanTextBreak = true;
        break;
      }

      if (!selectedPass.streamedText && (!selectedPass.pendingToolCalls || !selectedPass.pendingToolCalls.length) && selectedPass.streamedThinking.trim()) {
        logger.warn(
          `[TreeOfThoughts] Thinking-only response on iteration ${state.iterations} — ` +
            `thinking=${selectedPass.streamedThinking.length}chars, text=0. ` +
            `Injecting continuation prompt.`,
        );

        currentMessages.push({
          role: "assistant",
          content: "",
          thinking: selectedPass.streamedThinking.trim(),
          ...(selectedPass.thinkingSignature && {
            thinkingSignature: selectedPass.thinkingSignature,
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

        harness.logIteration(selectedPass, currentMessages);
        continue;
      }

      // ── Empty output — check for truncation recovery ─────────
      if (isOutputTruncated(selectedPass)) {
        truncationRecoveryCount++;
        const configuredMaxTokens = context.options.maxTokens || "default";
        const modelOutputCeiling = context.modelDefinition?.maxOutputTokens as number | undefined;
        logger.warn(
          `[TreeOfThoughts] Max tokens truncation detected on iteration ${state.iterations} — ` +
            `Recovery attempt ${truncationRecoveryCount}/${MAX_OUTPUT_TRUNCATION_RECOVERIES}.`,
        );

        const alreadyAtCeiling = typeof configuredMaxTokens === "number" &&
          isAtOutputCeiling(configuredMaxTokens, modelOutputCeiling);

        if (!alreadyAtCeiling && truncationRecoveryCount <= MAX_OUTPUT_TRUNCATION_RECOVERIES) {
          const escalatedMaxTokens = injectContinuationContext(
            currentMessages,
            selectedPass,
            context,
            truncationRecoveryCount,
          );
          context.options.maxTokens = escalatedMaxTokens;
          harness.logIteration(selectedPass, currentMessages);
          continue;
        }

        if (alreadyAtCeiling) {
          logger.warn(
            `[TreeOfThoughts] Skipping truncation recovery — maxTokens (${configuredMaxTokens}) ` +
              `is already at or above model ceiling (${modelOutputCeiling}). Escalation would be pointless.`,
          );
        }
        const exhaustionMessage = buildExhaustedRecoveryMessage(
          alreadyAtCeiling ? 0 : MAX_OUTPUT_TRUNCATION_RECOVERIES,
          configuredMaxTokens,
          options?.locale as string | undefined,
        );
        injectErrorAsConversationMessage(
          currentMessages,
          exhaustionMessage,
          context,
        );
        harness.logIteration(selectedPass, currentMessages);
        break;
      }

      logger.warn(
        `[TreeOfThoughts] Empty model output on iteration ${state.iterations}. Breaking.`,
      );
      harness.logIteration(selectedPass, currentMessages);
      break;
    }

    // ── Exhaustion Recovery Pass ─────────────────────────────
    if (
      !hasCleanTextBreak &&
      state.streamedToolCalls.length > 0 &&
      !signal?.aborted
    ) {
      state.conversationOutcome = "exhausted";
      await runExhaustionRecoveryPass(harness, context, state, currentMessages);
    }

    // ── Finalization ──────────────────────────────────────────
    logger.info(
      `[TreeOfThoughts] Session complete: ${state.iterations} iterations, ` +
        `${state.branchesExplored} branches explored, ` +
        `${state.branchesBacktracked} backtracked (${state.proactiveBacktracks} proactive), ` +
        `strategy: ${searchStrategy}`,
    );

    cleanupReminderCache(resolvedAgentConversationId);
    await harness["finalize"](currentMessages, hooks);
    return { messages: currentMessages };
  } catch (loopError: unknown) {
    logger.error(
      `[TreeOfThoughts] Loop error on iteration ${state.iterations}: ${loopError instanceof Error ? loopError.message : String(loopError)}. Persisting ${currentMessages.length - state.originalMessageCount} accumulated message(s).`,
    );

    injectErrorAsConversationMessage(
      currentMessages,
      buildProviderErrorMessage(loopError, state.iterations, options?.locale as string | undefined),
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

  const stream = harness.createProviderStream(branchMessages, passOptions);
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
//  Pre-loop planning phase
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function runPlanningPhase(
  harness: BaseAgenticHarness,
  currentMessages: ConversationMessage[],
): Promise<{ planApproved: boolean }> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const tools = harness["tools"];
  const { options, project, agent, username, signal } = context;

  const MAX_PLANNING_ITERATIONS = 10;

  await PlanningModeService.injectPlanningInstruction(currentMessages);

  const planModeTools = tools.finalTools.filter(
    (tool: ToolSchema) => tool.name === TOOL_NAMES.EXIT_PLAN_MODE,
  );
  const allowedPlanToolNames = new Set(
    planModeTools.map((tool: ToolSchema) => tool.name),
  );
  const planPassOptions: IterationPassOptions = {
    ...options,
    project,
    agent,
    username,
    tools: planModeTools,
  };

  logger.info(
    `[TreeOfThoughts] Planning phase started — model will plan before full branching.`,
  );

  let planningIteration = 0;
  while (planningIteration < MAX_PLANNING_ITERATIONS) {
    planningIteration++;

    if (signal?.aborted) return { planApproved: false };

    const pass = harness.createPassState(planPassOptions);
    const requestIdBase =
      context.requestId || context.agentConversationId || crypto.randomUUID();
    const passRequestId = `${requestIdBase}-plan-${planningIteration}`;
    pass.requestId = passRequestId;
    harness.registerTrackerRequest(passRequestId);

    const stream = harness.createProviderStream(currentMessages, planPassOptions);
    await harness.consumeStream(stream, pass, allowedPlanToolNames);

    finalizePassTracker(pass, passRequestId);
    harness.logIteration(pass, currentMessages);
    harness.emitGenerationProgress();
    harness.emitUsageUpdate();

    if (signal?.aborted) return { planApproved: false };

    const exitPlanToolCall = pass.pendingToolCalls.find(
      (toolCall) => toolCall.name === TOOL_NAMES.EXIT_PLAN_MODE,
    );

    if (exitPlanToolCall) {
      const results: ToolResult[] = [
        {
          name: exitPlanToolCall.name,
          id: exitPlanToolCall.id || "",
          result: {},
        },
      ];

      const { shouldContinueLoop } = await handleExitPlanMode(
        exitPlanToolCall,
        pass,
        results,
        currentMessages,
        context,
        state,
      );

      if (!shouldContinueLoop) return { planApproved: false };

      currentMessages.push({
        role: "assistant",
        content: pass.streamedText || "",
        ...(pass.streamedThinking.trim() && {
          thinking: pass.streamedThinking.trim(),
        }),
        ...(pass.thinkingSignature && {
          thinkingSignature: pass.thinkingSignature,
        }),
        toolCalls: [
          {
            id: exitPlanToolCall.id || null,
            name: exitPlanToolCall.name,
            args: exitPlanToolCall.args,
            result: results[0].result,
          },
        ],
      });

      logger.info(
        `[TreeOfThoughts] Plan approved — entering full branching loop with ${tools.finalTools.length} tool(s).`,
      );
      return { planApproved: true };
    }

    const unauthorizedCalls = pass.pendingToolCalls.filter(
      (toolCall) => toolCall.name !== TOOL_NAMES.EXIT_PLAN_MODE,
    );
    if (unauthorizedCalls.length > 0) {
      const blockedNames = unauthorizedCalls
        .map((toolCall) => toolCall.name)
        .join(", ");
      logger.warn(
        `[TreeOfThoughts] Planning phase: blocked ${unauthorizedCalls.length} unauthorized tool call(s): [${blockedNames}]`,
      );
      if (pass.streamedText) {
        currentMessages.push({
          role: "assistant",
          content: pass.streamedText,
          ...(pass.streamedThinking.trim() && {
            thinking: pass.streamedThinking.trim(),
          }),
          ...(pass.thinkingSignature && {
            thinkingSignature: pass.thinkingSignature,
          }),
        });
      }
      currentMessages.push({
        role: "system",
        content: PromptLocaleService.get((options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale(), "harness.planningMode.blocked", { blockedNames }),
      });
      continue;
    }

    if (pass.streamedText || pass.streamedThinking.trim()) {
      currentMessages.push({
        role: "assistant",
        content: pass.streamedText,
        ...(pass.streamedThinking.trim() && {
          thinking: pass.streamedThinking.trim(),
        }),
        ...(pass.thinkingSignature && {
          thinkingSignature: pass.thinkingSignature,
        }),
      });
      continue;
    }

    logger.warn(
      `[TreeOfThoughts] Planning phase iteration ${planningIteration}: empty output. Aborting planning phase.`,
    );
    return { planApproved: false };
  }

  logger.warn(
    `[TreeOfThoughts] Planning phase exhausted ${MAX_PLANNING_ITERATIONS} iterations without exit_plan_mode call.`,
  );
  return { planApproved: false };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Multi-criteria scoring (§2.1.2)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function scoreBranchesMultiCriteria(
  harness: BaseAgenticHarness,
  branches: ScoredBranch[],
  _currentMessages: ConversationMessage[],
): Promise<ScoredBranch[]> {
  if (branches.length <= 1) {
    if (branches[0]) {
      branches[0].score = 10;
      branches[0].criteriaScores = {
        correctness: 10,
        risk: 10,
        efficiency: 10,
        completeness: 10,
      };
    }
    return branches;
  }

  const context = harness["context"];

  try {
    const candidateSummaries = branches
      .map((branch, index) => {
        const textPreview = (branch.text || branch.thinking || "(no output)")
          .slice(0, 500)
          .trim();
        const toolCallCount = branch.pass.pendingToolCalls.length;
        const toolCallNames = branch.pass.pendingToolCalls
          .map((toolCall) => toolCall.name)
          .join(", ");
        return (
          `[Candidate ${index + 1}] ` +
          `${toolCallCount} tool call(s)${toolCallNames ? ` (${toolCallNames})` : ""}.\n` +
          `Output: ${textPreview}`
        );
      })
      .join("\n\n");

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

    const scoringMessages = [
      { role: "user" as const, content: scoringPrompt },
    ];

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
      logger.error(
        `[TreeOfThoughts] Failed to log scoring request: ${getErrorMessage(scoringLogError)}`,
      ),
    );

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

    const hasMultiCriteriaScores = branches.some(
      (branch) => branch.criteriaScores.correctness > 0,
    );
    if (!hasMultiCriteriaScores) {
      const simpleScorePattern = /(\d+)\s*:\s*(\d+(?:\.\d+)?)/g;
      let simpleMatch: RegExpExecArray | null;
      while (
        (simpleMatch = simpleScorePattern.exec(scoreResponseText)) !== null
      ) {
        const candidateIndex = parseInt(simpleMatch[1], 10) - 1;
        const candidateScore = parseFloat(simpleMatch[2]);
        if (
          candidateIndex >= 0 &&
          candidateIndex < branches.length &&
          candidateScore >= 0 &&
          candidateScore <= 10
        ) {
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
        branch.criteriaScores = {
          correctness: 5,
          risk: 5,
          efficiency: 5,
          completeness: 5,
        };
      }
    }

    logger.info(
      `[TreeOfThoughts] Branch scores: ${branches.map((branch, index) => `${index + 1}:${branch.score.toFixed(1)}`).join(", ")}`,
    );
  } catch (scoringError: unknown) {
    logger.warn(
      `[TreeOfThoughts] Scoring failed: ${getErrorMessage(scoringError)}. Using equal scores.`,
    );
    for (const branch of branches) {
      branch.score = 5;
      branch.criteriaScores = {
        correctness: 5,
        risk: 5,
        efficiency: 5,
        completeness: 5,
      };
    }
  }

  return branches;
}
