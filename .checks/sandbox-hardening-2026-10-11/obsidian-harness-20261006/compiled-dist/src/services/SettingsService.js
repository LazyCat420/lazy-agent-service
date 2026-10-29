import { DEFAULT_TOPOLOGY } from "@rodrigo-barraza/utilities-library/taxonomy";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { deepMerge } from "@rodrigo-barraza/utilities-library";
import { MONGO_DB_NAME } from "../../config.js";
import { COLLECTIONS, PROVIDERS } from "../constants.js";
import { MODELS } from "../config.js";
import logger from "../utils/logger.js";
let _cache = null;
const DEFAULTS = {
    memory: {
        extractionProvider: "",
        extractionModel: "",
        consolidationProvider: "",
        consolidationModel: "",
        embeddingProvider: "",
        embeddingModel: "",
    },
    agents: {
        subAgentProvider: "",
        subAgentModel: "",
        criticProvider: "",
        criticModel: "",
        reminderProvider: "",
        reminderModel: "",
        harness: "standard",
        topology: DEFAULT_TOPOLOGY,
        dynamicToolActivation: true,
        locale: "en",
    },
    security: {
        allowEnvFiles: false,
    },
    creative: {
        imageProvider: PROVIDERS.GOOGLE,
        imageModel: MODELS.GEMINI_3_PRO_IMAGE.name,
        visionProvider: PROVIDERS.VLLM,
        visionModel: "",
        textToSpeechProvider: PROVIDERS.ELEVENLABS,
        textToSpeechModel: "",
        speechToTextProvider: PROVIDERS.OPENAI,
        speechToTextModel: "",
    },
    somatic: {
        emotionProvider: "",
        emotionModel: "",
    },
};
// ─── Service ──────────────────────────────────────────────────────────────────
/**
 * SettingsService — server-side settings store backed by MongoDB.
 *
 * Stores a single document (keyed by `_key: "global"`) in the `settings`
 * collection. Uses an in-memory cache to avoid DB round-trips on the
 * hot path (embedding generation, memory extraction).
 */
const SettingsService = {
    async get() {
        if (_cache)
            return _cache;
        try {
            const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.SETTINGS);
            if (!collection)
                return { ...DEFAULTS };
            const document = await collection.findOne({ _key: "global" });
            if (!document) {
                _cache = { ...DEFAULTS };
                return _cache;
            }
            // Deep merge: defaults ← stored
            _cache = deepMerge(DEFAULTS, (document.data || {}));
            return _cache;
        }
        catch (error) {
            logger.warn(`[SettingsService] Failed to load settings from database: ${error instanceof Error ? error.message : String(error)}. Falling back to defaults.`);
            return { ...DEFAULTS };
        }
    },
    async getSection(section) {
        const settings = await this.get();
        const sectionData = settings[section] || DEFAULTS[section];
        // Runtime migration: Override legacy LM Studio Qwen vision configs to VLLM
        if (section === "creative" && sectionData) {
            const creative = sectionData;
            if (creative.visionProvider === PROVIDERS.LM_STUDIO &&
                creative.visionModel?.toLowerCase().includes("qwen")) {
                creative.visionProvider = PROVIDERS.VLLM;
                creative.visionModel = "";
            }
        }
        return sectionData;
    },
    async update(data) {
        const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.SETTINGS);
        if (!collection)
            throw new Error("Database not available");
        const current = await this.get();
        const merged = deepMerge(current, data);
        await collection.updateOne({ _key: "global" }, {
            $set: {
                data: merged,
                updatedAt: new Date().toISOString(),
            },
            $setOnInsert: {
                _key: "global",
                createdAt: new Date().toISOString(),
            },
        }, { upsert: true });
        // Invalidate cache
        _cache = merged;
        logger.info("[SettingsService] Settings updated and cache refreshed");
        return merged;
    },
    /**
     * Resolve provider + model for a memory subsystem role.
     * Centralises the identical getXxxConfig() helpers in MemoryService,
     * MemoryConsolidationService, and EmbeddingService.
     */
    async getMemoryModelConfig(role) {
        const memorySettings = await this.getSection("memory");
        const provider = memorySettings?.[`${role}Provider`];
        const model = memorySettings?.[`${role}Model`];
        if (!provider || !model) {
            throw new Error(`${role} model not configured — set it in Settings → Memory Models`);
        }
        return { provider, model };
    },
    async getSomaticModelConfig() {
        const somaticSettings = await this.getSection("somatic");
        const provider = somaticSettings?.emotionProvider;
        const model = somaticSettings?.emotionModel;
        if (!provider || !model) {
            return null;
        }
        return { provider, model };
    },
    invalidateCache() {
        _cache = null;
    },
    getCached() {
        return _cache || { ...DEFAULTS };
    },
    getDefaults() {
        return { ...DEFAULTS };
    },
};
// deepMerge — imported from @rodrigo-barraza/utilities-library
export default SettingsService;
//# sourceMappingURL=SettingsService.js.map