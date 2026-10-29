import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import { getProvider } from "../../providers/index.js";
import { PROVIDERS } from "../../constants.js";
import { resolveArchParams, estimateMemory } from "../../utils/gguf-arch.js";
import logger from "../../utils/logger.js";
import { getErrorMessage } from "../../utils/ErrorHelpers.js";
const router = express.Router();
// ─── GET /lm-studio/models ──────────────────────────
router.get("/models", asyncHandler(async (_req, res, next) => {
    try {
        const provider = getProvider(PROVIDERS.LM_STUDIO);
        const data = await provider.listModels();
        res.json(data);
    }
    catch (error) {
        logger.error(`Admin /lm-studio/models error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
// ─── POST /lm-studio/load ───────────────────────────
router.post("/load", asyncHandler(async (req, res, next) => {
    try {
        const { model, context_length, flash_attention, offload_kv_cache_to_gpu, eval_batch_size, parallel, unified_kv_cache, } = req.body;
        if (!model) {
            return res
                .status(400)
                .json({ error: "Missing 'model' in request body" });
        }
        const provider = getProvider(PROVIDERS.LM_STUDIO);
        const loadOptions = {};
        if (context_length != null)
            loadOptions.context_length = context_length;
        if (flash_attention != null)
            loadOptions.flash_attention = flash_attention;
        if (offload_kv_cache_to_gpu != null)
            loadOptions.offload_kv_cache_to_gpu = offload_kv_cache_to_gpu;
        if (eval_batch_size != null)
            loadOptions.eval_batch_size = eval_batch_size;
        if (parallel != null)
            loadOptions.parallel = parallel;
        if (unified_kv_cache != null)
            loadOptions.unified_kv_cache = unified_kv_cache;
        const { alreadyLoaded } = await provider.ensureModelLoaded(model, loadOptions);
        if (alreadyLoaded) {
            logger.info(`[admin/lm-studio/load] Model ${model} already loaded — skipping`);
        }
        res.json({ model, alreadyLoaded });
    }
    catch (error) {
        logger.error(`Admin /lm-studio/load error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
// ─── POST /lm-studio/unload ────────────────────────
router.post("/unload", asyncHandler(async (req, res, next) => {
    try {
        const { instance_id } = req.body;
        if (!instance_id) {
            return res.status(400).json({
                error: "Missing 'instance_id' in request body",
            });
        }
        const provider = getProvider(PROVIDERS.LM_STUDIO);
        await provider.unloadModel(instance_id);
        res.json({ success: true, instance_id });
    }
    catch (error) {
        logger.error(`Admin /lm-studio/unload error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
// ─── POST /lm-studio/estimate ──────────────────────
router.post("/estimate", asyncHandler(async (req, res, next) => {
    try {
        const { model, contextLength, gpuLayers, flashAttention, offloadKvCache, } = req.body;
        if (!model) {
            return res
                .status(400)
                .json({ error: "Missing 'model' in request body" });
        }
        const provider = getProvider(PROVIDERS.LM_STUDIO);
        const result = await provider.listModels();
        const allModels = result?.data || result?.models || [];
        const modelData = allModels.find((entry) => entry.id === model || entry.key === model);
        if (!modelData) {
            return res.status(404).json({ error: `Model '${model}' not found` });
        }
        const sizeBytes = modelData.size_bytes || 0;
        const bitsPerWeight = modelData.quantization?.bits_per_weight || 4;
        const archParams = resolveArchParams(modelData.architecture, modelData.params_string, sizeBytes, bitsPerWeight);
        const totalLayers = archParams.layers;
        const memory = estimateMemory({
            sizeBytes,
            archParams,
            gpuLayers: gpuLayers ?? totalLayers,
            contextLength: contextLength ?? 4096,
            offloadKvCache: offloadKvCache ?? true,
            flashAttention: flashAttention ?? true,
            vision: modelData.capabilities?.vision || false,
        });
        res.json({
            ...memory,
            archParams,
            totalLayers,
        });
    }
    catch (error) {
        logger.error(`Admin /lm-studio/estimate error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
export default router;
//# sourceMappingURL=AdminLmStudioRoutes.js.map