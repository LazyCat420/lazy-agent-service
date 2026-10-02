import { Router } from "express";
import { ExperimentService, type ExperimentRequest } from "../services/ExperimentService.ts";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";

const router = Router();

/**
 * POST /experiment
 * Runs a paired baseline/candidate experiment with repetition, bootstrap CI,
 * and an explicit inconclusive verdict when underpowered. Long-running; the
 * result is returned synchronously (caller should use a generous timeout).
 */
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const { benchmark, baseline, candidate, trials, minDetectableEffect, label, project, username } = req.body || {};

    if (!benchmark?.prompt) return res.status(400).json({ error: "Missing benchmark.prompt" });
    if (!baseline?.provider || !baseline?.model) return res.status(400).json({ error: "Missing baseline provider/model" });
    if (!candidate?.provider || !candidate?.model) return res.status(400).json({ error: "Missing candidate provider/model" });
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

    res.json(result);
  }),
);

export default router;
