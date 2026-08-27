import { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import CONFIG from "../../config.ts";
import logger from "../utils/logger.ts";
import { routeLocalTool } from "./LocalToolRouter.ts";
import { MCP_SERVER_NAME } from "./PrismRegistrationService.ts";

// One MCP tool result, in the shape the CallToolRequestSchema handler returns.
type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

// Race a tool execution against the adapter-level deadline and, on expiry,
// answer with a structured TOOL_TIMEOUT result instead of leaving the request
// hanging. Exported for unit tests.
//
// Why this exists (2026-08-26, cycle-v3-1787786020/KSS): prism's MCP client
// cancels any request at a fixed 60s (SDK default; its agentic path never
// overrides it, and resetTimeoutOnProgress never fires because we emit no
// progress notifications). This handler used to await routeLocalTool with no
// deadline, so a slow tool always lost the race and surfaced to the model as
// protocol error -32001 — an unanswerable failure that prism wraps in
// argument-fixing retry guidance, which fed an empty-output death spiral.
// A tool that RETURNS a timeout is an ordinary tool result the model can act
// on. The message text below is model-facing on purpose: it must counter that
// retry guidance, not just describe the timeout.
//
// The underlying execution is NOT cancelled on expiry — same abandoned-work
// semantics the -32001 path already had, and ToolCallGuard's in-flight
// coalescing means a repeat call attaches to it rather than duplicating work.
export function raceToolDeadline(
  toolName: string,
  execution: Promise<McpToolResult>,
  deadlineMs: number = CONFIG.MCP_TOOL_DEADLINE_MS
): Promise<McpToolResult> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return execution;
  let timeoutId: NodeJS.Timeout | undefined;
  const expiry = new Promise<McpToolResult>((resolve) => {
    timeoutId = setTimeout(() => {
      logger.error(
        `[McpAdapter] TOOL_TIMEOUT: ${toolName} exceeded ${deadlineMs}ms — returning structured timeout result before the MCP client's 60s -32001`
      );
      resolve({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `TOOL_TIMEOUT: ${toolName} exceeded ${Math.round(deadlineMs / 1000)}s. This is not an argument problem — do not retry the same call, with or without modified arguments. Proceed with the data you already have and emit your final artifact.`,
              is_error: true,
              tool: toolName,
              timeout_ms: deadlineMs,
            }),
          },
        ],
        isError: true,
      });
    }, deadlineMs);
  });
  return Promise.race([execution, expiry]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}

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
        // One constant, so the protocol handshake and the prism registration
        // can never disagree about what this server is called. They were two
        // hardcoded copies until 2026-08-07.
        name: MCP_SERVER_NAME,
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
        // Route through the shared LocalToolRouter so widget / html_notes /
        // canvas / music tools reach their HTTP targets instead of the
        // trading-service Python bridge. The deadline race answers before the
        // MCP client's fixed 60s so a slow tool degrades to a structured
        // TOOL_TIMEOUT result instead of protocol error -32001.
        return await raceToolDeadline(
          toolName,
          routeLocalTool(toolName, toolArgs).then((result) => ({
            content: [
              {
                type: "text" as const,
                text: typeof result === "string" ? result : JSON.stringify(result),
              },
            ],
          }))
        );
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
