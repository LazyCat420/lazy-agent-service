// Tests for ch.06 item 7: tool-result bounding on the non-trading paths —
// prism's 8k semantics with our cut, and no mid-JSON slice.
import { describe, expect, it } from "vitest";

import {
  expandMessagesForFunctionCall,
  truncateToolResult,
} from "../FunctionCallingUtilities.ts";
import type { ChatMessage, ToolCallEntry } from "../../types/admin.ts";

describe("truncateToolResult", () => {
  it("passes small results through untouched", () => {
    const result = { a: 1, list: [1, 2, 3] };
    expect(truncateToolResult(result)).toEqual(result);
    expect(truncateToolResult("short")).toBe("short");
  });

  it("bounds oversized strings with a line-aligned preview", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}: ${"x".repeat(60)}`).join("\n");
    const cut = truncateToolResult(text) as string;
    expect(cut.length).toBeLessThanOrEqual(8_600);
    expect(cut).toContain("cut to fit");
    expect(text.startsWith(cut.split("\n[")[0])).toBe(true);
  });

  it("never emits invalid JSON (no mid-JSON byte slice)", () => {
    // A 30k-char field used to become `{"data":"…<8000 chars>…}"` — a
    // serialized string sliced through its middle with a literal "…}".
    const result = { data: "d".repeat(30_000), id: 7 };
    const cut = truncateToolResult(result) as string;
    expect(typeof cut).toBe("string");
    expect(() => JSON.parse(cut as string)).not.toThrow();
    expect((cut as string).includes("…}")).toBe(false);
    expect(cut.length).toBeLessThanOrEqual(8_400);
  });

  it("caps top-level arrays at 10 items", () => {
    const cut = truncateToolResult(
      Array.from({ length: 40 }, (_, i) => ({ i, text: "t".repeat(400) })),
    ) as { _truncated?: string }[] | string;
    if (Array.isArray(cut)) {
      expect(cut.length).toBe(11);
      expect(cut[10]._truncated).toBe("Showing 10 of 40");
    } else {
      expect(() => JSON.parse(cut)).not.toThrow();
    }
  });

  it("caps arrays under known wrapper keys", () => {
    const cut = truncateToolResult({
      articles: Array.from({ length: 30 }, (_, i) => ({ id: i })),
    }) as { articles: unknown[]; _articlesTruncated: string };
    expect(cut.articles.length).toBe(10);
    expect(cut._articlesTruncated).toBe("Showing 10 of 30");
  });
});

describe("expandMessagesForFunctionCall bounding", () => {
  it("bounds oversized standalone tool messages", () => {
    const messages = [
      {
        role: "tool",
        tool_call_id: "t1",
        name: "lazy_web_search",
        content: "y".repeat(20_000),
      },
    ] as unknown as ChatMessage[];
    const expanded = expandMessagesForFunctionCall(messages, {
      filterDeleted: false,
    });
    expect(expanded.length).toBe(1);
    expect(String(expanded[0].content).length).toBeLessThanOrEqual(8_600);
  });

  it("bounds oversized results on assistant tool calls", () => {
    const messages = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "t1",
            name: "read_file",
            args: {},
            result: "z".repeat(20_000),
          } as ToolCallEntry,
        ],
      },
    ] as unknown as ChatMessage[];
    const expanded = expandMessagesForFunctionCall(messages, {
      filterDeleted: false,
    });
    const toolMessage = expanded.find((m) => m.role === "tool");
    expect(String(toolMessage?.content).length).toBeLessThanOrEqual(8_600);
  });
});
