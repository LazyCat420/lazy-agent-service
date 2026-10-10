import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../SettingsService.ts", () => ({
  default: { getSection: vi.fn(async () => ({ extractionProvider: "p", extractionModel: "m" })) },
}));

vi.mock("../../providers/instance-registry.ts", () => ({
  getInstancesByType: vi.fn(() => [{ id: "inst-1" }]),
  getInstanceType: vi.fn(() => "openai"),
}));

vi.mock("../../utils/ModelResolution.ts", () => ({
  resolveModelForInstances: vi.fn(async () => ({
    usable: [{ id: "inst-1" }],
    modelOverrides: new Map(),
  })),
}));

const generateText = vi.fn(async () => ({
  text: "<summary>summarized conversation</summary>",
  usage: { inputTokens: 10, outputTokens: 5 },
}));

vi.mock("../../providers/index.ts", () => ({
  getProvider: vi.fn(() => ({ generateText })),
}));

vi.mock("../RequestLogger.ts", () => ({
  default: { logBackgroundLlmCall: vi.fn(async () => {}) },
}));

import CompactionService, {
  enforceToolPairIntegrity,
} from "../compact/CompactionService.ts";
import type { ChatMessage as AdminChatMessage } from "../../types/admin.ts";

const msg = (role: string, content: string): AdminChatMessage =>
  ({ role, content }) as AdminChatMessage;

const assistantWithToolCall = (id: string): AdminChatMessage =>
  ({
    role: "assistant",
    content: "calling tool",
    toolCalls: [{ id, name: "read_file", args: {}, result: "ok" }],
  }) as AdminChatMessage;

const toolResult = (id: string): AdminChatMessage =>
  ({ role: "tool", tool_call_id: id, name: "read_file", content: "ok" }) as AdminChatMessage;

describe("enforceToolPairIntegrity", () => {
  beforeEach(() => {
    CompactionService.resetCircuitBreaker();
    generateText.mockClear();
  });

  it("keeps an assistant and its tool result together when the assistant is kept", () => {
    const messages = [
      msg("user", "turn 1"),
      assistantWithToolCall("a1"),
      toolResult("a1"),
      msg("user", "turn 2"),
    ];
    const kept = [false, true, true, true];

    expect(enforceToolPairIntegrity(messages, kept)).toEqual([
      false,
      true,
      true,
      true,
    ]);
  });

  it("drops a kept tool result whose owning assistant is dropped", () => {
    const messages = [
      msg("user", "turn 1"),
      assistantWithToolCall("a1"),
      toolResult("a1"),
      msg("user", "turn 2"),
    ];
    const kept = [false, false, true, true];

    expect(enforceToolPairIntegrity(messages, kept)).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it("drops an assistant whose tool result was already dropped (cascade)", () => {
    const messages = [
      msg("user", "turn 1"),
      assistantWithToolCall("a1"),
      toolResult("a1"),
      msg("user", "turn 2"),
    ];
    // Assistant kept, result dropped — the assistant must follow.
    const kept = [false, true, false, true];

    expect(enforceToolPairIntegrity(messages, kept)).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it("drops a tool result whose id is not declared by the owning assistant", () => {
    const messages = [
      msg("user", "turn 1"),
      assistantWithToolCall("a1"),
      toolResult("a1"),
      toolResult("unknown-id"),
      msg("user", "turn 2"),
    ];
    const kept = [false, true, true, true, true];

    expect(enforceToolPairIntegrity(messages, kept)).toEqual([
      false,
      true,
      true,
      false,
      true,
    ]);
  });

  it("compaction keeps dropped tool pairs together and calls the memory flush", async () => {
    const memoryFlush = vi.fn(async () => {});
    // 5 user turns: only the last 3 survive extractRecentTail, so the
    // first turn's assistant+tool pair would land in the dropped range.
    const messages: AdminChatMessage[] = [
      msg("system", "system prompt"),
      msg("user", "turn 1"),
      assistantWithToolCall("a1"),
      toolResult("a1"),
      msg("user", "turn 2"),
      msg("assistant", "answer 2"),
      msg("user", "turn 3"),
      msg("assistant", "answer 3"),
      msg("user", "turn 4"),
      msg("assistant", "answer 4"),
      msg("user", "turn 5"),
    ];

    const result = await CompactionService.compactConversation(messages, {
      project: "p",
      username: "u",
      memoryFlush,
    });

    expect(memoryFlush).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();

    const compacted = result!.compactedMessages;
    // The dropped a1 pair is fully absent — no orphan result, no orphan call.
    expect(
      compacted.some(
        (m) =>
          (m as AdminChatMessage).tool_call_id === "a1" ||
          (m as AdminChatMessage).toolCalls?.some((tc) => tc.id === "a1"),
      ),
    ).toBe(false);
    // Recent tail survives intact.
    expect(compacted.some((m) => m.content === "turn 5")).toBe(true);
  });

  it("continues with compaction when the memory flush rejects", async () => {
    const memoryFlush = vi.fn(async () => {
      throw new Error("memory backend down");
    });
    const messages: AdminChatMessage[] = [
      msg("user", "turn 1"),
      msg("assistant", "answer 1"),
      msg("user", "turn 2"),
      msg("assistant", "answer 2"),
      msg("user", "turn 3"),
    ];

    const result = await CompactionService.compactConversation(messages, {
      project: "p",
      username: "u",
      memoryFlush,
    });

    expect(memoryFlush).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(result!.summaryText).toBe("summarized conversation");
  });
});
