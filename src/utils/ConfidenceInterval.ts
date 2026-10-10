/**
 * Confidence-interval statistics for benchmark reporting (item 9 of the
 * 2026-10-10 improvement list). Deliberately dependency-free: a normal
 * approximation over n>=30 samples is the right precision/cost trade for
 * wall-clock microbenchmarks; for n<30 use a t-critical value via `zOverride`.
 */
export interface CIResult {
  n: number;
  mean: number;
  /** 95% confidence interval half-width. */
  halfWidth: number;
  lo: number;
  hi: number;
  stddev: number;
}

/**
 * Mean and 95% CI of `samples`. Throws on empty input and on non-finite
 * values (a NaN timing means the benchmark itself is broken — never report it).
 */
export function meanWithCI(samples: number[], zOverride?: number): CIResult {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("meanWithCI: need at least one sample");
  }
  for (const s of samples) {
    if (!Number.isFinite(s)) throw new Error(`meanWithCI: non-finite sample ${s}`);
  }
  const n = samples.length;
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance = n === 1 ? 0 : samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const stddev = Math.sqrt(variance);
  // 1.96 = normal z for 95%; below n=30 the normal approx under-covers — pass a
  // t-critical value (e.g. 2.776 for n=5, 2.262 for n=10).
  const z = zOverride ?? 1.96;
  const halfWidth = (z * stddev) / Math.sqrt(n);
  return { n, mean, halfWidth, lo: mean - halfWidth, hi: mean + halfWidth, stddev };
}
