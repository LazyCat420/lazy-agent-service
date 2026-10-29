import { resolveArchParams, estimateMemory } from "../../utils/gguf-arch.js";
import { getProvider } from "../../providers/index.js";
/**
 * Estimate VRAM usage for a GGUF model served by a local provider.
 * Primarily useful for LM Studio models that report GGUF metadata.
 */
export function estimateVRAM(modelData, options = {}) {
    if (!modelData)
        return null;
    const sizeBytes = modelData.size_bytes || 0;
    if (!sizeBytes)
        return null;
    const bitsPerWeight = modelData.quantization?.bits_per_weight || 4;
    const archParams = resolveArchParams(modelData.architecture || "", modelData.params_string || "", sizeBytes, bitsPerWeight);
    const totalLayers = archParams.layers;
    const memory = estimateMemory({
        sizeBytes,
        archParams,
        gpuLayers: options.gpuLayers ?? totalLayers,
        contextLength: options.contextLength ?? 4096,
        offloadKvCache: options.offloadKvCache ?? true,
        flashAttention: options.flashAttention ?? true,
        vision: !!modelData.capabilities?.vision,
        gpuTotalGiB: options.gpuTotalGiB,
        gpuBaselineGiB: options.gpuBaselineGiB || 0,
    });
    return {
        ...memory,
        archParams,
        totalLayers,
    };
}
/**
 * Estimate VRAM for a model by its key on a specific instance.
 * Fetches model metadata from the provider, then runs estimateVRAM.
 */
export async function estimateVRAMForModel(instanceId, modelKey, options = {}) {
    const provider = getProvider(instanceId);
    if (!provider?.listModels)
        return null;
    const result = await provider.listModels();
    const allModels = result?.data || result?.models || [];
    const modelData = allModels.find((modelEntry) => modelEntry.id === modelKey ||
        modelEntry.path === modelKey ||
        modelEntry.key === modelKey);
    if (!modelData)
        return null;
    return estimateVRAM(modelData, options);
}
//# sourceMappingURL=vramEstimation.js.map