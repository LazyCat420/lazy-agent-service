import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response } from "express";
import { CreateRunRequest, RunResult, RunEvent } from "../types/run.ts";
import { RunExecutionEngine } from "../services/RunExecutionEngine.ts";
import { RunStore } from "../services/RunStore.ts";
import { RunStateMachine } from "../services/RunStateMachine.ts";
import { randomUUID } from "node:crypto";

const router = express.Router();

/**
 * POST /v1/runs
 * Creates and starts a new agent run.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const payload = req.body as CreateRunRequest;
    const profileId = payload.profile_id || payload.profileId;

    if (!profileId) {
      return res.status(400).json({
        error: {
          code: "INVALID_RUN_REQUEST",
          message: "Missing profile_id",
          retryable: false,
          category: "CLIENT",
        },
      });
    }

    const idempotencyHeader = req.headers["x-idempotency-key"] as string | undefined;
    if (idempotencyHeader) {
      payload.idempotency_key = idempotencyHeader;
      payload.idempotencyKey = idempotencyHeader;
    }

    const deadlineHeader = req.headers["x-deadline-ms"] as string | undefined;
    if (deadlineHeader && !isNaN(Number(deadlineHeader))) {
      payload.deadline_ms = Number(deadlineHeader);
    }

    const runId = `run-${randomUUID()}`;

    if (payload.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const sendEvent = (event: Omit<RunEvent, "id" | "timestamp">) => {
        const fullEvent: RunEvent = {
          ...event,
          id: `evt-${randomUUID()}`,
          timestamp: new Date().toISOString(),
        };
        res.write(`event: ${fullEvent.type}\ndata: ${JSON.stringify(fullEvent)}\n\n`);
      };

      RunExecutionEngine.startRun(runId, payload, sendEvent)
        .then(() => {
          res.end();
        })
        .catch(() => {
          res.end();
        });
    } else {
      const result = await RunExecutionEngine.startRun(runId, payload, () => {});

      if (result.error?.code === "IDEMPOTENCY_CONFLICT") {
        return res.status(409).json({ error: result.error });
      }
      if (result.error?.code === "PROFILE_NOT_FOUND") {
        return res.status(404).json({ error: result.error });
      }
      if (result.error?.code === "INVALID_RUN_REQUEST") {
        return res.status(400).json({ error: result.error });
      }

      res.status(201).json(result);
    }
  }),
);

/**
 * GET /v1/runs/:runId
 * Returns the current status and/or final result of a run from the authoritative store.
 */
router.get(
  "/:runId",
  asyncHandler(async (req: Request, res: Response) => {
    const { runId } = req.params;
    const run = await RunStore.getRun(runId as string);

    if (!run) {
      return res.status(404).json({
        error: {
          code: "RUN_NOT_FOUND",
          message: `Run ${runId} not found`,
          retryable: false,
          category: "CLIENT",
        },
      });
    }

    if (!RunStateMachine.isTerminal(run.status)) {
      return res.json({
        run_id: run.run_id,
        status: run.status,
        profile_id: run.profile_id,
        current_turn: run.current_turn,
        started_at: run.started_at,
        deadline_at: run.deadline_at,
      });
    }

    const result: RunResult = {
      run_id: run.run_id,
      id: run.run_id,
      status: run.status,
      profile_id: run.profile_id,
      messages: run.messages || [],
      usage: run.usage,
      context_receipt: run.context_receipt,
      evidence_records: run.evidence_records,
      error: run.error,
    };

    res.json(result);
  }),
);

/**
 * POST /v1/runs/:runId/cancel
 * Explicitly cancels an active run.
 */
router.post(
  "/:runId/cancel",
  asyncHandler(async (req: Request, res: Response) => {
    const { runId } = req.params;
    const cancelled = await RunExecutionEngine.cancelRun(runId as string);
    res.json({ ok: true, cancelled, run_id: runId as string, status: "cancelled" });
  }),
);

export default router;
