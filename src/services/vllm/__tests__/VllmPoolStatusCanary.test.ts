import { EventEmitter } from "node:events";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.VLLM_SHIM_POOL_MEMBERS = "dell2,dell1";
});

import { VllmShimService, type PoolAndUpstreamStatusResponse } from "../VllmShimService.js";
import { markPoolMemberDown, resetPoolState } from "../VllmPool.js";

const GOLD_SPARK = "http://10.0.0.141:8000";
const JETSON = "http://10.0.0.30:8000";
const JETSON_2 = "http://10.0.0.30:8001";
const D131 = "http://10.0.0.131:8888"; // dell1
const D37 = "http://10.0.0.37:8888"; // dell2

interface UpstreamMockSpec {
  up?: boolean;
  models?: string[];
  running?: number;
  waiting?: number;
  modelsStatus?: number;
}

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

async function getJson(path: string): Promise<{ statusCode: number; body: PoolAndUpstreamStatusResponse }> {
  const req = {
    originalUrl: path,
    method: "GET",
    headers: {},
    body: undefined,
  };
  const res = shimResponse();
  await VllmShimService.handle(req as unknown as ExpressRequest, res as unknown as ExpressResponse);
  return {
    statusCode: res.statusCode,
    body: JSON.parse(res.output) as PoolAndUpstreamStatusResponse,
  };
}

function stubUpstreamFetch(specs: Record<string, UpstreamMockSpec>) {
  const bases = [GOLD_SPARK, JETSON, JETSON_2, D131, D37];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const base = bases.find((b) => url.startsWith(b));
    if (!base) throw new TypeError(`unexpected upstream url ${url}`);
    const spec = specs[base] ?? { up: false };
    const path = url.slice(base.length);

    if (path.startsWith("/v1/models")) {
      if (spec.up === false) throw new TypeError("ECONNREFUSED");
      if (spec.modelsStatus && spec.modelsStatus >= 400) {
        return new Response("bad gateway", { status: spec.modelsStatus });
      }
      const models = spec.models ?? ["dynamic-test-model"];
      return new Response(
        JSON.stringify({ object: "list", data: models.map((id) => ({ id })) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (path.startsWith("/metrics")) {
      if (spec.up === false) throw new TypeError("ECONNREFUSED");
      return new Response(
        `tensorfold:num_requests_running ${spec.running ?? 0}\n` +
          `tensorfold:num_requests_waiting ${spec.waiting ?? 0}\n`,
        { status: 200, headers: { "content-type": "text/plain" } },
      );
    }

    throw new TypeError(`unexpected path ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("/vllm-shim/pool-status and /vllm-shim/canary", () => {
  const prevEnableJetson2 = process.env.ENABLE_JETSON_2;

  beforeEach(() => {
    resetPoolState();
    delete process.env.ENABLE_JETSON_2;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (prevEnableJetson2 === undefined) {
      delete process.env.ENABLE_JETSON_2;
    } else {
      process.env.ENABLE_JETSON_2 = prevEnableJetson2;
    }
  });

  it("returns 200 pool-status with dynamic /v1/models discovery, gauges, and omits jetson-2 + gold-spark-vision", async () => {
    stubUpstreamFetch({
      [GOLD_SPARK]: { models: ["Qwen3.6-122B-A10B-NVFP4", "gliner"] },
      [JETSON]: { models: ["nemotron-35b"] },
      [D131]: { models: ["DeepSeek-V4.1-Flash-1017"], running: 1, waiting: 0 },
      [D37]: { models: ["DeepSeek-V4.1-Flash-1017"], running: 2, waiting: 3 },
      [JETSON_2]: { models: ["embeddinggemma"] },
    });

    const { statusCode, body } = await getJson("/vllm-shim/pool-status");
    expect(statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
    expect(body.healthy_generation_boxes).toBe(4);

    const names = body.upstreams.map((u) => u.name);
    expect(names).toEqual(["gold-spark", "jetson", "dell1", "dell2"]);
    expect(names).not.toContain("jetson-2");
    expect(names).not.toContain("gold-spark-vision");

    const goldSpark = body.upstreams.find((u) => u.name === "gold-spark");
    expect(goldSpark).toMatchObject({
      ip: "10.0.0.141",
      up: true,
      served_models: ["Qwen3.6-122B-A10B-NVFP4"],
      cooldown_remaining_ms: 0,
    });

    const dell2 = body.upstreams.find((u) => u.name === "dell2");
    expect(dell2).toMatchObject({
      ip: "10.0.0.37",
      up: true,
      served_models: ["DeepSeek-V4.1-Flash-1017"],
      running: 2,
      waiting: 3,
      cooldown_remaining_ms: 0,
    });
  });

  it("includes jetson-2 when ENABLE_JETSON_2=1 without counting embedding-only box as healthy generation", async () => {
    process.env.ENABLE_JETSON_2 = "1";
    stubUpstreamFetch({
      [GOLD_SPARK]: { up: false },
      [JETSON]: { up: false },
      [D131]: { up: false },
      [D37]: { up: false },
      [JETSON_2]: { up: true, models: ["embeddinggemma"] },
    });

    const statusRes = await getJson("/vllm-shim/pool-status");
    expect(statusRes.statusCode).toBe(200);
    const j2 = statusRes.body.upstreams.find((u) => u.name === "jetson-2");
    expect(j2).toBeDefined();
    expect(j2?.up).toBe(true);
    expect(statusRes.body.healthy_generation_boxes).toBe(0);
    expect(statusRes.body.ok).toBe(false);

    const canaryRes = await getJson("/vllm-shim/canary");
    expect(canaryRes.statusCode).toBe(503);
    expect(canaryRes.body.ok).toBe(false);
  });

  it("reports cooldown_remaining_ms > 0 and skips /v1/models round-trip when a pool member is marked down", async () => {
    const fetchMock = stubUpstreamFetch({
      [GOLD_SPARK]: { models: ["Qwen3.6-122B-A10B-NVFP4"] },
      [JETSON]: { up: false },
      [D131]: { models: ["DeepSeek-V4.1-Flash-1017"] },
      [D37]: { models: ["DeepSeek-V4.1-Flash-1017"] },
    });

    markPoolMemberDown("dell1");
    const { statusCode, body } = await getJson("/vllm-shim/pool-status");
    expect(statusCode).toBe(200);

    const dell1 = body.upstreams.find((u) => u.name === "dell1");
    expect(dell1?.up).toBe(false);
    expect(dell1?.cooldown_remaining_ms).toBeGreaterThan(0);

    const dell1ModelProbes = fetchMock.mock.calls.filter((call) =>
      String(call[0]).startsWith(`${D131}/v1/models`),
    );
    expect(dell1ModelProbes).toHaveLength(0);

    const canaryRes = await getJson("/vllm-shim/canary");
    expect(canaryRes.statusCode).toBe(200);
    expect(canaryRes.body.ok).toBe(true);
    expect(canaryRes.body.healthy_generation_boxes).toBe(2);
  });

  it("returns 503 on /vllm-shim/canary when 0 healthy generation boxes are up and 200 when >= 1 recovers", async () => {
    stubUpstreamFetch({
      [GOLD_SPARK]: { up: false },
      [JETSON]: { up: false },
      [D131]: { up: false },
      [D37]: { up: false },
    });

    const downCanary = await getJson("/vllm-shim/canary");
    expect(downCanary.statusCode).toBe(503);
    expect(downCanary.body.ok).toBe(false);
    expect(downCanary.body.healthy_generation_boxes).toBe(0);

    stubUpstreamFetch({
      [GOLD_SPARK]: { up: false },
      [JETSON]: { up: false },
      [D131]: { up: false },
      [D37]: { up: true, models: ["DeepSeek-V4.1-Flash-1017"] },
    });

    const upCanary = await getJson("/vllm-shim/canary");
    expect(upCanary.statusCode).toBe(200);
    expect(upCanary.body.ok).toBe(true);
    expect(upCanary.body.healthy_generation_boxes).toBe(1);
  });

  it("expires shim-level unreachable cooldown after timer advances", async () => {
    vi.useFakeTimers();
    stubUpstreamFetch({
      [GOLD_SPARK]: { modelsStatus: 502 },
      [JETSON]: { up: false },
      [D131]: { up: false },
      [D37]: { up: false },
    });

    // Trigger shim unreachable cooldown via legacy route
    const probeReq = {
      originalUrl: "/vllm-shim/gold-spark/v1/models",
      method: "GET",
      headers: {},
      body: undefined,
    };
    const probeRes = shimResponse();
    await VllmShimService.handle(
      probeReq as unknown as ExpressRequest,
      probeRes as unknown as ExpressResponse,
    );
    expect(probeRes.statusCode).toBe(502);

    const cooled = await getJson("/vllm-shim/pool-status");
    const gsCooled = cooled.body.upstreams.find((u) => u.name === "gold-spark");
    expect(gsCooled?.up).toBe(false);
    expect(gsCooled?.cooldown_remaining_ms).toBeGreaterThan(0);

    vi.advanceTimersByTime(60_000);
    stubUpstreamFetch({
      [GOLD_SPARK]: { up: true, models: ["Qwen3.6-122B-A10B-NVFP4"] },
      [JETSON]: { up: false },
      [D131]: { up: false },
      [D37]: { up: false },
    });

    const recovered = await getJson("/vllm-shim/canary");
    expect(recovered.statusCode).toBe(200);
    expect(recovered.body.healthy_generation_boxes).toBe(1);
  });
});
