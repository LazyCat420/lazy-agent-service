import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { Router } from "express";
import logger from "../utils/logger.js";
import requireDb from "../middleware/RequireDbMiddleware.js";
import { COLLECTIONS } from "../constants.js";
import { GetVramBenchmarksQuerySchema } from "../types/index.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
const router = Router();
router.use(requireDb);
const COLLECTION = COLLECTIONS.VRAM_BENCHMARKS;
/**
 * GET /vram-benchmarks
 * Returns all benchmark entries, with optional query filters.
 *
 * Query params:
 *   settings  — filter by settings label (e.g. "default", "no-flash-attn")
 *   hostname  — filter by system.hostname
 *   ctx       — filter by contextLength (number)
 *   provider  — filter by provider string
 *   limit     — max documents (default: 2000)
 */
router.get("/", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        const parsedQuery = GetVramBenchmarksQuerySchema.parse(req.query);
        const filter = { error: null };
        if (parsedQuery.settings) {
            filter["settings.label"] = parsedQuery.settings;
        }
        if (parsedQuery.hostname) {
            filter["system.hostname"] = parsedQuery.hostname;
        }
        if (parsedQuery.context !== undefined) {
            filter.contextLength = parsedQuery.context;
        }
        if (parsedQuery.provider) {
            filter.provider = parsedQuery.provider;
        }
        const limit = Math.min(parsedQuery.limit, 10000);
        // Full projection — includes all measurement fields from the benchmark script
        const projection = {
            _id: 0,
            // Identity
            displayName: 1,
            model: 1,
            provider: 1,
            runId: 1,
            // Model metadata
            contextLength: 1,
            architecture: 1,
            quantization: 1,
            bitsPerWeight: 1,
            fileSizeGB: 1,
            fileSizeBytes: 1,
            archParams: 1,
            modality: 1,
            // Settings applied for this run
            settings: 1,
            // Core VRAM measurements
            baselineVramMiB: 1,
            loadedVramMiB: 1,
            modelVramMiB: 1,
            modelVramGiB: 1,
            estimatedGiB: 1,
            deltaGiB: 1,
            fitsInVram: 1,
            // Generation performance
            generation: 1,
            tokensPerSecond: 1,
            loadTimeMs: 1,
            // GPU snapshot during benchmark
            gpu: 1,
            // Extended measurements
            ttft: 1,
            cpuRam: 1,
            vramDuringGen: 1,
            gpuBandwidth: 1,
            hysteresis: 1,
            // System profile (hardware fingerprint)
            "system.hostname": 1,
            "system.os": 1,
            "system.gpu": 1,
            "system.cpu": 1,
            "system.ram": 1,
            "system.motherboard": 1,
            createdAt: 1,
        };
        const docs = await db
            .collection(COLLECTION)
            .find(filter, { projection })
            .sort({ modelVramGiB: 1 })
            .limit(limit)
            .toArray();
        res.json({ count: docs.length, data: docs });
    }
    catch (error) {
        logger.error(`GET /vram-benchmarks error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
/**
 * GET /vram-benchmarks/machines
 * Returns distinct machines that have run benchmarks.
 */
router.get("/machines", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        const pipeline = [
            { $match: { "system.hostname": { $exists: true } } },
            {
                $group: {
                    _id: "$system.hostname",
                    gpu: { $first: "$system.gpu.name" },
                    gpuVramMiB: { $first: "$system.gpu.totalMiB" },
                    gpuVendor: { $first: "$system.gpu.vendor" },
                    gpuDriver: { $first: "$system.gpu.driver" },
                    cpu: { $first: "$system.cpu.model" },
                    ramGiB: { $first: "$system.ram.totalGiB" },
                    ramSpeedMHz: { $first: "$system.ram.speedMHz" },
                    ramType: { $first: "$system.ram.type" },
                    platform: { $first: "$system.os.platform" },
                    motherboard: { $first: "$system.motherboard.product" },
                    benchmarkCount: { $sum: 1 },
                    lastRun: { $max: "$createdAt" },
                },
            },
            { $sort: { benchmarkCount: -1 } },
        ];
        const machines = await db
            .collection(COLLECTION)
            .aggregate(pipeline)
            .toArray();
        res.json(machines.map((message) => ({
            hostname: message._id,
            gpu: message.gpu,
            gpuVramGB: message.gpuVramMiB
                ? Math.round(message.gpuVramMiB / 1024)
                : null,
            gpuVendor: message.gpuVendor || null,
            gpuDriver: message.gpuDriver || null,
            cpu: message.cpu,
            ramGiB: message.ramGiB,
            ramSpeedMHz: message.ramSpeedMHz || null,
            ramType: message.ramType || null,
            platform: message.platform || null,
            motherboard: message.motherboard || null,
            benchmarkCount: message.benchmarkCount,
            lastRun: message.lastRun,
        })));
    }
    catch (error) {
        logger.error(`GET /vram-benchmarks/machines error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
/**
 * GET /vram-benchmarks/settings
 * Returns distinct settings labels available in the benchmark data.
 */
router.get("/settings", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        const labels = (await db
            .collection(COLLECTION)
            .distinct("settings.label", { error: null }));
        // Sort with "default" first, then alphabetically
        labels.sort((firstItem, b) => {
            if (firstItem === "default")
                return -1;
            if (b === "default")
                return 1;
            return firstItem.localeCompare(b);
        });
        res.json(labels);
    }
    catch (error) {
        logger.error(`GET /vram-benchmarks/settings error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
/**
 * GET /vram-benchmarks/contexts
 * Returns distinct context lengths available in the benchmark data.
 */
router.get("/contexts", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        const filter = { error: null };
        if (req.query.settings && typeof req.query.settings === "string") {
            filter["settings.label"] = req.query.settings;
        }
        const contexts = (await db
            .collection(COLLECTION)
            .distinct("contextLength", filter));
        contexts.sort((firstItem, b) => firstItem - b);
        res.json(contexts);
    }
    catch (error) {
        logger.error(`GET /vram-benchmarks/contexts error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
export default router;
//# sourceMappingURL=VramBenchmarksRoutes.js.map