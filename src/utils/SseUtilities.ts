import { handleConversation } from "../routes/ChatRoutes.ts";
import { ProviderError } from "./errors.ts";
import { createAbortController } from "./AbortController.ts";
import logger from "./logger.ts";
import { Request, Response, NextFunction } from "express";
import { SseEvent } from "../types/SseTypes.ts";
import type { ChatRequest } from "../types/schemas.ts";
import AgentSessionRegistry from "../services/AgentSessionRegistry.ts";

// ─── shared by /chat and /agent routes ──────────────────────

/**
 * Configure an Express response for SSE (Server-Sent Events) streaming.
 * Sets the required headers and flushes them immediately.
 */
export function initSseResponse(res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}

/**
 * Create an SSE emit callback that writes events to the response.
 * Strips heavy base64 data from image events when minioRef is available.
 */
export function createSseEmitter(res: Response, connectionSignal: AbortSignal) {
  // Disable Nagle's algorithm for minimal SSE latency.
  // Without this, small SSE events can sit in the TCP buffer when
  // the server blocks on await (e.g. plan approval promise).
  if (res.socket) res.socket.setNoDelay(true);

  return (event: SseEvent) => {
    if (!connectionSignal.aborted && !res.destroyed && !res.writableEnded) {
      if (event.type === "image" && event.minioRef && event.data) {
        const { data: _stripped, ...lightweight } = event;
        res.write(`data: ${JSON.stringify(lightweight)}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      // Force-flush the write buffer. Without compression middleware,
      // res.flush() doesn't exist — use cork()/uncork() to guarantee
      // Node flushes pending writes to the socket immediately. Critical
      // for events emitted before an await block (plan_proposal,
      // approval_required) where no further writes push the buffer.
      const responseWithFlush = res as Response & { flush?: () => void };
      if (typeof responseWithFlush.flush === "function") {
        responseWithFlush.flush();
      } else if (res.socket && !res.socket.destroyed) {
        res.socket.uncork?.();
        res.socket.cork?.();
        res.socket.uncork?.();
      }
    }
  };
}

/**
 * Build a flat JSON response from collected SSE events.
 * Used by non-streaming callers (?stream=false).
 */
export function buildJsonResponseFromEvents(
  events: SseEvent[],
  requestBody: ChatRequest,
) {
  const errorEvent = events.find((event: SseEvent) => event.type === "error");
  if (errorEvent) {
    return {
      error: new ProviderError(
        "server",
        errorEvent.message || "Unknown error",
        500,
      ),
    };
  }

  const doneEvent =
    events.find((event: SseEvent) => event.type === "done") || ({} as SseEvent);
  const text = events
    .filter((event: SseEvent) => event.type === "chunk")
    .map((event: SseEvent) => event.content)
    .join("");
  const thinking = events
    .filter((event: SseEvent) => event.type === "thinking")
    .map((event: SseEvent) => event.content)
    .join("");
  const images = events
    .filter((event: SseEvent) => event.type === "image")
    .map((event: SseEvent) => ({
      data: event.data,
      mimeType: event.mimeType,
      minioRef: event.minioRef || null,
    }));

  const toolCalls = events
    .filter(
      (event: SseEvent) => event.type === "tool_execution" && event.status === "calling",
    )
    .map((event: SseEvent) => ({
      name: event.tool?.name,
      args: event.tool?.args,
    }));

  const toolResults = events
    .filter(
      (event: SseEvent) =>
        event.type === "tool_execution" &&
        (event.status === "done" || event.status === "error"),
    )
    .map((event: SseEvent) => ({
      name: event.tool?.name,
      args: event.tool?.args,
      result: event.tool?.result,
      status: event.status,
    }));

  const audioEvents = events
    .filter((event: SseEvent) => event.type === "audio")
    .map((event: SseEvent) => ({
      data: event.data,
      mimeType: event.mimeType,
      minioRef: event.minioRef || null,
    }));

  return {
    response: {
      text: text || null,
      thinking: thinking || null,
      images: images.length > 0 ? images : undefined,
      audio: audioEvents.length > 0 ? audioEvents : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
      provider: doneEvent.provider || requestBody.provider,
      model: doneEvent.model || requestBody.model,
      usage: doneEvent.usage || null,
      estimatedCost: doneEvent.estimatedCost ?? null,
      ...(doneEvent.audioRef && { audioRef: doneEvent.audioRef }),
      ...(doneEvent.traceId && { traceId: doneEvent.traceId }),
      ...(doneEvent.conversationId && {
        conversationId: doneEvent.conversationId,
      }),
    },
  };
}


/**
 * Options for SSE request handling.
 *
 * `persistOnDisconnect` — When true (used by /agent), the handler keeps
 * running after the SSE connection drops. The handler's `signal` is only
 * aborted by an explicit POST /agent/stop call. When false (default,
 * used by /chat), the handler aborts immediately on client disconnect
 * (legacy behavior).
 */
export interface SseRequestOptions {
  persistOnDisconnect?: boolean;
}

/**
 * Handle a full SSE streaming request lifecycle.
 * Sets up SSE headers, AbortController(s), runs the handler, and closes.
 *
 * Two-signal architecture:
 *   - connectionController — fires when the SSE socket closes (client
 *     disconnect, mobile screen lock, network drop). Guards `emit()` writes.
 *   - stopController — fires only on explicit user stop (POST /agent/stop).
 *     Passed to the handler as `context.signal` for loop-control checks.
 *
 * When `persistOnDisconnect` is false (default), connection close also
 * aborts the stop controller (legacy behavior for non-agentic routes).
 */
export async function handleSseRequest(
  req: Request,
  res: Response,
  params: ChatRequest,
  handler: (
    params: ChatRequest,
    onEvent: (event: SseEvent) => void,
    context: { signal: AbortSignal },
  ) => Promise<void> = handleConversation,
  options: SseRequestOptions = {},
) {
  const { persistOnDisconnect = false } = options;

  initSseResponse(res);

  // Disable socket-level timeouts for long-lived SSE streams.
  // Even with server.requestTimeout = 0, the underlying socket can
  // inherit a default timeout from Node.js or Express.
  if (req.socket) {
    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true, 30_000);
  }

  const connectionStartTime = Date.now();
  const connectionController = createAbortController();

  // For persistent sessions (/agent), register a separate stop controller
  // in the session registry so POST /agent/stop can abort it explicitly.
  // For non-persistent sessions (/chat), reuse the connection controller
  // as the stop signal (legacy behavior: disconnect = abort).
  const conversationId = (params as Record<string, unknown>).conversationId as string | undefined;
  let stopController: AbortController;

  if (persistOnDisconnect && conversationId) {
    stopController = AgentSessionRegistry.register(conversationId);
  } else {
    stopController = persistOnDisconnect
      ? createAbortController()
      : connectionController;
  }

  res.on("close", () => {
    const durationSeconds = ((Date.now() - connectionStartTime) / 1000).toFixed(
      1,
    );
    logger.warn(
      `[SSE] Connection closed after ${durationSeconds}s — ` +
        `writableFinished=${res.writableFinished}, destroyed=${res.destroyed}, ` +
        `socket.destroyed=${req.socket?.destroyed}, ` +
        `persistOnDisconnect=${persistOnDisconnect}`,
    );
    if (!res.writableFinished) {
      connectionController.abort();

      // Legacy behavior: when NOT persisting, also abort the handler
      if (!persistOnDisconnect && stopController !== connectionController) {
        stopController.abort();
      }
    }
  });

  const keepAliveInterval = setInterval(() => {
    if (!connectionController.signal.aborted && !res.destroyed && !res.writableEnded) {
      try {
        res.write(": keepalive\n\n");
        const responseWithFlush = res as Response & { flush?: () => void };
        if (typeof responseWithFlush.flush === "function") {
          responseWithFlush.flush();
        } else if (res.socket && !res.socket.destroyed) {
          res.socket.uncork?.();
          res.socket.cork?.();
          res.socket.uncork?.();
        }
      } catch (e) {
        logger.debug(`[SSE] Failed writing keepalive: ${e}`);
      }
    }
  }, 15_000);

  try {
    await handler(params, createSseEmitter(res, connectionController.signal), {
      signal: stopController.signal,
    });
  } finally {
    clearInterval(keepAliveInterval);
    // Cleanup session registry entry
    if (persistOnDisconnect && conversationId) {
      AgentSessionRegistry.cleanup(conversationId);
    }
  }

  if (!connectionController.signal.aborted) res.end();
}

/**
 * Handle a non-streaming JSON request lifecycle.
 * Collects events from the handler and returns a flat JSON response.
 *
 * Creates an AbortController tied to the client connection so that
 * provider-side inference (e.g. vLLM on a Jetson) is cancelled when
 * the caller disconnects or hits "stop" — preventing orphaned GPU
 * generations from blocking the LocalModelQueue semaphore.
 */
export async function handleJsonRequest(
  req: Request,
  res: Response,
  next: NextFunction,
  params: ChatRequest,
  handler: (
    params: ChatRequest,
    onEvent: (event: SseEvent) => void,
    context: { signal: AbortSignal },
  ) => Promise<void> = handleConversation,
) {
  const controller = createAbortController();
  const connectionStartTime = Date.now();

  res.on("close", () => {
    if (!res.writableFinished) {
      const durationSeconds = (
        (Date.now() - connectionStartTime) /
        1000
      ).toFixed(1);
      logger.warn(
        `[JSON] Client disconnected after ${durationSeconds}s — aborting in-flight generation`,
      );
      controller.abort();
    }
  });

  const events: SseEvent[] = [];
  await handler(params, (event: SseEvent) => events.push(event), {
    signal: controller.signal,
  });

  if (controller.signal.aborted) return;

  const { error, response } = buildJsonResponseFromEvents(events, req.body);
  if (error) return next(error);

  res.json(response);
}
