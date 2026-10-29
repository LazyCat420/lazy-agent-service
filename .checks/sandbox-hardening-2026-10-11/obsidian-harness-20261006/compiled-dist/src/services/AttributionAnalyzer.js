export const FAILURE_TAXONOMY = {
    // Observation layer
    tool_error: "The trial errored inside a tool call (error mentions tool)",
    provider_error: "The provider/model call itself failed (auth, unknown provider, timeout)",
    // Verification layer
    assertion_failed: "The response completed but failed the benchmark's assertions",
    empty_response: "The response was null or empty — harness produced nothing",
    // Everything else
    unclassified: "Failure that matches no known label",
};
export function classifyFailure(trial) {
    const labels = [];
    const error = (trial.error || "").toLowerCase();
    const response = trial.response ?? "";
    if (!response.trim() && !trial.passed)
        labels.push("empty_response");
    if (/tool|local tool execution/.test(error))
        labels.push("tool_error");
    if (/provider|api[_ ]key|unknown provider|timeout|unauthorized|quota/.test(error))
        labels.push("provider_error");
    if (trial.passed === false && response.trim() && !labels.includes("tool_error") && !labels.includes("provider_error")) {
        labels.push("assertion_failed");
    }
    if (labels.length === 0 && !trial.passed)
        labels.push("unclassified");
    return labels;
}
export class AttributionAnalyzer {
    static analyzeDiversion(paired) {
        let firstDivergentTrial = null;
        let firstDivergenceDirection = null;
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
    static clusterFailures(paired) {
        const clusters = new Map();
        const baselineLabels = {};
        const candidateLabels = {};
        for (const [label, description] of Object.entries(FAILURE_TAXONOMY)) {
            clusters.set(label, { label: label, description, count: 0, trials: [] });
        }
        for (const p of paired) {
            for (const label of classifyFailure(p.baseline)) {
                baselineLabels[label] = (baselineLabels[label] || 0) + 1;
                const c = clusters.get(label);
                c.count++;
                if (!c.trials.includes(p.trial))
                    c.trials.push(p.trial);
            }
            for (const label of classifyFailure(p.candidate)) {
                candidateLabels[label] = (candidateLabels[label] || 0) + 1;
                const c = clusters.get(label);
                c.count++;
                if (!c.trials.includes(p.trial))
                    c.trials.push(p.trial);
            }
        }
        return {
            clusters: [...clusters.values()].filter((c) => c.count > 0).sort((a, b) => b.count - a.count),
            baselineLabels,
            candidateLabels,
        };
    }
    static analyze(paired) {
        const { clusters, baselineLabels, candidateLabels } = this.clusterFailures(paired);
        return {
            divergence: this.analyzeDiversion(paired),
            failureClusters: clusters,
            baselineFailureLabels: baselineLabels,
            candidateFailureLabels: candidateLabels,
        };
    }
}
//# sourceMappingURL=AttributionAnalyzer.js.map