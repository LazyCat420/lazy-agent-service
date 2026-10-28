import crypto from "crypto";
import { getProvider } from "../../providers/index.ts";
import { DynamicModelResolver } from "../DynamicModelResolver.ts";
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

/**
 * Shrink-check cooldown (ported from prism-service COMPACTION.
 * NO_SHRINK_RETRY_GROWTH_FRACTION): after a summary that failed to shrink
 * the history, compaction is skipped until the conversation has grown this
 * fraction past the point that failed.
 */
const NO_SHRINK_RETRY_GROWTH_FRACTION = 0.1;

/** Did compaction actually make the conversation smaller? Test seam for the shrink check. */
export function compactionShrank(
  preCompactTokenCount: number,
  postCompactTokenCount: number,
): boolean {
  return postCompactTokenCount < preCompactTokenCount;
}

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
  /**
   * Per-conversation consecutive-failure counts (ch.06 item 6): one bad
   * conversation no longer opens the breaker for every other one. Keyed by
   * agentConversationId; unkeyed calls share the "default" bucket.
   */
  private static consecutiveFailures = new Map<string, number>();

  private static breakerKey(options: CompactionOptions): string {
    return options.agentConversationId || "default";
  }

  /**
   * Token counts of the conversation at which the last compaction FAILED
   * to shrink it (per conversation) — the shrink check's cooldown: retry
   * only once the history has grown NO_SHRINK_RETRY_GROWTH_FRACTION past
   * that point, instead of paying for a summary that cannot shrink it.
   */
  private static noShrinkAtTokens = new Map<string, number>();

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
  private static async resolveCompactionProviderAndModel(): Promise<{
    compactionProvider: string;
    compactionModel: string;
  } | null> {
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

    const isDefaultOrEmpty =
      !compactionProvider ||
      !compactionModel ||
      compactionModel === "default-model";

    if (isDefaultOrEmpty) {
      try {
        const aux = DynamicModelResolver.resolveAuxModel("compression");
        compactionProvider = aux.provider;
        compactionModel = aux.model;
      } catch {
        compactionProvider = undefined;
        compactionModel = undefined;
      }
    }
    if (
      !compactionProvider ||
      !compactionModel ||
      compactionModel === "default-model"
    ) {
      logger.info(
        "[CompactionService] No compaction model (Settings → Memory Models or aux compression chain). Skipping.",
      );
      return null;
    }
    return { compactionProvider, compactionModel };
  }

  private static formatConversationForSummarization(
    strippedMessages: AdminChatMessage[],
  ): string {
    return strippedMessages
      .map((message) => {
        const role = message.role;
        const content =
          typeof message.content === "string" ? message.content : "";
        if (!message.toolCalls?.length) {
          return `${role}: ${content}`;
        }
        const toolEntries = message.toolCalls.map((toolCall) => {
          if (!toolCall.result) return `${toolCall.name}()`;
          const preview =
            typeof toolCall.result === "string"
              ? toolCall.result.slice(0, 300)
              : JSON.stringify(toolCall.result).slice(0, 300);
          return `${toolCall.name}(→ ${preview}...)`;
        });
        return `${role}: ${content}\n[Tools used: ${toolEntries.join(", ")}]`;
      })
      .join("\n\n");
  }

  private static async flushMemoryBeforeCompaction(
    messages: AdminChatMessage[],
    options: CompactionOptions,
  ): Promise<void> {
    const flushTimeoutMs =
      Number(process.env.COMPACTION_MEMORY_FLUSH_TIMEOUT_MS) || 30_000;
    let flushTimer: NodeJS.Timeout | undefined;
    try {
      const flush = options.memoryFlush
        ? options.memoryFlush()
        : MemoryExtractor.extractAndStore({
            project: options.project,
            username: options.username,
            messages: messages as unknown as ConversationMessage[],
            traceId: options.traceId || null,
            agentConversationId: options.agentConversationId || null,
            agent: options.agent || null,
            emit: options.emit ?? null,
          });
      flush.catch(() => {});
      await Promise.race([
        flush,
        new Promise((_, reject) => {
          flushTimer = setTimeout(
            () => reject(new Error(`timed out after ${flushTimeoutMs} ms`)),
            flushTimeoutMs,
          );
        }),
      ]);
    } catch (error: unknown) {
      logger.warn(
        `[CompactionService] Memory flush before compaction failed (continuing): ${errorMessage(error)}`,
      );
    } finally {
      clearTimeout(flushTimer);
    }
  }

  private static async executeCompactionLlmCall(
    summarizationMessages: ChatMessage[],
    compactionProvider: string,
    compactionModel: string,
    breakerKey: string,
    preCompactTokenCount: number,
    messageCount: number,
    options: CompactionOptions,
  ): Promise<GenerateTextResult | null> {
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
      const baseType = getInstanceType(compactionProvider) || compactionProvider;
      const siblings = getInstancesByType(baseType);
      const modelRes = await resolveModelForInstances(resolvedModel, siblings);
      if (modelRes.usable.length === 0) {
        throw new Error(
          `[CompactionService] Model resolution failed: "${compactionModel}" is not loaded on any instances of provider type "${baseType}".`,
        );
      }

      const targetProviderId = modelRes.usable[0].id;
      const override = modelRes.modelOverrides.get(targetProviderId);
      if (override) resolvedModel = override;

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
      return result;
    } catch (error: unknown) {
      success = false;
      compactionError = errorMessage(error);
      const failures = (this.consecutiveFailures.get(breakerKey) ?? 0) + 1;
      this.consecutiveFailures.set(breakerKey, failures);
      logger.error(
        `[CompactionService] LLM call failed (failure ${failures}/${MAX_CONSECUTIVE_COMPACT_FAILURES} for ${breakerKey}): ${compactionError}`,
      );
      options.emit?.({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.COMPACTION_FAILED,
      });
      return null;
    } finally {
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
        usage: result?.usage || null,
        success,
        errorMessage: compactionError,
        requestStartMs: requestStart,
        extraRequestPayload: {
          operation: "compact:summarize",
          preCompactTokenCount,
          messageCount,
        },
      });
    }
  }

  private static assembleCompactedMessageArray(
    messages: AdminChatMessage[],
    summaryText: string,
  ): AdminChatMessage[] {
    const systemMessage = messages.find((message) => message.role === "system");
    const recentTail = extractRecentTail(messages);
    const keptFlags = messages.map(
      (message) => message === systemMessage || recentTail.includes(message),
    );
    const pairKeptFlags = enforceToolPairIntegrity(messages, keptFlags);
    const keptSystem =
      systemMessage && pairKeptFlags[messages.indexOf(systemMessage)]
        ? systemMessage
        : undefined;
    const keptTail = messages.filter(
      (message, index) =>
        pairKeptFlags[index] &&
        message !== systemMessage &&
        message.role !== "system",
    );

    const compactedMessages: AdminChatMessage[] = [];
    if (keptSystem) {
      compactedMessages.push(keptSystem);
    }
    compactedMessages.push({
      role: "user",
      content: `${PROMPT_DELIMITERS.CONVERSATION_SUMMARY_PREFIX} — auto-generated by compaction]\n\n${summaryText}`,
      isCompactSummary: true,
    });
    compactedMessages.push(...keptTail);
    return compactedMessages;
  }

  private static emitCompactionUsageIfPresent(
    options: CompactionOptions,
    result: GenerateTextResult,
    compactionModel: string,
  ): void {
    if (!options.emit || !result.usage) return;
    try {
      const compactPricing = getPricing(TYPES.TEXT, TYPES.TEXT)[
        compactionModel
      ];
      const inputTokens = result.usage.inputTokens || 0;
      const outputTokens = result.usage.outputTokens || 0;
      const compactCost = compactPricing
        ? calculateTextCost({ inputTokens, outputTokens }, compactPricing)
        : null;
      options.emit({
        type: SERVER_SENT_EVENT_TYPES.USAGE_UPDATE,
        operation: "compact:summarize",
        usage: {
          requests: 1,
          inputTokens,
          outputTokens,
          estimatedCost: compactCost,
        },
      });
    } catch {
      /* SSE channel may be closed */
    }
  }

  static async compactConversation(
    messages: AdminChatMessage[],
    options: CompactionOptions,
  ): Promise<CompactionResult | null> {
    const breakerKey = this.breakerKey(options);
    const consecutiveFailures = this.consecutiveFailures.get(breakerKey) ?? 0;
    if (consecutiveFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) {
      logger.warn(
        `[CompactionService] Circuit breaker open for ${breakerKey}: ${consecutiveFailures} consecutive failures. Skipping compaction.`,
      );
      return null;
    }

    const preCompactTokenCount = estimateTotalTokens(messages);
    const noShrinkAtTokens = this.noShrinkAtTokens.get(breakerKey);
    if (
      noShrinkAtTokens != null &&
      preCompactTokenCount <
        noShrinkAtTokens * (1 + NO_SHRINK_RETRY_GROWTH_FRACTION)
    ) {
      logger.info(
        `[CompactionService] Skipping compaction for ${breakerKey}: the last summary did not shrink a ` +
          `${noShrinkAtTokens}-token history and it is only ${preCompactTokenCount} tokens now.`,
      );
      return null;
    }

    const resolved = await this.resolveCompactionProviderAndModel();
    if (!resolved) return null;
    const { compactionProvider, compactionModel } = resolved;

    const strippedMessages = stripImagesFromMessages(messages);
    const conversationText =
      this.formatConversationForSummarization(strippedMessages);
    await this.flushMemoryBeforeCompaction(messages, options);

    const summarizationMessages: ChatMessage[] = [
      { role: "system", content: COMPACTION_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Here is the conversation to summarize:\n\n${conversationText}\n\n${COMPACTION_USER_PROMPT}`,
      },
    ];

    const result = await this.executeCompactionLlmCall(
      summarizationMessages,
      compactionProvider,
      compactionModel,
      breakerKey,
      preCompactTokenCount,
      messages.length,
      options,
    );
    if (!result) return null;

    const summaryText = extractSummaryFromResponse(result.text);
    if (!summaryText) {
      const failures = (this.consecutiveFailures.get(breakerKey) ?? 0) + 1;
      this.consecutiveFailures.set(breakerKey, failures);
      logger.warn(
        `[CompactionService] LLM returned no extractable summary. Failure ${failures}/${MAX_CONSECUTIVE_COMPACT_FAILURES} for ${breakerKey}`,
      );
      options.emit?.({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.COMPACTION_FAILED,
      });
      return null;
    }

    const compactedMessages = this.assembleCompactedMessageArray(
      messages,
      summaryText,
    );
    const postCompactTokenCount = estimateTotalTokens(compactedMessages);

    if (!compactionShrank(preCompactTokenCount, postCompactTokenCount)) {
      this.noShrinkAtTokens.set(breakerKey, preCompactTokenCount);
      logger.warn(
        `[CompactionService] Compaction did not shrink ${breakerKey} ` +
          `(${preCompactTokenCount} → ${postCompactTokenCount} tokens). Discarding result; ` +
          `shrink-guard bail-out (not a breaker failure) — next attempt once the history grows ` +
          `${Math.round(NO_SHRINK_RETRY_GROWTH_FRACTION * 100)}%.`,
      );
      options.emit?.({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.COMPACTION_FAILED,
      });
      return null;
    }

    this.consecutiveFailures.delete(breakerKey);

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

    this.emitCompactionUsageIfPresent(options, result, compactionModel);

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
    this.consecutiveFailures.clear();
    this.noShrinkAtTokens.clear();
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
