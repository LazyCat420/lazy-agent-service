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
import conversationBudgetRouter from "../routes/ConversationBudgetRoute.ts";
import filesRouter from "../routes/FilesRoutes.ts";
import mediaRouter from "../routes/MediaRoutes.ts";
import textRouter from "../routes/TextRoutes.ts";
import lmStudioRouter from "../routes/LmStudioRoutes.ts";
import ollamaRouter from "../routes/OllamaRoutes.ts";
import skillsRouter from "../routes/SkillsRoutes.ts";
import rulesRouter from "../routes/RulesRoutes.ts";
import agentMemoriesRouter from "../routes/AgentMemoriesRoutes.ts";
import mcpServersRouter from "../routes/McpServersRoutes.ts";
import mcpOAuthRouter from "../routes/McpOAuthRoutes.ts";
import favoritesRouter from "../routes/FavoritesRoutes.ts";
import conversationRouter from "../routes/ConversationExecutionRoute.ts";
import statsRouter from "../routes/StatsRoutes.ts";
import benchmarkRouter from "../routes/BenchmarkRoutes.ts";
import experimentRouter from "../routes/ExperimentRoutes.ts";
import harness2Router from "../routes/Harness2Routes.ts";
import synthesisRouter from "../routes/SynthesisRoutes.ts";
import vramBenchmarksRouter from "../routes/VramBenchmarksRoutes.ts";
import orchestratorRouter from "../routes/OrchestratorRoutes.ts";
import topologyRouter from "../routes/TopologyRoutes.ts";
import thoughtStructureRouter from "../routes/ThoughtStructureRoutes.ts";
import settingsRouter from "../routes/SettingsRoutes.ts";
import customAgentsRouter from "../routes/CustomAgentsRoutes.ts";
import workspacesRouter from "../routes/WorkspacesRoutes.ts";
import scheduledTasksRouter from "../routes/ScheduledTasksRoutes.ts";
import promptsRouter from "../routes/PromptsRoutes.ts";
import webhookRouter from "../routes/WebhookRoutes.ts";
import platformRouter from "../routes/PlatformRoutes.ts";
import executeRouter from "../routes/ExecuteRoutes.ts";
import runRouter from "../routes/RunRoutes.ts";
import { createObsidianCompletionRouter } from "../routes/ObsidianCompletionRoutes.ts";
import contractRouter from "../routes/ContractRoutes.ts";
import openAIEmbeddingsRouter from "../routes/OpenAIEmbeddingsRoutes.ts";
import { VllmShimService } from "../services/vllm/VllmShimService.js";
import wallgardenRouter from "../routes/WallgardenRoutes.js";

/** Endpoint registry (single source of truth for health check + startup logs). */
export const ENDPOINTS = {
  rest: [
    "/config",
    "/config-local",
    "/chat",
    "/agent",
    "/text-to-audio",
    "/audio-to-text",
    "/embed",
    "/conversations",
    "/files",
    "/media",
    "/text",
    "/lm-studio",
    "/ollama",
    "/skills",
    "/rules",
    "/agent-memories",
    "/mcp-servers",
    "/favorites",
    "/conversation",

    "/stats",
    "/benchmark",
    "/synthesis",
    "/vram-benchmarks",
    "/orchestrator",
    "/topologies",
    "/thought-structures",
    "/settings",
    "/custom-agents",
    "/workspaces",
    "/scheduled-tasks",
    "/prompts",
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

function installMiddleware(app: Express): void {
  app.use(
    cors({
      origin: true, // reflect request origin (equivalent to *)
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "x-project",
        "x-username",
        "x-workspace-id",
        "x-workspace-root",
        "x-api-secret",
        "x-admin-secret",
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
      res.status(report.httpStatus).json({ status: report.status, checks: report.checks });
    } catch (error) {
      next(error);
    }
  });
}

function installPublicRoutes(app: Express): void {
  app.use("/files", filesRouter);
  // MCP OAuth callback: a browser redirect carries no identity headers (the flow is found by its `state`)
  app.use("/mcp/oauth", mcpOAuthRouter);
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
  app.use("/text-to-audio", audioRouter);
  app.use("/audio-to-text", audioRouter);
  app.use("/embed", embedRouter);
  app.use("/conversations", conversationBudgetRouter);
  app.use("/conversations", conversationsRouter);
  app.use("/media", mediaRouter);
  app.use("/text", textRouter);
  app.use("/lm-studio", lmStudioRouter);
  app.use("/ollama", ollamaRouter);
  app.use("/skills", skillsRouter);
  app.use("/rules", rulesRouter);
  app.use("/agent-memories", agentMemoriesRouter);
  app.use("/mcp-servers", mcpServersRouter);
  app.use("/favorites", favoritesRouter);
  app.use("/conversation", conversationRouter);

  app.use("/stats", statsRouter);
  app.use("/benchmark", benchmarkRouter);
  app.use("/experiment", experimentRouter);
  app.use("/harness2", harness2Router);
  app.use("/synthesis", synthesisRouter);
  app.use("/vram-benchmarks", vramBenchmarksRouter);
  app.use("/orchestrator", orchestratorRouter);
  app.use("/topologies", topologyRouter);
  app.use("/thought-structures", thoughtStructureRouter);
  app.use("/settings", settingsRouter);
  app.use("/custom-agents", customAgentsRouter);
  app.use("/workspaces", workspacesRouter);
  app.use("/scheduled-tasks", scheduledTasksRouter);
  app.use("/prompts", promptsRouter);
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
  // the Qwen boxes /vllm-shim/dell1, /vllm-shim/dell2 via compose env) so a
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
  installPublicRoutes(app);
  installAuthenticatedRoutes(app);
  installCompatRoutes(app, mcpAdapter);

  return { app, server, mcpAdapter };
}
