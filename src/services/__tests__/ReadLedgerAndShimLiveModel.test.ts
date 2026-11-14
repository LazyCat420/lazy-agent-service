/**
 * T2 — `read_ledger_entry` in LocalToolRouter READ_ONLY_TOOLS (bare + MCP-prefixed + 5xx retry).
 * S-10 — VllmShimService 404 model auto-heal stamps `X-Vllm-Shim-Live-Model` on JSON & SSE
 *        responses and rewrites omitted/mismatched `"model"` in non-stream JSON responses.
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  READ_ONLY_TOOLS,
  executeToolViaTradingService,
  isReadOnlyTool,
} from "../LocalToolRouter.ts";
import { VllmShimService } from "../vllm/VllmShimService.ts";

function createMockExpressResponse() {
  const headers: Record<string, string> = {};
  return Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers,
    output: "",
    headersSent: false,
    flushedHeadersSnapshot: null as Record<string, string> | null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = String(value);
      return this;
    },
    flushHeaders() {
      this.headersSent = true;
      this.flushedHeadersSnapshot = { ...headers };
    },
    write(chunk: unknown) {
      if (typeof chunk === "string") {
        this.output += chunk;
      } else if (chunk instanceof Uint8Array) {
        this.output += Buffer.from(chunk).toString("utf8");
      }
      return true;
    },
    end(value?: string | Buffer) {
      this.headersSent = true;
      if (typeof value === "string") {
        this.output += value;
      } else if (Buffer.isBuffer(value)) {
        this.output += value.toString("utf8");
      }
      return this;
    },
    json(value: unknown) {
      this.headersSent = true;
      this.output = JSON.stringify(value);
      return this;
    },
  });
}

afterEach(() => {
  VllmShimService.clearActiveModels();
  vi.unstubAllGlobals();
});

describe("LocalToolRouter T2: read_ledger_entry read-only classification", () => {
  it("marks read_ledger_entry as read-only under bare and MCP-prefixed names", () => {
    expect(READ_ONLY_TOOLS.has("read_ledger_entry")).toBe(true);
    expect(isReadOnlyTool("read_ledger_entry")).toBe(true);
    expect(isReadOnlyTool("mcp__lazy-agent-service__read_ledger_entry")).toBe(true);
  });

  it("retries read_ledger_entry once on transient 502 from trading-service", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ entry_id: "led-7", payload: { eps: 5.12 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const out = await executeToolViaTradingService(
      "read_ledger_entry",
      { entry_id: "led-7" },
      { cycleId: "cycle-v3-test", agentName: "Board", ticker: "NVDA" },
      async () => {},
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ entry_id: "led-7", payload: { eps: 5.12 } });
  });
});

describe("VllmShimService S-10: X-Vllm-Shim-Live-Model & JSON model rewrite on 404 auto-heal", () => {
  it("sets X-Vllm-Shim-Live-Model and rewrites mismatched/omitted model on non-stream JSON retry", async () => {
    const fetchMock = vi
      .fn()
      // 1. Initial POST /v1/chat/completions -> 404 stale model
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "The model `glm-stale` does not exist." } }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        ),
      )
      // 2. GET /v1/models discovery -> DeepSeek-V3.2-Live
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ id: "DeepSeek-V3.2-Live" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // 3. Retried POST /v1/chat/completions -> 200 JSON omitting `model`
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = createMockExpressResponse();
    await VllmShimService.handle(
      {
        originalUrl: "/vllm-shim/gold-spark/v1/chat/completions",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { model: "glm-stale", stream: false, messages: [{ role: "user", content: "ping" }] },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-vllm-shim-live-model"]).toBe("DeepSeek-V3.2-Live");
    const parsed = JSON.parse(res.output);
    expect(parsed.model).toBe("DeepSeek-V3.2-Live");
    expect(parsed.choices[0].message.content).toBe("ok");
  });

  it("sets X-Vllm-Shim-Live-Model before flushing SSE headers on streaming 404 auto-heal", async () => {
    const ssePayload =
      'data: {"id":"cmpl-sse","model":"Qwen3-Coder-Live","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n' +
      "data: [DONE]\n\n";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "The model `qwen-old` does not exist." } }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ id: "Qwen3-Coder-Live" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(ssePayload, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = createMockExpressResponse();
    await VllmShimService.handle(
      {
        originalUrl: "/vllm-shim/dell1/v1/chat/completions",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { model: "qwen-old", stream: true, messages: [{ role: "user", content: "ping" }] },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-vllm-shim-live-model"]).toBe("Qwen3-Coder-Live");
    expect(res.flushedHeadersSnapshot?.["x-vllm-shim-live-model"]).toBe("Qwen3-Coder-Live");
    expect(res.output).toContain("Qwen3-Coder-Live");
  });

  it("does not set X-Vllm-Shim-Live-Model when no 404 auto-heal occurred", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "chatcmpl-normal",
            model: "Qwen3-Coder-Live",
            choices: [{ index: 0, message: { role: "assistant", content: "steady" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const res = createMockExpressResponse();
    await VllmShimService.handle(
      {
        originalUrl: "/vllm-shim/dell1/v1/chat/completions",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { model: "Qwen3-Coder-Live", stream: false, messages: [{ role: "user", content: "ping" }] },
      } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-vllm-shim-live-model"]).toBeUndefined();
    expect(JSON.parse(res.output).model).toBe("Qwen3-Coder-Live");
  });
});
