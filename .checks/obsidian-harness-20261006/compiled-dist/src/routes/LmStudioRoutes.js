import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { sleep } from "@rodrigo-barraza/utilities-library";
import express from "express";
import { getProvider } from "../providers/index.js";
import { isInstance } from "../providers/instance-registry.js";
import { PROVIDERS } from "../constants.js";
import logger from "../utils/logger.js";
import LocalProviderGateway from "../services/local-provider/index.js";
import { initSseResponse } from "../utils/SseUtilities.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
const router = express.Router();
/** Resolve instance ID from request — supports ?instance=lm-studio-2 */
function resolveInstanceId(req) {
    const id = req.query.instance ||
        req.body?.instance ||
        PROVIDERS.LM_STUDIO;
    // Validate it's actually a registered instance
    if (!isInstance(id))
        return PROVIDERS.LM_STUDIO;
    return id;
}
/**
 * GET /lm-studio/models
 * List all models available from LM Studio.
 */
router.get("/models", asyncHandler(async (req, res, next) => {
    try {
        const instanceId = resolveInstanceId(req);
        const provider = getProvider(instanceId);
        const data = await provider.listModels();
        res.json(data);
    }
    catch (error) {
        logger.error(`GET /lm-studio/models error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
/**
 * POST /lm-studio/load
 * Load a model into LM Studio.
 * Body: { model: "model-key" }
 */
router.post("/load", asyncHandler(async (req, res, next) => {
    try {
        const { model, context_length, flash_attention, offload_kv_cache_to_gpu, eval_batch_size, parallel, unified_kv_cache, } = req.body;
        if (!model) {
            return res
                .status(400)
                .json({ error: "Missing 'model' in request body" });
        }
        const instanceId = resolveInstanceId(req);
        const provider = getProvider(instanceId);
        // Build load options from request body
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
        // ensureModelLoaded handles: skip if already loaded, unload others, then load
        const { alreadyLoaded } = await provider.ensureModelLoaded(model, loadOptions);
        if (alreadyLoaded) {
            logger.info(`[/lm-studio/load] Model ${model} already loaded — skipping`);
            return res.json({ model, alreadyLoaded: true });
        }
        res.json({ model, alreadyLoaded: false });
    }
    catch (error) {
        logger.error(`POST /lm-studio/load error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
/**
 * POST /lm-studio/load-stream
 * Load a model into LM Studio with SSE progress streaming.
 * Fires the blocking load in the background and emits progress events.
 *
 * SSE events:
 *   { type: "start", model }
 *   { type: "unloading", model: "previous-model-key" }
 *   { type: "progress", progress: 0.0–1.0 }
 *   { type: "complete" }
 *   { type: "error", message: "..." }
 */
router.post("/load-stream", asyncHandler(async (req, res) => {
    const { model, context_length, flash_attention, offload_kv_cache_to_gpu, eval_batch_size, parallel, unified_kv_cache, } = req.body;
    if (!model) {
        return res.status(400).json({ error: "Missing 'model' in request body" });
    }
    // Set up SSE — use setHeader pattern (not writeHead) to match /chat endpoint
    res.setHeader("X-Accel-Buffering", "no");
    initSseResponse(res);
    const send = (data) => {
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
    };
    let aborted = false;
    req.on("close", () => {
        aborted = true;
    });
    try {
        const instanceId = resolveInstanceId(req);
        const provider = getProvider(instanceId);
        send({ type: "start", model });
        // Build load options
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
        if (aborted)
            return res.end();
        // Check if model is already loaded and unload others if needed
        // (non-streaming part — quick check + unload)
        let needsLoad = true;
        try {
            const { models } = await provider.listModels();
            const modelEntry = (models || []).find((entry) => entry.key === model);
            const isLoaded = (modelEntry?.loaded_instances?.length ?? 0) > 0;
            if (isLoaded) {
                // Already loaded — skip entirely
                logger.info(`[load-stream] Model ${model} already loaded — skipping`);
                send({ type: "progress", progress: 1 });
                send({ type: "complete", alreadyLoaded: true });
                needsLoad = false;
            }
            else {
                // Unload any other loaded models first (single-model enforcement)
                for (const message of models || []) {
                    for (const inst of message.loaded_instances || []) {
                        send({ type: "unloading", model: message.key });
                        logger.info(`[load-stream] Auto-unloading ${inst.id} before loading ${model}`);
                        await provider.unloadModel(inst.id);
                    }
                }
            }
        }
        catch (listError) {
            logger.warn(`[load-stream] Could not check models before loading: ${getErrorMessage(listError)}`);
        }
        if (!needsLoad || aborted) {
            return res.end();
        }
        send({ type: "progress", progress: 0 });
        // Fire load in background, poll for synthetic progress
        let loadDone = false;
        let loadError = null;
        const loadPromise = provider
            .loadModel(model, loadOptions)
            .then(() => {
            loadDone = true;
        })
            .catch((error) => {
            loadDone = true;
            loadError = error;
        });
        const startTime = Date.now();
        const EXPECTED_LOAD_MS = 15_000;
        let lastPercentage = 0;
        while (!loadDone && !aborted) {
            await sleep(300);
            if (loadDone || aborted)
                break;
            const elapsed = Date.now() - startTime;
            const percentage = Math.min(0.95, elapsed / (elapsed + EXPECTED_LOAD_MS));
            if (percentage > lastPercentage + 0.005) {
                lastPercentage = percentage;
                send({
                    type: "progress",
                    progress: parseFloat(percentage.toFixed(3)),
                });
            }
        }
        await loadPromise;
        if (aborted)
            return res.end();
        if (loadError) {
            logger.error(`[load-stream] loadModel failed: ${getErrorMessage(loadError)}`);
            send({ type: "error", message: getErrorMessage(loadError) });
        }
        else {
            send({ type: "progress", progress: 1 });
            send({ type: "complete" });
            logger.info(`[load-stream] Model ${model} loaded successfully`);
        }
    }
    catch (error) {
        logger.error(`POST /lm-studio/load-stream error: ${getErrorMessage(error)}`);
        send({ type: "error", message: getErrorMessage(error) });
    }
    finally {
        if (!res.writableEnded)
            res.end();
    }
}));
/**
 * POST /lm-studio/unload
 * Unload a model from LM Studio memory.
 * Body: { instance_id: "model-instance-id" }
 */
router.post("/unload", asyncHandler(async (req, res, next) => {
    try {
        const { instance_id } = req.body;
        if (!instance_id) {
            return res.status(400).json({
                error: "Missing 'instance_id' in request body",
            });
        }
        const instanceId = resolveInstanceId(req);
        const provider = getProvider(instanceId);
        await provider.unloadModel(instance_id);
        res.json({ success: true, instance_id });
    }
    catch (error) {
        logger.error(`POST /lm-studio/unload error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
/**
 * POST /lm-studio/estimate
 * Estimate VRAM usage for a model with given configuration.
 * Body: { model, contextLength, gpuLayers, flashAttention, offloadKvCache }
 */
router.post("/estimate", asyncHandler(async (req, res, next) => {
    try {
        const { model, contextLength, gpuLayers, flashAttention, offloadKvCache, } = req.body;
        if (!model) {
            return res
                .status(400)
                .json({ error: "Missing 'model' in request body" });
        }
        // Delegate to gateway — it handles the full fetch → estimate pipeline.
        // Fall back to direct gguf-arch if we need raw model data (e.g. for
        // custom gpuLayers values from the slider).
        const instanceId = resolveInstanceId(req);
        const provider = getProvider(instanceId);
        const result = await provider.listModels();
        const allModels = result?.data || result?.models || [];
        const modelData = allModels.find((modelItem) => modelItem.id === model || modelItem.key === model);
        if (!modelData) {
            return res.status(404).json({ error: `Model '${model}' not found` });
        }
        const estimate = LocalProviderGateway.estimateVRAM(modelData, {
            contextLength: contextLength ?? 4096,
            gpuLayers,
            flashAttention: flashAttention ?? true,
            offloadKvCache: offloadKvCache ?? true,
        });
        if (!estimate) {
            return res
                .status(400)
                .json({ error: "Could not estimate VRAM for this model" });
        }
        res.json(estimate);
    }
    catch (error) {
        logger.error(`POST /lm-studio/estimate error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
/**
 * GET /lm-studio/server-props
 * Retrieve rich runtime metadata from a llama.cpp server:
 * context configuration, slot utilization, sampling defaults,
 * model path, chat template, and modality flags.
 *
 * Query: ?instance=llama-cpp (or llama-cpp-2, etc.)
 *
 * Only available for llama-cpp provider instances — returns 404
 * for lm-studio, ollama, and vllm providers.
 */
router.get("/server-props", asyncHandler(async (req, res, next) => {
    try {
        const instanceId = resolveInstanceId(req);
        const provider = getProvider(instanceId);
        const providerWithProps = provider;
        if (!providerWithProps ||
            typeof providerWithProps.getServerProps !== "function") {
            return res.status(404).json({
                error: "Server props only available for llama-cpp provider instances",
            });
        }
        const serverProps = await providerWithProps.getServerProps();
        res.json(serverProps);
    }
    catch (error) {
        logger.error(`GET /lm-studio/server-props error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
export default router;
//# sourceMappingURL=LmStudioRoutes.js.map