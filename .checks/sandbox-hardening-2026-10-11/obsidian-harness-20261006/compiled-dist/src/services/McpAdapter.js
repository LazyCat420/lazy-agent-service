import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import CONFIG from "../../config.js";
import logger from "../utils/logger.js";
import { dispatchTool } from "./ToolDispatch.js";
import { classifyToolResult } from "./ToolResult.js";
import { modelVisibleText } from "./ModelVisibleToolResult.js";
import { verifyMcpClient } from "./TradingToolContext.js";
import { MCP_SERVER_NAME } from "./PrismRegistrationService.js";
import { toMcpTool } from "./McpToolAnnotations.js";
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
// semantics the -32001 path already had. Reusable reads may coalesce; writes
// do not. A timed-out write has an unknown outcome and must not be retried
// as though cancellation or rollback had occurred.
export function raceToolDeadline(toolName, execution, deadlineMs = CONFIG.MCP_TOOL_DEADLINE_MS) {
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0)
        return execution;
    let timeoutId;
    const expiry = new Promise((resolve) => {
        timeoutId = setTimeout(() => {
            logger.error(`[McpAdapter] TOOL_TIMEOUT: ${toolName} exceeded ${deadlineMs}ms — returning structured timeout result before the MCP client's 60s -32001`);
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
        if (timeoutId !== undefined)
            clearTimeout(timeoutId);
    });
}
export default class McpAdapter {
    sessions = new Map();
    toolsCache = null;
    constructor() { }
    async loadTools() {
        if (this.toolsCache)
            return this.toolsCache;
        try {
            const schemaPath = path.resolve(process.cwd(), "tool_schemas.json");
            const data = await fs.readFile(schemaPath, "utf-8");
            this.toolsCache = JSON.parse(data);
            return this.toolsCache || [];
        }
        catch (e) {
            logger.error(`[McpAdapter] Failed to load tool_schemas.json: ${e}`);
            return [];
        }
    }
    createMcpServer(authenticatedProject) {
        const server = new Server({
            // One constant, so the protocol handshake and the prism registration
            // can never disagree about what this server is called. They were two
            // hardcoded copies until 2026-08-07.
            name: MCP_SERVER_NAME,
            version: "1.0.0",
        }, {
            capabilities: {
                tools: {},
            },
        });
        server.setRequestHandler(ListToolsRequestSchema, async () => {
            const rawTools = await this.loadTools();
            const mcpTools = rawTools.map(toMcpTool);
            return {
                tools: mcpTools,
            };
        });
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const toolName = request.params.name;
            const toolArgs = (request.params.arguments || {});
            logger.info(`[McpAdapter] Received tool call for ${toolName}`);
            try {
                // Route through the shared LocalToolRouter so widget / html_notes /
                // canvas / music tools reach their HTTP targets instead of the
                // trading-service Python bridge. The deadline race answers before the
                // MCP client's fixed 60s so a slow tool degrades to a structured
                // TOOL_TIMEOUT result instead of protocol error -32001.
                return await raceToolDeadline(toolName, dispatchTool(toolName, toolArgs, { transport: "mcp", authenticatedProject }).then((result) => {
                    // A trading bridge result goes to the model unwrapped and within prism's
                    // per-result limit (ModelVisibleToolResult.ts); everything else is unchanged.
                    const visible = modelVisibleText(result);
                    if (visible.cut) {
                        logger.info(`[McpAdapter] ${toolName} result cut to fit prism's per-result limit: ${visible.before} -> ${visible.after} chars`);
                    }
                    return {
                        isError: !classifyToolResult(result).success,
                        content: [{ type: "text", text: visible.text }],
                    };
                }));
            }
            catch (err) {
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
    async handleSse(req, res) {
        logger.info("[McpAdapter] New SSE connection request received");
        const transport = new SSEServerTransport("/mcp/messages", res);
        const server = this.createMcpServer(verifyMcpClient(req.headers["x-lazy-tool-client"]));
        this.sessions.set(transport.sessionId, { server, transport });
        res.on("close", () => {
            logger.info(`[McpAdapter] SSE connection closed for session: ${transport.sessionId}`);
            this.sessions.delete(transport.sessionId);
            server.close().catch(() => { });
        });
        await server.connect(transport);
    }
    async handleMessage(req, res) {
        const sessionId = req.query.sessionId;
        const session = this.sessions.get(sessionId);
        if (!session) {
            logger.error(`[McpAdapter] Received message for invalid or expired session: ${sessionId}`);
            res.status(400).json({ error: "Invalid or expired session" });
            return;
        }
        await session.transport.handlePostMessage(req, res, req.body);
    }
}
//# sourceMappingURL=McpAdapter.js.map