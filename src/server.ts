import http from "node:http";
import express, { type Request, type Response, type NextFunction } from "express";
import logger from "./logger.js";
import CONFIG from "./config.js";
import executeRoutes from "./routes/ExecuteRoutes.js";
import { mountMcpRoutes } from "./services/McpAdapter.js";
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

httpServer.listen(port, () => {
  logger.success(`Lazy Tools API running on port ${port}`);
  logger.info(`Endpoint: /execute/:toolName`);
  logger.info(`MCP SSE endpoint: /mcp/sse`);
  if (!isProduction) {
    logger.info(`CORS allowed origins: ${[...ALLOWED_ORIGINS].join(", ")}`);
  }
});
