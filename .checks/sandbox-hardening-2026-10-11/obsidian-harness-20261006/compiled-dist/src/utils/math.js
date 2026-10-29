/** Cap — anything above this is a measurement artifact */
const MAX_TOKENS_PER_SEC = 10_000;
/**
 * Calculate tokens-per-second throughput (tok/s).
 *
 * Centralised formula used by every request logger in the codebase.
 * Pass a provider-reported value in `opts.providerReported` to prefer
 * it over manual computation, and `opts.fallbackSec` to use totalSec
 * when generationSec is unavailable.
 */
export function calculateTokensPerSec(tokens, sec, opts = {}) {
    // 1. Provider-reported value takes priority
    if (opts.providerReported != null && opts.providerReported > 0) {
        const value = parseFloat(opts.providerReported.toFixed(1));
        return value > MAX_TOKENS_PER_SEC ? null : value;
    }
    // 2. Determine effective duration
    const effectiveSec = sec && sec > 0.001
        ? sec
        : opts.fallbackSec && opts.fallbackSec > 0
            ? opts.fallbackSec
            : null;
    if (!effectiveSec || !tokens || tokens <= 0)
        return null;
    const value = parseFloat((tokens / effectiveSec).toFixed(1));
    return value > MAX_TOKENS_PER_SEC ? null : value;
}
//# sourceMappingURL=math.js.map