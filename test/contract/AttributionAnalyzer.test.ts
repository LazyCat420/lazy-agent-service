import { describe, it, expect } from "vitest";
import { AttributionAnalyzer, classifyFailure, type PairedTrial, type TrialResult } from "../../src/services/AttributionAnalyzer.ts";

const trial = (over: Partial<TrialResult> = {}): TrialResult => ({
  passed: false,
  latency: 100,
  usage: { total_tokens: 10 },
  error: null,
  response: "",
  ...over,
});

describe("classifyFailure", () => {
	it("labels provider errors by message", () => {
		const labels = classifyFailure(trial({ error: "Unknown provider \"vllm\"" }));
		expect(labels).toContain("provider_error");
	});

	it("labels tool errors", () => {
		const labels = classifyFailure(trial({ error: "Local tool execution failed" }));
		expect(labels).toContain("tool_error");
	});

	it("labels assertion failures for completed-but-wrong responses", () => {
		const labels = classifyFailure(trial({ passed: false, response: "some wrong text" }));
		expect(labels).toContain("assertion_failed");
	});

	it("labels empty responses", () => {
		const labels = classifyFailure(trial({ passed: false, response: "" }));
		expect(labels).toContain("empty_response");
	});

	it("never labels a passing trial", () => {
		const labels = classifyFailure(trial({ passed: true, response: "OK" }));
		expect(labels).toHaveLength(0);
	});
});

describe("AttributionAnalyzer.analyzeDiversion", () => {
	it("finds the first divergent trial index", () => {
		const paired: PairedTrial[] = [
			{ trial: 0, baseline: trial({ passed: true }), candidate: trial({ passed: true }) },
			{ trial: 1, baseline: trial({ passed: true }), candidate: trial({ passed: false }) },
			{ trial: 2, baseline: trial({ passed: true }), candidate: trial({ passed: true }) },
		];
		const d = AttributionAnalyzer.analyzeDiversion(paired);
		expect(d.firstDivergentTrial).toBe(1);
		expect(d.firstDivergenceDirection).toBe("candidate_only");
		expect(d.divergentTrials).toBe(1);
	});

	it("returns nulls when arms agree everywhere", () => {
		const paired: PairedTrial[] = [
			{ trial: 0, baseline: trial({ passed: true }), candidate: trial({ passed: true }) },
		];
		const d = AttributionAnalyzer.analyzeDiversion(paired);
		expect(d.firstDivergentTrial).toBeNull();
		expect(d.divergentTrials).toBe(0);
	});
});

describe("AttributionAnalyzer.clusterFailures", () => {
	it("counts clusters per label and per arm", () => {
		const paired: PairedTrial[] = [
			{ trial: 0, baseline: trial({ passed: false, error: "OPENAI_API_KEY is not set" }), candidate: trial({ passed: true }) },
			{ trial: 1, baseline: trial({ passed: false, error: "Local tool execution failed" }), candidate: trial({ passed: true }) },
			{ trial: 2, baseline: trial({ passed: false, error: "OPENAI_API_KEY is not set" }), candidate: trial({ passed: false, error: "Unknown provider x" }) },
		];
		const { clusters, baselineLabels, candidateLabels } = AttributionAnalyzer.clusterFailures(paired);
		expect(baselineLabels["provider_error"]).toBe(2);
		expect(baselineLabels["tool_error"]).toBe(1);
		expect(candidateLabels["provider_error"]).toBe(1);
		const providerCluster = clusters.find((c) => c.label === "provider_error");
		expect(providerCluster?.count).toBe(3); // 2 baseline + 1 candidate
		expect(providerCluster?.trials).toEqual([0, 2]);
	});
});

describe("AttributionAnalyzer.analyze (full report)", () => {
	it("produces divergence + clusters in one call", () => {
		const paired: PairedTrial[] = [
			{ trial: 0, baseline: trial({ passed: true }), candidate: trial({ passed: true }) },
			{ trial: 1, baseline: trial({ passed: false, response: "wrong" }), candidate: trial({ passed: true }) },
		];
		const report = AttributionAnalyzer.analyze(paired);
		expect(report.divergence.firstDivergentTrial).toBe(1);
		expect(report.failureClusters.find((c) => c.label === "assertion_failed")).toBeDefined();
	});
});
