/**
 * RateLimitStore — In-memory cache of latest provider rate-limit data.
 *
 * Updated dynamically from each OpenAI/Anthropic API response.
 * Rate limits are per-model (both OpenAI and Anthropic enforce limits
 * separately for each model). Google uses static tier limits.
 *
 * Call `.update(providerName, model, rateLimits)` after every API response.
 * Call `.getAll()` to get a snapshot of all providers/models.
 */
import { MODELS } from "../config.js";
// Static Google Tier 2 limits — seeded on module load since Google
// doesn't expose rate-limit headers in their SDK responses.
const GOOGLE_STATIC_LIMITS = {
    note: "Static tier-2 limits from Google AI Studio. Not dynamically updated.",
    models: {
        [MODELS.GEMINI_35_FLASH.name]: {
            rpm: 2000,
            tpm: 4_000_000,
            rpd: 100_000,
        },
        [MODELS.GEMINI_3_FLASH.name]: {
            rpm: 2000,
            tpm: 3_000_000,
            rpd: 100_000,
        },
        [MODELS.GEMINI_31_PRO.name]: {
            rpm: 1000,
            tpm: 5_000_000,
            rpd: 50_000,
        },
        // Legacy models — not in the active MODELS catalog
        "gemini-2.5-flash": {
            rpm: 2000,
            tpm: 3_000_000,
            rpd: 100_000,
        },
        "gemini-2.5-pro": {
            rpm: 1000,
            tpm: 5_000_000,
            rpd: 50_000,
        },
        "gemini-2-flash": {
            rpm: 10_000,
            tpm: 10_000_000,
            rpd: null,
        },
    },
};
class RateLimitStore {
    _models;
    _google;
    constructor() {
        /**
         * Per-model rate limits for dynamic providers.
         * Key: `${provider}::${model}` → { rateLimits, updatedAt }
         */
        this._models = new Map();
        /** Static Google limits (separate shape — not per-response). */
        this._google = GOOGLE_STATIC_LIMITS;
    }
    /**
     * Update the stored rate-limit snapshot for a provider + model.
     * Called after every API response that contains rate-limit headers.
     */
    update(providerName, model, rateLimits) {
        if (!rateLimits || !providerName || !model)
            return;
        const key = `${providerName}::${model}`;
        this._models.set(key, {
            rateLimits,
            updatedAt: new Date().toISOString(),
        });
    }
    /**
     * Get a snapshot of all provider rate limits, grouped by provider.
     *
     * Returns:
     * {
     *   openai: { dynamic: true, models: { "gpt-5": { rateLimits, updatedAt }, ... } },
     *   anthropic: { dynamic: true, models: { "claude-opus-4": { ... }, ... } },
     *   google: { dynamic: false, note: "...", models: { "gemini-3-flash": { rpm, tpm, rpd }, ... } },
     * }
     */
    getAll() {
        const result = {};
        // Group dynamic models by provider
        for (const [key, value] of this._models) {
            const [provider, model] = key.split("::");
            if (!result[provider]) {
                result[provider] = { dynamic: true, models: {} };
            }
            result[provider].models[model] = value;
        }
        // Add Google static limits
        result.google = {
            dynamic: false,
            note: this._google.note,
            models: this._google.models,
        };
        return result;
    }
}
// Singleton
const rateLimitStore = new RateLimitStore();
export default rateLimitStore;
//# sourceMappingURL=RateLimitStore.js.map