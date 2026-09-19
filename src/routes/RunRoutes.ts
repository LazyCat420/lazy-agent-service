import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response } from "express";
import { CreateRunRequest, RunResult, RunEvent } from "../types/run.ts";
import { RunExecutionEngine } from "../services/RunExecutionEngine.ts";
import { RunStore } from "../services/RunStore.ts";
import { RunStateMachine } from "../services/RunStateMachine.ts";
import { randomUUID } from "node:crypto";

import { LocalToolContinuation } from "../services/LocalToolContinuation.ts";

import { runtimeAuth } from "../middleware/RuntimeAuth.ts";

const router = express.Router();
router.use(runtimeAuth);
router.post("/:runId/tools/:callId/result", asyncHandler(async (req: Request, res: Response) => {
  try {
    const run = await RunStore.getRun(String(req.params.runId));
    if (!run || (run.identity && (run.identity.project !== req.project || run.identity.username !== req.username))) return res.status(404).json({ error: { code: "RUN_NOT_FOUND" } });
    const result = await LocalToolContinuation.submit(String(req.params.runId), String(req.params.callId), req.body);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(err.status || 400).json({ error: { code: "TOOL_RESULT_REJECTED", message: err.message } });
  }
}));

/**
 * POST /v1/runs
 * Creates and starts a new agent run.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const payload = { ...req.body, identity: { project: req.project || "default", username: req.username || "anonymous" } } as CreateRunRequest;
    const requestedApp = payload.app_id || payload.appId;
    if (requestedApp && requestedApp !== payload.identity!.project) return res.status(403).json({ error: { code: "SCOPE_VIOLATION" } });
    payload.app_id = requestedApp || payload.identity!.project;
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

      const controller = new AbortController();
      payload.signal = controller.signal;
      res.on("close", () => { if (!res.writableEnded) controller.abort(); });
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

    if (!run || (run.identity && (run.identity.project !== (req.project || "default") || run.identity.username !== (req.username || "anonymous")))) {
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
    const run = await RunStore.getRun(runId as string);
    if (!run || (run.identity && (run.identity.project !== (req.project || "default") || run.identity.username !== (req.username || "anonymous")))) return res.status(404).json({ error: { code: "RUN_NOT_FOUND" } });
    const cancelled = await RunExecutionEngine.cancelRun(runId as string);
    res.json({ ok: true, cancelled, run_id: runId as string, status: "cancelled" });
  }),
);

export default router;
