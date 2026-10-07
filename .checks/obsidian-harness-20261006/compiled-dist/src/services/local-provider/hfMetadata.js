import { formatBytes } from "@rodrigo-barraza/utilities-library";
import { TYPES } from "../../config.js";
import { formatParams } from "./nameParsers.js";
const _hfCache = new Map();
const HF_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
/**
 * Fetch model metadata from HuggingFace Hub API.
 * Returns null on any failure (gated models, network errors, etc.).
 * Results are cached in-memory with a 30-minute TTL.
 */
export async function fetchHuggingFaceMetadata(modelId) {
    const cached = _hfCache.get(modelId);
    if (cached && Date.now() - cached.timestamp < HF_CACHE_TTL_MS) {
        return cached.data;
    }
    try {
        const response = await fetch(`https://huggingface.co/api/models/${modelId}`, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
            _hfCache.set(modelId, { data: null, timestamp: Date.now() });
            return null;
        }
        const data = (await response.json());
        const config = data.config || {};
        const safetensors = data.safetensors || {};
        const meta = {
            architectures: config.architectures || [],
            modelType: config.model_type || null,
            pipelineTag: data.pipeline_tag || null,
            tags: data.tags || [],
            author: data.author || null,
            totalParams: safetensors.total || null,
            totalSize: data.usedStorage || null,
            paramsByDtype: safetensors.parameters || null,
        };
        _hfCache.set(modelId, { data: meta, timestamp: Date.now() });
        return meta;
    }
    catch {
        _hfCache.set(modelId, { data: null, timestamp: Date.now() });
        return null;
    }
}
/**
 * Enrich a model entry with HuggingFace metadata if the model ID
 * looks like a HF model path (has a slash: "org/model-name").
 */
export async function enrichWithHuggingFace(entry, modelKey) {
    if (!modelKey.includes("/"))
        return entry;
    const huggingFaceMeta = await fetchHuggingFaceMetadata(modelKey).catch(() => null);
    if (!huggingFaceMeta)
        return entry;
    // Vision/video/audio override from HF tags
    if (huggingFaceMeta.pipelineTag === "image-text-to-text" ||
        huggingFaceMeta.tags.includes("multimodal") ||
        huggingFaceMeta.tags.includes("vision")) {
        entry.vision = true;
        if (!entry.inputTypes.includes(TYPES.IMAGE)) {
            entry.inputTypes.push(TYPES.IMAGE);
        }
    }
    if (huggingFaceMeta.pipelineTag === "video-text-to-text" ||
        huggingFaceMeta.tags.includes("video")) {
        if (!entry.inputTypes.includes(TYPES.VIDEO)) {
            entry.inputTypes.push(TYPES.VIDEO);
        }
    }
    if (huggingFaceMeta.pipelineTag === "audio-text-to-text" ||
        huggingFaceMeta.tags.includes("audio")) {
        if (!entry.inputTypes.includes(TYPES.AUDIO)) {
            entry.inputTypes.push(TYPES.AUDIO);
        }
    }
    // Metadata overrides
    if (huggingFaceMeta.totalParams)
        entry.params = formatParams(huggingFaceMeta.totalParams) || undefined;
    if (huggingFaceMeta.totalSize)
        entry.size = formatBytes(huggingFaceMeta.totalSize);
    if (huggingFaceMeta.architectures?.length > 0)
        entry.architecture = huggingFaceMeta.architectures[0];
    if (huggingFaceMeta.author)
        entry.publisher = huggingFaceMeta.author;
    return entry;
}
//# sourceMappingURL=hfMetadata.js.map