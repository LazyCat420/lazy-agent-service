import http from "node:http";
import express, { type Request, type Response, type NextFunction } from "express";
import logger from "./logger.js";
import CONFIG, { MONGO_DB_NAME, MONGO_URI } from "../config.js";
import executeRoutes, { executeTool } from "./routes/ExecuteRoutes.js";
import AgentRoutes from "./routes/AgentRoutes.js";
import { mountMcpRoutes } from "./services/McpAdapter.js";
import MongoWrapper from "./wrappers/MongoWrapper.js";
import AgentPersonaRegistry from "./services/AgentPersonaRegistry.js";
import { getErrorMessage } from "./utils/ErrorHelpers.js";
import rateLimit from "express-rate-limit";

const app = express();

// ── CORS — Explicit origin allowlist ────────────────────────
const DEFAULT_CORS_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3035",
  "http://localhost:8888",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3035",
  "http://127.0.0.1:8888",
  "http://10.0.0.16:3000",
  "http://10.0.0.16:3035",
  "http://10.0.0.16:8888",
];

const envOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : [];

const ALLOWED_ORIGINS = new Set([...DEFAULT_CORS_ORIGINS, ...envOrigins]);

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Credentials", "true");
  }
  // If origin is not in allowlist, no ACAO header is set → browser blocks the request
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Project, X-Username, X-Agent, X-Request-Id, X-Conversation-Id, X-Api-Key, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "50mb" }));

// Rate Limiter: 100 requests per 1 minute
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: "Too many requests from this IP, please try again after a minute", code: 429 },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── API Key Authentication — hard-fail in production ────────
const isProduction = process.env.NODE_ENV === "production";

if (isProduction && !CONFIG.LAZY_TOOL_SERVICE_API_KEY) {
  logger.error("FATAL: LAZY_TOOL_SERVICE_API_KEY is not set. Refusing to start in production without authentication.");
  process.exit(1);
}

const requireApiKey = (req: Request, res: Response, next: NextFunction) => {
  if (!CONFIG.LAZY_TOOL_SERVICE_API_KEY) {
    // Dev-only: warn once per startup, allow requests through
    logger.warn("LAZY_TOOL_SERVICE_API_KEY is not set in environment. Running in unsecured mode (dev only)!");
    return next();
  }
  
  const authHeader = req.headers["authorization"];
  const apiKeyHeader = req.headers["x-api-key"];
  
  let providedKey = apiKeyHeader as string;
  if (!providedKey && authHeader && authHeader.startsWith("Bearer ")) {
    providedKey = authHeader.substring(7);
  }

  if (providedKey !== CONFIG.LAZY_TOOL_SERVICE_API_KEY) {
    return res.status(401).json({ error: "Unauthorized: Invalid or missing API Key", code: 401 });
  }
  next();
};

// Mount execution routes (Protected & Rate Limited)
app.use("/execute", apiLimiter, requireApiKey, executeRoutes);
app.use("/agent", apiLimiter, requireApiKey, AgentRoutes);

// Serve static charts
app.use("/charts", express.static("data/charts"));

// Mount MCP routes
mountMcpRoutes(app);

// Global Error Handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error(`[GlobalErrorHandler] ${err.message}`);
  if (!res.headersSent) {
    res.status(500).json({ error: err.message || "Internal server error", code: 500 });
  }
});

// Chat completions proxy route directing to Jetson or Spark vLLM based on model name
app.post(["/chat", "/v1/chat/completions"], apiLimiter, requireApiKey, async (req: Request, res: Response) => {
  const { model, messages, tools, tool_choice, temperature, max_tokens, stream } = req.body;
  const isQwen = String(model || "").toLowerCase().includes("qwen");
  const defaultHost = "10.0.0.16";
  const jetsonUrl = process.env.JETSON_VLLM_URL || `http://${defaultHost}:8001`;
  const sparkUrl = process.env.DGX_SPARK_VLLM_URL || `http://10.0.0.141:8000`;
  const vllmBase = isQwen ? jetsonUrl : sparkUrl;
  
  const targetUrl = `${vllmBase}/v1/chat/completions`;
  logger.info(`[Chat-Proxy] Routing model=${model} to vLLM at ${targetUrl}`);
  
  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        tools,
        tool_choice,
        temperature,
        max_tokens,
        stream: !!stream
      })
    });
    
    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }
    
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      if (response.body) {
        const reader = (response.body as any).getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } else {
      const data = await response.json();
      res.json(data);
    }
  } catch (error: any) {
    logger.error(`[Chat-Proxy] Failed to query vLLM: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Compatibility endpoints for apps expecting Prism API contract
app.get("/config", apiLimiter, requireApiKey, (_req: Request, res: Response) => {
  res.json({
    textToText: {
      models: {
        google: [
          { name: "gemini-2.0-flash-exp", label: "Gemini 2.0 Flash Exp" },
          { name: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
          { name: "gemini-1.5-flash", label: "Gemini 1.5 Flash" }
        ],
        openai: [
          { name: "gpt-4o", label: "GPT-4o" },
          { name: "gpt-4o-mini", label: "GPT-4o Mini" }
        ],
        anthropic: [
          { name: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet" }
        ]
      }
    }
  });
});

app.post("/audio-to-text", apiLimiter, requireApiKey, async (req: Request, res: Response) => {
  const { audio, audioUrl } = req.body;
  try {
    const result = (await executeTool("transcribe_audio", { audio, audioUrl })) as any;
    const text = result?.text || result?.transcription || "";
    res.json({ text });
  } catch (error: any) {
    logger.error(`Audio transcription compatibility endpoint failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    service: "lazy-tool-service",
  });
});

const port = CONFIG.LAZY_TOOL_SERVICE_PORT;
const httpServer = http.createServer(app);

httpServer.listen(port, async () => {
  logger.success(`Lazy Tools API running on port ${port}`);
  logger.info(`Endpoint: /execute/:toolName`);
  logger.info(`MCP SSE endpoint: /mcp/sse`);
  if (!isProduction) {
    logger.info(`CORS allowed origins: ${[...ALLOWED_ORIGINS].join(", ")}`);
  }

  // Initialize MongoDB connection and load custom agents
  try {
    if (MONGO_URI) {
      await MongoWrapper.createClient(MONGO_DB_NAME, MONGO_URI);
      await AgentPersonaRegistry.loadCustomAgents();
    } else {
      logger.warn("MONGO_URI not defined, skipping DB connection");
    }
  } catch (error: unknown) {
    logger.error(`Database initialization or custom agent loading failed: ${getErrorMessage(error)}`);
  }
});
