import { afterEach, describe, expect, it, vi } from "vitest";
import MongoWrapper from "../../wrappers/MongoWrapper.ts";
import { PromotionController } from "../PromotionController.ts";
import { tradingShimProfileId } from "../TradingToolProtocol.ts";
import {
  learnedStacksSnapshot,
  learnSequences,
  learnStacks,
  openingBundleHint,
  openingStack,
  refreshLearnedStacks,
  type RunRecord,
  type ToolUseRecord,
} from "../TradingToolStacks.ts";

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
    await vi.waitFor(() => expect(find).toHaveBeenCalledTimes(3));
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
    await vi.waitFor(() => expect(find).toHaveBeenCalledTimes(3));

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

  it("mines universal sequences across tool_usage_stats, excludes probes, persists learned_tool_stacks, and renders openingBundleHint", async () => {
    const seqUses: ToolUseRecord[] = [];
    const baseTime = 1_760_000_000_000;
    const rwRuns = runs("research_worker", 6);
    rwRuns.forEach((r, idx) => {
      seqUses.push(
        { ...r, tool: "get_market_data", argsHash: "a1", timestamp: baseTime + idx * 10_000 },
        { ...r, tool: "get_finviz_fundamentals", argsHash: "a2", timestamp: baseTime + idx * 10_000 + 500 },
        { ...r, tool: "get_earnings_data", argsHash: "a3", timestamp: baseTime + idx * 10_000 + 1500 },
        // Write tool and failed call must never enter read-only sequences
        { ...r, tool: "save_equation", argsHash: "w1", timestamp: baseTime + idx * 10_000 + 2500 },
      );
    });
    const learnedSeqMap = learnSequences(rwRuns, seqUses);
    expect(learnedSeqMap.get("research_worker")?.[0]?.tools).toEqual([
      "get_market_data",
      "get_finviz_fundamentals",
      "get_earnings_data",
    ]);

    const upserts: Array<{ filter: unknown; update: unknown }> = [];
    const deletes: unknown[] = [];
    const usageDocs = Array.from({ length: 6 }, (_, idx) => [
      {
        agent_name: "user_chat",
        cycle_id: `chat-${idx}`,
        ticker: "AAPL",
        tool_name: "get_market_data",
        args_hash: "u1",
        called_at: new Date(baseTime + idx * 10_000),
        success: true,
        service_source: "trading-client",
      },
      {
        agent_name: "user_chat",
        cycle_id: `chat-${idx}`,
        ticker: "AAPL",
        tool_name: "get_finnhub_news",
        args_hash: "u2",
        called_at: new Date(baseTime + idx * 10_000 + 800),
        success: true,
        service_source: "trading-client",
      },
    ]).flat();
    // Duplicate of first doc inside agent_tool_telemetry + probe rows that must be excluded
    const telDocs = [
      { ...usageDocs[0], timestamp: usageDocs[0].called_at },
      {
        agent_name: "probe_agent",
        cycle_id: "cycle-audit-2026-11-21",
        ticker: "SPY",
        tool_name: "get_market_data",
        args_hash: "p1",
        service_source: "audit-probe",
      },
      {
        agent_name: "contract_probe_agent",
        cycle_id: "cycle-99",
        ticker: "SPY",
        tool_name: "get_market_data",
        args_hash: "p2",
        service_source: "contract-test",
      },
      {
        agent_name: "boundary_probe_agent",
        cycle_id: "probe-boundary-2026-11-21",
        ticker: "SPY",
        tool_name: "get_market_data",
        args_hash: "p3",
        service_source: "lazy-agent-service",
      },
    ];
    const docs: Record<string, Record<string, unknown>[]> = {
      v3_agent_telemetry: [],
      agent_tool_telemetry: telDocs,
      tool_usage_stats: usageDocs,
    };
    vi.spyOn(MongoWrapper, "getDb").mockReturnValue({
      collection: (name: string) => ({
        find: () => ({ toArray: async () => docs[name] ?? [] }),
        updateOne: async (filter: unknown, update: unknown) => {
          upserts.push({ filter, update });
          return { acknowledged: true };
        },
        deleteMany: async (filter: unknown) => {
          deletes.push(filter);
          return { deletedCount: 0 };
        },
      }),
    } as never);

    await refreshLearnedStacks();
    expect(upserts.some((u) => (u.filter as Record<string, unknown>).agent_name === "user_chat")).toBe(true);
    expect(upserts.some((u) => (u.filter as Record<string, unknown>).agent_name === "probe_agent")).toBe(false);
    expect(upserts.some((u) => (u.filter as Record<string, unknown>).agent_name === "contract_probe_agent")).toBe(false);
    expect(upserts.some((u) => (u.filter as Record<string, unknown>).agent_name === "boundary_probe_agent")).toBe(false);
    expect(deletes).toHaveLength(1);
    const snapshot = learnedStacksSnapshot();
    const chatEntry = snapshot.find((e) => e.agent_name === "user_chat");
    expect(chatEntry?.sequences[0]?.tools).toEqual(["get_market_data", "get_finnhub_news"]);
    expect(chatEntry?.sequences[0]?.avg_gap_ms).toBe(800);

    const hint = openingBundleHint("user_chat", ["get_market_data", "get_finnhub_news"]);
    expect(hint).toContain("get_market_data -> get_finnhub_news");
    expect(openingBundleHint("user_chat", ["get_market_data"])).toBe("");
  });
});
