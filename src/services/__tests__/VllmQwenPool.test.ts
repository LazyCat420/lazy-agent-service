/**
 * The shared Qwen pool route `/vllm-shim/qwen`.
 *
 * Context (2026-11-19, user decision "option A"): both Dell boxes serve
 * Qwen3.8-Flash-Next, but today they are two independent shim routes, so a
 * backlog on one box never spills to the other. These tests pin the four
 * behaviours that make the pool useful: least-loaded pick (including a burst
 * that must spread before the engine gauges catch up), session affinity with
 * its 2-deep release threshold, member dropout on down/different model, and
 * one failover retry before any byte is streamed.
 */
import { EventEmitter } from "node:events";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VllmShimService } from "../vllm/VllmShimService.js";
import {
  clearPoolCaches,
  parsePoolGauges,
  pickPoolModel,
  poolSessionKey,
  qwenPoolStats,
  resetQwenPoolState,
} from "../vllm/VllmQwenPool.js";

const D37 = "http://10.0.0.37:8888"; // physical dellbox1
const D131 = "http://10.0.0.131:8888"; // physical dellbox2
const MODEL = "Qwen3.8-Flash-Next";

interface BoxSim {
  up?: boolean;
  model?: string;
  running?: number;
  waiting?: number;
  chatFails?: boolean;
  sse?: boolean;
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const sseResponse = (): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"delta":"hi"}\n\n'));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

/** Stub global fetch with a per-box simulator and return the spy. */
function installFetch(sims: Record<string, BoxSim>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const base = url.startsWith(D37) ? D37 : url.startsWith(D131) ? D131 : null;
    if (!base) throw new TypeError(`unexpected url ${url}`);
    const sim = sims[base] ?? {};
    const path = url.slice(base.length);
    if (path.startsWith("/v1/models")) {
      if (sim.up === false) throw new TypeError("fetch failed");
      return jsonResponse({ object: "list", data: [{ id: sim.model ?? MODEL }] });
    }
    if (path.startsWith("/metrics")) {
      if (sim.up === false) throw new TypeError("fetch failed");
      return new Response(
        `tensorfold:num_requests_running ${sim.running ?? 0}\n` +
          `tensorfold:num_requests_waiting ${sim.waiting ?? 0}\n`,
        { status: 200, headers: { "content-type": "text/plain" } },
      );
    }
    if (path.startsWith("/v1/chat/completions")) {
      if (sim.chatFails) throw new TypeError("connect ECONNREFUSED");
      if (sim.sse) return sseResponse();
      return jsonResponse({
        id: "c1",
        choices: [{ index: 0, message: { role: "assistant", content: `served by ${base}` } }],
      });
    }
    throw new TypeError(`unexpected path ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Minimal Express response double carrying only the members handle() touches. */
function shimResponse() {
  return Object.assign(new EventEmitter(), {
    statusCode: 200,
    headersSent: false,
    output: "",
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
    flushHeaders() {
      this.headersSent = true;
    },
    write(value: unknown) {
      this.output += typeof value === "string" ? value : Buffer.from(value as Uint8Array).toString();
    },
    end(value?: unknown) {
      if (value) this.write(value);
      return this;
    },
    json(value: unknown) {
      this.output = JSON.stringify(value);
      return this;
    },
  });
}

/** The request shape these tests send through the shim. */
interface PoolChatRequest {
  originalUrl: string;
  method: string;
  headers: Record<string, string>;
  body: { model: string; messages: { role: string; content: string }[]; user?: string };
}

const chatRequest = (user?: string, headers: Record<string, string> = {}): PoolChatRequest => ({
  originalUrl: "/vllm-shim/qwen/v1/chat/completions",
  method: "POST",
  headers,
  body: {
    model: MODEL,
    messages: [{ role: "user", content: "hi" }],
    ...(user ? { user } : {}),
  },
});

async function send(request: PoolChatRequest) {
  const res = shimResponse();
  await VllmShimService.handle(
    request as unknown as ExpressRequest,
    res as unknown as ExpressResponse,
  );
  return res;
}

beforeEach(() => resetQwenPoolState());
afterEach(() => vi.unstubAllGlobals());

describe("parsePoolGauges", () => {
  it("reads the TensorFold gauge family the Dells expose", () => {
    const text = [
      "# HELP tensorfold:num_requests_running Requests in prefill or decode.",
      "# TYPE tensorfold:num_requests_running gauge",
      "tensorfold:num_requests_running 2",
      "tensorfold:num_requests_waiting 3",
    ].join("\n");
    expect(parsePoolGauges(text)).toEqual({ running: 2, waiting: 3 });
  });

  it("sums label sets of the first matching family", () => {
    const text = [
      'vllm:num_requests_running{model="a"} 1',
      'vllm:num_requests_running{model="b"} 2',
      "vllm:num_requests_waiting 0",
    ].join("\n");
    expect(parsePoolGauges(text)).toEqual({ running: 3, waiting: 0 });
  });

  it("reports zero when the gauges are absent", () => {
    expect(parsePoolGauges("# nothing here")).toEqual({ running: 0, waiting: 0 });
  });
});

describe("pickPoolModel", () => {
  it("skips embedders and extraction-only models", () => {
    expect(
      pickPoolModel({ data: [{ id: "gliner" }, { id: "text-embedding-x" }, { id: MODEL }] }),
    ).toBe(MODEL);
  });

  it("accepts the models[] spelling and returns null for an empty list", () => {
    expect(pickPoolModel({ models: [{ name: MODEL }] })).toBe(MODEL);
    expect(pickPoolModel({ data: [] })).toBeNull();
  });
});

describe("poolSessionKey", () => {
  it("prefers the OpenAI user field", () => {
    expect(poolSessionKey({ body: { user: "u1" }, headers: { "x-session-id": "h1" } })).toBe("u:u1");
  });

  it("falls back to x-session-id, then to a hash of the message prefix", () => {
    expect(poolSessionKey({ body: {}, headers: { "x-session-id": "h1" } })).toBe("h:h1");
    const body = { messages: [{ role: "system", content: "s" }, { role: "user", content: "q" }] };
    const key = poolSessionKey({ body });
    expect(key?.startsWith("m:")).toBe(true);
    expect(poolSessionKey({ body })).toBe(key);
  });

  it("returns null when nothing identifies the session", () => {
    expect(poolSessionKey({ body: { messages: [{ role: "assistant", content: "x" }] } })).toBeNull();
  });
});

describe("/vllm-shim/qwen routing", () => {
  it("picks the member with the lowest running+waiting", async () => {
    installFetch({ [D37]: { running: 4 }, [D131]: { running: 0 } });
    const res = await send(chatRequest());
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-pool-box"]).toBe("10.0.0.131");
    expect(res.output).toContain(`served by ${D131}`);
  });

  it("spreads a concurrent burst across both boxes before the gauges move", async () => {
    // Both gauges read 0 for the whole burst; only the shim's own in-flight
    // count (plus the tie-break rotation) can keep them from piling up.
    installFetch({ [D37]: {}, [D131]: {} });
    const [a, b] = await Promise.all([send(chatRequest("burst-a")), send(chatRequest("burst-b"))]);
    expect([a.headers["x-pool-box"], b.headers["x-pool-box"]].sort()).toEqual([
      "10.0.0.131",
      "10.0.0.37",
    ]);
  });

  it("keeps a session on its previous box until that box is 2 deeper", async () => {
    installFetch({ [D37]: {}, [D131]: {} });
    expect((await send(chatRequest("sess"))).headers["x-pool-box"]).toBe("10.0.0.37");

    clearPoolCaches();
    installFetch({ [D37]: { running: 1 }, [D131]: {} });
    expect((await send(chatRequest("sess"))).headers["x-pool-box"]).toBe("10.0.0.37");

    clearPoolCaches();
    installFetch({ [D37]: { running: 2 }, [D131]: {} });
    expect((await send(chatRequest("sess"))).headers["x-pool-box"]).toBe("10.0.0.131");
  });

  it("drops a member that is down", async () => {
    installFetch({ [D37]: {}, [D131]: { up: false } });
    const res = await send(chatRequest());
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-pool-box"]).toBe("10.0.0.37");
  });

  it("drops a member serving a different model id", async () => {
    installFetch({ [D37]: { model: MODEL }, [D131]: { model: "GLM-5.3-Flash-EXL3" } });
    const res = await send(chatRequest());
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-pool-box"]).toBe("10.0.0.37");
  });

  it("answers 503 when no member is up", async () => {
    installFetch({ [D37]: { up: false }, [D131]: { up: false } });
    const res = await send(chatRequest());
    expect(res.statusCode).toBe(503);
    expect(res.output).toContain("no pool member is up");
  });

  it("fails over once to the other member on a connection error", async () => {
    const fetchMock = installFetch({ [D37]: { chatFails: true }, [D131]: {} });
    const res = await send(chatRequest());
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-pool-box"]).toBe("10.0.0.131");
    const chatCalls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.endsWith("/v1/chat/completions"));
    expect(chatCalls).toEqual([`${D37}/v1/chat/completions`, `${D131}/v1/chat/completions`]);
  });

  it("passes an SSE stream through and still stamps x-pool-box", async () => {
    installFetch({ [D37]: { sse: true }, [D131]: { sse: true } });
    const res = await send(chatRequest());
    expect(res.headers["x-pool-box"]).toBe("10.0.0.37");
    expect(res.output).toContain('data: {"delta":"hi"}');
    expect(res.output).toContain("data: [DONE]");
  });

  it("attributes served responses per box in the pool stats", async () => {
    installFetch({ [D37]: {}, [D131]: {} });
    await send(chatRequest("stats-a"));
    await send(chatRequest("stats-b"));
    const stats = qwenPoolStats() as {
      members: { name: string; ip: string; served: number }[];
    };
    const total = stats.members.reduce((sum, m) => sum + m.served, 0);
    expect(total).toBe(2);
    expect(stats.members.map((m) => m.ip).sort()).toEqual(["10.0.0.131", "10.0.0.37"]);
  });
});

describe("/vllm-shim/qwen is not one of the legacy routes", () => {
  it("leaves /dell1 and /dell2 resolving to their single upstreams", () => {
    expect(VllmShimService.resolveUpstream("/vllm-shim/dell1/v1/chat/completions")?.upstreamUrl).toBe(D131);
    expect(VllmShimService.resolveUpstream("/vllm-shim/dell2/v1/chat/completions")?.upstreamUrl).toBe(D37);
  });
});
