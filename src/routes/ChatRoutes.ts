import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import { handleConversation } from "../core/chat/ChatGeneration.ts";
import { handleSseRequest, handleJsonRequest } from "../utils/SseUtilities.ts";
import { wantsSse } from "../utils/StreamNegotiation.ts";

const router = express.Router();
// ─── SSE streaming or JSON fallback ─────────────────────────
/**
 * POST /chat
 *
 * Response mode (see utils/StreamNegotiation.ts wantsSse):
 *   Default: SSE streaming (text/event-stream).
 *   JSON only on an explicit opt-out: `?stream=false`, body `"stream": false`,
 *   or `Accept: application/json` without text/event-stream.
 *   `?stream=true` always streams.
 *
 * Body (flat, OpenAI-style):
 *   { provider, model?, messages, tools?, temperature?, maxTokens?, ... }
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const params = {
      ...req.body,
      project: req.project,
      username: req.username,
      clientIp: req.clientIp,
    };
    if (wantsSse(req)) {
      // persistOnDisconnect mirrors /agent: a dropped TCP connection (e.g.
      // mobile screen lock) must not abort generation — the handler keeps
      // running server-side and the final messages still land in the
      // conversation via the finalizer.
      await handleSseRequest(req, res, params, handleConversation, {
        persistOnDisconnect: true,
      });
    } else {
      await handleJsonRequest(req, res, next, params);
    }
  }),
);
export default router;

