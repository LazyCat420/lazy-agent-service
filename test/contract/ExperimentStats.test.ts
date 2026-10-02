import { describe, it, expect } from "vitest";
import { requiredTrialsFor, bootstrapCI } from "../../src/services/ExperimentService.ts";

describe("requiredTrialsFor", () => {
	it("returns smaller trials for larger MDEs", () => {
		expect(requiredTrialsFor(0.20)).toBeLessThan(requiredTrialsFor(0.10));
		expect(requiredTrialsFor(0.10)).toBeLessThan(requiredTrialsFor(0.05));
	});

	it("matches the pinned table values (80% power, α=0.05)", () => {
		expect(requiredTrialsFor(0.20)).toBe(20);
		expect(requiredTrialsFor(0.10)).toBe(80);
		expect(requiredTrialsFor(0.05)).toBe(310);
	});

	it("clamps tiny MDEs to the largest table entry", () => {
		expect(requiredTrialsFor(0.001)).toBe(requiredTrialsFor(0.02));
	});
});

describe("bootstrapCI", () => {
	it("is deterministic for the same input", () => {
		const b = Array.from({ length: 30 }, (_, i) => i % 2 === 0);
		const c = Array.from({ length: 30 }, (_, i) => i % 3 !== 0);
		const a = bootstrapCI(b, c);
		const b2 = bootstrapCI(b, c);
		expect(a).toEqual(b2);
	});

	it("excludes zero for a large consistent delta", () => {
		// Baseline always fails, candidate always passes → delta 1.0, CI way above 0.
		const b = Array.from({ length: 40 }, () => false);
		const c = Array.from({ length: 40 }, () => true);
		const { lower } = bootstrapCI(b, c);
		expect(lower).toBeGreaterThan(0);
	});

	it("includes zero when both arms are identical", () => {
		const b = Array.from({ length: 40 }, (_, i) => i % 2 === 0);
		const c = Array.from({ length: 40 }, (_, i) => i % 2 === 0);
		const { lower, upper } = bootstrapCI(b, c);
		expect(lower).toBeLessThanOrEqual(0);
		expect(upper).toBeGreaterThanOrEqual(0);
	});
});
