import { afterEach, describe, expect, it, vi } from "vitest";
import MongoWrapper from "../../wrappers/MongoWrapper.ts";
import { PromotionController } from "../PromotionController.ts";
import { tradingShimProfileId } from "../TradingToolProtocol.ts";
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

  it("partitions learned stacks by model family (qwen vs deepseek) with role-wide fallback when family n < 30", () => {
    const deepseekRuns = Array.from({ length: 40 }, (_, i) => ({
      agent: "v3_quant_analyst",
      cycleId: `ds-${i}`,
      ticker: "NVDA",
      model: "DeepSeek-V4.1-Flash-1017",
    }));
    const qwenRuns = Array.from({ length: 20 }, (_, i) => ({
      agent: "v3_quant_analyst",
      cycleId: `qw-${i}`,
      ticker: "NVDA",
      model: "Qwen3.8-Flash-Next",
    }));
    const allRuns = [...deepseekRuns, ...qwenRuns];
    const stacks = learnStacks(allRuns, [
      ...allRuns.map((r) => ({ ...r, tool: "get_polygon_price_history", argsHash: "h1" })),
      ...allRuns.map((r) => ({ ...r, tool: "get_technical_indicators", argsHash: "h2" })),
      ...deepseekRuns.map((r) => ({ ...r, tool: "get_market_data", argsHash: "h3" })),
    ]);
    // DeepSeek has n=40 >= 30, so its 3-tool stack is learned specifically for `v3_quant_analyst|deepseek`.
    expect(stacks.get("v3_quant_analyst|deepseek")).toEqual([
      "get_market_data",
      "get_polygon_price_history",
      "get_technical_indicators",
    ]);
    // Qwen has n=20 < 30, so no `|qwen` stack yet; it inherits the role-wide 2-tool stack (n=60).
    expect(stacks.has("v3_quant_analyst|qwen")).toBe(false);
    expect(stacks.get("v3_quant_analyst")).toEqual([
      "get_polygon_price_history",
      "get_technical_indicators",
    ]);
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

  it("keeps role-wide baseline stack for live payloads until family promotion is active", async () => {
    const dsRuns = Array.from({ length: 35 }, (_, i) => ({
      agent_name: "v3_quant_analyst",
      cycle_id: `cycle-ds-${i}`,
      ticker: "NVDA",
      model_used: "DeepSeek-V4.1-Flash-1017",
    }));
    const qwenRuns = Array.from({ length: 35 }, (_, i) => ({
      agent_name: "v3_quant_analyst",
      cycle_id: `cycle-qw-${i}`,
      ticker: "NVDA",
      model_used: "Qwen3.8-Flash-Next",
    }));
    const allRuns = [...dsRuns, ...qwenRuns];
    const docs: Record<string, Record<string, unknown>[]> = {
      v3_agent_telemetry: allRuns,
      agent_tool_telemetry: [
        // Both families call price_history + market_data -> role-wide baseline stack has 2 tools
        ...allRuns.flatMap((r) => [
          { ...r, tool_name: "get_polygon_price_history", args_hash: "h" },
          { ...r, tool_name: "get_market_data", args_hash: "h" },
        ]),
        // Only DeepSeek also calls technical_indicators (>= 90% of DeepSeek runs, 50% role-wide)
        ...dsRuns.map((r) => ({ ...r, tool_name: "get_technical_indicators", args_hash: "h" })),
      ],
    };
    const find = vi.fn((collection: string) => ({ toArray: async () => docs[collection] }));
    vi.spyOn(MongoWrapper, "getDb").mockReturnValue({ collection: (name: string) => ({ find: () => find(name) }) } as never);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 8 * 60 * 60 * 1000);
    vi.spyOn(PromotionController, "getActive").mockReturnValue(undefined);

    const catalog = ["get_polygon_price_history", "get_market_data", "get_technical_indicators"];
    openingStack("v3_quant_analyst", catalog, "DeepSeek-V4.1-Flash-1017");
    await vi.waitFor(() => expect(find).toHaveBeenCalledTimes(2));

    // Unpromoted: DeepSeek still receives the role-wide baseline stack (zero unpromoted payload drift).
    await vi.waitFor(() =>
      expect(openingStack("v3_quant_analyst", catalog, "DeepSeek-V4.1-Flash-1017")).toEqual([
        "get_market_data",
        "get_polygon_price_history",
      ]),
    );

    // Offline evaluation opt-in or active PromotionController selects the DeepSeek-specific 3-tool stack.
    expect(
      openingStack("v3_quant_analyst", catalog, "DeepSeek-V4.1-Flash-1017", { allowUnpromotedFamily: true }),
    ).toEqual(["get_market_data", "get_polygon_price_history", "get_technical_indicators"]);

    vi.spyOn(PromotionController, "getActive").mockImplementation((pid: string) =>
      pid === tradingShimProfileId("v3_quant_analyst", "deepseek") ? ({ version: "1.0.0", channel: "active" } as never) : undefined,
    );
    expect(openingStack("v3_quant_analyst", catalog, "DeepSeek-V4.1-Flash-1017")).toEqual([
      "get_market_data",
      "get_polygon_price_history",
      "get_technical_indicators",
    ]);
  });
});
