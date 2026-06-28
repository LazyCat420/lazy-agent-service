import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import AgenticLoopService from "../services/AgenticLoopService.ts";
import AgentSessionRegistry from "../services/AgentSessionRegistry.ts";
import LiveFrameService from "../services/LiveFrameService.ts";
import { handleAgent } from "./ChatRoutes.ts";
import logger from "../utils/logger.ts";
import { handleSseRequest, handleJsonRequest } from "../utils/SseUtilities.ts";

const router = express.Router();

// ─── resolves pending plan/tool approvals ───────────────────

/**
 * POST /agent/approve
 *
 * Body:
 *   { conversationId: string, approved: boolean }
 *
 * Resolves the pending approval promise in AgenticLoopService
 * so the agentic loop can continue (or abort).
 */
router.post(
  "/approve",
  asyncHandler(async (req: Request, res: Response) => {
    const { conversationId, approved, approveAll } = req.body;
    const isApproved = approved !== false;
    const shouldApproveAll = approveAll === true;

    if (!conversationId) {
      return res.status(400).json({ error: "Missing conversationId" });
    }

    const resolved = AgenticLoopService.resolveApproval(
      conversationId,
      isApproved,
      { shouldApproveAll },
    );

    if (!resolved) {
      return res.status(404).json({
        error: "No pending approval for this conversation",
        conversationId,
      });
    }

    logger.info(
      `[agent/approve] ${isApproved ? "Approved" : "Rejected"}${shouldApproveAll ? " (all future)" : ""} for conversation ${conversationId}`,
    );

    res.json({ ok: true, approved: isApproved });
  }),
);

// ─── resolves pending ask_user_question pauses ──────────────

/**
 * POST /agent/answer
 *
 * Body:
 *   { conversationId: string, answer: string }          ← simple (backward-compat)
 *   { conversationId: string, answers: Array<{ answer: string|string[], annotations?: string }> }  ← structured multi-question
 *
 * Resolves the pending question promise in AgenticLoopService
 * so the agentic loop can continue with the user's answer(s).
 */
router.post(
  "/answer",
  asyncHandler(async (req: Request, res: Response) => {
    const { conversationId, answer, answers } = req.body;

    if (!conversationId) {
      return res.status(400).json({ error: "Missing conversationId" });
    }

    // Normalize: structured answers take priority, fall back to simple string
    let normalizedAnswers: {
      answer: string | string[];
      annotations?: string;
    }[];
    if (Array.isArray(answers) && answers.length > 0) {
      normalizedAnswers = answers as {
        answer: string | string[];
        annotations?: string;
      }[];
    } else if (answer !== undefined && answer !== null) {
      normalizedAnswers = [{ answer: String(answer) }];
    } else {
      return res.status(400).json({ error: "Missing answer or answers" });
    }

    const resolved = AgenticLoopService.resolveUserQuestion(
      conversationId,
      normalizedAnswers,
    );

    if (!resolved) {
      return res.status(404).json({
        error: "No pending question for this conversation",
        conversationId,
      });
    }

    logger.info(
      `[agent/answer] ${normalizedAnswers.length} answer(s) for conversation ${conversationId}`,
    );

    res.json({ ok: true });
  }),
);

// ─── live vision frame streaming ────────────────────────────

/**
 * POST /agent/conversation/:conversationId/frame
 *
 * Body:
 *   { frameDataUrl: string } // base64 JPEG data URL
 *
 * Receives the latest frame for a conversation and adds it to the rolling buffer.
 */
router.post(
  "/conversation/:conversationId/frame",
  asyncHandler(async (request: Request, response: Response) => {
    const { conversationId } = request.params;
    const { frameDataUrl } = request.body;

    if (!conversationId) {
      return response.status(400).json({ error: "Missing conversationId" });
    }
    if (!frameDataUrl) {
      return response.status(400).json({ error: "Missing frameDataUrl" });
    }

    LiveFrameService.pushFrame(
      conversationId as string,
      frameDataUrl as string,
    );
    response.json({ ok: true });
  }),
);

// ─── explicit session stop ──────────────────────────────────

/**
 * POST /agent/stop
 *
 * Body:
 *   { conversationId: string }
 *
 * Explicitly stops a running agentic session. Used by the client when the
 * user presses Stop — decoupled from SSE connection lifecycle so mobile
 * browser disconnections don't abort background processing.
 */
router.post(
  "/stop",
  asyncHandler(async (req: Request, res: Response) => {
    const { conversationId } = req.body;

    if (!conversationId) {
      return res.status(400).json({ error: "Missing conversationId" });
    }

    const stopped = AgentSessionRegistry.stop(conversationId);

    if (!stopped) {
      return res.status(404).json({
        error: "No active session for this conversation",
        conversationId,
      });
    }

    logger.info(
      `[agent/stop] Explicitly stopped session for conversation ${conversationId}`,
    );

    res.json({ ok: true, stopped: true });
  }),
);

// ─── SSE streaming or JSON fallback ─────────────────────────

/**
 * POST /agent
 *
 * Agentic endpoint — always enables function calling and the
 * AgenticLoopService tool-execution loop. Use this for autonomous
 * agent workflows; use /chat for simple LLM calls.
 *
 * Default:       SSE streaming (text/event-stream)
 * ?stream=false: Plain JSON response (for server-to-server callers)
 *
 * Body (flat, OpenAI-style):
 *   { provider, model?, messages, enabledTools?, temperature?, maxTokens?, ... }
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    // Force agentic mode — the entire point of this endpoint
    const params = {
      ...req.body,
      functionCallingEnabled: true,
      agenticLoopEnabled: true,
      project: req.project,
      username: req.username,
      clientIp: req.clientIp,
      agent: req.body.agent || req.agent || null,
      // Multi-workspace: override the default workspace root when the user has
      // selected a non-default workspace in the Prism Client sidebar. Sources:
      //   1. x-workspace-root header (set by Prism Client's serviceHeaders.js)
      //   2. body.workspaceRoot (for server-to-server / API callers)
      workspaceRoot: req.workspaceRoot || req.body.workspaceRoot || null,
    };

    const acceptsSse = req.headers.accept?.includes("text/event-stream");
    const streamQuery = req.query.stream;
    const isSse = streamQuery === "true" || (acceptsSse && streamQuery !== "false" && req.body.stream !== false);

    if (isSse) {
      await handleSseRequest(req, res, params, handleAgent, {
        persistOnDisconnect: true,
      });
    } else {
      await handleJsonRequest(req, res, next, params, handleAgent);
    }
  }),
);

export default router;
