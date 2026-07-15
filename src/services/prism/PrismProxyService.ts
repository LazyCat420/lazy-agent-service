import { type Request, type Response } from "express";
import logger from "../../logger.js";
import { getToolSchemas } from "../ToolSchemaService.js";
import { rewriteNonLeadingSystemMessages } from "../../utils/openai-compat.ts";

const REAL_PRISM_URL = process.env.REAL_PRISM_URL || "http://10.0.0.16:7777";

/**
 * Timeout for the upstream connection + response headers. Generous (120s)
 * because /agent requests can take a long time before the first byte.
 * The timer is cleared as soon as headers arrive — long-running SSE streams
 * are never aborted once streaming has begun.
 */
const UPSTREAM_HEADERS_TIMEOUT_MS = 120_000;

/** Session registrations older than this are pruned on insert. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Hard cap on tracked sessions — oldest entries are evicted beyond this. */
const MAX_TRACKED_SESSIONS = 5_000;

interface SessionToolRegistration {
  allowedTools: string[];
  registeredAt: number;
}

export class PrismProxyService {
  // Map conversationId -> allowed tool names (+ registration timestamp for TTL eviction).
  // NOTE: in-memory only. Registrations are intentionally NOT persisted:
  // isToolAllowed is a synchronous hot-path check (ExecuteRoutes calls it
  // inline on every tool execution) and this service is designed to keep the
  // proxy path dependency-free. A restart therefore fails OPEN for in-flight
  // cycles — see the distinct warning in isToolAllowed.
  private static sessionAllowedTools = new Map<string, SessionToolRegistration>();

  // Sessions we already warned about fail-open treatment (avoid log spam).
  private static warnedUnknownSessions = new Set<string>();

  public static registerSession(conversationId: string, allowedTools: string[]) {
    logger.info(`[PrismProxy] Registering allowed tools for conversation ${conversationId}: ${allowedTools.join(", ")}`);
    this.pruneSessions();
    this.sessionAllowedTools.set(conversationId, {
      allowedTools,
      registeredAt: Date.now()
    });
  }

  /** Prune expired registrations and enforce the max-size cap (called on insert). */
  private static pruneSessions() {
    const now = Date.now();
    for (const [conversationId, registration] of this.sessionAllowedTools) {
      if (now - registration.registeredAt > SESSION_TTL_MS) {
        this.sessionAllowedTools.delete(conversationId);
      }
    }
    // Map iteration order is insertion order — evict oldest first.
    while (this.sessionAllowedTools.size >= MAX_TRACKED_SESSIONS) {
      const oldestKey = this.sessionAllowedTools.keys().next().value;
      if (oldestKey === undefined) break;
      this.sessionAllowedTools.delete(oldestKey);
      logger.warn(`[PrismProxy] Session registry at capacity (${MAX_TRACKED_SESSIONS}) — evicted oldest session ${oldestKey}`);
    }
  }

  public static isToolAllowed(conversationId: string, toolName: string): boolean {
    if (!conversationId) return true; // Default to allow if no context (fallback)

    // Normalize tool name for lookup (strip prefix from hallucinated tool name)
    const cleanToolName = toolName.replace(/^(mcp__[a-zA-Z0-9_-]+__)/, "");

    const registration = this.sessionAllowedTools.get(conversationId);
    if (!registration) {
      // Fail OPEN for unknown sessions: could be a non-trading agent, or a
      // registration lost to a service restart / TTL eviction. A restart must
      // not brick in-flight cycles, but make the fail-open visible.
      if (!this.warnedUnknownSessions.has(conversationId)) {
        if (this.warnedUnknownSessions.size >= 1_000) this.warnedUnknownSessions.clear();
        this.warnedUnknownSessions.add(conversationId);
        logger.warn(
          `[PrismProxy] FAIL-OPEN: no tool whitelist registered for conversation ${conversationId} ` +
            `(unregistered session, service restart, or TTL eviction) — allowing "${toolName}" and all further calls for this session`
        );
      }
      return true;
    }

    return registration.allowedTools.includes(cleanToolName);
  }

  public static async handle(req: Request, res: Response) {
    const originalPath = req.originalUrl.replace(/^\/prism-proxy/, "");
    // Extract base path without query params for routing logic
    const basePath = originalPath.split("?")[0];
    const targetUrl = `${REAL_PRISM_URL}${originalPath}`;
    
    let body = req.body;
    
    // If it's the agent endpoint, apply our guardrail bypass
    if (basePath === "/agent" && req.method === "POST" && body) {
      body = { ...req.body };
      const conversationId = body.conversationId;
      const originalEnabledTools = body.enabledTools || [];

      if (conversationId) {
        this.registerSession(conversationId, originalEnabledTools);
      }

      // Respect the client's explicit tool whitelist. Do not inject all tools, 
      // as this overwhelms the LLM context window (~130k tokens).
      body.enabledTools = originalEnabledTools;
    }

    // Apply Qwen non-leading system message rewrite patch (workaround for Qwen
    // chat template constraint in vLLM). Shared with the vLLM provider so the
    // proxied path and the direct :7778 path apply identical transformations.
    if ((basePath === "/agent" || basePath === "/chat") && req.method === "POST" && body && Array.isArray(body.messages) && typeof body.model === "string") {
      const rewrittenMessages = rewriteNonLeadingSystemMessages(
        body.messages as Array<{ role?: string }>,
        body.model,
        "PrismProxy"
      );
      if (rewrittenMessages !== body.messages) {
        if (body === req.body) {
          body = { ...req.body };
        }
        body.messages = rewrittenMessages;
      }
    }

    const streamQuery = req.query.stream;
    const acceptsSse = req.headers.accept?.includes("text/event-stream");
    const isStream = streamQuery === "true" || (acceptsSse && streamQuery !== "false" && req.body.stream !== false);

    logger.info(`[PrismProxy] Forwarding ${req.method} ${originalPath} to ${REAL_PRISM_URL} (stream=${isStream})`);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json"
      };
      
      // Forward relevant request headers
      const forwardHeaders = ["x-project", "x-username", "authorization", "x-workspace-root"];
      for (const h of forwardHeaders) {
        if (req.headers[h]) {
          headers[h] = req.headers[h] as string;
        }
      }

      // Connect/headers timeout — abort if the upstream never responds.
      // Cleared as soon as headers arrive so long-running SSE streams are
      // never cut off once streaming has begun.
      const upstreamAbortController = new AbortController();
      const headersTimeout = setTimeout(() => {
        logger.error(`[PrismProxy] Upstream headers timeout after ${UPSTREAM_HEADERS_TIMEOUT_MS}ms for ${originalPath}`);
        upstreamAbortController.abort();
      }, UPSTREAM_HEADERS_TIMEOUT_MS);

      let response: globalThis.Response;
      try {
        response = await fetch(targetUrl, {
          method: req.method,
          headers,
          body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(body) : undefined,
          signal: upstreamAbortController.signal
        });
      } finally {
        clearTimeout(headersTimeout);
      }

      if (!response.ok) {
        const errText = await response.text();
        logger.error(`[PrismProxy] Target returned error status=${response.status}: ${errText}`);
        return res.status(response.status).json({ error: errText });
      }

      // Stream whenever the upstream response is SSE — not just for /agent.
      // GET /webhooks/requests/stream is an infinite event-stream; awaiting
      // response.json() on it hangs forever and the client sees a silent
      // connection (this is what starved the office's prism event feed).
      const upstreamContentType = response.headers.get("content-type") || "";
      const respondAsStream =
        upstreamContentType.includes("text/event-stream") ||
        (isStream && basePath === "/agent");

      if (respondAsStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();

        if (response.body) {
          const reader = (response.body as any).getReader();
          // Client-disconnect teardown: if the downstream client goes away
          // mid-stream (e.g. an infinite /webhooks/requests/stream), cancel
          // the upstream reader so the pump loop doesn't consume forever.
          let clientDisconnected = false;
          const handleClientDisconnect = () => {
            clientDisconnected = true;
            reader.cancel?.().catch(() => {});
          };
          res.on("close", handleClientDisconnect);
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done || clientDisconnected) break;
              res.write(value);
            }
          } finally {
            res.off("close", handleClientDisconnect);
            // Client disconnects mid-stream shouldn't leak the upstream reader
            reader.cancel?.().catch(() => {});
          }
          if (clientDisconnected) {
            logger.info(`[PrismProxy] Client disconnected mid-stream for ${originalPath} — upstream reader cancelled`);
          }
        }
        res.end();
      } else {
        const data = await response.json();
        res.json(data);
      }
    } catch (error: any) {
      logger.error(`[PrismProxy] Failed to proxy ${originalPath}: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    }
  }
}
