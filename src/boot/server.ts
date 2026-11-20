import express, { Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import http from "http";

import { errorHandler } from "../utils/errors.ts";
import { listProviders } from "../providers/index.ts";
import { authMiddleware } from "../middleware/AuthMiddleware.ts";
import { requestLoggerMiddleware } from "../middleware/RequestLoggerMiddleware.ts";
import { CORS_MAX_AGE_SECONDS, PROVIDERS } from "../constants.ts";
import McpAdapter from "../services/McpAdapter.ts";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { getInstancesByType } from "../providers/instance-registry.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import { createHealthProbe } from "./healthProbe.ts";

// Routes
import chatRouter from "../routes/ChatRoutes.ts";
import agentRouter from "../routes/AgentRoutes.ts";
import audioRouter from "../routes/AudioRoutes.ts";
import embedRouter from "../routes/EmbedRoutes.ts";
import configRouter, { localConfigRouter } from "../routes/ConfigRoutes.ts";
import conversationsRouter from "../routes/ConversationsRoutes.ts";
import harness2Router from "../routes/Harness2Routes.ts";
import customAgentsRouter from "../routes/CustomAgentsRoutes.ts";
import webhookRouter from "../routes/WebhookRoutes.ts";
import platformRouter from "../routes/PlatformRoutes.ts";
import executeRouter from "../routes/ExecuteRoutes.ts";
import runRouter from "../routes/RunRoutes.ts";
import { createObsidianCompletionRouter } from "../routes/ObsidianCompletionRoutes.ts";
import contractRouter from "../routes/ContractRoutes.ts";
import openAIEmbeddingsRouter from "../routes/OpenAIEmbeddingsRoutes.ts";
import { VllmShimService } from "../services/vllm/VllmShimService.js";
import { qwenPoolStats } from "../services/vllm/VllmQwenPool.ts";
import wallgardenRouter from "../routes/WallgardenRoutes.js";

/** Endpoint registry (single source of truth for health check + startup logs). */
export const ENDPOINTS = {
  rest: [
    "/config",
    "/config-local",
    "/chat",
    "/agent",
    "/audio-to-text",
    "/embed",
    "/conversations",
    "/custom-agents",
    "/webhooks",
    "/v1/runs",
    "/v1/embeddings",
    "/obsidian-completions",
  ],
};

export interface HttpRuntime {
  app: Express;
  server: http.Server;
  mcpAdapter: McpAdapter;
}

/**
 * Origins the browser UIs are served from: trading-client (:3030), prism-client
 * (:3333), the LAS chat UI itself (:5591) and the legacy tools UI (:8888), on
 * loopback and the NAS LAN address. Extend with CORS_ORIGINS (comma-separated).
 * Requests without an Origin header (same-origin navigation, curl, server-to-
 * server) are not CORS requests and always pass.
 */
const DEFAULT_CORS_ORIGINS = [
  "http://localhost:3030",
  "http://localhost:3333",
  "http://localhost:5591",
  "http://localhost:8888",
  "http://127.0.0.1:3030",
  "http://127.0.0.1:3333",
  "http://127.0.0.1:5591",
  "http://127.0.0.1:8888",
  "http://10.0.0.16:3030",
  "http://10.0.0.16:3333",
  "http://10.0.0.16:5591",
  "http://10.0.0.16:8888",
];

const corsOrigins = (): Set<string> =>
  new Set([
    ...DEFAULT_CORS_ORIGINS,
    ...(process.env.CORS_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ]);

function installMiddleware(app: Express): void {
  const allowedOrigins = corsOrigins();
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "x-project",
        "x-username",
        "x-workspace-id",
        "x-workspace-root",
        "x-api-secret",
        "x-api-key",
        "x-admin-secret",
        "x-runtime-token",
      ],
      maxAge: CORS_MAX_AGE_SECONDS, // cache preflight for 24h — eliminates burst OPTIONS storms
    }),
  );
  app.use(express.json({ limit: "50mb" }));
  app.use(requestLoggerMiddleware);
}

/**
 * Is a configured vLLM box actually in rotation? Every PROVIDER_VLLM_*_URL
 * points at our own shim (/vllm-shim/<name>), and some upstreams are
 * registered but disabled by default (jetson-2 = LAS vllm-3, the embedder,
 * unless ENABLE_JETSON_2=1 — VllmShimService answers 404 by design). Probing
 * those would pin /health to `degraded` forever, so ask the shim's own
 * enabled check; URLs that are not shim routes are always probed.
 */
function isBoxEnabled(baseUrl: string): boolean {
  try {
    const resolved = VllmShimService.resolveUpstream(new URL(baseUrl).pathname);
    return resolved ? VllmShimService.upstreamEnabled(resolved.upstreamName) : true;
  } catch {
    return true; // unparsable URL — let the probe itself report the failure
  }
}

function installHealthRoutes(app: Express): void {
  // LF-11: the static `{"status":"ok"}` kept the container green while Mongo
  // or every model box was dead. This probe pings the Mongo connection the
  // service already holds and GETs <base>/v1/models on every configured vLLM
  // box, both with a 2 s timeout. Contract with the compose healthcheck
  // (wget exit code) and deploy script: the route path and the `status` key
  // stay, `degraded` answers 200 so a partial outage never marks the
  // container unhealthy, and only a total outage (Mongo down or every box
  // down) answers 503. Results are cached 10 s so a probe storm cannot
  // hammer the boxes.
  const healthProbe = createHealthProbe({
    pingMongo: async () => {
      const db = MongoWrapper.getDb(MONGO_DB_NAME);
      await db.command({ ping: 1 });
    },
    listBoxes: () =>
      getInstancesByType(PROVIDERS.VLLM).map((entry) => ({
        name: entry.id,
        url: entry.baseUrl,
        enabled: isBoxEnabled(entry.baseUrl),
      })),
  });
  app.get("/", (_req: Request, res: Response) => {
    res.json({
      name: "Lazy Agent Service",
      version: "1.0.0",
      providers: listProviders(),
      endpoints: ENDPOINTS,
    });
  });
  app.get("/health", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await healthProbe.check();
      const pool = qwenPoolStats();
      const anyMemberDown = pool.members.some((m) => !m.up);
      const status = report.status === "ok" && anyMemberDown ? "degraded" : report.status;
      // Pool attribution rides the status endpoint: `served` counts how many
      // responses each Qwen box answered since boot, running/waiting are
      // the gauges the pool routes on, and a down member promotes ok -> degraded.
      res.status(report.httpStatus).json({
        status,
        checks: report.checks,
        pool,
      });
    } catch (error) {
      next(error);
    }
  });
}

function installAuthenticatedRoutes(app: Express): void {
  app.use(authMiddleware);

  app.use("/config", configRouter);
  app.use("/config-local", localConfigRouter);
  // First-party chat UI (static). Registered BEFORE chatRouter: express.static
  // only handles GET/HEAD, so POST /chat (the SSE turn endpoint) falls through
  // to chatRouter while GET /chat serves public/chat/index.html.
  app.use("/chat", express.static("public/chat"));
  app.use("/chat", chatRouter);
  app.use("/agent", agentRouter);
  app.use("/obsidian-completions", createObsidianCompletionRouter());
  app.use("/audio-to-text", audioRouter);
  app.use("/embed", embedRouter);
  app.use("/conversations", conversationsRouter);
  app.use("/harness2", harness2Router);
  app.use("/custom-agents", customAgentsRouter);
  app.use("/webhooks", webhookRouter);
  app.use("/execute", executeRouter);
  app.use("/platform", platformRouter);
  app.use("/v1/runs", runRouter);
  app.use("/v1/contracts", contractRouter);
  app.use("/v1/embeddings", openAIEmbeddingsRouter);

  // Platform dashboard — cross-project tool telemetry. Lives here (not in
  // trading-client) because this service owns the tool registry; trading-client
  // scopes its own Tools tab to owner_app === "trading".
  app.use("/dashboard", express.static("public"));
}

function installCompatRoutes(app: Express, mcpAdapter: McpAdapter): void {
  app.get("/mcp/sse", (req: Request, res: Response, next: NextFunction) => {
    mcpAdapter.handleSse(req, res).catch(next);
  });
  app.post("/mcp/messages", (req: Request, res: Response, next: NextFunction) => {
    mcpAdapter.handleMessage(req, res).catch(next);
  });
  // vLLM translation shim. ALL PROVIDER_VLLM_*_URL entries in the vault point
  // here (/vllm-shim/gold-spark, /vllm-shim/jetson, /vllm-shim/jetson-2, and
  // the pooled Qwen route /vllm-shim/qwen for vllm-4/vllm-5 via compose env;
  // legacy per-member routes /vllm-shim/dell1 and /vllm-shim/dell2 remain
  // swapped vs the physical boxes: dell1 -> dellbox2@10.0.0.131, dell2 ->
  // dellbox1@10.0.0.37; see VllmShimService UPSTREAMS) so a
  // model swap on any box can never silently strand a thinking-flag spelling.
  // This service is the gateway (:5591); prism-service is retired and no route
  // forwards to it. See VllmShimService for why.
  app.use("/vllm-shim", async (req: Request, res: Response) => {
    await VllmShimService.handle(req, res);
  });
  app.use("/charts", express.static("data/charts"));
  app.use("/wallgarden", wallgardenRouter);
  // Error handler (must be last)
  app.use(errorHandler);
}

/**
 * Build the whole HTTP surface: middleware, every route group, the MCP
 * adapter's SSE/message pair, and the error handler.
 * Pure wiring — no I/O, no timers — so it is safe to call from a test.
 */
export function createHttpRuntime(): HttpRuntime {
  const app = express();
  const server = http.createServer(app);
  // Disable the default 5-minute request timeout for long-lived SSE connections.
  // Node.js 18+ defaults `requestTimeout` to 300,000ms which kills ANY response
  // cycle exceeding 5 minutes — including active SSE streams where data is flowing
  // continuously. SSE lifecycle is managed by AbortController + client disconnect,
  // so the server-level timeout is redundant and harmful for streaming workloads.
  server.requestTimeout = 0;

  const mcpAdapter = new McpAdapter();

  installMiddleware(app);
  installHealthRoutes(app);
  installAuthenticatedRoutes(app);
  installCompatRoutes(app, mcpAdapter);

  return { app, server, mcpAdapter };
}
