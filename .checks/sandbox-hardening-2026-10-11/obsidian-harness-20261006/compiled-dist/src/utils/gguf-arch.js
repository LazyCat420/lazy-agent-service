// ── GGUF Architecture Parameters ─────────────────────────────
// Lookup table for model architecture parameters required for
// VRAM estimation. Values verified from HuggingFace config.json.
//
// The KV cache formula is:
//   KV_bytes = 2 × effective_layers × kv_heads × head_dim × bytes_per_el × ctx_len
//
// For hybrid architectures (Mamba/SSM, linear attention), only a
// fraction of layers have KV caches (controlled by attnRatio).
const ARCH_DB = {
    // Llama family (Meta)
    llama: [
        { minB: 0, maxB: 2, layers: 16, kvHeads: 8, headDim: 64 },
        { minB: 2, maxB: 5, layers: 16, kvHeads: 8, headDim: 64 },
        { minB: 5, maxB: 10, layers: 32, kvHeads: 8, headDim: 128 },
        { minB: 10, maxB: 18, layers: 40, kvHeads: 8, headDim: 128 },
        { minB: 18, maxB: 28, layers: 48, kvHeads: 8, headDim: 128 },
        { minB: 28, maxB: 50, layers: 48, kvHeads: 8, headDim: 128 },
        { minB: 50, maxB: 80, layers: 80, kvHeads: 8, headDim: 128 },
        { minB: 80, maxB: 500, layers: 126, kvHeads: 8, headDim: 128 },
    ],
    mllama: [
        { minB: 0, maxB: 15, layers: 40, kvHeads: 8, headDim: 128 },
        { minB: 15, maxB: 100, layers: 100, kvHeads: 8, headDim: 128 },
    ],
    // Qwen2 family (Alibaba)
    qwen2: [
        { minB: 0, maxB: 2, layers: 24, kvHeads: 2, headDim: 64 },
        { minB: 2, maxB: 5, layers: 36, kvHeads: 4, headDim: 128 },
        { minB: 5, maxB: 10, layers: 28, kvHeads: 4, headDim: 128 },
        { minB: 10, maxB: 20, layers: 48, kvHeads: 4, headDim: 128 },
        { minB: 20, maxB: 40, layers: 64, kvHeads: 8, headDim: 128 },
        { minB: 40, maxB: 80, layers: 80, kvHeads: 8, headDim: 128 },
    ],
    qwen2vl: [
        { minB: 0, maxB: 5, layers: 28, kvHeads: 4, headDim: 128 },
        { minB: 5, maxB: 10, layers: 28, kvHeads: 4, headDim: 128 },
        { minB: 10, maxB: 80, layers: 80, kvHeads: 8, headDim: 128 },
    ],
    // Qwen3 family
    qwen3: [
        { minB: 0, maxB: 1, layers: 28, kvHeads: 2, headDim: 64 },
        { minB: 1, maxB: 3, layers: 28, kvHeads: 4, headDim: 64 },
        { minB: 3, maxB: 6, layers: 36, kvHeads: 8, headDim: 128 },
        { minB: 6, maxB: 12, layers: 36, kvHeads: 8, headDim: 128 },
        { minB: 12, maxB: 20, layers: 40, kvHeads: 8, headDim: 128 },
        { minB: 20, maxB: 40, layers: 64, kvHeads: 8, headDim: 128 },
        { minB: 40, maxB: 80, layers: 94, kvHeads: 8, headDim: 128 },
        { minB: 80, maxB: 300, layers: 94, kvHeads: 8, headDim: 128 },
    ],
    qwen3moe: [{ minB: 0, maxB: 40, layers: 48, kvHeads: 4, headDim: 128 }],
    // Qwen3.5 (hybrid: linear_attention + full_attention)
    qwen35: [
        {
            minB: 0,
            maxB: 12,
            layers: 32,
            kvHeads: 4,
            headDim: 256,
            attnRatio: 0.25,
        },
        {
            minB: 12,
            maxB: 25,
            layers: 40,
            kvHeads: 4,
            headDim: 256,
            attnRatio: 0.25,
        },
        {
            minB: 25,
            maxB: 40,
            layers: 64,
            kvHeads: 4,
            headDim: 256,
            attnRatio: 0.25,
        },
    ],
    qwen35moe: [
        {
            minB: 0,
            maxB: 50,
            layers: 48,
            kvHeads: 4,
            headDim: 128,
            attnRatio: 0.25,
        },
    ],
    qwen3vl: [
        { minB: 0, maxB: 5, layers: 32, kvHeads: 4, headDim: 128 },
        { minB: 5, maxB: 12, layers: 32, kvHeads: 4, headDim: 128 },
    ],
    qwen3vlmoe: [{ minB: 0, maxB: 50, layers: 48, kvHeads: 4, headDim: 128 }],
    // Gemma family (Google) — verified from HF config
    gemma3: [
        { minB: 0, maxB: 3, layers: 26, kvHeads: 4, headDim: 256 },
        { minB: 3, maxB: 6, layers: 34, kvHeads: 4, headDim: 256 },
        { minB: 6, maxB: 16, layers: 48, kvHeads: 4, headDim: 256 },
        { minB: 16, maxB: 50, layers: 62, kvHeads: 16, headDim: 128 },
    ],
    gemma4: [
        { minB: 0, maxB: 16, layers: 34, kvHeads: 4, headDim: 256 },
        { minB: 16, maxB: 50, layers: 48, kvHeads: 4, headDim: 256 },
    ],
    // Granite (IBM)
    granite: [
        { minB: 0, maxB: 5, layers: 32, kvHeads: 8, headDim: 128 },
        { minB: 5, maxB: 12, layers: 40, kvHeads: 8, headDim: 128 },
        { minB: 12, maxB: 40, layers: 52, kvHeads: 8, headDim: 128 },
    ],
    // GraniteHybrid: Mamba-2 + attention (9:1 ratio) — verified from HF config
    granitehybrid: [
        { minB: 0, maxB: 12, layers: 40, kvHeads: 4, headDim: 128, attnRatio: 0.1 },
        {
            minB: 12,
            maxB: 40,
            layers: 40,
            kvHeads: 8,
            headDim: 128,
            attnRatio: 0.1,
        },
    ],
    // Mistral family
    mistral: [
        { minB: 0, maxB: 10, layers: 32, kvHeads: 8, headDim: 128 },
        { minB: 10, maxB: 30, layers: 56, kvHeads: 8, headDim: 128 },
    ],
    mistral3: [{ minB: 0, maxB: 30, layers: 56, kvHeads: 8, headDim: 128 }],
    // Nemotron (NVIDIA) — Mamba-2 hybrid — verified from HF config
    nemotron_h: [
        { minB: 0, maxB: 6, layers: 32, kvHeads: 8, headDim: 128, attnRatio: 0.08 },
        {
            minB: 6,
            maxB: 12,
            layers: 52,
            kvHeads: 8,
            headDim: 128,
            attnRatio: 0.08,
        },
    ],
    nemotron_h_moe: [
        {
            minB: 0,
            maxB: 40,
            layers: 54,
            kvHeads: 8,
            headDim: 128,
            attnRatio: 0.08,
        },
    ],
    // LFM2 (Liquid AI) — Hybrid architecture
    lfm2: [
        { minB: 0, maxB: 2, layers: 24, kvHeads: 4, headDim: 64, attnRatio: 0.25 },
        { minB: 2, maxB: 5, layers: 28, kvHeads: 4, headDim: 80, attnRatio: 0.25 },
    ],
};
export function resolveArchParams(architecture, paramsString, sizeBytes, bitsPerWeight = 4) {
    let billions = 0;
    if (paramsString) {
        const match = paramsString.match(/([\d.]+)\s*[Bb]/);
        if (match)
            billions = parseFloat(match[1]);
    }
    if (!billions && sizeBytes > 0 && bitsPerWeight > 0) {
        billions = (sizeBytes * 8) / (bitsPerWeight * 1e9);
    }
    if (billions <= 0)
        billions = 7;
    const archKey = architecture?.toLowerCase() || "";
    const variants = ARCH_DB[archKey];
    if (variants) {
        for (const value of variants) {
            if (billions >= value.minB && billions < value.maxB) {
                return {
                    layers: value.layers,
                    kvHeads: value.kvHeads,
                    headDim: value.headDim,
                    attnRatio: value.attnRatio ?? 1.0,
                    isKnown: true,
                };
            }
        }
        const last = variants[variants.length - 1];
        return {
            layers: last.layers,
            kvHeads: last.kvHeads,
            headDim: last.headDim,
            attnRatio: last.attnRatio ?? 1.0,
            isKnown: true,
        };
    }
    // Fallback: generic estimate from param count
    let layers, kvHeads, headDim;
    if (billions < 2) {
        layers = 24;
        kvHeads = 4;
        headDim = 64;
    }
    else if (billions < 5) {
        layers = 32;
        kvHeads = 4;
        headDim = 128;
    }
    else if (billions < 10) {
        layers = 32;
        kvHeads = 8;
        headDim = 128;
    }
    else if (billions < 20) {
        layers = 40;
        kvHeads = 8;
        headDim = 128;
    }
    else if (billions < 40) {
        layers = 64;
        kvHeads = 8;
        headDim = 128;
    }
    else if (billions < 80) {
        layers = 80;
        kvHeads = 8;
        headDim = 128;
    }
    else {
        layers = 96;
        kvHeads = 8;
        headDim = 128;
    }
    return { layers, kvHeads, headDim, attnRatio: 1.0, isKnown: false };
}
const GiB = 1024 ** 3;
/**
 * Estimate VRAM usage for a GGUF model.
 *
 * Overhead constants calibrated against real RTX 4090 benchmark data
 * (38 models, flash_attention=true, offload_kv_cache=true, 4096 ctx).
 *
 * Key findings from calibration (2026-04-03):
 *   - CUDA context + compute buffers ≈ 0.8 GiB (was 0.5)
 *   - Small models (<3GB file) have ~0.4 GiB extra proportional overhead
 *   - Vision models carry an encoder surcharge (~0.7–1.0 GiB)
 *   - Models near VRAM limits get partially CPU-offloaded by LM Studio
 *     silently, so raw estimate can exceed actual usage by 1–3 GiB
 */
export function estimateMemory({ sizeBytes, archParams, gpuLayers, contextLength, offloadKvCache = true, flashAttention = true, vision = false, gpuTotalGiB, gpuBaselineGiB = 0, }) {
    if (!sizeBytes || !archParams)
        return { gpuGiB: 0, totalGiB: 0, cpuOffloaded: false };
    const { layers, kvHeads, headDim, attnRatio } = archParams;
    const fileSizeGiB = sizeBytes / GiB;
    const ratio = Math.min(gpuLayers / layers, 1);
    const weightsOnGPU = fileSizeGiB * ratio;
    const weightsOnCPU = fileSizeGiB * (1 - ratio);
    // KV cache: 2 (K+V) × effective_layers × kv_heads × head_dim × bytes_per_el × ctx_len
    // Flash attention → Q8_0 (1 byte), no flash → FP32 (4 bytes)
    const effectiveKvLayers = Math.round(layers * attnRatio);
    const bytesPerElement = flashAttention ? 1 : 4;
    const kvCacheGiB = (2 *
        effectiveKvLayers *
        kvHeads *
        headDim *
        bytesPerElement *
        contextLength) /
        GiB;
    // ── CUDA context + compute buffer overhead ────────────────
    // Calibrated: 0.8 GiB base (benchmarked: avg Δ minimized at 0.8–0.9).
    // Small models (<3 GiB file) carry proportionally more overhead from
    // CUDA context, scratch buffers, and the llama.cpp compute graph.
    let overhead = 0;
    if (gpuLayers > 0) {
        overhead = 0.8;
        // Small-model surcharge: below 3 GB file size, add up to 0.4 GiB extra
        // (benchmarked: 0.6B model had +0.69G Δ with 0.5G overhead → needs ~1.2G)
        if (fileSizeGiB < 3) {
            overhead += 0.4 * (1 - fileSizeGiB / 3);
        }
    }
    // ── Vision encoder surcharge ──────────────────────────────
    // Vision models (qwen3vl, gemma3-12b, llava, etc.) carry a vision
    // encoder that isn't captured by the GGUF weights-only file size.
    // Benchmarked: +0.7 to +1.7 GiB extra, scales roughly with model size.
    let visionOverhead = 0;
    if (vision && gpuLayers > 0) {
        // ~0.7 GiB base + ~2.5% of file size for larger encoders
        visionOverhead = 0.7 + fileSizeGiB * 0.025;
    }
    let gpuGiB = weightsOnGPU +
        (offloadKvCache ? kvCacheGiB : 0) +
        overhead +
        visionOverhead;
    const totalGiB = gpuGiB + weightsOnCPU + (!offloadKvCache ? kvCacheGiB : 0);
    // ── Auto-offload clamping ─────────────────────────────────
    // LM Studio silently CPU-offloads layers when a model exceeds
    // available VRAM. If we know the GPU budget, clamp the GPU estimate.
    // (benchmarked: 20.6 GB qwen2 q4_1 estimated 20.2G but actual was 18.5G
    //  because ~2G of weights were silently moved to CPU)
    let cpuOffloaded = false;
    if (gpuTotalGiB && gpuTotalGiB > 0) {
        const availableGiB = gpuTotalGiB - gpuBaselineGiB;
        if (gpuGiB > availableGiB) {
            gpuGiB = availableGiB;
            cpuOffloaded = true;
        }
    }
    return {
        gpuGiB: Math.max(0, gpuGiB),
        totalGiB: Math.max(0, totalGiB),
        cpuOffloaded,
    };
}
//# sourceMappingURL=gguf-arch.js.map