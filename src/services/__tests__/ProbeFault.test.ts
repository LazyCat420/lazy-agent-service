import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cutStreamBody, probeFault, probeToolStallMs } from "../ProbeFault.ts";
import { prepareToolContext, TOOL_CONTEXT_ARG, signToolContext } from "../TradingToolContext.ts";
import { prepareTradingRequest } from "../learning/TradingLearningBoundary.ts";
import { VllmShimService } from "../vllm/VllmShimService.ts";
import { dispatchTool } from "../ToolDispatch.ts";

beforeEach(() => vi.stubEnv("TRADING_TOOL_CONTEXT_KEY", "offline-probe-key"));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

function response() {
  return Object.assign(new EventEmitter(), {
    statusCode: 200, output: "", headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
    flushHeaders() {},
    write(value: any) { this.output += typeof value === "string" ? value : Buffer.from(value).toString(); },
    end(value?: any) { if (value) this.write(value); return this; },
    json(value: any) { this.output = JSON.stringify(value); return this; },
  });
}

it("fires only for a probe-boundary cycle naming the fault, and can be switched off", () => {
  expect(probeFault("probe-boundary-1790662244-fault-cut")).toBe("cut");
  expect(probeFault("probe-boundary-1790662244-fault-toolstall")).toBe("toolstall");
  for (const id of ["cycle-v3-1790662244", "probe-boundary-1790662244", "probe-boundary-1790662244-fault-cut-x",
                    "xprobe-boundary-1-fault-cut", "", undefined, 42]) expect(probeFault(id)).toBeNull();
  vi.stubEnv("PROBE_FAULTS_ENABLED", "0");
  expect(probeFault("probe-boundary-1790662244-fault-cut")).toBeNull();
});

it("the cut stream has a delta and no finish_reason and no [DONE]", () => {
  const body = cutStreamBody("nemotron35");
  expect(body).toContain('"finish_reason":null');
  expect(body).not.toContain("[DONE]");
  expect(probeToolStallMs()).toBe(240000);
});

function shimRequest(cycleId: string) {
  const prepared = prepareToolContext(prepareTradingRequest({
    project: "vllm-trading-bot", provider: "vllm", agent: "CUSTOM_V3_JUNIOR_ANALYST", conversationId: "probe-conv",
    enabledTools: ["get_market_data"], systemPrompt: "probe",
    messages: [{ role: "user", content: `## Ticker: AAPL\n\n## Cycle: ${cycleId}\nReply OK.` }] }));
  return { originalUrl: "/vllm-shim/jetson/v1/chat/completions", method: "POST", headers: {},
           body: { model: "nemotron35", stream: true, messages: [{ role: "system", content: prepared.systemPrompt }, ...prepared.messages] } };
}

it("the shim cuts a probe cycle's stream without calling the model", async () => {
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  const res = response();
  await VllmShimService.handle(shimRequest("probe-boundary-1790662244-fault-cut") as any, res as any);
  expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/v1/chat/completions"), expect.anything());
  expect(res.statusCode).toBe(200);
  expect(res.headers["Content-Type"]).toBe("text/event-stream");
  expect(res.output).toContain('"content":"probe"');
  expect(res.output).not.toContain("[DONE]");
});

it("a production cycle's request goes to the model as before", async () => {
  const wire = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
  const fetchMock = vi.fn().mockResolvedValue(new Response(wire, { headers: { "content-type": "text/event-stream" } }));
  vi.stubGlobal("fetch", fetchMock);
  const res = response();
  await VllmShimService.handle(shimRequest("cycle-v3-1790662244") as any, res as any);
  expect(fetchMock.mock.calls.some((c: any[]) => String(c[0]).includes("/v1/chat/completions"))).toBe(true);
  expect(res.output).toContain("[DONE]");
});

function signedArgs(cycleId: string) {
  const token = signToolContext({ project: "vllm-trading-bot", agentName: "v3_junior_analyst", cycleId, ticker: "AAPL",
    conversationId: "c", allowedTools: ["get_market_data"], expiresAt: Date.now() + 60_000 });
  return { ticker: "AAPL", [TOOL_CONTEXT_ARG]: token };
}

it("a probe cycle's tool call hangs, then reports the stall; production calls do not", async () => {
  vi.useFakeTimers();
  vi.stubEnv("PROBE_TOOL_STALL_MS", "5000");
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
  vi.stubGlobal("fetch", fetchMock);
  let settled = false;
  const stalled = dispatchTool("get_market_data", signedArgs("probe-boundary-1790662244-fault-toolstall"), { transport: "mcp" })
    .then((v) => { settled = true; return v; });
  await vi.advanceTimersByTimeAsync(4_000);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1_500);
  expect(await stalled).toMatchObject({ error: "PROBE_TOOL_STALL", is_error: true });
  expect(fetchMock).not.toHaveBeenCalled();
  vi.useRealTimers();
  expect(await dispatchTool("get_market_data", signedArgs("cycle-v3-1790662244"), { transport: "mcp" })).toEqual({ ok: true });
});
