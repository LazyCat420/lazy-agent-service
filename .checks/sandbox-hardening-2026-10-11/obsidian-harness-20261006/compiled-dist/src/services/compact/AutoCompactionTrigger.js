import logger from "../../utils/logger.js";
// ────────────────────────────────────────────────────────────
// AutoCompactionTrigger — Threshold-Based Auto-Compact
// ────────────────────────────────────────────────────────────
// Modeled after claude-code/src/services/compact/autoCompact.ts
//
// Determines when to automatically trigger LLM-powered compaction
// based on current token usage vs. the model's context window.
//
// Claude Code constants (from autoCompact.ts):
//   AUTOCOMPACT_BUFFER_TOKENS = 13_000
//   MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
//   WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
//   ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
//   MANUAL_COMPACT_BUFFER_TOKENS = 3_000
//   MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
//
// Claude Code threshold calculation:
//   effectiveWindow = contextWindow - min(maxOutputTokens, 20_000)
//   autoCompactThreshold = effectiveWindow - 13_000
// ────────────────────────────────────────────────────────────
/** Buffer tokens reserved for the compaction summary output. */
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
/**
 * Buffer between the effective context window and the auto-compact trigger.
 * Matches Claude Code's AUTOCOMPACT_BUFFER_TOKENS constant.
 */
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
/** Minimum messages required before auto-compaction can trigger. */
const MINIMUM_MESSAGES_FOR_COMPACTION = 6;
export default class AutoCompactionTrigger {
    /**
     * Calculate the effective context window size minus output reserve.
     *
     * Claude Code equivalent: getEffectiveContextWindowSize() in autoCompact.ts
     */
    static getEffectiveContextWindowSize(contextWindowSize, maxOutputTokens) {
        const reservedForSummary = Math.min(maxOutputTokens, MAX_OUTPUT_TOKENS_FOR_SUMMARY);
        return contextWindowSize - reservedForSummary;
    }
    /**
     * Get the auto-compact threshold — the token count at which
     * compaction should be triggered.
     *
     * Claude Code equivalent: getAutoCompactThreshold() in autoCompact.ts
     */
    static getAutoCompactThreshold(contextWindowSize, maxOutputTokens) {
        const effectiveWindow = this.getEffectiveContextWindowSize(contextWindowSize, maxOutputTokens);
        return effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS;
    }
    /**
     * Check whether auto-compaction should trigger for the current token usage.
     *
     * Returns a result object with the threshold, usage percentage, and decision.
     */
    static evaluate(estimatedTokens, contextWindowSize, maxOutputTokens, messageCount) {
        const effectiveContextWindow = this.getEffectiveContextWindowSize(contextWindowSize, maxOutputTokens);
        const threshold = this.getAutoCompactThreshold(contextWindowSize, maxOutputTokens);
        const percentUsed = effectiveContextWindow > 0
            ? Math.round((estimatedTokens / effectiveContextWindow) * 100)
            : 0;
        const shouldCompact = estimatedTokens >= threshold &&
            messageCount >= MINIMUM_MESSAGES_FOR_COMPACTION;
        if (shouldCompact) {
            logger.info(`[AutoCompaction] Threshold exceeded: ${estimatedTokens} tokens >= ${threshold} threshold ` +
                `(${percentUsed}% of ${effectiveContextWindow} effective window, ${messageCount} messages)`);
        }
        return {
            threshold,
            effectiveContextWindow,
            percentUsed,
            shouldCompact,
        };
    }
}
//# sourceMappingURL=AutoCompactionTrigger.js.map