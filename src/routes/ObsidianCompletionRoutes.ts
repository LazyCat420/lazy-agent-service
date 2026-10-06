import express from "express";
import { ObsidianCompletionJobs } from "../services/ObsidianCompletionJobs.ts";

export function createObsidianCompletionRouter(jobs = new ObsidianCompletionJobs()) {
  const router = express.Router();
  router.get("/", (_req, res) => res.json({ version: 1, durableVaultChat: true }));
  router.put("/:id", (req, res) => {
    try {
      const job = jobs.submit(JSON.stringify([req.project, req.username]), String(req.params.id), req.body.target, req.body.payload);
      res.status(job.status === "running" ? 202 : 200).json(job);
    } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  router.get("/:id", (req, res) => {
    try {
      const job = jobs.get(JSON.stringify([req.project, req.username]), String(req.params.id));
      if (!job) return res.status(404).json({ error: "Completion not found" });
      res.json(job);
    } catch { res.status(400).json({ error: "Invalid completion id" }); }
  });
  return router;
}
