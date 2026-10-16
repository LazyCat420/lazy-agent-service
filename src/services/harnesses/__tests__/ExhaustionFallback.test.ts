/**
 * ch.06 item 9 — forced final turn parity (the rest after dfa1c84/f4d6e86).
 *
 * The exhaustion pass keeps the same tool block as every other request of
 * the turn (only tool_choice "none" — dropping `tools` rewrote the front of
 * the prompt and missed the cache), and when the recovery pass itself comes
 * back empty, a synthetic summary is built from the tool history so the
 * parent orchestrator never receives "[No output]".
 * Ported from prism-service ExhaustionRecovery.ts.
 */
import { describe, expect, it } from "vitest";

import {
  buildSyntheticFallbackSummary,
} from "../../harnesses/lifecycle/ExhaustionRecovery.ts";
import type { AgenticLoopState } from "../../AgenticLoopState.ts";

function stateWith(toolCalls: Array<{ name: string; args?: unknown; result?: unknown }>, iterations = 7): AgenticLoopState {
  return {
    iterations,
    streamedToolCalls: toolCalls.map((toolCall) => ({
      id: `call_${toolCall.name}`,
      name: toolCall.name,
      args: (toolCall.args ?? {}) as Record<string, unknown>,
      result: toolCall.result,
    })),
  } as unknown as AgenticLoopState;
}

describe("buildSyntheticFallbackSummary", () => {
  it("names the iteration count and the tool usage", () => {
    const state = stateWith([
      { name: "get_market_data", args: { ticker: "COF" }, result: '{"price": 42}' },
      { name: "get_market_data", args: { ticker: "AAPL" }, result: '{"price": 190}' },
      { name: "search_web", args: { q: "fed" }, result: "ok" },
    ]);
    const summary = buildSyntheticFallbackSummary(state, []);
    expect(summary).toContain("after 7 iterations");
    expect(summary).toContain("get_market_data: 2 call(s)");
    expect(summary).toContain("search_web: 1 call(s)");
  });

  it("includes recent tool results with the call arguments", () => {
    const state = stateWith([{ name: "get_market_data", args: { ticker: "COF" }, result: '{"price": 42}' }]);
    const messages = [
      {
        role: "assistant",
        toolCalls: [{ id: "c1", name: "get_market_data", args: { ticker: "COF" }, result: '{"price": 42}' }],
      },
    ] as never[];
    const summary = buildSyntheticFallbackSummary(state, messages);
    expect(summary).toContain("get_market_data(");
    expect(summary).toContain('{"price": 42}');
  });

  it("truncates oversized results behind an ellipsis", () => {
    const state = stateWith([{ name: "big", result: "x".repeat(2000) }]);
    const messages = [
      { role: "assistant", toolCalls: [{ id: "c1", name: "big", args: {}, result: "x".repeat(2000) }] },
    ] as never[];
    const summary = buildSyntheticFallbackSummary(state, messages);
    expect(summary).toContain("…");
    expect(summary.length).toBeLessThan(3000);
  });
});
