import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response } from "express";
import { CreateRunRequest, RunResult, RunEvent } from "../types/run.ts";
import { RunExecutionEngine } from "../services/RunExecutionEngine.ts";
import { RunStore } from "../services/RunStore.ts";
import { RunStateMachine } from "../services/RunStateMachine.ts";
import { randomUUID } from "node:crypto";

import { LocalToolContinuation } from "../services/LocalToolContinuation.ts";

import { runtimeAuth, getRuntimeScope, scopeOwnsRun, issueRuntimeSession } from "../middleware/RuntimeAuth.ts";

import { RunEventSchema, RunResultSchema, ToolResultCommandSchema, ApprovalResolutionCommandSchema } from "../contracts/RuntimeWire.ts";
import { RunApprovals } from "../services/RunApprovals.ts";
import { DecisionService } from "../decision-fabric/DecisionService.ts";

const router = express.Router();
router.use(runtimeAuth);
router.post("/sessions", asyncHandler(async (req: Request, res: Response) => {
  if (!res.locals.runtimeBackend) return res.status(403).json({ error: { code: "BACKEND_REQUIRED" } });
  try {
    if (req.body.app_id !== req.project || req.body.username !== req.username) return res.status(403).json({ error: { code: "SCOPE_VIOLATION" } });
    const bearer = issueRuntimeSession(req.body);
    res.status(201).json({ bearer, expires_at: req.body.expires_at });
  } catch { res.status(400).json({ error: { code: "INVALID_SESSION_SCOPE" } }); }
}));
router.post("/:runId/steer", asyncHandler(async (req: Request, res: Response) => {
  const run = await RunStore.getRun(String(req.params.runId));
  if (!run || !scopeOwnsRun(res, run) || run.identity?.project !== req.project || run.identity?.username !== req.username) return res.status(404).json({ error: { code: "RUN_NOT_FOUND" } });
  const accepted = typeof req.body.instruction === "string" && RunExecutionEngine.steerRun(run.run_id, req.body.instruction);
  res.status(accepted ? 202 : 409).json({ accepted, delivery: "next_model_turn" });
}));
router.post("/:runId/approvals/:approvalId", asyncHandler(async (req: Request, res: Response) => {
  const run = await RunStore.getRun(String(req.params.runId));
  if (!run || !scopeOwnsRun(res, run) || run.identity?.project !== req.project || run.identity?.username !== req.username) return res.status(404).json({ error: { code: "RUN_NOT_FOUND" } });
  try { res.json(await RunApprovals.resolve(run.run_id, String(req.params.approvalId), ApprovalResolutionCommandSchema.parse(req.body).approved)); }
  catch { res.status(409).json({ error: { code: "APPROVAL_REJECTED" } }); }
}));
router.post("/:runId/decisions", asyncHandler(async (req: Request, res: Response) => {
  const run = await RunStore.getRun(String(req.params.runId));
  if (!run || !scopeOwnsRun(res, run) || run.identity?.project !== req.project || run.identity?.username !== req.username) return res.status(404).json({ error: { code: "RUN_NOT_FOUND" } });
  if (req.body.runId !== run.run_id) return res.status(400).json({ error: { code: "DECISION_RUN_MISMATCH" } });
  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  try { res.json(await DecisionService.decide(req.body, controller.signal)); }
  catch { res.status(400).json({ error: { code: "DECISION_REQUEST_REJECTED" } }); }
}));
router.post("/:runId/tools/:callId/result", asyncHandler(async (req: Request, res: Response) => {
  try {
    const run = await RunStore.getRun(String(req.params.runId));
    if (!run || !scopeOwnsRun(res, run) || (run.identity && (run.identity.project !== req.project || run.identity.username !== req.username))) return res.status(404).json({ error: { code: "RUN_NOT_FOUND" } });
    const result = await LocalToolContinuation.submit(String(req.params.runId), String(req.params.callId), ToolResultCommandSchema.parse(req.body));
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
    const scope = getRuntimeScope(res);
    if (scope && (profileId !== scope.profile_id || (payload.session_id || payload.sessionId) !== scope.session_id)) return res.status(403).json({ error: { code: "SCOPE_VIOLATION" } });

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

      let delivery = Promise.resolve();
      const sendEvent = (event: Omit<RunEvent, "id" | "timestamp">) => {
        const fullEvent = RunEventSchema.parse({
          ...event,
          id: `evt-${randomUUID()}`,
          timestamp: new Date().toISOString(),
        }) as RunEvent;
        delivery = delivery.then(async () => {
          await RunStore.appendEvent(fullEvent);
          if (!res.destroyed) res.write(`id: ${fullEvent.id}\nevent: ${fullEvent.type}\ndata: ${JSON.stringify(fullEvent)}\n\n`);
        });
      };

      const controller = new AbortController();
      payload.signal = controller.signal;
      res.on("close", () => { if (!res.writableEnded) controller.abort(); });
      RunExecutionEngine.startRun(runId, payload, sendEvent)
        .then(async () => {
          await delivery;
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

      res.status(201).json(RunResultSchema.parse(result));
    }
  }),
);

/** Resume delivery of recorded events only; never restart model or tool execution. */
router.get("/:runId/events", asyncHandler(async (req: Request, res: Response) => {
  const run = await RunStore.getRun(String(req.params.runId));
  if (!run || !scopeOwnsRun(res, run) || run.identity?.project !== req.project || run.identity?.username !== req.username) return res.status(404).json({ error: { code: "RUN_NOT_FOUND" } });
  const cursor = req.get("Last-Event-ID") || String(req.query.after || "");
  const events = run.events || [];
  const index = cursor ? events.findIndex(event => event.id === cursor) : -1;
  if (cursor && index < 0) return res.status(409).json({ error: { code: "EVENT_CURSOR_UNKNOWN" } });
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  for (const event of events.slice(index + 1)) res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  // Snapshot delivery is explicit; clients may poll from the last event while active.
  res.end();
}));

/**
 * GET /v1/runs/:runId
 * Returns the current status and/or final result of a run from the authoritative store.
 */
router.get(
  "/:runId",
  asyncHandler(async (req: Request, res: Response) => {
    const { runId } = req.params;
    const run = await RunStore.getRun(runId as string);

    if (!run || !scopeOwnsRun(res, run) || (run.identity && (run.identity.project !== (req.project || "default") || run.identity.username !== (req.username || "anonymous")))) {
      return res.status(404).json({
        error: {
          code: "RUN_NOT_FOUND",
          message: `Run ${runId} not found`,
          retryable: false,
          category: "CLIENT",
        },
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

    res.json(RunResultSchema.parse(result));
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
    if (!run || !scopeOwnsRun(res, run) || (run.identity && (run.identity.project !== (req.project || "default") || run.identity.username !== (req.username || "anonymous")))) return res.status(404).json({ error: { code: "RUN_NOT_FOUND" } });
    const cancelled = await RunExecutionEngine.cancelRun(runId as string);
    res.json({ ok: true, cancelled, run_id: runId as string, status: "cancelled" });
  }),
);

export default router;
