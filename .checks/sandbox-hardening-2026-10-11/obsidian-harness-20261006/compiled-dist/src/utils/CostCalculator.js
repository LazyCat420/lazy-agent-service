/**
 * CostCalculator — token estimation and cost calculation utilities.
 *
 * Centralises pricing logic across all provider types:
 * text-to-text, audio-to-text, live API sessions, and image generation.
 */
// ── Token estimation ────────────────────────────────────────
/**
 * Estimate token count from a text string using the ~4 chars/token heuristic.
 * Accurate enough for budget enforcement without requiring a real tokenizer.
 */
export function estimateTokens(text) {
    if (!text)
        return 0;
    return Math.ceil(text.length / 4);
}
/**
 * Get the total input token count from a usage object.
 * Providers like Anthropic and Google split prompt tokens into
 * new + cache_read + cache_write. This aggregates all three.
 */
export function getTotalInputTokens(usage) {
    if (!usage)
        return 0;
    return ((usage.inputTokens || 0) +
        (usage.cacheReadInputTokens || 0) +
        (usage.cacheCreationInputTokens || 0));
}
export function createUsageAccumulator() {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
        tokensPerSec: 0,
    };
}
/**
 * Merge a provider-reported usage chunk into an accumulator (mutates target).
 * Centralises the `target.X += source.X || 0` pattern that was duplicated
 * across AgenticLoopService, chat.js, and StreamChunkDispatcher.
 */
export function mergeUsage(target, source) {
    if (!source)
        return target;
    target.inputTokens = (target.inputTokens ?? 0) + (source.inputTokens || 0);
    target.outputTokens = (target.outputTokens ?? 0) + (source.outputTokens || 0);
    target.cacheReadInputTokens =
        (target.cacheReadInputTokens ?? 0) + (source.cacheReadInputTokens || 0);
    target.cacheCreationInputTokens =
        (target.cacheCreationInputTokens ?? 0) +
            (source.cacheCreationInputTokens || 0);
    target.reasoningOutputTokens =
        (target.reasoningOutputTokens ?? 0) + (source.reasoningOutputTokens || 0);
    if (source.tokensPerSec != null) {
        target.tokensPerSec = source.tokensPerSec;
    }
    return target;
}
// ── Cost calculation ────────────────────────────────────────
/**
 * Calculate the estimated cost for a text-to-text request.
 * Supports Anthropic prompt caching: cache reads at reduced rate,
 * cache writes at premium rate.
 */
export function calculateTextCost(usage, pricing) {
    if (!pricing || !usage)
        return null;
    let cost = ((usage.inputTokens || 0) / 1_000_000) * (pricing.inputPerMillion || 0) +
        ((usage.outputTokens || 0) / 1_000_000) * (pricing.outputPerMillion || 0);
    // Cache read tokens (Anthropic: 0.1x base rate)
    if (usage.cacheReadInputTokens && pricing.cachedInputPerMillion) {
        cost +=
            (usage.cacheReadInputTokens / 1_000_000) * pricing.cachedInputPerMillion;
    }
    // Cache write tokens (Anthropic: 1.25x base rate)
    if (usage.cacheCreationInputTokens && pricing.cacheWriteInputPerMillion) {
        cost +=
            (usage.cacheCreationInputTokens / 1_000_000) *
                pricing.cacheWriteInputPerMillion;
    }
    return parseFloat(cost.toFixed(8));
}
/**
 * Calculate the estimated cost for an audio-to-text request.
 * Supports two strategies — per-minute pricing takes priority.
 */
export function calculateAudioCost(usage, pricing) {
    if (!pricing || !usage)
        return null;
    // Strategy 1: per-minute pricing
    if (pricing.perMinute && usage.durationSeconds != null) {
        const durationSeconds = Math.max(0, usage.durationSeconds);
        return parseFloat(((durationSeconds / 60) * pricing.perMinute).toFixed(8));
    }
    // Strategy 2: token-based pricing
    if (pricing.audioInputPerMillion && usage.inputTokens) {
        return parseFloat(((usage.inputTokens / 1_000_000) * pricing.audioInputPerMillion +
            ((usage.outputTokens || 0) / 1_000_000) *
                (pricing.outputPerMillion || 0)).toFixed(8));
    }
    return null;
}
/**
 * Calculate the estimated cost for a Live API session turn.
 * The Live API streams audio in and out, so input tokens should
 * use audioInputPerMillion and output tokens should use
 * audioOutputPerMillion when available.
 */
export function calculateLiveCost(usage, pricing) {
    if (!pricing || !usage)
        return null;
    const inputRate = pricing.audioInputPerMillion || pricing.inputPerMillion || 0;
    const outputRate = pricing.audioOutputPerMillion || pricing.outputPerMillion || 0;
    return parseFloat((((usage.inputTokens || 0) / 1_000_000) * inputRate +
        ((usage.outputTokens || 0) / 1_000_000) * outputRate).toFixed(8));
}
/**
 * Calculate the estimated cost for a text-to-image request.
 * Estimates input tokens from prompt length (~4 chars per token).
 * Output image tokens vary by provider and resolution:
 *   - Google 512px ≈ 747 tokens, 1024px ≈ 1120 tokens, 2048px ≈ 1680 tokens, 4096px ≈ 2520 tokens
 *   - OpenAI 1024×1024 high-quality ≈ 1056 tokens
 */
export function calculateImageCost(prompt, pricing, inputImages = 0, outputImageTokens = 1120) {
    if (!pricing || !prompt)
        return null;
    const estimatedInputTokens = estimateTokens(prompt);
    let cost = 0;
    // Input text cost
    if (pricing.inputPerMillion) {
        cost += (estimatedInputTokens / 1_000_000) * pricing.inputPerMillion;
    }
    // Input image cost (for edit requests)
    if (inputImages > 0 && pricing.imageInputPerMillion) {
        cost += ((inputImages * 258) / 1_000_000) * pricing.imageInputPerMillion;
    }
    // Output image cost
    if (pricing.imageOutputPerMillion) {
        cost += (outputImageTokens / 1_000_000) * pricing.imageOutputPerMillion;
    }
    else if (pricing.outputPerMillion) {
        cost += (outputImageTokens / 1_000_000) * pricing.outputPerMillion;
    }
    return cost > 0 ? parseFloat(cost.toFixed(8)) : null;
}
//# sourceMappingURL=CostCalculator.js.map