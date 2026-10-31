import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { sleep } from "@rodrigo-barraza/utilities-library";
import express, { Request, Response, NextFunction } from "express";
import { getProvider } from "../providers/index.ts";
import type { LmStudioProvider } from "../providers/lm-studio.ts";
import { isInstance } from "../providers/instance-registry.ts";
import { PROVIDERS } from "../constants.ts";
import logger from "../utils/logger.ts";
import LocalProviderGateway from "../services/local-provider/index.ts";
import { initSseResponse } from "../utils/SseUtilities.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import type { ProviderOptions } from "../types/provider.ts";
const router = express.Router();
/** Resolve instance ID from request — supports ?instance=lm-studio-2 */
function resolveInstanceId(req: Request) {
  const id =
    (req.query.instance as string) ||
    (req.body as Record<string, unknown>)?.instance ||
    PROVIDERS.LM_STUDIO;
  // Validate it's actually a registered instance
  if (!isInstance(id as string)) return PROVIDERS.LM_STUDIO;
  return id as string;
}
/**
 * GET /lm-studio/models
 * List all models available from LM Studio.
 */
router.get(
  "/models",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const instanceId = resolveInstanceId(req);
      const provider = getProvider(instanceId) as LmStudioProvider;
      const data = await provider.listModels();
      res.json(data);
    } catch (error: unknown) {
      logger.error(`GET /lm-studio/models error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);
/**
 * POST /lm-studio/load
 * Load a model into LM Studio.
 * Body: { model: "model-key" }
 */
router.post(
  "/load",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        model,
        context_length,
        flash_attention,
        offload_kv_cache_to_gpu,
        eval_batch_size,
        parallel,
        unified_kv_cache,
      } = req.body;
      if (!model) {
        return res
          .status(400)
          .json({ error: "Missing 'model' in request body" });
      }
      const instanceId = resolveInstanceId(req);
      const provider = getProvider(instanceId) as LmStudioProvider;
      // Build load options from request body
      const loadOptions: ProviderOptions = {};
      if (context_length != null) loadOptions.context_length = context_length;
      if (flash_attention != null)
        loadOptions.flash_attention = flash_attention;
      if (offload_kv_cache_to_gpu != null)
        loadOptions.offload_kv_cache_to_gpu = offload_kv_cache_to_gpu;
      if (eval_batch_size != null)
        loadOptions.eval_batch_size = eval_batch_size;
      if (parallel != null) loadOptions.parallel = parallel;
      if (unified_kv_cache != null)
        loadOptions.unified_kv_cache = unified_kv_cache;
      // ensureModelLoaded handles: skip if already loaded, unload others, then load
      const { alreadyLoaded } = await provider.ensureModelLoaded(
        model,
        loadOptions,
      );
      if (alreadyLoaded) {
        logger.info(
          `[/lm-studio/load] Model ${model} already loaded — skipping`,
        );
        return res.json({ model, alreadyLoaded: true });
      }
      res.json({ model, alreadyLoaded: false });
    } catch (error: unknown) {
      logger.error(`POST /lm-studio/load error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);
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
/** Only pass the load options the caller actually supplied. */
function buildStreamLoadOptions(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const {
    context_length,
    flash_attention,
    offload_kv_cache_to_gpu,
    eval_batch_size,
    parallel,
    unified_kv_cache,
  } = body;
  const loadOptions: Record<string, unknown> = {};
  if (context_length != null) loadOptions.context_length = context_length;
  if (flash_attention != null) loadOptions.flash_attention = flash_attention;
  if (offload_kv_cache_to_gpu != null)
    loadOptions.offload_kv_cache_to_gpu = offload_kv_cache_to_gpu;
  if (eval_batch_size != null)
    loadOptions.eval_batch_size = eval_batch_size;
  if (parallel != null) loadOptions.parallel = parallel;
  if (unified_kv_cache != null)
    loadOptions.unified_kv_cache = unified_kv_cache;
  return loadOptions;
}

/** Quick check: skip an already-loaded model, else unload every other loaded model. */
async function checkAndUnloadModels(
  provider: LmStudioProvider,
  model: string,
  send: (data: Record<string, unknown>) => void,
): Promise<boolean> {
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
    } else {
      // Unload any other loaded models first (single-model enforcement)
      for (const message of models || []) {
        for (const inst of message.loaded_instances || []) {
          send({ type: "unloading", model: message.key });
          logger.info(
            `[load-stream] Auto-unloading ${inst.id} before loading ${model}`,
          );
          await provider.unloadModel(inst.id);
        }
      }
    }
  } catch (listError: unknown) {
    logger.warn(
      `[load-stream] Could not check models before loading: ${getErrorMessage(listError)}`,
    );
  }
  return needsLoad;
}

/** Fire the load in the background and emit synthetic progress until it settles. */
async function loadModelWithProgress(
  provider: LmStudioProvider,
  model: string,
  loadOptions: Record<string, unknown>,
  send: (data: Record<string, unknown>) => void,
  isAborted: () => boolean,
): Promise<Record<string, unknown> | null> {
  let loadDone = false;
  let loadError: Record<string, unknown> | null = null;
  const loadPromise = provider
    .loadModel(model, loadOptions)
    .then(() => {
      loadDone = true;
    })
    .catch((error: Record<string, unknown>) => {
      loadDone = true;
      loadError = error;
    });
  const startTime = Date.now();
  const EXPECTED_LOAD_MS = 15_000;
  let lastPercentage = 0;
  while (!loadDone && !isAborted()) {
    await sleep(300);
    if (loadDone || isAborted()) break;
    const elapsed = Date.now() - startTime;
    const percentage = Math.min(
      0.95,
      elapsed / (elapsed + EXPECTED_LOAD_MS),
    );
    if (percentage > lastPercentage + 0.005) {
      lastPercentage = percentage;
      send({
        type: "progress",
        progress: parseFloat(percentage.toFixed(3)),
      });
    }
  }
  await loadPromise;
  return loadError;
}

router.post(
  "/load-stream",
  asyncHandler(async (req: Request, res: Response) => {
    const { model } = req.body;
    if (!model) {
      return res.status(400).json({ error: "Missing 'model' in request body" });
    }
    // Set up SSE — use setHeader pattern (not writeHead) to match /chat endpoint
    res.setHeader("X-Accel-Buffering", "no");
    initSseResponse(res);
    const send = (data: Record<string, unknown>) => {
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
      const provider = getProvider(instanceId) as LmStudioProvider;
      send({ type: "start", model });
      const loadOptions = buildStreamLoadOptions(req.body);
      if (aborted) return res.end();
      // Check if model is already loaded and unload others if needed
      // (non-streaming part — quick check + unload)
      const needsLoad = await checkAndUnloadModels(provider, model, send);
      if (!needsLoad || aborted) {
        return res.end();
      }
      send({ type: "progress", progress: 0 });
      // Fire load in background, poll for synthetic progress
      const loadError = await loadModelWithProgress(
        provider,
        model,
        loadOptions,
        send,
        () => aborted,
      );
      if (aborted) return res.end();
      if (loadError) {
        logger.error(
          `[load-stream] loadModel failed: ${getErrorMessage(loadError)}`,
        );
        send({ type: "error", message: getErrorMessage(loadError) });
      } else {
        send({ type: "progress", progress: 1 });
        send({ type: "complete" });
        logger.info(`[load-stream] Model ${model} loaded successfully`);
      }
    } catch (error: unknown) {
      logger.error(
        `POST /lm-studio/load-stream error: ${getErrorMessage(error)}`,
      );
      send({ type: "error", message: getErrorMessage(error) });
    } finally {
      if (!res.writableEnded) res.end();
    }
  }),
);
/**
 * POST /lm-studio/unload
 * Unload a model from LM Studio memory.
 * Body: { instance_id: "model-instance-id" }
 */
router.post(
  "/unload",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { instance_id } = req.body;
      if (!instance_id) {
        return res.status(400).json({
          error: "Missing 'instance_id' in request body",
        });
      }
      const instanceId = resolveInstanceId(req);
      const provider = getProvider(instanceId) as LmStudioProvider;
      await provider.unloadModel(instance_id);
      res.json({ success: true, instance_id });
    } catch (error: unknown) {
      logger.error(`POST /lm-studio/unload error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);
/**
 * POST /lm-studio/estimate
 * Estimate VRAM usage for a model with given configuration.
 * Body: { model, contextLength, gpuLayers, flashAttention, offloadKvCache }
 */
router.post(
  "/estimate",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        model,
        contextLength,
        gpuLayers,
        flashAttention,
        offloadKvCache,
      } = req.body;
      if (!model) {
        return res
          .status(400)
          .json({ error: "Missing 'model' in request body" });
      }
      // Delegate to gateway — it handles the full fetch → estimate pipeline.
      // Fall back to direct gguf-arch if we need raw model data (e.g. for
      // custom gpuLayers values from the slider).
      const instanceId = resolveInstanceId(req);
      const provider = getProvider(instanceId) as LmStudioProvider;
      const result = await provider.listModels();
      const allModels = result?.data || result?.models || [];
      const modelData = allModels.find(
        (modelItem) => modelItem.id === model || modelItem.key === model,
      );
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
    } catch (error: unknown) {
      logger.error(`POST /lm-studio/estimate error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);
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
router.get(
  "/server-props",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const instanceId = resolveInstanceId(req);
      const provider = getProvider(instanceId);
      const providerWithProps = provider as unknown as
        | { getServerProps?: () => Promise<unknown> }
        | undefined;
      if (
        !providerWithProps ||
        typeof providerWithProps.getServerProps !== "function"
      ) {
        return res.status(404).json({
          error:
            "Server props only available for llama-cpp provider instances",
        });
      }
      const serverProps = await providerWithProps.getServerProps();
      res.json(serverProps);
    } catch (error: unknown) {
      logger.error(
        `GET /lm-studio/server-props error: ${getErrorMessage(error)}`,
      );
      next(error);
    }
  }),
);
export default router;
