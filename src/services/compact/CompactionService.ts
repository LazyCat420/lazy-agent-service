import crypto from "crypto";
import { getProvider } from "../../providers/index.ts";
import { getInstancesByType } from "../../providers/instance-registry.ts";
import { resolveModelForInstances } from "../../utils/ModelResolution.ts";
import SettingsService from "../SettingsService.ts";
import RequestLogger from "../RequestLogger.ts";
import logger from "../../utils/logger.ts";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { PROMPT_DELIMITERS } from "../../constants.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import {
  estimateTokens,
  calculateTextCost,
} from "../../utils/CostCalculator.ts";
import { TYPES, getPricing } from "../../config.ts";
import {
  COMPACTION_SYSTEM_PROMPT,
  COMPACTION_USER_PROMPT,
  extractSummaryFromResponse,
  stripImagesFromMessages,
} from "./CompactionPrompt.ts";
import type { ChatMessage as AdminChatMessage } from "../../types/admin.ts";
import type { ChatMessage, GenerateTextResult } from "../../types/provider.ts";
import type { EmitFunction } from "../harnesses/types.ts";

// ────────────────────────────────────────────────────────────
// CompactionService — LLM-Powered Conversation Summarization
// ────────────────────────────────────────────────────────────
// Modeled after claude-code/src/services/compact/compact.ts
//
// Instead of mechanically truncating messages, this service calls
// an LLM to produce a structured summary of the conversation.
// The summary replaces all pre-boundary messages, preserving
// user intent, code context, error history, and pending tasks.
//
// Claude Code reference (compactConversation):
//   1. Strip images from messages
//   2. Build summarization request with COMPACTION_PROMPT
//   3. Call LLM (forked agent, maxTurns: 1)
//   4. Extract <summary> from response (strip <analysis> scratchpad)
//   5. Build compacted array: [boundary, summary, ...recentTail]
//
// Key constants from Claude Code:
//   COMPACT_MAX_OUTPUT_TOKENS = 16_384
//   MAX_COMPACT_STREAMING_RETRIES = 2
//   MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
// ────────────────────────────────────────────────────────────

const COMPACT_MAX_OUTPUT_TOKENS = 16_384;

/**
 * Circuit breaker: stop retrying after this many consecutive failures.
 *
 * From claude-code/src/services/compact/autoCompact.ts:
 *   "BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures
 *    (up to 3,272) in a single session, wasting ~250K API calls/day globally."
 */
const MAX_CONSECUTIVE_COMPACT_FAILURES = 3;

export interface CompactionResult {
  compactedMessages: AdminChatMessage[];
  summaryText: string;
  preCompactTokenCount: number;
  postCompactTokenCount: number;
  compactionUsage: { inputTokens: number; outputTokens: number };
}

interface CompactionOptions {
  project: string;
  username: string;
  agentConversationId?: string;
  traceId?: string | null;
  agent?: string | null;
  emit?: EmitFunction | null;
  signal?: AbortSignal;
}

interface MemorySettingsSection {
  extractionProvider?: string;
  extractionModel?: string;
}

function estimateTotalTokens(messages: AdminChatMessage[]): number {
  return messages.reduce((sum, message) => {
    let tokens = 4;
    if (message.content) {
      tokens += estimateTokens(
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content),
      );
    }
    if (message.thinking) tokens += estimateTokens(message.thinking);
    if (message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        tokens += estimateTokens(toolCall.name || "");
        tokens += estimateTokens(
          toolCall.args ? JSON.stringify(toolCall.args) : "",
        );
        if (toolCall.result) {
          tokens += estimateTokens(
            typeof toolCall.result === "string"
              ? toolCall.result
              : JSON.stringify(toolCall.result),
          );
        }
      }
    }
    return sum + tokens;
  }, 0);
}

export default class CompactionService {
  private static consecutiveFailures = 0;

  /**
   * Summarize a conversation using an LLM call.
   *
   * Returns the compacted message array: [system, summary, ...recentTail]
   * or null if compaction was skipped or failed.
   *
   * Modeled after claude-code compactConversation() which:
   *   1. Strips images (saves tokens)
   *   2. Sends full conversation + summarization prompt to a forked agent
   *   3. Extracts <summary> from the response
   *   4. Builds: [CompactBoundary, SummaryUserMessage, ...recentTail]
   */
  static async compactConversation(
    messages: AdminChatMessage[],
    options: CompactionOptions,
  ): Promise<CompactionResult | null> {
    // ── Circuit breaker ────────────────────────────────────────
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) {
      logger.warn(
        `[CompactionService] Circuit breaker open: ${this.consecutiveFailures} consecutive failures. Skipping compaction.`,
      );
      return null;
    }

    // ── Resolve compaction model from settings ─────────────────
    // Uses the same provider/model config path as MemoryExtractor
    let compactionProvider: string | undefined;
    let compactionModel: string | undefined;
    try {
      const memorySettings = (await SettingsService.getSection(
        "memory",
      )) as MemorySettingsSection;
      compactionProvider = memorySettings?.extractionProvider;
      compactionModel = memorySettings?.extractionModel;
    } catch {
      logger.info(
        "[CompactionService] Settings not configured. Skipping compaction.",
      );
      return null;
    }

    if (!compactionProvider || !compactionModel) {
      logger.info(
        "[CompactionService] No compaction model configured in Settings → Memory Models. Skipping.",
      );
      return null;
    }

    const preCompactTokenCount = estimateTotalTokens(messages);

    // ── Strip images before summarizing ────────────────────────
    // Claude Code equivalent: stripImagesFromMessages() in compact.ts
    const strippedMessages = stripImagesFromMessages(messages);

    // ── Build the conversation text for summarization ──────────
    // Build a compact text representation of the conversation
    // (same approach as MemoryExtractor — compact format saves tokens)
    const conversationText = strippedMessages
      .map((message) => {
        const role = message.role;
        const content =
          typeof message.content === "string" ? message.content : "";

        // Include tool call summaries for context
        const toolSummary = message.toolCalls?.length
          ? `\n[Tools used: ${message.toolCalls
              .map((toolCall) => {
                const resultPreview = toolCall.result
                  ? typeof toolCall.result === "string"
                    ? toolCall.result.slice(0, 300)
                    : JSON.stringify(toolCall.result).slice(0, 300)
                  : "";
                return `${toolCall.name}(${resultPreview ? `→ ${resultPreview}...` : ""})`;
              })
              .join(", ")}]`
          : "";

        return `${role}: ${content}${toolSummary}`;
      })
      .join("\n\n");

    // ── Build summarization messages ───────────────────────────
    const summarizationMessages: ChatMessage[] = [
      { role: "system", content: COMPACTION_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Here is the conversation to summarize:\n\n${conversationText}\n\n${COMPACTION_USER_PROMPT}`,
      },
    ];

    // ── Call the LLM ──────────────────────────────────────────
    options.emit?.({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.COMPACTION_STARTED,
    });

    const requestId = crypto.randomUUID();
    const requestStart = performance.now();
    let result: GenerateTextResult | undefined;
    let success = true;
    let compactionError: string | null = null;

    try {
      let resolvedModel = compactionModel;
      let targetProviderId = compactionProvider;

      let siblings = getInstancesByType(compactionProvider);
      let modelRes = await resolveModelForInstances(resolvedModel, siblings);
      let usable = modelRes.usable;
      let modelOverrides = modelRes.modelOverrides;

      if (usable.length === 0 && compactionProvider.startsWith("vllm")) {
        const otherProvider = compactionProvider === "vllm" ? "vllm-2" : "vllm";
        const otherSiblings = getInstancesByType(otherProvider);
        const otherRes = await resolveModelForInstances(resolvedModel, otherSiblings);
        if (otherRes.usable.length > 0) {
          usable = otherRes.usable;
          modelOverrides = otherRes.modelOverrides;
          targetProviderId = otherProvider;
        }
      }

      if (usable.length > 0) {
        targetProviderId = usable[0].id;
        const override = modelOverrides.get(targetProviderId);
        if (override) {
          resolvedModel = override;
        }
      }

      const provider = getProvider(targetProviderId);
      result = await provider.generateText(
        summarizationMessages,
        resolvedModel,
        {
          maxTokens: COMPACT_MAX_OUTPUT_TOKENS,
          temperature: 0.1,
          thinkingEnabled: false,
        },
      );
    } catch (error: unknown) {
      success = false;
      compactionError = errorMessage(error);
      this.consecutiveFailures++;
      logger.error(
        `[CompactionService] LLM call failed (failure ${this.consecutiveFailures}/${MAX_CONSECUTIVE_COMPACT_FAILURES}): ${compactionError}`,
      );
      options.emit?.({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.COMPACTION_FAILED,
      });
      return null;
    } finally {
      // Log the compaction LLM call for cost tracking
      const realUsage = result?.usage || null;
      RequestLogger.logBackgroundLlmCall({
        requestId,
        endpoint: "/agent",
        operation: "compact:summarize",
        project: options.project,
        username: options.username,
        agent: options.agent || null,
        provider: compactionProvider,
        model: compactionModel,
        traceId: options.traceId || null,
        agentConversationId: options.agentConversationId || null,
        aiMessages: summarizationMessages as Parameters<
          typeof RequestLogger.logBackgroundLlmCall
        >[0]["aiMessages"],
        resultText: result?.text || "",
        usage: realUsage,
        success,
        errorMessage: compactionError,
        requestStartMs: requestStart,
        extraRequestPayload: {
          operation: "compact:summarize",
          preCompactTokenCount,
          messageCount: messages.length,
        },
      });
    }

    // ── Extract summary from response ─────────────────────────
    const summaryText = extractSummaryFromResponse(result!.text);
    if (!summaryText) {
      this.consecutiveFailures++;
      logger.warn(
        `[CompactionService] LLM returned no extractable summary. Failure ${this.consecutiveFailures}/${MAX_CONSECUTIVE_COMPACT_FAILURES}`,
      );
      options.emit?.({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.COMPACTION_FAILED,
      });
      return null;
    }

    // ── Build compacted message array ─────────────────────────
    // Structure: [system prompt, summary as user message, ...recent tail]
    const systemMessage = messages.find((message) => message.role === "system");
    const compactedMessages: AdminChatMessage[] = [];

    if (systemMessage) {
      compactedMessages.push(systemMessage);
    }

    // Insert the summary as a user message with a marker
    compactedMessages.push({
      role: "user",
      content: `${PROMPT_DELIMITERS.CONVERSATION_SUMMARY_PREFIX} — auto-generated by compaction]\n\n${summaryText}`,
      isCompactSummary: true,
    });

    // Append recent tail (last few turns the model is actively reasoning about)
    const recentTail = extractRecentTail(messages);
    compactedMessages.push(...recentTail);

    const postCompactTokenCount = estimateTotalTokens(compactedMessages);

    // ── Reset circuit breaker on success ──────────────────────
    this.consecutiveFailures = 0;

    logger.info(
      `[CompactionService] Compaction complete: ${preCompactTokenCount} → ${postCompactTokenCount} tokens ` +
        `(${Math.round((1 - postCompactTokenCount / preCompactTokenCount) * 100)}% reduction, ` +
        `${messages.length} → ${compactedMessages.length} messages)`,
    );

    options.emit?.({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.COMPACTION_COMPLETE,
      preCompactTokens: preCompactTokenCount,
      postCompactTokens: postCompactTokenCount,
    });

    // Emit usage for the compaction call so the UI token badge updates
    if (options.emit && result?.usage) {
      try {
        const compactPricing = getPricing(TYPES.TEXT, TYPES.TEXT)[
          compactionModel
        ];
        const compactCost = compactPricing
          ? calculateTextCost(
              {
                inputTokens: result.usage.inputTokens || 0,
                outputTokens: result.usage.outputTokens || 0,
              },
              compactPricing,
            )
          : null;
        options.emit({
          type: SERVER_SENT_EVENT_TYPES.USAGE_UPDATE,
          operation: "compact:summarize",
          usage: {
            requests: 1,
            inputTokens: result.usage.inputTokens || 0,
            outputTokens: result.usage.outputTokens || 0,
            estimatedCost: compactCost,
          },
        });
      } catch {
        /* SSE channel may be closed */
      }
    }

    return {
      compactedMessages,
      summaryText,
      preCompactTokenCount,
      postCompactTokenCount,
      compactionUsage: result!.usage || { inputTokens: 0, outputTokens: 0 },
    };
  }

  /** Reset the circuit breaker (for testing or session boundaries). */
  static resetCircuitBreaker(): void {
    this.consecutiveFailures = 0;
  }
}

// ── Helper: Extract recent conversation tail ──────────────────

/**
 * Extract the most recent user turns and their assistant responses.
 * These are appended after the summary so the model has immediate
 * context to continue from.
 *
 * Claude Code equivalent: the "messagesToKeep" logic in compact.ts
 * which preserves the last N turns after compaction.
 */
const RECENT_TAIL_TURN_COUNT = 3;

function extractRecentTail(messages: AdminChatMessage[]): AdminChatMessage[] {
  // Walk backwards counting user turns
  let userTurnsSeen = 0;
  // Default to 0 so that if the conversation has fewer user turns than
  // RECENT_TAIL_TURN_COUNT, we preserve all messages (except system)
  // in the tail instead of discarding the entire history.
  let tailStartIndex = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userTurnsSeen++;
      if (userTurnsSeen >= RECENT_TAIL_TURN_COUNT) {
        tailStartIndex = i;
        break;
      }
    }
  }

  // Extract the tail, skipping system messages (already in compactedMessages)
  return messages
    .slice(tailStartIndex)
    .filter((message) => message.role !== "system");
}
