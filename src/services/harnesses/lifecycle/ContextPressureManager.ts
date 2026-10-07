import logger from "../../../utils/logger.ts";
import { errorMessage } from "@rodrigo-barraza/utilities-library";

import MicroCompactionService from "../../compact/MicroCompactionService.ts";
import AutoCompactionTrigger from "../../compact/AutoCompactionTrigger.ts";
import CompactionService from "../../compact/CompactionService.ts";
import ConversationEmbeddingService from "../../ConversationEmbeddingService.ts";
import ContextWindowManager from "../../../utils/ContextWindowManager.ts";
import {
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from "../../../constants/TokenBudgetDefaults.ts";

import type AgenticLoopState from "../../AgenticLoopState.ts";
import type { ChatMessage } from "../../../types/admin.ts";
import type { ConversationMessage, AgenticContext } from "../types.ts";

/**
 * ContextPressureManager — unified context management pipeline.
 *
 * Orchestrates three sequential operations that must run in this
 * exact order every iteration to keep the context window healthy:
 *
 *   1. Micro-compaction (pressure-gated at >70%) — clears old tool
 *      results when the context is near capacity, but skips when
 *      pressure is low to preserve the append-only prefix property
 *      required for KV cache reuse across iterations.
 *
 *   2. Auto-compaction trigger — evaluates whether LLM-powered
 *      summarization is needed (even after micro-compaction) and
 *      executes it when the token count exceeds the threshold.
 *
 *   3. Compaction summary persistence — when auto-compaction fires,
 *      persists the summary text to ConversationEmbeddingService
 *      as a free embedding source (no additional LLM call needed).
 *
 * Extracted from ReActHarness (lines 244–341) to eliminate ~80 lines
 * of duplicated inline code across all harness implementations.
 */

const CONTEXT_PRESSURE_THRESHOLD = 0.7;

interface ContextPressureResult {
  messages: ConversationMessage[];
  tokenEstimate: number;
}

/**
 * Run the full context pressure management pipeline.
 *
 * Returns the (possibly compacted) message array and the current
 * token estimate for downstream context window enforcement.
 */
export async function manageContextPressure(
  currentMessages: ConversationMessage[],
  context: AgenticContext,
  state: AgenticLoopState,
  harnessLabel: string,
): Promise<ContextPressureResult> {
  const { emit, signal } = context;
  const contextWindowSize =
    context.modelDefinition?.maxInputTokens || DEFAULT_MAX_INPUT_TOKENS;
  const maxOutputTokens = context.options.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS;
  const availableInputBudget = contextWindowSize - maxOutputTokens;

  let messages = currentMessages;
  let currentTokenEstimate = ContextWindowManager.estimateTokens(
    messages as ChatMessage[],
  );

  // ── 1. Micro-compaction (pressure-gated) ────────────────────
  // Only run when context usage exceeds 70% of the available input
  // budget. Running unconditionally mutates tool results in the
  // middle of the prompt prefix, invalidating the LLM's KV cache
  // and forcing a full re-prefill on subsequent iterations.
  const contextPressureRatio =
    availableInputBudget > 0
      ? currentTokenEstimate / availableInputBudget
      : 0;

  if (contextPressureRatio > CONTEXT_PRESSURE_THRESHOLD) {
    await context.hooks?.run("preCompact", {
      reason: "micro-compaction",
      pressureRatio: contextPressureRatio,
    });
    const microCompactionResult =
      MicroCompactionService.microcompactMessages(
        messages as ChatMessage[],
      );
    if (microCompactionResult.clearedResultCount > 0) {
      messages =
        microCompactionResult.messages as ConversationMessage[];
      currentTokenEstimate = ContextWindowManager.estimateTokens(
        messages as ChatMessage[],
      );
      await context.hooks?.run("postCompact", {
        reason: "micro-compaction",
        freedTokens: microCompactionResult.freedTokens,
      });
      logger.info(
        `[${harnessLabel}] Micro-compaction at ${(contextPressureRatio * 100).toFixed(0)}% context pressure — ` +
          `freed ~${microCompactionResult.freedTokens} tokens`,
      );
    }
  }

  // ── 2. Auto-compaction trigger ──────────────────────────────
  // After potential micro-compaction, check if LLM-powered
  // compaction is also needed. This produces an intelligent
  // summary instead of just dropping messages.
  const autoCompactEvaluation = AutoCompactionTrigger.evaluate(
    currentTokenEstimate,
    contextWindowSize,
    maxOutputTokens,
    messages.length,
  );

  if (autoCompactEvaluation.shouldCompact) {
    const compactionResult = await CompactionService.compactConversation(
      messages as ChatMessage[],
      {
        project: context.project || "",
        username: context.username || "",
        agentConversationId: context.agentConversationId,
        traceId: context.traceId || null,
        agent: context.agent || null,
        emit,
        signal: signal || undefined,
      },
    );

    if (compactionResult) {
      messages =
        compactionResult.compactedMessages as ConversationMessage[];
      state.originalMessageCount = messages.length;
      state.compactionPerformed = true;
      state.preCompactTokenCount = compactionResult.preCompactTokenCount;
      state.postCompactTokenCount =
        compactionResult.postCompactTokenCount;

      currentTokenEstimate = ContextWindowManager.estimateTokens(
        messages as ChatMessage[],
      );

      // ── 3. Compaction summary persistence ─────────────────
      // Persist summary to ConversationEmbeddingService as a free
      // embedding source — no additional LLM call needed.
      if (compactionResult.summaryText && context.conversationId) {
        ConversationEmbeddingService.persistCompactionSummary(
          context.conversationId,
          context.project || "",
          context.username || "",
          compactionResult.summaryText,
        ).catch((error: unknown) =>
          logger.error(
            `[${harnessLabel}] Failed to persist compaction summary: ${errorMessage(error)}`,
          ),
        );
      }

      logger.info(
        `[${harnessLabel}] Auto-compacted: ${compactionResult.preCompactTokenCount} → ` +
          `${compactionResult.postCompactTokenCount} tokens ` +
          `(${messages.length} messages remain)`,
      );
    }
  }

  return { messages, tokenEstimate: currentTokenEstimate };
}
