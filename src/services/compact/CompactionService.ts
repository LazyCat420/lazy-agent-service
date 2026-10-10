import crypto from "crypto";
import { getProvider } from "../../providers/index.ts";
import { getInstancesByType, getInstanceType } from "../../providers/instance-registry.ts";
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
import MemoryExtractor from "../MemoryExtractor.ts";
import type { ConversationMessage } from "../harnesses/types.ts";
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
  /**
   * Optional injection seam for tests: replaces the default
   * MemoryExtractor.extractAndStore flush. Receives nothing, returns a
   * promise that is awaited before summarization.
   */
  memoryFlush?: () => Promise<unknown>;
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

    // ── Memory flush before compaction (N7) ────────────────────
    // Summarization drops the pre-boundary history, so any pending
    // memory extraction must run first or the facts it would capture
    // are lost. Awaited; failure is logged and compaction continues.
    try {
      if (options.memoryFlush) {
        await options.memoryFlush();
      } else {
        await MemoryExtractor.extractAndStore({
          project: options.project,
          username: options.username,
          messages: messages as unknown as ConversationMessage[],
          traceId: options.traceId || null,
          agentConversationId: options.agentConversationId || null,
          agent: options.agent || null,
          emit: options.emit ?? null,
        });
      }
    } catch (error: unknown) {
      logger.warn(
        `[CompactionService] Memory flush before compaction failed (continuing): ${errorMessage(error)}`,
      );
    }

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

      const baseType = getInstanceType(compactionProvider) || compactionProvider;
      let siblings = getInstancesByType(baseType);
      let modelRes = await resolveModelForInstances(resolvedModel, siblings);
      let usable = modelRes.usable;
      let modelOverrides = modelRes.modelOverrides;

      if (usable.length === 0) {
        throw new Error(
          `[CompactionService] Model resolution failed: "${compactionModel}" is not loaded on any instances of provider type "${baseType}".`
        );
      }

      targetProviderId = usable[0].id;
      const override = modelOverrides.get(targetProviderId);
      if (override) {
        resolvedModel = override;
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
    const recentTail = extractRecentTail(messages);

    // ── Pair-aware drop filter (N7) ────────────────────────────
    // The dropped range is everything not kept (system + recent tail).
    // An assistant toolCalls message and its tool results must be
    // dropped together: never orphan a tool result whose owning
    // assistant is summarized away, and never keep an assistant whose
    // tool result was dropped.
    const keptFlags = messages.map(
      (message) => message === systemMessage || recentTail.includes(message),
    );
    const pairKeptFlags = enforceToolPairIntegrity(messages, keptFlags);
    const keptSystem = systemMessage && pairKeptFlags[messages.indexOf(systemMessage)]
      ? systemMessage
      : undefined;
    const keptTail = messages.filter(
      (message, index) =>
        pairKeptFlags[index] && message !== systemMessage && message.role !== "system",
    );

    const compactedMessages: AdminChatMessage[] = [];

    if (keptSystem) {
      compactedMessages.push(keptSystem);
    }

    // Insert the summary as a user message with a marker
    compactedMessages.push({
      role: "user",
      content: `${PROMPT_DELIMITERS.CONVERSATION_SUMMARY_PREFIX} — auto-generated by compaction]\n\n${summaryText}`,
      isCompactSummary: true,
    });

    // Append recent tail (last few turns the model is actively reasoning about)
    compactedMessages.push(...keptTail);

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

// ── Helper: Tool-pair integrity over the drop range ───────────

function owningAssistantIndex(
  messages: AdminChatMessage[],
  toolIndex: number,
): number {
  for (let i = toolIndex - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].toolCalls?.length) {
      return i;
    }
  }
  return -1;
}

/**
 * Enforce pair-aware dropping over a kept-flags array (N7).
 *
 * Given `messages` and a boolean `kept` mask (true = survives
 * compaction), returns a new mask where tool-call pairs are never
 * split:
 *   - a role:"tool" result message survives only if its owning
 *     assistant-with-toolCalls message also survives and declares a
 *     matching toolCall id;
 *   - an assistant-with-toolCalls message is dropped when any of its
 *     tool results (matched by id) was already marked dropped.
 *
 * Tool results stored inline (toolCall.result on the assistant) move
 * with their assistant automatically — no separate message exists.
 * Fixpoint iteration handles cascades in either direction.
 */
export function enforceToolPairIntegrity(
  messages: AdminChatMessage[],
  kept: boolean[],
): boolean[] {
  const result = [...kept];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < messages.length; i++) {
      if (!result[i]) continue;
      const message = messages[i];

      if (message.role === "tool") {
        const owner = owningAssistantIndex(messages, i);
        const callId = message.tool_call_id;
        const ownerDeclaresCall =
          owner !== -1 &&
          (!callId || messages[owner].toolCalls!.some((tc) => tc.id === callId));
        if (owner === -1 || !result[owner] || !ownerDeclaresCall) {
          result[i] = false;
          changed = true;
        }
        continue;
      }

      if (message.role === "assistant" && message.toolCalls?.length) {
        for (const toolCall of message.toolCalls) {
          if (!toolCall.id) continue;
          const resultIndex = messages.findIndex(
            (candidate, index) =>
              index > i &&
              candidate.role === "tool" &&
              candidate.tool_call_id === toolCall.id,
          );
          if (resultIndex !== -1 && !result[resultIndex]) {
            result[i] = false;
            changed = true;
            break;
          }
        }
      }
    }
  }
  return result;
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
