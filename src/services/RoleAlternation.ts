import logger from "../utils/logger.ts";
import type { ConversationMessage } from "./harnesses/types.ts";

// ────────────────────────────────────────────────────────────
// RoleAlternation — pre-flight role-alternation validator (W3)
//
// Normalizes the internal ConversationMessage array before it is
// expanded (expandMessagesForFunctionCall) and submitted to the
// provider, so providers with strict alternation requirements
// (Anthropic, OpenAI) never reject a request over malformed history.
//
// Internal format notes (verified against
// src/utils/FunctionCallingUtilities.ts):
//   - Tool results live inline on assistant messages
//     (assistant.toolCalls[].result) and are expanded into
//     role:"tool" wire messages. Standalone role:"tool" messages
//     (with tool_call_id) are also legal and passed through.
//   - Normalization therefore operates on the internal format and
//     must never break the assistant(toolCalls) → tool results →
//     assistant shape.
//
// Rules:
//   (a) Consecutive same-role non-tool messages are merged with a
//       "\n\n" join. Assistant messages carrying toolCalls are never
//       merged (their toolCalls must stay attached to exactly one
//       assistant turn).
//   (b) The valid shape assistant(toolCalls) → tool results →
//       assistant is preserved untouched.
//   (c) Tool-result messages (role:"tool") with no preceding
//       assistant-with-toolCalls message are dropped; a single warn
//       is logged per normalization run.
//   (d) System messages are only valid at position 0. The FIRST
//       system message is moved to position 0 (if not already
//       there) and every later system message is merged into it
//       with a "\n\n" join, preserving all later-system content.
// ────────────────────────────────────────────────────────────

export interface RoleAlternationResult {
  messages: ConversationMessage[];
  droppedOrphanToolResults: number;
  mergedMessageCount: number;
}

function messageContent(message: ConversationMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

function hasToolCalls(message: ConversationMessage): boolean {
  return Array.isArray(message.toolCalls) && message.toolCalls.length > 0;
}

/**
 * Normalize role alternation on an internal ConversationMessage array.
 * Returns a new array; the input is never mutated.
 */
export function normalizeRoleAlternation(
  messages: ConversationMessage[],
): RoleAlternationResult {
  // ── (c) Drop orphan tool-result messages ──────────────────
  let droppedOrphanToolResults = 0;
  const withoutOrphans: ConversationMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      // The owner is the nearest preceding assistant toolCalls turn (only
      // tool results may sit between them); when the result names its call,
      // that turn must actually contain that call id.
      let owner: ConversationMessage | undefined;
      for (let i = withoutOrphans.length - 1; i >= 0; i--) {
        const prior = withoutOrphans[i];
        if (prior.role === "tool") continue;
        if (prior.role === "assistant" && hasToolCalls(prior)) owner = prior;
        break;
      }
      const callId = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
      const hasOwner =
        owner !== undefined &&
        (!callId || (owner.toolCalls ?? []).some((call) => call.id === callId));
      if (!hasOwner) {
        droppedOrphanToolResults++;
        continue;
      }
    }
    withoutOrphans.push(message);
  }
  if (droppedOrphanToolResults > 0) {
    logger.warn(
      `[RoleAlternation] Dropped ${droppedOrphanToolResults} tool-result message(s) with no matching preceding assistant toolCalls turn.`,
    );
  }

  // ── (d) System messages only at position 0 ────────────────
  const firstSystemIndex = withoutOrphans.findIndex(
    (message) => message.role === "system",
  );
  let withSystem: ConversationMessage[];
  if (firstSystemIndex === -1) {
    withSystem = withoutOrphans;
  } else {
    // Merge every later system message into the first one.
    let mergedSystem: ConversationMessage = {
      ...withoutOrphans[firstSystemIndex],
    };
    const rest: ConversationMessage[] = [];
    let systemSlot = -1;
    withoutOrphans.forEach((message, index) => {
      if (index === firstSystemIndex) {
        systemSlot = rest.length;
        rest.push(mergedSystem);
        return;
      }
      if (message.role === "system") {
        mergedSystem = {
          ...mergedSystem,
          content: [messageContent(mergedSystem), messageContent(message)]
            .filter((part) => part.trim().length > 0)
            .join("\n\n"),
        };
        rest[systemSlot] = mergedSystem;
        return;
      }
      rest.push(message);
    });
    // Move the (merged) system message to position 0 if it isn't there.
    withSystem =
      firstSystemIndex === 0
        ? rest
        : [rest[firstSystemIndex], ...rest.filter((_, index) => index !== firstSystemIndex)];
  }

  // ── (a) Merge consecutive same-role non-tool messages ─────
  const merged: ConversationMessage[] = [];
  let mergedMessageCount = 0;
  for (const message of withSystem) {
    const previous = merged[merged.length - 1];
    const mergeable =
      previous !== undefined &&
      previous.role === message.role &&
      message.role !== "tool" &&
      message.role !== "system" &&
      !hasToolCalls(previous) &&
      !hasToolCalls(message) &&
      // Structured (array) content cannot be string-joined without loss.
      (previous.content === undefined || typeof previous.content === "string") &&
      (message.content === undefined || typeof message.content === "string");
    if (mergeable) {
      const images = [...(previous.images ?? []), ...(message.images ?? [])];
      merged[merged.length - 1] = {
        ...previous,
        content: [messageContent(previous), messageContent(message)]
          .filter((part) => part.trim().length > 0)
          .join("\n\n"),
        ...(images.length > 0 ? { images } : {}),
      };
      mergedMessageCount++;
    } else {
      merged.push(message);
    }
  }

  return {
    messages: merged,
    droppedOrphanToolResults,
    mergedMessageCount,
  };
}
