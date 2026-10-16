// ported from prism-service src/services/compact/RecencyProtection.ts
import { estimateTokens } from "../../utils/CostCalculator.ts";
import type { ChatMessage } from "../../types/admin.ts";

// ────────────────────────────────────────────────────────────
// RecencyProtection — what the model is actively working from
// ────────────────────────────────────────────────────────────
// Every shrinking layer (micro-compaction, lossy truncation) leaves the
// recent window verbatim. That window used to be "the last N user turns" —
// but tool results live on assistant messages, and a long single run has
// ONE user turn, so the entire run was protected and never shrank (40 tool
// calls of 4K each grew the request linearly to 160K).
//
// Protection is now by recency of model calls: the last
// PROTECTED_RECENT_ITERATIONS assistant messages (each model call leaves
// one — a tool-calling iteration or a final answer) and everything after
// the first of them, capped at PROTECTED_TOOL_OUTPUT_TOKENS of tool
// output so a handful of huge results cannot pin the window. The newest
// iteration is always protected, whatever its size. The window starts
// right after the newest UNprotected assistant message, so the question
// that prompted the first protected answer is always inside it.
// ────────────────────────────────────────────────────────────

/** Most recent assistant messages (model calls) to keep verbatim. */
export const PROTECTED_RECENT_ITERATIONS = 4;

/** Cap on tool-output tokens inside the protected window. */
export const PROTECTED_TOOL_OUTPUT_TOKENS = 20_000;

export interface RecencyProtection {
  /** Most recent assistant messages (model calls) to keep verbatim. */
  iterations?: number;
  /** Cap on tool-output tokens inside the protected window. */
  toolOutputTokens?: number;
}

function toolOutputTokensOf(message: ChatMessage): number {
  if (!message.toolCalls?.length) return 0;
  let tokens = 0;
  for (const toolCall of message.toolCalls) {
    if (toolCall.result == null) continue;
    tokens += estimateTokens(
      typeof toolCall.result === "string"
        ? toolCall.result
        : JSON.stringify(toolCall.result),
    );
  }
  return tokens;
}

/**
 * Index of the first protected message: messages at or after it are the
 * recent window; everything before it may be offloaded, summarized or
 * truncated. Returns 0 when the whole array is within the window.
 */
export function findRecencyBoundary(
  messages: ChatMessage[],
  {
    iterations = PROTECTED_RECENT_ITERATIONS,
    toolOutputTokens = PROTECTED_TOOL_OUTPUT_TOKENS,
  }: RecencyProtection = {},
): number {
  let iterationsSeen = 0;
  let protectedToolTokens = 0;

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const messageToolTokens = toolOutputTokensOf(message);
    if (
      iterationsSeen >= Math.max(1, iterations) ||
      (iterationsSeen >= 1 &&
        protectedToolTokens + messageToolTokens > toolOutputTokens)
    ) {
      return index + 1;
    }
    iterationsSeen++;
    protectedToolTokens += messageToolTokens;
  }
  return 0;
}
