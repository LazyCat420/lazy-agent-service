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

export default class McpAdapter {
  private server: Server;
  private transport: SSEServerTransport | null = null;
  private toolsCache: any[] | null = null;

  constructor() {
    this.server = new Server(
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

    this.setupHandlers();
  }

  private async loadTools() {
    if (this.toolsCache) return this.toolsCache;
    try {
      // tool_schemas.json is located in the root of the repo, or next to package.json
      const schemaPath = path.resolve(process.cwd(), "tool_schemas.json");
      const data = await fs.readFile(schemaPath, "utf-8");
      this.toolsCache = JSON.parse(data);
      return this.toolsCache || [];
    } catch (e) {
      logger.error(`[McpAdapter] Failed to load tool_schemas.json: ${e}`);
      return [];
    }
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
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

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      logger.info(`[McpAdapter] Received tool call for ${request.params.name}`);
      // The actual execution is handled dynamically by html-notes/app/main.py interception,
      // so we just return a success placeholder if Prism tries to execute it directly.
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, message: "Tool intercepted locally by client harness" }),
          },
        ],
      };
    });
  }

  public async handleSse(req: Request, res: Response) {
    logger.info("[McpAdapter] New SSE connection established");
    this.transport = new SSEServerTransport("/mcp/messages", res);
    await this.server.connect(this.transport);
  }

  public async handleMessage(req: Request, res: Response) {
    if (!this.transport) {
      logger.error("[McpAdapter] Received message but no SSE transport is active");
      res.status(500).json({ error: "No active SSE transport" });
      return;
    }
    await this.transport.handlePostMessage(req, res);
  }
}
