import { Router } from "express";
import { ExperimentService } from "../services/ExperimentService.js";
import { AttributionAnalyzer } from "../services/AttributionAnalyzer.js";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
const router = Router();
/**
 * POST /experiment
 * Runs a paired baseline/candidate experiment with repetition, bootstrap CI,
 * and an explicit inconclusive verdict when underpowered. Long-running; the
 * result is returned synchronously (caller should use a generous timeout).
 */
router.post("/", asyncHandler(async (req, res) => {
    const { benchmark, baseline, candidate, trials, minDetectableEffect, label, project, username } = req.body || {};
    if (!benchmark?.prompt)
        return res.status(400).json({ error: "Missing benchmark.prompt" });
    if (!baseline?.provider || !baseline?.model)
        return res.status(400).json({ error: "Missing baseline provider/model" });
    if (!candidate?.provider || !candidate?.model)
        return res.status(400).json({ error: "Missing candidate provider/model" });
    const trialCount = Number(trials);
    if (!Number.isInteger(trialCount) || trialCount < 2 || trialCount > 500) {
        return res.status(400).json({ error: "trials must be an integer between 2 and 500" });
    }
    const result = await ExperimentService.runExperiment({
        benchmark,
        baseline,
        candidate,
        trials: trialCount,
        minDetectableEffect: minDetectableEffect ? Number(minDetectableEffect) : undefined,
        label,
        project: project || "experiment",
        username: username || "experiment",
        signal: req.query.abort === "1" ? undefined : undefined,
    });
    // Attribution: first divergence + failure clusters over the paired trials.
    const paired = result.pairedDeltas.map((p, i) => ({
        trial: p.trial,
        baseline: { passed: p.passedBaseline, error: result.baseline.failures[i] ?? null, response: null },
        candidate: { passed: p.passedCandidate, error: result.candidate.failures[i] ?? null, response: null },
    }));
    const attribution = AttributionAnalyzer.analyze(paired);
    res.json({ ...result, attribution });
}));
export default router;
//# sourceMappingURL=ExperimentRoutes.js.map