import http from "node:http";
import express, { type Request, type Response, type NextFunction } from "express";
import logger from "./logger.js";
import CONFIG from "./config.js";
import executeRoutes from "./routes/ExecuteRoutes.js";
import { mountMcpRoutes } from "./services/McpAdapter.js";

const app = express();

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  res.header("Access-Control-Allow-Origin", origin || "*");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Project, X-Username, X-Agent, X-Request-Id, X-Conversation-Id");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "50mb" }));

// Mount execution routes
app.use("/execute", executeRoutes);

// Serve static charts
app.use("/charts", express.static("data/charts"));

// Mount MCP routes
mountMcpRoutes(app);

// Global Error Handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error(`[GlobalErrorHandler] ${err.message}`);
  if (!res.headersSent) {
    res.status(500).json({ error: err.message || "Internal server error" });
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
});
