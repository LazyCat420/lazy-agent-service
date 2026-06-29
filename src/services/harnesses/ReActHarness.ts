import BaseAgenticHarness from "./BaseAgenticHarness.ts";
import { runTreeOfThoughts } from "./strategies/TreeOfThoughtsStrategy.ts";
import { runGraphOfThoughts } from "./strategies/GraphOfThoughtsStrategy.ts";
import logger from "../../utils/logger.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  TOOL_NAMES,
  THOUGHT_STRUCTURES,
  MAX_TOOL_ITERATIONS,
} from "@rodrigo-barraza/utilities-library/taxonomy";

import { createStandardHooks } from "./lifecycle/HookInitializer.ts";
import { executeToolBatch } from "./lifecycle/ToolExecutor.ts";
import { checkAndWaitForApproval } from "./lifecycle/ApprovalGate.ts";
import {
  emitPostExecutionStatus,
  processToolResultMedia,
  trackToolErrors,
} from "./lifecycle/PostExecutionEmitter.ts";
import { runExhaustionRecoveryPass } from "./lifecycle/ExhaustionRecovery.ts";
import {
  blockUnauthorizedToolCalls,
  handleExitPlanMode,
  checkForPlanModeEntry,
} from "./lifecycle/PlanModeController.ts";
import { validateAfterToolExecution } from "./lifecycle/ValidationInterceptor.ts";
import { buildToolRetryGuidance } from "./lifecycle/ToolRetryInterceptor.ts";
import {
  isOutputTruncated,
  isAtOutputCeiling,
  injectContinuationContext,
  injectErrorAsConversationMessage,
  buildExhaustedRecoveryMessage,
  buildProviderErrorMessage,
  MAX_OUTPUT_TRUNCATION_RECOVERIES,
} from "./lifecycle/OutputTruncationRecovery.ts";
import { manageContextPressure } from "./lifecycle/ContextPressureManager.ts";
import { logKVCacheHitRate } from "./lifecycle/KVCacheReporter.ts";
import { injectToolDiscoveryNudge } from "./lifecycle/ToolDiscoveryNudge.ts";
import { finalizePassTracker } from "./lifecycle/TrackerFinalizer.ts";
import { handleCodexPlanningResponse } from "./lifecycle/CodexPlanningDetector.ts";
import { maybeInjectSystemReminder, cleanupReminderCache } from "./lifecycle/SystemReminderInjector.ts";
import { checkCostBudget } from "./lifecycle/CostBudgetEnforcer.ts";
import { createSandboxCheckpoint, restoreSandboxCheckpoint } from "./lifecycle/SandboxExecutor.ts";

import PlanningModeService from "../PlanningModeService.ts";
import PromptLocaleService from "../PromptLocaleService.ts";

import type {
  ConversationMessage,
  ToolCall,
  ToolSchema,
  ToolResult,
  AgenticOptions,
  BeforePromptHookContext,
} from "./types.ts";


/**
 * Per-iteration pass options combining the user's AgenticOptions with
 * runtime context fields needed by the provider and lifecycle modules.
 */
interface IterationPassOptions extends AgenticOptions {
  project: string;
  agent?: string | null;
  username: string;
}

const MAX_CONSECUTIVE_TOOL_ERRORS = 3;

/**
 * ReActHarness — Reason→Act→Observe tool-use loop with pluggable thought structures.
 *
 * Two orthogonal axes govern agent reasoning:
 *   1. Execution pattern (this harness): ReAct — interleaved reasoning and acting
 *   2. Reasoning shape (thought structure): CoT / ToT / GoT — how thoughts connect
 *
 * Papers:
 *   Execution pattern:
 *   - "ReAct: Synergizing Reasoning and Acting in Language Models"
 *     (arxiv.org/abs/2210.03629) — Yao et al., 2022
 *
 *   Reasoning shapes:
 *   - "Chain-of-Thought Prompting Elicits Reasoning in Large Language Models"
 *     (arxiv.org/abs/2201.11903) — Wei et al., 2022  [CoT — linear chain]
 *   - "Tree of Thoughts: Deliberate Problem Solving with Large Language Models"
 *     (arxiv.org/abs/2305.10601) — Yao et al., 2023  [ToT — branching tree]
 *   - "Graph of Thoughts: Solving Elaborate Problems with Large Language Models"
 *     (arxiv.org/abs/2308.09687) — Besta et al., 2023  [GoT — merging graph]
 *   - "Reflexion: Language Agents with Verbal Reinforcement Learning"
 *     (arxiv.org/abs/2303.11366) — Shinn et al., 2023  [backtracking self-correction in ToT]
 *
 * Thought structures (dispatched at run()):
 *   - Chain of Thought (default): linear chain — one reasoning step per iteration
 *   - Tree of Thoughts: branching tree — parallel branches, score, select best
 *   - Graph of Thoughts: merging graph — parallel branches, score, synthesize all
 *
 * See ThoughtStructureRegistry.ts → THOUGHT_STRUCTURE_DEFINITIONS
 * for full paper-alignment metadata and config option documentation.
 *
 * Control flow (Chain of Thought):
 *   1. Stream LLM response (Reason)
 *   2. If tool calls: execute → append results → loop (Act → Observe)
 *   3. If text only (and not plan mode): break → finalize
 *   4. Exhaustion recovery pass if iteration limit hit
 *
 * Supports:
 *   - Plan mode (planFirst / enter_plan_mode / exit_plan_mode)
 *   - Auto-approval engine
 *   - Orchestrator (multi-agent) sub-agent tracking
 *   - Streaming tool output (shell, python, js)
 *
 * Lifecycle phases are delegated to composable modules in ./lifecycle/
 * so future harnesses can reuse individual phases without inheriting
 * the entire ReActHarness.
 */
export default class ReActHarness extends BaseAgenticHarness {
  static id = "standard";
  static label = "ReAct Loop";
  static description =
    "Reason→Act→Observe tool-use loop with plan mode, approval gating, and exhaustion recovery.";

  async run(): Promise<{ messages: ConversationMessage[] }> {
    // ── Strategy dispatch ──────────────────────────────────
    const resolvedStructure = this.context.options.thoughtStructure;
    if (resolvedStructure === THOUGHT_STRUCTURES.TREE_OF_THOUGHTS) {
      logger.info(
        `[ReActHarness] Delegating to Tree of Thoughts thought structure`,
      );
      return runTreeOfThoughts(this);
    }
    if (resolvedStructure === THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS) {
      logger.info(
        `[ReActHarness] Delegating to Graph of Thoughts thought structure`,
      );
      return runGraphOfThoughts(this);
    }

    const context = this.context;
    const state = this.state;
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

    // ── Resolve max iterations ────────────────────────────────
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

    // ── Initialize lifecycle hooks ──────────────────────────
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

    // ── Main loop ────────────────────────────────────────────
    // Wrapped in try/catch to persist accumulated messages on error.
    // Without this, a provider timeout mid-loop leaves the conversation
    // document as an empty stub (messages: []) in MongoDB — the
    // "disappearing messages" bug.
    try {
      while (state.iterations < resolvedMaxIterations) {
        state.iterations++;

        emit({
          type: SERVER_SENT_EVENT_TYPES.STATUS,
          message: STATUS_MESSAGES.ITERATION_PROGRESS,
          iteration: state.iterations,
          maxIterations: resolvedMaxIterations,
        });

        // ── Instruction fade-out countermeasure ─────────────────
        await maybeInjectSystemReminder(
          currentMessages,
          state,
          context,
        );

        // ── beforePrompt hook (iteration 1 only) ──────────────
        if (state.iterations === 1) {
          const hookContext: BeforePromptHookContext = {
            messages: currentMessages,
            project,
            username,
            agent,
            traceId,
            conversationId,
            agentConversationId,
            parentAgentConversationId: context.parentAgentConversationId,
            agentContext: options.agentContext,
            enabledTools: this.tools.resolvedEnabledTools,
            resolvedToolNames: this.tools.finalTools.map(
              (tool: ToolSchema) => tool.name,
            ),
            workspaceRoot: workspaceRoot || undefined,
            workspaceEnabled: options.workspaceEnabled as boolean | undefined,
            locale: options.locale as string | undefined,
            loadedTools: state.loadedTools,
          };
          await hooks.run("beforePrompt", hookContext);

          // ── Persist assembled system prompt to conversationMeta ──
          if (hookContext._assembledSystemPrompt) {
            const assembledPrompt = hookContext._assembledSystemPrompt as string;
            context.conversationMeta = {
              ...(context.conversationMeta || {}),
              systemPrompt: assembledPrompt,
            };
            // Feed the identity prompt to providers as a first-class parameter
            // (Google → systemInstruction, Anthropic → payload.system, etc.)
            // so it never needs to exist in the messages array.
            options.systemPrompt = assembledPrompt;
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

          if (state.planModeActive) {
            await PlanningModeService.injectPlanningInstruction(currentMessages);
          }
        }

        // ── Build pass options ─────────────────────────────────
        const passOptions: IterationPassOptions = {
          ...options,
          project,
          agent,
          username,
        };
        if (state.planModeActive) {
          const planModeTools = this.tools.finalTools.filter(
            (tool: ToolSchema) => tool.name === TOOL_NAMES.EXIT_PLAN_MODE,
          );
          passOptions.tools = planModeTools;
          logger.info(
            `[PlanningMode] Sending ${planModeTools.length} tools to provider: ${planModeTools.map((tool: ToolSchema) => tool.name).join(", ")}`,
          );
        } else {
          passOptions.tools = this.tools.finalTools.filter(
            (tool: ToolSchema) => {
              const cleanName = tool.name.replace(/^(mcp__[a-zA-Z0-9_-]+__)/, "");
              return tool.name === "describe_tools" || state.loadedTools.has(cleanName);
            },
          );
        }

        const resolvedPassTools = passOptions.tools || [];
        const allowedToolNames = new Set(
          resolvedPassTools.map((tool: ToolSchema) => tool.name),
        );

        // ── Context pressure management ──────────────────────────
        // Micro-compaction (pressure-gated) → auto-compaction → summary persistence
        const pressureResult = await manageContextPressure(
          currentMessages,
          context,
          state,
          "ReActHarness",
        );
        currentMessages = pressureResult.messages;

        // ── Context window enforcement ─────────────────────────
        currentMessages = this.enforceContextWindow(
          currentMessages,
          this.tools.finalTools.length,
        );

        // ── Create per-iteration pass state ────────────────────
        const pass = this.createPassState(passOptions);
        const requestIdBase =
          context.requestId || agentConversationId || crypto.randomUUID();
        const passRequestId = `${requestIdBase}-iter-${state.iterations}`;
        pass.requestId = passRequestId;

        this.registerTrackerRequest(passRequestId);

        // ── Stream LLM response ────────────────────────────────
        const stream = this.createProviderStream(currentMessages, passOptions);
        await this.consumeStream(stream, pass, allowedToolNames);

        // ── Finalize tracker for this pass ─────────────────────
        finalizePassTracker(pass, passRequestId);
        logKVCacheHitRate(pass.usage, state.iterations, "ReActHarness");
        this.emitGenerationProgress();

        if (signal?.aborted) break;

        this.emitUsageUpdate();

        // ── Cost budget enforcement ────────────────────────────
        if (checkCostBudget(state, context.resolvedModel, options.maxCostDollars, emit)) {
          break;
        }

        // ── Tool execution ─────────────────────────────────────
        if (pass.pendingToolCalls.length > 0) {
          // Plan mode enforcement
          if (state.planModeActive) {
            const { allBlocked } = blockUnauthorizedToolCalls(
              pass.pendingToolCalls,
              currentMessages,
              pass,
              state,
              this.context.options?.locale as string | undefined,
            );
            if (allBlocked) {
              this.logIteration(pass, currentMessages);
              continue;
            }
          }

          // ── Approval gating ───────────────────────────────────
          const { isApproved, shouldApproveAll } =
            await checkAndWaitForApproval(
              pass.pendingToolCalls,
              context,
              approvalEngine,
            );

          let results: ToolResult[] = [];
          let sandboxCheckpointReference: string | null = null;
          if (!isApproved) {
            results = pass.pendingToolCalls.map((toolCall) => ({
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

            // ── Execute tools in parallel ─────────────────────────
            // Attach currentMessages to context so ToolExecutor can pass them
            // to tools-api (needed by tools like generate_image that inspect conversation)
            context._currentMessages = currentMessages;

            // ── Sandbox checkpoint (git-based rollback) ────────────
            sandboxCheckpointReference = options.enableSandbox
              ? createSandboxCheckpoint(workspaceRoot, emit)
              : null;

            results = await executeToolBatch(
              pass.pendingToolCalls,
              context,
              this.tools,
              hooks,
              state,
            );
          }

          // ── Post-execution: media, errors, status ─────────────
          await processToolResultMedia(
            pass.pendingToolCalls,
            results,
            state,
            pass,
            emit,
            context,
          );

          trackToolErrors(
            pass.pendingToolCalls,
            results,
            state,
            MAX_CONSECUTIVE_TOOL_ERRORS,
            emit,
          );

          emitPostExecutionStatus(pass.pendingToolCalls, emit);

          // ── Validation intercept (linter auto-remediation) ──────
          // Must run BEFORE plan mode toggling — no point entering plan
          // mode if validation will inject error feedback and continue.
          const validationFeedback = await validateAfterToolExecution(
            pass.pendingToolCalls,
            results,
            context,
            state,
          );

          if (validationFeedback.length > 0) {
            const errorBlock = validationFeedback
              .map(
                (feedback) =>
                  `### ${feedback.filePath} (${feedback.validatorType})\n${feedback.rawOutput}`,
              )
              .join("\n\n");

            currentMessages.push({
              role: "assistant",
              content: pass.streamedText || "",
              ...(pass.streamedThinking.trim() && {
                thinking: pass.streamedThinking.trim(),
              }),
              ...(pass.thinkingSignature && {
                thinkingSignature: pass.thinkingSignature,
              }),
              toolCalls: pass.pendingToolCalls.map((toolCall: ToolCall) => {
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
              }),
            });

            // Restore sandbox checkpoint on validation failure
            if (sandboxCheckpointReference) {
              restoreSandboxCheckpoint(workspaceRoot, sandboxCheckpointReference, emit);
            }

            currentMessages.push({
              role: "system",
              content:
                PromptLocaleService.get(
                  (this.context.options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale(),
                  "harness.validationError.header",
                  { errorCount: String(validationFeedback.length) },
                ) +
                `\n\n${errorBlock}\n\n` +
                PromptLocaleService.get(
                  (this.context.options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale(),
                  "harness.validationError.analyzePrompt",
                ),
            });

            emit({
              type: SERVER_SENT_EVENT_TYPES.STATUS,
              message: STATUS_MESSAGES.VALIDATION_ERRORS_DETECTED,
              count: validationFeedback.length,
            });
            this.logIteration(pass, currentMessages);
            continue;
          }

          // ── Plan mode toggling ────────────────────────────────
          await checkForPlanModeEntry(
            pass.pendingToolCalls,
            currentMessages,
            state,
            emit,
            this.context.options?.locale as string | undefined,
          );

          const exitPlanToolCall = pass.pendingToolCalls.find(
            (toolCall) => toolCall.name === TOOL_NAMES.EXIT_PLAN_MODE,
          );
          if (exitPlanToolCall) {
            const { shouldContinueLoop } = await handleExitPlanMode(
              exitPlanToolCall,
              pass,
              results,
              currentMessages,
              context,
              state,
            );
            if (!shouldContinueLoop) return { messages: currentMessages };
          }

          // ── Append to context for next pass ───────────────────
          const assistantMessage: ConversationMessage = {
            role: "assistant",
            content: pass.streamedText || "",
            ...(pass.streamedThinking.trim() && {
              thinking: pass.streamedThinking.trim(),
            }),
            ...(pass.thinkingSignature && {
              thinkingSignature: pass.thinkingSignature,
            }),
            toolCalls: pass.pendingToolCalls.map((toolCall: ToolCall) => {
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
            }),
          };
          currentMessages.push(assistantMessage);

          // ── Structured retry guidance on tool failure ──────────
          // When tool calls fail, inject a system message prompting the
          // model to analyze which arguments caused the failure and retry
          // with corrections (Fission-GRPO pattern, arXiv 2026).
          const retryGuidanceMessage = buildToolRetryGuidance(
            pass.pendingToolCalls,
            results,
            state,
            MAX_CONSECUTIVE_TOOL_ERRORS,
            this.context.options?.locale as string | undefined,
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

          // ── Post-search nudge for tool discovery chain ─────────
          injectToolDiscoveryNudge(
            pass.pendingToolCalls,
            results,
            currentMessages,
            context,
          );

          this.checkAndApplyToolSetChanges(currentMessages);

          this.logIteration(pass, currentMessages);
          continue;
        }

        // ── No tools — check if we should break ─────────────────
        // Text present (with or without thinking) → clean text break.
        // Thinking-only (no text, no tools) → the model exhausted its
        // output budget on thinking tokens before producing a response.
        // Inject a continuation prompt asking it to respond concisely.
        if (pass.streamedText) {
          if (state.planModeActive) {
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
            this.logIteration(pass, currentMessages);
            continue;
          }

          // Handle Codex/planning models that separate planning and action
          const codexResult = handleCodexPlanningResponse(
            pass,
            currentMessages,
            context,
            state,
            this.tools.finalTools,
            "ReActHarness",
          );
          if (codexResult.shouldContinueLoop) {
            this.logIteration(pass, currentMessages);
            continue;
          }

          this.logIteration(pass, currentMessages);
          hasCleanTextBreak = true;
          break;
        }

        if (!pass.streamedText && pass.streamedThinking.trim()) {
          // Thinking-only response: model spent its entire output budget on
          // extended thinking without producing visible text or tool calls.
          // This commonly happens with local models (e.g. Gemma on lm-studio)
          // where the thinking budget isn't separately capped.
          //
          // Append the thinking as context and inject a continuation prompt
          // so the model can produce an actual response on the next iteration.
          logger.warn(
            `[AgenticLoop] Thinking-only response on iteration ${state.iterations} — ` +
              `thinking=${pass.streamedThinking.length}chars, text=0. ` +
              `Injecting continuation prompt to elicit text response.`,
          );

          currentMessages.push({
            role: "assistant",
            content: "",
            thinking: pass.streamedThinking.trim(),
            ...(pass.thinkingSignature && {
              thinkingSignature: pass.thinkingSignature,
            }),
          });

          currentMessages.push({
            role: "user",
            content:
              "[System: Your previous response contained only internal reasoning " +
              "without producing any visible output. Your thinking has been preserved. " +
              "Now respond concisely with your actual answer, analysis, or tool calls. " +
              "Do not repeat your reasoning — act on it.]",
          });

          this.logIteration(pass, currentMessages);
          continue;
        }

        // ── Empty output — check for truncation recovery ─────────
        if (isOutputTruncated(pass)) {
          truncationRecoveryCount++;
          const configuredMaxTokens = context.options.maxTokens || "default";
          const modelOutputCeiling = context.modelDefinition?.maxOutputTokens as number | undefined;
          logger.warn(
            `[AgenticLoop] Max tokens truncation detected on iteration ${state.iterations} — ` +
              `stopReason=${pass.stopReason}, maxTokens=${configuredMaxTokens}` +
              `${modelOutputCeiling ? `, modelCeiling=${modelOutputCeiling}` : ""}. ` +
              `Recovery attempt ${truncationRecoveryCount}/${MAX_OUTPUT_TRUNCATION_RECOVERIES}.`,
          );

          // Skip recovery if already at the model's physical output ceiling
          const alreadyAtCeiling = typeof configuredMaxTokens === "number" &&
            isAtOutputCeiling(configuredMaxTokens, modelOutputCeiling);

          if (!alreadyAtCeiling && truncationRecoveryCount <= MAX_OUTPUT_TRUNCATION_RECOVERIES) {
            const escalatedMaxTokens = injectContinuationContext(
              currentMessages,
              pass,
              context,
              truncationRecoveryCount,
            );
            context.options.maxTokens = escalatedMaxTokens;
            this.logIteration(pass, currentMessages);
            continue;
          }

          // All recovery attempts exhausted or at ceiling — inject error as conversation context
          if (alreadyAtCeiling) {
            logger.warn(
              `[AgenticLoop] Skipping truncation recovery — maxTokens (${configuredMaxTokens}) ` +
                `is already at or above model ceiling (${modelOutputCeiling}). Escalation would be pointless.`,
            );
          }
          const exhaustionMessage = buildExhaustedRecoveryMessage(
            alreadyAtCeiling ? 0 : MAX_OUTPUT_TRUNCATION_RECOVERIES,
            configuredMaxTokens,
            this.context.options?.locale as string | undefined,
          );
          injectErrorAsConversationMessage(
            currentMessages,
            exhaustionMessage,
            context,
          );
          this.logIteration(pass, currentMessages);
          break;
        }

        // Genuinely empty output (not truncation)
        logger.warn(
          `[AgenticLoop] Empty model output on iteration ${state.iterations} — ` +
            `text=${pass.streamedText.length}, thinking=${pass.streamedThinking.length}, ` +
            `toolCalls=${pass.pendingToolCalls.length}. Breaking.`,
        );
        this.logIteration(pass, currentMessages);
        break;
      }

      // ── Exhaustion Recovery Pass ─────────────────────────────
      // Triggers when the agent used tools but never produced a clean text-only
      // break — regardless of how the loop exited (max iterations, empty output,
      // truncation exhaustion). In all these cases, state.finalStreamedText
      // contains stale per-pass planning text ("Let me search for...") instead
      // of a synthesized final summary.
      // Skipped when signal is aborted (provider would reject the call).
      if (
        !hasCleanTextBreak &&
        state.streamedToolCalls.length > 0 &&
        !signal?.aborted
      ) {
        state.conversationOutcome = "exhausted";
        await runExhaustionRecoveryPass(this, context, state, currentMessages);
      }

      // ── Finalization (happy path) ──────────────────────────────
      cleanupReminderCache(agentConversationId);
      await this.finalize(currentMessages, hooks);
      return { messages: currentMessages };
    } catch (loopError: unknown) {
      // ── Error-path persistence ─────────────────────────────
      // Persist whatever messages accumulated before the error so
      // the conversation isn't left as an empty stub in MongoDB.
      // Also inject the error as a conversation message so the LLM
      // has context about the failure on the next turn.
      logger.error(
        `[ReActHarness] Loop error on iteration ${state.iterations}: ${loopError instanceof Error ? loopError.message : String(loopError)}. Persisting ${currentMessages.length - state.originalMessageCount} accumulated message(s).`,
      );

      injectErrorAsConversationMessage(
        currentMessages,
        buildProviderErrorMessage(loopError, state.iterations, this.context.options?.locale as string | undefined),
        context,
      );

      state.conversationOutcome = "error";

      try {
        await this.finalize(currentMessages, hooks);
      } catch (persistError: unknown) {
        logger.error(
          `[ReActHarness] Failed to persist messages on error path: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
        );
      }
      throw loopError;
    }
  }
}
