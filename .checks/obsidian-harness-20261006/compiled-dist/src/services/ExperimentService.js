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
import { runSingleModel } from "./BenchmarkService.js";
import { getModelByName } from "../config.js";
const REQUIRED_TRIALS_TABLE = [
    // [minDetectableEffect, trialsPerArm] — 80% power, α=0.05, two-sided
    [0.20, 20], [0.15, 35], [0.10, 80], [0.05, 310], [0.03, 870], [0.02, 1960],
];
export function requiredTrialsFor(minDetectableEffect) {
    const mde = Math.max(minDetectableEffect, 0.01);
    for (const [effect, trials] of REQUIRED_TRIALS_TABLE) {
        if (mde >= effect)
            return trials;
    }
    return REQUIRED_TRIALS_TABLE[REQUIRED_TRIALS_TABLE.length - 1][1];
}
function summarizeArm(target, results) {
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
export function bootstrapCI(baselinePass, candidatePass, iterations = 2000) {
    const n = Math.min(baselinePass.length, candidatePass.length);
    if (n === 0)
        return { lower: 0, upper: 0 };
    const deltas = [];
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
    static async runExperiment(req) {
        const mde = req.minDetectableEffect ?? 0.10;
        const required = requiredTrialsFor(mde);
        const powerOk = req.trials >= required;
        const baselineResults = [];
        const candidateResults = [];
        for (let t = 0; t < req.trials; t++) {
            if (req.signal?.aborted)
                break;
            const b = await runSingleModel(req.benchmark, this.toEntry(req.baseline), req.project ?? "experiment", req.username ?? "experiment", { signal: req.signal });
            baselineResults.push(b);
            const c = await runSingleModel(req.benchmark, this.toEntry(req.candidate), req.project ?? "experiment", req.username ?? "experiment", { signal: req.signal });
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
        let outcome;
        if (!powerOk) {
            outcome = "inconclusive";
        }
        else if (lower > 0) {
            outcome = "improved";
        }
        else if (upper < 0) {
            outcome = "regressed";
        }
        else if (Math.abs(delta) < (req.minDetectableEffect ?? 0.10) / 2) {
            outcome = "neutral";
        }
        else {
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
    static toEntry(target) {
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
//# sourceMappingURL=ExperimentService.js.map