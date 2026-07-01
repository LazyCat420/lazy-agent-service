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
 * See ThoughtStructureRegistry.ts → THOUGHT_STRUCTURE_DEFINITIONS
 * (id: "graph_of_thoughts") for full paper-alignment metadata.
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
const DEFAULT_VALUE_THRESHOLD = 5.0;
const MAX_PROACTIVE_BACKTRACKS = 3;

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
//  Public API — called by ReActHarness when thoughtStructure === "graph_of_thoughts"
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function runGraphOfThoughts(
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

  const initialBranchCount = Math.min(
    Math.max(1, options.branchCount || DEFAULT_BRANCH_COUNT),
    5,
  );
  const valueThreshold = options.valueThreshold ?? DEFAULT_VALUE_THRESHOLD;

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
        state.iterations === 1
          ? initialBranchCount
          : Math.max(2, Math.ceil(initialBranchCount * 0.6));

      emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.ITERATION_PROGRESS,
        iteration: state.iterations,
        maxIterations: resolvedMaxIterations,
        harness: "graph_of_thoughts",
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
        "GraphOfThoughts",
      );
      currentMessages = pressureResult.messages;

      // ── Context window enforcement ─────────────────────────
      currentMessages = harness.enforceContextWindow(
        currentMessages,
        tools.finalTools.length,
      );

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  PHASE 1: Generate candidate branches
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.BRANCHING_STARTED,
        branchCount: adaptiveBranchCount,
        iteration: state.iterations,
      });

      const allowedToolNames = new Set(
        tools.finalTools.map((tool: ToolSchema) => tool.name),
      );

      const branchResults = await Promise.all(
        Array.from({ length: adaptiveBranchCount }, (_, branchIndex) =>
          generateBranch(
            harness,
            branchIndex,
            adaptiveBranchCount,
            currentMessages,
            passOptions,
            allowedToolNames,
          ),
        ),
      );

      if (signal?.aborted) break;

      state.branchesExplored += adaptiveBranchCount;

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  PHASE 2: Multi-criteria score branches
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      const scoredBranches = await scoreBranchesMultiCriteria(
        harness,
        branchResults,
        currentMessages,
      );

      scoredBranches.sort(
        (branchA, branchB) => branchB.score - branchA.score,
      );

      state.selectedBranchScores.push(scoredBranches[0]?.score ?? 0);

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

      logger.info(
        `[GraphOfThoughts] Iteration ${state.iterations}: scored ${adaptiveBranchCount} branches — ` +
          `scores: [${scoredBranches.map((branch) => branch.score.toFixed(1)).join(", ")}]`,
      );

      // ── Proactive value-threshold pruning & filtering ──
      const activeBranches = scoredBranches.filter(
        (branch) => branch.score >= valueThreshold,
      );

      if (
        activeBranches.length === 0 &&
        state.iterations > 1 &&
        state.proactiveBacktracks < MAX_PROACTIVE_BACKTRACKS
      ) {
        state.proactiveBacktracks++;
        state.branchesBacktracked++;

        emit({
          type: SERVER_SENT_EVENT_TYPES.STATUS,
          message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
          branchIndex: -1,
          reason: "proactive_value_threshold",
          bestScore: scoredBranches[0]?.score ?? 0,
          threshold: valueThreshold,
          proactiveBacktracks: state.proactiveBacktracks,
          maxProactiveBacktracks: MAX_PROACTIVE_BACKTRACKS,
        });

        logger.info(
          `[GraphOfThoughts] Proactive backtrack — best score ${(scoredBranches[0]?.score ?? 0).toFixed(1)} ` +
            `< threshold ${valueThreshold}. Re-branching (${state.proactiveBacktracks}/${MAX_PROACTIVE_BACKTRACKS}).`,
        );

        currentMessages.push({
          role: "system",
          content: PromptLocaleService.get(
            (options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale(),
            "harness.graphOfThoughts.proactiveBacktrack",
            {
              bestScore: (scoredBranches[0]?.score ?? 0).toFixed(1),
              threshold: String(valueThreshold),
            },
          ),
        });

        continue;
      }

      const branchesToSynthesize = activeBranches.length > 0
        ? activeBranches
        : [scoredBranches[0]];

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  PHASE 3: Synthesize branches into merged output
      //  (GoT differentiator — aggregation instead of pick-winner)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      const synthesizedPass = await synthesizeBranches(
        harness,
        branchesToSynthesize,
        currentMessages,
        passOptions,
        allowedToolNames,
      );

      if (signal?.aborted) break;

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

      // ── Cost budget enforcement ────────────────────────────
      if (checkCostBudget(state, context.resolvedModel, options.maxCostDollars, emit)) {
        break;
      }

      // ── Tool execution from synthesized output ──────────────
      if (synthesizedPass.pendingToolCalls.length > 0) {
        const { isApproved, shouldApproveAll } =
          await checkAndWaitForApproval(
            synthesizedPass.pendingToolCalls,
            context,
            approvalEngine,
          );

        let results: ToolResult[] = [];
        let sandboxCheckpointReference: string | null = null;
        if (!isApproved) {
          results = synthesizedPass.pendingToolCalls.map((toolCall) => ({
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
            synthesizedPass.pendingToolCalls,
            context,
            tools,
            hooks,
            state,
          );
        }

        // ── Post-execution processing ─────────────────────────
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

        // ── Validation ──────────────────────────────────────────
        const validationFeedback = await validateAfterToolExecution(
          synthesizedPass.pendingToolCalls,
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

          // Restore sandbox checkpoint on validation failure
          if (sandboxCheckpointReference) {
            restoreSandboxCheckpoint(workspaceRoot, sandboxCheckpointReference, emit);
          }

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
          continue;
        }

        // ── No validation errors — commit ──────────────────────
        harness.logIteration(synthesizedPass, currentMessages);

        await checkForPlanModeEntry(
          synthesizedPass.pendingToolCalls,
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
          content: synthesizedPass.streamedText || "",
          ...(synthesizedPass.streamedThinking.trim() && {
            thinking: synthesizedPass.streamedThinking.trim(),
          }),
          ...(synthesizedPass.thinkingSignature && {
            thinkingSignature: synthesizedPass.thinkingSignature,
          }),
          toolCalls: synthesizedPass.pendingToolCalls.map(
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
          synthesizedPass.pendingToolCalls,
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
          synthesizedPass.pendingToolCalls,
          results,
          currentMessages,
          context,
        );

        harness.checkAndApplyToolSetChanges(currentMessages);

        continue;
      }

      // ── No tools — final text response ──────────────────────
      // Text present → clean text break. Thinking-only → continuation.
      if (synthesizedPass.streamedText) {
        const codexResult = handleCodexPlanningResponse(
          synthesizedPass,
          currentMessages,
          context,
          state,
          tools.finalTools,
          "GraphOfThoughts",
        );
        if (codexResult.shouldContinueLoop) {
          harness.logIteration(synthesizedPass, currentMessages);
          continue;
        }

        harness.logIteration(synthesizedPass, currentMessages);
        hasCleanTextBreak = true;
        break;
      }

      if (!synthesizedPass.streamedText && (!synthesizedPass.pendingToolCalls || !synthesizedPass.pendingToolCalls.length) && synthesizedPass.streamedThinking.trim()) {
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
        continue;
      }

      // ── Empty output — check for truncation recovery ─────────
      if (isOutputTruncated(synthesizedPass)) {
        truncationRecoveryCount++;
        const configuredMaxTokens = context.options.maxTokens || "default";
        const modelOutputCeiling = context.modelDefinition?.maxOutputTokens as number | undefined;
        logger.warn(
          `[GraphOfThoughts] Max tokens truncation detected on iteration ${state.iterations} — ` +
            `Recovery attempt ${truncationRecoveryCount}/${MAX_OUTPUT_TRUNCATION_RECOVERIES}.`,
        );

        const alreadyAtCeiling = typeof configuredMaxTokens === "number" &&
          isAtOutputCeiling(configuredMaxTokens, modelOutputCeiling);

        if (!alreadyAtCeiling && truncationRecoveryCount <= MAX_OUTPUT_TRUNCATION_RECOVERIES) {
          const escalatedMaxTokens = injectContinuationContext(
            currentMessages,
            synthesizedPass,
            context,
            truncationRecoveryCount,
          );
          context.options.maxTokens = escalatedMaxTokens;
          harness.logIteration(synthesizedPass, currentMessages);
          continue;
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
          options?.locale as string | undefined,
        );
        injectErrorAsConversationMessage(
          currentMessages,
          exhaustionMessage,
          context,
        );
        harness.logIteration(synthesizedPass, currentMessages);
        break;
      }

      logger.warn(
        `[GraphOfThoughts] Empty model output on iteration ${state.iterations}. Breaking.`,
      );
      harness.logIteration(synthesizedPass, currentMessages);
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
      `[GraphOfThoughts] Session complete: ${state.iterations} iterations, ` +
        `${state.branchesExplored} branches explored, ` +
        `${state.branchesBacktracked} backtracked`,
    );

    cleanupReminderCache(resolvedAgentConversationId);
    await harness["finalize"](currentMessages, hooks);
    return { messages: currentMessages };
  } catch (loopError: unknown) {
    logger.error(
      `[GraphOfThoughts] Loop error on iteration ${state.iterations}: ${loopError instanceof Error ? loopError.message : String(loopError)}. Persisting ${currentMessages.length - state.originalMessageCount} accumulated message(s).`,
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
        `[GraphOfThoughts] Failed to persist messages on error path: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
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
): Promise<ScoredBranch> {
  const state: AgenticLoopState = harness["state"];
  const context = harness["context"];

  const branchMessages = [...currentMessages];

  if (branchIndex > 0) {
    const strategyDescriptor =
      BRANCH_STRATEGY_DESCRIPTORS[
        branchIndex % BRANCH_STRATEGY_DESCRIPTORS.length
      ] || BRANCH_STRATEGY_DESCRIPTORS[1];

    const diversityInstruction =
      `[BRANCH ${branchIndex + 1}/${totalBranches}] ` + strategyDescriptor;

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
    logger.info(
      `[GraphOfThoughts] Single branch — skipping synthesis, using directly.`,
    );
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

  const synthesisMessages = [
    ...currentMessages,
    synthesisInstruction,
  ];

  emit({
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
  const requestIdBase =
    context.requestId ||
    resolvedAgentConversationId ||
    crypto.randomUUID();
  const passRequestId = `${requestIdBase}-iter-${state.iterations}-synthesis`;
  synthesisPass.requestId = passRequestId;
  harness.registerTrackerRequest(passRequestId);

  const synthesisStream = harness.createProviderStream(synthesisMessages, passOptions);
  await harness.consumeStream(synthesisStream, synthesisPass, allowedToolNames);

  logger.info(
    `[GraphOfThoughts] Synthesis complete — ` +
      `${synthesisPass.pendingToolCalls.length} tool call(s), ` +
      `${(synthesisPass.streamedText || "").length} chars text output.`,
  );

  return synthesisPass;

  // Note: `emit` is captured from the outer `context` closure
  function emit(event: { type: string; [key: string]: unknown }) {
    context.emit(event);
  }
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
    `[GraphOfThoughts] Planning phase started — model will plan before branching.`,
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
        `[GraphOfThoughts] Plan approved — entering branching + synthesis loop.`,
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
        `[GraphOfThoughts] Planning phase: blocked ${unauthorizedCalls.length} unauthorized tool call(s): [${blockedNames}]`,
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
      `[GraphOfThoughts] Planning phase iteration ${planningIteration}: empty output. Aborting planning phase.`,
    );
    return { planApproved: false };
  }

  logger.warn(
    `[GraphOfThoughts] Planning phase exhausted ${MAX_PLANNING_ITERATIONS} iterations without exit_plan_mode call.`,
  );
  return { planApproved: false };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Multi-criteria scoring
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
        `[GraphOfThoughts] Failed to log scoring request: ${getErrorMessage(scoringLogError)}`,
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
      `[GraphOfThoughts] Branch scores: ${branches.map((branch, index) => `${index + 1}:${branch.score.toFixed(1)}`).join(", ")}`,
    );
  } catch (scoringError: unknown) {
    logger.warn(
      `[GraphOfThoughts] Scoring failed: ${getErrorMessage(scoringError)}. Using equal scores.`,
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
