import logger from "../../../utils/logger.js";
/**
 * KVCacheReporter — per-iteration KV cache hit rate diagnostics.
 *
 * Logs the breakdown of input tokens vs cached (KV cache hit) tokens
 * after each LLM call, enabling operators to diagnose whether the
 * append-only prefix property is being preserved across iterations.
 *
 * A high cache hit rate (>80%) indicates the provider is reusing
 * the KV cache from previous iterations. A low rate suggests prefix
 * mutation (e.g., unconditional micro-compaction) is invalidating
 * the cache and forcing expensive full re-prefills.
 *
 * Extracted from ReActHarness (lines 376–389) for cross-harness reuse.
 */
/**
 * Log KV cache hit rate for the current iteration.
 *
 * Only emits a log line when there is meaningful cache data to report
 * (iteration > 1 or cached tokens > 0), avoiding noise on first pass.
 */
export function logKVCacheHitRate(passUsage, iteration, harnessLabel) {
    const finalInputTokens = passUsage.inputTokens || passUsage.promptTokens || 0;
    const cachedInputTokens = passUsage.cacheReadInputTokens || 0;
    const totalPromptTokens = finalInputTokens + cachedInputTokens;
    if (iteration > 1 || cachedInputTokens > 0) {
        const cacheHitPercentage = totalPromptTokens > 0
            ? ((cachedInputTokens / totalPromptTokens) * 100).toFixed(1)
            : "0.0";
        logger.info(`[${harnessLabel}] Iteration ${iteration} KV cache: ` +
            `input=${finalInputTokens}, cached=${cachedInputTokens}, ` +
            `total=${totalPromptTokens}, hit=${cacheHitPercentage}%`);
    }
}
//# sourceMappingURL=KVCacheReporter.js.map