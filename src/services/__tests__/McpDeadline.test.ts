import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { raceToolDeadline } from "../McpAdapter.js";
import CONFIG from "../../../config.js";
import { GUARD_CONFIG } from "../ToolCallGuard.js";

// 2026-08-26 (cycle-v3-1787786020/KSS): get_finnhub_news + lazy_web_search both
// died as `MCP error -32001: Request timed out`. Prism's MCP client cancels at
// a fixed 60s (SDK default, never overridden on its agentic path) while our
// bridge deadline for SLOW_TOOLS was ALSO 60s — an exact tie the client always
// wins because its clock starts first, plus up to 15s of ToolCallGuard acquire
// wait before the bridge fetch even begins. The -32001 protocol error (instead
// of a structured tool result) fed prism's empty-output recovery loop until
// the junior analyst phase died with outputTokens=1.
//
// The fix: McpAdapter answers with a structured TOOL_TIMEOUT result BEFORE the
// client's 60s, and the whole budget is pinned so no future edit can
// reintroduce the tie.

describe("raceToolDeadline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns a structured TOOL_TIMEOUT result when the tool outlives the deadline", async () => {
    const never = new Promise<never>(() => {});
    const race = raceToolDeadline("get_finnhub_news", never as never, 1_000);
    await vi.advanceTimersByTimeAsync(1_001);
    const result = await race;
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toContain("TOOL_TIMEOUT");
    expect(payload.error).toContain("get_finnhub_news");
    // The message is model-facing: it must counter prism's argument-fixing
    // retry guidance, not just describe the timeout.
    expect(payload.error).toContain("do not retry the same call");
    expect(payload.tool).toBe("get_finnhub_news");
  });

  it("passes a fast tool result through untouched", async () => {
    const ok = { content: [{ type: "text" as const, text: '{"rows":3}' }] };
    const race = raceToolDeadline("get_market_data", Promise.resolve(ok), 1_000);
    await vi.advanceTimersByTimeAsync(0);
    await expect(race).resolves.toBe(ok);
    // And the expiry timer must not linger: advancing past the deadline after
    // resolution must not blow up or re-resolve anything.
    await vi.advanceTimersByTimeAsync(5_000);
  });

  it("SABOTAGE CONTROL: without a finite deadline the old hang is back", async () => {
    // This is the pre-fix shape — an execution nothing bounds. If someone
    // "simplifies" raceToolDeadline into a pass-through, the timeout test
    // above fails; this control documents what the pass-through looks like.
    let settled = false;
    const never = new Promise<never>(() => {});
    raceToolDeadline("get_finnhub_news", never as never, Infinity).then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await vi.advanceTimersByTimeAsync(600_000);
    expect(settled).toBe(false);
  });
});

describe("the tool-timeout budget invariant", () => {
  // SLOW_TOOL_TIMEOUT_MS + guard acquire wait <= MCP_TOOL_DEADLINE_MS < 60s.
  // Failed on the pre-fix numbers (60_000 + 15_000 > 60_000): the bridge could
  // not answer before prism's MCP client gave up, so every slow tool surfaced
  // as -32001. 60_000 is the MCP SDK's DEFAULT_REQUEST_TIMEOUT_MSEC, which
  // prism never overrides and we cannot change (read-only upstream).
  const PRISM_MCP_CLIENT_TIMEOUT_MS = 60_000;

  it("the bridge (plus worst-case guard wait) answers before the adapter deadline", () => {
    expect(CONFIG.SLOW_TOOL_TIMEOUT_MS + GUARD_CONFIG.ACQUIRE_TIMEOUT_MS)
      .toBeLessThanOrEqual(CONFIG.MCP_TOOL_DEADLINE_MS);
  });

  it("the adapter deadline answers before prism's MCP client cancels", () => {
    expect(CONFIG.MCP_TOOL_DEADLINE_MS).toBeLessThan(PRISM_MCP_CLIENT_TIMEOUT_MS);
  });

  it("the fast-tool bridge deadline sits under the adapter deadline too", () => {
    expect(CONFIG.EXECUTION_TIMEOUT_MS + GUARD_CONFIG.ACQUIRE_TIMEOUT_MS)
      .toBeLessThanOrEqual(CONFIG.MCP_TOOL_DEADLINE_MS);
  });
});
