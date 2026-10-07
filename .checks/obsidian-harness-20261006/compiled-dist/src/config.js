// ─── Configuration & Reference Catalog ──────────────────────
import { PROVIDERS, PROVIDER_LIST, TYPES, MODEL_TYPES } from "./constants.js";
// ─── UNIFIED MODEL CATALOG ──────────────────────────────────
// Every model lives here with all its metadata.
// Helper functions below derive defaults, options, and pricing.
import { MODELS } from "./config/models.js";
import { VOICES, DEFAULT_VOICES } from "./config/voices.js";
// ─── derive defaults, options, pricing from MODELS ──────────
/**
 * Get all models whose inputTypes includes `inputType`
 * and whose outputTypes includes `outputType`.
 */
function getModels(inputType, outputType) {
    return Object.values(MODELS).filter((model) => {
        const modelRecord = model;
        return (modelRecord.inputTypes?.includes(inputType) &&
            modelRecord.outputTypes?.includes(outputType));
    });
}
/**
 * Get listed model options grouped by provider
 * for a given input→output type combination.
 * Returns: { [provider]: [{ name, label, ... }, ...] }
 */
function getModelOptions(inputType, outputType) {
    const optionsMap = {};
    for (const model of getModels(inputType, outputType)) {
        const modelRecord = model;
        if (modelRecord.listed !== false) {
            const entry = { name: model.name, label: model.label };
            if (modelRecord.description)
                entry.description = modelRecord.description;
            if (modelRecord.thinking)
                entry.thinking = true;
            if (model.inputTypes?.includes(TYPES.IMAGE))
                entry.vision = true;
            if (modelRecord.webSearch)
                entry.webSearch = modelRecord.webSearch;
            if (model.inputTypes)
                entry.inputTypes = model.inputTypes;
            if (model.outputTypes)
                entry.outputTypes = model.outputTypes;
            if (modelRecord.tools)
                entry.tools = modelRecord.tools;
            if (modelRecord.pricing)
                entry.pricing = modelRecord.pricing;
            if (modelRecord.arena)
                entry.arena = modelRecord.arena;
            if (modelRecord.maxInputTokens)
                entry.contextLength = modelRecord.maxInputTokens;
            if (modelRecord.maxOutputTokens)
                entry.maxOutputTokens = modelRecord.maxOutputTokens;
            if (modelRecord.assistantImages === false)
                entry.assistantImages = false;
            // JSON mode: OpenAI + Google support response_format / responseMimeType
            if (model.modelType === MODEL_TYPES.CONVERSATION &&
                (model.provider === PROVIDERS.OPENAI || model.provider === PROVIDERS.GOOGLE)) {
                entry.jsonMode = true;
            }
            if (modelRecord.codeExecution)
                entry.codeExecution = true;
            if (modelRecord.webFetch)
                entry.webFetch = true;
            if (modelRecord.urlContext)
                entry.urlContext = true;
            if (modelRecord.defaultTemperature !== undefined)
                entry.defaultTemperature = modelRecord.defaultTemperature;
            if (modelRecord.verbosity)
                entry.verbosity = true;
            if (modelRecord.reasoningSummary)
                entry.reasoningSummary = true;
            if (modelRecord.responsesAPI)
                entry.responsesAPI = true;
            if (modelRecord.size)
                entry.size = modelRecord.size;
            if (model.modelType)
                entry.modelType = model.modelType;
            if (modelRecord.liveAPI)
                entry.liveAPI = true;
            if (modelRecord.thinkingLevels)
                entry.thinkingLevels = modelRecord.thinkingLevels;
            if (modelRecord.mediaLimits)
                entry.mediaLimits = modelRecord.mediaLimits;
            if (modelRecord.year)
                entry.year = modelRecord.year;
            if (modelRecord.lockedSampling)
                entry.lockedSampling = true;
            if (modelRecord.adaptiveThinking)
                entry.adaptiveThinking = true;
            // System prompt support: true for chat models, false for image-only/TTS/embedding APIs
            entry.supportsSystemPrompt =
                modelRecord.supportsSystemPrompt !== undefined
                    ? modelRecord.supportsSystemPrompt
                    : model.outputTypes.includes(TYPES.TEXT);
            (optionsMap[model.provider] ??= []).push(entry);
        }
    }
    return optionsMap;
}
/**
 * Get the default model name per provider
 * for a given input→output type combination.
 * Returns: { [provider]: modelName }
 */
function getDefaultModels(inputType, outputType) {
    const defaults = {};
    for (const model of getModels(inputType, outputType)) {
        const modelRecord = model;
        if (modelRecord.default) {
            defaults[model.provider] = model.name;
        }
    }
    return defaults;
}
/**
 * Get pricing map for a given input→output type combination.
 * Returns: { [modelName]: pricingObject }
 */
function getPricing(inputType, outputType) {
    const pricing = {};
    for (const model of getModels(inputType, outputType)) {
        const modelRecord = model;
        if (modelRecord.pricing) {
            pricing[model.name] = modelRecord.pricing;
        }
    }
    return pricing;
}
/**
 * Find a single model object by its API name.
 * Returns the model object or null.
 */
function getModelByName(name) {
    return (Object.values(MODELS).find((model) => model.name === name) ?? null);
}
/**
 * Resolve the recommended default model for a given input→output type
 * and set of available providers.
 *
 * Priority ladder (cost-optimized):
 *   1. Gemini 3.5 Flash  (google)    — cheapest high-quality model
 *   2. Gemini 3 Flash    (google)    — fallback if 3.5 unavailable
 *   3. Haiku             (anthropic) — fast and cheap
 *   4. GPT 5.4 Mini/Nano (openai)    — mini/nano tier
 *   5. GPT 5 Mini/Nano   (openai)    — legacy mini/nano
 *   6. Any provider's per-provider default (the `default: true` flag)
 *
 * When fcOnly is true, only models with "Tool Calling" in their tools
 * array are considered (for agentic contexts).
 *
 * Returns { provider, model, temperature } or null if nothing matches.
 */
function resolveRecommendedDefault(inputType, outputType, availableProviders, functionCallOnly = false) {
    const modelOptions = getModelOptions(inputType, outputType);
    const isEligible = (model) => {
        if (!functionCallOnly)
            return true;
        return (model.tools || []).includes("Tool Calling");
    };
    const tryProvider = (providerName, candidateNames) => {
        if (!availableProviders.has(providerName))
            return null;
        const providerModels = modelOptions[providerName] || [];
        for (const candidateName of candidateNames) {
            const match = providerModels.find((model) => model.name === candidateName && isEligible(model));
            if (match) {
                return {
                    provider: providerName,
                    model: match.name,
                    temperature: match.defaultTemperature ?? 1.0,
                };
            }
        }
        // Provider available but no named candidate — try any eligible model
        const anyEligible = providerModels.find(isEligible);
        if (anyEligible) {
            return {
                provider: providerName,
                model: anyEligible.name,
                temperature: anyEligible.defaultTemperature ?? 1.0,
            };
        }
        return null;
    };
    // Priority 1–2: Google (Gemini Flash variants)
    const googleResult = tryProvider("google", [
        MODELS.GEMINI_35_FLASH.name,
        MODELS.GEMINI_3_FLASH.name,
    ]);
    if (googleResult)
        return googleResult;
    // Priority 3: Anthropic (Haiku)
    if (availableProviders.has("anthropic")) {
        const anthropicModels = modelOptions["anthropic"] || [];
        const haikuMatch = anthropicModels.find((model) => model.name.toLowerCase().includes("haiku") && isEligible(model));
        if (haikuMatch) {
            return {
                provider: "anthropic",
                model: haikuMatch.name,
                temperature: haikuMatch.defaultTemperature ?? 1.0,
            };
        }
        const anyAnthropic = anthropicModels.find(isEligible);
        if (anyAnthropic) {
            return {
                provider: "anthropic",
                model: anyAnthropic.name,
                temperature: anyAnthropic.defaultTemperature ?? 1.0,
            };
        }
    }
    // Priority 4–5: OpenAI (Mini/Nano variants)
    const openaiResult = tryProvider("openai", [
        MODELS.GPT_54_MINI.name,
        MODELS.GPT_5_MINI.name,
        MODELS.GPT_54_NANO.name,
        MODELS.GPT_5_NANO.name,
    ]);
    if (openaiResult)
        return openaiResult;
    // Priority 6: Absolute fallback — any available provider with an eligible model
    for (const providerName of availableProviders) {
        const providerModels = modelOptions[providerName] || [];
        const firstEligible = providerModels.find(isEligible);
        if (firstEligible) {
            return {
                provider: providerName,
                model: firstEligible.name,
                temperature: firstEligible.defaultTemperature ?? 1.0,
            };
        }
    }
    return null;
}
// ─── VOICES (per provider — applies to TEXT → AUDIO models) ─
// ─── Parameter Registry ─────────────────────────────────────
import { getParameterDescriptors, getAgentDefaults, } from "./services/ParameterRegistry.js";
// ─── EXPORTS ────────────────────────────────────────────────
export { 
// Providers
PROVIDERS, PROVIDER_LIST, 
// Types
TYPES, MODEL_TYPES, 
// Models
MODELS, 
// Helpers
getModels, getModelOptions, getDefaultModels, getPricing, getModelByName, resolveRecommendedDefault, 
// Voices
VOICES, DEFAULT_VOICES, 
// Parameter Registry
getParameterDescriptors, getAgentDefaults, };
//# sourceMappingURL=config.js.map