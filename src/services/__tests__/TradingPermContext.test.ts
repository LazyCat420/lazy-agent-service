/** 2026-11-03, cycle-v3-1793702165 MSFT: every v3_junior_analyst call on the role's own
 * allowlist failed `PERMISSION_DENIED: Missing trading tool authorization` (agent_traces),
 * because a call recovered from text markup reached ToolDispatch without the signed context. */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createVllmProvider } from "../../providers/vllm.ts";
import { dispatchTool } from "../ToolDispatch.ts";
import { signToolContext } from "../TradingToolContext.ts";
import { bindRecoveredToolArgs } from "../TradingToolStream.ts";
import { VllmShimService } from "../vllm/VllmShimService.ts";

const ALLOWED = ["get_upcoming_events", "lazy_web_search", "list_watches", "screener_query", "whiteboard_write"];
const caller = { project: "vllm-trading-bot", agentName: "v3_junior_analyst" };
const token = () => signToolContext({ project: "vllm-trading-bot", agentName: "v3_junior_analyst",
  cycleId: "cycle-v3-1793702165", ticker: "MSFT", conversationId: "conv", allowedTools: ALLOWED, expiresAt: Date.now() + 60_000 });
/** The trading-service bridge: it rejects a non-string whiteboard content, as the real endpoint does. */
const bridge = vi.fn(async (_url: unknown, init: { body: string }) => {
  const { arguments: args } = JSON.parse(init.body);
  return new Response(typeof args.content === "string" ? '{"ok":true}' : '{"error":"\\"content\\" must be string"}');
});

/** The model answers with text markup; the vLLM provider recovers it as a tool call. */
async function markupCall(name: string, t: string): Promise<{ name: string; args: Record<string, unknown> }> {
  const content = `<tool_call>\n<function=${name}>\n<parameter=ticker>\nMSFT\n</parameter>\n` +
    `<parameter=section>\nmarket_context\n</parameter>\n<parameter=content>\nrecon\n</parameter>\n</function>\n</tool_call>`;
  const model = new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(model).mockImplementation(bridge));
  const messages = [{ role: "system", content: `role <TRADING_TOOL_CONTEXT_V1>${t}</TRADING_TOOL_CONTEXT_V1>` }, { role: "user", content: "go" }];
  for await (const c of createVllmProvider("http://vllm.test").generateTextStream!(messages as never, "m", { tools: [] })) {
    if (typeof c === "object" && "type" in c && c.type === "toolCall" && "name" in c && "args" in c) {
      return { name: String(c.name), args: c.args as Record<string, unknown> };
    }
  }
  throw new Error("no markup tool call recovered");
}

beforeEach(() => { vi.stubEnv("TRADING_TOOL_CONTEXT_KEY", "offline-perm-key"); bridge.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("(a) an allowlisted call recovered from markup executes instead of PERMISSION_DENIED", async () => {
  const call = await markupCall("whiteboard_write", token());
  expect(await dispatchTool(call.name, call.args, caller)).toEqual({ ok: true });
  expect(JSON.parse(bridge.mock.calls[0][1].body)).toMatchObject({ cycle_id: "cycle-v3-1793702165", agent_name: "v3_junior_analyst", ticker: "MSFT" });
});

it("(b) an invalid-argument call fails on its arguments and consumes nothing; the next valid call succeeds", async () => {
  const t = token();
  vi.stubGlobal("fetch", bridge);
  const bad = bindRecoveredToolArgs("whiteboard_write", { ticker: "MSFT", section: "market_context", content: { text: 123 } }, t);
  const rejected = await dispatchTool("whiteboard_write", bad, caller);
  expect(rejected).toEqual({ error: '"content" must be string' });
  const good = bindRecoveredToolArgs("whiteboard_write", { ticker: "MSFT", section: "market_context", content: "recon" }, t);
  expect(await dispatchTool("whiteboard_write", good, caller)).toEqual({ ok: true });
});

it("(c) a tool outside the signed allowlist is still PERMISSION_DENIED", async () => {
  const call = await markupCall("buy_stock", token());
  expect(await dispatchTool(call.name, call.args, caller)).toMatchObject({ error: "PERMISSION_DENIED" });
  expect(bridge).not.toHaveBeenCalled();
});

function shimResponse() {
  return Object.assign(new EventEmitter(), {
    statusCode: 200, output: "", headersSent: false,
    status(code: number) { this.statusCode = code; return this; },
    setHeader() { return this; },
    end(value?: string) { if (value) this.output += value; return this; },
    json(value: unknown) { this.output = JSON.stringify(value); return this; },
  });
}
const dsml = '<｜tool calls｜><｜tool_call｜>{"name": "whiteboard_write", "arguments": {"ticker": "MSFT", "content": "x"}}<｜end of tool call｜>';
async function shimJson(toolChoice: string) {
  const upstream = { choices: [{ index: 0, message: { role: "assistant", content: dsml }, finish_reason: "stop" }] };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(upstream), { headers: { "content-type": "application/json" } })));
  const res = shimResponse();
  const body = { model: "m", stream: false, tool_choice: toolChoice, messages: [{ role: "user", content: "final answer" }] };
  await VllmShimService.handle({ originalUrl: "/vllm-shim/gold-spark/v1/chat/completions", method: "POST", headers: {}, body } as never, res as never);
  return JSON.parse(res.output).choices[0].message;
}

it("a tool_choice none turn returns its markup as text, never as a callable tool call", async () => {
  const off = await shimJson("none");
  expect(off.tool_calls).toBeUndefined();
  expect(off.content).toBe(dsml);
  expect((await shimJson("auto")).tool_calls[0].function.name).toBe("whiteboard_write");
});
