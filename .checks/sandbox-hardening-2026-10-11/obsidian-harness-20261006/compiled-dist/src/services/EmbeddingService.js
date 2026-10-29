import { formatCostTag, roundMilliseconds, } from "@rodrigo-barraza/utilities-library";
import crypto from "crypto";
import { getProvider } from "../providers/index.js";
import { TYPES, getDefaultModels, getPricing } from "../config.js";
import { estimateTokens } from "../utils/CostCalculator.js";
import { ProviderError } from "../utils/errors.js";
import RequestLogger from "./RequestLogger.js";
import logger from "../utils/logger.js";
import { calculateTokensPerSec } from "../utils/math.js";
import SettingsService from "./SettingsService.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
/** Resolve the current embedding provider + model from settings. */
async function getEmbeddingConfig() {
    return SettingsService.getMemoryModelConfig("embedding");
}
const EmbeddingService = {
    async generate(content, options = {}) {
        const requestId = crypto.randomUUID();
        const requestStart = performance.now();
        // Resolve defaults from settings when no explicit provider/model given
        const embedConfig = await getEmbeddingConfig();
        const providerName = options.provider || embedConfig.provider;
        const resolvedModel = options.model ||
            getDefaultModels(TYPES.TEXT, TYPES.EMBEDDING)?.[providerName] ||
            embedConfig.model;
        let result = undefined;
        let success = true;
        let errorMessage = null;
        try {
            const provider = getProvider(providerName);
            if (!provider.generateEmbedding) {
                throw new ProviderError(providerName, `Provider "${providerName}" does not support embeddings`, 400);
            }
            const providerOptions = {};
            if (options.taskType)
                providerOptions.taskType = options.taskType;
            if (options.dimensions)
                providerOptions.dimensions = options.dimensions;
            result = await provider.generateEmbedding(content, resolvedModel, providerOptions);
        }
        catch (error) {
            success = false;
            errorMessage = getErrorMessage(error);
            throw error;
        }
        finally {
            const totalSec = (performance.now() - requestStart) / 1000;
            // Cost estimation
            const pricing = getPricing(TYPES.TEXT, TYPES.EMBEDDING)[resolvedModel];
            const approxInputTokens = typeof content === "string" ? estimateTokens(content) : 100;
            let estimatedCost = null;
            if (pricing?.inputPerMillion) {
                estimatedCost =
                    (approxInputTokens / 1_000_000) * pricing.inputPerMillion;
            }
            const source = options.source || "any";
            // Determine input content type for payload logging
            const contentType = typeof content === "string"
                ? "text"
                : Array.isArray(content)
                    ? "multimodal"
                    : "any";
            const inputCharacters = typeof content === "string" ? content.length : 0;
            logger.request(options.project || "", options.username || "system", options.clientIp || null, `[embed] ${providerName} model=${resolvedModel} source=${source} — ` +
                (success
                    ? `dims: ${result?.dimensions}, total: ${totalSec.toFixed(2)}s`
                    : `FAILED: ${errorMessage}`) +
                formatCostTag(estimatedCost));
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
                    const modalities = { embeddingOut: true };
                    if (typeof content === "string") {
                        modalities.textIn = true;
                    }
                    else if (Array.isArray(content)) {
                        for (const part of content) {
                            if (typeof part === "string") {
                                modalities.textIn = true;
                            }
                            else {
                                if (part.text)
                                    modalities.textIn = true;
                                const mime = part.inlineData?.mimeType || "";
                                if (mime.startsWith("image/"))
                                    modalities.imageIn = true;
                                else if (mime.startsWith("audio/"))
                                    modalities.audioIn = true;
                                else if (mime.startsWith("video/"))
                                    modalities.videoIn = true;
                                else if (mime === "application/pdf")
                                    modalities.docIn = true;
                            }
                        }
                    }
                    return modalities;
                })(),
                requestPayload: {
                    source,
                    contentType,
                    ...(options.taskType ? { taskType: options.taskType } : {}),
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
            throw new Error(`Embedding generation failed: ${errorMessage || "unknown error"}`);
        }
        return {
            embedding: result.embedding,
            dimensions: result.dimensions,
            provider: providerName,
            model: resolvedModel,
        };
    },
    async embed(text, options = {}) {
        const result = await this.generate(text, options);
        return result.embedding;
    },
};
export default EmbeddingService;
//# sourceMappingURL=EmbeddingService.js.map