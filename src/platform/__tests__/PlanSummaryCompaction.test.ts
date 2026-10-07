import { describe, it, expect } from "vitest";
import {
  compactToolResultsForPressure,
  compactWithPlanSummary,
} from "../../services/AgenticLoopService.ts";
import type { ConversationMessage } from "../../services/harnesses/types.ts";

function bigToolTurn(name: string, filler: string, withResult = true): ConversationMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: `call_${name}`,
        name,
        args: { target: "a/b.ts" },
        ...(withResult ? { result: { success: true, message: filler } } : {}),
      },
    ],
  };
}

const LARGE = "y".repeat(2000);

function pressuredHistory(): ConversationMessage[] {
  return [
    bigToolTurn("turn1", LARGE),
    bigToolTurn("turn2", LARGE),
    bigToolTurn("turn3", LARGE),
    bigToolTurn("turn4", LARGE),
    bigToolTurn("turn5", LARGE, false), // open item: no result recorded
  ];
}

describe("compactWithPlanSummary", () => {
  it("returns input unchanged when compaction does not fire", () => {
    const messages: ConversationMessage[] = [
      bigToolTurn("a", "x".repeat(50)),
      bigToolTurn("b", "x".repeat(50)),
      bigToolTurn("c", "x".repeat(50)),
      bigToolTurn("d", "x".repeat(50)),
      bigToolTurn("e", "x".repeat(50)),
    ];
    expect(compactWithPlanSummary(messages, { totalMaxChars: 5000 })).toBe(messages);
  });

  it("prepends a deterministic plan summary with request, state, and open items", () => {
    const messages = pressuredHistory();
    const compacted = compactWithPlanSummary(messages, {
      totalMaxChars: 5000,
      pressureRatio: 0.6,
      originalRequest: "Fix the flaky parser tests",
    });

    // One system message prepended; compaction still applied to the rest.
    expect(compacted).toHaveLength(messages.length + 1);
    expect(compacted[0].role).toBe("system");
    const summary = String(compacted[0].content);
    expect(summary).toContain("[plan summary]");
    expect(summary).toContain("Fix the flaky parser tests");
    expect(summary).toContain("5 tool turn(s)");
    expect(summary).toContain("turn1, turn2, turn3, turn4, turn5");
    expect(summary).toContain("turn5");
    expect(summary).toContain("no result recorded");
    // Compacted placeholder results survive after the summary.
    expect(String((compacted[1].toolCalls![0].result as Record<string, unknown>).message)).toContain(
      "[compacted] turn1 result summary:",
    );

    // Deterministic: same input → byte-identical summary.
    const again = compactWithPlanSummary(messages, {
      totalMaxChars: 5000,
      pressureRatio: 0.6,
      originalRequest: "Fix the flaky parser tests",
    });
    expect(again[0].content).toBe(summary);
  });

  it("falls back to the latest assistant statement as focus when all calls are resolved", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "go" },
      bigToolTurn("turn1", LARGE),
      { role: "assistant", content: "Parser now passes locally." },
      bigToolTurn("turn2", LARGE),
      bigToolTurn("turn3", LARGE),
      bigToolTurn("turn4", LARGE),
    ];
    const compacted = compactWithPlanSummary(messages, {
      totalMaxChars: 2000,
      pressureRatio: 0.6,
    });
    const summary = String(compacted[0].content);
    expect(summary).toContain("none — all issued tool calls have results");
    expect(summary).toContain("Parser now passes locally.");
    expect(summary).toContain("(not provided)");
  });

  it("fires postCompact on a duck-typed hooks instance after prepending", () => {
    const events: Array<[string, unknown]> = [];
    const hooks = {
      run: (event: string, payload?: unknown) => {
        events.push([event, payload]);
        return Promise.resolve();
      },
    };
    compactWithPlanSummary(pressuredHistory(), {
      totalMaxChars: 5000,
      pressureRatio: 0.6,
      hooks,
    });
    expect(events).toEqual([
      ["postCompact", { turnCount: 5, toolsUsed: ["turn1", "turn2", "turn3", "turn4", "turn5"], openItemCount: 1 }],
    ]);
  });

  it("does not fire postCompact when compaction does not fire", () => {
    const events: Array<[string, unknown]> = [];
    const hooks = { run: (event: string, payload?: unknown) => void events.push([event, payload]) };
    const messages = [
      bigToolTurn("a", "x".repeat(50)),
      bigToolTurn("b", "x".repeat(50)),
      bigToolTurn("c", "x".repeat(50)),
      bigToolTurn("d", "x".repeat(50)),
      bigToolTurn("e", "x".repeat(50)),
    ];
    compactWithPlanSummary(messages, { totalMaxChars: 5000, hooks });
    expect(events).toEqual([]);
  });
});

describe("compactToolResultsForPressure (baseline unchanged)", () => {
  it("still returns the same array when under pressure", () => {
    const messages: ConversationMessage[] = [bigToolTurn("a", "x")];
    expect(compactToolResultsForPressure(messages)).toBe(messages);
  });
});
