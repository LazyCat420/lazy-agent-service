import { DEFAULT_USERNAME } from "@rodrigo-barraza/utilities-library/taxonomy";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import { EventEmitter } from "node:events";
import BenchmarkService from "../services/BenchmarkService.js";
import logger from "../utils/logger.js";
import { createAbortController } from "../utils/AbortController.js";
import { registerCleanup } from "../utils/CleanupRegistry.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
import { BENCHMARK_PRESETS } from "../data/benchmarkPresets.js";
const router = express.Router();
// Process-level registry of in-flight benchmark runs → AbortControllers
// Used by the explicit POST /benchmark/abort/:runId endpoint.
const activeRuns = new Map();
// Pub/sub for live benchmark progress — allows reconnecting clients
// to receive events from an already-running benchmark.
const runEmitters = new Map();
const runStates = new Map();
// Shutdown cleanup — abort any running benchmarks
registerCleanup(async () => {
    if (activeRuns.size === 0)
        return;
    logger.info(`[Benchmark] Shutdown: aborting ${activeRuns.size} active run(s)`);
    for (const [id, controller] of activeRuns) {
        controller.abort();
        activeRuns.delete(id);
    }
});
// ─── GET /benchmark — List all benchmark tests for the caller's project ─
router.get("/", asyncHandler(async (req, res, next) => {
    try {
        const benchmarks = (await BenchmarkService.list(req.project || null));
        // Attach latest run summary + cumulative cost across ALL runs
        const enriched = await Promise.all(benchmarks.map(async (b) => {
            const [latestRun, allRuns] = await Promise.all([
                BenchmarkService.getLatestRun(b.id, req.project || null),
                BenchmarkService.getRuns(b.id, req.project || null),
            ]);
            const cumulativeCost = allRuns.reduce((sum, r) => sum + (r.summary?.totalCost || 0), 0);
            return {
                ...b,
                cumulativeCost,
                runCount: allRuns.length,
                latestRun: latestRun
                    ? {
                        id: latestRun.id,
                        summary: latestRun.summary,
                        completedAt: latestRun.completedAt,
                    }
                    : null,
            };
        }));
        res.json({ benchmarks: enriched, count: enriched.length });
    }
    catch (error) {
        logger.error(`GET /benchmark error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
// ─── GET /benchmark/stats — Aggregate model performance across all runs ─
// Per model+benchmark pair, only the LATEST run's result counts toward
// pass/fail/error (unique test results). Cost and latency accumulate
// across all runs for accurate historical totals.
router.get("/stats", asyncHandler(async (req, res, next) => {
    try {
        const benchmarks = (await BenchmarkService.list(req.project || null));
        // Phase 1: For each benchmark, find the latest result per model config.
        // getRuns() returns runs sorted by startedAt DESC, so the first
        // occurrence of a model key is its most recent result.
        // Composite key: "provider:model:thinking:tools:agent" so the same
        // model with different configs appears as separate rows.
        // latestResults: Map<compositeKey, Map<benchmarkId, result>>
        const latestResults = new Map();
        // allRunTotals: Map<compositeKey, { totalCost, totalLatency, runCount }>
        const allRunTotals = new Map();
        // cumulativeBenchmarks: Map<"compositeKey::benchmarkId", { name, total, passed, failed, errored }>
        const cumulativeBenchmarks = new Map();
        /** Build a composite grouping key from a result object. */
        const makeKey = (r) => {
            const thinking = r.thinkingEnabled ? "T" : "";
            const tools = r.toolsEnabled ? "F" : "";
            const agent = r.agent || "";
            return `${r.provider}:${r.model}:${thinking}:${tools}:${agent}`;
        };
        for (const b of benchmarks) {
            const runs = (await BenchmarkService.getRuns(b.id, req.project || null));
            const seenForBenchmark = new Set(); // track which model configs we've already recorded as "latest"
            for (const run of runs) {
                for (const result of (run.models || [])) {
                    const modelKey = makeKey(result);
                    // Accumulate ALL-run cost/latency regardless of dedup
                    if (!allRunTotals.has(modelKey)) {
                        allRunTotals.set(modelKey, {
                            totalCost: 0,
                            totalLatency: 0,
                            runCount: 0,
                        });
                    }
                    const runTotal = allRunTotals.get(modelKey);
                    runTotal.totalCost += result.estimatedCost || 0;
                    runTotal.totalLatency += result.latency || 0;
                    runTotal.runCount++;
                    // Accumulate ALL-run per-benchmark stats (for detail cards)
                    const cumulKey = `${modelKey}::${b.id}`;
                    if (!cumulativeBenchmarks.has(cumulKey)) {
                        cumulativeBenchmarks.set(cumulKey, {
                            name: b.name,
                            total: 0,
                            passed: 0,
                            failed: 0,
                            errored: 0,
                        });
                    }
                    const callback = cumulativeBenchmarks.get(cumulKey);
                    callback.total++;
                    if (result.error)
                        callback.errored++;
                    else if (result.passed)
                        callback.passed++;
                    else
                        callback.failed++;
                    // Only record the first (latest) result per model config per benchmark
                    if (seenForBenchmark.has(cumulKey))
                        continue;
                    seenForBenchmark.add(cumulKey);
                    if (!latestResults.has(modelKey)) {
                        latestResults.set(modelKey, new Map());
                    }
                    latestResults.get(modelKey).set(b.id, {
                        benchmarkId: b.id,
                        benchmarkName: b.name,
                        provider: result.provider,
                        model: result.model,
                        label: result.label || result.model,
                        thinkingEnabled: result.thinkingEnabled || false,
                        toolsEnabled: result.toolsEnabled || false,
                        agent: result.agent || null,
                        passed: result.passed,
                        error: result.error,
                    });
                }
            }
        }
        // Phase 2: Build per-model-config stats from deduplicated latest results
        const models = [...latestResults.entries()].map(([modelKey, benchmarkMap]) => {
            const benchmarkResults = [...benchmarkMap.values()];
            const first = benchmarkResults[0];
            const runTotal = allRunTotals.get(modelKey) || {
                totalCost: 0,
                totalLatency: 0,
                runCount: 0,
            };
            let passed = 0;
            let failed = 0;
            let errored = 0;
            const perBenchmark = [];
            for (const benchmarkResult of benchmarkResults) {
                if (benchmarkResult.error)
                    errored++;
                else if (benchmarkResult.passed)
                    passed++;
                else
                    failed++;
                // Detail card uses cumulative (all runs) stats
                const cumulKey = `${modelKey}::${benchmarkResult.benchmarkId}`;
                const cumul = cumulativeBenchmarks.get(cumulKey);
                perBenchmark.push({
                    name: benchmarkResult.benchmarkName,
                    // Latest result (for the status badge)
                    latestPassed: !benchmarkResult.error && benchmarkResult.passed,
                    latestErrored: !!benchmarkResult.error,
                    // Cumulative stats (all runs)
                    total: cumul?.total || 0,
                    passed: cumul?.passed || 0,
                    failed: cumul?.failed || 0,
                    errored: cumul?.errored || 0,
                });
            }
            const total = benchmarkResults.length;
            return {
                provider: first.provider,
                model: first.model,
                label: first.label,
                thinkingEnabled: first.thinkingEnabled || false,
                toolsEnabled: first.toolsEnabled || false,
                agent: first.agent || null,
                total,
                passed,
                failed,
                errored,
                totalCost: runTotal.totalCost,
                totalLatency: runTotal.totalLatency,
                runCount: runTotal.runCount,
                passRate: total > 0 ? passed / total : 0,
                avgLatency: runTotal.runCount > 0
                    ? runTotal.totalLatency / runTotal.runCount
                    : 0,
                benchmarks: perBenchmark,
            };
        });
        // Sort by pass rate descending, then by total benchmarks descending
        models.sort((firstModel, secondModel) => secondModel.passRate - firstModel.passRate ||
            secondModel.total - firstModel.total);
        res.json({
            models,
            totalModels: models.length,
            totalBenchmarks: benchmarks.length,
        });
    }
    catch (error) {
        logger.error(`GET /benchmark/stats error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
// ─── GET /benchmark/models — List available conversation models for benchmarking ─
router.get("/models", (_req, res) => {
    const models = BenchmarkService.getConversationModels();
    res.json({ models, count: models.length });
});
// ─── GET /benchmark/active-list — List all benchmarks with active runs ─
// Returns an array of benchmark IDs that currently have in-progress runs.
// Used by the benchmark list page to show running indicators on cards.
router.get("/active-list", (_req, res) => {
    const activeIds = [...runStates.keys()];
    res.json({ activeIds });
});
// ─── GET /benchmark/presets — Return industry-standard benchmark presets ──
router.get("/presets", (_req, res) => {
    res.json({ presets: BENCHMARK_PRESETS, count: BENCHMARK_PRESETS.length });
});
// ─── POST /benchmark — Create a new benchmark test ──────────
router.post("/", asyncHandler(async (req, res, next) => {
    try {
        const { name, prompt, systemPrompt, expectedValue, matchMode, temperature, maxTokens, tags, assertions, assertionOperator, benchmarkMode, agentAssertions, agentAssertionOperator, } = req.body;
        if (!name || !prompt) {
            return res
                .status(400)
                .json({ error: "Missing required fields: name, prompt" });
        }
        // Model and combined benchmarks require at least an expectedValue or assertions
        if (benchmarkMode !== "agent" &&
            !expectedValue &&
            (!assertions ||
                !assertions.some((assertion) => assertion.expectedValue))) {
            return res.status(400).json({
                error: "Model/combined benchmarks require at least one text assertion (expectedValue)",
            });
        }
        // Agent benchmarks require at least one agent assertion
        if (benchmarkMode === "agent" &&
            (!agentAssertions || agentAssertions.length === 0)) {
            return res.status(400).json({
                error: "Agent benchmarks require at least one behavioral assertion",
            });
        }
        const validModes = Object.values(BenchmarkService.MATCH_MODES);
        // Validate top-level matchMode (backward compat)
        if (matchMode && !validModes.includes(matchMode)) {
            return res.status(400).json({
                error: `Invalid matchMode. Must be one of: ${validModes.join(", ")}`,
            });
        }
        // Validate assertions array if provided
        if (assertions && Array.isArray(assertions)) {
            for (const assertion of assertions) {
                if (assertion.matchMode &&
                    !validModes.includes(assertion.matchMode)) {
                    return res.status(400).json({
                        error: `Invalid matchMode in assertion. Must be one of: ${validModes.join(", ")}`,
                    });
                }
            }
        }
        if (assertionOperator && !["AND", "OR"].includes(assertionOperator)) {
            return res.status(400).json({
                error: "Invalid assertionOperator. Must be AND or OR.",
            });
        }
        const benchmark = await BenchmarkService.create({
            name,
            prompt,
            systemPrompt,
            expectedValue,
            matchMode,
            temperature,
            maxTokens,
            tags,
            assertions,
            assertionOperator,
            benchmarkMode,
            agentAssertions,
            agentAssertionOperator,
        }, req.project || null, req.username || DEFAULT_USERNAME);
        res.status(201).json(benchmark);
    }
    catch (error) {
        logger.error(`POST /benchmark error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
// ─── GET /benchmark/:id — Get a single benchmark test + latest run ─
router.get("/:id", asyncHandler(async (req, res, next) => {
    try {
        const benchmark = await BenchmarkService.getById(String(req.params.id), req.project || null);
        if (!benchmark) {
            return res.status(404).json({ error: "Benchmark not found" });
        }
        const latestRun = await BenchmarkService.getLatestRun(benchmark.id, req.project || null);
        res.json({ ...benchmark, latestRun: latestRun || null });
    }
    catch (error) {
        logger.error(`GET /benchmark/:id error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
// ─── DELETE /benchmark/:id — Delete a benchmark test and its runs ─
router.delete("/:id", asyncHandler(async (req, res, next) => {
    try {
        const existing = await BenchmarkService.getById(String(req.params.id), req.project || null);
        if (!existing) {
            return res.status(404).json({ error: "Benchmark not found" });
        }
        await BenchmarkService.remove(String(req.params.id), req.project || null);
        res.json({ deleted: true, id: req.params.id });
    }
    catch (error) {
        logger.error(`DELETE /benchmark/:id error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
// ─── POST /benchmark/:id/run — Execute a benchmark against models (SSE) ─
// Body (optional):
//   { models: [{ provider: "openai", model: "gpt-5.4" }, ...] }
// If models is omitted, all available conversation models are tested.
//
// Streams SSE events:
//   model_start   { provider, model, label }
//   model_complete { ...result }
//   run_complete  { ...run }
router.post("/:id/run", asyncHandler(async (req, res) => {
    try {
        const benchmark = await BenchmarkService.getById(String(req.params.id), req.project || null);
        if (!benchmark) {
            return res.status(404).json({ error: "Benchmark not found" });
        }
        // Disable Node's default socket/request timeout for long-running SSE streams
        req.setTimeout(0);
        if (req.socket)
            req.socket.setTimeout(0);
        // Set up SSE headers
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        // Abort controller — wired to client disconnect AND explicit abort endpoint
        const abortController = createAbortController();
        let clientClosed = false;
        const registryKey = String(req.params.id);
        activeRuns.set(registryKey, abortController);
        // Set up pub/sub emitter and state for live reconnection
        const emitter = new EventEmitter();
        emitter.setMaxListeners(20);
        runEmitters.set(registryKey, emitter);
        runStates.set(registryKey, {
            completedResults: [],
            activeModel: null,
            totalModels: 0,
            startedAt: new Date().toISOString(),
        });
        // Keepalive: send SSE comment ping every 15s to prevent proxy/browser timeouts
        const keepalive = setInterval(() => {
            if (clientClosed)
                return;
            try {
                res.write(":keepalive\n\n");
            }
            catch {
                /* client already gone */
            }
        }, 15_000);
        const cleanup = () => {
            clientClosed = true;
            clearInterval(keepalive);
            activeRuns.delete(registryKey);
            runEmitters.delete(registryKey);
            runStates.delete(registryKey);
        };
        req.on("close", () => {
            cleanup();
            abortController.abort();
        });
        const send = (type, data) => {
            if (clientClosed)
                return;
            try {
                res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
            }
            catch {
                /* client already gone */
            }
        };
        const { models: modelTargets } = req.body || {};
        const run = await BenchmarkService.runBenchmark(benchmark, modelTargets, req.project || null, req.username || DEFAULT_USERNAME, {
            signal: abortController.signal,
            onRunStart: (info) => {
                // Store total model count for reconnecting clients
                const state = runStates.get(registryKey);
                if (state)
                    state.totalModels = info.totalModels;
                emitter.emit("event", {
                    type: "run_info",
                    totalModels: info.totalModels,
                });
                send("run_info", { totalModels: info.totalModels });
            },
            onModelStart: (model) => {
                const data = {
                    provider: model.provider,
                    model: model.model,
                    label: model.label,
                    isLocal: !!model.isLocal,
                };
                // Update live state for followers
                const state = runStates.get(registryKey);
                if (state)
                    state.activeModel = data;
                // Emit to followers
                emitter.emit("event", { type: "model_start", ...data });
                // Send to original connection
                send("model_start", data);
            },
            onModelComplete: (result) => {
                // Update live state for followers
                const state = runStates.get(registryKey);
                if (state) {
                    state.completedResults.push({ ...result });
                    state.activeModel = null;
                }
                // Emit to followers
                emitter.emit("event", { type: "model_complete", ...result });
                // Send to original connection
                send("model_complete", { ...result });
            },
            onEvent: (event) => {
                // Forward live events for real-time preview
                emitter.emit("event", event);
                // Include _sourceModel for concurrent model attribution
                const sourceTag = event._sourceModel
                    ? { _sourceModel: event._sourceModel }
                    : {};
                // Tool events carry structured data beyond just content
                if (event.type === "toolCall" ||
                    event.type === "tool_execution" ||
                    event.type === "tool_output") {
                    const { type, _sourceModel, ...rest } = event;
                    send(type, { ...rest, ...sourceTag });
                }
                else {
                    send(event.type, {
                        content: event.content,
                        ...sourceTag,
                    });
                }
            },
        });
        // Emit run_complete to followers before cleanup
        emitter.emit("event", { type: "run_complete", ...run });
        send("run_complete", run);
        if (!clientClosed)
            res.end();
        cleanup();
    }
    catch (error) {
        logger.error(`POST /benchmark/:id/run error: ${getErrorMessage(error)}`);
        if (res.headersSent) {
            try {
                res.write(`data: ${JSON.stringify({ type: "error", message: getErrorMessage(error) })}\n\n`);
                res.end();
            }
            catch {
                /* client already gone */
            }
        }
        else {
            res.status(500).json({ error: "Benchmark execution failed" });
        }
    }
}));
// ─── POST /benchmark/:id/abort — Explicitly cancel a running benchmark ─
router.post("/:id/abort", (req, res) => {
    const controller = activeRuns.get(String(req.params.id));
    if (controller) {
        logger.info(`[benchmark] Explicit abort requested for benchmark ${req.params.id}`);
        controller.abort();
        activeRuns.delete(String(req.params.id));
        res.json({ aborted: true });
    }
    else {
        res.json({
            aborted: false,
            message: "No active run found for this benchmark",
        });
    }
});
// ─── GET /benchmark/:id/active — Check if a benchmark has an active run ─
// Returns the current live state (completed results, active model)
// so reconnecting clients can catch up immediately.
router.get("/:id/active", (req, res) => {
    const state = runStates.get(String(req.params.id));
    if (!state) {
        return res.json({ active: false });
    }
    res.json({
        active: true,
        totalModels: state.totalModels,
        completedResults: state.completedResults,
        activeModel: state.activeModel,
        startedAt: state.startedAt,
    });
});
// ─── GET /benchmark/:id/follow — Reconnect to an in-progress run (SSE) ─
// Replays completed results, then streams live events from the
// running benchmark. Allows clients that navigated away and
// returned to see live progress without starting a new run.
router.get("/:id/follow", (req, res) => {
    const state = runStates.get(String(req.params.id));
    const emitter = runEmitters.get(String(req.params.id));
    if (!state || !emitter) {
        return res.status(404).json({ error: "No active run for this benchmark" });
    }
    // Disable timeouts
    req.setTimeout(0);
    if (req.socket)
        req.socket.setTimeout(0);
    // SSE headers
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    });
    // Send total model count first so the client knows the denominator
    res.write(`data: ${JSON.stringify({ type: "run_info", totalModels: state.totalModels })}\n\n`);
    // Replay completed results
    for (const result of state.completedResults) {
        res.write(`data: ${JSON.stringify({ type: "model_complete", ...result })}\n\n`);
    }
    // Send active model if one is currently running
    if (state.activeModel) {
        res.write(`data: ${JSON.stringify({ type: "model_start", ...state.activeModel })}\n\n`);
    }
    // Subscribe to live events going forward
    const handler = (event) => {
        try {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        catch {
            /* follower disconnected */
        }
    };
    emitter.on("event", handler);
    // Keepalive
    const keepalive = setInterval(() => {
        try {
            res.write(":keepalive\n\n");
        }
        catch {
            /* gone */
        }
    }, 15_000);
    req.on("close", () => {
        emitter.off("event", handler);
        clearInterval(keepalive);
    });
});
// ─── GET /benchmark/:id/runs — Get all past runs for a benchmark ─
router.get("/:id/runs", asyncHandler(async (req, res, next) => {
    try {
        const benchmark = await BenchmarkService.getById(String(req.params.id), req.project || null);
        if (!benchmark) {
            return res.status(404).json({ error: "Benchmark not found" });
        }
        const runs = await BenchmarkService.getRuns(benchmark.id, req.project || null);
        res.json({ runs, count: runs.length });
    }
    catch (error) {
        logger.error(`GET /benchmark/:id/runs error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
// ─── POST /benchmark/:id/runs/:runId/rerun — Re-run with same models ─
router.post("/:id/runs/:runId/rerun", asyncHandler(async (req, res, next) => {
    try {
        const benchmark = await BenchmarkService.getById(String(req.params.id), req.project || null);
        if (!benchmark) {
            return res.status(404).json({ error: "Benchmark not found" });
        }
        const previousRun = (await BenchmarkService.getRunById(String(req.params.runId), req.project || null));
        if (!previousRun) {
            return res.status(404).json({ error: "Run not found" });
        }
        // Re-run with the same model set from the previous run
        const modelTargets = (previousRun.models || []).map((modelResult) => ({
            provider: modelResult.provider,
            model: modelResult.model,
            display_name: modelResult.label,
            thinkingEnabled: modelResult.thinkingEnabled,
            toolsEnabled: modelResult.toolsEnabled,
            agent: modelResult.agent || undefined,
        }));
        const run = await BenchmarkService.runBenchmark(benchmark, modelTargets, req.project || null, req.username || DEFAULT_USERNAME);
        res.json(run);
    }
    catch (error) {
        logger.error(`POST /benchmark/:id/runs/:runId/rerun error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
export default router;
//# sourceMappingURL=BenchmarkRoutes.js.map