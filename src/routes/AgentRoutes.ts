import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import AgentSessionRegistry from "../services/AgentSessionRegistry.ts";
import LiveFrameService from "../services/LiveFrameService.ts";
import { handleAgent } from "./ChatRoutes.ts";
import { handleApprovalDecision } from "./ApprovalDecisionRoute.ts";
import { handleQuestionAnswer } from "./QuestionAnswerHandler.ts";
import { prepareTradingAgentRequest } from "../services/TradingAgentRequest.ts";
import logger from "../utils/logger.ts";
import { handleSseRequest, handleJsonRequest } from "../utils/SseUtilities.ts";
import { wantsSse } from "../utils/StreamNegotiation.ts";
import {
  dispatchAgentRouteWithRollback,
  runCoreLoopForAgent,
  shouldUseCoreLoopForAgent,
} from "../core/loop/AgentRouteAdapter.ts";

export {
  dispatchAgentRouteWithRollback,
  runCoreLoopForAgent,
  shouldUseCoreLoopForAgent,
};

const router = express.Router();

// ─── resolves pending plan/tool approvals and ask_user questions ───
// POST /agent/approve — see ApprovalDecisionRoute; POST /agent/answer — see QuestionAnswerHandler.
router.post("/approve", handleApprovalDecision("[agent/approve]"));
router.post("/answer", handleQuestionAnswer("agent/answer"));

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
 * Response mode (see utils/StreamNegotiation.ts wantsSse):
 *   Default: SSE streaming (text/event-stream).
 *   JSON only on an explicit opt-out: `?stream=false`, body `"stream": false`,
 *   or `Accept: application/json` without text/event-stream.
 *   `?stream=true` always streams.
 *
 * Body (flat, OpenAI-style):
 *   { provider, model?, messages, enabledTools?, temperature?, maxTokens?, ... }
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    // Force agentic mode — the entire point of this endpoint
    let params = {
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
    // The same trading boundary /prism-proxy applies (signed tool context,
    // learning marker, unattended) — see TradingAgentRequest.ts. A no-op for
    // every other project.
    try {
      params = prepareTradingAgentRequest(params);
    } catch (error) {
      res.status(422).json({ error: String(error) });
      return;
    }

    if (wantsSse(req)) {
      await handleSseRequest(req, res, params, handleAgent, {
        persistOnDisconnect: true,
      });
    } else {
      await handleJsonRequest(req, res, next, params, handleAgent);
    }
  }),
);

export default router;
