// Audit characterizations: passing tests document current defects, not desired contracts.
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Function>(), route: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
  setRequestHandler(schema: any, handler: Function) {
    mocks.handlers.set(schema.shape.method.value, handler);
  }
} }));
vi.mock("../LocalToolRouter.ts", () => ({ routeLocalTool: mocks.route }));
vi.mock("../PrismRegistrationService.ts", () => ({ MCP_SERVER_NAME: "offline-audit" }));
import McpAdapter from "../McpAdapter.ts";
beforeEach(() => { mocks.handlers.clear(); mocks.route.mockReset(); });
it("characterizes MCP dispatch without a caller context or a whitelist check", async () => {
  const adapter = new McpAdapter();
  (adapter as any).createMcpServer();
  mocks.route.mockResolvedValue({ ok: true });
  const handler = mocks.handlers.get("tools/call")!;
  await handler({ params: { name: "offline_unlisted_tool", arguments: { ticker: "TEST" } } });
  expect(mocks.route).toHaveBeenCalledExactlyOnceWith("offline_unlisted_tool", { ticker: "TEST" });
});
it("characterizes a resolved tool failure missing the MCP error flag", async () => {
  (new McpAdapter() as any).createMcpServer();
  mocks.route.mockResolvedValue({ error: "offline failure", is_error: true });
  const result = await mocks.handlers.get("tools/call")!({ params: { name: "get_market_data" } });
  expect(JSON.parse(result.content[0].text).is_error).toBe(true);
  expect(result.isError).toBeUndefined();
});
