/**
 * AttributionAnalyzer — P1 phase 2: first-divergence detection and failure
 * classification over paired experiment trials.
 *
 * Given the two arms' trial results, the analyzer answers:
 *   1. WHERE did behavior first diverge? (first trial index whose pass
 *      results differ — the proximal turning point, Who&When formulation)
 *   2. WHAT failed, and how? (multi-label failure taxonomy over the
 *      losing trials — a trial can carry several labels)
 *
 * Both operate on data runSingleModel already produces (passed, error,
 * response, latency, usage). No new plumbing.
 */
import type { TrialResult } from "./ExperimentService.ts";

export interface PairedTrial {
  trial: number;
  baseline: TrialResult;
  candidate: TrialResult;
}

export interface Divergence {
  /** First trial index where pass results differ; null when arms agree everywhere. */
  firstDivergentTrial: number | null;
  /** Total trials where the arms disagree. */
  divergentTrials: number;
  /** Direction at first divergence: which arm failed there. */
  firstDivergenceDirection: "baseline_only" | "candidate_only" | null;
}

export const FAILURE_TAXONOMY = {
  // Observation layer
  tool_error: "The trial errored inside a tool call (error mentions tool)",
  provider_error: "The provider/model call itself failed (auth, unknown provider, timeout)",
  // Verification layer
  assertion_failed: "The response completed but failed the benchmark's assertions",
  empty_response: "The response was null or empty — harness produced nothing",
  // Everything else
  unclassified: "Failure that matches no known label",
} as const;

export type FailureLabel = keyof typeof FAILURE_TAXONOMY;

export function classifyFailure(trial: TrialResult): FailureLabel[] {
  const labels: FailureLabel[] = [];
  const error = (trial.error || "").toLowerCase();
  const response = trial.response ?? "";

  if (!response.trim() && !trial.passed) labels.push("empty_response");
  if (/tool|local tool execution/.test(error)) labels.push("tool_error");
  if (/provider|api[_ ]key|unknown provider|timeout|unauthorized|quota/.test(error)) labels.push("provider_error");
  if (trial.passed === false && response.trim() && !labels.includes("tool_error") && !labels.includes("provider_error")) {
    labels.push("assertion_failed");
  }
  if (labels.length === 0 && !trial.passed) labels.push("unclassified");
  return labels;
}

export interface FailureCluster {
  label: FailureLabel;
  description: string;
  count: number;
  /** Trial indices carrying this label (either arm). */
  trials: number[];
}

export interface AttributionReport {
  divergence: Divergence;
  /** Failure clusters across both arms, sorted by frequency. */
  failureClusters: FailureCluster[];
  /** Per-arm failure label counts (for slice comparison). */
  baselineFailureLabels: Record<string, number>;
  candidateFailureLabels: Record<string, number>;
}

export class AttributionAnalyzer {
  static analyzeDiversion(paired: PairedTrial[]): Divergence {
    let firstDivergentTrial: number | null = null;
    let firstDivergenceDirection: Divergence["firstDivergenceDirection"] = null;
    let divergentTrials = 0;

    for (const p of paired) {
      if (p.baseline.passed !== p.candidate.passed) {
        divergentTrials++;
        if (firstDivergentTrial === null) {
          firstDivergentTrial = p.trial;
          firstDivergenceDirection = p.baseline.passed ? "candidate_only" : "baseline_only";
        }
      }
    }
    return { firstDivergentTrial, divergentTrials, firstDivergenceDirection };
  }

  static clusterFailures(paired: PairedTrial[]): {
    clusters: FailureCluster[];
    baselineLabels: Record<string, number>;
    candidateLabels: Record<string, number>;
  } {
    const clusters = new Map<FailureLabel, FailureCluster>();
    const baselineLabels: Record<string, number> = {};
    const candidateLabels: Record<string, number> = {};

    for (const [label, description] of Object.entries(FAILURE_TAXONOMY)) {
      clusters.set(label as FailureLabel, { label: label as FailureLabel, description, count: 0, trials: [] });
    }

    for (const p of paired) {
      for (const label of classifyFailure(p.baseline)) {
        baselineLabels[label] = (baselineLabels[label] || 0) + 1;
        const c = clusters.get(label)!;
        c.count++;
        if (!c.trials.includes(p.trial)) c.trials.push(p.trial);
      }
      for (const label of classifyFailure(p.candidate)) {
        candidateLabels[label] = (candidateLabels[label] || 0) + 1;
        const c = clusters.get(label)!;
        c.count++;
        if (!c.trials.includes(p.trial)) c.trials.push(p.trial);
      }
    }

    return {
      clusters: [...clusters.values()].filter((c) => c.count > 0).sort((a, b) => b.count - a.count),
      baselineLabels,
      candidateLabels,
    };
  }

  static analyze(paired: PairedTrial[]): AttributionReport {
    const { clusters, baselineLabels, candidateLabels } = this.clusterFailures(paired);
    return {
      divergence: this.analyzeDiversion(paired),
      failureClusters: clusters,
      baselineFailureLabels: baselineLabels,
      candidateFailureLabels: candidateLabels,
    };
  }
}
