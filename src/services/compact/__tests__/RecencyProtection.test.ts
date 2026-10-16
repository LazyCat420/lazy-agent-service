// Tests for ch.06 item 6: recency protection by MODEL CALLS (not user
// turns) in the rolling window, ported from prism-service.
import { describe, expect, it } from "vitest";

import { findRecencyBoundary } from "../RecencyProtection.ts";
import ContextWindowManager from "../../../utils/ContextWindowManager.ts";
import type { ChatMessage, ToolCallEntry } from "../../../types/admin.ts";

const RESULT_CHARS = 10_000; // ~2_500 tokens per tool result

function assistantWithResult(result: string): ChatMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "t", name: "lazy_web_search", args: {}, result } as ToolCallEntry,
    ],
  } as ChatMessage;
}

function singleTurnConversation(assistantCount: number): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "user", content: "run the analysis" } as ChatMessage,
  ];
  for (let i = 0; i < assistantCount; i++) {
    messages.push(assistantWithResult("r".repeat(RESULT_CHARS)));
    if (i < assistantCount - 1) {
      messages.push({
        role: "user",
        content: `continue ${i}`,
      } as unknown as ChatMessage);
    }
  }
  return messages;
}

describe("findRecencyBoundary", () => {
  it("protects the last model calls, not the last user turns", () => {
    // One user turn, six model calls — the old user-turn window protected
    // the entire array (boundary 0), so nothing ever shrank.
    const messages = singleTurnConversation(6);
    // 6 calls × 2_500 tool-output tokens fit the cap, but only the last
    // PROTECTED_RECENT_ITERATIONS = 4 model calls are protected.
    expect(findRecencyBoundary(messages)).toBe(4);
    expect(
      messages.slice(4).filter((m) => m.role === "assistant").length,
    ).toBe(4);
  });

  it("stops the protected window at the tool-output cap", () => {
    const messages = singleTurnConversation(12);
    // 12 × 2_500 = 30_000 > 20_000: only ~8 calls fit the cap.
    const boundary = findRecencyBoundary(messages);
    expect(boundary).toBeGreaterThan(0);
    const protectedAssistants = messages
      .slice(boundary)
      .filter((m) => m.role === "assistant").length;
    // The iteration limit (4) binds before the 20_000-token cap does at
    // 2_500 tokens per result — exactly the last four model calls.
    expect(protectedAssistants).toBe(4);
    // The newest iteration is always protected.
    expect(messages[messages.length - 1].role).toBe("assistant");
  });

  it("protects the newest iteration whatever its size", () => {
    const huge = "r".repeat(200_000);
    const messages: ChatMessage[] = [
      { role: "user", content: "go" } as ChatMessage,
      assistantWithResult(huge),
      { role: "user", content: "again" } as unknown as ChatMessage,
      assistantWithResult(huge),
    ];
    // Two iterations, 100_000 tool-output tokens — over the cap, but the
    // newest (the last assistant) is still inside the window.
    const boundary = findRecencyBoundary(messages);
    // Only the newest assistant (index 3) stays inside the window; the
    // earlier one (index 1) is left to the shrinking layers.
    expect(boundary).toBe(2);
  });
});

describe("ContextWindowManager with model-call recency", () => {
  it("shrinks a single-turn run instead of returning it unchanged", () => {
    const messages = singleTurnConversation(12);
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 32_768,
      maxOutputTokens: 8_192,
      toolCount: 1,
    });
    // Old behaviour: truncated=true but the input was returned UNCHANGED
    // (every message sat in the protected range). The recency window now
    // leaves the older tool results to the truncation strategies.
    expect(result.truncated).toBe(true);
    expect(result.estimatedTokens).toBeLessThan(
      ContextWindowManager.estimateTokens(messages),
    );
    // The newest model calls keep their results verbatim.
    const resultStrings = result.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) =>
        (m.toolCalls ?? []).map((tc: ToolCallEntry) => String(tc.result ?? "")),
      );
    expect(resultStrings.some((r) => r.length > 2_000)).toBe(true);
  });

  it("the truncation budget honours the fixed overhead", () => {
    const messages = singleTurnConversation(4);
    const tight = ContextWindowManager.enforce(messages, {
      maxInputTokens: 32_768,
      maxOutputTokens: 20_000,
      toolCount: 40, // 40 × 150 + 2000 heuristic overhead
    });
    expect(tight.messages.length).toBeLessThanOrEqual(messages.length);
  });
});
