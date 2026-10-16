// Tests for ch.06 item 6, remaining pieces: verbatim originals
// (MessageLineage + TurnTranscript, ported from prism-service) and the
// shrink check (CompactionService).
import { describe, expect, it } from "vitest";

import {
  markDerivedMessage,
  pristineOf,
} from "../MessageLineage.ts";
import {
  collectTurnMessages,
  syncTurnTranscript,
} from "../../harnesses/lifecycle/TurnTranscript.ts";
import { compactionShrank } from "../CompactionService.ts";
import ContextWindowManager from "../../../utils/ContextWindowManager.ts";
import AgenticLoopState from "../../AgenticLoopState.ts";
import type { ConversationMessage } from "../../harnesses/types.ts";
import type { ChatMessage, ToolCallEntry } from "../../types/admin.ts";

const RESULT_CHARS = 10_000;

function singleTurnConversation(assistantCount: number): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "user", content: "run the analysis" } as ChatMessage,
  ];
  for (let i = 0; i < assistantCount; i++) {
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: `t${i}`,
          name: "lazy_web_search",
          args: {},
          result: "r".repeat(RESULT_CHARS),
        } as ToolCallEntry,
      ],
    } as ChatMessage);
  }
  return messages;
}

describe("MessageLineage", () => {
  it("maps a shrunk copy back to its verbatim original", () => {
    const original = { role: "assistant", content: "x".repeat(20_000) } as ChatMessage;
    const copy = markDerivedMessage({ ...original, content: "[truncated]" }, original);
    expect(pristineOf(copy)).toBe(original);
    expect(pristineOf(original)).toBe(original);
  });

  it("ContextWindowManager registers every shrunk copy", () => {
    const messages = singleTurnConversation(12);
    const state = new AgenticLoopState({ originalMessageCount: 1 });
    // A window small enough that truncation must fire.
    const context = {
      messages: messages as unknown as ConversationMessage[],
    } as Parameters<typeof syncTurnTranscript>[0];
    syncTurnTranscript(context, state, messages as unknown as ConversationMessage[]);
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 32_768,
      maxOutputTokens: 8_192,
      toolCount: 1,
    });
    // Every truncated result maps back to a verbatim original of the same
    // length the turn recorded.
    for (const view of result.messages) {
      const original = pristineOf(view);
      if (original !== view) {
        expect(original.toolCalls?.[0]?.result?.length).toBe(RESULT_CHARS);
      }
    }
  });
});

describe("TurnTranscript", () => {
  it("persistence sees the verbatim turn after the view was shrunk", () => {
    const history = [
      { role: "user", content: "old persisted message", _alreadyPersisted: true },
    ] as unknown as ConversationMessage[];
    const turn = singleTurnConversation(6);
    const view = [...history, ...turn] as unknown as ConversationMessage[];
    const context = {
      messages: history,
    } as Parameters<typeof syncTurnTranscript>[0];
    const state = new AgenticLoopState({ originalMessageCount: 1 });

    // The harness records the turn BEFORE the shrink (as
    // enforceContextWindow now does)…
    syncTurnTranscript(context, state, view);
    // …then the shrink replaces early results with tiny copies.
    const shrunk = ContextWindowManager.enforce(
      view as unknown as ChatMessage[],
      { maxInputTokens: 32_768, maxOutputTokens: 8_192, toolCount: 1 },
    );

    const collected = collectTurnMessages(
      context,
      state,
      shrunk.messages as unknown as ConversationMessage[],
    );
    // Every turn message persists, with its FULL original result —
    // the classic slice of the shrunk view would have lost them.
    const assistants = collected.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(6);
    for (const message of assistants) {
      expect(
        (message.toolCalls as ToolCallEntry[])?.[0]?.result?.length,
      ).toBe(RESULT_CHARS);
    }
  });

  it("falls back to the classic slice when no shrink ever ran", () => {
    const history = [
      { role: "user", content: "old", _alreadyPersisted: true },
    ] as unknown as ConversationMessage[];
    const context = {
      messages: history,
    } as Parameters<typeof syncTurnTranscript>[0];
    const state = new AgenticLoopState({ originalMessageCount: 1 });
    const view = [
      ...history,
      { role: "assistant", content: "answer" },
    ] as unknown as ConversationMessage[];
    const collected = collectTurnMessages(context, state, view);
    expect(collected).toHaveLength(1);
    expect(collected[0].content).toBe("answer");
  });
});

describe("shrink check", () => {
  it("accepts a summary that shrank and rejects one that grew", () => {
    expect(compactionShrank(30_000, 12_000)).toBe(true);
    expect(compactionShrank(30_000, 30_000)).toBe(false);
    expect(compactionShrank(30_000, 31_000)).toBe(false);
  });
});
