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
import { EMBEDDING_PROVIDER, EMBEDDING_MODEL, embeddingSpace } from "./EmbeddingGemma2Client.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import type {
  EmbeddingMultimodalPart,
  EmbeddingContent,
} from "../types/provider.ts";
/** Resolve the current embedding provider + model from settings. */
async function getEmbeddingConfig() {
  return SettingsService.getMemoryModelConfig("embedding");
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
    const embedConfig = options.provider && options.model
      ? { provider: options.provider, model: options.model }
      : await getEmbeddingConfig();
    const requestedProvider = options.provider || embedConfig.provider;
    const requestedModel = options.model || (!options.provider ? embedConfig.model : undefined) ||
      (getDefaultModels(TYPES.TEXT, TYPES.EMBEDDING) as Record<string, string> | undefined)?.[requestedProvider] || embedConfig.model;
    const useGemma = /embeddinggemma/i.test(requestedModel) || requestedProvider === EMBEDDING_PROVIDER;
    const taskType = options.taskType || (useGemma ? "RETRIEVAL_DOCUMENT" : undefined);
    const providerName = useGemma ? EMBEDDING_PROVIDER : requestedProvider;
    const resolvedModel = useGemma ? EMBEDDING_MODEL : requestedModel;
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
      space: useGemma ? `${embeddingSpace(result.dimensions)}${taskType === "similarity" || taskType === "SEMANTIC_SIMILARITY" ? ":similarity" : ""}` : `${providerName}:${resolvedModel}:${result.dimensions}:retrieval-v1`,
    };
  },
  async embed(text: EmbeddingContent, options: EmbeddingOptions = {}) {
    const result = await this.generate(text, options);
    return result.embedding;
  },
};
export default EmbeddingService;
