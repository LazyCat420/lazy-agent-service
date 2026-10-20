import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SseEvent } from "../../../types/SseTypes.js";
import {
  JetsonGate,
  JetsonGateRejectedError,
  WALLGARDEN_PRIORITY,
} from "../JetsonGate.js";

const chatState = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../routes/ChatRoutes.js", () => ({
  handleConversation: async (
    params: Record<string, unknown>,
    emit: (event: SseEvent) => void,
  ) => {
    chatState.calls.push(params);
    emit({ type: "chunk", content: '{"topics":["wood ash glaze"]}' } as SseEvent);
    emit({ type: "done", provider: "vllm", model: params.model } as SseEvent);
  },
}));

describe("JetsonGate — priority admission & queue timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("caps concurrency at maxInFlight (2) and runs priority-0 ahead of queued priority-2 jobs", async () => {
    const gate = new JetsonGate({ maxInFlight: 2, maxWaitMs: 90_000 });
    const startOrder: string[] = [];
    const resolvers: Array<() => void> = [];

    const makeJob = (label: string) => () =>
      new Promise<string>((resolve) => {
        startOrder.push(label);
        resolvers.push(() => resolve(label));
      });

    // Submit 2 in-flight + 1 queued priority-2 job, then 1 priority-0 job
    const p2a = gate.run(WALLGARDEN_PRIORITY.BACKGROUND, makeJob("p2-a"));
    const p2b = gate.run(WALLGARDEN_PRIORITY.BACKGROUND, makeJob("p2-b"));
    const p2c = gate.run(WALLGARDEN_PRIORITY.BACKGROUND, makeJob("p2-c"));
    const p0 = gate.run(WALLGARDEN_PRIORITY.USER_FACING, makeJob("p0-urgent"));

    expect(startOrder).toEqual(["p2-a", "p2-b"]);
    expect(gate.stats()).toMatchObject({
      inFlight: 2,
      queued: { p0: 1, p1: 0, p2: 1, total: 2 },
    });

    // Finish first in-flight job -> p0-urgent MUST start before p2-c
    resolvers.shift()!();
    await p2a;
    await new Promise((r) => setTimeout(r, 0));

    expect(startOrder).toEqual(["p2-a", "p2-b", "p0-urgent"]);

    // Finish second in-flight job -> p2-c starts next
    resolvers.shift()!();
    await p2b;
    await new Promise((r) => setTimeout(r, 0));

    expect(startOrder).toEqual(["p2-a", "p2-b", "p0-urgent", "p2-c"]);

    // Finish remaining
    resolvers.shift()!();
    resolvers.shift()!();
    await Promise.all([p0, p2c]);

    expect(gate.stats()).toMatchObject({
      inFlight: 0,
      queued: { p0: 0, p1: 0, p2: 0, total: 0 },
      completed: 4,
      rejected: 0,
    });
  });

  it("rejects a priority >= 1 job that waits > 90s with JetsonGateRejectedError (statusCode 503)", async () => {
    vi.useFakeTimers();
    const gate = new JetsonGate({ maxInFlight: 2, maxWaitMs: 90_000 });
    const resolvers: Array<() => void> = [];

    const holdSlot = () =>
      new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });

    // Fill both slots
    const slot1 = gate.run(WALLGARDEN_PRIORITY.USER_FACING, holdSlot);
    const slot2 = gate.run(WALLGARDEN_PRIORITY.USER_FACING, holdSlot);

    // Enqueue a priority-1 (JUDGE) and a priority-0 (USER_FACING) job
    const p1Promise = gate.run(WALLGARDEN_PRIORITY.JUDGE, async () => "judged");
    let p1Error: unknown = null;
    p1Promise.catch((err) => {
      p1Error = err;
    });
    const p0Promise = gate.run(WALLGARDEN_PRIORITY.USER_FACING, async () => "extracted");

    expect(gate.stats().queued).toEqual({ p0: 1, p1: 1, p2: 0, total: 2 });

    // Advance past 90s -> p1 rejects with 503, p0 remains queued
    await vi.advanceTimersByTimeAsync(90_001);

    expect(p1Error).toBeInstanceOf(JetsonGateRejectedError);
    expect((p1Error as JetsonGateRejectedError).statusCode).toBe(503);
    expect(gate.stats().rejected).toBe(1);
    expect(gate.stats().queued).toEqual({ p0: 1, p1: 0, p2: 0, total: 1 });

    // Release slots -> p0 still succeeds
    resolvers.forEach((r) => r());
    await Promise.all([slot1, slot2]);
    await expect(p0Promise).resolves.toBe("extracted");
  });
});

describe("WallgardenRoutes — classify-candidates disabled & gate stats exposed", () => {
  beforeEach(() => {
    chatState.calls.length = 0;
    vi.stubGlobal("fetch", async (url: any) => {
      const u = String(url);
      if (u.endsWith("/v1/models")) {
        return {
          ok: true,
          json: async () => ({ data: [{ id: "nemotron35" }] }),
        } as any;
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POST /wallgarden/classify-candidates returns disabled=true with 0 LLM calls", async () => {
    const routerMod = await import("../../../routes/WallgardenRoutes.js");
    const router = routerMod.default as any;
    const layer = router.stack.find(
      (l: any) => l.route?.path === "/classify-candidates" && l.route?.methods?.post,
    );
    expect(layer).toBeDefined();

    const handler = layer.route.stack[0].handle;
    let statusCode = 200;
    let bodyOut: any = null;
    const req = {
      body: {
        topic: "raku kiln",
        candidates: [{ id: "vid1", title: "Building a raku kiln" }],
      },
    } as any;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: any) {
        bodyOut = payload;
        return this;
      },
    } as any;

    await handler(req, res, () => {});
    expect(statusCode).toBe(200);
    expect(bodyOut).toEqual({
      classifications: [],
      count: 0,
      failed: false,
      disabled: true,
    });
    expect(chatState.calls).toHaveLength(0);
  });

  it("GET /wallgarden/models includes gate stats and expected nemotron35 model", async () => {
    const { EXPECTED_JETSON_MODEL } = await import("../WallgardenService.js");
    expect(EXPECTED_JETSON_MODEL).toBe("nemotron35");

    const routerMod = await import("../../../routes/WallgardenRoutes.js");
    const router = routerMod.default as any;
    const layer = router.stack.find(
      (l: any) => l.route?.path === "/models" && l.route?.methods?.get,
    );
    expect(layer).toBeDefined();

    const handler = layer.route.stack[0].handle;
    let bodyOut: any = null;
    const res = {
      status() {
        return this;
      },
      json(payload: any) {
        bodyOut = payload;
        return this;
      },
    } as any;

    await handler({} as any, res, () => {});
    expect(bodyOut).toHaveProperty("gate");
    expect(bodyOut.gate).toMatchObject({
      maxInFlight: 2,
      maxWaitMs: 90_000,
    });
  });
});
