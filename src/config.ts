// ─── Configuration & Reference Catalog ──────────────────────

import { PROVIDERS, PROVIDER_LIST, TYPES, MODEL_TYPES } from "./constants.ts";

// ─── UNIFIED MODEL CATALOG ──────────────────────────────────
// Every model lives here with all its metadata.
// Helper functions below derive defaults, options, and pricing.

import { MODELS } from "./config/models.ts";
import { OPENAI_VOICES, GOOGLE_VOICES, ELEVENLABS_VOICES, INWORLD_VOICES, VOICES, DEFAULT_VOICES } from "./config/voices.ts";

// ─── Model Type ─────────────────────────────────────────────

/** Shape of a single entry in the MODELS catalog. */
export type ModelDefinition = (typeof MODELS)[keyof typeof MODELS];

/** Client-facing model option entry returned by getModelOptions(). */
export interface ModelOptionEntry {
  description?: string;
  name: string;
  label: string;
  thinking?: boolean;
  vision?: boolean;
  webSearch?: boolean | string;
  inputTypes?: string[];
  outputTypes?: string[];
  tools?: string[];
  pricing?: Record<string, number>;
  arena?: Record<string, number>;
  contextLength?: number;
  maxOutputTokens?: number;
  assistantImages?: boolean;
  jsonMode?: boolean;
  codeExecution?: boolean;
  webFetch?: boolean;
  urlContext?: boolean;
  defaultTemperature?: number;
  verbosity?: boolean;
  reasoningSummary?: boolean;
  responsesAPI?: boolean;
  size?: string;
  modelType?: string;
  liveAPI?: boolean;
  thinkingLevels?: string[];
  mediaLimits?: Record<string, unknown>;
  year?: number;
  supportsSystemPrompt?: boolean;
  lockedSampling?: boolean;
  adaptiveThinking?: boolean;
}

// ─── derive defaults, options, pricing from MODELS ──────────

/**
 * Get all models whose inputTypes includes `inputType`
 * and whose outputTypes includes `outputType`.
 */
function getModels(inputType: string, outputType: string): ModelDefinition[] {
  return Object.values(MODELS).filter((model) => {
    const modelRecord = model as ModelDefinition & Record<string, unknown>;
    return (
      (modelRecord.inputTypes as string[])?.includes(inputType) &&
      (modelRecord.outputTypes as string[])?.includes(outputType)
    );
  });
}

/**
 * Get listed model options grouped by provider
 * for a given input→output type combination.
 * Returns: { [provider]: [{ name, label, ... }, ...] }
 */
function getModelOptions(
  inputType: string,
  outputType: string,
): Record<string, ModelOptionEntry[]> {
  const optionsMap: Record<string, ModelOptionEntry[]> = {};
  for (const model of getModels(inputType, outputType)) {
    const modelRecord = model as ModelDefinition & Record<string, unknown>;
    if (modelRecord.listed !== false) {
      const entry: ModelOptionEntry = { name: model.name, label: model.label };
      if (modelRecord.description)
        entry.description = modelRecord.description as string;
      if (modelRecord.thinking) entry.thinking = true;
      if (model.inputTypes?.includes(TYPES.IMAGE)) entry.vision = true;
      if (modelRecord.webSearch)
        entry.webSearch = modelRecord.webSearch as boolean | string;
      if (model.inputTypes) entry.inputTypes = model.inputTypes;
      if (model.outputTypes) entry.outputTypes = model.outputTypes;
      if (modelRecord.tools) entry.tools = modelRecord.tools as string[];
      if (modelRecord.pricing)
        entry.pricing = modelRecord.pricing as Record<string, number>;
      if (modelRecord.arena)
        entry.arena = modelRecord.arena as Record<string, number>;
      if (modelRecord.maxInputTokens)
        entry.contextLength = modelRecord.maxInputTokens as number;
      if (modelRecord.maxOutputTokens)
        entry.maxOutputTokens = modelRecord.maxOutputTokens as number;
      if (modelRecord.assistantImages === false) entry.assistantImages = false;
      // JSON mode: OpenAI + Google support response_format / responseMimeType
      if (
        model.modelType === MODEL_TYPES.CONVERSATION &&
        (model.provider === PROVIDERS.OPENAI || model.provider === PROVIDERS.GOOGLE)
      ) {
        entry.jsonMode = true;
      }
      if (modelRecord.codeExecution) entry.codeExecution = true;
      if (modelRecord.webFetch) entry.webFetch = true;
      if (modelRecord.urlContext) entry.urlContext = true;
      if (modelRecord.defaultTemperature !== undefined)
        entry.defaultTemperature = modelRecord.defaultTemperature as number;
      if (modelRecord.verbosity) entry.verbosity = true;
      if (modelRecord.reasoningSummary) entry.reasoningSummary = true;
      if (modelRecord.responsesAPI) entry.responsesAPI = true;
      if (modelRecord.size) entry.size = modelRecord.size as string;
      if (model.modelType) entry.modelType = model.modelType;
      if (modelRecord.liveAPI) entry.liveAPI = true;
      if (modelRecord.thinkingLevels)
        entry.thinkingLevels = modelRecord.thinkingLevels as string[];
      if (modelRecord.mediaLimits)
        entry.mediaLimits = modelRecord.mediaLimits as Record<string, unknown>;
      if (modelRecord.year) entry.year = modelRecord.year as number;
      if (modelRecord.lockedSampling) entry.lockedSampling = true;
      if (modelRecord.adaptiveThinking) entry.adaptiveThinking = true;
      // System prompt support: true for chat models, false for image-only/TTS/embedding APIs
      entry.supportsSystemPrompt =
        modelRecord.supportsSystemPrompt !== undefined
          ? (modelRecord.supportsSystemPrompt as boolean)
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
function getDefaultModels(
  inputType: string,
  outputType: string,
): Record<string, string> {
  const defaults: Record<string, string> = {};
  for (const model of getModels(inputType, outputType)) {
    const modelRecord = model as ModelDefinition & Record<string, unknown>;
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
function getPricing(
  inputType: string,
  outputType: string,
): Record<string, Record<string, number>> {
  const pricing: Record<string, Record<string, number>> = {};
  for (const model of getModels(inputType, outputType)) {
    const modelRecord = model as ModelDefinition & Record<string, unknown>;
    if (modelRecord.pricing) {
      pricing[model.name] = modelRecord.pricing as Record<string, number>;
    }
  }
  return pricing;
}

/**
 * Find a single model object by its API name.
 * Returns the model object or null.
 */
function getModelByName(name: string): ModelDefinition | null {
  return (
    (Object.values(MODELS).find(
      (model) => (model as ModelDefinition).name === name,
    ) as ModelDefinition | null) ?? null
  );
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
function resolveRecommendedDefault(
  inputType: string,
  outputType: string,
  availableProviders: Set<string>,
  functionCallOnly = false,
): { provider: string; model: string; temperature: number } | null {
  const modelOptions = getModelOptions(inputType, outputType);

  const isEligible = (model: ModelOptionEntry): boolean => {
    if (!functionCallOnly) return true;
    return (model.tools || []).includes("Tool Calling");
  };

  const tryProvider = (
    providerName: string,
    candidateNames: string[],
  ): { provider: string; model: string; temperature: number } | null => {
    if (!availableProviders.has(providerName)) return null;
    const providerModels = modelOptions[providerName] || [];
    for (const candidateName of candidateNames) {
      const match = providerModels.find(
        (model) => model.name === candidateName && isEligible(model),
      );
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
  if (googleResult) return googleResult;

  // Priority 3: Anthropic (Haiku)
  if (availableProviders.has("anthropic")) {
    const anthropicModels = modelOptions["anthropic"] || [];
    const haikuMatch = anthropicModels.find(
      (model) =>
        model.name.toLowerCase().includes("haiku") && isEligible(model),
    );
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
  if (openaiResult) return openaiResult;

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

import {
  getParameterDescriptors,
  getAgentDefaults,
} from "./services/ParameterRegistry.ts";
import type { ParameterDescriptor } from "./services/ParameterRegistry.ts";

// ─── EXPORTS ────────────────────────────────────────────────

export {
  // Providers
  PROVIDERS,
  PROVIDER_LIST,

  // Types
  TYPES,
  MODEL_TYPES,

  // Models
  MODELS,

  // Helpers
  getModels,
  getModelOptions,
  getDefaultModels,
  getPricing,
  getModelByName,
  resolveRecommendedDefault,

  // Voices
  VOICES,
  DEFAULT_VOICES,

  // Parameter Registry
  getParameterDescriptors,
  getAgentDefaults,
};

export type { ParameterDescriptor };
