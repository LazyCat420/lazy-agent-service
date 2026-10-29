import ConversationGenerationTracker from "../../ConversationGenerationTracker.js";
/**
 * TrackerFinalizer — per-pass ConversationGenerationTracker finalization.
 *
 * After each LLM stream completes, the harness must:
 *   1. Report output token count to the tracker
 *   2. Report input token count (with promptTokens fallback)
 *   3. Mark the request as complete
 *
 * This ~15-line block was duplicated identically across ReActHarness,
 * VisionLanguageHarness, and TreeOfThoughtsStrategy.
 *
 * Returns `finalInputTokens` so callers can pass it to KVCacheReporter.
 */
/**
 * Finalize the ConversationGenerationTracker for a completed pass.
 *
 * Updates token counts and marks the request as complete.
 * Returns the resolved input token count for downstream diagnostics.
 */
export function finalizePassTracker(pass, passRequestId) {
    if (pass.usage.outputTokens > 0 || pass.usage.tokensPerSec) {
        ConversationGenerationTracker.update(passRequestId, {
            ...(pass.usage.outputTokens > 0 && {
                outputTokens: pass.usage.outputTokens,
            }),
            ...(pass.usage.tokensPerSec != null && pass.usage.tokensPerSec > 0 && {
                providerTokPerSec: pass.usage.tokensPerSec,
            }),
        });
    }
    const finalInputTokens = pass.usage.inputTokens || pass.usage.promptTokens || 0;
    if (finalInputTokens > 0) {
        ConversationGenerationTracker.update(passRequestId, {
            inputTokens: finalInputTokens,
        });
    }
    ConversationGenerationTracker.complete(passRequestId);
    return { finalInputTokens };
}
//# sourceMappingURL=TrackerFinalizer.js.map