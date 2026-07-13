import { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import logger from "../utils/logger.ts";
import { executeTool } from "../routes/ExecuteRoutes.ts";

export default class McpAdapter {
  private sessions = new Map<
    string,
    { server: Server; transport: SSEServerTransport }
  >();
  private toolsCache: any[] | null = null;

  constructor() {}

  private async loadTools() {
    if (this.toolsCache) return this.toolsCache;
    try {
      const schemaPath = path.resolve(process.cwd(), "tool_schemas.json");
      const data = await fs.readFile(schemaPath, "utf-8");
      this.toolsCache = JSON.parse(data);
      return this.toolsCache || [];
    } catch (e) {
      logger.error(`[McpAdapter] Failed to load tool_schemas.json: ${e}`);
      return [];
    }
  }

  private createMcpServer(): Server {
    const server = new Server(
      {
        name: "lazy-tool-service",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const rawTools = await this.loadTools();
      const mcpTools = rawTools.map((t: any) => ({
        name: t.name,
        description: t.description || "",
        inputSchema: t.parameters || { type: "object", properties: {} },
      }));

      return {
        tools: mcpTools,
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const toolArgs = (request.params.arguments || {}) as Record<string, unknown>;
      logger.info(`[McpAdapter] Received tool call for ${toolName}`);
      
      try {
        const result = await executeTool(toolName, toolArgs);
        return {
          content: [
            {
              type: "text",
              text: typeof result === "string" ? result : JSON.stringify(result),
            },
          ],
        };
      } catch (err: any) {
        logger.error(`[McpAdapter] Tool execution failed for ${toolName}: ${err.message}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: err.message }),
            },
          ],
          isError: true,
        };
      }
    });

    return server;
  }

  public async handleSse(req: Request, res: Response) {
    logger.info("[McpAdapter] New SSE connection request received");
    const transport = new SSEServerTransport("/mcp/messages", res);
    const server = this.createMcpServer();

    this.sessions.set(transport.sessionId, { server, transport });

    res.on("close", () => {
      logger.info(`[McpAdapter] SSE connection closed for session: ${transport.sessionId}`);
      this.sessions.delete(transport.sessionId);
      server.close().catch(() => {});
    });

    await server.connect(transport);
  }

  public async handleMessage(req: Request, res: Response) {
    const sessionId = req.query.sessionId as string;
    const session = this.sessions.get(sessionId);

    if (!session) {
      logger.error(`[McpAdapter] Received message for invalid or expired session: ${sessionId}`);
      res.status(400).json({ error: "Invalid or expired session" });
      return;
    }

    await session.transport.handlePostMessage(req, res, req.body);
  }
}
