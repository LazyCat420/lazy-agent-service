import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareToolContext, TOOL_CONTEXT_ARG } from "../TradingToolContext.ts";
import { VllmShimService } from "../vllm/VllmShimService.ts";
import { dispatchTool } from "../ToolDispatch.ts";
beforeEach(() => vi.stubEnv("TRADING_TOOL_CONTEXT_KEY", "offline-transport-key"));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function response() {
  const result = Object.assign(new EventEmitter(), {
    statusCode: 200, headersSent: false, output: "", headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
    flushHeaders() { this.headersSent = true; },
    write(value: any) { this.output += typeof value === "string" ? value : Buffer.from(value).toString(); },
    end(value?: any) { if (value) this.write(value); return this; },
    json(value: any) { this.output = JSON.stringify(value); return this; },
  });
  return result;
}
for (const cycleId of ["cycle-v3-fullpath", "cycle-observe-1788843390", "bench-FIXT-123"])
for (const streaming of [false, true]) it(`binds real shim -> dispatch -> bridge identity ${cycleId} (${streaming ? "SSE" : "JSON"})`, async () => {
  const prepared = prepareToolContext({ project: "vllm-trading-bot", agent: "CUSTOM_V3_JUNIOR_ANALYST", conversationId: "offline-fullpath", enabledTools: ["whiteboard_write"], systemPrompt: "role", messages: [{ role: "user", content: `## Ticker: TEST\n\n## Cycle: ${cycleId}` }] });
  const call = { id: "call-a", type: "function", function: { name: "whiteboard_write", arguments: '{"ticker":"TEST","section":"market_context","content":"offline"}' } };
  const modelResponse = { choices: [{ index: 0, message: { role: "assistant", tool_calls: [call] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 8 } };
  const wire = streaming ? [
    { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, ...call }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: modelResponse.usage },
  ].map(v => `data: ${JSON.stringify(v)}\n\n`).join("") + "data: [DONE]\n\n" : JSON.stringify(modelResponse);
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response(wire, { headers: { "content-type": streaming ? "text/event-stream" : "application/json" } })).mockResolvedValueOnce(new Response('{"ok":true}'));
  vi.stubGlobal("fetch", fetchMock);
  const res = response();
  await VllmShimService.handle({ originalUrl: "/vllm-shim/gold-spark/v1/chat/completions", method: "POST", headers: {}, body: { model: "offline", stream: streaming, tools: [{ type: "function", function: { name: "think" } }, { type: "function", function: { name: "whiteboard_write" } }], messages: [{ role: "system", content: prepared.systemPrompt }, ...prepared.messages] } } as any, res as any);
  expect(res.statusCode).toBe(200);
  const upstream = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(JSON.stringify(upstream)).not.toContain("TRADING_TOOL_CONTEXT");
  expect(upstream.tools.map((t: any) => t.function.name)).toEqual(["whiteboard_write"]);
  expect(upstream.messages[0].content).toContain("TRADING TOOL EXECUTION CONTRACT v1");
  let argumentsText = "";
  if (!streaming) argumentsText = JSON.parse(res.output).choices[0].message.tool_calls[0].function.arguments;
  else for (const event of res.output.split("\n\n")) {
    if (!event.startsWith("data: {")) continue;
    const parsed = JSON.parse(event.slice(6));
    for (const choice of parsed.choices) for (const chunk of choice.delta?.tool_calls || []) argumentsText += chunk.function?.arguments || "";
  }
  expect(JSON.parse(argumentsText)[TOOL_CONTEXT_ARG]).toBeTruthy();
  expect(await dispatchTool("whiteboard_write", JSON.parse(argumentsText), { transport: "mcp" })).toEqual({ ok: true });
  const bridge = JSON.parse(fetchMock.mock.calls[1][1].body);
  expect(bridge).toMatchObject({ cycle_id: cycleId, agent_name: "v3_junior_analyst", ticker: "TEST" });
  expect(bridge.arguments).not.toHaveProperty(TOOL_CONTEXT_ARG);
});
it("rejects bad request identity before contacting a model", async () => {
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  const res = response();
  await VllmShimService.handle({ originalUrl: "/vllm-shim/gold-spark/v1/chat/completions", method: "POST", headers: {}, body: { messages: [{ role: "system", content: "<TRADING_TOOL_CONTEXT_V1>bad.signature</TRADING_TOOL_CONTEXT_V1>" }] } } as any, res as any);
  expect(res.statusCode).toBe(422); expect(fetchMock).not.toHaveBeenCalled();
});

it("leaves the tool catalog and acknowledgements of non-trading callers untouched", async () => {
  const body = { model: "offline", tools: [{ type: "function", function: { name: "think" } }],
    messages: [{ role: "system", content: "ordinary agent" },
      { role: "assistant", tool_calls: [{ id: "a", function: { name: "think", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "a", content: "ack" }] };
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"choices":[{"message":{"content":"done"}}]}', { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  await VllmShimService.handle({ originalUrl: "/vllm-shim/gold-spark/v1/chat/completions", method: "POST", headers: {}, body } as any, response() as any);
  const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(sent.tools).toEqual(body.tools);
  expect(sent.messages).toEqual(body.messages);
});
