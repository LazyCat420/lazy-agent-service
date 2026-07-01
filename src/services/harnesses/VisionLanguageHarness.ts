import BaseAgenticHarness from "./BaseAgenticHarness.ts";
import logger from "../../utils/logger.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  TOOL_NAMES,
  MAX_TOOL_ITERATIONS,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import LiveFrameService from "../LiveFrameService.ts";
import PromptLocaleService from "../PromptLocaleService.ts";

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

import PlanningModeService from "../PlanningModeService.ts";

import type {
  ConversationMessage,
  ToolCall,
  ToolSchema,
  ToolResult,
  AgenticOptions,
  BeforePromptHookContext,
} from "./types.ts";


/** Per-iteration pass options with runtime context fields. */
interface IterationPassOptions extends AgenticOptions {
  project: string;
  agent?: string | null;
  username: string;
}

const MAX_CONSECUTIVE_TOOL_ERRORS = 3;

/**
 * VisionLanguageHarness — Reason→Act→Observe tool-use loop with live webcam/video streaming.
 *
 * Control flow:
 *   1. Inject live camera frames rolling buffer into the last user message.
 *   2. Stream LLM response (Reason)
 *   3. If tool calls: execute → append results → loop (Act → Observe)
 *   4. If text only: break → finalize
 */
export default class VisionLanguageHarness extends BaseAgenticHarness {
  static id = "vision_language";
  static label = "Vision-Language Harness";
  static description =
    "Reason→Act→Observe tool-use loop with real-time rolling webcam/screen streaming injection.";

  async run(): Promise<{ messages: ConversationMessage[] }> {
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

    const resolvedAgentConversationId = agentConversationId || "";

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

    // ── Inject live vision system instruction ─────────────────
    const systemMessage = currentMessages.find(
      (message) => message.role === "system",
    );
    const visionInstruction = PromptLocaleService.get(
      (this.context.options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale(),
      "harness.visionFeed.instruction",
    );
    if (systemMessage) {
      if (!systemMessage.content?.includes("LIVE VISION FEED ACTIVE")) {
        systemMessage.content =
          (systemMessage.content || "") + visionInstruction;
      }
    } else {
      currentMessages.unshift({
        role: "system",
        content: visionInstruction.trim(),
      });
    }

    // ── Main loop ────────────────────────────────────────────
    // Wrapped in try/catch for error-path message persistence.
    try {
      while (state.iterations < resolvedMaxIterations) {
        state.iterations++;

        emit({
          type: SERVER_SENT_EVENT_TYPES.STATUS,
          message: STATUS_MESSAGES.ITERATION_PROGRESS,
          iteration: state.iterations,
          maxIterations: resolvedMaxIterations,
        });

        // ── beforePrompt hook (iteration 1 only) ──────────────
        if (state.iterations === 1) {
          const hookContext: BeforePromptHookContext = {
            messages: currentMessages,
            project,
            username,
            agent,
            traceId,
            conversationId,
            agentConversationId: agentConversationId || "",
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
          "VisionLanguageHarness",
        );
        currentMessages = pressureResult.messages;

        // ── Live Vision Frame Injection ────────────────────────
        const liveFrames = LiveFrameService.getFrames(context.conversationId);
        if (liveFrames && liveFrames.length > 0) {
          const lastUserMessage = [...currentMessages]
            .reverse()
            .find((message) => message.role === "user");
          if (lastUserMessage) {
            if (!lastUserMessage.images) {
              lastUserMessage.images = [];
            }
            lastUserMessage.images = [...liveFrames];
            logger.info(
              `[VisionLanguageHarness] Injected ${liveFrames.length} live frames into last user message for session ${resolvedAgentConversationId}`,
            );
          }
        }

        // ── Context window enforcement ─────────────────────────
        currentMessages = this.enforceContextWindow(
          currentMessages,
          this.tools.finalTools.length,
        );

        // ── Create per-iteration pass state ────────────────────
        const pass = this.createPassState(passOptions);
        const requestIdBase =
          context.requestId || resolvedAgentConversationId || crypto.randomUUID();
        const passRequestId = `${requestIdBase}-iter-${state.iterations}`;
        pass.requestId = passRequestId;

        this.registerTrackerRequest(passRequestId);

        // ── Stream LLM response ────────────────────────────────
        const stream = this.createProviderStream(currentMessages, passOptions);
        await this.consumeStream(stream, pass, allowedToolNames);

        // ── Finalize tracker for this pass ─────────────────────
        finalizePassTracker(pass, passRequestId);
        logKVCacheHitRate(pass.usage, state.iterations, "VisionLanguageHarness");
        this.emitGenerationProgress();

        if (signal?.aborted) break;

        this.emitUsageUpdate();

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

            context._currentMessages = currentMessages;

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

          // Handle Codex/planning models
          const codexResult = handleCodexPlanningResponse(
            pass,
            currentMessages,
            context,
            state,
            this.tools.finalTools,
            "VisionLanguageHarness",
          );
          if (codexResult.shouldContinueLoop) {
            this.logIteration(pass, currentMessages);
            continue;
          }

          this.logIteration(pass, currentMessages);
          hasCleanTextBreak = true;
          break;
        }

        if (!pass.streamedText && (!pass.pendingToolCalls || !pass.pendingToolCalls.length) && pass.streamedThinking.trim()) {
          logger.warn(
            `[VisionLanguageHarness] Thinking-only response on iteration ${state.iterations} — ` +
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
            _isSystemWarning: true,
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
            `[VisionLanguageHarness] Max tokens truncation detected on iteration ${state.iterations} — ` +
              `Recovery attempt ${truncationRecoveryCount}/${MAX_OUTPUT_TRUNCATION_RECOVERIES}.`,
          );

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

          if (alreadyAtCeiling) {
            logger.warn(
              `[VisionLanguageHarness] Skipping truncation recovery — maxTokens (${configuredMaxTokens}) ` +
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

        logger.warn(
          `[VisionLanguageHarness] Empty model output on iteration ${state.iterations} — ` +
            `text=${pass.streamedText.length}, thinking=${pass.streamedThinking.length}, ` +
            `toolCalls=${pass.pendingToolCalls.length}. Breaking.`,
        );
        this.logIteration(pass, currentMessages);
        break;
      }

      // ── Exhaustion Recovery Pass ─────────────────────────────
      // Triggers when the agent used tools but never produced a clean text-only
      // break — regardless of how the loop exited (max iterations, empty output,
      // truncation exhaustion). Skipped when signal is aborted.
      if (
        !hasCleanTextBreak &&
        state.streamedToolCalls.length > 0 &&
        !signal?.aborted
      ) {
        state.conversationOutcome = "exhausted";
        await runExhaustionRecoveryPass(this, context, state, currentMessages);
      }

      // ── Finalization (happy path) ──────────────────────────────
      await this.finalize(currentMessages, hooks);
      return { messages: currentMessages };
    } catch (loopError: unknown) {
      logger.error(
        `[VisionLanguageHarness] Loop error on iteration ${state.iterations}: ${loopError instanceof Error ? loopError.message : String(loopError)}. Persisting ${currentMessages.length - state.originalMessageCount} accumulated message(s).`,
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
          `[VisionLanguageHarness] Failed to persist messages on error path: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
        );
      }
      throw loopError;
    }
  }
}
