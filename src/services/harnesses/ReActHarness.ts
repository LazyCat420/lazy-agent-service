import BaseAgenticHarness from "./BaseAgenticHarness.ts";
import type { AgenticContext } from "./types.ts";
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
import {
  emitPostExecutionStatus,
  processToolResultMedia,
  trackToolErrors,
} from "./lifecycle/PostExecutionEmitter.ts";
import { runExhaustionRecoveryPass } from "./lifecycle/ExhaustionRecovery.ts";
import { CanonicalProviderBudget } from "../CanonicalProviderBudget.ts";
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
import { StuckDetector, normalizeContent, isErrorResult, type StuckPattern } from "../../platform/verify/StuckDetector.ts";
import { compactToolResultsForPressure, isContextWindowError } from "../AgenticLoopService.ts";
import {
  MAX_EMPTY_OUTPUT_RETRIES,
  EMPTY_OUTPUT_TEMPERATURE_BUMP,
  emptyOutputRecoveryNotice,
} from "../../constants/LoopGuards.ts";

import PlanningModeService from "../PlanningModeService.ts";
import PromptLocaleService from "../PromptLocaleService.ts";
import { applyAssembledSystemPrompt } from "./lifecycle/IdentityPrompt.ts";

import type AgenticLoopState from "../AgenticLoopState.ts";
import type {
  ConversationMessage,
  ToolCall,
  ToolSchema,
  ToolResult,
  AgenticOptions,
  BeforePromptHookContext,
  EmitFunction,
  PassState,
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

// ── Repetition/stall detection (simplified port of prism's detectors) ──
// A model cycling the SAME tool+args with non-error results is stalled but
// trips neither the consecutive-error brake nor plan mode — without this it
// burns every remaining iteration. After 3 identical consecutive calls we
// inject guidance; after 5 we terminate the loop.
const REPETITION_WARNING_THRESHOLD = 3;
const REPETITION_TERMINATION_THRESHOLD = 5;

/** Instruction appended before the final forced-answer pass. */
const FINALIZE_NOW_NOTICE =
  "Time or budget is up. Do not call tools. Answer the user now using only the information already gathered, and say briefly what you could not check.";

/**
 * Route a TOKEN_BUDGET_FINALIZE rejection into the final-answer path: allow
 * the budget's final reserve, flag the run for finalization, and warn.
 * Returns true when the error was a finalize request.
 */
function handleTokenBudgetFinalize(error: unknown, context: AgenticContext): boolean {
  if ((error as { code?: string } | null)?.code !== "TOKEN_BUDGET_FINALIZE") return false;
  const budget = context.canonicalBudget;
  if (!(budget instanceof CanonicalProviderBudget)) return false;
  budget.allowFinalPass();
  context.finalizeRequested = { reason: "TOKEN_BUDGET" };
  context.emit({
    type: "run.warning",
    data: {
      code: "TOKEN_BUDGET_SOFT",
      message: "Token budget reached; the run will answer now with the information already gathered.",
    },
  });
  return true;
}

/** Deterministically stringify a value with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    return `{${sortedKeys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Signature of an iteration's tool calls: (toolName, normalized args) pairs. */
function computeToolCallSignature(toolCalls: ToolCall[]): string {
  return toolCalls
    .map((toolCall) => `${toolCall.name}(${stableStringify(toolCall.args || {})})`)
    .sort()
    .join("|");
}

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
function handleStuckPatternInReAct(
  pattern: StuckPattern,
  stuckDetector: StuckDetector,
  state: AgenticLoopState,
  currentMessages: ConversationMessage[],
  emit: EmitFunction,
): boolean {
  if (stuckDetector.getStreak() >= 2) {
    logger.warn(
      `[ReActHarness] Stuck pattern "${pattern.pattern}" persisted across consecutive detections — ending run with status "stuck" on iteration ${state.iterations}.`,
    );
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: "stuck_terminated",
      iteration: state.iterations,
      pattern: pattern.pattern,
    });
    state.conversationOutcome = "stuck";
    return true;
  }
  logger.warn(
    `[ReActHarness] Stuck pattern "${pattern.pattern}" detected on iteration ${state.iterations} — injecting change-approach observation.`,
  );
  currentMessages.push({
    role: "system",
    _isSystemWarning: true,
    content: `[Loop guard] You are repeating pattern ${pattern.pattern}: ${pattern.description} You are repeating this pattern; change approach — use a different tool, different arguments, or conclude with the information you already have.`,
  });
  return false;
}

async function runReActFirstIterationHooks(
  harness: ReActHarness,
  currentMessages: ConversationMessage[],
  hooks: ReturnType<typeof createStandardHooks>["hooks"],
): Promise<void> {
  const context = harness["context"];
  const state = harness["state"];
  const tools = harness["tools"];
  const { options, conversationId, agentConversationId, traceId, project, username, agent, workspaceRoot, emit } =
    context;

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
    enabledTools: tools.resolvedEnabledTools,
    resolvedToolNames: tools.finalTools.map((tool: ToolSchema) => tool.name),
    workspaceRoot: workspaceRoot || undefined,
    workspaceEnabled: options.workspaceEnabled as boolean | undefined,
    locale: options.locale as string | undefined,
    loadedTools: state.loadedTools,
  };
  await hooks.run("beforePrompt", hookContext);

  if (hookContext._assembledSystemPrompt) {
    const assembledPrompt = hookContext._assembledSystemPrompt as string;
    context.conversationMeta = {
      ...(context.conversationMeta || {}),
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

  if (state.planModeActive) {
    await PlanningModeService.injectPlanningInstruction(currentMessages);
  }
}

function buildReActPassOptions(harness: ReActHarness): {
  passOptions: IterationPassOptions;
  allowedToolNames: Set<string>;
} {
  const { options, project, agent, username } = harness["context"];
  const state = harness["state"];
  const finalTools = harness["tools"].finalTools;
  const passOptions: IterationPassOptions = {
    ...options,
    project,
    agent,
    username,
  };
  if (state.planModeActive) {
    const planModeTools = finalTools.filter((tool: ToolSchema) => tool.name === TOOL_NAMES.EXIT_PLAN_MODE);
    passOptions.tools = planModeTools;
    logger.info(
      `[PlanningMode] Sending ${planModeTools.length} tools to provider: ${planModeTools.map((tool: ToolSchema) => tool.name).join(", ")}`,
    );
  } else {
    passOptions.tools = finalTools.filter((tool: ToolSchema) => {
      const cleanName = tool.name.replace(/^(mcp__[a-zA-Z0-9_-]+__)/, "");
      return tool.name === "describe_tools" || state.loadedTools.has(cleanName);
    });
  }
  const resolvedPassTools = passOptions.tools || [];
  const allowedToolNames = new Set(resolvedPassTools.map((tool: ToolSchema) => tool.name));
  return { passOptions, allowedToolNames };
}

async function streamReActPassWithOverflowRetry(
  harness: ReActHarness,
  currentMessages: ConversationMessage[],
  passOptions: IterationPassOptions,
  pass: PassState,
  allowedToolNames: Set<string>,
): Promise<{ stream: AsyncIterable<unknown> | null; messages: ConversationMessage[] }> {
  const context = harness["context"];
  const state = harness["state"];
  const { emit } = context;
  let stream: AsyncIterable<unknown> | null = null;
  let overflowRetried = false;
  let messages = currentMessages;

  while (true) {
    try {
      stream = await harness.createProviderStream(messages, passOptions);
    } catch (setupError: unknown) {
      if (handleTokenBudgetFinalize(setupError, context)) break;
      if (!overflowRetried && isContextWindowError(setupError)) {
        overflowRetried = true;
        logger.warn(
          `[ReActHarness] Context-window overflow creating stream on iteration ${state.iterations} — compacting older tool results and retrying once.`,
        );
        emit({ type: SERVER_SENT_EVENT_TYPES.STATUS, message: "context_overflow_retry", iteration: state.iterations });
        messages = compactToolResultsForPressure(messages, { force: true });
        continue;
      }
      throw setupError;
    }

    if (stream === null) break;

    const textBefore = pass.streamedText.length;
    const thinkingBefore = pass.streamedThinking.length;
    try {
      await harness.consumeStream(stream, pass, allowedToolNames);
      break;
    } catch (streamError: unknown) {
      if (handleTokenBudgetFinalize(streamError, context)) break;
      const consumedOutput =
        pass.streamedText.length > textBefore ||
        pass.streamedThinking.length > thinkingBefore ||
        pass.pendingToolCalls.length > 0;
      if (!overflowRetried && !consumedOutput && isContextWindowError(streamError)) {
        overflowRetried = true;
        logger.warn(
          `[ReActHarness] Context-window overflow on iteration ${state.iterations} — compacting older tool results and retrying once.`,
        );
        emit({ type: SERVER_SENT_EVENT_TYPES.STATUS, message: "context_overflow_retry", iteration: state.iterations });
        messages = compactToolResultsForPressure(messages, { force: true });
        continue;
      }
      throw streamError;
    }
  }
  return { stream, messages };
}

function handleReActValidationErrors(
  harness: ReActHarness,
  pass: PassState,
  results: ToolResult[],
  validationFeedback: Array<{ filePath: string; validatorType: string; rawOutput: string }>,
  currentMessages: ConversationMessage[],
  sandboxCheckpointReference: string | null,
): void {
  const { workspaceRoot, emit, options } = harness["context"];
  const locale = (options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale();
  const errorBlock = validationFeedback
    .map((feedback) => `### ${feedback.filePath} (${feedback.validatorType})\n${feedback.rawOutput}`)
    .join("\n\n");

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

  if (sandboxCheckpointReference) {
    restoreSandboxCheckpoint(workspaceRoot, sandboxCheckpointReference, emit);
  }

  currentMessages.push({
    role: "system",
    content:
      PromptLocaleService.get(locale, "harness.validationError.header", {
        errorCount: String(validationFeedback.length),
      }) +
      `\n\n${errorBlock}\n\n` +
      PromptLocaleService.get(locale, "harness.validationError.analyzePrompt"),
  });

  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.VALIDATION_ERRORS_DETECTED,
    count: validationFeedback.length,
  });
  harness.logIteration(pass, currentMessages);
}

async function executeReActToolTurn(
  harness: ReActHarness,
  pass: PassState,
  currentMessages: ConversationMessage[],
  hooks: ReturnType<typeof createStandardHooks>["hooks"],
  repetitionState: { lastSignature: string | null; repeatedCount: number },
  stuckDetector: StuckDetector,
): Promise<{
  action: "continue" | "break" | "return";
  messages: ConversationMessage[];
}> {
  const context = harness["context"];
  const state = harness["state"];
  const tools = harness["tools"];
  const { options, workspaceRoot, emit } = context;

  const toolCallSignature = computeToolCallSignature(pass.pendingToolCalls);
  if (toolCallSignature === repetitionState.lastSignature) {
    repetitionState.repeatedCount++;
  } else {
    repetitionState.lastSignature = toolCallSignature;
    repetitionState.repeatedCount = 1;
  }

  if (repetitionState.repeatedCount >= REPETITION_TERMINATION_THRESHOLD) {
    logger.warn(
      `[ReActHarness] Repetition limit reached on iteration ${state.iterations} — identical tool call(s) repeated ${repetitionState.repeatedCount} times in a row. Terminating loop. Signature: ${toolCallSignature.slice(0, 300)}`,
    );
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: "repetition_limit_reached",
      iteration: state.iterations,
      repeatCount: repetitionState.repeatedCount,
    });
    state.conversationOutcome = "stuck";
    harness.logIteration(pass, currentMessages);
    return { action: "break", messages: currentMessages };
  }

  if (state.planModeActive) {
    const { allBlocked } = blockUnauthorizedToolCalls(
      pass.pendingToolCalls,
      currentMessages,
      pass,
      state,
      options?.locale as string | undefined,
    );
    if (allBlocked) {
      harness.logIteration(pass, currentMessages);
      return { action: "continue", messages: currentMessages };
    }
  }

  context._currentMessages = currentMessages;
  const sandboxCheckpointReference = options.enableSandbox
    ? createSandboxCheckpoint(workspaceRoot, emit)
    : null;

  const results: ToolResult[] = await executeToolBatch(pass.pendingToolCalls, context, tools, hooks, state);
  await processToolResultMedia(pass.pendingToolCalls, results, state, pass, emit, context);
  trackToolErrors(pass.pendingToolCalls, results, state, MAX_CONSECUTIVE_TOOL_ERRORS, emit);
  emitPostExecutionStatus(pass.pendingToolCalls, emit);

  const validationFeedback = await validateAfterToolExecution(pass.pendingToolCalls, results, context, tools);
  if (validationFeedback.length > 0) {
    handleReActValidationErrors(harness, pass, results, validationFeedback, currentMessages, sandboxCheckpointReference);
    return { action: "continue", messages: currentMessages };
  }

  return finalizeReActToolTurn(
    harness,
    pass,
    results,
    currentMessages,
    repetitionState.repeatedCount,
    stuckDetector,
  );
}

async function finalizeReActToolTurn(
  harness: ReActHarness,
  pass: PassState,
  results: ToolResult[],
  currentMessages: ConversationMessage[],
  repeatedToolCallCount: number,
  stuckDetector: StuckDetector,
): Promise<{
  action: "continue" | "break" | "return";
  messages: ConversationMessage[];
}> {
  const context = harness["context"];
  const state = harness["state"];
  const { options, emit } = context;

  await checkForPlanModeEntry(
    pass.pendingToolCalls,
    currentMessages,
    state,
    emit,
    options?.locale as string | undefined,
  );

  const exitPlanToolCall = pass.pendingToolCalls.find((toolCall) => toolCall.name === TOOL_NAMES.EXIT_PLAN_MODE);
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
      if (context.runtimeToolExecutor) {
        throw Object.assign(new Error("Detached work cannot complete a canonical run"), { code: "INCOMPLETE_RUN" });
      }
      return { action: "return", messages: currentMessages };
    }
  }

  appendReActAssistantToolMessage(pass, results, currentMessages);
  appendReActRetryAndRepetitionGuidance(harness, pass, results, currentMessages, repeatedToolCallCount);

  let updatedMessages = currentMessages.filter(
    (message) =>
      !(
        message.role === "assistant" &&
        !message.content?.trim() &&
        (!message.toolCalls || message.toolCalls.length === 0)
      ),
  );

  injectToolDiscoveryNudge(pass.pendingToolCalls, results, updatedMessages, context);
  harness.checkAndApplyToolSetChanges(updatedMessages);

  for (const result of results) {
    stuckDetector.record({
      toolName: result.name,
      normalizedContent: normalizeContent(
        typeof result.result === "string" ? result.result : JSON.stringify(result.result) ?? "",
      ),
      isError: isErrorResult(result.result),
      isModelMonologue: false,
    });
  }
  const stuckPattern = stuckDetector.detect();
  if (stuckPattern && handleStuckPatternInReAct(stuckPattern, stuckDetector, state, updatedMessages, emit)) {
    harness.logIteration(pass, updatedMessages);
    return { action: "break", messages: updatedMessages };
  }

  updatedMessages = compactToolResultsForPressure(updatedMessages);
  harness.logIteration(pass, updatedMessages);
  return { action: "continue", messages: updatedMessages };
}

function appendReActAssistantToolMessage(
  pass: PassState,
  results: ToolResult[],
  currentMessages: ConversationMessage[],
): void {
  currentMessages.push({
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
  });
}

function appendReActRetryAndRepetitionGuidance(
  harness: ReActHarness,
  pass: PassState,
  results: ToolResult[],
  currentMessages: ConversationMessage[],
  repeatedToolCallCount: number,
): void {
  const { options, emit } = harness["context"];
  const state = harness["state"];
  const retryGuidanceMessage = buildToolRetryGuidance(
    pass.pendingToolCalls,
    results,
    state,
    MAX_CONSECUTIVE_TOOL_ERRORS,
    options?.locale as string | undefined,
  );
  if (retryGuidanceMessage) {
    currentMessages.push(retryGuidanceMessage);
  }

  if (repeatedToolCallCount >= REPETITION_WARNING_THRESHOLD) {
    logger.warn(
      `[ReActHarness] Repetition detected on iteration ${state.iterations} — identical tool call(s) repeated ${repeatedToolCallCount} times in a row. Injecting guidance.`,
    );
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: "repetition_detected",
      iteration: state.iterations,
      repeatCount: repeatedToolCallCount,
    });
    currentMessages.push({
      role: "system",
      content:
        `[Loop guard] You have now issued the exact same tool call(s) with identical arguments ${repeatedToolCallCount} times in a row. Repeating the call again will not produce different results. You MUST either change your approach (different tool or different arguments) or answer now using the information you already have. If the call repeats ${REPETITION_TERMINATION_THRESHOLD} times the loop will be terminated.`,
    });
  }
}

function handleReActNonToolTurn(
  harness: ReActHarness,
  pass: PassState,
  currentMessages: ConversationMessage[],
  stuckDetector: StuckDetector,
  recoveryCounters: { truncationCount: number; emptyOutputCount: number },
): "continue" | "clean_break" | "break" {
  const context = harness["context"];
  const state = harness["state"];
  const tools = harness["tools"];
  const { emit } = context;

  if (pass.streamedText) {
    if (state.planModeActive) {
      stuckDetector.record({
        toolName: "",
        normalizedContent: normalizeContent(pass.streamedText),
        isError: false,
        isModelMonologue: true,
      });
      const monologueStuck = stuckDetector.detect();
      if (monologueStuck && handleStuckPatternInReAct(monologueStuck, stuckDetector, state, currentMessages, emit)) {
        harness.logIteration(pass, currentMessages);
        return "break";
      }
      currentMessages.push({
        role: "assistant",
        content: pass.streamedText,
        ...(pass.streamedThinking.trim() && { thinking: pass.streamedThinking.trim() }),
        ...(pass.thinkingSignature && { thinkingSignature: pass.thinkingSignature }),
      });
      harness.logIteration(pass, currentMessages);
      return "continue";
    }

    const codexResult = handleCodexPlanningResponse(
      pass,
      currentMessages,
      context,
      state,
      tools.finalTools,
      "ReActHarness",
    );
    harness.logIteration(pass, currentMessages);
    return codexResult.shouldContinueLoop ? "continue" : "clean_break";
  }

  if (pass.streamedThinking.trim()) {
    logger.warn(
      `[AgenticLoop] Thinking-only response on iteration ${state.iterations} — thinking=${pass.streamedThinking.length}chars, text=0. Injecting continuation prompt to elicit text response.`,
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
        "[System: Your previous response contained only internal reasoning without producing any visible output. Your thinking has been preserved. Now respond concisely with your actual answer, analysis, or tool calls. Do not repeat your reasoning — act on it.]",
      _isSystemWarning: true,
    });
    harness.logIteration(pass, currentMessages);
    return "continue";
  }

  if (isOutputTruncated(pass)) {
    return handleReActTruncationRecovery(harness, pass, currentMessages, recoveryCounters);
  }

  return handleReActEmptyOutputRecovery(harness, pass, currentMessages, recoveryCounters);
}

function handleReActTruncationRecovery(
  harness: ReActHarness,
  pass: PassState,
  currentMessages: ConversationMessage[],
  recoveryCounters: { truncationCount: number; emptyOutputCount: number },
): "continue" | "break" {
  const context = harness["context"];
  const state = harness["state"];
  recoveryCounters.truncationCount++;
  const configuredMaxTokens = context.options.maxTokens || "default";
  const modelOutputCeiling = context.modelDefinition?.maxOutputTokens as number | undefined;
  logger.warn(
    `[AgenticLoop] Max tokens truncation detected on iteration ${state.iterations} — stopReason=${pass.stopReason}, maxTokens=${configuredMaxTokens}${modelOutputCeiling ? `, modelCeiling=${modelOutputCeiling}` : ""}. Recovery attempt ${recoveryCounters.truncationCount}/${MAX_OUTPUT_TRUNCATION_RECOVERIES}.`,
  );

  const alreadyAtCeiling =
    typeof configuredMaxTokens === "number" && isAtOutputCeiling(configuredMaxTokens, modelOutputCeiling);
  if (!alreadyAtCeiling && recoveryCounters.truncationCount <= MAX_OUTPUT_TRUNCATION_RECOVERIES) {
    context.options.maxTokens = injectContinuationContext(
      currentMessages,
      pass,
      context,
      recoveryCounters.truncationCount,
    );
    harness.logIteration(pass, currentMessages);
    return "continue";
  }

  if (alreadyAtCeiling) {
    logger.warn(
      `[AgenticLoop] Skipping truncation recovery — maxTokens (${configuredMaxTokens}) is already at or above model ceiling (${modelOutputCeiling}). Escalation would be pointless.`,
    );
  }
  const exhaustionMessage = buildExhaustedRecoveryMessage(
    alreadyAtCeiling ? 0 : MAX_OUTPUT_TRUNCATION_RECOVERIES,
    configuredMaxTokens,
    context.options?.locale as string | undefined,
  );
  injectErrorAsConversationMessage(currentMessages, exhaustionMessage, context);
  harness.logIteration(pass, currentMessages);
  return "break";
}

function handleReActEmptyOutputRecovery(
  harness: ReActHarness,
  pass: PassState,
  currentMessages: ConversationMessage[],
  recoveryCounters: { truncationCount: number; emptyOutputCount: number },
): "continue" | "break" {
  const context = harness["context"];
  const state = harness["state"];
  recoveryCounters.emptyOutputCount++;
  if (recoveryCounters.emptyOutputCount <= MAX_EMPTY_OUTPUT_RETRIES) {
    const currentTemperature = typeof context.options.temperature === "number" ? context.options.temperature : 0.7;
    context.options.temperature = Math.min(currentTemperature + EMPTY_OUTPUT_TEMPERATURE_BUMP, 1.5);
    logger.warn(
      `[AgenticLoop] Empty model output on iteration ${state.iterations} — retry ${recoveryCounters.emptyOutputCount}/${MAX_EMPTY_OUTPUT_RETRIES} (temperature=${context.options.temperature}).`,
    );
    currentMessages.push({
      role: "system",
      content: emptyOutputRecoveryNotice(),
      _isSystemWarning: true,
    });
    harness.logIteration(pass, currentMessages);
    return "continue";
  }

  logger.warn(
    `[AgenticLoop] Empty output recovery exhausted on iteration ${state.iterations} — text=${pass.streamedText.length}, thinking=${pass.streamedThinking.length}, toolCalls=${pass.pendingToolCalls.length}. Breaking.`,
  );
  harness.logIteration(pass, currentMessages);
  return "break";
}

async function runPostLoopReActRecovery(
  harness: ReActHarness,
  hasCleanTextBreak: boolean,
  currentMessages: ConversationMessage[],
): Promise<void> {
  const context = harness["context"];
  const state = harness["state"];
  const { signal } = context;

  if (
    !hasCleanTextBreak &&
    state.conversationOutcome !== "stuck" &&
    !signal?.aborted &&
    (context.finalizeRequested || state.streamedToolCalls.length > 0)
  ) {
    state.conversationOutcome = "exhausted";
    if (context.finalizeRequested) {
      currentMessages.push({
        role: "system",
        _isSystemWarning: true,
        content: FINALIZE_NOW_NOTICE,
      });
    }
    await runExhaustionRecoveryPass(harness, context, state, currentMessages);
  }

  if (
    context.runtimeToolExecutor &&
    !hasCleanTextBreak &&
    state.conversationOutcome !== "exhausted" &&
    state.conversationOutcome !== "stuck"
  ) {
    throw Object.assign(new Error("Canonical run ended without a final model turn"), { code: "INCOMPLETE_RUN" });
  }
}

export default class ReActHarness extends BaseAgenticHarness {
  static id = "standard";
  static label = "ReAct Loop";
  static description =
    "Reason→Act→Observe tool-use loop with plan mode, approval gating, and exhaustion recovery.";

  async run(): Promise<{ messages: ConversationMessage[] }> {
    const resolvedStructure = this.context.options.thoughtStructure;
    if (resolvedStructure === THOUGHT_STRUCTURES.TREE_OF_THOUGHTS) {
      logger.info(`[ReActHarness] Delegating to Tree of Thoughts thought structure`);
      return runTreeOfThoughts(this);
    }
    if (resolvedStructure === THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS) {
      logger.info(`[ReActHarness] Delegating to Graph of Thoughts thought structure`);
      return runGraphOfThoughts(this);
    }

    const context = this.context;
    const state = this.state;
    const { options, agentConversationId, workspaceRoot, emit, signal } = context;

    const clientMaxIterations = options.maxIterations;
    const resolvedMaxIterations =
      clientMaxIterations === 0
        ? Infinity
        : clientMaxIterations
          ? Math.min(100, Math.max(1, clientMaxIterations))
          : MAX_TOOL_ITERATIONS;

    let currentMessages: ConversationMessage[] = [...context.messages];
    const recoveryCounters = { truncationCount: 0, emptyOutputCount: 0 };
    const repetitionState = { lastSignature: null as string | null, repeatedCount: 0 };
    let hasCleanTextBreak = false;
    const stuckDetector = new StuckDetector();

    const { hooks } = createStandardHooks({
      workspaceRoot: workspaceRoot || undefined,
      enableCriticGate: options.enableCriticGate === true,
      criticModel: options.criticModel || undefined,
    });

    if (options.planFirst) {
      emit({ type: SERVER_SENT_EVENT_TYPES.STATUS, message: STATUS_MESSAGES.PLAN_MODE_ENTERED });
    }

    try {
      while (state.iterations < resolvedMaxIterations) {
        if (context.finalizeRequested) break;
        state.iterations++;

        emit({
          type: SERVER_SENT_EVENT_TYPES.STATUS,
          message: STATUS_MESSAGES.ITERATION_PROGRESS,
          iteration: state.iterations,
          maxIterations: resolvedMaxIterations,
        });

        await maybeInjectSystemReminder(currentMessages, state, context);

        if (state.iterations === 1) {
          await runReActFirstIterationHooks(this, currentMessages, hooks);
        }

        const { passOptions, allowedToolNames } = buildReActPassOptions(this);

        const steering = (context as any).runtimeSteering as string[] | undefined;
        if (steering?.length) {
          currentMessages.push(
            ...steering.splice(0).map((content) => ({ role: "user", content: `Updated user instruction: ${content}` })),
          );
        }

        const pressureResult = await manageContextPressure(currentMessages, context, state, "ReActHarness");
        currentMessages = this.enforceContextWindow(pressureResult.messages, this.tools.finalTools.length);

        const pass = this.createPassState(passOptions);
        const requestIdBase = context.requestId || agentConversationId || crypto.randomUUID();
        const passRequestId = `${requestIdBase}-iter-${state.iterations}`;
        pass.requestId = passRequestId;
        this.registerTrackerRequest(passRequestId);

        const streamOutcome = await streamReActPassWithOverflowRetry(
          this,
          currentMessages,
          passOptions,
          pass,
          allowedToolNames,
        );
        currentMessages = streamOutcome.messages;
        const stream = streamOutcome.stream;

        if (context.finalizeRequested) break;

        if (stream === null) {
          logger.warn(
            `[ReActHarness] Context exhaustion guard fired on iteration ${state.iterations} — skipping provider call, triggering exhaustion recovery.`,
          );
          injectErrorAsConversationMessage(
            currentMessages,
            `Context window exhausted on iteration ${state.iterations}: the remaining output token budget is too small to produce a complete response. The conversation history has consumed nearly the entire context window.`,
            context,
          );
          state.conversationOutcome = "exhausted";
          this.logIteration(pass, currentMessages);
          break;
        }

        await this.consumeStream(stream, pass, allowedToolNames);

        finalizePassTracker(pass, passRequestId);
        logKVCacheHitRate(pass.usage, state.iterations, "ReActHarness");
        this.emitGenerationProgress();
        if (signal?.aborted) break;
        this.emitUsageUpdate();

        if (
          await checkCostBudget(state, context.resolvedModel, options.maxCostDollars, emit, context.conversationId, {
            signal: context.signal,
            pauseTimeoutMs: options.budgetPauseTimeoutMs,
          })
        ) {
          break;
        }

        if (pass.pendingToolCalls.length > 0) {
          const toolTurn = await executeReActToolTurn(
            this,
            pass,
            currentMessages,
            hooks,
            repetitionState,
            stuckDetector,
          );
          currentMessages = toolTurn.messages;
          if (toolTurn.action === "return") return { messages: currentMessages };
          if (toolTurn.action === "break") break;
          continue;
        }

        const nonToolAction = handleReActNonToolTurn(
          this,
          pass,
          currentMessages,
          stuckDetector,
          recoveryCounters,
        );
        if (nonToolAction === "continue") continue;
        if (nonToolAction === "clean_break") hasCleanTextBreak = true;
        break;
      }

      await runPostLoopReActRecovery(this, hasCleanTextBreak, currentMessages);

      cleanupReminderCache(agentConversationId);
      await this.finalize(currentMessages, hooks);
      return { messages: currentMessages };
    } catch (loopError: unknown) {
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
