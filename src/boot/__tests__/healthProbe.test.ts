/**
 * LF-11 — /health must tell the truth. Fakes for Mongo ping, box list and
 * fetch drive the verdict rules without sockets:
 *   all up -> ok 200; one box down -> degraded 200; mongo down -> down 503;
 *   every box down -> down 503; hung mongo ping -> down 503 "timeout" (2 s
 *   race, not just a measurement); disabled boxes (jetson-2/vllm-3) are
 *   skipped and never counted; with zero enabled boxes the verdict follows
 *   mongo alone; cache holds within 10 s; error text never leaks URL
 *   credentials.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createHealthProbe,
  publicErrorText,
  type BoxTarget,
  type HealthProbeDeps,
} from "../healthProbe.ts";

const BOXES: BoxTarget[] = [
  { name: "vllm", url: "http://10.0.0.20:8000" },
  { name: "vllm-2", url: "http://10.0.0.21:8000/" },
];

function makeFetch(opts: { failBoxes?: string[] } = {}) {
  const failBoxes = opts.failBoxes ?? [];
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, init });
    const dead = failBoxes.some((base) => href.startsWith(base.replace(/\/+$/, "")));
    if (dead) return { ok: false, status: 503 } as Response;
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeDeps(overrides: Partial<HealthProbeDeps> = {}): HealthProbeDeps & {
  pingCalls: () => number;
} {
  let pings = 0;
  const deps: HealthProbeDeps = {
    pingMongo: async () => {
      pings += 1;
    },
    listBoxes: () => BOXES,
    ...overrides,
  };
  return { ...deps, pingCalls: () => pings };
}

describe("createHealthProbe verdicts", () => {
  it("answers ok/200 when mongo and every box answer", async () => {
    const { fetchImpl, calls } = makeFetch();
    const probe = createHealthProbe(makeDeps({ fetchImpl }));

    const report = await probe.check();

    expect(report.status).toBe("ok");
    expect(report.httpStatus).toBe(200);
    expect(report.checks.mongo.ok).toBe(true);
    expect(report.checks.vllm.ok).toBe(true);
    expect(report.checks["vllm-2"].ok).toBe(true);
    // Trailing slash normalised, discovery path appended, GET only.
    expect(calls.map((c) => c.url).sort()).toEqual([
      "http://10.0.0.20:8000/v1/models",
      "http://10.0.0.21:8000/v1/models",
    ]);
    for (const call of calls) {
      expect(call.init?.method).toBe("GET");
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("answers degraded/200 when one box is down but mongo is up", async () => {
    const { fetchImpl } = makeFetch({ failBoxes: ["http://10.0.0.21:8000"] });
    const probe = createHealthProbe(makeDeps({ fetchImpl }));

    const report = await probe.check();

    expect(report.status).toBe("degraded");
    expect(report.httpStatus).toBe(200); // healthcheck must stay green
    expect(report.checks.vllm.ok).toBe(true);
    expect(report.checks["vllm-2"].ok).toBe(false);
    expect(report.checks["vllm-2"].error).toContain("HTTP 503");
  });

  it("answers down/503 when mongo is down, even with all boxes up", async () => {
    const { fetchImpl } = makeFetch();
    const probe = createHealthProbe(
      makeDeps({ fetchImpl, pingMongo: async () => { throw new Error("ECONNREFUSED"); } }),
    );

    const report = await probe.check();

    expect(report.status).toBe("down");
    expect(report.httpStatus).toBe(503);
    expect(report.checks.mongo.ok).toBe(false);
    expect(report.checks.mongo.error).toContain("ECONNREFUSED");
    expect(report.checks.vllm.ok).toBe(true);
  });

  it("answers down/503 when every box is down", async () => {
    const { fetchImpl } = makeFetch({
      failBoxes: ["http://10.0.0.20:8000", "http://10.0.0.21:8000"],
    });
    const probe = createHealthProbe(makeDeps({ fetchImpl }));

    const report = await probe.check();

    expect(report.status).toBe("down");
    expect(report.httpStatus).toBe(503);
  });

  it("reports down/503 with error 'timeout' when the mongo ping hangs", async () => {
    // A hang (e.g. Mongo server-selection stalling ~30 s) must count as mongo
    // down within the probe budget — the ping is raced against a timer.
    const { fetchImpl } = makeFetch();
    const probe = createHealthProbe(
      makeDeps({
        fetchImpl,
        timeoutMs: 50,
        pingMongo: () => new Promise<never>(() => {}),
      }),
    );

    const report = await probe.check();

    expect(report.status).toBe("down");
    expect(report.httpStatus).toBe(503);
    expect(report.checks.mongo.ok).toBe(false);
    expect(report.checks.mongo.error).toContain("timeout");
    expect(report.checks.vllm.ok).toBe(true); // boxes still probed in parallel
  });

  it("skips disabled boxes: not probed, not counted toward degraded/down", async () => {
    const { fetchImpl, calls } = makeFetch();
    const probe = createHealthProbe(
      makeDeps({
        fetchImpl,
        listBoxes: () => [
          ...BOXES,
          { name: "vllm-3", url: "http://10.0.0.16:5591/vllm-shim/jetson-2", enabled: false },
        ],
      }),
    );

    const report = await probe.check();

    expect(report.status).toBe("ok"); // the disabled box does not pin degraded
    expect(report.httpStatus).toBe(200);
    expect(report.checks["vllm-3"]).toEqual({ ok: null, ms: 0, skipped: "disabled" });
    expect(calls.map((c) => c.url)).not.toContain(
      "http://10.0.0.16:5591/vllm-shim/jetson-2/v1/models",
    );
  });

  it("still reports degraded when an enabled box fails next to a disabled one", async () => {
    const { fetchImpl } = makeFetch({ failBoxes: ["http://10.0.0.20:8000"] });
    const probe = createHealthProbe(
      makeDeps({
        fetchImpl,
        listBoxes: () => [
          BOXES[0],
          { name: "vllm-3", url: "http://10.0.0.16:5591/vllm-shim/jetson-2", enabled: false },
        ],
      }),
    );

    const report = await probe.check();

    expect(report.status).toBe("degraded");
    expect(report.httpStatus).toBe(200);
  });

  it("follows mongo alone when no box is enabled", async () => {
    const { fetchImpl, calls } = makeFetch();

    const up = await createHealthProbe(
      makeDeps({
        fetchImpl,
        listBoxes: () => [
          { name: "vllm-3", url: "http://10.0.0.16:5591/vllm-shim/jetson-2", enabled: false },
        ],
      }),
    ).check();
    expect(up.status).toBe("ok");
    expect(up.httpStatus).toBe(200);
    expect(calls).toHaveLength(0); // nothing probed, nothing counted

    const downProbe = createHealthProbe(
      makeDeps({
        fetchImpl,
        listBoxes: () => [
          { name: "vllm-3", url: "http://10.0.0.16:5591/vllm-shim/jetson-2", enabled: false },
        ],
        pingMongo: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    );
    const down = await downProbe.check();
    expect(down.status).toBe("down");
    expect(down.httpStatus).toBe(503);
  });
});

describe("createHealthProbe cache", () => {
  it("holds the result for 10 s and re-probes after the TTL", async () => {
    let clock = 1_000;
    const { fetchImpl } = makeFetch();
    const deps = makeDeps({ fetchImpl, now: () => clock });
    const probe = createHealthProbe(deps);

    const first = await probe.check();
    clock += 9_999;
    const second = await probe.check();

    // Same cached object: one Mongo ping and two box GETs for both requests.
    expect(second).toBe(first);
    expect(deps.pingCalls()).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    clock += 1; // past the 10 s TTL
    const third = await probe.check();

    expect(third).not.toBe(first);
    expect(deps.pingCalls()).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("shares one in-flight probe across concurrent requests (no storm)", async () => {
    const { fetchImpl } = makeFetch();
    const deps = makeDeps({ fetchImpl });
    const probe = createHealthProbe(deps);

    const reports = await Promise.all([probe.check(), probe.check(), probe.check()]);

    expect(reports[0]).toBe(reports[1]);
    expect(reports[1]).toBe(reports[2]);
    expect(deps.pingCalls()).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("publicErrorText", () => {
  it("redacts URL credentials so secrets never reach /health", () => {
    const text = publicErrorText(
      new Error("connect failed to http://user:hunter2@10.0.0.5:27017/prism"),
    );
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("user:");
    expect(text).toContain("[redacted]@");
  });
});
