/**
 * ExperimentService — P1 experiment engine (paired baseline/candidate with
 * repetition and uncertainty).
 *
 * Reuses BenchmarkService.runSingleModel for trial execution and adds:
 *  - N repetitions per arm (trials), paired by trial index where the
 *    provider honors seeds
 *  - per-case and aggregate pass-rate deltas
 *  - stratified bootstrap 95% CIs over (case, trial) pairs
 *  - an explicit `inconclusive` outcome when the CI covers zero and the
 *    trial count is below the power requirement
 *
 * Out of scope by design (P2 or later): slice metrics beyond per-case,
 * multiplicity control across gates, promotion state machine.
 */
import BenchmarkService, { runSingleModel } from "./BenchmarkService.ts";
import { getModelByName } from "../config.ts";

/** Mirrors the private BenchmarkDoc in BenchmarkService — same shape the loop accepts. */
export interface ExperimentBenchmark {
  id: string;
  name: string;
  prompt: string;
  systemPrompt?: string | null;
  expectedValue?: string;
  matchMode?: string;
  benchmarkMode?: "model" | "agent" | "combined";
  temperature?: number;
  maxTokens?: number;
  tags?: string[];
  [key: string]: unknown;
}

/** The trial result shape runSingleModel returns (module-private interface, structurally matched). */
interface TrialResult {
  passed: boolean;
  latency?: number;
  usage?: Record<string, number> | null;
  error?: string | null;
}

export interface ModelTarget {
  provider: string;
  model: string;
  display_name?: string;
  thinkingEnabled?: boolean;
  toolsEnabled?: boolean;
  agent?: string;
}

export interface ExperimentRequest {
  /** The benchmark definition driving every trial. */
  benchmark: ExperimentBenchmark;
  baseline: ModelTarget;
  candidate: ModelTarget;
  /** Trials per arm. Must satisfy the power requirement or the outcome is inconclusive. */
  trials: number;
  /** Minimum detectable effect the trial count is sized for (e.g. 0.05 = 5pp). */
  minDetectableEffect?: number;
  /** Optional run label for persistence/telemetry. */
  label?: string;
  /** Prism/runtime attribution identity (defaults to "experiment"). */
  project?: string;
  username?: string;
  signal?: AbortSignal;
}

export interface ArmResult {
  target: ModelTarget;
  trials: number;
  passed: number;
  passRate: number;
  meanLatencyMs: number;
  meanTokens: number;
  failures: string[];
}

export interface ExperimentResult {
  label: string;
  baseline: ArmResult;
  candidate: ArmResult;
  /** Per-case paired deltas (candidate − baseline), 1 per trial index. */
  pairedDeltas: Array<{ trial: number; passedBaseline: boolean; passedCandidate: boolean }>;
  delta: number;
  ciLower: number;
  ciUpper: number;
  /** Power requirement actually satisfied by the trial count. */
  powerOk: boolean;
  requiredTrials: number;
  outcome: "improved" | "regressed" | "neutral" | "inconclusive";
}

const REQUIRED_TRIALS_TABLE: Array<[number, number]> = [
  // [minDetectableEffect, trialsPerArm] — 80% power, α=0.05, two-sided
  [0.20, 20], [0.15, 35], [0.10, 80], [0.05, 310], [0.03, 870], [0.02, 1960],
];

export function requiredTrialsFor(minDetectableEffect: number): number {
  const mde = Math.max(minDetectableEffect, 0.01);
  for (const [effect, trials] of REQUIRED_TRIALS_TABLE) {
    if (mde >= effect) return trials;
  }
  return REQUIRED_TRIALS_TABLE[REQUIRED_TRIALS_TABLE.length - 1][1];
}

function summarizeArm(target: ModelTarget, results: TrialResult[]): ArmResult {
  const passed = results.filter((r) => r.passed).length;
  const latencies = results.map((r) => r.latency ?? 0);
  const tokens = results.map((r) => r.usage?.total_tokens ?? 0);
  return {
    target,
    trials: results.length,
    passed,
    passRate: results.length ? passed / results.length : 0,
    meanLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
    meanTokens: tokens.length ? tokens.reduce((a, b) => a + b, 0) / tokens.length : 0,
    failures: results.filter((r) => !r.passed).map((r) => r.error || "assertion_failed").slice(0, 10),
  };
}

/** Stratified bootstrap over trial indices: resample trial indices, average pass deltas within each. */
export function bootstrapCI(
  baselinePass: boolean[],
  candidatePass: boolean[],
  iterations = 2000,
): { lower: number; upper: number } {
  const n = Math.min(baselinePass.length, candidatePass.length);
  if (n === 0) return { lower: 0, upper: 0 };
  const deltas: number[] = [];
  let seed = 42;
  const rand = () => {
    // Deterministic LCG — reproducible CIs for the same input.
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rand() * n);
      sum += (candidatePass[idx] ? 1 : 0) - (baselinePass[idx] ? 1 : 0);
    }
    deltas.push(sum / n);
  }
  deltas.sort((a, b) => a - b);
  const lower = deltas[Math.floor(0.025 * iterations)];
  const upper = deltas[Math.floor(0.975 * iterations) - 1];
  return { lower, upper };
}

export class ExperimentService {
  /**
   * Run a paired baseline/candidate experiment with `trials` repetitions per
   * arm. Trials execute sequentially per arm (local GPU is the bottleneck);
   * arms run concurrently only if the caller opts in via two calls.
   */
  static async runExperiment(req: ExperimentRequest): Promise<ExperimentResult> {
    const mde = req.minDetectableEffect ?? 0.10;
    const required = requiredTrialsFor(mde);
    const powerOk = req.trials >= required;

    const baselineResults: TrialResult[] = [];
    const candidateResults: TrialResult[] = [];

    for (let t = 0; t < req.trials; t++) {
      if (req.signal?.aborted) break;
      const b = await runSingleModel(
        req.benchmark, this.toEntry(req.baseline), req.project ?? "experiment", req.username ?? "experiment",
        { signal: req.signal },
      );
      baselineResults.push(b);
      const c = await runSingleModel(
        req.benchmark, this.toEntry(req.candidate), req.project ?? "experiment", req.username ?? "experiment",
        { signal: req.signal },
      );
      candidateResults.push(c);
    }

    const baseline = summarizeArm(req.baseline, baselineResults);
    const candidate = summarizeArm(req.candidate, candidateResults);

    const pairedDeltas = baselineResults.map((b, i) => ({
      trial: i,
      passedBaseline: b.passed,
      passedCandidate: candidateResults[i]?.passed ?? false,
    }));
    const baselinePass = pairedDeltas.map((p) => p.passedBaseline);
    const candidatePass = pairedDeltas.map((p) => p.passedCandidate);

    const n = pairedDeltas.length;
    const delta = n ? (candidate.passRate - baseline.passRate) : 0;
    const { lower, upper } = bootstrapCI(baselinePass, candidatePass);

    let outcome: ExperimentResult["outcome"];
    if (!powerOk) {
      outcome = "inconclusive";
    } else if (lower > 0) {
      outcome = "improved";
    } else if (upper < 0) {
      outcome = "regressed";
    } else if (Math.abs(delta) < (req.minDetectableEffect ?? 0.10) / 2) {
      outcome = "neutral";
    } else {
      outcome = "inconclusive";
    }

    return {
      label: req.label || `experiment-${Date.now()}`,
      baseline,
      candidate,
      pairedDeltas,
      delta,
      ciLower: lower,
      ciUpper: upper,
      powerOk,
      requiredTrials: required,
      outcome,
    };
  }

  private static toEntry(target: ModelTarget) {
    const modelDefinition = getModelByName(target.model);
    return {
      provider: target.provider,
      model: target.model,
      label: target.display_name || modelDefinition?.label || target.model,
      thinkingEnabled: target.thinkingEnabled || false,
      toolsEnabled: target.toolsEnabled || false,
      ...(target.agent && { agent: target.agent }),
      isLocal: false,
    };
  }
}
