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

function findPrecedingAssistantOwner(
  withoutOrphans: ConversationMessage[],
): ConversationMessage | undefined {
  for (let i = withoutOrphans.length - 1; i >= 0; i--) {
    const prior = withoutOrphans[i];
    if (prior.role === "tool") continue;
    if (prior.role === "assistant" && hasToolCalls(prior)) return prior;
    break;
  }
  return undefined;
}

function dropOrphanToolResults(messages: ConversationMessage[]): {
  withoutOrphans: ConversationMessage[];
  droppedOrphanToolResults: number;
} {
  let droppedOrphanToolResults = 0;
  const withoutOrphans: ConversationMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      const owner = findPrecedingAssistantOwner(withoutOrphans);
      const callId =
        typeof message.tool_call_id === "string" ? message.tool_call_id : "";
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
  return { withoutOrphans, droppedOrphanToolResults };
}

function consolidateSystemMessagesAtPositionZero(
  withoutOrphans: ConversationMessage[],
): ConversationMessage[] {
  const firstSystemIndex = withoutOrphans.findIndex(
    (message) => message.role === "system",
  );
  if (firstSystemIndex === -1) {
    return withoutOrphans;
  }
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
  return firstSystemIndex === 0
    ? rest
    : [
        rest[firstSystemIndex],
        ...rest.filter((_, index) => index !== firstSystemIndex),
      ];
}

function canMergeConsecutiveMessages(
  previous: ConversationMessage | undefined,
  message: ConversationMessage,
): previous is ConversationMessage {
  if (!previous || previous.role !== message.role) return false;
  if (message.role === "tool" || message.role === "system") return false;
  if (hasToolCalls(previous) || hasToolCalls(message)) return false;
  const prevIsStringOrEmpty =
    previous.content === undefined || typeof previous.content === "string";
  const currIsStringOrEmpty =
    message.content === undefined || typeof message.content === "string";
  return prevIsStringOrEmpty && currIsStringOrEmpty;
}

/**
 * Normalize role alternation on an internal ConversationMessage array.
 * Returns a new array; the input is never mutated.
 */
export function normalizeRoleAlternation(
  messages: ConversationMessage[],
): RoleAlternationResult {
  const { withoutOrphans, droppedOrphanToolResults } =
    dropOrphanToolResults(messages);
  const withSystem = consolidateSystemMessagesAtPositionZero(withoutOrphans);

  const merged: ConversationMessage[] = [];
  let mergedMessageCount = 0;
  for (const message of withSystem) {
    const previous = merged[merged.length - 1];
    if (canMergeConsecutiveMessages(previous, message)) {
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
