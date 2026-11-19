/**
 * WI-5 One-Example Proof: Cross-Model CRSI + Self-Improvement Memory (SIM) on `v3_quant_analyst`
 * across live local DeepSeek (`gold-spark` 10.0.0.141:8000) and Qwen (`dell1` 10.0.0.131:8888 / `dell2` 10.0.0.37:8888).
 *
 * Climbs the 4-rung verification ladder (`.agents/AGENTS.md`):
 *   Rung 1: Static + A/A, Known-Answer, and Mutation controls (`runCrsiSelftest`)
 *   Rung 2: Live MongoDB `trading_bot` frozen corpus build + disjoint `evolve`/`holdout` check + IDLE guard
 *   Rung 3: 2-case live cross-model smoke (DeepSeek + Qwen) with `SimStore` MongoDB persistence
 *   Rung 4: Paired `Full SIM` vs `No SIM` continuation + blind `holdout` evaluation & `PromotionController` shadow registration
 *
 * Usage:
 *   testrun --mem 4G --max-time 45m -- npx tsx scripts/crsi-trading-proof.ts [--agent=v3_quant_analyst] [--evolve=3] [--holdout=4]
 */
import fs from "node:fs";
import path from "node:path";
import { fetch as undiciFetch } from "undici";
import { bootstrapLocalEnvironment } from "../src/bootstrap.ts";

(globalThis as Record<string, unknown>).fetch = undiciFetch;
bootstrapLocalEnvironment();

const { TRADING_MONGO_DB } = await import("../config.ts");
const MongoWrapper = (await import("../src/wrappers/MongoWrapper.ts")).default;
const { SimStore } = await import("../src/services/harness2/SimStore.ts");
const {
  assertNoHoldoutLeak,
  buildFrozenTradingCorpus,
  defaultHttpChatTurn,
  discoverLiveEndpointTarget,
  evaluateSplitAcrossModels,
  isTradingPipelineBusy,
  runCrossModelCrsi,
  runCrsiSelftest,
} = await import("../src/services/harness2/CrossModelCrsiService.ts");

const arg = (name: string, fallback: string) =>
  (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=").slice(1).join("=");

const AGENT = arg("agent", "v3_quant_analyst");
const EVOLVE_LIMIT = Number(arg("evolve", "2"));
const HOLDOUT_LIMIT = Number(arg("holdout", "3"));
const ROUNDS = Number(arg("rounds", "2"));
const MAX_TURNS = Number(arg("max-turns", "5"));
const OUT_FILE = path.resolve(
  process.cwd(),
  arg("out", `.checks/crsi-quant-proof-${new Date().toISOString().slice(0, 10)}.json`),
);

function log(rung: string, msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${rung}] ${msg}`);
}

/** Add replicaSet directConnection when running from WSL against single-node NAS MongoDB. */
function directMongoUri(rawUri: string): string {
  const u = new URL(rawUri);
  if (!u.searchParams.has("directConnection") && u.hostname !== "mongodb") {
    u.searchParams.set("directConnection", "true");
    u.searchParams.delete("replicaSet");
  }
  return u.toString();
}

async function main(): Promise<void> {
  // ── Rung 1: Static + A/A, Known-Answer, Mutation Controls ──
  log("RUNG-1", "Running A/A, Known-Answer, and Mutation self-test controls...");
  const selftest = await runCrsiSelftest();
  if (!selftest.passed) {
    throw new Error(`Rung 1 failed self-test controls: ${JSON.stringify(selftest.checks)}`);
  }
  log("RUNG-1", `PASS controls=${JSON.stringify(selftest.checks)}`);

  // ── Rung 2: Live MongoDB Corpus + Disjointness + IDLE Check ──
  const rawUri = process.env.PRISM_MONGO_URI || process.env.MONGO_URI;
  if (!rawUri) throw new Error("MONGO_URI is not configured after bootstrapLocalEnvironment()");
  await MongoWrapper.createClient(TRADING_MONGO_DB, directMongoUri(rawUri));

  try {
    if (await isTradingPipelineBusy(TRADING_MONGO_DB)) {
      throw new Error("Live trading cycle is currently BUSY; refusing to run off-cycle CRSI proof.");
    }
    log("RUNG-2", "Trading pipeline confirmed IDLE. Building frozen trace corpus from trading_bot...");
    const fullCorpus = await buildFrozenTradingCorpus({ agentRole: AGENT, maxCases: 90, mongoDbName: TRADING_MONGO_DB });
    assertNoHoldoutLeak(
      fullCorpus.evolve.map((c) => c.caseId).join("\n"),
      fullCorpus.holdout,
    );
    log(
      "RUNG-2",
      `PASS corpus=${fullCorpus.corpusHash} total=${fullCorpus.evolve.length + fullCorpus.holdout.length} evolve=${fullCorpus.evolve.length} holdout=${fullCorpus.holdout.length} (ASSUMPTION-1 holdout>=30: ${fullCorpus.holdout.length >= 30})`,
    );
    if (fullCorpus.evolve.length < 2 || fullCorpus.holdout.length < 2) {
      throw new Error(`Insufficient non-truncated ${AGENT} trace cases: evolve=${fullCorpus.evolve.length}, holdout=${fullCorpus.holdout.length}`);
    }

    // Prioritize multi-loop recorded cases on evolve & holdout so the stimulus actually exercises tool-loop behavior!
    const pickActive = <T extends { recordedLoops: number }>(items: T[], n: number): T[] =>
      [...items].sort((a, b) => b.recordedLoops - a.recordedLoops).slice(0, n);
    const evolveSlice = pickActive(fullCorpus.evolve, EVOLVE_LIMIT);
    const holdoutSlice = pickActive(fullCorpus.holdout, HOLDOUT_LIMIT);

    // Discover live local endpoints via `/v1/models` (zero hardcoded model IDs).
    const goldUrl = process.env.VLLM_SHIM_GOLD_SPARK_URL || "http://10.0.0.141:8000";
    const dell1Url = process.env.VLLM_SHIM_DELL1_URL || "http://10.0.0.131:8888";
    const dell2Url = process.env.VLLM_SHIM_DELL2_URL || "http://10.0.0.37:8888";
    const [deepseekTarget, qwenTarget] = await Promise.all([
      discoverLiveEndpointTarget("gold-spark", goldUrl),
      discoverLiveEndpointTarget("dell1", dell1Url).catch(() => discoverLiveEndpointTarget("dell2", dell2Url)),
    ]);
    log(
      "RUNG-2",
      `Live endpoints discovered: ${deepseekTarget.label}=${deepseekTarget.modelFamily}/${deepseekTarget.modelId}, ${qwenTarget.label}=${qwenTarget.modelFamily}/${qwenTarget.modelId}`,
    );

    const logRollout = (phase: string) => (ev: { caseId: string; modelFamily: string; loopsUsed: number; artifactValid: boolean; evidenceCompleted: boolean; compositeScore: number; elapsedMs: number; interlockFired: string | null; error?: string }) => {
      log(
        phase,
        `  rollout ${ev.caseId} [${ev.modelFamily}] loops=${ev.loopsUsed} valid=${ev.artifactValid} ev=${ev.evidenceCompleted} score=${ev.compositeScore} interlock=${ev.interlockFired ?? "none"} (${Math.round(ev.elapsedMs / 1000)}s)${ev.error ? ` err=${ev.error.slice(0, 80)}` : ""}`,
      );
    };
    const chatTurn = defaultHttpChatTurn();
    const checkBusy = () => isTradingPipelineBusy(TRADING_MONGO_DB);

    // ── Rung 3: 1-Round Smoke with MongoDB-Backed SimStore (computing shared evolve baseline once) ──
    log("RUNG-3", `Computing shared evolve baseline (${evolveSlice.map((c) => c.caseId).join(", ")})...`);
    const sharedEvolveBaseline = await evaluateSplitAcrossModels({
      cases: evolveSlice,
      targets: [deepseekTarget, qwenTarget],
      interlockByFamily: () => null,
      chatTurn,
      maxTurns: MAX_TURNS,
      checkBusy,
      onRollout: logRollout("RUNG-3:base"),
    });
    const smokeSim = new SimStore(`trading-crsi-${AGENT}`, { useMongo: true, mongoDbName: TRADING_MONGO_DB });
    await smokeSim.load();
    const smokeCaseIds = new Set(evolveSlice.slice(0, 2).map((c) => c.caseId));
    const smokeOut = await runCrossModelCrsi({
      agentRole: AGENT,
      corpus: { corpusHash: `${fullCorpus.corpusHash}-smoke`, evolve: evolveSlice.slice(0, 2), holdout: [] },
      targets: [deepseekTarget, qwenTarget],
      improverTarget: deepseekTarget,
      simStore: smokeSim,
      simCondition: "full",
      rounds: 1,
      maxTurns: MAX_TURNS,
      precomputedEvolveBaseline: sharedEvolveBaseline.filter((e) => smokeCaseIds.has(e.caseId)),
      chatTurn,
      checkBusy,
      onRollout: logRollout("RUNG-3:smoke"),
    });
    log(
      "RUNG-3",
      `PASS smoke evolve score ${smokeOut.evolveBaseline.meanScore} -> ${smokeOut.evolveFinal.meanScore}; SIM problems=${smokeSim.snapshot().problems.length}`,
    );

    // ── Rung 4: Paired `Full SIM` (carrying Rung 3 SIM) vs `No SIM` (dryRun control) + Blind Holdout Proof ──
    log(
      "RUNG-4",
      `Computing shared blind holdout baseline (${holdoutSlice.map((c) => c.caseId).join(", ")})...`,
    );
    const sharedHoldoutBaseline = await evaluateSplitAcrossModels({
      cases: holdoutSlice,
      targets: [deepseekTarget, qwenTarget],
      interlockByFamily: () => null,
      chatTurn,
      maxTurns: MAX_TURNS,
      checkBusy,
      onRollout: logRollout("RUNG-4:holdBase"),
    });
    log(
      "RUNG-4",
      `Running paired ${ROUNDS}-round CRSI (${evolveSlice.length} evolve, ${holdoutSlice.length} holdout) across ${deepseekTarget.modelId} + ${qwenTarget.modelId}...`,
    );
    const noSimStore = new SimStore(`trading-crsi-${AGENT}-nosim`, {
      filePath: path.join(path.dirname(OUT_FILE), "nosim-scratch.json"),
      useMongo: false,
    });
    const noSimRun = await runCrossModelCrsi({
      agentRole: AGENT,
      corpus: { corpusHash: fullCorpus.corpusHash, evolve: evolveSlice, holdout: holdoutSlice },
      targets: [deepseekTarget, qwenTarget],
      improverTarget: deepseekTarget,
      simStore: noSimStore,
      simCondition: "none",
      rounds: ROUNDS,
      maxTurns: MAX_TURNS,
      minHoldoutCases: 30,
      promoteToCanary: false,
      dryRun: true, // R3-F2: No-SIM control arm never writes to production PromotionController / shim_interlocks.json
      precomputedEvolveBaseline: sharedEvolveBaseline,
      precomputedHoldoutBaseline: sharedHoldoutBaseline,
      chatTurn,
      checkBusy,
      onRollout: logRollout("RUNG-4:noSim"),
    });

    const fullSimRun = await runCrossModelCrsi({
      agentRole: AGENT,
      corpus: { corpusHash: fullCorpus.corpusHash, evolve: evolveSlice, holdout: holdoutSlice },
      targets: [deepseekTarget, qwenTarget],
      improverTarget: deepseekTarget,
      simStore: smokeSim,
      simCondition: "full",
      rounds: ROUNDS,
      maxTurns: MAX_TURNS,
      minHoldoutCases: 30,
      promoteToCanary: false, // DECISION-5: cap initial promotion at `shadow` for operator review
      precomputedEvolveBaseline: sharedEvolveBaseline,
      precomputedHoldoutBaseline: sharedHoldoutBaseline,
      chatTurn,
      checkBusy,
      onRollout: logRollout("RUNG-4:fullSim"),
    });

    if (fs.existsSync(noSimStore.filePath)) fs.rmSync(noSimStore.filePath, { force: true });

    const report = {
      generatedAt: new Date().toISOString(),
      agentRole: AGENT,
      endpoints: { deepseek: deepseekTarget, qwen: qwenTarget },
      corpusCounts: {
        fullEvolve: fullCorpus.evolve.length,
        fullHoldout: fullCorpus.holdout.length,
        assumption1Cleared30Holdout: fullCorpus.holdout.length >= 30,
        pilotEvolveUsed: evolveSlice.map((c) => ({ caseId: c.caseId, recordedLoops: c.recordedLoops, recordedModel: c.recordedModel })),
        pilotHoldoutUsed: holdoutSlice.map((c) => ({ caseId: c.caseId, recordedLoops: c.recordedLoops, recordedModel: c.recordedModel })),
      },
      rung1Controls: selftest.checks,
      noSimContinuation: {
        retainedConfig: noSimRun.retainedConfig,
        evolveBaseline: noSimRun.evolveBaseline,
        evolveFinal: noSimRun.evolveFinal,
        holdoutVerdict: noSimRun.holdoutVerdict,
      },
      fullSimContinuation: {
        retainedConfig: fullSimRun.retainedConfig,
        evolveBaseline: fullSimRun.evolveBaseline,
        evolveFinal: fullSimRun.evolveFinal,
        holdoutVerdict: fullSimRun.holdoutVerdict,
        simProblemsRecorded: smokeSim.snapshot().problems.length,
        simSnapshot: smokeSim.snapshot(),
      },
    };

    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    log("RUNG-4", `Saved proof report -> ${OUT_FILE}`);
    log(
      "SUMMARY",
      `FullSIM holdout=${fullSimRun.holdoutVerdict?.status ?? "no-edit"} (delta=${fullSimRun.holdoutVerdict?.delta ?? 0}, ci=[${fullSimRun.holdoutVerdict?.ciLow ?? 0}, ${fullSimRun.holdoutVerdict?.ciHigh ?? 0}], channel=${fullSimRun.holdoutVerdict?.promotedChannel ?? "none"}) vs NoSIM holdout delta=${noSimRun.holdoutVerdict?.delta ?? 0}`,
    );
  } finally {
    await MongoWrapper.closeClient(TRADING_MONGO_DB).catch(() => {});
  }
}

await main();
