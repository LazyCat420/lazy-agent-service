import logger from "./logger.ts";
import { estimateTokens } from "./CostCalculator.ts";
import type { ChatMessage, ToolCallEntry } from "../types/admin.ts";
import MicroCompactionService from "../services/compact/MicroCompactionService.ts";
import { findRecencyBoundary } from "../services/compact/RecencyProtection.ts";
import {
  computeContextBudgets,
  messageTokenBudget,
  type ProviderInputBaseline,
} from "../services/compact/ContextBudgets.ts";
import PromptLocaleService from "../services/PromptLocaleService.ts";
import { PROMPT_DELIMITERS } from "../constants.ts";
import {
  DEFAULT_MAX_INPUT_TOKENS,
  MIN_OUTPUT_RESERVE,
} from "../constants/TokenBudgetDefaults.ts";

// ────────────────────────────────────────────────────────────
// ContextWindowManager — Token-Budget Truncation
// ────────────────────────────────────────────────────────────
// Prevents context window overflow by estimating token usage
// and compressing or dropping low-value messages when the
// conversation approaches the model's input limit.
//
// Strategy (in priority order):
//   1. Truncate tool results further (aggressive cap)
//   2. Summarize old assistant messages (keep first + last N)
//   3. Drop middle conversation turns (sliding window)
//
// Token estimation uses the ~4 chars/token heuristic, which is
// accurate enough for budget enforcement without requiring a
// real tokenizer (which would add latency and a dependency).
// ────────────────────────────────────────────────────────────

/** Default overhead for tool schemas, internal formatting, etc. */
const TOOL_SCHEMA_OVERHEAD_TOKENS = 2000;

/** Fraction of context window to target (leave headroom for output + safety) */
const TARGET_UTILIZATION = 0.8;



/** When truncating tool results aggressively, cap at this many chars */
const AGGRESSIVE_TOOL_RESULT_CAP = 3000;

// Recency protection is by MODEL CALLS, not user turns — see
// RecencyProtection.ts. A single-turn agent run has one user turn, so a
// user-turn window protected the entire run and nothing ever shrank.

interface EnforceOptions {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  toolCount?: number;
  locale?: string;
  /**
   * System prompt + tool schema tokens the request carries besides the
   * messages. Defaults to a per-tool heuristic when the caller has no
   * measurement.
   */
  fixedOverheadTokens?: number;
  /**
   * The loop's latest provider-reported input and the ratio an earlier turn
   * measured — so the truncation budget is measured in the same units as
   * the compaction trigger (ContextBudgets.messageTokenBudget).
   */
  providerInputBaseline?: ProviderInputBaseline | null;
  calibrationRatio?: number | null;
  /** Why summarization did not keep the request under budget — logged if truncation runs. */
  truncationReason?: string;
}

interface EnforceResult {
  messages: ChatMessage[];
  truncated: boolean;
  strategy: string | null;
  estimatedTokens: number;
}

/**
 * Estimate token count for a single message.
 * Accounts for content, tool calls, tool results, thinking blocks, and images.
 */
function estimateMessageTokens(message: ChatMessage): number {
  let tokens = 4; // Per-message overhead (role, formatting)

  // Text content
  if (message.content) {
    tokens += estimateTokens(
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    );
  }

  // Thinking blocks
  if (message.thinking) {
    tokens += estimateTokens(message.thinking);
  }

  // Tool calls (function name + args + results)
  if (message.toolCalls && Array.isArray(message.toolCalls)) {
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

  // Tool response content (standalone tool messages)
  if (message.role === "tool" && message.content) {
    tokens += estimateTokens(
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    );
  }

  // Images (rough: ~1000 tokens per image reference)
  if (message.images && Array.isArray(message.images)) {
    tokens += message.images.length * 1000;
  }

  return tokens;
}

function estimateTotalTokens(messages: ChatMessage[]): number {
  return messages.reduce(
    (sum, message) => sum + estimateMessageTokens(message),
    0,
  );
}

// ────────────────────────────────────────────────────────────
// Truncation Strategies
// ────────────────────────────────────────────────────────────

/**
 * Strategy 1: Aggressively truncate OLD tool call results.
 * Tool results are the largest context consumers — a single `read_file`
 * can dump 10k+ chars. This caps results that exceed the aggressive limit,
 * but only for messages OUTSIDE the protected recent window.
 *
 * Recent tool results (the recency-protected window) are preserved in
 * full — the LLM is actively reasoning about them.
 */
function truncateToolResults(messages: ChatMessage[]): ChatMessage[] {
  // The recency-protected window (the last model calls) is preserved in
  // full — the LLM is actively reasoning about it.
  const protectionIndex = findRecencyBoundary(messages);

  return messages.map((message, i) => {
    // Never truncate tool results in recent (protected) messages
    if (i >= protectionIndex) return message;
    if (message.role !== "assistant" || !message.toolCalls?.length)
      return message;

    const truncated = { ...message };
    truncated.toolCalls = message.toolCalls.map((toolCall: ToolCallEntry) => {
      if (!toolCall.result) return toolCall;

      const resultString =
        typeof toolCall.result === "string"
          ? toolCall.result
          : JSON.stringify(toolCall.result);
      if (resultString.length <= AGGRESSIVE_TOOL_RESULT_CAP) return toolCall;

      return {
        ...toolCall,
        result:
          resultString.slice(0, AGGRESSIVE_TOOL_RESULT_CAP) +
          `\n...[truncated ${resultString.length - AGGRESSIVE_TOOL_RESULT_CAP} chars]`,
      };
    });
    return truncated;
  });
}

/**
 * Strategy 2: Compress old assistant messages — keep only a summary marker.
 * Replaces assistant content with a "[Earlier response summarized]" marker.
 * Preserves tool call names but drops results.
 */
function compressOldAssistantMessages(messages: ChatMessage[]): ChatMessage[] {
  const protectionIndex = findRecencyBoundary(messages);

  return messages.map((message, i) => {
    // Never compress system messages, user messages, or protected recent messages
    if (
      message.role === "system" ||
      message.role === "user" ||
      i >= protectionIndex
    ) {
      return message;
    }

    // Compress assistant messages
    if (message.role === "assistant") {
      const compressed = { ...message };

      // Keep a short summary of what the assistant did
      const toolNames =
        message.toolCalls
          ?.map((toolCall: ToolCallEntry) => toolCall.name)
          .join(", ") || "";
      const contentString =
        typeof message.content === "string" ? message.content : "";
      const contentPreview = contentString.slice(0, 200);

      compressed.content = `[Earlier response${toolNames ? ` — used: ${toolNames}` : ""}]${contentPreview ? `\n${contentPreview}...` : ""}`;
      compressed.thinking = undefined;

      if (compressed.toolCalls) {
        compressed.toolCalls = compressed.toolCalls.map(
          (toolCall: ToolCallEntry) => ({
            ...toolCall,
            result: toolCall.result
              ? "[result truncated for context budget]"
              : undefined,
          }),
        );
      }

      return compressed;
    }

    // Compress standalone tool messages
    if (message.role === "tool") {
      return {
        ...message,
        content: "[tool result truncated for context budget]",
      };
    }

    return message;
  });
}

/**
 * Strategy 3: Drop middle turns entirely (sliding window).
 * Keeps the system prompt, first user message (for task context),
 * and the most recent N turns.
 */
function slidingWindowTruncation(
  messages: ChatMessage[],
  maxTokens: number,
  locale?: string,
): ChatMessage[] {
  if (messages.length <= 3) return messages;

  // Always keep: system message, first user message
  const head: ChatMessage[] = [];
  let headEnd = 0;

  for (let i = 0; i < messages.length; i++) {
    head.push(messages[i]);
    headEnd = i + 1;
    if (messages[i].role === "user") break; // Stop after first user message
  }

  // The recency-protected window is always kept, whatever the budget
  const protectionIndex = findRecencyBoundary(messages);

  // Build tail from the end until we approach budget
  const tail: ChatMessage[] = [];
  let tailTokens = 0;
  const headTokens = estimateTotalTokens(head);
  const availableForTail = maxTokens - headTokens - 200; // 200 token buffer for marker

  for (let i = messages.length - 1; i >= headEnd; i--) {
    const messageTokens = estimateMessageTokens(messages[i]);
    if (i >= protectionIndex) {
      // Always protect recent turns, accumulate token count without breaking on budget
      tail.unshift(messages[i]);
      tailTokens += messageTokens;
    } else {
      if (tailTokens + messageTokens > availableForTail) break;
      tail.unshift(messages[i]);
      tailTokens += messageTokens;
    }
  }

  const droppedCount = messages.length - head.length - tail.length;

  if (droppedCount > 0) {
    // Insert a context marker so the model knows history was dropped
    head.push({
      role: "user",
      content: `${PROMPT_DELIMITERS.CONTEXT_NOTE_PREFIX} ${PromptLocaleService.get(locale || PromptLocaleService.getDefaultLocale(), "harness.contextWindow.droppedMessages", { droppedCount: String(droppedCount) })}]`,
    });
  }

  return [...head, ...tail];
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

export default class ContextWindowManager {
  /**
   * Enforce context window limits on a messages array.
   *
   * Applies truncation strategies in order of aggressiveness until
   * the estimated token count fits within the model's context window.
   */
  static enforce(
    messages: ChatMessage[],
    options: EnforceOptions = {},
  ): EnforceResult {
    const {
      maxInputTokens = DEFAULT_MAX_INPUT_TOKENS,
      maxOutputTokens = MIN_OUTPUT_RESERVE,
      toolCount = 0,
    } = options;

    // The truncation budget is shared with the compaction trigger
    // (ContextBudgets) and never below its threshold. Only the messages are
    // estimated here, so the request budget is converted to message tokens
    // with the trigger's own estimate (reported baseline or calibrated
    // chars/4 + system prompt + tool schemas) — same units, no crossing.
    const fixedOverhead =
      options.fixedOverheadTokens ??
      TOOL_SCHEMA_OVERHEAD_TOKENS + toolCount * 150;
    const { truncationBudget } = computeContextBudgets(
      maxInputTokens,
      maxOutputTokens,
    );
    const budget = Math.max(
      messageTokenBudget(truncationBudget, {
        overheadTokens: fixedOverhead,
        baseline: options.providerInputBaseline,
        calibrationRatio: options.calibrationRatio,
      }),
      1024, // Ensure at least a small budget even if window is tight
    );

    let currentTokens = estimateTotalTokens(messages);

    // Fast path: fits within budget
    if (currentTokens <= budget) {
      return {
        messages,
        truncated: false,
        strategy: null,
        estimatedTokens: currentTokens,
      };
    }

    logger.warn(
      `[ContextWindowManager] Truncating: ${currentTokens} message tokens > ${budget} message budget ` +
        `(${truncationBudget}-token request budget of a ${maxInputTokens} window, ` +
        `${options.providerInputBaseline ? "from reported usage" : `${fixedOverhead} fixed overhead`}) — ` +
        `${options.truncationReason || "no compaction attempted on this path"}`,
    );

    // Strategy 0: Micro-compaction — clear old compactable tool results entirely
    const microCompactionResult =
      MicroCompactionService.microcompactMessages(messages);
    let result = microCompactionResult.messages;
    currentTokens = estimateTotalTokens(result);

    if (currentTokens <= budget) {
      logger.info(
        `[ContextWindowManager] Fixed with micro-compaction: ${currentTokens} tokens (cleared ${microCompactionResult.clearedResultCount} results, freed ~${microCompactionResult.freedTokens} tokens)`,
      );
      return {
        messages: result,
        truncated: true,
        strategy: "micro_compaction",
        estimatedTokens: currentTokens,
      };
    }

    // Strategy 1: Truncate tool results aggressively
    result = truncateToolResults(result);
    currentTokens = estimateTotalTokens(result);

    if (currentTokens <= budget) {
      logger.info(
        `[ContextWindowManager] Fixed with tool result truncation: ${currentTokens} tokens`,
      );
      return {
        messages: result,
        truncated: true,
        strategy: "tool_truncation",
        estimatedTokens: currentTokens,
      };
    }

    // Strategy 2: Compress old assistant messages
    result = compressOldAssistantMessages(result);
    currentTokens = estimateTotalTokens(result);

    if (currentTokens <= budget) {
      logger.info(
        `[ContextWindowManager] Fixed with assistant compression: ${currentTokens} tokens`,
      );
      return {
        messages: result,
        truncated: true,
        strategy: "assistant_compression",
        estimatedTokens: currentTokens,
      };
    }

    // Strategy 3: Sliding window — drop middle turns
    result = slidingWindowTruncation(result, budget, options.locale);
    currentTokens = estimateTotalTokens(result);

    logger.info(
      `[ContextWindowManager] Applied sliding window: ${currentTokens} tokens (budget: ${budget})`,
    );
    return {
      messages: result,
      truncated: true,
      strategy: "sliding_window",
      estimatedTokens: currentTokens,
    };
  }

  static estimateTokens(messages: ChatMessage[]): number {
    return estimateTotalTokens(messages);
  }

  static estimateMessageTokens(message: ChatMessage): number {
    return estimateMessageTokens(message);
  }
}
