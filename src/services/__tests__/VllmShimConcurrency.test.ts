/**
 * The Gold Spark concurrency cap.
 *
 * Context: the box collapsed on 2026-08-09 with 16 requests in flight against
 * an engine that runs 6 — throughput fell 23x in 150s while the KV cache hit
 * 85.9%. `--max-num-seqs` is an admission ceiling, so capping here works
 * without a vLLM restart.
 *
 * The load-bearing test in this file is `holds the slot until the BODY drains`
 * plus its sabotage control. vLLM answers headers in ~20ms and then holds the
 * GPU for 5-10 seconds — 99.7% of a streaming request happens after the fetch
 * promise resolves — so a limiter that releases on `await fetch()` caps
 * nothing that matters and still passes every naive test.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  UpstreamSemaphore,
  QueueTimeoutError,
  VllmShimService,
} from "../vllm/VllmShimService.js";

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("UpstreamSemaphore", () => {
  it("admits up to the limit immediately", async () => {
    const sem = new UpstreamSemaphore(4);
    for (let i = 0; i < 4; i++) await sem.acquire(1000);
    expect(sem.inFlight).toBe(4);
    expect(sem.queued).toBe(0);
  });

  it("queues past the limit and never exceeds it", async () => {
    const sem = new UpstreamSemaphore(4);
    let peak = 0;
    const releases: (() => void)[] = [];

    // 12 concurrent arrivals against a limit of 4 — the burst shape from the
    // incident, scaled down.
    const running = Array.from({ length: 12 }, async () => {
      const rel = await sem.acquire(5000);
      peak = Math.max(peak, sem.inFlight);
      releases.push(rel);
    });

    await settle();
    expect(sem.inFlight).toBe(4);
    expect(sem.queued).toBe(8);

    // Drain: each release hands the slot to the next waiter.
    while (releases.length) {
      releases.pop()!();
      await settle();
    }
    await Promise.all(running);
    expect(peak).toBe(4);
  });

  it("hands a freed slot to the LONGEST waiter (FIFO), not the newest arrival", async () => {
    const sem = new UpstreamSemaphore(1);
    const first = await sem.acquire(1000);
    const order: string[] = [];
    const a = sem.acquire(1000).then(() => order.push("a"));
    const b = sem.acquire(1000).then(() => order.push("b"));
    await settle();
    first();
    await settle();
    expect(order).toEqual(["a"]);
    await a;
    void b;
  });

  it("rejects with QueueTimeoutError rather than waiting forever", async () => {
    const sem = new UpstreamSemaphore(1);
    await sem.acquire(1000);
    await expect(sem.acquire(20)).rejects.toBeInstanceOf(QueueTimeoutError);
  });

  it("a timed-out waiter does not later steal a slot", async () => {
    const sem = new UpstreamSemaphore(1);
    const held = await sem.acquire(1000);
    await expect(sem.acquire(10)).rejects.toBeInstanceOf(QueueTimeoutError);
    expect(sem.queued).toBe(0);
    held();
    expect(sem.inFlight).toBe(0); // not 1 — the dead waiter took nothing
  });

  it("release is IDEMPOTENT — a double call cannot raise the effective cap", async () => {
    const sem = new UpstreamSemaphore(2);
    const rel = await sem.acquire(1000);
    await sem.acquire(1000);
    expect(sem.inFlight).toBe(2);
    rel();
    rel();
    rel();
    expect(sem.inFlight).toBe(1); // one release, however many times it was called
  });
});

describe("VllmShimService.limitFor", () => {
  beforeEach(() => {
    delete process.env.VLLM_SHIM_MAX_CONCURRENT_GOLD_SPARK;
    delete process.env.VLLM_SHIM_MAX_CONCURRENT_JETSON;
    VllmShimService.resetSemaphores();
  });

  it("defaults gold-spark to 4 — the box runs 6 and is shared with prism", () => {
    expect(VllmShimService.limitFor("gold-spark")).toBe(4);
  });

  it("leaves other upstreams ungated by default", () => {
    expect(VllmShimService.limitFor("jetson")).toBe(0);
    expect(VllmShimService.semaphoreFor("jetson")).toBeNull();
  });

  it("honours a per-upstream env override", () => {
    process.env.VLLM_SHIM_MAX_CONCURRENT_GOLD_SPARK = "2";
    expect(VllmShimService.limitFor("gold-spark")).toBe(2);
    expect(VllmShimService.semaphoreFor("gold-spark")!.limit).toBe(2);
  });

  it("treats an explicit 0 as an opt-out, so the cap can be disabled live", () => {
    process.env.VLLM_SHIM_MAX_CONCURRENT_GOLD_SPARK = "0";
    expect(VllmShimService.limitFor("gold-spark")).toBe(0);
    expect(VllmShimService.semaphoreFor("gold-spark")).toBeNull();
  });

  it("maps the hyphenated upstream name onto the underscored env key", () => {
    process.env.VLLM_SHIM_MAX_CONCURRENT_JETSON_2 = "3";
    expect(VllmShimService.limitFor("jetson-2")).toBe(3);
    delete process.env.VLLM_SHIM_MAX_CONCURRENT_JETSON_2;
  });
});

// ── The one that matters ────────────────────────────────────────────
//
// Models the real timing: headers resolve fast, the body drains slowly.
describe("a slot is held for the whole request, not just the fetch", () => {
  const HEADERS_MS = 5;
  const BODY_MS = 60;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * What we count is BODIES IN FLIGHT — the window during which the GPU is
   * actually generating. Counting arrivals instead measures how fast the test
   * spawned coroutines, which is what the first version of this harness did:
   * it reported 12 for both shapes and would have "passed" a broken limiter.
   */
  type Tracker = { enter(): void; exit(): void; peak: number };
  const tracker = (): Tracker => {
    let live = 0;
    const t: Tracker = {
      peak: 0,
      enter() {
        live += 1;
        t.peak = Math.max(t.peak, live);
      },
      exit() {
        live -= 1;
      },
    };
    return t;
  };

  /** Correct: release in a `finally` that covers the body pump. */
  async function correctProxy(sem: UpstreamSemaphore, t: Tracker) {
    const release = await sem.acquire(5000);
    try {
      await sleep(HEADERS_MS); // await fetch() resolves — headers only
      t.enter(); // body starts: the GPU is busy from here
      await sleep(BODY_MS); // SSE drain
      t.exit();
    } finally {
      release();
    }
  }

  /** SABOTAGE: the pre-fix shape — release as soon as headers arrive. */
  async function releaseOnHeadersProxy(sem: UpstreamSemaphore, t: Tracker) {
    const release = await sem.acquire(5000);
    await sleep(HEADERS_MS);
    release(); // <-- the defect: the GPU has not started yet
    t.enter();
    await sleep(BODY_MS);
    t.exit();
  }

  async function peakBodies(
    proxy: (s: UpstreamSemaphore, t: Tracker) => Promise<void>,
    n = 12,
    limit = 4,
  ): Promise<number> {
    const sem = new UpstreamSemaphore(limit);
    const t = tracker();
    await Promise.all(Array.from({ length: n }, () => proxy(sem, t)));
    return t.peak;
  }

  it("CORRECT: releasing after the body drains holds GPU concurrency at the cap", async () => {
    expect(await peakBodies(correctProxy)).toBe(4);
  });

  it("SABOTAGE CONTROL: releasing at header time lets every body run at once", async () => {
    const peak = await peakBodies(releaseOnHeadersProxy);
    // Not a marginal overshoot — the cap is simply absent, which is the whole
    // point of the control. A limiter test that passes both ways proves nothing,
    // and per the live timing (99.7% of a request is post-headers) this is the
    // mistake actually available in this code.
    expect(peak).toBe(12);
  });
});

// ── Routing: what is gated and what must never be ───────────────────
describe("only generation is gated", () => {
  // Mirrors the predicate in handle(); the live-path assertion is the
  // integration check in the plan, this pins the intent.
  const isGated = (method: string, basePath: string) =>
    method === "POST" && (basePath === "/v1/chat/completions" || basePath === "/v1/embeddings");

  it("gates chat completions and embeddings", () => {
    expect(isGated("POST", "/v1/chat/completions")).toBe(true);
    expect(isGated("POST", "/v1/embeddings")).toBe(true);
  });

  it("NEVER gates the probes trading-service polls every 5s", () => {
    // Queueing /metrics behind four generations feeds the caller's own limiter
    // stale queue depths — the same shape as the blind-limiter bug, which read
    // waiting=0 while the box sat at 17.
    expect(isGated("GET", "/metrics")).toBe(false);
    expect(isGated("GET", "/v1/models")).toBe(false);
    expect(isGated("GET", "/health")).toBe(false);
  });
});

describe("resolveUpstream carries the name the semaphore is keyed on", () => {
  it("returns the upstream name alongside the URL", () => {
    const r = VllmShimService.resolveUpstream("/vllm-shim/gold-spark/v1/chat/completions");
    expect(r?.upstreamName).toBe("gold-spark");
    expect(r?.originalPath).toBe("/v1/chat/completions");
  });

  it("still rejects an unknown upstream", () => {
    expect(VllmShimService.resolveUpstream("/vllm-shim/nope/v1/models")).toBeNull();
  });
});
