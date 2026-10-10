import { describe, expect, it } from "vitest";
import { meanWithCI } from "../ConfidenceInterval.ts";

describe("meanWithCI", () => {
  it("computes exact mean and half-width for a known sample", () => {
    // [8,10,12]: mean 10, sample stddev 2, n=3 → halfWidth = 1.96 * 2 / √3
    const r = meanWithCI([8, 10, 12]);
    expect(r.n).toBe(3);
    expect(r.mean).toBeCloseTo(10, 10);
    expect(r.halfWidth).toBeCloseTo((1.96 * 2) / Math.sqrt(3), 10);
    expect(r.lo).toBeCloseTo(10 - (1.96 * 2) / Math.sqrt(3), 10);
    expect(r.hi).toBeCloseTo(10 + (1.96 * 2) / Math.sqrt(3), 10);
  });

  it("widens the interval for small n with an explicit t-critical", () => {
    const samples = [10, 12, 8, 10, 14];
    const normal = meanWithCI(samples);
    const t = meanWithCI(samples, 2.776); // df=4
    expect(t.halfWidth).toBeGreaterThan(normal.halfWidth);
  });

  it("rejects empty and non-finite input", () => {
    expect(() => meanWithCI([])).toThrow();
    expect(() => meanWithCI([1, Number.NaN])).toThrow();
    expect(() => meanWithCI([1, Number.POSITIVE_INFINITY])).toThrow();
  });

  it("single sample yields zero-width interval", () => {
    const r = meanWithCI([42]);
    expect(r.mean).toBe(42);
    expect(r.halfWidth).toBe(0);
  });
});
