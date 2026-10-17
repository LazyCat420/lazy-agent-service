import { afterEach, describe, expect, it, vi } from "vitest";
import MongoWrapper from "../../wrappers/MongoWrapper.ts";
import { learnStacks, openingStack, type RunRecord, type ToolUseRecord } from "../TradingToolStacks.ts";

const runs = (agent: string, n: number): RunRecord[] =>
  Array.from({ length: n }, (_, i) => ({ agent, cycleId: `cycle-${i}`, ticker: "AMD" }));
const uses = (agent: string, tool: string, n: number, argsHash = "h"): ToolUseRecord[] =>
  runs(agent, n).map((r) => ({ ...r, tool, argsHash }));

describe("learnStacks", () => {
  it("keeps ticker-keyed reads present in at least 90 % of a role's successful runs, most frequent first", () => {
    const stacks = learnStacks(runs("v3_junior_analyst", 100), [
      ...uses("v3_junior_analyst", "get_finnhub_news", 95),
      ...uses("v3_junior_analyst", "mcp__lazy-agent-service__get_upcoming_events", 98),
      ...uses("v3_junior_analyst", "get_institutional_holdings", 90),
      ...uses("v3_junior_analyst", "get_market_data", 89),
      ...uses("v3_junior_analyst", "whiteboard_write", 100),
      ...uses("v3_junior_analyst", "lazy_web_search", 100),
    ]);
    expect(stacks.get("v3_junior_analyst")).toEqual(["get_upcoming_events", "get_finnhub_news", "get_institutional_holdings"]);
  });

  it("ignores autoroute prefetches, unsuccessful runs, thin samples and single-tool stacks", () => {
    const stacks = learnStacks([...runs("v3_fundamental_analyst", 50), ...runs("v3_quant_analyst", 29), ...runs("v3_valuation_analyst", 50)], [
      ...uses("v3_fundamental_analyst", "get_earnings_data", 50, "autoroute:abc"),
      ...uses("v3_fundamental_analyst", "get_institutional_holdings", 50, "autoroute:def"),
      // calls in runs that never succeeded do not count toward presence
      ...uses("v3_fundamental_analyst", "get_finnhub_news", 50).map((u) => ({ ...u, cycleId: `failed-${u.cycleId}` })),
      ...uses("v3_quant_analyst", "get_polygon_price_history", 29),
      ...uses("v3_quant_analyst", "get_market_data", 29),
      ...uses("v3_valuation_analyst", "get_finviz_fundamentals", 50),
    ]);
    expect([...stacks.keys()]).toEqual([]);
  });
});

describe("openingStack", () => {
  afterEach(() => { vi.restoreAllMocks(); delete process.env.TRADING_TOOL_STACKS; });

  it("learns from the trading telemetry collections and names only tools in the signed catalog", async () => {
    const docs: Record<string, Record<string, unknown>[]> = {
      v3_agent_telemetry: runs("v3_junior_analyst", 40).map((r) => ({ agent_name: r.agent, cycle_id: r.cycleId, ticker: r.ticker })),
      agent_tool_telemetry: ["get_upcoming_events", "get_finnhub_news", "get_institutional_holdings"].flatMap((tool) =>
        runs("v3_junior_analyst", 40).map((r) => ({ agent_name: r.agent, cycle_id: r.cycleId, ticker: r.ticker, tool_name: tool, args_hash: "h" }))),
    };
    const find = vi.fn((collection: string) => ({ toArray: async () => docs[collection] }));
    vi.spyOn(MongoWrapper, "getDb").mockReturnValue({ collection: (name: string) => ({ find: () => find(name) }) } as never);

    const catalog = ["get_upcoming_events", "get_finnhub_news", "whiteboard_write"];
    expect(openingStack("v3_junior_analyst", catalog)).toEqual([]); // the refresh never blocks a request
    await vi.waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(openingStack("v3_junior_analyst", catalog)).toEqual(["get_finnhub_news", "get_upcoming_events"]));
    expect(openingStack("v3_junior_analyst", ["get_upcoming_events"])).toEqual([]);
    process.env.TRADING_TOOL_STACKS = "false";
    expect(openingStack("v3_junior_analyst", catalog)).toEqual([]);
  });
});
