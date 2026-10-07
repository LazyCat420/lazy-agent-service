/**
 * Native /agent must give a trading agent what /prism-proxy gives it.
 *
 * Found 2026-10-07 while moving trading off prism (documentation ch.05/ch.06):
 *   - the trading boundary (signed tool context, learning marker, unattended)
 *     was applied on /prism-proxy only, so every trading tool call on native
 *     /agent came back PERMISSION_DENIED from ToolDispatch;
 *   - the native catalog held no trading tools at all ("trading tools stay off
 *     the agent pool"), and a local tool ran through executeMCPTool with a
 *     conversation UUID as its cycle and no authorization.
 * These pin the route, the catalog and the dispatch path.
 */
import http from "node:http";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handleAgent = vi.fn(async () => {});
vi.mock("../../routes/ChatRoutes.ts", () => ({ handleAgent: (...args: unknown[]) => handleAgent(...(args as [])) }));
const dispatchTool = vi.fn(async () => ({ content: "{}" }));
vi.mock("../ToolDispatch.js", () => ({ dispatchTool: (...args: unknown[]) => dispatchTool(...(args as [])) }));

import agentRouter from "../../routes/AgentRoutes.ts";
import ToolOrchestratorService from "../ToolOrchestratorService.ts";
import { prepareTradingAgentRequest } from "../TradingAgentRequest.ts";
import { extractToolContext, verifyToolContext } from "../TradingToolContext.ts";

const TRADING = "vllm-trading-bot";

function tradingBody(overrides: Record<string, unknown> = {}) {
  return {
    project: TRADING,
    provider: "vllm",
    model: "m",
    agent: "CUSTOM_V3_JUNIOR_ANALYST",
    conversationId: "conv-native-1",
    enabledTools: ["get_market_data", "mcp__lazy-agent-service__get_market_data", "whiteboard_write"],
    systemPrompt: "ROLE PROMPT",
    messages: [{ role: "user", content: "## Ticker: COF\n## Cycle: probe-parity-ours-1791350000\n\nevidence" }],
    ...overrides,
  };
}

beforeEach(() => vi.stubEnv("TRADING_TOOL_CONTEXT_KEY", "offline-context-test-key"));
afterEach(() => {
  vi.unstubAllEnvs();
  handleAgent.mockClear();
  dispatchTool.mockClear();
});

describe("the trading boundary, shared by both routes", () => {
  it("signs the cycle, ticker and role catalog into the system prompt and marks the run unattended", () => {
    const prepared = prepareTradingAgentRequest(tradingBody());
    expect(prepared.unattended).toBe(true);
    expect(prepared.systemPrompt).toContain("TRADING_LEARNING_BOUNDARY_V2");
    expect(prepared.systemPrompt).toMatch(/ROLE PROMPT$/);
    const { token } = extractToolContext({ messages: [{ role: "system", content: prepared.systemPrompt }] });
    expect(verifyToolContext(token)).toMatchObject({
      agentName: "v3_junior_analyst", cycleId: "probe-parity-ours-1791350000", ticker: "COF",
      allowedTools: ["get_market_data", "whiteboard_write"],
    });
  });

  it("leaves every other project alone", () => {
    const body = tradingBody({ project: "html-notes" });
    expect(prepareTradingAgentRequest(body)).toEqual(body);
  });

  it("refuses a trading request that cannot reach the vLLM shim", () => {
    expect(() => prepareTradingAgentRequest(tradingBody({ provider: "openai" }))).toThrow(/vLLM shim provider/);
  });
});

describe("native POST /agent", () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  async function post(body: Record<string, unknown>, project = TRADING) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.project = project;
      req.username = "test-user";
      next();
    });
    app.use("/agent", agentRouter);
    server = await new Promise<http.Server>((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const { port } = server.address() as { port: number };
    return fetch(`http://127.0.0.1:${port}/agent?stream=false`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  }

  it("hands the loop a prepared trading request", async () => {
    await post(tradingBody());
    expect(handleAgent).toHaveBeenCalledTimes(1);
    const params = (handleAgent.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(params.unattended).toBe(true);
    expect(String(params.systemPrompt)).toContain("TRADING_TOOL_CONTEXT_V1");
    expect(String(params.systemPrompt)).toMatch(/ROLE PROMPT$/);
  });

  it("answers 422 to a trading request the boundary refuses, as /prism-proxy does", async () => {
    const res = await post(tradingBody({ provider: "openai" }));
    expect(res.status).toBe(422);
    expect(handleAgent).not.toHaveBeenCalled();
  });

  it("passes a non-trading request through untouched", async () => {
    await post({ provider: "vllm", model: "m", messages: [{ role: "user", content: "hi" }], systemPrompt: "P" }, "html-notes");
    const params = (handleAgent.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(params.systemPrompt).toBe("P");
    expect(params.unattended).toBeUndefined();
  });
});

describe("trading tools on the native loop", () => {
  it("offers the trading catalog under prism's names, one schema per tool", () => {
    const merged = ToolOrchestratorService.withTradingCatalog([
      { name: "mcp__lazy-tool-service__lazy_web_search" }, { name: "create_widget" }]);
    const names = merged.map((tool) => tool.name);
    expect(names).toContain("mcp__lazy-agent-service__get_market_data");
    expect(names).toContain("mcp__lazy-agent-service__lazy_web_search");
    expect(names).not.toContain("mcp__lazy-tool-service__lazy_web_search");
    expect(names).toContain("create_widget");
    expect(names.filter((n) => n.endsWith("__lazy_web_search"))).toHaveLength(1);
  });

  it("recognises a trading call only from a trading request", () => {
    for (const name of ["mcp__lazy-agent-service__get_market_data", "mcp__lazy-tool-service__get_market_data", "get_market_data"]) {
      expect(ToolOrchestratorService.isTradingToolCall(name, { project: TRADING })).toBe(true);
      expect(ToolOrchestratorService.isTradingToolCall(name, { project: "html-notes" })).toBe(false);
    }
    expect(ToolOrchestratorService.isTradingToolCall("create_widget", { project: TRADING })).toBe(false);
    expect(ToolOrchestratorService.isTradingToolCall("mcp__other-server__get_market_data", { project: TRADING })).toBe(false);
  });

  it("gives the model the bridge result's content, fitted to the per-result limit, as prism's MCP path does", async () => {
    const bridge = (content: string) => ({ role: "tool", tool_call_id: "call_lazy_tool_bridge", name: "get_finnhub_news", content });
    const ctx = { project: TRADING, agent: "CUSTOM_V3_JUNIOR_ANALYST" };

    dispatchTool.mockResolvedValueOnce(bridge("## Recent News\n- one headline") as never);
    expect(await ToolOrchestratorService.executeTool("mcp__lazy-agent-service__get_finnhub_news", {}, ctx))
      .toBe("## Recent News\n- one headline");

    const long = Array.from({ length: 400 }, (_, i) => `- headline ${i}: ${"x".repeat(40)}`).join("\n");
    dispatchTool.mockResolvedValueOnce(bridge(long) as never);
    const cut = await ToolOrchestratorService.executeTool("mcp__lazy-agent-service__get_finnhub_news", {}, ctx);
    expect(typeof cut).toBe("string");
    expect((cut as string).length).toBeLessThanOrEqual(8000);
    expect(cut as string).toContain("cut to fit the model's per-result limit");

    const refusal = { error: "PERMISSION_DENIED", message: "no signed context", is_error: true };
    dispatchTool.mockResolvedValueOnce(refusal as never);
    expect(await ToolOrchestratorService.executeTool("mcp__lazy-agent-service__get_finnhub_news", {}, ctx)).toEqual(refusal);
  });

  it("dispatches a trading call through ToolDispatch with the bare name and the caller's identity", async () => {
    const args = { ticker: "COF", _lazy_trading_context: "signed" };
    await ToolOrchestratorService.executeTool("mcp__lazy-agent-service__get_market_data", args,
      { project: TRADING, agent: "CUSTOM_V3_JUNIOR_ANALYST", conversationId: "conv-native-unregistered" });
    expect(dispatchTool).toHaveBeenCalledWith("get_market_data", args,
      { project: TRADING, agentName: "CUSTOM_V3_JUNIOR_ANALYST", transport: "rest" });
  });
});
