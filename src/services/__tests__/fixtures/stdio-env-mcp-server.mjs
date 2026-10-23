// Test fixture for McpStdioGuard.test.ts: a real MCP server over stdio that
// writes the names of the env vars it was started with to argv[2], then
// serves one tool. Proves which env reaches a spawned stdio server.
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const reportPath = process.argv[2];
if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(Object.keys(process.env)));

const server = new McpServer({ name: "stdio-env", version: "1.0.0" });
server.registerTool("ping", { description: "Reply pong" }, async () => ({
  content: [{ type: "text", text: "pong" }],
}));
await server.connect(new StdioServerTransport());
