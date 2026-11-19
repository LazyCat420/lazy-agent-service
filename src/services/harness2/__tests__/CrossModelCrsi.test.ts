import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import harness2Router from "../../../routes/Harness2Routes.ts";
import MongoWrapper from "../../../wrappers/MongoWrapper.ts";
import { PromotionController } from "../../PromotionController.ts";
import * as ToolStacks from "../../TradingToolStacks.ts";
import { tradingShimProfileId } from "../../TradingToolProtocol.ts";
import {
  assertNoHoldoutLeak,
  deterministicSplit,
  evaluateHoldoutAndPromote,
  isTradingPipelineBusy,
  replayFrozenCase,
  runCrossModelCrsi,
  runCrsiSelftest,
  type ChatTurnFn,
  type FrozenTradingCase,
  type ModelEndpointTarget,
} from "../CrossModelCrsiService.ts";
import { SimStore } from "../SimStore.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PROMOTION_INTERLOCK_STORE_PATH;
  delete process.env.HARNESS2_SIM_PATH;
  delete process.env.RUNTIME_API_TOKEN;
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function isolateStores(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-model-crsi-test-"));
  tmpDirs.push(dir);
  process.env.PROMOTION_INTERLOCK_STORE_PATH = path.join(dir, "shim_interlocks.json");
  process.env.HARNESS2_SIM_PATH = dir;
  (PromotionController as unknown as { state: Map<string, unknown> }).state = new Map();
  (PromotionController as unknown as { initialized: boolean }).initialized = false;
  (PromotionController as unknown as { storePath: string }).storePath = path.join(dir, "promo.json");
  return dir;
}

function makeSyntheticCorpus(count = 70): {
  corpusHash: string;
  evolve: FrozenTradingCase[];
  holdout: FrozenTradingCase[];
} {
  const evolve: FrozenTradingCase[] = [];
  const holdout: FrozenTradingCase[] = [];
  for (let i = 0; i < count; i++) {
    const cycleId = `cycle-v3-17941${10000 + i}`;
    const ticker = `TK${i % 7}`;
    const split = deterministicSplit(cycleId, ticker);
    const fc: FrozenTradingCase = {
      caseId: `${cycleId}|${ticker}`,
      cycleId,
      ticker,
      agentRole: "v3_quant_analyst",
      split,
      recordedModel: "Qwen3.8-Flash-Next",
      recordedLoops: 11,
      systemPrompt: "You are v3_quant_analyst. Return quant_report JSON.",
      userPrompt: `## Ticker: ${ticker}\n## Cycle: ${cycleId}`,
      allowedTools: ["get_polygon_price_history", "run_equation"],
      tools: [
        { type: "function", function: { name: "get_polygon_price_history", parameters: { type: "object" } } },
        { type: "function", function: { name: "run_equation", parameters: { type: "object" } } },
      ],
      toolFixtures: { get_polygon_price_history: ['{"price_rows":252}'] },
    };
    if (split === "evolve") evolve.push(fc);
    else holdout.push(fc);
  }
  return { corpusHash: "synth-corpus-20261118", evolve, holdout };
}

const TARGETS: ModelEndpointTarget[] = [
  { label: "gold-spark", baseUrl: "http://127.0.0.1:1", modelId: "DeepSeek-V4.1-Flash-1017", modelFamily: "deepseek" },
  { label: "dell1", baseUrl: "http://127.0.0.1:2", modelId: "Qwen3.8-Flash-Next", modelFamily: "qwen" },
];

const dualFamilyStubChat: ChatTurnFn = async (target, body) => {
  const msgs = body.messages as Array<{ role: string; content?: string; tool_calls?: unknown[] }>;
  const toolTurns = msgs.filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls)).length;
  const lastMsg = String(msgs[msgs.length - 1]?.content || "");
  if (toolTurns === 0) {
    return {
      content: null,
      toolCalls: [{ id: "read-1", name: "get_polygon_price_history", arguments: '{"ticker":"TK0"}' }],
    };
  }
  // DeepSeek finishes cleanly in 1 tool turn.
  if (target.modelFamily === "deepseek") {
    return { content: '{"summary":"deepseek quant ok","risk_metrics":{"sharpe":1.4}}', toolCalls: [] };
  }
  // Qwen blind-retries dict `run_equation` until interlock `[tool-retry]` fires, or fails with prose at wall without directive.
  if (lastMsg.includes("[TRADING INTERLOCK v1]")) {
    return { content: '{"summary":"qwen converged via interlock","risk_metrics":{"sharpe":1.3}}', toolCalls: [] };
  }
  if (body.tool_choice === "none") {
    return {
      content: lastMsg.includes("Reply at once with the complete required JSON artifact")
        ? '{"summary":"qwen wall salvaged","risk_metrics":{"sharpe":1.1}}'
        : "I ran out of steps while debugging run_equation.",
      toolCalls: [],
    };
  }
  return {
    content: null,
    toolCalls: [{ id: `eq-${toolTurns}`, name: "run_equation", arguments: '{"code":"out = {\\"rv\\": 0.4}"}' }],
  };
};

describe("CrossModelCrsiService (WI-4, arXiv:2611.18856 S2 + SIM + Holdout Controls)", () => {
  it("passes A/A, Known-Answer, and Mutation controls", async () => {
    isolateStores();
    const res = await runCrsiSelftest();
    expect(res.passed).toBe(true);
    expect(res.checks).toEqual({
      aaSpansZero: true,
      knownAnswerPassed: true,
      mutationBlocked: true,
    });
  });

  it("enforces strict holdout disjointness (assertNoHoldoutLeak)", () => {
    const corpus = makeSyntheticCorpus(10);
    expect(() => assertNoHoldoutLeak("clean evolve prompt", corpus.holdout)).not.toThrow();
    expect(() =>
      assertNoHoldoutLeak(`prompt mentioning ${corpus.holdout[0].caseId}`, corpus.holdout),
    ).toThrow(/Holdout leakage violation/);
  });

  it("runs S2 unified synthesis across DeepSeek + Qwen, records SIM, and promotes passing candidate to shadow/canary_5", async () => {
    const dir = isolateStores();
    const corpus = makeSyntheticCorpus(76);
    const simStore = new SimStore("quant-s2-test", { filePath: path.join(dir, "SIM.json"), useMongo: false });
    const seenPrompts: string[] = [];

    const out = await runCrossModelCrsi({
      agentRole: "v3_quant_analyst",
      corpus,
      targets: TARGETS,
      improverTarget: TARGETS[0],
      simStore,
      simCondition: "full",
      rounds: 2,
      maxTurns: 6,
      minHoldoutCases: 30,
      promoteToCanary: true,
      chatTurn: dualFamilyStubChat,
      improver: async (prompt, label) => {
        seenPrompts.push(prompt);
        const targetIds = corpus.evolve.slice(0, 3).map((c) => c.caseId).join(", ");
        if (label === "crsi-r1") {
          return [
            `<diagnosis problem="NEW">Qwen run_equation dict TypeError loop + native wall prose</diagnosis>`,
            `<predicted>${targetIds}</predicted>`,
            `<rationale>Stop after 2 consecutive run_equation errors and direct native exhaustion wall to JSON.</rationale>`,
            "```json",
            JSON.stringify({
              matchNativeExhaustionNotice: true,
              maxConsecutiveToolErrors: 2,
              turnWarnThreshold: 5,
              toolErrorHint: "Return scalar values in run_equation.",
            }),
            "```",
          ].join("\n");
        }
        return [
          `<diagnosis problem="P1">Qwen run_equation dict TypeError loop + native wall prose</diagnosis>`,
          `<predicted>${targetIds}</predicted>`,
          `<rationale>Tighten turnWarnThreshold to 4 while keeping 2-error stop.</rationale>`,
          "```json",
          JSON.stringify({
            matchNativeExhaustionNotice: true,
            maxConsecutiveToolErrors: 2,
            turnWarnThreshold: 4,
            toolErrorHint: "Return scalar values in run_equation.",
          }),
          "```",
        ].join("\n");
      },
    });

    // Round 2 prompt saw Round 1's SIM entry P1, and zero holdout IDs leaked.
    expect(seenPrompts[1]).toContain("P1 (opened r1)");
    for (const p of seenPrompts) assertNoHoldoutLeak(p, corpus.holdout);

    expect(out.holdoutVerdict?.status).toBe("passed");
    expect(out.holdoutVerdict?.delta).toBeGreaterThan(0.3);
    expect(out.holdoutVerdict?.ciLow).toBeGreaterThan(0);
    expect(out.holdoutVerdict?.promotedChannel).toBe("canary_5");
    // DeepSeek remained 100% valid (non-inferiority guard), Qwen rose from 0% to 100% valid and loops dropped from 6 to 3!
    expect(out.holdoutVerdict?.candidate.byFamily.deepseek.validityRate).toBe(1);
    expect(out.holdoutVerdict?.candidate.byFamily.qwen.validityRate).toBe(1);
    expect(out.holdoutVerdict?.candidate.byFamily.qwen.avgLoops).toBeLessThan(
      out.holdoutVerdict!.baseline.byFamily.qwen.avgLoops!,
    );
  });

  it("aborts immediately when checkBusy reports a live trading cycle", async () => {
    const dir = isolateStores();
    const corpus = makeSyntheticCorpus(6);
    const simStore = new SimStore("busy-abort", { filePath: path.join(dir, "SIM.json"), useMongo: false });
    await expect(
      runCrossModelCrsi({
        agentRole: "v3_quant_analyst",
        corpus,
        targets: TARGETS,
        improverTarget: TARGETS[0],
        simStore,
        chatTurn: dualFamilyStubChat,
        checkBusy: async () => true,
      }),
    ).rejects.toThrow(/Live trading cycle became busy/);
  });

  it("exposes open GET /harness2/sim/:domain and runtimeAuth-protected POST /harness2/crsi/selftest without mutating production stores", async () => {
    const dir = isolateStores();
    process.env.RUNTIME_API_TOKEN = "test-crsi-token";
    const store = new SimStore("route-sim", { useMongo: false });
    await store.recordAttempt({
      rootCause: "Test route problem",
      round: 1,
      sample: "r1",
      accepted: true,
      what: "config update",
      files: ["TradingToolProtocol.ts"],
      rationale: "route check",
      predicted: ["c1"],
      fixed: ["c1"],
      missed: [],
      passed: 1,
      total: 1,
      modelId: "Qwen3.8-Flash-Next",
    });

    const app = express();
    app.use(express.json());
    app.use("/harness2", harness2Router);
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/harness2`;
    try {
      const simRes = await fetch(`${base}/sim/route-sim?condition=full`);
      expect(simRes.status).toBe(200);
      const simJson = (await simRes.json()) as { sim: { problems: unknown[] }; prompt: string };
      expect(simJson.sim.problems).toHaveLength(1);
      expect(simJson.prompt).toContain("P1 (opened r1): Test route problem");

      const unauth = await fetch(`${base}/crsi/selftest`, { method: "POST" });
      expect(unauth.status).toBe(401);

      const selftestRes = await fetch(`${base}/crsi/selftest`, {
        method: "POST",
        headers: { "x-runtime-token": "test-crsi-token" },
      });
      expect(selftestRes.status).toBe(200);
      expect(((await selftestRes.json()) as { passed: boolean }).passed).toBe(true);
      // Selftest is pure dry-run: zero fake records in PromotionController or shim_interlocks.json!
      expect(PromotionController.listByProfile(tradingShimProfileId("v3_quant_analyst", "qwen"))).toEqual([]);
      expect(fs.existsSync(path.join(dir, "shim_interlocks.json"))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails closed when MongoDB busy-check is unavailable or throws, and prevents failed reruns from mutating promoted interlocks", async () => {
    const dir = isolateStores();
    vi.spyOn(MongoWrapper, "getDb").mockReturnValue(undefined as never);
    expect(await isTradingPipelineBusy()).toBe(true);

    vi.spyOn(MongoWrapper, "getDb").mockReturnValue({
      collection: () => ({
        findOne: async () => {
          throw new Error("mongo socket reset");
        },
      }),
    } as never);
    expect(await isTradingPipelineBusy()).toBe(true);

    const corpus = makeSyntheticCorpus(10);
    const baseEval = corpus.holdout.map((c) => ({
      caseId: c.caseId,
      endpointLabel: "dell1",
      modelId: "Qwen3.8-Flash-Next",
      modelFamily: "qwen" as const,
      artifactValid: true,
      evidenceCompleted: true,
      loopsUsed: 2,
      elapsedMs: 10,
      interlockFired: null,
      compositeScore: 0.95,
      finalPreview: "{}",
    }));
    const worseEval = baseEval.map((e) => ({ ...e, artifactValid: false, compositeScore: 0 }));

    // Failed evaluation must NOT write candidate config to shim_interlocks.json or PromotionController,
    // even when pairedCases < minHoldoutCases (reports "failed", never masked as "underpowered" — R3-F3)!
    const failedVerdict = evaluateHoldoutAndPromote({
      agentRole: "v3_quant_analyst",
      targetFamily: "*",
      candidateConfig: { version: "crsi-failed-v1", maxConsecutiveToolErrors: 1 },
      holdoutCases: corpus.holdout,
      baselineEvals: baseEval,
      candidateEvals: worseEval,
      minHoldoutCases: 30,
    });
    expect(failedVerdict.status).toBe("failed");
    expect(failedVerdict.promotedChannel).toBe("offline_candidate");
    expect(PromotionController.listByProfile(tradingShimProfileId("v3_quant_analyst", "*"))).toEqual([]);
    expect(fs.existsSync(path.join(dir, "shim_interlocks.json"))).toBe(false);
  });

  it("applies unified S2 candidate across all target families (DeepSeek + Qwen), handles single-letter ticker prefix boundaries, and rejects unlisted replay tools", async () => {
    isolateStores();
    const corpus = makeSyntheticCorpus(12);

    // Single-letter holdout ticker `cycle-1|S` must NOT false-match evolve `cycle-1|SPY` or `cycle-1|SNDK`,
    // while still catching an actual `cycle-1|S` leak!
    const singleTickerHoldout: FrozenTradingCase[] = [
      { ...corpus.holdout[0], caseId: "cycle-v3-1794113650|S", cycleId: "cycle-v3-1794113650", ticker: "S" },
    ];
    expect(() => assertNoHoldoutLeak("case=cycle-v3-1794113650|SPY\ncase=cycle-v3-1794113650|SNDK", singleTickerHoldout)).not.toThrow();
    expect(() => assertNoHoldoutLeak("predicted=[cycle-v3-1794113650|S, cycle-v3-1794113650|SPY]", singleTickerHoldout)).toThrow(
      /Holdout leakage violation/,
    );

    // Unlisted / hallucinated tools return an error envelope and do NOT count as evidenceCompleted!
    const unlistedRollout = await replayFrozenCase({
      frozenCase: corpus.evolve[0],
      target: TARGETS[1],
      interlock: null,
      maxTurns: 3,
      chatTurn: async (_t, body) => {
        const turns = (body.messages as Array<{ role: string; tool_calls?: unknown[] }>).filter(
          (m) => m.role === "assistant" && Array.isArray(m.tool_calls),
        ).length;
        if (turns === 0) {
          return { content: null, toolCalls: [{ id: "bad1", name: "hallucinated_tool", arguments: "{}" }] };
        }
        return { content: '{"summary":"no real evidence","risk_metrics":{"vol":0.1}}', toolCalls: [] };
      },
    });
    expect(unlistedRollout.artifactValid).toBe(true);
    expect(unlistedRollout.evidenceCompleted).toBe(false);
    expect(unlistedRollout.compositeScore).toBe(0);

    // Unified S2 synthesis evaluates candidate on BOTH DeepSeek and Qwen: if a bad candidate breaks DeepSeek
    // when interlock is non-null, `non_inferior_validity_deepseek` blocks promotion!
    const simStore = new SimStore("unified-s2-gate", { useMongo: false });
    const regressedOnDeepSeek = await runCrossModelCrsi({
      agentRole: "v3_quant_analyst",
      corpus,
      targets: TARGETS,
      improverTarget: TARGETS[0],
      simStore,
      rounds: 1,
      minHoldoutCases: 2,
      improver: async () =>
        [
          '<diagnosis problem="NEW">Test unified cross-family gate</diagnosis>',
          `<predicted>${corpus.evolve[0].caseId}</predicted>`,
          "<rationale>Candidate applied to all families.</rationale>",
          '```json\n{"maxConsecutiveToolErrors": 2, "turnWarnThreshold": 3}\n```',
        ].join("\n"),
      chatTurn: async (target, body) => {
        const msgs = body.messages as Array<{ role: string; content?: string; tool_calls?: unknown[] }>;
        const turns = msgs.filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls)).length;
        const last = String(msgs[msgs.length - 1]?.content || "");
        if (turns === 0) {
          return { content: null, toolCalls: [{ id: "p1", name: "get_polygon_price_history", arguments: "{}" }] };
        }
        if (target.modelFamily === "deepseek") {
          // Prove DeepSeek actually receives the candidate interlock on turn 3 (`turnWarnThreshold: 3`):
          if (turns < 3) {
            return { content: null, toolCalls: [{ id: `d${turns}`, name: "get_polygon_price_history", arguments: "{}" }] };
          }
          if (last.includes("[TRADING INTERLOCK v1]")) {
            return { content: "BROKEN_BY_CANDIDATE_ON_DEEPSEEK", toolCalls: [] };
          }
          return { content: '{"summary":"ok","risk_metrics":{"vol":0.2}}', toolCalls: [] };
        }
        return { content: '{"summary":"ok","risk_metrics":{"vol":0.2}}', toolCalls: [] };
      },
    });
    // Rejected already on evolve because DeepSeek validity dropped under the candidate!
    expect(regressedOnDeepSeek.retainedConfig).toBeNull();

    // Verify evaluateSplitAcrossModels passes allowUnpromotedFamily=false on baseline and true on candidate (R3-F1),
    // and dryRun=true on runCrossModelCrsi leaves PromotionController untouched (R3-F2).
    const stackSpy = vi.spyOn(ToolStacks, "openingStack");
    const dryOut = await runCrossModelCrsi({
      agentRole: "v3_quant_analyst",
      corpus,
      targets: TARGETS,
      improverTarget: TARGETS[0],
      simStore: new SimStore("dry-run-control", { useMongo: false }),
      rounds: 1,
      minHoldoutCases: 2,
      dryRun: true,
      improver: async () =>
        [
          '<diagnosis problem="NEW">Bounded retries</diagnosis>',
          `<predicted>${corpus.evolve[0].caseId}</predicted>`,
          "<rationale>Dry run check.</rationale>",
          '```json\n{"maxConsecutiveToolErrors": 2, "matchNativeExhaustionNotice": true}\n```',
        ].join("\n"),
      chatTurn: dualFamilyStubChat,
    });
    expect(dryOut.holdoutVerdict?.status).toBe("passed");
    expect(stackSpy).toHaveBeenCalledWith(
      "v3_quant_analyst",
      expect.any(Array),
      "Qwen3.8-Flash-Next",
      { allowUnpromotedFamily: false },
    );
    expect(stackSpy).toHaveBeenCalledWith(
      "v3_quant_analyst",
      expect.any(Array),
      "Qwen3.8-Flash-Next",
      { allowUnpromotedFamily: true },
    );
    expect(PromotionController.listByProfile(tradingShimProfileId("v3_quant_analyst", "*"))).toEqual([]);
  });
});
