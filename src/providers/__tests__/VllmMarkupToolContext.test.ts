import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createVllmProvider } from "../vllm.ts";
import { TOOL_CONTEXT_ARG, authorizeTradingTool, signToolContext } from "../../services/TradingToolContext.ts";

const token = () => {
  vi.stubEnv("TRADING_TOOL_CONTEXT_KEY", "offline-context-test-key");
  return signToolContext({
    project: "vllm-trading-bot", agentName: "junior", cycleId: "c1", ticker: "JPM",
    conversationId: "conv", allowedTools: ["whiteboard_write"], expiresAt: Date.now() + 60_000,
  });
};
const markup = (name: string) => `<tool_call>\n<function=${name}>\n<parameter=note>\nhello\n</parameter>\n</function>\n</tool_call>`;
const sse = (delta: Record<string, unknown>, finish: string) =>
  new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } });

async function run(delta: Record<string, unknown>, finish: string, system?: string) {
  vi.stubGlobal("fetch", vi.fn(async () => sse(delta, finish)));
  const provider = createVllmProvider("http://vllm.test");
  const calls: any[] = [];
  const messages: any[] = [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: "hi" }];
  for await (const c of provider.generateTextStream!(messages, "m", {
    tools: [{ name: "x", description: "x", parameters: { type: "object", properties: {} } }],
  })) if (typeof c === "object" && c.type === "toolCall") calls.push(c);
  return calls;
}
const marker = (t: string) => `sys <TRADING_TOOL_CONTEXT_V1>${t}</TRADING_TOOL_CONTEXT_V1>`;

beforeEach(() => { vi.stubEnv("TRADING_TOOL_CONTEXT_KEY", "offline-context-test-key"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("vLLM markup tool call trading context", () => {
  it("binds an allowlisted markup call", async () => {
    const t = token();
    const calls = await run({ content: markup("whiteboard_write") }, "stop", marker(t));
    expect(calls).toHaveLength(1);
    expect(calls[0].args[TOOL_CONTEXT_ARG]).toBe(t);
    expect(() => authorizeTradingTool(calls[0].name, calls[0].args)).not.toThrow();
  });
  it("leaves a non-allowlisted markup call unbound", async () => {
    const calls = await run({ content: markup("screener_query") }, "stop", marker(token()));
    expect(calls).toHaveLength(1);
    expect(TOOL_CONTEXT_ARG in calls[0].args).toBe(false);
    expect(() => authorizeTradingTool(calls[0].name, calls[0].args)).toThrow();
  });
  it("yields an expired-context markup call unbound instead of failing the turn", async () => {
    const expired = signToolContext({
      project: "vllm-trading-bot", agentName: "junior", cycleId: "c1", ticker: "JPM",
      conversationId: "conv", allowedTools: ["whiteboard_write"], expiresAt: Date.now() - 1,
    });
    const calls = await run({ content: markup("whiteboard_write") }, "stop", marker(expired));
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ note: "hello" });
  });
  it("does nothing without a marker", async () => {
    const calls = await run({ content: markup("whiteboard_write") }, "stop");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ note: "hello" });
  });
  it("does not touch native tool calls", async () => {
    const calls = await run({ tool_calls: [{ index: 0, id: "call_n", type: "function",
      function: { name: "whiteboard_write", arguments: '{"note":"n"}' } }] }, "tool_calls", marker(token()));
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ note: "n" });
  });
});
