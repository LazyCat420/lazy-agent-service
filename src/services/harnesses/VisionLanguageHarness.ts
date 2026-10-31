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
import { applyAssembledSystemPrompt } from "./lifecycle/IdentityPrompt.ts";

import type AgentHooks from "../AgentHooks.ts";
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

interface VisionIterationOutcome {
  messages: ConversationMessage[];
  action: "continue" | "break" | "return";
  hasCleanTextBreak: boolean;
  truncationRecoveryCount: number;
}

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

  private resolveMaxIterations(clientMaxIterations: number | undefined): number {
    if (clientMaxIterations === 0) return Infinity;
    if (clientMaxIterations) return Math.min(100, Math.max(1, clientMaxIterations));
    return MAX_TOOL_ITERATIONS;
  }

  private injectVisionFeedInstruction(currentMessages: ConversationMessage[]): void {
    const systemMessage = currentMessages.find((message) => message.role === "system");
    const visionInstruction = PromptLocaleService.get(
      (this.context.options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale(),
      "harness.visionFeed.instruction",
    );
    if (systemMessage) {
      if (!systemMessage.content?.includes("LIVE VISION FEED ACTIVE")) {
        systemMessage.content = (systemMessage.content || "") + visionInstruction;
      }
    } else {
      currentMessages.unshift({
        role: "system",
        content: visionInstruction.trim(),
      });
    }
  }

  private async runFirstIterationSetup(
    currentMessages: ConversationMessage[],
    hooks: ReturnType<typeof createStandardHooks>["hooks"],
  ): Promise<void> {
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
    } = this.context;

    const hookContext: BeforePromptHookContext = {
      messages: currentMessages,
      project,
      username,
      agent,
      traceId,
      conversationId,
      agentConversationId: agentConversationId || "",
      parentAgentConversationId: this.context.parentAgentConversationId,
      agentContext: options.agentContext,
      enabledTools: this.tools.resolvedEnabledTools,
      resolvedToolNames: this.tools.finalTools.map((tool: ToolSchema) => tool.name),
      workspaceRoot: workspaceRoot || undefined,
      workspaceEnabled: options.workspaceEnabled as boolean | undefined,
      locale: options.locale as string | undefined,
      loadedTools: this.state.loadedTools,
    };
    await hooks.run("beforePrompt", hookContext);

    if (hookContext._assembledSystemPrompt) {
      const assembledPrompt = hookContext._assembledSystemPrompt as string;
      this.context.conversationMeta = {
        ...(this.context.conversationMeta || {}),
        systemPrompt: assembledPrompt,
      };
      applyAssembledSystemPrompt(options, assembledPrompt);
    }

    if (Array.isArray(hookContext._injectedSkills) && hookContext._injectedSkills.length > 0) {
      emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.SKILLS_INJECTED,
        skills: hookContext._injectedSkills,
      });
    }

    if (this.state.planModeActive) {
      await PlanningModeService.injectPlanningInstruction(currentMessages);
    }
  }

  private buildPassTools(): ToolSchema[] {
    if (this.state.planModeActive) {
      const planModeTools = this.tools.finalTools.filter(
        (tool: ToolSchema) => tool.name === TOOL_NAMES.EXIT_PLAN_MODE,
      );
      logger.info(
        `[PlanningMode] Sending ${planModeTools.length} tools to provider: ${planModeTools.map((tool: ToolSchema) => tool.name).join(", ")}`,
      );
      return planModeTools;
    }
    return this.tools.finalTools.filter((tool: ToolSchema) => {
      const cleanName = tool.name.replace(/^(mcp__[a-zA-Z0-9_-]+__)/, "");
      return tool.name === "describe_tools" || this.state.loadedTools.has(cleanName);
    });
  }

  private injectLiveVisionFrames(
    currentMessages: ConversationMessage[],
    resolvedAgentConversationId: string,
  ): void {
    const liveFrames = LiveFrameService.getFrames(this.context.conversationId);
    if (!liveFrames || liveFrames.length === 0) return;
    const lastUserMessage = [...currentMessages].reverse().find((message) => message.role === "user");
    if (!lastUserMessage) return;
    lastUserMessage.images = [...liveFrames];
    logger.info(
      `[VisionLanguageHarness] Injected ${liveFrames.length} live frames into last user message for session ${resolvedAgentConversationId}`,
    );
  }

  private appendValidationFailureMessages(
    pass: ReturnType<VisionLanguageHarness["createPassState"]>,
    results: ToolResult[],
    validationFeedback: Awaited<ReturnType<typeof validateAfterToolExecution>>,
    currentMessages: ConversationMessage[],
  ): void {
    const errorBlock = validationFeedback
      .map((feedback) => `### ${feedback.filePath} (${feedback.validatorType})\n${feedback.rawOutput}`)
      .join("\n\n");
    const locale =
      (this.context.options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale();

    currentMessages.push({
      role: "assistant",
      content: pass.streamedText || "",
      ...(pass.streamedThinking.trim() && { thinking: pass.streamedThinking.trim() }),
      ...(pass.thinkingSignature && { thinkingSignature: pass.thinkingSignature }),
      toolCalls: pass.pendingToolCalls.map((toolCall: ToolCall) => {
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
      content:
        PromptLocaleService.get(locale, "harness.validationError.header", {
          errorCount: String(validationFeedback.length),
        }) +
        `\n\n${errorBlock}\n\n` +
        PromptLocaleService.get(locale, "harness.validationError.analyzePrompt"),
    });

    this.context.emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.VALIDATION_ERRORS_DETECTED,
      count: validationFeedback.length,
    });
  }

  private appendCompletedToolTurnMessages(
    pass: ReturnType<VisionLanguageHarness["createPassState"]>,
    results: ToolResult[],
    currentMessages: ConversationMessage[],
  ): ConversationMessage[] {
    const assistantMessage: ConversationMessage = {
      role: "assistant",
      content: pass.streamedText || "",
      ...(pass.streamedThinking.trim() && { thinking: pass.streamedThinking.trim() }),
      ...(pass.thinkingSignature && { thinkingSignature: pass.thinkingSignature }),
      toolCalls: pass.pendingToolCalls.map((toolCall: ToolCall) => {
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
      pass.pendingToolCalls,
      results,
      this.state,
      MAX_CONSECUTIVE_TOOL_ERRORS,
      this.context.options?.locale as string | undefined,
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

    injectToolDiscoveryNudge(pass.pendingToolCalls, results, filteredMessages, this.context);
    this.checkAndApplyToolSetChanges(filteredMessages);
    return filteredMessages;
  }

  private async handleIterationToolCalls(
    pass: ReturnType<VisionLanguageHarness["createPassState"]>,
    currentMessages: ConversationMessage[],
    hooks: ReturnType<typeof createStandardHooks>["hooks"],
  ): Promise<{ messages: ConversationMessage[]; earlyReturn: boolean }> {
    const { context, state } = this;
    const { emit } = context;

    if (state.planModeActive) {
      const { allBlocked } = blockUnauthorizedToolCalls(
        pass.pendingToolCalls,
        currentMessages,
        pass,
        state,
        context.options?.locale as string | undefined,
      );
      if (allBlocked) {
        this.logIteration(pass, currentMessages);
        return { messages: currentMessages, earlyReturn: false };
      }
    }

    context._currentMessages = currentMessages;
    const results: ToolResult[] = await executeToolBatch(
      pass.pendingToolCalls,
      context,
      this.tools,
      hooks,
      state,
    );

    await processToolResultMedia(pass.pendingToolCalls, results, state, pass, emit, context);
    trackToolErrors(pass.pendingToolCalls, results, state, MAX_CONSECUTIVE_TOOL_ERRORS, emit);
    emitPostExecutionStatus(pass.pendingToolCalls, emit);

    const validationFeedback = await validateAfterToolExecution(
      pass.pendingToolCalls,
      results,
      context,
      this.tools,
    );

    if (validationFeedback.length > 0) {
      this.appendValidationFailureMessages(pass, results, validationFeedback, currentMessages);
      this.logIteration(pass, currentMessages);
      return { messages: currentMessages, earlyReturn: false };
    }

    await checkForPlanModeEntry(
      pass.pendingToolCalls,
      currentMessages,
      state,
      emit,
      context.options?.locale as string | undefined,
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
      if (!shouldContinueLoop) {
        return { messages: currentMessages, earlyReturn: true };
      }
    }

    const updatedMessages = this.appendCompletedToolTurnMessages(pass, results, currentMessages);
    this.logIteration(pass, updatedMessages);
    return { messages: updatedMessages, earlyReturn: false };
  }

  private handleTruncatedPass(
    pass: ReturnType<VisionLanguageHarness["createPassState"]>,
    currentMessages: ConversationMessage[],
    truncationRecoveryCount: number,
  ): { shouldContinue: boolean; truncationRecoveryCount: number } {
    const nextRecoveryCount = truncationRecoveryCount + 1;
    const configuredMaxTokens = this.context.options.maxTokens || "default";
    const modelOutputCeiling = this.context.modelDefinition?.maxOutputTokens as number | undefined;
    logger.warn(
      `[VisionLanguageHarness] Max tokens truncation detected on iteration ${this.state.iterations} — ` +
        `Recovery attempt ${nextRecoveryCount}/${MAX_OUTPUT_TRUNCATION_RECOVERIES}.`,
    );

    const alreadyAtCeiling =
      typeof configuredMaxTokens === "number" &&
      isAtOutputCeiling(configuredMaxTokens, modelOutputCeiling);

    if (!alreadyAtCeiling && nextRecoveryCount <= MAX_OUTPUT_TRUNCATION_RECOVERIES) {
      const escalatedMaxTokens = injectContinuationContext(
        currentMessages,
        pass,
        this.context,
        nextRecoveryCount,
      );
      this.context.options.maxTokens = escalatedMaxTokens;
      this.logIteration(pass, currentMessages);
      return { shouldContinue: true, truncationRecoveryCount: nextRecoveryCount };
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
    injectErrorAsConversationMessage(currentMessages, exhaustionMessage, this.context);
    this.logIteration(pass, currentMessages);
    return { shouldContinue: false, truncationRecoveryCount: nextRecoveryCount };
  }

  private handleNoToolPass(
    pass: ReturnType<VisionLanguageHarness["createPassState"]>,
    currentMessages: ConversationMessage[],
    truncationRecoveryCount: number,
  ): { shouldBreak: boolean; hasCleanTextBreak: boolean; truncationRecoveryCount: number } {
    const { context, state } = this;

    if (pass.streamedText) {
      if (state.planModeActive) {
        currentMessages.push({
          role: "assistant",
          content: pass.streamedText,
          ...(pass.streamedThinking.trim() && { thinking: pass.streamedThinking.trim() }),
          ...(pass.thinkingSignature && { thinkingSignature: pass.thinkingSignature }),
        });
        this.logIteration(pass, currentMessages);
        return { shouldBreak: false, hasCleanTextBreak: false, truncationRecoveryCount };
      }

      const codexResult = handleCodexPlanningResponse(
        pass,
        currentMessages,
        context,
        state,
        this.tools.finalTools,
        "VisionLanguageHarness",
      );
      this.logIteration(pass, currentMessages);
      if (codexResult.shouldContinueLoop) {
        return { shouldBreak: false, hasCleanTextBreak: false, truncationRecoveryCount };
      }
      return { shouldBreak: true, hasCleanTextBreak: true, truncationRecoveryCount };
    }

    if (pass.streamedThinking.trim()) {
      logger.warn(
        `[VisionLanguageHarness] Thinking-only response on iteration ${state.iterations} — ` +
          `thinking=${pass.streamedThinking.length}chars, text=0. ` +
          `Injecting continuation prompt to elicit text response.`,
      );
      currentMessages.push({
        role: "assistant",
        content: "",
        thinking: pass.streamedThinking.trim(),
        ...(pass.thinkingSignature && { thinkingSignature: pass.thinkingSignature }),
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
      return { shouldBreak: false, hasCleanTextBreak: false, truncationRecoveryCount };
    }

    if (isOutputTruncated(pass)) {
      const recovery = this.handleTruncatedPass(pass, currentMessages, truncationRecoveryCount);
      return {
        shouldBreak: !recovery.shouldContinue,
        hasCleanTextBreak: false,
        truncationRecoveryCount: recovery.truncationRecoveryCount,
      };
    }

    logger.warn(
      `[VisionLanguageHarness] Empty model output on iteration ${state.iterations} — ` +
        `text=${pass.streamedText.length}, thinking=${pass.streamedThinking.length}, ` +
        `toolCalls=${pass.pendingToolCalls.length}. Breaking.`,
    );
    this.logIteration(pass, currentMessages);
    return { shouldBreak: true, hasCleanTextBreak: false, truncationRecoveryCount };
  }

  /** Run one vision iteration and report what the loop should do next. */
  private async runVisionIteration(
    currentMessagesIn: ConversationMessage[],
    hooks: AgentHooks,
    truncationRecoveryCountIn: number,
    maxIterations: number,
  ): Promise<VisionIterationOutcome> {
    const context = this.context;
    const state = this.state;
    const { options, agentConversationId, project, username, agent, emit, signal } =
      context;
    const resolvedAgentConversationId = agentConversationId || "";
    let currentMessages = currentMessagesIn;
    const truncationRecoveryCount = truncationRecoveryCountIn;

    state.iterations++;

    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.ITERATION_PROGRESS,
      iteration: state.iterations,
      maxIterations,
    });

    if (state.iterations === 1) {
      await this.runFirstIterationSetup(currentMessages, hooks);
    }

    const passOptions: IterationPassOptions = {
      ...options,
      project,
      agent,
      username,
      tools: this.buildPassTools(),
    };
    const resolvedPassTools = passOptions.tools || [];
    const allowedToolNames = new Set(resolvedPassTools.map((tool: ToolSchema) => tool.name));

    const pressureResult = await manageContextPressure(
      currentMessages,
      context,
      state,
      "VisionLanguageHarness",
    );
    currentMessages = pressureResult.messages;

    this.injectLiveVisionFrames(currentMessages, resolvedAgentConversationId);

    currentMessages = this.enforceContextWindow(currentMessages, this.tools.finalTools.length);

    const pass = this.createPassState(passOptions);
    const requestIdBase =
      context.requestId || resolvedAgentConversationId || crypto.randomUUID();
    const passRequestId = `${requestIdBase}-iter-${state.iterations}`;
    pass.requestId = passRequestId;

    this.registerTrackerRequest(passRequestId);

    const stream = await this.createProviderStream(currentMessages, passOptions);
    await this.consumeStream(stream, pass, allowedToolNames);

    finalizePassTracker(pass, passRequestId);
    logKVCacheHitRate(pass.usage, state.iterations, "VisionLanguageHarness");
    this.emitGenerationProgress();

    if (signal?.aborted) {
      return {
        messages: currentMessages,
        action: "break",
        hasCleanTextBreak: false,
        truncationRecoveryCount,
      };
    }

    this.emitUsageUpdate();

    if (pass.pendingToolCalls.length > 0) {
      const toolTurn = await this.handleIterationToolCalls(pass, currentMessages, hooks);
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

    const noToolOutcome = this.handleNoToolPass(
      pass,
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

  async run(): Promise<{ messages: ConversationMessage[] }> {
    const context = this.context;
    const state = this.state;
    const { options, workspaceRoot, emit, signal } = context;

    const resolvedMaxIterations = this.resolveMaxIterations(options.maxIterations);

    let currentMessages: ConversationMessage[] = [...context.messages];
    let truncationRecoveryCount = 0;
    let hasCleanTextBreak = false;

    const { hooks } = createStandardHooks({
      workspaceRoot: workspaceRoot || undefined,
      enableCriticGate: options.enableCriticGate === true,
      criticModel: options.criticModel || undefined,
    });

    if (options.planFirst) {
      emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.PLAN_MODE_ENTERED,
      });
    }

    this.injectVisionFeedInstruction(currentMessages);

    try {
      while (state.iterations < resolvedMaxIterations) {
        const outcome = await this.runVisionIteration(
          currentMessages,
          hooks,
          truncationRecoveryCount,
          resolvedMaxIterations,
        );
        currentMessages = outcome.messages;
        truncationRecoveryCount = outcome.truncationRecoveryCount;
        if (outcome.hasCleanTextBreak) hasCleanTextBreak = true;
        if (outcome.action === "return") return { messages: currentMessages };
        if (outcome.action === "break") break;
      }

      if (!hasCleanTextBreak && state.streamedToolCalls.length > 0 && !signal?.aborted) {
        state.conversationOutcome = "exhausted";
        await runExhaustionRecoveryPass(this, context, state, currentMessages);
      }

      await this.finalize(currentMessages, hooks);
      return { messages: currentMessages };
    } catch (loopError: unknown) {
      logger.error(
        `[VisionLanguageHarness] Loop error on iteration ${state.iterations}: ${loopError instanceof Error ? loopError.message : String(loopError)}. Persisting ${currentMessages.length - state.originalMessageCount} accumulated message(s).`,
      );

      injectErrorAsConversationMessage(
        currentMessages,
        buildProviderErrorMessage(
          loopError,
          state.iterations,
          this.context.options?.locale as string | undefined,
        ),
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
