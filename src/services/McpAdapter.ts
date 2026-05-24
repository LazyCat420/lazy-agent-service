// ────────────────────────────────────────────────────────────
// MCP Adapter — Bridges lazy-tools-api REST endpoints to MCP
// ────────────────────────────────────────────────────────────

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  getToolSchemas,
  type ToolSchema,
} from "./ToolSchemaService.js";
import CONFIG from "../config.js";
import logger from "../logger.js";
import type { Request, Response, Application } from "express";

const SELF_BASE_URL = CONFIG.LAZY_TOOL_SERVICE_URL;

async function executeTool(toolName: string, endpoint: Record<string, any>, args: Record<string, any> = {}): Promise<any> {
  try {
    const url = `${SELF_BASE_URL}${endpoint.path}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!response.ok) {
      return { error: `API returned ${response.status}: ${response.statusText}` };
    }
    return await response.json();
  } catch (error: unknown) {
    return { error: `Tool execution failed: ${(error as Error).message}` };
  }
}

function createMcpServer() {
  const server = new Server(
    { name: "lazy-tools", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  const fullSchemas = getToolSchemas();
  const toolMap = new Map();
  for (const schema of fullSchemas) {
    toolMap.set(schema.name, schema);
  }

  server.setRequestHandler(
    ListToolsRequestSchema,
    async () => {
      const fullSchemas = getToolSchemas();
      return {
        tools: fullSchemas.map((t: ToolSchema) => ({
          name: t.name,
          description: t.description || "",
          inputSchema: t.parameters || { type: "object", properties: {} },
          _meta: {
            domain: t.domain,
            labels: t.labels,
          },
        })),
      };
    },
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
      const { name, arguments: args = {} } = request.params;
      const schema = toolMap.get(name);

      if (!schema || !schema.endpoint) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
          isError: true,
        };
      }

      try {
        const result = await executeTool(name, schema.endpoint, args);
        // Note: result here is the object from execute_tool.py which has a "content" field
        const text = result?.content || JSON.stringify(result);
        return {
          content: [{ type: "text", text }],
          isError: !!result?.error,
        };
      } catch (error: unknown) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: (error as Error).message }) }],
          isError: true,
        };
      }
    },
  );

  return server;
}

export function mountMcpRoutes(app: Application) {
  const sessions = new Map<string, { server: Server; transport: SSEServerTransport }>();

  // 1. Standard SSE transport routes
  app.get("/mcp/sse", async (req: Request, res: Response) => {
    const transport = new SSEServerTransport("/mcp/messages", res);
    const server = createMcpServer();

    sessions.set(transport.sessionId, { server, transport });

    res.on("close", () => {
      sessions.delete(transport.sessionId);
      server.close().catch(() => {});
    });

    await server.connect(transport);
  });

  app.post("/mcp/messages", async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    const session = sessions.get(sessionId);

    if (!session) {
      res.status(400).json({ error: "Invalid or expired session" });
      return;
    }

    await session.transport.handlePostMessage(req, res, req.body);
  });

  logger.info("   🔌 MCP SSE adapter mounted at /mcp/sse");

  // 2. Streamable HTTP transport routes (used by Prism)
  const streamableSessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();

  app.all("/mcp", async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string;
      let session = sessionId ? streamableSessions.get(sessionId) : null;

      if (!session) {
        let generatedSessionId: string | undefined;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => {
            generatedSessionId = randomUUID();
            return generatedSessionId;
          },
          onsessionclosed: (id) => {
            streamableSessions.delete(id);
            server.close().catch(() => {});
          }
        });

        const server = createMcpServer();
        await server.connect(transport);

        transport.onclose = () => {
          if (generatedSessionId) {
            streamableSessions.delete(generatedSessionId);
          }
          server.close().catch(() => {});
        };

        session = { server, transport };

        // Handle the initial request
        await transport.handleRequest(req, res, req.body);

        // Store the session if one was generated
        if (generatedSessionId) {
          streamableSessions.set(generatedSessionId, session);
        }
      } else {
        await session.transport.handleRequest(req, res, req.body);
      }
    } catch (err: any) {
      logger.error(`[MCP-Streamable] Error handling request: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || "Internal server error" });
      }
    }
  });

  logger.info("   🔌 MCP Streamable HTTP adapter mounted at /mcp");
}
