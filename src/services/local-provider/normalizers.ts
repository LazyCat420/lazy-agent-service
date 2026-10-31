import { formatBytes } from "@rodrigo-barraza/utilities-library";
import { TYPES } from "../../config.ts";
import { detectCapabilities } from "./detectCapabilities.ts";
import {
  parseParamsFromName,
  parseQuantFromName,
  parsePublisherFromName,
} from "./nameParsers.ts";
import {
  ModelEntry,
  LmStudioRawModel,
  OllamaRawModel,
  OpenAICompatRawModel,
} from "./types.ts";

/** Canonical entry fields for an LM Studio model, before capabilities and metadata. */
function buildLmStudioEntry(
  modelKey: string,
  label: string,
  isEmbedding: boolean,
  capabilities: ReturnType<typeof detectCapabilities>,
): ModelEntry {
  return {
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
}

/** Capability flags (LLM only). */
function applyLmStudioCapabilities(
  entry: ModelEntry,
  capabilities: ReturnType<typeof detectCapabilities>,
  isEmbedding: boolean,
): void {
  if (isEmbedding) return;
  if (capabilities.tools.length > 0) entry.tools = capabilities.tools;
  if (capabilities.thinking) entry.thinking = true;
  if (capabilities.vision) entry.vision = true;
}

/** Size, quantization and architecture metadata LM Studio reports for the file. */
function applyLmStudioMetadata(entry: ModelEntry, raw: LmStudioRawModel): void {
  if (raw.max_context_length) entry.contextLength = raw.max_context_length;
  if (raw.size_bytes) entry.size = formatBytes(raw.size_bytes);
  if (raw.params_string) entry.params = raw.params_string;
  if (raw.quantization?.name) entry.quantization = raw.quantization.name;
  if (raw.quantization?.bits_per_weight != null)
    entry.bitsPerWeight = raw.quantization.bits_per_weight;
  if (raw.architecture) entry.architecture = raw.architecture;
  if (raw.publisher) entry.publisher = raw.publisher;
  if (raw.loaded_instances && raw.loaded_instances.length > 0)
    entry.loaded = true;
}

/**
 * Normalize an LM Studio model into a canonical model entry.
 * LM Studio's /api/v1/models returns rich metadata including
 * type, capabilities, quantization, architecture, and load state.
 */
export function normalizeLmStudioModel(raw: LmStudioRawModel): ModelEntry {
  const modelKey = raw.key;
  const capabilities = detectCapabilities(modelKey, raw);

  let label = raw.display_name || modelKey;
  if (raw.quantization?.name) {
    label += ` (${raw.quantization.name})`;
  }

  const isEmbedding = raw.type === "embedding";

  const entry = buildLmStudioEntry(modelKey, label, isEmbedding, capabilities);

  // Capability flags (LLM only)
  applyLmStudioCapabilities(entry, capabilities, isEmbedding);

  // Metadata from LM Studio API
  applyLmStudioMetadata(entry, raw);

  // Preserve raw for VRAM estimation
  entry._raw = raw;

  return entry;
}

/**
 * Normalize an Ollama model into a canonical model entry.
 * Ollama's /api/tags returns { name, model, size, details: { family, parameter_size, ... } }.
 */
export function normalizeOllamaModel(raw: OllamaRawModel): ModelEntry {
  const name = raw.model || raw.name || "";
  const capabilities = detectCapabilities(name);
  const details = raw.details || {};

  const entry: ModelEntry = {
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

  if (capabilities.tools.length > 0) entry.tools = capabilities.tools;
  if (capabilities.thinking) entry.thinking = true;
  if (details.parameter_size) entry.params = details.parameter_size;
  if (details.family) entry.architecture = details.family;
  if (raw.size) entry.size = formatBytes(raw.size);
  if (
    (raw as Record<string, unknown>).loaded_instances &&
    ((raw as Record<string, unknown>).loaded_instances as unknown[]).length > 0
  ) {
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
export function normalizeOpenAICompatModel(
  raw: OpenAICompatRawModel,
): ModelEntry {
  const modelKey = raw.key || raw.id || "";
  const capabilities = detectCapabilities(modelKey);

  const parsedParams = parseParamsFromName(modelKey);
  const parsedQuant = parseQuantFromName(modelKey);
  const parsedPublisher = parsePublisherFromName(modelKey);

  let label = raw.display_name || modelKey;
  if (parsedQuant) label += ` (${parsedQuant})`;

  const entry: ModelEntry = {
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

  if (capabilities.tools.length > 0) entry.tools = capabilities.tools;
  if (capabilities.thinking) entry.thinking = true;
  if (capabilities.vision) entry.vision = true;
  if (parsedParams) entry.params = parsedParams;
  if (parsedQuant) entry.quantization = parsedQuant;
  if (parsedPublisher) entry.publisher = parsedPublisher;

  return entry;
}

/**
 * vLLM-specific normalizer.
 * vLLM containers are launched with --enable-auto-tool-choice and a
 * --tool-call-parser, so every served model supports tool calling at
 * the server level regardless of name. Force "Tool Calling" onto all
 * vLLM models, then delegate the rest to the shared normalizer.
 */
export function normalizeVllmModel(raw: OpenAICompatRawModel): ModelEntry {
  const entry = normalizeOpenAICompatModel(raw);

  // Ensure Tool Calling is always present for vLLM models
  if (!entry.tools) entry.tools = [];
  if (!entry.tools.includes("Tool Calling")) {
    entry.tools.push("Tool Calling");
  }

  // Set maximum output token capacity for vLLM models to 50,000
  entry.maxOutputTokens = 50000;

  return entry;
}

import { PROVIDERS } from "../../constants.ts";

export type NormalizerFunction = (
  raw: LmStudioRawModel & OllamaRawModel & OpenAICompatRawModel,
) => ModelEntry;

export const NORMALIZER_BY_TYPE: Record<string, NormalizerFunction> = {
  [PROVIDERS.LM_STUDIO]: normalizeLmStudioModel as NormalizerFunction,
  [PROVIDERS.OLLAMA]: normalizeOllamaModel as NormalizerFunction,
  [PROVIDERS.VLLM]: normalizeVllmModel as NormalizerFunction,
  [PROVIDERS.LLAMA_CPP]: normalizeOpenAICompatModel as NormalizerFunction,
};

/** Provider types that should get HuggingFace metadata enrichment. */
export const HF_ENRICHED_TYPES = new Set<string>([PROVIDERS.VLLM, PROVIDERS.LLAMA_CPP]);
