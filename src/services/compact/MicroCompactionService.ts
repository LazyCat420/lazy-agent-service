import logger from "../../utils/logger.ts";
import { estimateTokens } from "../../utils/CostCalculator.ts";
import { TOOL_NAMES } from "../ToolTaxonomyConstants.ts";
import type { ChatMessage, ToolCallEntry } from "../../types/admin.ts";
import { markDerivedMessage } from "./MessageLineage.ts";

// ────────────────────────────────────────────────────────────
// MicroCompactionService — In-Memory Tool Result Clearing
// ────────────────────────────────────────────────────────────
// Modeled after claude-code/src/services/compact/microCompact.ts
//
// Before sending messages to the LLM, this service clears large
// tool results from COMPACTABLE tools in old (unprotected) turns.
// This is the lightest compaction layer — no LLM call required.
//
// Claude Code equivalent:
//   const COMPACTABLE_TOOLS = new Set([
//     FILE_READ_TOOL_NAME, ...SHELL_TOOL_NAMES,
//     GREP_TOOL_NAME, GLOB_TOOL_NAME,
//     WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME,
//     FILE_EDIT_TOOL_NAME, FILE_WRITE_TOOL_NAME,
//   ]);
// ────────────────────────────────────────────────────────────

const CLEARED_RESULT_MARKER = "[Old tool result content cleared]";

const MINIMUM_RESULT_TOKEN_THRESHOLD = 500;

/** Number of recent user turns to never micro-compact. */
const PROTECTED_RECENT_TURNS = 4;

/**
 * Tools whose results are safe to clear during micro-compaction.
 * These produce large outputs (file contents, shell output, search results)
 * that the model no longer needs once it has acted on them.
 *
 * Matches Claude Code's COMPACTABLE_TOOLS set from microCompact.ts.
 */
const COMPACTABLE_TOOLS: Set<string> = new Set([
  TOOL_NAMES.READ_FILE,
  TOOL_NAMES.EXECUTE_CODE,
  TOOL_NAMES.WEB_CONTENT,
  TOOL_NAMES.WEB_SEARCH,
  TOOL_NAMES.SEARCH_FILES,
  TOOL_NAMES.LIST_DIRECTORY,
  TOOL_NAMES.READ_IMAGE,
  TOOL_NAMES.PYTHON_INTERPRETER,
  TOOL_NAMES.JAVASCRIPT_INTERPRETER,
  TOOL_NAMES.SHELL,
  TOOL_NAMES.GENERATE_AUDIO,
]);

export interface MicroCompactionResult {
  messages: ChatMessage[];
  freedTokens: number;
  clearedResultCount: number;
}

/**
 * Estimate token count for a tool result value.
 */
function estimateToolResultTokens(result: unknown): number {
  if (!result) return 0;
  const resultText =
    typeof result === "string" ? result : JSON.stringify(result);
  return estimateTokens(resultText);
}

/**
 * Find the protection boundary index — messages at or after this index
 * are in the "recent" window and should never be micro-compacted.
 */
function findProtectionBoundary(
  messages: ChatMessage[],
  protectedTurnCount: number,
): number {
  let userTurnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userTurnsSeen++;
      if (userTurnsSeen >= protectedTurnCount) {
        return i;
      }
    }
  }
  return 0;
}

export default class MicroCompactionService {
  /**
   * Clear old compactable tool results in-memory.
   *
   * Returns the modified messages array and the number of tokens freed.
   * Does NOT mutate the original array — returns a new one.
   */
  static microcompactMessages(
    messages: ChatMessage[],
    protectedTurnCount: number = PROTECTED_RECENT_TURNS,
  ): MicroCompactionResult {
    const protectionBoundary = findProtectionBoundary(
      messages,
      protectedTurnCount,
    );

    let freedTokens = 0;
    let clearedResultCount = 0;

    const compactedMessages = messages.map((message, index) => {
      // Never touch protected (recent) messages
      if (index >= protectionBoundary) return message;

      // Only process assistant messages with tool calls
      if (message.role !== "assistant" || !message.toolCalls?.length)
        return message;

      let messageModified = false;
      const compactedToolCalls = message.toolCalls.map(
        (toolCall: ToolCallEntry) => {
          // Skip tools not in the compactable set
          if (!COMPACTABLE_TOOLS.has(toolCall.name)) return toolCall;

          // Skip tool calls with no result or small results
          if (!toolCall.result) return toolCall;
          const resultTokens = estimateToolResultTokens(toolCall.result);
          if (resultTokens < MINIMUM_RESULT_TOKEN_THRESHOLD) return toolCall;

          // Clear the result
          messageModified = true;
          freedTokens += resultTokens;
          clearedResultCount++;
          return {
            ...toolCall,
            result: CLEARED_RESULT_MARKER,
          };
        },
      );

      if (!messageModified) return message;

      return markDerivedMessage(
        {
          ...message,
          toolCalls: compactedToolCalls,
        },
        message,
      );
    });

    if (clearedResultCount > 0) {
      logger.info(
        `[MicroCompaction] Cleared ${clearedResultCount} old tool results, freed ~${freedTokens} tokens`,
      );
    }

    return {
      messages: compactedMessages,
      freedTokens,
      clearedResultCount,
    };
  }
}
