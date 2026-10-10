import { describe, it, expect } from "vitest";
import { normalizeRoleAlternation } from "../RoleAlternation.ts";
import type { ConversationMessage } from "../harnesses/types.ts";

const msg = (role: string, content: string): ConversationMessage =>
  ({ role, content }) as ConversationMessage;

const withToolCalls = (content: string, ids: string[]): ConversationMessage =>
  ({
    role: "assistant",
    content,
    toolCalls: ids.map((id) => ({ id, name: "read_file", result: "ok" })),
  }) as ConversationMessage;

describe("normalizeRoleAlternation", () => {
  it("merges consecutive same-role non-tool messages with a double newline", () => {
    const { messages } = normalizeRoleAlternation([
      msg("user", "hello"),
      msg("user", "world"),
      msg("assistant", "answer A"),
      msg("assistant", "answer B"),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", content: "hello\n\nworld" });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "answer A\n\nanswer B" });
  });

  it("never merges assistant messages that carry toolCalls", () => {
    const { messages } = normalizeRoleAlternation([
      withToolCalls("calling", ["t1"]),
      withToolCalls("calling again", ["t2"]),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0].toolCalls).toHaveLength(1);
    expect(messages[1].toolCalls).toHaveLength(1);
  });

  it("preserves the assistant(toolCalls) → tool → assistant shape", () => {
    const shape = [
      msg("user", "go"),
      withToolCalls("calling", ["t1"]),
      msg("tool", "result"),
      msg("assistant", "done"),
    ];
    const { messages } = normalizeRoleAlternation(shape);

    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("drops tool-result messages with no preceding assistant toolCalls message", () => {
    const { messages, droppedOrphanToolResults } = normalizeRoleAlternation([
      msg("tool", "orphan result"),
      msg("user", "hi"),
      msg("assistant", "hi back"),
      msg("tool", "second orphan"),
    ]);

    expect(droppedOrphanToolResults).toBe(2);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("keeps tool results that follow an assistant with toolCalls", () => {
    const { messages, droppedOrphanToolResults } = normalizeRoleAlternation([
      withToolCalls("calling", ["t1"]),
      msg("tool", "result"),
    ]);

    expect(droppedOrphanToolResults).toBe(0);
    expect(messages).toHaveLength(2);
  });

  it("moves the first system message to position 0 and merges later system messages into it", () => {
    const { messages } = normalizeRoleAlternation([
      msg("user", "first"),
      msg("system", "late system"),
      msg("assistant", "reply"),
      msg("system", "extra directives"),
      msg("system", "more directives"),
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      role: "system",
      content: "late system\n\nextra directives\n\nmore directives",
    });
    expect(messages[1]).toMatchObject({ role: "user", content: "first" });
    expect(messages[2]).toMatchObject({ role: "assistant", content: "reply" });
  });

  it("leaves a leading system message in place and merges subsequent ones", () => {
    const { messages } = normalizeRoleAlternation([
      msg("system", "base prompt"),
      msg("system", "addendum"),
      msg("user", "question"),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "system",
      content: "base prompt\n\naddendum",
    });
  });

  it("does not mutate the input array", () => {
    const input = [msg("user", "a"), msg("user", "b")];
    normalizeRoleAlternation(input);

    expect(input).toHaveLength(2);
    expect(input[0].content).toBe("a");
  });
});
