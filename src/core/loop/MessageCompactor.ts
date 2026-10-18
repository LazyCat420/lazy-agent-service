import type { ChatMessage } from "./types.ts";

export const DEFAULT_COMPACT_TOKEN_BUDGET = 28_000;
export const CHARS_PER_TOKEN_ESTIMATE = 4;

export interface CompactionOptions {
  /** Maximum estimated token budget before middle atomic groups are evicted (default 28,000). */
  budgetTokens?: number;
  /** Minimum number of tail atomic groups to preserve (default 2). */
  keepRecentGroups?: number;
  /** Whether to insert a synthetic summary note where middle groups were evicted (default true). */
  insertCompactionMarker?: boolean;
}

export interface AtomicMessageGroup {
  kind: "system_prefix" | "first_user" | "tool_pair_group" | "single";
  messages: ChatMessage[];
  estimatedTokens: number;
}

export function estimateSingleMessageChars(msg: ChatMessage): number {
  let chars = typeof msg.content === "string" ? msg.content.length : 0;
  const thinkingLen =
    typeof msg.thinking === "string" ? msg.thinking.length : 0;
  const reasoningLen =
    typeof msg.reasoning_content === "string"
      ? msg.reasoning_content.length
      : 0;
  if (
    thinkingLen > 0 &&
    reasoningLen > 0 &&
    msg.thinking === msg.reasoning_content
  ) {
    chars += thinkingLen;
  } else {
    chars += thinkingLen + reasoningLen;
  }
  if (Array.isArray(msg.toolCalls)) {
    for (const tc of msg.toolCalls) {
      chars += (tc.name?.length ?? 0) + (tc.id?.length ?? 0);
      if (tc.args !== undefined) {
        try {
          chars +=
            typeof tc.args === "string"
              ? tc.args.length
              : JSON.stringify(tc.args).length;
        } catch {
          chars += 64;
        }
      }
    }
  }
  return chars + 16; // framing overhead
}

export function estimateMessageTokens(messages: ChatMessage[]): number {
  let totalChars = 0;
  for (const m of messages) {
    totalChars += estimateSingleMessageChars(m);
  }
  return Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Partition a conversation into atomic message groups where every assistant
 * `toolCalls` message is bound to all of its corresponding `role === "tool"`
 * result messages, and any orphan `role === "tool"` message without a matching
 * preceding assistant toolCall is stripped.
 */
export function partitionIntoAtomicGroups(
  messages: ChatMessage[],
): AtomicMessageGroup[] {
  const groups: AtomicMessageGroup[] = [];
  let idx = 0;

  // 1. Leading system messages
  while (idx < messages.length && messages[idx].role === "system") {
    const msg = messages[idx];
    groups.push({
      kind: "system_prefix",
      messages: [msg],
      estimatedTokens: Math.ceil(
        estimateSingleMessageChars(msg) / CHARS_PER_TOKEN_ESTIMATE,
      ),
    });
    idx += 1;
  }

  // 2. First user message (pinned anchor)
  if (idx < messages.length && messages[idx].role === "user") {
    const msg = messages[idx];
    groups.push({
      kind: "first_user",
      messages: [msg],
      estimatedTokens: Math.ceil(
        estimateSingleMessageChars(msg) / CHARS_PER_TOKEN_ESTIMATE,
      ),
    });
    idx += 1;
  }

  // 3. Remaining messages grouped atomically
  while (idx < messages.length) {
    const current = messages[idx];

    if (
      current.role === "assistant" &&
      Array.isArray(current.toolCalls) &&
      current.toolCalls.length > 0
    ) {
      const expectedIds = new Set<string>();
      for (const tc of current.toolCalls) {
        if (tc.id) expectedIds.add(tc.id);
      }

      const groupMsgs: ChatMessage[] = [current];
      let lookahead = idx + 1;
      while (lookahead < messages.length && messages[lookahead].role === "tool") {
        const toolMsg = messages[lookahead];
        const callId = toolMsg.tool_call_id || toolMsg.id;
        if (!callId || expectedIds.size === 0 || expectedIds.has(callId)) {
          groupMsgs.push(toolMsg);
        }
        lookahead += 1;
      }

      let chars = 0;
      for (const m of groupMsgs) chars += estimateSingleMessageChars(m);
      groups.push({
        kind: "tool_pair_group",
        messages: groupMsgs,
        estimatedTokens: Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE),
      });
      idx = lookahead;
      continue;
    }

    // Strip orphan `role === "tool"` messages that have no preceding assistant toolCalls
    if (current.role === "tool") {
      idx += 1;
      continue;
    }

    groups.push({
      kind: "single",
      messages: [current],
      estimatedTokens: Math.ceil(
        estimateSingleMessageChars(current) / CHARS_PER_TOKEN_ESTIMATE,
      ),
    });
    idx += 1;
  }

  return groups;
}

/**
 * Verify that `messages` has zero orphan `role === "tool"` messages and that
 * every `assistant.toolCalls` entry has its matching `role === "tool"` result
 * immediately following in the assistant's tool block.
 */
export function verifyToolPairAtomicity(messages: ChatMessage[]): {
  valid: boolean;
  orphanToolCallIds: string[];
  missingResultToolCallIds: string[];
} {
  const orphanToolCallIds: string[] = [];
  const missingResultToolCallIds: string[] = [];

  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (
      msg.role === "assistant" &&
      Array.isArray(msg.toolCalls) &&
      msg.toolCalls.length > 0
    ) {
      const expected = new Set<string>(
        msg.toolCalls.map((tc) => tc.id).filter((id): id is string => Boolean(id)),
      );
      const seen = new Set<string>();
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") {
        const toolId = messages[j].tool_call_id || messages[j].id || "";
        if (!expected.has(toolId)) {
          orphanToolCallIds.push(toolId || `<missing-id-at-${j}>`);
        } else {
          seen.add(toolId);
        }
        j += 1;
      }
      for (const reqId of expected) {
        if (!seen.has(reqId)) {
          missingResultToolCallIds.push(reqId);
        }
      }
      i = j;
      continue;
    }

    if (msg.role === "tool") {
      orphanToolCallIds.push(msg.tool_call_id || msg.id || `<orphan-at-${i}>`);
    }
    i += 1;
  }

  return {
    valid:
      orphanToolCallIds.length === 0 && missingResultToolCallIds.length === 0,
    orphanToolCallIds,
    missingResultToolCallIds,
  };
}

/**
 * H6 / B8: Tool-Pair-Atomic Message Compactor.
 *
 * Ensures that:
 * 1. Orphan `role: "tool"` messages are always stripped.
 * 2. When total estimated tokens exceed `budgetTokens`, the oldest middle
 *    atomic groups (`tool_pair_group` or `single`) are evicted as complete
 *    units so an `assistant` message with `toolCalls` is never separated
 *    from its `role: "tool"` results.
 * 3. Leading `system` messages, the first `user` message, and the most recent
 *    tail atomic group(s) are preserved.
 */
export function compactMessages(
  messages: ChatMessage[],
  opts: CompactionOptions = {},
): ChatMessage[] {
  const budgetTokens = opts.budgetTokens ?? DEFAULT_COMPACT_TOKEN_BUDGET;
  const keepRecentGroups = Math.max(1, opts.keepRecentGroups ?? 2);
  const insertCompactionMarker = opts.insertCompactionMarker ?? true;

  const groups = partitionIntoAtomicGroups(messages);
  let totalTokens = groups.reduce((acc, g) => acc + g.estimatedTokens, 0);

  if (totalTokens <= budgetTokens) {
    return groups.flatMap((g) => g.messages);
  }

  const headGroups: AtomicMessageGroup[] = [];
  const middleGroups: AtomicMessageGroup[] = [];
  for (const g of groups) {
    if (g.kind === "system_prefix" || g.kind === "first_user") {
      headGroups.push(g);
    } else {
      middleGroups.push(g);
    }
  }

  if (middleGroups.length <= 1) {
    return groups.flatMap((g) => g.messages);
  }

  // Always preserve at least the last atomic group; preserve up to `keepRecentGroups`
  // when they fit or while evicting from the front of `middleGroups`.
  let evictedCount = 0;
  let evictedMessages = 0;
  let cursor = 0;
  const maxEvictable = Math.max(0, middleGroups.length - keepRecentGroups);

  while (totalTokens > budgetTokens && cursor < maxEvictable) {
    totalTokens -= middleGroups[cursor].estimatedTokens;
    evictedMessages += middleGroups[cursor].messages.length;
    evictedCount += 1;
    cursor += 1;
  }

  // If still over budget and more than 1 middle group remains, evict down to the very last group.
  const hardLimit = Math.max(0, middleGroups.length - 1);
  while (totalTokens > budgetTokens && cursor < hardLimit) {
    totalTokens -= middleGroups[cursor].estimatedTokens;
    evictedMessages += middleGroups[cursor].messages.length;
    evictedCount += 1;
    cursor += 1;
  }

  const keptMiddle = middleGroups.slice(cursor);
  const result: ChatMessage[] = [];
  for (const g of headGroups) {
    result.push(...g.messages);
  }

  if (evictedCount > 0 && insertCompactionMarker) {
    const markerContent = `[Context compacted: ${evictedMessages} earlier messages across ${evictedCount} tool/turn group(s) were removed to fit the context window.]`;
    const lastHead = result[result.length - 1];
    const firstKept = keptMiddle[0]?.messages[0];
    result.push({
      role:
        lastHead?.role === "user" && firstKept?.role === "user"
          ? "assistant"
          : "system",
      content: markerContent,
    });
  }

  for (const g of keptMiddle) {
    result.push(...g.messages);
  }

  return result;
}
