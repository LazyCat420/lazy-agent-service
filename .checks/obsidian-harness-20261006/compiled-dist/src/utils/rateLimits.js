/**
 * Rate Limit Header Extraction Utilities
 *
 * Extracts rate-limit metadata from provider HTTP response headers.
 * OpenAI and Anthropic expose these in standardized header formats.
 * Google does not expose rate-limit headers — static tier data is used instead.
 */
import rateLimitStore from "../services/RateLimitStore.js";
import { PROVIDERS } from "../constants.js";
export function extractOpenAIRateLimits(response, model) {
    if (!response?.headers)
        return null;
    const headers = response.headers;
    const limitRequests = headers.get("x-ratelimit-limit-requests");
    const limitTokens = headers.get("x-ratelimit-limit-tokens");
    // Only return if we actually got rate-limit headers
    if (!limitRequests && !limitTokens)
        return null;
    const result = {
        provider: PROVIDERS.OPENAI,
        requests: {
            limit: safeInt(limitRequests),
            remaining: safeInt(headers.get("x-ratelimit-remaining-requests")),
            reset: headers.get("x-ratelimit-reset-requests") || null,
        },
        tokens: {
            limit: safeInt(limitTokens),
            remaining: safeInt(headers.get("x-ratelimit-remaining-tokens")),
            reset: headers.get("x-ratelimit-reset-tokens") || null,
        },
    };
    // Update the global store with the latest per-model snapshot
    rateLimitStore.update(PROVIDERS.OPENAI, model, result);
    return result;
}
/**
 * Extract rate-limit headers from an Anthropic HTTP response.
 *
 * Headers:
 *   anthropic-ratelimit-requests-limit      → max RPM
 *   anthropic-ratelimit-tokens-limit        → max TPM
 *   anthropic-ratelimit-input-tokens-limit  → max input TPM
 *   anthropic-ratelimit-output-tokens-limit → max output TPM
 *   anthropic-ratelimit-requests-remaining  → remaining RPM
 *   anthropic-ratelimit-tokens-remaining    → remaining TPM
 *   anthropic-ratelimit-requests-reset      → RPM reset time
 *   anthropic-ratelimit-tokens-reset        → TPM reset time
 *   retry-after                             → seconds to wait if 429
 */
export function extractAnthropicRateLimits(response, model) {
    if (!response?.headers)
        return null;
    const headers = response.headers;
    const limitRequests = headers.get("anthropic-ratelimit-requests-limit");
    const limitTokens = headers.get("anthropic-ratelimit-tokens-limit");
    // Only return if we actually got rate-limit headers
    if (!limitRequests && !limitTokens)
        return null;
    const result = {
        provider: PROVIDERS.ANTHROPIC,
        requests: {
            limit: safeInt(limitRequests),
            remaining: safeInt(headers.get("anthropic-ratelimit-requests-remaining")),
            reset: headers.get("anthropic-ratelimit-requests-reset") || null,
        },
        tokens: {
            limit: safeInt(limitTokens),
            remaining: safeInt(headers.get("anthropic-ratelimit-tokens-remaining")),
            reset: headers.get("anthropic-ratelimit-tokens-reset") || null,
        },
        inputTokens: {
            limit: safeInt(headers.get("anthropic-ratelimit-input-tokens-limit")),
            remaining: safeInt(headers.get("anthropic-ratelimit-input-tokens-remaining")),
            reset: headers.get("anthropic-ratelimit-input-tokens-reset") || null,
        },
        outputTokens: {
            limit: safeInt(headers.get("anthropic-ratelimit-output-tokens-limit")),
            remaining: safeInt(headers.get("anthropic-ratelimit-output-tokens-remaining")),
            reset: headers.get("anthropic-ratelimit-output-tokens-reset") || null,
        },
    };
    // Update the global store with the latest per-model snapshot
    rateLimitStore.update(PROVIDERS.ANTHROPIC, model, result);
    return result;
}
function safeInt(value) {
    if (value == null)
        return null;
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
}
//# sourceMappingURL=rateLimits.js.map