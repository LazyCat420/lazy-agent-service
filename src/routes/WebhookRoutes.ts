import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import type { Request, Response } from "express";
import WebhookEventBus from "../services/WebhookEventBus.ts";
import type { WebhookEvent } from "../services/WebhookEventBus.ts";
import { SSE_KEEPALIVE_INTERVAL_MS } from "../constants.ts";

const router = express.Router();

// ─── GET /webhooks/requests/stream — SSE live event stream ─

router.get(
  "/requests/stream",
  asyncHandler(async (req: Request, res: Response) => {
    const filterAgent = req.query.agent as string | undefined;
    const filterProvider = req.query.provider as string | undefined;
    const filterProject = req.query.project as string | undefined;
    const filterEvents = req.query.events
      ? (req.query.events as string).split(",").filter(Boolean)
      : null;
    const replaySince = req.query.since as string | undefined;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const shouldForward = (event: WebhookEvent): boolean => {
      if (
        filterEvents &&
        !filterEvents.includes(event.eventType) &&
        !filterEvents.includes("*")
      ) {
        return false;
      }
      if (filterAgent && event.data.agent !== filterAgent) return false;
      if (filterProvider && event.data.provider !== filterProvider)
        return false;
      if (filterProject && event.data.project !== filterProject) return false;
      return true;
    };

    // Replay buffered events for reconnection
    if (replaySince) {
      const missedEvents = WebhookEventBus.getReplayBuffer(replaySince);
      for (const event of missedEvents) {
        if (shouldForward(event)) {
          try {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          } catch {
            // Client disconnected during replay
          }
        }
      }
    }

    res.write(
      `data: ${JSON.stringify({ type: "connected", listenerCount: WebhookEventBus.listenerCount + 1 })}\n\n`,
    );

    const onEvent = (event: WebhookEvent) => {
      if (!shouldForward(event)) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Client disconnected
      }
    };

    WebhookEventBus.subscribe(onEvent);

    const keepAliveInterval = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        // ignore
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);

    req.on("close", () => {
      WebhookEventBus.unsubscribe(onEvent);
      clearInterval(keepAliveInterval);
    });
  }),
);


export default router;
