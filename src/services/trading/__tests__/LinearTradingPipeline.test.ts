import http from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTradingDeskRouter } from "../../../routes/TradingDeskRoutes.ts";
import { ProfileRegistry } from "../../ProfileRegistry.ts";
import { errorHandler } from "../../../utils/errors.ts";
import { reconcileAaExtractions } from "../AaNoiseReconciler.ts";
import { verifyFactsAgainstLedger } from "../FactLedgerVerifier.ts";
import { runLinearDeskPipeline, type LinearDeskDeps } from "../LinearDeskPipeline.ts";
import type { ExtractedFact, LedgerEntry, LinearDeskRequest } from "../types.ts";

const LEDGER: Record<string, LedgerEntry> = {
  fct_price_nvda: {
    fact_id: "fct_price_nvda",
    tool_name: "get_market_data",
    ticker: "NVDA",
    as_of: "2026-11-21T16:00:00Z",
    summary: "NVDA last close 185.50, RSI 54.2, ATR 4.10, volume 42M.",
    raw: { close: 185.5, rsi_14: 54.2, atr_14: 4.1 },
  },
  fct_fund_nvda: {
    fact_id: "fct_fund_nvda",
    tool_name: "get_finviz_fundamentals",
    ticker: "NVDA",
    as_of: "2026-11-21T16:00:00Z",
    summary: "Forward P/E 28.4, YoY revenue growth 62%, gross margin 74.5%.",
    raw: { forward_pe: 28.4, rev_growth_pct: 62, gross_margin_pct: 74.5 },
  },
};

function makeFact(over: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    fact_id: "fct_price_nvda",
    category: "price",
    metric: "last_close",
    value: "$185.50",
    raw_number: 185.5,
    ticker: "NVDA",
    summary: "NVDA closed at $185.50",
    ...over,
  };
}

describe("FactLedgerVerifier (0-GPU control + mutation checks)", () => {
  it("passes grounded facts within rounding/percentage scale and flags wrong IDs, tickers, and numbers", () => {
    const good = makeFact();
    const goodPct = makeFact({
      fact_id: "fct_fund_nvda",
      category: "fundamental",
      metric: "gross_margin",
      value: "74.5%",
      raw_number: 0.745,
    });
    const wrongId = makeFact({ fact_id: "fct_invented_999" });
    const wrongTicker = makeFact({ ticker: "AAPL" });
    const wrongNumber = makeFact({ metric: "last_close", raw_number: 310.0, value: "$310.00" });

    const res = verifyFactsAgainstLedger([good, goodPct, wrongId, wrongTicker, wrongNumber], "NVDA", LEDGER);
    expect(res.verifiedFacts).toHaveLength(2);
    expect(res.hallucinationCount).toBe(3);
    expect(res.mismatches.map((m) => m.reason)).toEqual([
      "unknown_fact_id",
      "ticker_mismatch",
      "number_mismatch",
    ]);
  });
});

describe("AaNoiseReconciler (parallel gold-spark vs dell2 A/A noise tracking)", () => {
  it("computes fact_flip_share, citation_jaccard, numeric spread, and isolates single-seed facts", () => {
    const outA = {
      summary: "Seed A summary",
      facts: [
        makeFact({ raw_number: 185.5 }),
        makeFact({ fact_id: "fct_fund_nvda", category: "valuation", metric: "forward_pe", value: "28.4x", raw_number: 28.4 }),
      ],
      catalysts: ["Data center ramp"],
      risks: ["Valuation compression"],
      data_gaps: [],
    };
    const outB = {
      summary: "Seed B summary",
      facts: [
        makeFact({ raw_number: 185.52 }),
        makeFact({ fact_id: "fct_invented", metric: "fake_guidance", value: "$999", raw_number: 999 }),
      ],
      catalysts: ["data center ramp", "Networking demand"],
      risks: [],
      data_gaps: ["Reddit sentiment missing"],
    };

    const rec = reconcileAaExtractions({
      boxA: "gold-spark",
      boxB: "dell2",
      modelId: "dynamic-deepseek-v4",
      sameBoxFallback: false,
      outputA: outA,
      outputB: outB,
    });

    expect(rec.corroboratedFacts).toHaveLength(1);
    expect(rec.uncorroboratedFacts).toHaveLength(2);
    expect(rec.metrics.fact_flip_share).toBe(0.5);
    expect(rec.metrics.box_a).toBe("gold-spark");
    expect(rec.metrics.box_b).toBe("dell2");
    expect(rec.metrics.same_box_fallback).toBe(false);
    expect(rec.metrics.numeric_rel_spread_median).toBeGreaterThan(0);
    expect(rec.catalysts).toEqual(["Data center ramp", "Networking demand"]);
  });
});

describe("LinearDeskPipeline end-to-end & schema enforcement", () => {
  function makeDeps(opts: { unheldAction?: string; includeBadFact?: boolean } = {}): LinearDeskDeps {
    return {
      acquireTarget: async (preferredMember) => {
        const boxName = preferredMember || "gold-spark";
        return {
          boxName,
          modelId: "dynamic-model-from-v1-models",
          sameBoxFallback: false,
          release: () => {},
          model: (req) => ({
            async *[Symbol.asyncIterator]() {
              const sys = String(req.messages[0]?.content || "");
              if (sys.includes("Stage 1")) {
                const facts = [makeFact()];
                if (opts.includeBadFact && boxName === "dell2") {
                  facts.push(makeFact({ fact_id: "fct_fund_nvda", metric: "forward_pe", value: "99.9", raw_number: 99.9 }));
                }
                yield JSON.stringify({ summary: "NVDA strong close", facts, catalysts: ["AI cycle"], risks: [], data_gaps: [] });
              } else if (sys.includes("Stage 2")) {
                yield JSON.stringify({
                  summary: "Cleaned dossier",
                  facts: [makeFact()],
                  catalysts: ["AI cycle"],
                  risks: [],
                  data_gaps: [],
                  dropped_facts: [{ fact_id: "fct_fund_nvda", reason: "99.9 mismatch vs 28.4" }],
                  notes: ["Removed misquoted forward_pe"],
                });
              } else {
                yield JSON.stringify({
                  action: opts.unheldAction ?? "BUY",
                  entry_mode: "enter_now",
                  entry_condition: null,
                  position_size_pct: 12,
                  stop_loss: 175.0,
                  take_profit: 215.0,
                  cited_fact_ids: ["fct_price_nvda"],
                  decision_thesis: "20% YoY upside with 1.5x ATR risk stop at $175.00.",
                });
              }
            },
          }),
        };
      },
    };
  }

  const baseReq: LinearDeskRequest = {
    ticker: "NVDA",
    cycle_id: "cycle-v3-100",
    ledger_entries: LEDGER,
    portfolio_context: { held: false, shares_owned: 0, avg_cost: null, cash_usd: 50000, max_position_pct: 15 },
    macro_snapshot: { vix: 22.1, spy_20d_return: 0.03 },
  };

  it("drops single-seed misquoted numbers via Data Critic and allows digits in Trader thesis", async () => {
    const out = await runLinearDeskPipeline(baseReq, makeDeps({ includeBadFact: true }));
    expect(out.aa_noise_metrics.fact_flip_share).toBeGreaterThan(0);
    expect(out.critic_report.llm_repaired).toBe(true);
    expect(out.critic_report.dropped_facts).toEqual([
      { fact_id: "fct_fund_nvda", reason: "99.9 mismatch vs 28.4" },
    ]);
    expect(out.dossier.facts).toHaveLength(1);
    expect(out.decision.action).toBe("BUY");
    expect(out.decision.decision_thesis).toContain("20%");
  });

  it("refuses SELL when held=false even if the model attempts it once, and allows AVOID", async () => {
    await expect(
      runLinearDeskPipeline(baseReq, makeDeps({ unheldAction: "SELL" })),
    ).rejects.toThrow(/Stage 3 Final Trader failed schema validation/);

    const avoid = await runLinearDeskPipeline(baseReq, makeDeps({ unheldAction: "AVOID" }));
    expect(avoid.decision.action).toBe("AVOID");
  });

  it("loads trading-linear-v1 profile cleanly via ProfileRegistry", async () => {
    const loaded = await ProfileRegistry.loadProfilesFromDisk();
    expect(loaded).toBeGreaterThan(0);
    const prof = await ProfileRegistry.loadProfile("trading-linear-v1", "1.0.0");
    expect(prof?.profile_id).toBe("trading-linear-v1");
  });
});

describe("POST /v1/trading/linear-desk route + runtimeAuth", () => {
  const prevToken = process.env.RUNTIME_API_TOKEN;
  const TOKEN = "linear-desk-test-token";
  let server: http.Server | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    process.env.RUNTIME_API_TOKEN = TOKEN;
    const app = express();
    app.use(express.json());
    const deps: LinearDeskDeps = {
      acquireTarget: async () => ({
        boxName: "gold-spark",
        modelId: "dynamic-model",
        sameBoxFallback: false,
        release: () => {},
        model: (req) => ({
          async *[Symbol.asyncIterator]() {
            const sys = String(req.messages[0]?.content || "");
            if (sys.includes("Stage 1")) {
              yield JSON.stringify({ summary: "ok", facts: [makeFact()], catalysts: [], risks: [], data_gaps: [] });
            } else {
              yield JSON.stringify({
                action: "AVOID",
                entry_mode: "none",
                entry_condition: null,
                position_size_pct: 0,
                stop_loss: null,
                take_profit: null,
                cited_fact_ids: ["fct_price_nvda"],
                decision_thesis: "10% downside skew on flat volume.",
              });
            }
          },
        }),
      }),
    };
    app.use("/v1/trading", createTradingDeskRouter(deps));
    app.use(errorHandler);
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/trading`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (prevToken === undefined) delete process.env.RUNTIME_API_TOKEN;
    else process.env.RUNTIME_API_TOKEN = prevToken;
    vi.restoreAllMocks();
  });

  it("rejects unauthenticated requests with 401 and executes valid requests with 200", async () => {
    const payload = {
      ticker: "NVDA",
      cycle_id: "cycle-v3-200",
      ledger_entries: LEDGER,
      portfolio_context: { held: false, shares_owned: 0, avg_cost: null, cash_usd: 50000, max_position_pct: 15 },
    };
    const unauth = await fetch(`${baseUrl}/linear-desk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(unauth.status).toBe(401);

    const ok = await fetch(`${baseUrl}/linear-desk`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-runtime-token": TOKEN },
      body: JSON.stringify(payload),
    });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.decision.action).toBe("AVOID");
    expect(body.aa_noise_metrics.fact_flip_share).toBe(0);
  });
});
