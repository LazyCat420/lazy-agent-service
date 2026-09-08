// Regression tests replacing the original audit characterizations.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Function>(), route: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
  setRequestHandler(schema: any, handler: Function) { mocks.handlers.set(schema.shape.method.value, handler); }
} }));
vi.mock("../LocalToolRouter.ts", () => ({ routeLocalTool: mocks.route }));
vi.mock("../PrismRegistrationService.ts", () => ({ MCP_SERVER_NAME: "offline-audit" }));
import McpAdapter from "../McpAdapter.ts";
import { dispatchTool } from "../ToolDispatch.ts";
import { signToolContext, TOOL_CONTEXT_ARG } from "../TradingToolContext.ts";
beforeEach(() => { mocks.handlers.clear(); mocks.route.mockReset(); vi.stubEnv("TRADING_TOOL_CONTEXT_KEY", "offline-test-key"); });
afterEach(() => vi.unstubAllEnvs());
const context = () => ({ project: "vllm-trading-bot" as const, agentName: "v3_junior_analyst", cycleId: "cycle-v3-offline", ticker: "TEST", conversationId: "offline-session", allowedTools: ["whiteboard_read"], expiresAt: Date.now() + 60000 });
const handler = () => { (new McpAdapter() as any).createMcpServer(); return mocks.handlers.get("tools/call")!; };
it("refuses an unbound trading MCP call before routing", async () => {
  const result = await handler()({ params: { name: "whiteboard_write", arguments: { ticker: "TEST" } } });
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0].text).error).toBe("PERMISSION_DENIED");
  expect(mocks.route).not.toHaveBeenCalled();
});
it("forwards verified per-call identity and clean arguments, without session registration", async () => {
  mocks.route.mockResolvedValue({ entries: [] });
  const ctx = context();
  const result = await handler()({ params: { name: "whiteboard_read", arguments: { ticker: "TEST", [TOOL_CONTEXT_ARG]: signToolContext(ctx) } } });
  expect(result.isError).toBe(false);
  expect(mocks.route).toHaveBeenCalledExactlyOnceWith("whiteboard_read", { ticker: "TEST" }, ctx);
});
it("enforces the same role whitelist on REST and MCP", async () => {
  const args = { [TOOL_CONTEXT_ARG]: signToolContext(context()) };
  const result = await handler()({ params: { name: "buy_stock", arguments: args } });
  expect(result.isError).toBe(true);
  expect(await dispatchTool("buy_stock", args, { transport: "rest" })).toMatchObject({ error: "PERMISSION_DENIED" });
  expect(await dispatchTool("whiteboard_read", {}, { transport: "rest", project: "vllm-trading-bot" })).toMatchObject({ error: "PERMISSION_DENIED" });
  expect(mocks.route).not.toHaveBeenCalled();
});
it("preserves explicit non-trading MCP compatibility but never overrides a bad per-call token", async () => {
  (new McpAdapter() as any).createMcpServer("html-notes-client");
  mocks.route.mockResolvedValue({ ok: true });
  const h = mocks.handlers.get("tools/call")!;
  expect((await h({ params: { name: "get_market_data", arguments: { ticker: "TEST" } } })).isError).toBe(false);
  expect((await h({ params: { name: "get_market_data", arguments: { [TOOL_CONTEXT_ARG]: "invalid" } } })).isError).toBe(true);
  expect(mocks.route).toHaveBeenCalledTimes(1);
});
it("propagates returned failures as MCP errors and preserves empty successes", async () => {
  const h = handler();
  const args = { [TOOL_CONTEXT_ARG]: signToolContext(context()) };
  for (const failure of [{ error: "offline failure", is_error: true }, '{"success":false,"message":"unavailable"}']) {
    mocks.route.mockResolvedValueOnce(failure);
    expect((await h({ params: { name: "whiteboard_read", arguments: args } })).isError).toBe(true);
  }
  mocks.route.mockResolvedValueOnce({ entries: [] });
  expect((await h({ params: { name: "whiteboard_read", arguments: args } })).isError).toBe(false);
});
