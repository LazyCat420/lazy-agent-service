import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response } from "express";
import { CreateRunRequest, RunResult, RunEvent } from "../types/run.ts";
import { randomUUID } from "crypto";

const router = express.Router();

/**
 * POST /v1/runs
 * Creates and starts a new agent run.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const payload = req.body as CreateRunRequest;

    if (!payload.profileId) {
      return res.status(400).json({ error: "Missing profileId" });
    }

    const runId = randomUUID();

    if (payload.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const sendEvent = (event: Omit<RunEvent, 'id' | 'timestamp'>) => {
        const fullEvent: RunEvent = {
          ...event,
          id: randomUUID(),
          timestamp: new Date().toISOString()
        };
        res.write(`data: ${JSON.stringify(fullEvent)}\n\n`);
      };

      sendEvent({
        runId,
        type: 'run.created',
        data: { status: 'queued', profileId: payload.profileId }
      });

      // Start actual execution engine in background for streaming
      import("../services/RunExecutionEngine.ts").then(({ RunExecutionEngine }) => {
        RunExecutionEngine.startRun(runId, payload, sendEvent).then((result) => {
          res.end();
        }).catch(() => {
          res.end();
        });
      });

    } else {
      const { RunExecutionEngine } = await import("../services/RunExecutionEngine.ts");
      // For sync, we collect events (or just wait for the end).
      const result = await RunExecutionEngine.startRun(runId, payload, () => {});
      res.status(201).json(result);
    }
  })
);

/**
 * GET /v1/runs/:runId
 * Returns the current status and/or final result of a run.
 */
router.get(
  "/:runId",
  asyncHandler(async (req: Request, res: Response) => {
    const { runId } = req.params;

    const result: RunResult = {
      id: runId as string,
      status: 'completed',
      messages: [{ role: 'assistant', content: "Mock retrieved result" }],
      usage: {
        promptTokens: 10,
        completionTokens: 10,
        totalTokens: 20,
        toolCalls: 0
      }
    };

    res.json(result);
  })
);

/**
 * POST /v1/runs/:runId/cancel
 * Explicitly cancels a run.
 */
router.post(
  "/:runId/cancel",
  asyncHandler(async (req: Request, res: Response) => {
    const { runId } = req.params;
    res.json({ ok: true, cancelled: true, runId: runId as string });
  })
);

export default router;
