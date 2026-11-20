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
  poolMemberDown,
  poolSessionKey,
  qwenPoolAffinityKeys,
  qwenPoolStats,
  QWEN_POOL_MEMBERS,
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
  chatHangs?: boolean;
  modelsHangs?: boolean;
  chatDiesMidBody?: boolean;
  modelsDiesMidBody?: boolean;
  sse?: boolean;
  sseHangs?: boolean;
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

/** One SSE chunk, then silence forever (QP-6 idle abort). */
const sseHangResponse = (): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"delta":"hi"}\n\n'));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

/** Upstream accepted the request, then its body dies (QP-1 delivery failure). */
const dyingBodyResponse = (): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new TypeError("terminated"));
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/** Stub global fetch with a per-box simulator and return the spy. */
function installFetch(sims: Record<string, BoxSim>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const base = url.startsWith(D37) ? D37 : url.startsWith(D131) ? D131 : null;
    if (!base) throw new TypeError(`unexpected url ${url}`);
    const sim = sims[base] ?? {};
    const path = url.slice(base.length);
    if (path.startsWith("/v1/models")) {
      if (sim.modelsHangs) {
        const { promise, reject } = Promise.withResolvers<Response>();
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
        return promise;
      }
      if (sim.up === false) throw new TypeError("fetch failed");
      if (sim.modelsDiesMidBody) return dyingBodyResponse();
      return jsonResponse({ object: "list", data: [{ id: sim.model ?? MODEL }] });
    }
    if (path.startsWith("/metrics")) {
      if (sim.modelsHangs) {
        const { promise, reject } = Promise.withResolvers<Response>();
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
        return promise;
      }
      if (sim.up === false) throw new TypeError("fetch failed");
      return new Response(
        `tensorfold:num_requests_running ${sim.running ?? 0}\n` +
          `tensorfold:num_requests_waiting ${sim.waiting ?? 0}\n`,
        { status: 200, headers: { "content-type": "text/plain" } },
      );
    }
    if (path.startsWith("/v1/chat/completions")) {
      if (sim.chatFails) throw new TypeError("connect ECONNREFUSED");
      if (sim.chatHangs) {
        const { promise, reject } = Promise.withResolvers<Response>();
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
        return promise;
      }
      if (sim.chatDiesMidBody) return dyingBodyResponse();
      if (sim.sse) return sseResponse();
      if (sim.sseHangs) return sseHangResponse();
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
  body?: { model?: string; messages?: { role: string; content: string }[]; user?: string };
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

  it("keeps serving through a simultaneous single probe blip instead of 503 (QP-4)", async () => {
    // A single `/v1/models` probe timeout (~1.2 s default) is not evidence a box is dead: both
    // engines can be serving while both probes blip, so neither leaves
    // rotation on the first strike and the request is attempted.
    installFetch({ [D37]: { up: false }, [D131]: { up: false } });
    const res = await send(chatRequest());
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-pool-box"]).toBe("10.0.0.37");
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
    const stats = qwenPoolStats();
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

  it("a legacy /dell1 models body-read failure still parks the upstream (QP-R1)", async () => {
    // Pre-pool, ANY failure of a /v1/models call — including a body read that
    // dies after the 200 headers — marked the box unreachable. The pool
    // refactor must not drop that for the legacy routes.
    const fetchMock = installFetch({ [D131]: { modelsDiesMidBody: true }, [D37]: {} });
    const request = {
      originalUrl: "/vllm-shim/dell1/v1/models",
      method: "GET",
      headers: {},
      body: undefined,
    };
    const res = shimResponse();
    await VllmShimService.handle(
      request as unknown as ExpressRequest,
      res as unknown as ExpressResponse,
    );
    expect(res.statusCode).toBe(502);
    expect(VllmShimService.upstreamUnreachable("dell1")).toBe(true);

    // The next probe is answered locally: no new upstream round trip.
    const callsBefore = fetchMock.mock.calls.length;
    const res2 = shimResponse();
    await VllmShimService.handle(
      request as unknown as ExpressRequest,
      res2 as unknown as ExpressResponse,
    );
    expect(res2.statusCode).toBe(503);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });
});

describe("review fixes (QP-1..QP-6)", () => {
  const servedTotal = () => qwenPoolStats().members.reduce((sum, m) => sum + m.served, 0);

  it("QP-1: never fails over once the upstream accepted the request (mid-body death)", async () => {
    // The engine received and started the POST; replaying it on the other box
    // would run the same non-idempotent generation twice.
    const fetchMock = installFetch({ [D37]: { chatDiesMidBody: true }, [D131]: {} });
    const res = await send(chatRequest());
    expect(res.statusCode).toBe(502);
    const calls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.endsWith("/v1/chat/completions"));
    expect(calls).toEqual([`${D37}/v1/chat/completions`]);
    expect(servedTotal()).toBe(0);
  });

  it("QP-1: never fails over after the shim's own headers timeout", async () => {
    // The abort means box A is still generating; a replay would burn one of
    // its max_batch_size-5 slots plus a full run on box B.
    process.env.VLLM_SHIM_UPSTREAM_HEADERS_TIMEOUT_MS = "40";
    try {
      const fetchMock = installFetch({ [D37]: { chatHangs: true }, [D131]: {} });
      const res = await send(chatRequest());
      expect(res.statusCode).toBe(502);
      const calls = fetchMock.mock.calls
        .map((call) => String(call[0]))
        .filter((url) => url.endsWith("/v1/chat/completions"));
      expect(calls).toEqual([`${D37}/v1/chat/completions`]);
    } finally {
      delete process.env.VLLM_SHIM_UPSTREAM_HEADERS_TIMEOUT_MS;
    }
  });

  it("QP-2: counts a request as served once, only after delivery", async () => {
    installFetch({ [D37]: {}, [D131]: {} });
    await send(chatRequest("qp2"));
    const stats = qwenPoolStats();
    expect(stats.members.reduce((sum, m) => sum + m.served, 0)).toBe(1);
    expect(stats.members.filter((m) => m.served === 1)).toHaveLength(1);
  });

  it("QP-2: a stalled stream that is idle-aborted is not counted as served", async () => {
    process.env.VLLM_SHIM_POOL_STREAM_IDLE_TIMEOUT_MS = "40";
    try {
      installFetch({ [D37]: { sseHangs: true }, [D131]: { sseHangs: true } });
      const res = await send(chatRequest("qp2-idle"));
      expect(res.headers["x-pool-box"]).toBe("10.0.0.37");
      expect(servedTotal()).toBe(0);
    } finally {
      delete process.env.VLLM_SHIM_POOL_STREAM_IDLE_TIMEOUT_MS;
    }
  });

  it("QP-3: refreshing a session makes it most-recently-used (true LRU)", async () => {
    process.env.VLLM_SHIM_POOL_AFFINITY_MAX_ENTRIES = "2";
    try {
      installFetch({ [D37]: {}, [D131]: {} });
      await send(chatRequest("A"));
      await send(chatRequest("B"));
      expect(qwenPoolAffinityKeys()).toEqual(["u:A", "u:B"]);

      // Re-using A must move it to the tail, not leave it at the head.
      clearPoolCaches();
      installFetch({ [D37]: { running: 1 }, [D131]: {} });
      await send(chatRequest("A"));
      expect(qwenPoolAffinityKeys()).toEqual(["u:B", "u:A"]);

      // Inserting C at the cap evicts B (oldest), never the hot A.
      clearPoolCaches();
      installFetch({ [D37]: {}, [D131]: {} });
      await send(chatRequest("C"));
      expect(qwenPoolAffinityKeys()).toEqual(["u:A", "u:C"]);
    } finally {
      delete process.env.VLLM_SHIM_POOL_AFFINITY_MAX_ENTRIES;
    }
  });

  it("QP-4: one probe failure does not evict a member; two consecutive ones do", async () => {
    const dellbox1 = QWEN_POOL_MEMBERS[0]; // dell2 / 10.0.0.37
    installFetch({ [D37]: { up: false }, [D131]: {} });
    await send(chatRequest("qp4-a"));
    expect(poolMemberDown(dellbox1)).toBe(false);

    clearPoolCaches();
    installFetch({ [D37]: { up: false }, [D131]: {} });
    await send(chatRequest("qp4-b"));
    expect(poolMemberDown(dellbox1)).toBe(true);
  });

  it("QP-4: tries the least recently failed member instead of answering 503", async () => {
    // Round 1: both probes blip once (one strike each) — both still eligible.
    installFetch({ [D37]: { up: false }, [D131]: { up: false } });
    expect((await send(chatRequest("qp4-c"))).statusCode).toBe(200);

    // Round 2: both reach two strikes and leave rotation; the request must
    // still be attempted against the least recently failed box.
    clearPoolCaches();
    installFetch({ [D37]: { up: false }, [D131]: { up: false } });
    const res = await send(chatRequest("qp4-d"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-pool-box"]).toBe("10.0.0.37");
  });

  it("QP-6: aborts a stalled pool stream after the idle timeout", async () => {
    process.env.VLLM_SHIM_POOL_STREAM_IDLE_TIMEOUT_MS = "40";
    try {
      installFetch({ [D37]: { sseHangs: true }, [D131]: { sseHangs: true } });
      // Resolves only because the idle timer cancels the reader; without it
      // the await on reader.read() would hang past the test timeout.
      const res = await send(chatRequest("qp6"));
      expect(res.headers["x-pool-box"]).toBe("10.0.0.37");
      expect(res.output).toContain('data: {"delta":"hi"}');
    } finally {
      delete process.env.VLLM_SHIM_POOL_STREAM_IDLE_TIMEOUT_MS;
    }
  });

  it("QP-7: single-strike first member or hanging probe routes pooled /v1/models to live member", async () => {
    installFetch({ [D37]: { up: false }, [D131]: {} });
    const strikeRes = await send({
      originalUrl: "/vllm-shim/qwen/v1/models",
      method: "GET",
      headers: {},
    });
    expect(strikeRes.statusCode).toBe(200);
    expect(strikeRes.headers["x-pool-box"]).toBe("10.0.0.131");

    resetQwenPoolState();
    process.env.VLLM_SHIM_POOL_PROBE_TIMEOUT_MS = "30";
    process.env.VLLM_SHIM_POOL_GAUGE_TIMEOUT_MS = "30";
    try {
      installFetch({ [D37]: { modelsHangs: true }, [D131]: {} });
      const startedAt = Date.now();
      const hangRes = await send({
        originalUrl: "/vllm-shim/qwen/v1/models",
        method: "GET",
        headers: {},
      });
      expect(hangRes.statusCode).toBe(200);
      expect(hangRes.headers["x-pool-box"]).toBe("10.0.0.131");
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      delete process.env.VLLM_SHIM_POOL_PROBE_TIMEOUT_MS;
      delete process.env.VLLM_SHIM_POOL_GAUGE_TIMEOUT_MS;
    }
  });

  it("QP-8: failed /metrics scrape preserves prior gauge reading instead of resetting to idle 0", async () => {
    installFetch({ [D37]: { running: 4, waiting: 2 }, [D131]: { running: 1, waiting: 0 } });
    const first = await send(chatRequest());
    expect(first.headers["x-pool-box"]).toBe("10.0.0.131");

    // Force gauge cache expiry (via clearPoolCaches? No: test failed scrape after TTL via fake timers or direct unit check):
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(1500);
      installFetch({ [D37]: { up: false, chatFails: false }, [D131]: { running: 1, waiting: 0 } });
      // Wait — probeHealth up:false keeps up:true on 1 strike, while /metrics fails!
      const second = await send(chatRequest());
      expect(second.headers["x-pool-box"]).toBe("10.0.0.131");
      const stats = qwenPoolStats();
      const d37Stats = stats.members.find((m) => m.name === "dell2");
      expect(d37Stats?.running).toBe(4);
      expect(d37Stats?.waiting).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
