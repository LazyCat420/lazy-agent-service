import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { signToolContext, verifyToolContext, prepareToolContext, extractToolContext, attachToolContext,
  authorizeTradingTool, TOOL_CONTEXT_ARG, signMcpClient, verifyMcpClient } from "../TradingToolContext.ts";
import { TradingToolStream, bindToolResponse } from "../TradingToolStream.ts";
beforeEach(() => vi.stubEnv("TRADING_TOOL_CONTEXT_KEY", "offline-context-test-key"));
afterEach(() => vi.unstubAllEnvs());
const context = () => ({ project: "vllm-trading-bot" as const, agentName: "v3_junior_analyst", cycleId: "cycle-v3-test-a", ticker: "TEST", conversationId: "session-test", allowedTools: ["whiteboard_read", "whiteboard_write"], expiresAt: Date.now() + 60000 });
it("validates stateless capabilities, rejects tampering/expiry and checks exact tool access", () => {
  const ctx = context();
  const token = signToolContext(ctx);
  expect(verifyToolContext(token)).toEqual(ctx);
  expect(() => verifyToolContext(token.slice(0, -4) + "xxxx")).toThrow();
  expect(() => verifyToolContext(signToolContext({ ...context(), expiresAt: 1 }))).toThrow();
  expect(() => authorizeTradingTool("buy_stock", { [TOOL_CONTEXT_ARG]: token })).toThrow("not allowed");
  const result = authorizeTradingTool("mcp__lazy-agent-service__whiteboard_read", { ticker: "OTHER", [TOOL_CONTEXT_ARG]: token });
  expect(result.arguments).toEqual({ ticker: "OTHER" });
  expect(result.context.cycleId).toBe("cycle-v3-test-a");
  expect(() => authorizeTradingTool("whiteboard_read", { [TOOL_CONTEXT_ARG]: signToolContext({ ...context(), cycleId: "" }) })).toThrow("explicit cycle");
});
it("extracts trusted harness headings and removes all capability bytes before model generation", () => {
  const original = { project: "vllm-trading-bot", agent: "CUSTOM_V3_JUNIOR_ANALYST", conversationId: "session-test", enabledTools: ["whiteboard_read", "mcp__lazy-tool-service__whiteboard_read"], systemPrompt: "role", messages: [{ role: "user", content: "## Ticker: TEST\n\n## Cycle: cycle-v3-test-a\n\nevidence" }] };
  const prepared = prepareToolContext(original);
  const extracted = extractToolContext({ messages: [{ role: "system", content: prepared.systemPrompt }, ...prepared.messages] });
  expect(verifyToolContext(extracted.token)).toMatchObject({ agentName: "v3_junior_analyst", cycleId: "cycle-v3-test-a", ticker: "TEST", allowedTools: ["whiteboard_read"] });
  expect(JSON.stringify(extracted.body)).not.toContain(extracted.token!);
  const history = extractToolContext({ messages: [{ role: "assistant", tool_calls: [{ function: { name: "whiteboard_read", arguments: attachToolContext('{"ticker":"TEST"}', extracted.token!) } }] }] });
  expect(history.body.messages[0].tool_calls[0].function.arguments).toBe('{"ticker":"TEST"}');
});
it("binds non-trading compatibility to an authenticated connection, not claimed headers", () => {
  expect(verifyMcpClient(signMcpClient("html-notes-client"))).toBe("html-notes-client");
  expect(verifyMcpClient("html-notes-client")).toBeUndefined();
  expect(verifyMcpClient(signToolContext(context()))).toBeUndefined();
});
it("streaming preserves fragmented UTF-8, interleaved tools, usage and finish events", () => {
  const token = signToolContext(context());
  const chunks = [
    { choices: [{ index: 0, delta: { content: "café ", tool_calls: [{ index: 0, id: "a", function: { name: "whiteboard_read", arguments: '{"ticker":' } }, { index: 1, id: "b", function: { name: "whiteboard_write", arguments: '{"content":"' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '✓"}' } }, { index: 0, function: { arguments: '"TEST"}' } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } },
  ];
  const bytes = Buffer.from(chunks.map(c => `data: ${JSON.stringify(c)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n");
  const stream = new TradingToolStream(token);
  let output = "";
  for (const byte of bytes) output += stream.push(Uint8Array.of(byte));
  output += stream.finish();
  const frames = output.split("\n\n").filter(e => e.startsWith("data: {")).map(e => JSON.parse(e.slice(6)));
  const args = ["", ""];
  for (const f of frames) for (const c of f.choices) for (const t of c.delta?.tool_calls || []) args[t.index] += t.function?.arguments || "";
  expect(JSON.parse(args[0])).toEqual({ ticker: "TEST", [TOOL_CONTEXT_ARG]: token });
  expect(JSON.parse(args[1]).content).toBe("✓");
  expect(frames.filter(f => f.usage)).toHaveLength(1);
  expect(output).toContain("café");
  expect(frames.flatMap(f => f.choices).filter(c => c.finish_reason)).toHaveLength(1);
});
it("does not authorize truncated arguments and keeps foreign tool arguments unchanged", () => {
  const stream = new TradingToolStream(signToolContext(context()));
  expect(() => stream.push(Buffer.from('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"whiteboard_write","arguments":"{"}}]},"finish_reason":"length"}]}\n\n'))).toThrow("Incomplete");
  const foreign = { choices: [{ message: { tool_calls: [{ function: { name: "mcp__other__search", arguments: "{}" } }] } }] };
  expect(bindToolResponse(foreign, signToolContext(context()))).toEqual(foreign);
});
