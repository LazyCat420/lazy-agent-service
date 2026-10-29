import logger from "../../utils/logger.js";
import { withTimeoutFallback } from "@rodrigo-barraza/utilities-library";
import { getProvider } from "../../providers/index.js";
import { listInstances, getInstancesByType, isInstance, getInstance, getInstanceType, listInstanceTypes, } from "../../providers/instance-registry.js";
import { TYPES } from "../../config.js";
import { getErrorMessage } from "../../utils/ErrorHelpers.js";
import { LOCAL_PROVIDER_TYPES, NATIVE_MCP_TYPES, DEFAULT_THINKING_TYPES, MODEL_MANAGEMENT_TYPES, } from "./constants.js";
import { enrichWithHuggingFace } from "./hfMetadata.js";
import { NORMALIZER_BY_TYPE, HF_ENRICHED_TYPES } from "./normalizers.js";
import { estimateVRAM, estimateVRAMForModel } from "./vramEstimation.js";
class LocalProviderGateway {
    constructor() {
        logger.info("[LocalProviderGateway] Initialized");
    }
    // ── Provider Classification ─────────────────────────────────
    /**
     * Check whether a provider/instance ID represents a local provider.
     * Handles both base types ("lm-studio") and multi-instance IDs ("lm-studio-2").
     */
    isLocal(providerOrInstanceId) {
        if (!providerOrInstanceId)
            return false;
        if (LOCAL_PROVIDER_TYPES.has(providerOrInstanceId))
            return true;
        return isInstance(providerOrInstanceId);
    }
    /**
     * Check whether a provider uses native MCP tool execution.
     * These providers handle multi-step tool calling internally — the
     * agentic loop should only feed tools on the first pass.
     */
    isNativeMCP(providerOrInstanceId) {
        if (!providerOrInstanceId)
            return false;
        const type = this.getProviderType(providerOrInstanceId) || providerOrInstanceId;
        return NATIVE_MCP_TYPES.has(type);
    }
    /**
     * Check whether a provider should default thinkingEnabled=true
     * when the client doesn't explicitly set it.
     */
    defaultsThinkingEnabled(providerOrInstanceId) {
        if (!providerOrInstanceId)
            return false;
        const type = this.getProviderType(providerOrInstanceId) || providerOrInstanceId;
        return DEFAULT_THINKING_TYPES.has(type);
    }
    supportsModelManagement(providerOrInstanceId) {
        if (!providerOrInstanceId)
            return false;
        const type = this.getProviderType(providerOrInstanceId) || providerOrInstanceId;
        return MODEL_MANAGEMENT_TYPES.has(type);
    }
    /**
     * Resolve the base provider type from any instance ID.
     * e.g. "lm-studio-2" → "lm-studio", "ollama" → "ollama"
     * Returns null for non-local providers.
     */
    getProviderType(providerOrInstanceId) {
        if (!providerOrInstanceId)
            return null;
        if (LOCAL_PROVIDER_TYPES.has(providerOrInstanceId))
            return providerOrInstanceId;
        return getInstanceType(providerOrInstanceId);
    }
    // ── Instance Enumeration ────────────────────────────────────
    getInstances() {
        return listInstances().map((instance) => ({
            id: instance.id,
            type: instance.type,
            instanceNumber: instance.instanceNumber,
            concurrency: instance.concurrency,
        }));
    }
    getInstancesByType(type) {
        return getInstancesByType(type);
    }
    getRegisteredTypes() {
        return listInstanceTypes();
    }
    getConcurrencyCapacity() {
        const instances = listInstances();
        const byType = {};
        const byInstance = {};
        let total = 0;
        for (const instance of instances) {
            total += instance.concurrency;
            byType[instance.type] =
                (byType[instance.type] || 0) + instance.concurrency;
            byInstance[instance.id] = instance.concurrency;
        }
        return { total, byType, byInstance };
    }
    // ── Model Discovery ─────────────────────────────────────────
    /**
     * Discover all models across all local provider instances.
     * Results are normalized into a canonical format and enriched
     * with capability detection and (optionally) HuggingFace metadata.
     */
    async discoverModels({ timeoutMs = 3000, enrich = true, } = {}) {
        const instances = listInstances();
        const models = {};
        const results = await Promise.allSettled(instances.map(async (instance) => {
            const fetched = await this._fetchModelsForInstance(instance, timeoutMs, enrich);
            return {
                id: instance.id,
                type: instance.type,
                instanceNumber: instance.instanceNumber,
                models: fetched,
            };
        }));
        for (const result of results) {
            if (result.status === "fulfilled" && result.value.models.length > 0) {
                const { id, type, instanceNumber, models: providerModels, } = result.value;
                // Tag each model with its instance metadata
                for (const model of providerModels) {
                    model.instanceNumber = instanceNumber;
                    model.providerType = type;
                }
                models[id] = providerModels;
            }
        }
        return models;
    }
    async discoverModelsForInstance(instanceId, { timeoutMs = 3000, enrich = true, } = {}) {
        const instance = getInstance(instanceId);
        if (!instance) {
            logger.warn(`[LocalProviderGateway] Unknown instance: ${instanceId}`);
            return [];
        }
        return this._fetchModelsForInstance(instance, timeoutMs, enrich);
    }
    /**
     * Internal: Fetch, normalize, and optionally enrich models for an instance.
     * @private
     */
    async _fetchModelsForInstance(instance, timeoutMs, enrich) {
        try {
            const provider = getProvider(instance.id);
            if (!provider?.listModels)
                return [];
            const rawResult = (await withTimeoutFallback(provider.listModels(), timeoutMs, { models: [] }));
            const rawModels = rawResult?.models || rawResult?.data || [];
            if (!Array.isArray(rawModels) || rawModels.length === 0)
                return [];
            const normalize = NORMALIZER_BY_TYPE[instance.type];
            if (!normalize)
                return [];
            // Normalize all models
            let normalized = rawModels.map((raw) => normalize(raw));
            // HuggingFace enrichment for vLLM/llama.cpp (their model IDs are HF-style)
            if (enrich && HF_ENRICHED_TYPES.has(instance.type)) {
                const enriched = await Promise.allSettled(normalized.map((entry) => enrichWithHuggingFace(entry, entry.name)));
                normalized = enriched.map((r, i) => r.status === "fulfilled" ? r.value : normalized[i]);
            }
            return normalized;
        }
        catch (error) {
            logger.warn(`[LocalProviderGateway] Failed to discover models for ${instance.id}: ${getErrorMessage(error)}`);
            return [];
        }
    }
    // ── Model Search & Filter ───────────────────────────────────
    async searchModels(filter = {}) {
        const allModels = await this.discoverModels();
        const results = [];
        for (const [instanceId, models] of Object.entries(allModels)) {
            for (const model of models) {
                if (!this._matchesFilter(model, filter))
                    continue;
                results.push({ instanceId, model });
            }
        }
        return results;
    }
    /**
     * Check if a model entry matches the given filter criteria.
     * @private
     */
    _matchesFilter(model, filter) {
        if (filter.thinking && !model.thinking)
            return false;
        if (filter.functionCalling && !model.tools?.includes("Tool Calling"))
            return false;
        if (filter.vision && !model.vision)
            return false;
        if (filter.video && !model.inputTypes?.includes(TYPES.VIDEO))
            return false;
        if (filter.audio && !model.inputTypes?.includes(TYPES.AUDIO))
            return false;
        if (filter.modelType && model.modelType !== filter.modelType)
            return false;
        if (filter.loaded === true && !model.loaded)
            return false;
        if (filter.loaded === false && model.loaded)
            return false;
        if (filter.query) {
            const searchQuery = filter.query.toLowerCase();
            const nameMatch = model.name?.toLowerCase().includes(searchQuery);
            const labelMatch = model.label?.toLowerCase().includes(searchQuery);
            if (!nameMatch && !labelMatch)
                return false;
        }
        return true;
    }
    // ── Aggregate Statistics ────────────────────────────────────
    async getStats() {
        const allModels = await this.discoverModels({ enrich: false });
        const instances = listInstances();
        let totalModels = 0;
        let loadedModels = 0;
        let embeddingModels = 0;
        let conversationModels = 0;
        const modelsByInstance = {};
        const modelsByType = {};
        const capabilityDistribution = {
            thinking: 0,
            functionCalling: 0,
            vision: 0,
            video: 0,
            audio: 0,
        };
        for (const [instanceId, models] of Object.entries(allModels)) {
            modelsByInstance[instanceId] = models.length;
            const instance = getInstance(instanceId);
            const type = instance?.type || "any";
            modelsByType[type] = (modelsByType[type] || 0) + models.length;
            for (const model of models) {
                totalModels++;
                if (model.loaded)
                    loadedModels++;
                if (model.modelType === "embed")
                    embeddingModels++;
                else
                    conversationModels++;
                if (model.thinking)
                    capabilityDistribution.thinking++;
                if (model.tools?.includes("Tool Calling"))
                    capabilityDistribution.functionCalling++;
                if (model.vision)
                    capabilityDistribution.vision++;
                if (model.inputTypes?.includes(TYPES.VIDEO))
                    capabilityDistribution.video++;
                if (model.inputTypes?.includes(TYPES.AUDIO))
                    capabilityDistribution.audio++;
            }
        }
        return {
            instances: instances.length,
            totalModels,
            loadedModels,
            conversationModels,
            embeddingModels,
            modelsByInstance,
            modelsByType,
            capabilityDistribution,
            concurrency: this.getConcurrencyCapacity(),
        };
    }
    // ── Model Routing ───────────────────────────────────────────
    /**
     * Resolve which provider instance serves a given model.
     * Queries each instance's model list and returns the first match.
     */
    async resolveProvider(modelName, { timeoutMs = 3000 } = {}) {
        const instances = listInstances();
        const checks = await Promise.allSettled(instances.map(async (instance) => {
            const provider = getProvider(instance.id);
            if (!provider?.listModels)
                return null;
            const result = (await withTimeoutFallback(provider.listModels(), timeoutMs, { models: [] }));
            const models = result?.models || result?.data || [];
            const found = models.some((modelEntry) => {
                const key = (modelEntry.key ||
                    modelEntry.id ||
                    modelEntry.model ||
                    modelEntry.name);
                return key === modelName;
            });
            return found ? instance : null;
        }));
        for (const result of checks) {
            if (result.status === "fulfilled" && result.value) {
                const instance = result.value;
                return {
                    instanceId: instance.id,
                    type: instance.type,
                    provider: getProvider(instance.id),
                };
            }
        }
        return null;
    }
    // ── Health Monitoring ───────────────────────────────────────
    /**
     * Check health of all local provider instances.
     * Returns a map of instance ID → health status.
     *
     * For providers that expose checkHealth() (llama.cpp), uses that.
     * For others, performs a lightweight listModels() probe.
     */
    async checkHealth(timeoutMs = 3000) {
        const instances = listInstances();
        const health = {};
        const results = await Promise.allSettled(instances.map(async (instance) => {
            const provider = getProvider(instance.id);
            // Prefer native health check if available
            if (provider?.checkHealth) {
                const result = await withTimeoutFallback(provider.checkHealth(), timeoutMs, { ok: false, status: "timeout" });
                return {
                    id: instance.id,
                    type: instance.type,
                    ...result,
                };
            }
            // Fallback: probe via listModels
            if (provider?.listModels) {
                try {
                    const result = (await withTimeoutFallback(provider.listModels(), timeoutMs, null));
                    if (!result) {
                        return {
                            id: instance.id,
                            type: instance.type,
                            ok: false,
                            status: "timeout",
                        };
                    }
                    const models = result.models || result.data || [];
                    return {
                        id: instance.id,
                        type: instance.type,
                        ok: true,
                        status: "ok",
                        models: models.length,
                    };
                }
                catch (error) {
                    return {
                        id: instance.id,
                        type: instance.type,
                        ok: false,
                        status: "unreachable",
                        error: getErrorMessage(error),
                    };
                }
            }
            return {
                id: instance.id,
                type: instance.type,
                ok: false,
                status: "no_probe",
            };
        }));
        for (const result of results) {
            if (result.status === "fulfilled") {
                const { id, ...status } = result.value;
                health[id] = status;
            }
        }
        return health;
    }
    // ── VRAM Estimation ─────────────────────────────────────────
    /**
     * Estimate VRAM usage for a GGUF model served by a local provider.
     * Primarily useful for LM Studio models that report GGUF metadata.
     */
    estimateVRAM(modelData, options = {}) {
        return estimateVRAM(modelData, options);
    }
    /**
     * Estimate VRAM for a model by its key on a specific instance.
     * Fetches model metadata from the provider, then runs estimateVRAM.
     */
    async estimateVRAMForModel(instanceId, modelKey, options = {}) {
        return estimateVRAMForModel(instanceId, modelKey, options);
    }
    // ── Model Management ────────────────────────────────────────
    /**
     * Load a model on a specific instance.
     * Only supported by providers that expose loadModel (LM Studio).
     */
    async loadModel(instanceId, modelKey, options = {}, signal) {
        const provider = getProvider(instanceId);
        if (!provider?.loadModel) {
            throw new Error(`Provider ${instanceId} does not support model loading`);
        }
        return provider.loadModel(modelKey, options, signal);
    }
    /**
     * Ensure a specific model is loaded on a specific instance.
     * Handles unloading of other models if necessary (single-model enforcement).
     */
    async ensureModelLoaded(instanceId, modelKey, options = {}, signal, onStatus) {
        const provider = getProvider(instanceId);
        if (!provider?.ensureModelLoaded) {
            throw new Error(`Provider ${instanceId} does not support model management`);
        }
        return provider.ensureModelLoaded(modelKey, options, signal, onStatus);
    }
    async unloadModel(instanceId, modelInstanceId) {
        const provider = getProvider(instanceId);
        if (!provider?.unloadModel) {
            throw new Error(`Provider ${instanceId} does not support model unloading`);
        }
        return provider.unloadModel(modelInstanceId);
    }
    // ── Options Normalization ───────────────────────────────────
    /**
     * Apply local provider defaults to the options object.
     * This handles the "thinking enabled by default" behavior
     * and any other provider-specific option normalization.
     *
     * Call this during request preparation (prepareGenerationContext).
     */
    applyLocalDefaults(providerName, options, clientParams = {}) {
        if (!this.isLocal(providerName))
            return options;
        // Default thinkingEnabled=true for providers that emit <think> tags,
        // but only when the client didn't explicitly send a value.
        if (this.defaultsThinkingEnabled(providerName) &&
            clientParams.thinkingEnabled === undefined) {
            options.thinkingEnabled = true;
        }
        return options;
    }
    // ── Generation Delegation ───────────────────────────────────
    /**
     * Generate text (non-streaming) via a local provider.
     * Auto-resolves the provider if only a model name is given.
     */
    async generateText(messages, model, options = {}, instanceId) {
        const provider = await this._getProviderForModel(model, instanceId);
        if (!provider.generateText) {
            throw new Error(`Provider does not support text generation`);
        }
        return provider.generateText(messages, model, options);
    }
    /**
     * Generate text (streaming) via a local provider.
     * Auto-resolves the provider if only a model name is given.
     */
    async *generateTextStream(messages, model, options = {}, instanceId) {
        const provider = await this._getProviderForModel(model, instanceId);
        if (!provider.generateTextStream) {
            throw new Error(`Provider does not support streaming text generation`);
        }
        yield* provider.generateTextStream(messages, model, options);
    }
    async generateEmbedding(content, model, options = {}, instanceId) {
        const provider = await this._getProviderForModel(model, instanceId);
        if (!provider.generateEmbedding) {
            throw new Error(`Provider does not support embeddings`);
        }
        return provider.generateEmbedding(content, model, options);
    }
    async captionImage(images, prompt, model, systemPrompt, instanceId) {
        const provider = await this._getProviderForModel(model, instanceId);
        if (!provider.captionImage) {
            throw new Error(`Provider does not support image captioning`);
        }
        return provider.captionImage(images, prompt, model, systemPrompt);
    }
    // ── Internal Helpers ────────────────────────────────────────
    /**
     * Get the provider for a model, either by explicit instance or auto-routing.
     * @private
     */
    async _getProviderForModel(model, instanceId) {
        if (instanceId) {
            const provider = getProvider(instanceId);
            if (!provider) {
                throw new Error(`No provider found for instance "${instanceId}"`);
            }
            return provider;
        }
        const resolved = await this.resolveProvider(model);
        if (!resolved) {
            throw new Error(`No local provider found serving model "${model}". ` +
                `Available instances: ${listInstances()
                    .map((i) => i.id)
                    .join(", ")}`);
        }
        logger.info(`[LocalProviderGateway] Auto-routed model "${model}" → ${resolved.instanceId} (${resolved.type})`);
        return resolved.provider;
    }
}
const gateway = new LocalProviderGateway();
export default gateway;
export { LocalProviderGateway };
//# sourceMappingURL=index.js.map