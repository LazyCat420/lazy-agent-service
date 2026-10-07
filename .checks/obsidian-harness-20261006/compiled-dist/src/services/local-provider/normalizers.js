import { formatBytes } from "@rodrigo-barraza/utilities-library";
import { TYPES } from "../../config.js";
import { detectCapabilities } from "./detectCapabilities.js";
import { parseParamsFromName, parseQuantFromName, parsePublisherFromName, } from "./nameParsers.js";
/**
 * Normalize an LM Studio model into a canonical model entry.
 * LM Studio's /api/v1/models returns rich metadata including
 * type, capabilities, quantization, architecture, and load state.
 */
export function normalizeLmStudioModel(raw) {
    const modelKey = raw.key;
    const capabilities = detectCapabilities(modelKey, raw);
    let label = raw.display_name || modelKey;
    if (raw.quantization?.name) {
        label += ` (${raw.quantization.name})`;
    }
    const isEmbedding = raw.type === "embedding";
    const entry = {
        name: modelKey,
        label,
        modelType: isEmbedding ? "embed" : "conversation",
        inputTypes: isEmbedding ? [TYPES.TEXT] : capabilities.inputTypes,
        outputTypes: isEmbedding ? [TYPES.EMBEDDING] : capabilities.outputTypes,
        supportsSystemPrompt: !isEmbedding,
        streaming: !isEmbedding,
        defaultTemperature: isEmbedding ? undefined : 0.7,
        pricing: { inputPerMillion: 0, outputPerMillion: 0 },
    };
    // Capability flags (LLM only)
    if (!isEmbedding) {
        if (capabilities.tools.length > 0)
            entry.tools = capabilities.tools;
        if (capabilities.thinking)
            entry.thinking = true;
        if (capabilities.vision)
            entry.vision = true;
    }
    // Metadata from LM Studio API
    if (raw.max_context_length)
        entry.contextLength = raw.max_context_length;
    if (raw.size_bytes)
        entry.size = formatBytes(raw.size_bytes);
    if (raw.params_string)
        entry.params = raw.params_string;
    if (raw.quantization?.name)
        entry.quantization = raw.quantization.name;
    if (raw.quantization?.bits_per_weight != null)
        entry.bitsPerWeight = raw.quantization.bits_per_weight;
    if (raw.architecture)
        entry.architecture = raw.architecture;
    if (raw.publisher)
        entry.publisher = raw.publisher;
    if (raw.loaded_instances && raw.loaded_instances.length > 0)
        entry.loaded = true;
    // Preserve raw for VRAM estimation
    entry._raw = raw;
    return entry;
}
/**
 * Normalize an Ollama model into a canonical model entry.
 * Ollama's /api/tags returns { name, model, size, details: { family, parameter_size, ... } }.
 */
export function normalizeOllamaModel(raw) {
    const name = raw.model || raw.name || "";
    const capabilities = detectCapabilities(name);
    const details = raw.details || {};
    const entry = {
        name,
        label: raw.name || name,
        modelType: "conversation",
        inputTypes: capabilities.inputTypes,
        outputTypes: capabilities.outputTypes,
        supportsSystemPrompt: true,
        streaming: true,
        defaultTemperature: 0.7,
        pricing: { inputPerMillion: 0, outputPerMillion: 0 },
    };
    if (capabilities.tools.length > 0)
        entry.tools = capabilities.tools;
    if (capabilities.thinking)
        entry.thinking = true;
    if (details.parameter_size)
        entry.params = details.parameter_size;
    if (details.family)
        entry.architecture = details.family;
    if (raw.size)
        entry.size = formatBytes(raw.size);
    if (raw.loaded_instances &&
        raw.loaded_instances.length > 0) {
        entry.loaded = true;
    }
    entry._raw = raw;
    return entry;
}
/**
 * Normalize a vLLM or llama.cpp model into a canonical model entry.
 * Both use the OpenAI-compatible /v1/models which returns { id, object, owned_by }.
 * Enriches with name-parsed attributes; HF enrichment is done separately.
 */
export function normalizeOpenAICompatModel(raw) {
    const modelKey = raw.key || raw.id || "";
    const capabilities = detectCapabilities(modelKey);
    const parsedParams = parseParamsFromName(modelKey);
    const parsedQuant = parseQuantFromName(modelKey);
    const parsedPublisher = parsePublisherFromName(modelKey);
    let label = raw.display_name || modelKey;
    if (parsedQuant)
        label += ` (${parsedQuant})`;
    const entry = {
        name: modelKey,
        label,
        modelType: "conversation",
        inputTypes: capabilities.inputTypes,
        outputTypes: capabilities.outputTypes,
        supportsSystemPrompt: true,
        streaming: true,
        defaultTemperature: 0.7,
        pricing: { inputPerMillion: 0, outputPerMillion: 0 },
    };
    if (capabilities.tools.length > 0)
        entry.tools = capabilities.tools;
    if (capabilities.thinking)
        entry.thinking = true;
    if (capabilities.vision)
        entry.vision = true;
    if (parsedParams)
        entry.params = parsedParams;
    if (parsedQuant)
        entry.quantization = parsedQuant;
    if (parsedPublisher)
        entry.publisher = parsedPublisher;
    return entry;
}
/**
 * vLLM-specific normalizer.
 * vLLM containers are launched with --enable-auto-tool-choice and a
 * --tool-call-parser, so every served model supports tool calling at
 * the server level regardless of name. Force "Tool Calling" onto all
 * vLLM models, then delegate the rest to the shared normalizer.
 */
export function normalizeVllmModel(raw) {
    const entry = normalizeOpenAICompatModel(raw);
    // Ensure Tool Calling is always present for vLLM models
    if (!entry.tools)
        entry.tools = [];
    if (!entry.tools.includes("Tool Calling")) {
        entry.tools.push("Tool Calling");
    }
    // Set maximum output token capacity for vLLM models to 50,000
    entry.maxOutputTokens = 50000;
    return entry;
}
import { PROVIDERS } from "../../constants.js";
export const NORMALIZER_BY_TYPE = {
    [PROVIDERS.LM_STUDIO]: normalizeLmStudioModel,
    [PROVIDERS.OLLAMA]: normalizeOllamaModel,
    [PROVIDERS.VLLM]: normalizeVllmModel,
    [PROVIDERS.LLAMA_CPP]: normalizeOpenAICompatModel,
};
/** Provider types that should get HuggingFace metadata enrichment. */
export const HF_ENRICHED_TYPES = new Set([PROVIDERS.VLLM, PROVIDERS.LLAMA_CPP]);
//# sourceMappingURL=normalizers.js.map