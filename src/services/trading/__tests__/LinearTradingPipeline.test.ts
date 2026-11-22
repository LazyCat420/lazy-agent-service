import http from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTradingDeskRouter } from "../../../routes/TradingDeskRoutes.ts";
import { ProfileRegistry } from "../../ProfileRegistry.ts";
import { errorHandler } from "../../../utils/errors.ts";
import { reconcileAaExtractions } from "../AaNoiseReconciler.ts";
import { verifyFactsAgainstLedger } from "../FactLedgerVerifier.ts";
import { findMissingLedgerFollowupSlots, runLinearDeskPipeline, type LinearDeskDeps } from "../LinearDeskPipeline.ts";
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
    const missingTicker = makeFact({ ticker: "" });
    const wrongNumber = makeFact({ metric: "last_close", raw_number: 310.0, value: "$310.00" });
    const crossFieldNumber = makeFact({ fact_id: "fct_fund_nvda", metric: "forward_pe", value: "62x", raw_number: 62 });
    const dateNumber = makeFact({ metric: "year_check", value: "2026", raw_number: 2026 });
    const otherTickerLedger = {
      ...LEDGER,
      fct_aapl: { fact_id: "fct_aapl", tool_name: "get_market_data", ticker: "AAPL", summary: "AAPL 225.0", raw: { close: 225.0 } },
    };
    const crossTickerEntry = makeFact({ fact_id: "fct_aapl", metric: "close", value: "$225.00", raw_number: 225.0 });
    const nullRawValid = makeFact({ metric: "close", value: "$185.50", raw_number: null });
    const nullRawBad = makeFact({ metric: "close", value: "$999.00", raw_number: null });
    const unparseableNumeric = makeFact({ category: "valuation", metric: "pe_ratio", value: "high multiple", raw_number: null });
    const protoKey = makeFact({ fact_id: "constructor", category: "news", metric: "headline", value: "Proto check", raw_number: null });

    const res = verifyFactsAgainstLedger(
      [good, goodPct, nullRawValid, wrongId, protoKey, wrongTicker, missingTicker, wrongNumber, crossFieldNumber, dateNumber, crossTickerEntry, nullRawBad, unparseableNumeric],
      "NVDA",
      otherTickerLedger,
    );
    expect(res.verifiedFacts).toHaveLength(3);
    expect(res.hallucinationCount).toBe(10);
    expect(res.mismatches.map((m) => m.reason)).toEqual([
      "unknown_fact_id",
      "unknown_fact_id",
      "ticker_mismatch",
      "ticker_mismatch",
      "number_mismatch",
      "number_mismatch",
      "number_mismatch",
      "ticker_mismatch",
      "number_mismatch",
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
  it("deduplicates repeated facts within one seed and records model_mismatch", () => {
    const out = reconcileAaExtractions({
      boxA: "gold-spark",
      boxB: "dell2",
      modelId: "m-a",
      modelA: "m-a",
      modelB: "m-b",
      sameBoxFallback: false,
      outputA: { summary: "a", facts: [makeFact(), makeFact()], catalysts: [], risks: [], data_gaps: [] },
      outputB: { summary: "b", facts: [makeFact()], catalysts: [], risks: [], data_gaps: [] },
    });
    expect(out.metrics.count_a).toBe(1);
    expect(out.metrics.count_b).toBe(1);
    expect(out.metrics.fact_flip_share).toBe(0);
    expect(out.metrics.model_mismatch).toBe(true);
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

  it("refuses SELL when held=false and refuses AVOID when held=true", async () => {
    await expect(
      runLinearDeskPipeline(baseReq, makeDeps({ unheldAction: "SELL" })),
    ).rejects.toThrow(/Stage 3 Final Trader failed schema validation/);

    const avoid = await runLinearDeskPipeline(baseReq, makeDeps({ unheldAction: "AVOID" }));
    expect(avoid.decision.action).toBe("AVOID");

    const heldReq: LinearDeskRequest = {
      ...baseReq,
      portfolio_context: { held: true, shares_owned: 10, avg_cost: 150, cash_usd: 50000, max_position_pct: 15 },
    };
    const sellHeld = await runLinearDeskPipeline(heldReq, makeDeps({ unheldAction: "SELL" }));
    expect(sellHeld.decision.action).toBe("SELL");

    await expect(
      runLinearDeskPipeline(heldReq, makeDeps({ unheldAction: "AVOID" })),
    ).rejects.toThrow(/Stage 3 Final Trader failed schema validation/);
  });

  it("aborts sibling extractor seed when the other extractor fails", async () => {
    let siblingAborted = false;
    const deps: LinearDeskDeps = {
      acquireTarget: async (preferredMember) => ({
        boxName: preferredMember || "gold-spark",
        modelId: "dynamic-model",
        sameBoxFallback: false,
        release: () => {},
        model: (req) => ({
          async *[Symbol.asyncIterator]() {
            if (preferredMember === "gold-spark") {
              yield "not valid json";
              return;
            }
            req.signal?.addEventListener("abort", () => {
              siblingAborted = true;
            });
            await new Promise((r) => setTimeout(r, 40));
            yield JSON.stringify({ summary: "ok", facts: [makeFact()], catalysts: [], risks: [], data_gaps: [] });
          },
        }),
      }),
    };
    await expect(runLinearDeskPipeline(baseReq, deps)).rejects.toThrow(/invalid JSON/i);
    expect(siblingAborted).toBe(true);
  });

  it("drops critic-invented non-candidate facts and preserves uncorroborated provenance", async () => {
    const deps: LinearDeskDeps = {
      acquireTarget: async (preferredMember) => ({
        boxName: preferredMember || "gold-spark",
        modelId: "dynamic-model",
        sameBoxFallback: false,
        release: () => {},
        model: (req) => ({
          async *[Symbol.asyncIterator]() {
            const sys = String(req.messages[0]?.content || "");
            if (sys.includes("Stage 1")) {
              const facts = [makeFact()];
              if (preferredMember === "dell2") facts[0] = makeFact({ metric: "close", value: "$185.51", raw_number: 185.51 });
              if (preferredMember === "gold-spark") {
                facts.push(makeFact({ metric: "rsi_14", value: "99.0", raw_number: 99.0 })); // triggers Stage 2 critic via uncorroborated + mismatch
              }
              yield JSON.stringify({ summary: "s1", facts, catalysts: [], risks: [], data_gaps: [] });
            } else if (sys.includes("Stage 2")) {
              yield JSON.stringify({
                summary: "s2",
                facts: [
                  makeFact(),
                  makeFact({ fact_id: "fct_fund_nvda", category: "fundamental", metric: "forward_pe", value: "28.4x", raw_number: 28.4 }),
                ],
                catalysts: [],
                risks: [],
                data_gaps: [],
                dropped_facts: [],
                notes: [],
              });
            } else {
              yield JSON.stringify({
                action: "HOLD",
                entry_mode: "none",
                entry_condition: null,
                position_size_pct: 0,
                stop_loss: null,
                take_profit: null,
                cited_fact_ids: ["fct_price_nvda"],
                decision_thesis: "Holding on verified price $185.50.",
              });
            }
          },
        }),
      }),
    };
    const out = await runLinearDeskPipeline(baseReq, deps);
    expect(out.dossier.facts.map((f) => f.fact_id)).toEqual(["fct_price_nvda"]);
    expect(out.critic_report.dropped_facts).toContainEqual({
      fact_id: "fct_fund_nvda",
      reason: "not_in_stage1_candidates",
    });
  });

  it("loads trading-linear-v1 profile cleanly via ProfileRegistry", async () => {
    const loaded = await ProfileRegistry.loadProfilesFromDisk();
    expect(loaded).toBeGreaterThan(0);
    const prof = await ProfileRegistry.loadProfile("trading-linear-v1", "1.0.0");
    expect(prof?.profile_id).toBe("trading-linear-v1");
  });
});

import {
  clearPoolCaches,
  poolStats,
  resetPoolState,
} from "../../vllm/VllmPool.ts";
import {
  acquireLocalPoolTarget,
  createPoolCoreModel,
  PipelineTimeoutError,
  PoolUnavailableError,
  releasePoolTarget,
} from "../LocalPoolClient.ts";

describe("LocalPoolClient discovery-fallback in-flight accounting", () => {
  it("transfers in-flight slot to the surviving candidate when preferred discovery fails", async () => {
    resetPoolState();
    clearPoolCaches();
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/metrics")) {
        return new Response("vllm:num_requests_running 0\nvllm:num_requests_waiting 0\n", { status: 200 });
      }
      if (url.includes("10.0.0.141") && url.endsWith("/v1/models")) {
        // Strike 1 in selectPoolMember leaves gold-spark eligible with model=null, then discoverPoolModel fails -> dell2
        return new Response("err", { status: 502 });
      }
      return new Response(JSON.stringify({ data: [{ id: "dynamic-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const acquired = await acquireLocalPoolTarget("gold-spark");
      expect(acquired.member.name).toBe("dell2");
      expect(acquired.sameBoxFallback).toBe(true);
      const statsBeforeRelease = poolStats().members;
      expect(statsBeforeRelease.find((m) => m.name === "gold-spark")?.inFlight).toBe(0);
      expect(statsBeforeRelease.find((m) => m.name === "dell2")?.inFlight).toBe(1);
      releasePoolTarget(acquired.member.name);
      const statsAfterRelease = poolStats().members;
      expect(statsAfterRelease.find((m) => m.name === "dell2")?.inFlight).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
      resetPoolState();
    }
  });

  it("reuses cached /v1/models from VllmPool probe instead of issuing duplicate /v1/models requests", async () => {
    resetPoolState();
    clearPoolCaches();
    let goldModelsCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/metrics")) {
        return new Response("vllm:num_requests_running 0\nvllm:num_requests_waiting 0\n", { status: 200 });
      }
      if (url.includes("10.0.0.141") && url.endsWith("/v1/models")) {
        goldModelsCalls += 1;
      }
      return new Response(JSON.stringify({ data: [{ id: "dynamic-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const acquired = await acquireLocalPoolTarget("gold-spark");
      expect(acquired.member.name).toBe("gold-spark");
      expect(acquired.modelId).toBe("dynamic-model");
      expect(goldModelsCalls).toBe(1);
      releasePoolTarget(acquired.member.name);
    } finally {
      globalThis.fetch = origFetch;
      resetPoolState();
    }
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

  it("rejects mismatched ledger_entries record key vs entry.fact_id with 400 (claude:R3-F5)", async () => {
    const badRes = await fetch(`${baseUrl}/linear-desk`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-runtime-token": TOKEN },
      body: JSON.stringify({
        ticker: "NVDA",
        cycle_id: "cycle-v3-201",
        ledger_entries: {
          wrong_key: LEDGER.fct_price_nvda,
        },
        portfolio_context: { held: false, shares_owned: 0, avg_cost: null, cash_usd: 50000, max_position_pct: 15 },
      }),
    });
    expect(badRes.status).toBe(400);
  });
});

describe("Round 3 hardening invariants (numeric consistency, critic scoping, Stage 1 repair)", () => {
  it("rejects contradictory value vs raw_number (codex:R3-F1) and tight small-value/unmatched-metric checks (claude:R3-F3)", () => {
    const contradictory = makeFact({ value: "$999", raw_number: 185.5 });
    const smallEpsLedger: Record<string, LedgerEntry> = {
      fct_eps: {
        fact_id: "fct_eps",
        tool_name: "get_earnings_data",
        ticker: "NVDA",
        summary: "EPS was 0.05",
        raw: { eps: 0.05 },
      },
      fct_fund: LEDGER.fct_fund_nvda,
    };
    const smallBad = makeFact({ fact_id: "fct_eps", metric: "eps", value: "0.07", raw_number: 0.07 });
    const unmatchedMetric = makeFact({
      fact_id: "fct_fund",
      metric: "unseen_fabricated_ratio",
      value: "28.4x",
      raw_number: 28.4,
    });
    const smallGood = makeFact({ fact_id: "fct_eps", metric: "eps", value: "0.05", raw_number: 0.05 });

    const out = verifyFactsAgainstLedger([contradictory, smallBad, unmatchedMetric, smallGood], "NVDA", {
      ...LEDGER,
      ...smallEpsLedger,
    });
    expect(out.verifiedFacts.map((f) => f.fact_id)).toEqual(["fct_eps"]);
    expect(out.hallucinationCount).toBe(3);
  });

  it("prevents Stage 2 Critic from injecting ungrounded summary/catalysts or silently dropping verified facts (codex:R3-F2, claude:R3-F1)", async () => {
    const req: LinearDeskRequest = {
      ticker: "NVDA",
      cycle_id: "cycle-r3-critic",
      ledger_entries: LEDGER,
      portfolio_context: { held: false, shares_owned: 0, avg_cost: null, cash_usd: 50000, max_position_pct: 15 },
    };
    const deps: LinearDeskDeps = {
      acquireTarget: async (preferredMember) => ({
        boxName: preferredMember || "gold-spark",
        modelId: "dyn",
        sameBoxFallback: false,
        release: () => {},
        model: (mReq) => ({
          async *[Symbol.asyncIterator]() {
            const sys = String(mReq.messages[0]?.content || "");
            if (sys.includes("Stage 1")) {
              const facts = [makeFact()];
              if (preferredMember === "dell2") {
                // Triggers Stage 2 Critic via uncorroborated second fact
                facts.push(makeFact({ fact_id: "fct_fund_nvda", metric: "forward_pe", value: "28.4", raw_number: 28.4 }));
              }
              yield JSON.stringify({
                summary: "Stage 1 verified summary",
                facts,
                catalysts: ["Blackwell ramp"],
                risks: ["Export caps"],
                data_gaps: ["No Q4 guidance"],
              });
            } else if (sys.includes("Stage 2")) {
              // Critic tries to overwrite summary, inject fake catalyst/risk, and silently omit fct_fund_nvda
              yield JSON.stringify({
                summary: "CRITIC HALLUCINATED BUYOUT RUMOR",
                facts: [makeFact()],
                catalysts: ["Blackwell ramp", "INVENTED ACQUISITION"],
                risks: ["INVENTED BANKRUPTCY"],
                data_gaps: ["Invented gap"],
                dropped_facts: [],
                notes: [],
              });
            } else {
              yield JSON.stringify({
                action: "BUY",
                entry_mode: "enter_now",
                entry_condition: null,
                position_size_pct: 10,
                stop_loss: 170,
                take_profit: 210,
                cited_fact_ids: ["fct_price_nvda"],
                decision_thesis: "Buying at 185.50.",
              });
            }
          },
        }),
      }),
    };
    const res = await runLinearDeskPipeline(req, deps);
    expect(res.dossier.summary).toBe("Stage 1 verified summary");
    expect(res.dossier.catalysts).toEqual(["Blackwell ramp"]);
    expect(res.dossier.risks).toEqual([]);
    expect(res.dossier.data_gaps).toEqual([]);
    // Both pre-verified facts remain because fct_fund_nvda was not in dropped_facts
    expect(res.dossier.facts.map((f) => f.fact_id).sort()).toEqual(["fct_fund_nvda", "fct_price_nvda"]);
  });

  it("coerces numeric value / string raw_number and repairs Stage 1 schema slip in 1 retry (claude:R3-F2)", async () => {
    const req: LinearDeskRequest = {
      ticker: "NVDA",
      cycle_id: "cycle-r3-repair",
      ledger_entries: { fct_price_nvda: LEDGER.fct_price_nvda },
      portfolio_context: { held: false, shares_owned: 0, avg_cost: null, cash_usd: 50000, max_position_pct: 15 },
    };
    const deps: LinearDeskDeps = {
      acquireTarget: async (preferredMember) => {
        let stage1Calls = 0;
        return {
          boxName: preferredMember || "gold-spark",
          modelId: "dyn",
          sameBoxFallback: false,
          release: () => {},
          model: (mReq) => ({
            async *[Symbol.asyncIterator]() {
              const sys = String(mReq.messages[0]?.content || "");
              if (sys.includes("Stage 1")) {
                stage1Calls += 1;
                if (preferredMember === "gold-spark" && stage1Calls === 1) {
                  yield "not valid json";
                  return;
                }
                yield JSON.stringify({
                  summary: "Repaired Stage 1",
                  facts: [
                    {
                      fact_id: "fct_price_nvda",
                      category: "unknown_bucket",
                      metric: "close",
                      value: 185.5,
                      raw_number: "185.5",
                      ticker: "NVDA",
                    },
                  ],
                  catalysts: [],
                  risks: [],
                  data_gaps: [],
                });
              } else {
                yield JSON.stringify({
                  action: "HOLD",
                  entry_mode: "none",
                  entry_condition: null,
                  position_size_pct: 0,
                  stop_loss: null,
                  take_profit: null,
                  cited_fact_ids: ["fct_price_nvda"],
                  decision_thesis: "Hold at 185.50.",
                });
              }
            },
          }),
        };
      },
    };
    const res = await runLinearDeskPipeline(req, deps);
    expect(res.dossier.facts[0]?.category).toBe("fundamental");
    expect(res.dossier.facts[0]?.value).toBe("185.5");
    expect(res.dossier.facts[0]?.raw_number).toBe(185.5);
  });

  it("compacts bulky raw payloads in prompts while verifying full raw ledger and scoping critic entries", async () => {
    const bulkyPayload = "A".repeat(750);
    const largeLedger: Record<string, LedgerEntry> = {
      fct_price_nvda: LEDGER.fct_price_nvda,
      fct_news_bulk: {
        fact_id: "fct_news_bulk",
        tool_name: "get_finnhub_news",
        ticker: "NVDA",
        summary: "NVDA sentiment positive at 185.50.",
        raw: { article_blob: bulkyPayload, close: 185.5 },
      },
      fct_fund_nvda: LEDGER.fct_fund_nvda,
      fct_earn_nvda: { fact_id: "fct_earn_nvda", tool_name: "get_earnings_data", ticker: "NVDA", summary: "EPS beat 0.89", raw: { eps: 0.89 } },
      fct_events_nvda: { fact_id: "fct_events_nvda", tool_name: "get_upcoming_events", ticker: "NVDA", summary: "No imminent binary events", raw: { events: [] } },
      fct_tech_nvda: { fact_id: "fct_tech_nvda", tool_name: "get_technical_indicators", ticker: "NVDA", summary: "RSI 54.2", raw: { rsi_14: 54.2 } },
      fct_unused_extra: { fact_id: "fct_unused_extra", tool_name: "get_institutional_holdings", ticker: "NVDA", summary: "Institutional ownership 65%", raw: { inst_pct: 65 } },
    };

    const recordedPrompts: Array<{ sys: string; user: string; toolCount: number; maxTokens?: number }> = [];
    const req: LinearDeskRequest = {
      ticker: "NVDA",
      cycle_id: "cycle-compact-1",
      ledger_entries: largeLedger,
      portfolio_context: { held: false, shares_owned: 0, avg_cost: null, cash_usd: 50000, max_position_pct: 15 },
    };
    const deps: LinearDeskDeps = {
      acquireTarget: async (preferredMember, _seed, _temp, maxTokens) => ({
        boxName: preferredMember || "gold-spark",
        modelId: "dyn",
        sameBoxFallback: false,
        release: () => {},
        model: (mReq) => ({
          async *[Symbol.asyncIterator]() {
            const sys = String(mReq.messages[0]?.content || "");
            const user = String(mReq.messages[1]?.content || "");
            recordedPrompts.push({ sys, user, toolCount: mReq.tools.length, maxTokens });
            if (sys.includes("Stage 1")) {
              const facts = [makeFact()];
              if (preferredMember === "dell2") {
                facts.push(makeFact({ fact_id: "fct_news_bulk", category: "news", metric: "close", value: "$185.50", raw_number: 185.5 }));
              }
              yield JSON.stringify({ summary: "Compact", facts, catalysts: [], risks: [], data_gaps: [] });
            } else if (sys.includes("Stage 2")) {
              yield JSON.stringify({
                summary: "Compact cleaned",
                facts: [makeFact(), makeFact({ fact_id: "fct_news_bulk", category: "news", metric: "close", value: "$185.50", raw_number: 185.5 })],
                catalysts: [],
                risks: [],
                data_gaps: [],
                dropped_facts: [],
                notes: [],
              });
            } else {
              yield JSON.stringify({
                action: "HOLD",
                entry_mode: "none",
                entry_condition: null,
                position_size_pct: 0,
                stop_loss: null,
                take_profit: null,
                cited_fact_ids: ["fct_price_nvda"],
                decision_thesis: "Holding on verified close 185.50.",
              });
            }
          },
        }),
      }),
    };

    const res = await runLinearDeskPipeline(req, deps);
    expect(res.dossier.facts.map((f) => f.fact_id).sort()).toEqual(["fct_news_bulk", "fct_price_nvda"]);

    const stage1Calls = recordedPrompts.filter((p) => p.sys.includes("Stage 1"));
    const stage2Call = recordedPrompts.find((p) => p.sys.includes("Stage 2"));
    const stage3Call = recordedPrompts.find((p) => p.sys.includes("Stage 3"));
    expect(stage1Calls).toHaveLength(2);
    for (const s1 of stage1Calls) {
      expect(s1.toolCount).toBe(0);
      expect(s1.maxTokens).toBe(2560);
      expect(s1.user).not.toContain(bulkyPayload);
      expect(s1.user).toContain("NVDA sentiment positive at 185.50.");
    }
    expect(stage2Call).toBeDefined();
    expect(stage2Call!.maxTokens).toBe(3584);
    expect(stage2Call!.user).not.toContain(bulkyPayload);
    expect(stage2Call!.user).not.toContain("fct_unused_extra");
    expect(stage3Call?.maxTokens).toBe(1536);

    // Entry omitting fact_id falls back to its record key in Stage 1/2 prompts & scoping (codex:R1-F1)
    recordedPrompts.length = 0;
    const keyedLedger = {
      ...largeLedger,
      fct_keyed_only: {
        fact_id: "",
        tool_name: "get_earnings_data",
        ticker: "NVDA",
        summary: "Revenue $35.1B",
        raw: { revenue_b: 35.1 },
      } as LedgerEntry,
    };
    const keyedDeps: LinearDeskDeps = {
      acquireTarget: async (preferredMember, _seed, _temp, maxTokens) => ({
        boxName: preferredMember || "gold-spark",
        modelId: "dyn",
        sameBoxFallback: false,
        release: () => {},
        model: (mReq) => ({
          async *[Symbol.asyncIterator]() {
            const sys = String(mReq.messages[0]?.content || "");
            const user = String(mReq.messages[1]?.content || "");
            recordedPrompts.push({ sys, user, toolCount: mReq.tools.length, maxTokens });
            if (sys.includes("Stage 1")) {
              const facts = [makeFact()];
              if (preferredMember === "dell2") {
                facts.push(makeFact({ fact_id: "fct_keyed_only", category: "earnings", metric: "revenue_b", value: "35.1", raw_number: 35.1 }));
              }
              yield JSON.stringify({ summary: "Keyed", facts, catalysts: [], risks: [], data_gaps: [] });
            } else if (sys.includes("Stage 2")) {
              yield JSON.stringify({
                summary: "Keyed cleaned",
                facts: [makeFact(), makeFact({ fact_id: "fct_keyed_only", category: "earnings", metric: "revenue_b", value: "35.1", raw_number: 35.1 })],
                catalysts: [],
                risks: [],
                data_gaps: [],
                dropped_facts: [],
                notes: [],
              });
            } else {
              yield JSON.stringify({
                action: "HOLD",
                entry_mode: "none",
                entry_condition: null,
                position_size_pct: 0,
                stop_loss: null,
                take_profit: null,
                cited_fact_ids: ["fct_keyed_only"],
                decision_thesis: "Hold with $35.1B revenue.",
              });
            }
          },
        }),
      }),
    };
    const keyedRes = await runLinearDeskPipeline({ ...req, ledger_entries: keyedLedger }, keyedDeps);
    expect(keyedRes.dossier.facts.map((f) => f.fact_id)).toContain("fct_keyed_only");
    const keyedStage2 = recordedPrompts.find((p) => p.sys.includes("Stage 2"));
    expect(keyedStage2?.user).toContain("fct_keyed_only");

    // Oversized raw payload without summary is also capped at 600 chars (codex:R2-F1)
    recordedPrompts.length = 0;
    const summarylessBulk = "B".repeat(750);
    await runLinearDeskPipeline(
      {
        ...req,
        ledger_entries: {
          ...largeLedger,
          fct_no_summary: {
            fact_id: "fct_no_summary",
            tool_name: "get_earnings_data",
            ticker: "NVDA",
            summary: "",
            raw: { blob: summarylessBulk },
          },
        },
      },
      deps,
    );
    const noSummaryStage1 = recordedPrompts.filter((p) => p.sys.includes("Stage 1"));
    expect(noSummaryStage1).toHaveLength(2);
    for (const s1 of noSummaryStage1) {
      expect(s1.user).not.toContain("B".repeat(610));
      expect(s1.user).toContain("B".repeat(200));
    }
  });

  it("repairs Stage 2 critic JSON via parseStageWithRepair and falls back to FactLedgerVerifier when retries exhaust", async () => {
    const req: LinearDeskRequest = {
      ticker: "NVDA",
      cycle_id: "cycle-critic-repair-fallback",
      ledger_entries: LEDGER,
      portfolio_context: { held: false, shares_owned: 0, avg_cost: null, cash_usd: 50000, max_position_pct: 15 },
    };

    const runScenario = async (mode: "repair" | "fallback" | "transport") => {
      let criticAttempts = 0;
      let traderSawPrompt = "";
      const deps: LinearDeskDeps = {
        acquireTarget: async (preferredMember) => ({
          boxName: preferredMember || "gold-spark",
          modelId: "dyn",
          sameBoxFallback: false,
          release: () => {},
          model: (mReq) => ({
            async *[Symbol.asyncIterator]() {
              const sys = String(mReq.messages[0]?.content || "");
              if (sys.includes("Stage 1")) {
                const facts = [makeFact()];
                if (preferredMember === "dell2") {
                  // Uncorroborated bad numeric fact triggers Stage 2 Critic + deterministic verifier drop
                  facts.push(makeFact({ fact_id: "fct_fund_nvda", metric: "forward_pe", value: "999.0", raw_number: 999.0 }));
                }
                yield JSON.stringify({
                  summary: "Stage 1 verified summary",
                  facts,
                  catalysts: ["Blackwell ramp"],
                  risks: [],
                  data_gaps: [],
                });
              } else if (sys.includes("Stage 2")) {
                criticAttempts += 1;
                if (mode === "transport") {
                  throw new Error("vLLM dell2 HTTP 503");
                }
                if (mode === "repair" && criticAttempts === 2) {
                  yield JSON.stringify({
                    summary: "Stage 1 verified summary",
                    facts: [makeFact()],
                    catalysts: ["Blackwell ramp"],
                    risks: [],
                    data_gaps: [],
                    dropped_facts: [{ fact_id: "fct_fund_nvda", reason: "mismatch_repaired" }],
                    notes: ["repaired on attempt 2"],
                  });
                } else {
                  // Truncated / malformed JSON simulating array syntax failure
                  yield '{"summary":"NVDA","facts":[{"fact_id":"fct_price_nvda","metric":"close","value":"185.50" "broken"';
                }
              } else {
                traderSawPrompt = String(mReq.messages[1]?.content || "");
                yield JSON.stringify({
                  action: "HOLD",
                  entry_mode: "none",
                  entry_condition: null,
                  position_size_pct: 0,
                  stop_loss: null,
                  take_profit: null,
                  cited_fact_ids: ["fct_price_nvda"],
                  decision_thesis: "Hold on verified close 185.50.",
                });
              }
            },
          }),
        }),
      };
      const res = await runLinearDeskPipeline(req, deps);
      return { res, criticAttempts, traderSawPrompt };
    };

    // (a) Attempt 1 malformed JSON repaired on attempt 2 via parseStageWithRepair
    const repaired = await runScenario("repair");
    expect(repaired.criticAttempts).toBe(2);
    expect(repaired.res.critic_report.llm_repaired).toBe(true);
    expect(repaired.res.dossier.facts.map((f) => f.fact_id)).toEqual(["fct_price_nvda"]);

    // (b) Both critic attempts malformed -> deterministic FactLedgerVerifier fallback feeds Stage 3
    const fallback = await runScenario("fallback");
    expect(fallback.criticAttempts).toBe(2);
    expect(fallback.res.critic_report.llm_repaired).toBe(false);
    expect(fallback.res.critic_report.dropped_facts.some((d) => d.fact_id === "fct_fund_nvda")).toBe(true);
    expect(fallback.res.critic_report.notes.some((n) => n.startsWith("critic_llm_fallback:"))).toBe(true);
    expect(fallback.res.dossier.facts.map((f) => f.fact_id)).toEqual(["fct_price_nvda"]);
    expect(fallback.traderSawPrompt).toContain("fct_price_nvda");
    expect(fallback.res.decision.action).toBe("HOLD");

    // (c) Non-parse provider/transport errors must propagate instead of falling back (codex:R1-F1)
    await expect(runScenario("transport")).rejects.toThrow(/HTTP 503/);

    // (d) Abort/deadline during Stage 2 malformed output must propagate instead of entering fallback (codex:R2-F1)
    const abortCtl = new AbortController();
    const abortDeps: LinearDeskDeps = {
      acquireTarget: async (preferredMember) => ({
        boxName: preferredMember || "gold-spark",
        modelId: "dyn",
        sameBoxFallback: false,
        release: () => {},
        model: (mReq) => ({
          async *[Symbol.asyncIterator]() {
            const sys = String(mReq.messages[0]?.content || "");
            if (sys.includes("Stage 1")) {
              const facts = [makeFact()];
              if (preferredMember === "dell2") {
                facts.push(makeFact({ fact_id: "fct_fund_nvda", metric: "forward_pe", value: "999.0", raw_number: 999.0 }));
              }
              yield JSON.stringify({ summary: "s1", facts, catalysts: [], risks: [], data_gaps: [] });
            } else if (sys.includes("Stage 2")) {
              abortCtl.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
              yield '{"summary":"NVDA","facts":[{"broken"';
            } else {
              throw new Error("Stage 3 must not run after Stage 2 abort");
            }
          },
        }),
      }),
    };
    await expect(runLinearDeskPipeline({ ...req, signal: abortCtl.signal }, abortDeps)).rejects.toThrow(/abort|timeout/i);
  });

  it("uses gap-aware Stage 1 follow-up gating rather than a blunt 5-tool cutoff", async () => {
    const fiveToolsMissingEvents: Record<string, LedgerEntry> = {
      f1: { fact_id: "f1", tool_name: "get_market_data", ticker: "NVDA", summary: "price" },
      f2: { fact_id: "f2", tool_name: "get_technical_indicators", ticker: "NVDA", summary: "rsi" },
      f3: { fact_id: "f3", tool_name: "get_finviz_fundamentals", ticker: "NVDA", summary: "pe" },
      f4: { fact_id: "f4", tool_name: "get_finnhub_news", ticker: "NVDA", summary: "news" },
      f5: { fact_id: "f5", tool_name: "get_earnings_data", ticker: "NVDA", summary: "eps" },
    };
    expect(findMissingLedgerFollowupSlots(fiveToolsMissingEvents)).toEqual(["events"]);

    const completeSlots: Record<string, LedgerEntry> = {
      ...fiveToolsMissingEvents,
      f6: { fact_id: "f6", tool_name: "get_upcoming_events", ticker: "NVDA", summary: "earnings next week" },
    };
    expect(findMissingLedgerFollowupSlots(completeSlots)).toEqual([]);

    const runWithLedger = async (ledger_entries: Record<string, LedgerEntry>) => {
      const stage1ToolsSeen: string[][] = [];
      const req: LinearDeskRequest = {
        ticker: "NVDA",
        cycle_id: "cycle-gap-gate",
        ledger_entries,
        portfolio_context: { held: false, shares_owned: 0, cash_usd: 10000, max_position_pct: 15, equity_usd: 10000, quote_price: 185.5, quote_age_seconds: 10 },
        macro_snapshot: { vix: 18 },
        followup_tools: ["read_ledger_entry", "get_upcoming_events"],
      };
      const deps: LinearDeskDeps = {
        acquireTarget: async (preferredMember) => ({
          boxName: preferredMember || "gold-spark",
          modelId: "dyn",
          sameBoxFallback: false,
          release: () => {},
          model: (mReq) => ({
            async *[Symbol.asyncIterator]() {
              const sys = String(mReq.messages[0]?.content || "");
              if (sys.includes("Stage 1")) {
                stage1ToolsSeen.push((mReq.tools || []).map((t) => t.name));
                yield JSON.stringify({
                  summary: "s1",
                  facts: [{ fact_id: "f1", metric: "close", value: "185.5", raw_number: 185.5, source_tool: "get_market_data", ticker: "NVDA", verbatim_quote: "price" }],
                  catalysts: [],
                  risks: [],
                  data_gaps: [],
                });
              } else {
                yield JSON.stringify({
                  action: "HOLD", entry_mode: "none", entry_condition: null, position_size_pct: 0,
                  stop_loss: null, take_profit: null, cited_fact_ids: ["f1"], decision_thesis: "Hold.",
                });
              }
            },
          }),
        }),
      };
      await runLinearDeskPipeline(req, deps);
      return stage1ToolsSeen;
    };

    const withGap = await runWithLedger(fiveToolsMissingEvents);
    expect(withGap[0]).toContain("get_upcoming_events");

    const withoutGap = await runWithLedger(completeSlots);
    expect(withoutGap[0]).toEqual([]);
  });

  it("normalizes entry_mode + dynamic_trigger and populates stage_timings_ms + usage", async () => {
    const req: LinearDeskRequest = {
      ticker: "NVDA",
      cycle_id: "cycle-v3-trigger-norm",
      ledger_entries: LEDGER,
      portfolio_context: { held: false, shares_owned: 0, avg_cost: null, cash_usd: 50000, max_position_pct: 15 },
    };

    const runWithDecision = async (decisionPayload: Record<string, unknown>) => {
      const deps: LinearDeskDeps = {
        acquireTarget: async (preferredMember) => ({
          boxName: preferredMember || "gold-spark",
          modelId: "dyn-model",
          sameBoxFallback: false,
          release: () => {},
          model: (mReq) => ({
            async *[Symbol.asyncIterator]() {
              const sys = String(mReq.messages[0]?.content || "");
              if (sys.includes("Stage 1")) {
                yield JSON.stringify({ summary: "s1", facts: [makeFact()], catalysts: [], risks: [], data_gaps: [] });
              } else {
                yield JSON.stringify(decisionPayload);
              }
              yield { type: "usage", usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 } };
            },
          }),
        }),
      };
      return runLinearDeskPipeline(req, deps);
    };

    const conditionalBuy = await runWithDecision({
      action: "BUY",
      entry_mode: "enter_on_condition",
      entry_condition: "Wait for dip below 180",
      dynamic_trigger: { type: "price_below", value: 180 },
      position_size_pct: 10,
      stop_loss: 170,
      take_profit: 210,
      cited_fact_ids: ["fct_price_nvda"],
      decision_thesis: "Buy pullback to $180 from $185.50.",
    });
    expect(conditionalBuy.decision.entry_mode).toBe("enter_on_condition");
    expect(conditionalBuy.decision.dynamic_trigger).toEqual({ type: "price_below", value: 180 });
    expect(conditionalBuy.stage_timings_ms).toBeDefined();
    expect(conditionalBuy.stage_timings_ms!.stage2_ms).toBe(0);
    expect(conditionalBuy.usage).toEqual({ prompt_tokens: 300, completion_tokens: 75, total_tokens: 375 });

    const missingTriggerBuy = await runWithDecision({
      action: "BUY",
      entry_mode: "enter_on_condition",
      entry_condition: "Wait for pullback",
      dynamic_trigger: null,
      position_size_pct: 10,
      stop_loss: 170,
      take_profit: 210,
      cited_fact_ids: ["fct_price_nvda"],
      decision_thesis: "Buy pullback without structured trigger.",
    });
    expect(missingTriggerBuy.decision.entry_mode).toBe("watch_only");
    expect(missingTriggerBuy.decision.dynamic_trigger).toBeNull();
  });

  it("performs 1-shot cross-box failover in createPoolCoreModel without CoreLoop 5x retry storm", async () => {
    resetPoolState();
    clearPoolCaches();
    let vllmCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/metrics")) {
        return new Response("vllm:num_requests_running 0\nvllm:num_requests_waiting 0\n", { status: 200 });
      }
      if (url.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "dyn-model" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      vllmCalls += 1;
      if (url.includes("10.0.0.141")) {
        return new Response("overload", { status: 503 });
      }
      const payload = {
        choices: [
          {
            message: {
              content: JSON.stringify({ summary: "s1", facts: [makeFact()], catalysts: [], risks: [], data_gaps: [] }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      const acquired = await acquireLocalPoolTarget("gold-spark");
      let currentBox = acquired.member.name;
      let fellBack = false;
      const model = createPoolCoreModel(acquired, {
        preferredMember: "gold-spark",
        seed: 101,
        temperature: 0.2,
        onFailover: (nextMember) => {
          currentBox = nextMember.name;
          fellBack = true;
        },
      });
      const chunks: string[] = [];
      for await (const ch of model({ messages: [{ role: "user", content: "hi" }], tools: [], toolChoice: "auto", signal: new AbortController().signal, finalPass: false })) {
        if (typeof ch === "string") {
          chunks.push(ch);
        }
      }
      acquired.release();
      acquired.release(); // idempotent second call must not underflow/leak
      expect(vllmCalls).toBe(2);
      expect(fellBack).toBe(true);
      expect(currentBox).toBe("dell2");
      expect(acquired.member.name).toBe("dell2");
      expect(poolStats().members.every((m) => m.inFlight === 0)).toBe(true);
      expect(chunks.join("")).toContain("fct_price_nvda");
    } finally {
      globalThis.fetch = origFetch;
      resetPoolState();
    }
  });
});

describe("TradingDeskRoutes typed HTTP error mapping & ledger cap", () => {
  it("maps >128 ledger_entries -> 400, StageParseError -> 422, PoolUnavailableError -> 503, PipelineTimeoutError -> 504", async () => {
    const prevToken = process.env.RUNTIME_API_TOKEN;
    const TOKEN = "linear-error-map-token";
    process.env.RUNTIME_API_TOKEN = TOKEN;

    let mode: "parse" | "pool" | "timeout" = "parse";
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use(
      "/v1/trading",
      createTradingDeskRouter({
        acquireTarget: async () => {
          if (mode === "pool") throw new PoolUnavailableError("All local vLLM boxes down");
          if (mode === "timeout") throw new PipelineTimeoutError("Pipeline budget exceeded");
          return {
            boxName: "gold-spark",
            modelId: "dyn",
            sameBoxFallback: false,
            release: () => {},
            model: () => ({
              async *[Symbol.asyncIterator]() {
                if (mode === "parse") {
                  yield "not-json";
                }
              },
            }),
          };
        },
      }),
    );

    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/trading`;

    try {
      const tooMany: Record<string, LedgerEntry> = {};
      for (let i = 0; i < 129; i += 1) {
        const fid = `fct_n_${i}`;
        tooMany[fid] = { fact_id: fid, tool_name: "get_market_data", ticker: "NVDA", summary: "ok" };
      }
      const res400 = await fetch(`${baseUrl}/linear-desk`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-runtime-token": TOKEN },
        body: JSON.stringify({
          ticker: "NVDA",
          cycle_id: "cycle-v3-400",
          ledger_entries: tooMany,
          portfolio_context: { held: false, shares_owned: 0, avg_cost: null, cash_usd: 50000, max_position_pct: 15 },
        }),
      });
      expect(res400.status).toBe(400);

      const basePayload = {
        ticker: "NVDA",
        cycle_id: "cycle-v3-err",
        ledger_entries: LEDGER,
        portfolio_context: { held: false, shares_owned: 0, avg_cost: null, cash_usd: 50000, max_position_pct: 15 },
      };

      mode = "parse";
      const res422 = await fetch(`${baseUrl}/linear-desk`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-runtime-token": TOKEN },
        body: JSON.stringify(basePayload),
      });
      expect(res422.status).toBe(422);

      mode = "pool";
      const res503 = await fetch(`${baseUrl}/linear-desk`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-runtime-token": TOKEN },
        body: JSON.stringify(basePayload),
      });
      expect(res503.status).toBe(503);

      mode = "timeout";
      const res504 = await fetch(`${baseUrl}/linear-desk`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-runtime-token": TOKEN },
        body: JSON.stringify(basePayload),
      });
      expect(res504.status).toBe(504);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (prevToken === undefined) delete process.env.RUNTIME_API_TOKEN;
      else process.env.RUNTIME_API_TOKEN = prevToken;
    }
  });

  it("rolls back fallback inFlight slot on failed failover and aborts active requests at deadlineAtMs", async () => {
    const {
      acquireLocalPoolTarget,
      createPoolCoreModel,
      PipelineTimeoutError: PoolDeadlineErr,
    } = await import("../LocalPoolClient.js");
    const { poolStats } = await import("../../vllm/VllmPool.js");
    const origFetch = globalThis.fetch;

    let stage = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "Qwen3.8-Linear-Test" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/api/status")) {
        return new Response(
          JSON.stringify({ engine: { running: 0, waiting: 0 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/v1/chat/completions")) {
        stage += 1;
        if (stage <= 2) {
          return new Response("upstream failure", { status: 503 });
        }
        return await new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new DOMException("Timed out", "TimeoutError")),
            { once: true },
          );
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    try {
      // Case 1 (R1-F1): primary fails (503) and fallback also fails (503) — both inFlight counts return to 0.
      const target1 = await acquireLocalPoolTarget("gold-spark");
      const origBox = target1.member.name;
      const model1 = createPoolCoreModel(target1, {
        temperature: 0.1,
        deadlineAtMs: Date.now() + 180_000,
      });
      let failedBoth = false;
      try {
        for await (const _chunk of model1({
          messages: [{ role: "user", content: "hi" }],
          tools: [],
          toolChoice: "none",
        })) {
          // unreachable
        }
      } catch {
        failedBoth = true;
      } finally {
        target1.release();
      }
      expect(failedBoth).toBe(true);
      expect(target1.member.name).toBe(origBox);
      expect(poolStats().members.every((m) => m.inFlight === 0)).toBe(true);

      // Case 2 (R1-F2): hung completion is bounded by remaining deadlineAtMs (< 300s) and throws PipelineTimeoutError.
      const target2 = await acquireLocalPoolTarget("gold-spark");
      const model2 = createPoolCoreModel(target2, {
        temperature: 0.1,
        deadlineAtMs: Date.now() + 60,
      });
      const startedAt = Date.now();
      let caught: unknown;
      try {
        for await (const _chunk of model2({
          messages: [{ role: "user", content: "hi" }],
          tools: [],
          toolChoice: "none",
        })) {
          // unreachable
        }
      } catch (err) {
        caught = err;
      } finally {
        target2.release();
      }
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(caught).toBeInstanceOf(PoolDeadlineErr);
      expect(poolStats().members.every((m) => m.inFlight === 0)).toBe(true);

      // Case 3 (R2-F1): pool selection aborts promptly within deadlineAtMs when /v1/models or /metrics hangs
      const { resetPoolState } = await import("../../vllm/VllmPool.js");
      resetPoolState();
      globalThis.fetch = (async (_input: string | URL | Request) => {
        return await new Promise<Response>(() => {});
      }) as typeof fetch;
      const selStart = Date.now();
      let selErr: unknown;
      try {
        await acquireLocalPoolTarget("gold-spark", undefined, Date.now() + 60);
      } catch (err) {
        selErr = err;
      }
      expect(Date.now() - selStart).toBeLessThan(1500);
      expect(selErr).toBeInstanceOf(PoolDeadlineErr);
      expect(poolStats().members.every((m) => m.inFlight === 0)).toBe(true);

      // Case 4 (R2-F2): release tracks explicit owned slots, isolated from concurrent acquisition & member mutation
      resetPoolState();
      let compCall = 0;
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/v1/models")) {
          return new Response(JSON.stringify({ data: [{ id: "Qwen3.8-Linear-Test" }] }), { status: 200 });
        }
        if (url.endsWith("/api/status")) {
          return new Response(JSON.stringify({ engine: { running: 0, waiting: 0 } }), { status: 200 });
        }
        if (url.endsWith("/v1/chat/completions")) {
          compCall += 1;
          if (compCall === 1) {
            return new Response("primary overloaded", { status: 503 });
          }
          return new Response(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch;

      const targetA = await acquireLocalPoolTarget("gold-spark");
      const targetB = await acquireLocalPoolTarget("gold-spark");
      const modelA = createPoolCoreModel(targetA, { temperature: 0.1 });
      const chunks: string[] = [];
      for await (const ch of modelA({
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        toolChoice: "none",
      })) {
        if (typeof ch === "string") chunks.push(ch);
      }
      expect(chunks.join("")).toBe("ok");
      // targetA promoted from gold-spark -> dell2; targetB still holds gold-spark
      const statsMid = Object.fromEntries(poolStats().members.map((m) => [m.name, m.inFlight]));
      expect(statsMid["gold-spark"]).toBe(1);
      expect(statsMid["dell2"]).toBe(1);
      // Even if targetA.member were mutated afterward, targetA.release() only frees its owned slot (dell2)
      targetA.member = { ...targetA.member, name: "gold-spark" };
      targetA.release();
      const statsAfterA = Object.fromEntries(poolStats().members.map((m) => [m.name, m.inFlight]));
      expect(statsAfterA["gold-spark"]).toBe(1);
      expect(statsAfterA["dell2"]).toBe(0);
      targetB.release();
      expect(poolStats().members.every((m) => m.inFlight === 0)).toBe(true);

      // Case 5 (R3-F1): caller cancellation / deadline during candidate #1 discovery rethrows without trying sibling
      resetPoolState();
      const ctl = new AbortController();
      let probePhase = 0;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/status")) {
          return new Response(JSON.stringify({ engine: { running: 0, waiting: 0 } }), { status: 200 });
        }
        if (url.endsWith("/v1/models")) {
          probePhase += 1;
          if (probePhase <= 2) {
            return new Response(JSON.stringify({}), { status: 200 });
          }
          ctl.abort(new Error("caller aborted during discovery"));
          return await new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch;
      await expect(acquireLocalPoolTarget("gold-spark", ctl.signal)).rejects.toThrow("caller aborted during discovery");
      expect(probePhase).toBe(3);
      expect(poolStats().members.every((m) => m.inFlight === 0)).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
