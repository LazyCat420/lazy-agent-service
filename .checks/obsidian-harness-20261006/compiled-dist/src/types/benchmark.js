/**
 * Benchmark Type Definitions
 *
 * Shared interfaces for BenchmarkService accuracy testing.
 */
// ── Match Modes ─────────────────────────────────────────────
export const MATCH_MODES = {
    CONTAINS: "contains",
    EXACT: "exact",
    STARTS_WITH: "startsWith",
    REGEX: "regex",
};
export const COMPARATORS = {
    gte: (agent, b) => agent >= b,
    lte: (agent, b) => agent <= b,
    gt: (agent, b) => agent > b,
    lt: (agent, b) => agent < b,
    eq: (agent, b) => agent === b,
};
//# sourceMappingURL=benchmark.js.map