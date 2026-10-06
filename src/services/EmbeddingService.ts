import {
  formatCostTag,
  roundMilliseconds,
} from "@rodrigo-barraza/utilities-library";
import crypto from "crypto";
import { getProvider } from "../providers/index.ts";
import { TYPES, getDefaultModels, getPricing } from "../config.ts";
import { estimateTokens } from "../utils/CostCalculator.ts";
import { ProviderError } from "../utils/errors.ts";
import RequestLogger from "./RequestLogger.ts";
import logger from "../utils/logger.ts";
import { calculateTokensPerSec } from "../utils/math.ts";
import SettingsService from "./SettingsService.ts";
import { EmbeddingGemma2Client, EMBEDDING_PROVIDER, EMBEDDING_MODEL, embeddingSpace } from "./EmbeddingGemma2Client.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import type {
  EmbeddingMultimodalPart,
  EmbeddingContent,
} from "../types/provider.ts";
/** Resolve the current embedding provider + model from settings. */
async function getEmbeddingConfig() {
  return SettingsService.getMemoryModelConfig("embedding");
}

/** Most texts one batch request may carry. The whole batch holds the shared
 *  Jetson queue, so this bounds how long a live harness call waits behind it. */
export const MAX_BATCH_TEXTS = 32;

/** Provider/model/task resolution shared by single and batch requests. */
async function resolveTarget(options: EmbeddingOptions) {
  const embedConfig = options.provider && options.model
    ? { provider: options.provider, model: options.model }
    : await getEmbeddingConfig();
  const requestedProvider = options.provider || embedConfig.provider;
  const requestedModel = options.model || (!options.provider ? embedConfig.model : undefined) ||
    (getDefaultModels(TYPES.TEXT, TYPES.EMBEDDING) as Record<string, string> | undefined)?.[requestedProvider] || embedConfig.model;
  const useGemma = /embeddinggemma/i.test(requestedModel) || requestedProvider === EMBEDDING_PROVIDER;
  return {
    useGemma,
    taskType: options.taskType || (useGemma ? "RETRIEVAL_DOCUMENT" : undefined),
    providerName: useGemma ? EMBEDDING_PROVIDER : requestedProvider,
    resolvedModel: useGemma ? EMBEDDING_MODEL : requestedModel,
  };
}

function spaceFor(target: Awaited<ReturnType<typeof resolveTarget>>, dimensions: number) {
  const { useGemma, taskType, providerName, resolvedModel } = target;
  return useGemma
    ? `${embeddingSpace(dimensions)}${taskType === "similarity" || taskType === "SEMANTIC_SIMILARITY" ? ":similarity" : ""}`
    : `${providerName}:${resolvedModel}:${dimensions}:retrieval-v1`;
}
/**
 * EmbeddingService — single entry point for all embedding generation.
 *
 * Wraps the provider's `generateEmbedding()` with RequestLogger tracking,
 * ensuring both HTTP `/embed` requests and internal callers (MemoryService,
 * SystemPromptAssembler) flow through the same path.
 */

interface EmbeddingOptions {
  provider?: string;
  model?: string;
  taskType?: string;
  dimensions?: number;
  source?: string;
  project?: string | null;
  username?: string;
  clientIp?: string | null;
  endpoint?: string | null;
  agent?: string | null;
  traceId?: string | null;
  conversationId?: string | null;
  agentConversationId?: string | null;
}

const EmbeddingService = {
  async generate(content: EmbeddingContent, options: EmbeddingOptions = {}) {
    const requestId = crypto.randomUUID();
    const requestStart = performance.now();
    // Resolve defaults from settings when no explicit provider/model given
    const target = await resolveTarget(options);
    const { taskType, providerName, resolvedModel } = target;
    let result: { embedding: number[]; dimensions: number } | undefined =
      undefined;
    let success = true;
    let errorMessage = null;
    try {
      const provider = getProvider(providerName);
      if (!provider.generateEmbedding) {
        throw new ProviderError(
          providerName,
          `Provider "${providerName}" does not support embeddings`,
          400,
        );
      }
      const providerOptions: Record<string, unknown> = {};
      if (taskType) providerOptions.taskType = taskType;
      if (options.dimensions !== undefined) providerOptions.dimensions = options.dimensions;
      result = await provider.generateEmbedding(
        content,
        resolvedModel,
        providerOptions,
      );
      result.dimensions = result.embedding.length;
    } catch (error: unknown) {
      success = false;
      errorMessage = getErrorMessage(error);
      throw error;
    } finally {
      const totalSec = (performance.now() - requestStart) / 1000;
      // Cost estimation
      const pricing = getPricing(TYPES.TEXT, TYPES.EMBEDDING)[resolvedModel];
      const approxInputTokens =
        typeof content === "string" ? estimateTokens(content) : 100;
      let estimatedCost = null;
      if (pricing?.inputPerMillion) {
        estimatedCost =
          (approxInputTokens / 1_000_000) * pricing.inputPerMillion;
      }
      const source = options.source || "any";
      // Determine input content type for payload logging
      const contentType =
        typeof content === "string"
          ? "text"
          : Array.isArray(content)
            ? "multimodal"
            : "any";
      const inputCharacters = typeof content === "string" ? content.length : 0;
      logger.request(
        options.project || "",
        options.username || "system",
        options.clientIp || null,
        `[embed] ${providerName} model=${resolvedModel} source=${source} — ` +
          (success
            ? `dims: ${result?.dimensions}, total: ${totalSec.toFixed(2)}s`
            : `FAILED: ${errorMessage}`) +
          formatCostTag(estimatedCost),
      );
      RequestLogger.log({
        requestId,
        endpoint: options.endpoint || null,
        operation: `${source}:embed`,
        project: options.project || null,
        username: options.username || "system",
        clientIp: options.clientIp || null,
        agent: options.agent || null,
        provider: providerName,
        model: resolvedModel,
        traceId: options.traceId || null,
        conversationId: options.conversationId || null,
        agentConversationId: options.agentConversationId || null,
        success,
        errorMessage,
        estimatedCost,
        inputTokens: approxInputTokens,
        outputTokens: 0, // Embeddings produce vectors, not output tokens
        tokensPerSec: calculateTokensPerSec(approxInputTokens, totalSec),
        inputCharacters,
        totalTime: roundMilliseconds(totalSec),
        modalities: (() => {
          const modalities: Record<string, boolean> = { embeddingOut: true };
          if (typeof content === "string") {
            modalities.textIn = true;
          } else if (Array.isArray(content)) {
            for (const part of content) {
              if (typeof part === "string") {
                modalities.textIn = true;
              } else {
                if (part.text) modalities.textIn = true;
                const mime = part.inlineData?.mimeType || "";
                if (mime.startsWith("image/")) modalities.imageIn = true;
                else if (mime.startsWith("audio/")) modalities.audioIn = true;
                else if (mime.startsWith("video/")) modalities.videoIn = true;
                else if (mime === "application/pdf") modalities.docIn = true;
              }
            }
          }
          return modalities;
        })(),
        requestPayload: {
          source,
          contentType,
          ...(taskType ? { taskType } : {}),
          ...(options.dimensions ? { dimensions: options.dimensions } : {}),
          ...(contentType === "text"
            ? { text: typeof content === "string" ? content : "" }
            : {}),
        },
        responsePayload: success
          ? {
              dimensions: result?.dimensions || null,
              embeddingPreview: result?.embedding?.slice(0, 5) || null,
            }
          : { error: errorMessage },
      });
    }
    if (!result) {
      throw new Error(
        `Embedding generation failed: ${errorMessage || "unknown error"}`,
      );
    }
    return {
      embedding: result.embedding,
      dimensions: result.dimensions,
      provider: providerName,
      model: resolvedModel,
      space: spaceFor(target, result.dimensions),
    };
  },
  /**
   * Embed several texts in one request. The shared Jetson client packs them
   * into ≤8-input calls through its single queue and logs ONE request row
   * (counts only, never the texts — corpus reindexes would otherwise copy the
   * corpus into the request log). Other providers fall back to generate().
   */
  async generateMany(texts: string[], options: EmbeddingOptions = {}) {
    if (!Array.isArray(texts) || !texts.length || texts.length > MAX_BATCH_TEXTS ||
      texts.some(text => typeof text !== "string" || !text.trim())) {
      throw new ProviderError("server", `texts must hold 1–${MAX_BATCH_TEXTS} non-empty strings`, 400);
    }
    const target = await resolveTarget(options);
    if (!target.useGemma) {
      const results = [];
      for (const text of texts) results.push(await this.generate(text, options));
      const { dimensions, provider, model, space } = results[0];
      return { embeddings: results.map(result => result.embedding), dimensions, provider, model, space };
    }
    const dimensions = options.dimensions ?? 768;
    const source = options.source || "any";
    const inputCharacters = texts.reduce((sum, text) => sum + text.length, 0);
    const requestStart = performance.now();
    let embeddings: number[][] | undefined;
    let errorMessage: string | null = null;
    try {
      embeddings = await EmbeddingGemma2Client.embedMany(texts, target.taskType, dimensions);
      return { embeddings, dimensions, provider: target.providerName, model: target.resolvedModel, space: spaceFor(target, dimensions) };
    } catch (error: unknown) {
      errorMessage = getErrorMessage(error);
      throw error;
    } finally {
      const totalSec = (performance.now() - requestStart) / 1000;
      const approxInputTokens = texts.reduce((sum, text) => sum + estimateTokens(text), 0);
      logger.request(
        options.project || "",
        options.username || "system",
        options.clientIp || null,
        `[embed] ${target.providerName} model=${target.resolvedModel} source=${source} batch=${texts.length} — ` +
          (embeddings ? `dims: ${dimensions}, total: ${totalSec.toFixed(2)}s` : `FAILED: ${errorMessage}`),
      );
      RequestLogger.log({
        requestId: crypto.randomUUID(),
        endpoint: options.endpoint || null,
        operation: `${source}:embed-batch`,
        project: options.project || null,
        username: options.username || "system",
        clientIp: options.clientIp || null,
        agent: options.agent || null,
        provider: target.providerName,
        model: target.resolvedModel,
        traceId: options.traceId || null,
        success: Boolean(embeddings),
        errorMessage,
        estimatedCost: null,
        inputTokens: approxInputTokens,
        outputTokens: 0,
        tokensPerSec: calculateTokensPerSec(approxInputTokens, totalSec),
        inputCharacters,
        totalTime: roundMilliseconds(totalSec),
        modalities: { textIn: true, embeddingOut: true },
        requestPayload: { source, contentType: "text-batch", count: texts.length, taskType: target.taskType, dimensions },
        responsePayload: embeddings ? { count: embeddings.length, dimensions } : { error: errorMessage },
      });
    }
  },
  async embed(text: EmbeddingContent, options: EmbeddingOptions = {}) {
    const result = await this.generate(text, options);
    return result.embedding;
  },
};
export default EmbeddingService;
