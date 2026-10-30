/**
 * BenchmarkRoutes — list enrichment, aggregate stats, creation validation,
 * the SSE run stream and reruns. BenchmarkService is a stub; assertions are on
 * the response payloads and the emitted SSE events.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import router from "../BenchmarkRoutes.ts";

const stub = vi.hoisted(() => ({
  benchmarks: [] as Array<Record<string, any>>,
  runsById: {} as Record<string, Array<Record<string, any>>>,
  latestById: {} as Record<string, Record<string, any> | null>,
  created: null as null | { payload: Record<string, unknown>; project: unknown; username: unknown },
  runCallbacks: null as null | ((callbacks: any) => Promise<Record<string, any>>),
  runError: null as Error | null,
}));

vi.mock("../../services/BenchmarkService.ts", () => ({
  default: {
    MATCH_MODES: ["exact", "contains", "regex"],
    async list() {
      return stub.benchmarks;
    },
    async getRuns(id: string) {
      return stub.runsById[id] || [];
    },
    async getLatestRun(id: string) {
      return stub.latestById[id] ?? null;
    },
    async getById(id: string) {
      return stub.benchmarks.find((benchmark) => benchmark.id === id) ?? null;
    },
    async create(payload: Record<string, unknown>, project: unknown, username: unknown) {
      stub.created = { payload, project, username };
      return { id: "b-new", ...payload };
    },
    async remove() {},
    async runBenchmark(_benchmark: unknown, _models: unknown, _project: unknown, _username: unknown, callbacks: any) {
      if (stub.runError) throw stub.runError;
      if (stub.runCallbacks) return stub.runCallbacks(callbacks);
      return { id: "r1", summary: { total: 0, passed: 0 } };
    },
    async getRunById(id: string) {
      return (stub.runsById.all || []).find((run) => run.id === id) ?? null;
    },
    getConversationModels() {
      return [{ provider: "openai", model: "gpt-5.2" }];
    },
  },
}));

const handlerFor = (method: string, path: string) => {
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route.methods[method],
  );
  if (!layer) throw new Error(`${method} ${path} is not registered`);
  return layer.route.stack.at(-1).handle as (req: any, res: any, next: any) => Promise<unknown>;
};

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    chunks: [] as string[],
    ended: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      res.headersSent = true;
      return res;
    },
    writeHead(code: number) {
      res.statusCode = code;
      res.headersSent = true;
      return res;
    },
    write(chunk: string) {
      res.chunks.push(chunk);
      return true;
    },
    end() {
      res.ended = true;
      return res;
    },
    on() {
      return res;
    },
  };
  return res;
}

function fakeReq(over: Record<string, unknown> = {}) {
  return {
    params: {},
    body: {},
    query: {},
    headers: { host: "prism.local" },
    project: "proj",
    username: "alice",
    setTimeout() {},
    socket: { setTimeout() {} },
    on() {},
    ...over,
  };
}

const invoke = async (method: string, path: string, req: any) => {
  const res = fakeRes();
  const errors: unknown[] = [];
  await handlerFor(method, path)(req, res, (error: unknown) => {
    if (error !== undefined) errors.push(error);
  });
  return { res, errors };
};

const result = (over: Record<string, unknown> = {}) => ({
  provider: "openai",
  model: "gpt-5.2",
  label: "GPT",
  thinkingEnabled: false,
  toolsEnabled: false,
  agent: null,
  passed: true,
  error: null,
  estimatedCost: 0.1,
  latency: 100,
  ...over,
});

beforeEach(() => {
  stub.benchmarks = [];
  stub.runsById = {};
  stub.latestById = {};
  stub.created = null;
  stub.runCallbacks = null;
  stub.runError = null;
});

describe("GET /benchmark — list enrichment", () => {
  it("attaches cumulative cost, run count and the latest run summary", async () => {
    stub.benchmarks = [
      { id: "b1", name: "First" },
      { id: "b2", name: "Second" },
    ];
    stub.runsById = {
      b1: [{ id: "r1", summary: { totalCost: 1.5 } }, { id: "r2", summary: { totalCost: 0.5 } }, { id: "r3" }],
      b2: [],
    };
    stub.latestById = { b1: { id: "r2", summary: { totalCost: 0.5 }, completedAt: "2026-01-02" }, b2: null };

    const { res, errors } = await invoke("get", "/", fakeReq());
    expect(errors).toEqual([]);
    expect(res.body.count).toBe(2);
    expect(res.body.benchmarks[0]).toMatchObject({
      id: "b1",
      cumulativeCost: 2,
      runCount: 3,
      latestRun: { id: "r2", summary: { totalCost: 0.5 }, completedAt: "2026-01-02" },
    });
    expect(res.body.benchmarks[1]).toMatchObject({ cumulativeCost: 0, runCount: 0, latestRun: null });
  });

  it("forwards service failures", async () => {
    stub.benchmarks = null as unknown as Array<Record<string, any>>;
    const { errors } = await invoke("get", "/", fakeReq());
    expect(errors).toHaveLength(1);
  });
});

describe("GET /benchmark/stats", () => {
  it("deduplicates to the latest result per model config and accumulates totals", async () => {
    stub.benchmarks = [
      { id: "b1", name: "Reasoning" },
      { id: "b2", name: "Coding" },
    ];
    stub.runsById = {
      b1: [
        {
          id: "r2",
          models: [result({ passed: true, estimatedCost: 0.2, latency: 200 })],
        },
        {
          id: "r1",
          models: [
            result({ passed: false, estimatedCost: 0.1, latency: 100 }),
            result({ provider: "google", model: "gemini", label: "Gemini", thinkingEnabled: true, toolsEnabled: true, agent: "coding", error: "timeout" }),
          ],
        },
      ],
      b2: [
        { id: "r3", models: [result({ passed: false, error: null })] },
      ],
    };

    const { res, errors } = await invoke("get", "/stats", fakeReq());
    expect(errors).toEqual([]);
    expect(res.body.totalBenchmarks).toBe(2);
    expect(res.body.totalModels).toBe(2);

    const openai = res.body.models.find((model: any) => model.provider === "openai");
    // Latest run wins for pass/fail; totals accumulate over all runs.
    expect(openai).toMatchObject({
      model: "gpt-5.2",
      label: "GPT",
      total: 2,
      passed: 1,
      failed: 1,
      errored: 0,
      runCount: 3,
      totalCost: 0.4,
      totalLatency: 400,
      passRate: 0.5,
      avgLatency: 400 / 3,
      agent: null,
    });
    expect(openai.benchmarks).toEqual([
      { name: "Reasoning", latestPassed: true, latestErrored: false, total: 2, passed: 1, failed: 1, errored: 0 },
      { name: "Coding", latestPassed: false, latestErrored: false, total: 1, passed: 0, failed: 1, errored: 0 },
    ]);

    const google = res.body.models.find((model: any) => model.provider === "google");
    expect(google).toMatchObject({ total: 1, passed: 0, failed: 0, errored: 1, passRate: 0, agent: "coding", thinkingEnabled: true, toolsEnabled: true });
    expect(google.benchmarks[0]).toMatchObject({ latestPassed: false, latestErrored: true });

    // Sorted by pass rate descending.
    expect(res.body.models.map((model: any) => model.provider)).toEqual(["openai", "google"]);
  });

  it("returns an empty model list when nothing has run", async () => {
    stub.benchmarks = [{ id: "b1", name: "Idle" }];
    stub.runsById = { b1: [] };
    const { res } = await invoke("get", "/stats", fakeReq());
    expect(res.body).toEqual({ models: [], totalModels: 0, totalBenchmarks: 1 });
  });
});

describe("POST /benchmark — creation validation", () => {
  const create = (body: Record<string, unknown>) => invoke("post", "/", fakeReq({ body }));

  it("requires name and prompt", async () => {
    const { res } = await create({ prompt: "p" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Missing required fields: name, prompt" });
  });

  it("requires an expected value or text assertion for model benchmarks", async () => {
    const noAssertion = await create({ name: "n", prompt: "p" });
    expect(noAssertion.res.body.error).toContain("at least one text assertion");

    const emptyAssertions = await create({ name: "n", prompt: "p", assertions: [{ expectedValue: "" }] });
    expect(emptyAssertions.res.body.error).toContain("at least one text assertion");
  });

  it("requires a behavioural assertion for agent benchmarks", async () => {
    const { res } = await create({ name: "n", prompt: "p", benchmarkMode: "agent", agentAssertions: [] });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("at least one behavioral assertion");
  });

  it("rejects an unknown top-level or per-assertion matchMode", async () => {
    const topLevel = await create({ name: "n", prompt: "p", expectedValue: "x", matchMode: "fuzzy" });
    expect(topLevel.res.body.error).toContain("Invalid matchMode");

    const perAssertion = await create({
      name: "n",
      prompt: "p",
      expectedValue: "x",
      assertions: [{ expectedValue: "x", matchMode: "fuzzy" }],
    });
    expect(perAssertion.res.body.error).toContain("Invalid matchMode in assertion");
  });

  it("rejects an invalid assertion operator", async () => {
    const { res } = await create({ name: "n", prompt: "p", expectedValue: "x", assertionOperator: "XOR" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("Invalid assertionOperator");
  });

  it("creates the benchmark with the caller's project and username", async () => {
    const body = {
      name: "Reasoning",
      prompt: "2+2?",
      expectedValue: "4",
      matchMode: "exact",
      assertions: [{ expectedValue: "4", matchMode: "contains" }],
      assertionOperator: "AND",
      tags: ["math"],
    };
    const { res, errors } = await create(body);

    expect(errors).toEqual([]);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ id: "b-new", name: "Reasoning" });
    expect(stub.created).toMatchObject({ project: "proj", username: "alice" });
    expect(stub.created!.payload).toMatchObject(body);
  });

  it("defaults the username when the caller sends none", async () => {
    const { res } = await invoke("post", "/", fakeReq({
      body: { name: "n", prompt: "p", benchmarkMode: "agent", agentAssertions: [{ expectedValue: "x" }] },
      username: undefined,
    }));
    expect(res.statusCode).toBe(201);
    expect(stub.created!.username).toBe("anonymous");
  });
});

describe("POST /benchmark/:id/run — SSE", () => {
  it("answers 404 for an unknown benchmark", async () => {
    const { res } = await invoke("post", "/:id/run", fakeReq({ params: { id: "nope" } }));
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "Benchmark not found" });
  });

  it("streams run, model and tool events, then run_complete", async () => {
    stub.benchmarks = [{ id: "b1", name: "Run me" }];
    stub.runCallbacks = async (callbacks) => {
      callbacks.onRunStart({ totalModels: 2 });
      callbacks.onModelStart({ provider: "openai", model: "gpt-5.2", label: "GPT", isLocal: false });
      callbacks.onModelComplete(result());
      callbacks.onEvent({ type: "toolCall", content: "call", _sourceModel: "gpt-5.2" });
      callbacks.onEvent({ type: "content", content: "partial" });
      return { id: "r1", summary: { total: 1, passed: 1 } };
    };

    const { res, errors } = await invoke("post", "/:id/run", fakeReq({
      params: { id: "b1" },
      body: { models: [{ provider: "openai", model: "gpt-5.2" }] },
    }));

    expect(errors).toEqual([]);
    expect(res.ended).toBe(true);
    const events = res.chunks.map((chunk) => JSON.parse(chunk.replace(/^data: /, "")));
    expect(events.map((event: any) => event.type)).toEqual([
      "run_info",
      "model_start",
      "model_complete",
      "toolCall",
      "content",
      "run_complete",
    ]);
    expect(events[0]).toEqual({ type: "run_info", totalModels: 2 });
    expect(events[1]).toMatchObject({ model: "gpt-5.2", isLocal: false });
    expect(events[3]).toEqual({ type: "toolCall", content: "call", _sourceModel: "gpt-5.2" });
    expect(events[4]).toEqual({ type: "content", content: "partial" });
    expect(events[5]).toMatchObject({ id: "r1" });

    // The live-state registry is cleared once the stream ends.
    const active = await invoke("get", "/:id/active", fakeReq({ params: { id: "b1" } }));
    expect(active.res.body).toEqual({ active: false });
  });

  it("reports a mid-stream failure as an SSE error event", async () => {
    stub.benchmarks = [{ id: "b1", name: "Broken" }];
    stub.runError = new Error("runner exploded");
    const { res } = await invoke("post", "/:id/run", fakeReq({ params: { id: "b1" } }));

    expect(res.headersSent).toBe(true);
    expect(res.ended).toBe(true);
    const last = JSON.parse(res.chunks.at(-1)!.replace(/^data: /, ""));
    expect(last).toEqual({ type: "error", message: "runner exploded" });
  });

  it("answers 500 when the lookup fails before streaming", async () => {
    stub.benchmarks = null as unknown as Array<Record<string, any>>;
    const { res } = await invoke("post", "/:id/run", fakeReq({ params: { id: "b1" } }));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Benchmark execution failed" });
  });
});

describe("POST /benchmark/:id/runs/:runId/rerun", () => {
  it("answers 404 for a missing benchmark or run", async () => {
    const missingBenchmark = await invoke("post", "/:id/runs/:runId/rerun", fakeReq({ params: { id: "b1", runId: "r1" } }));
    expect(missingBenchmark.res.statusCode).toBe(404);
    expect(missingBenchmark.res.body).toEqual({ error: "Benchmark not found" });

    stub.benchmarks = [{ id: "b1", name: "Rerun" }];
    stub.runsById = { all: [] };
    const missingRun = await invoke("post", "/:id/runs/:runId/rerun", fakeReq({ params: { id: "b1", runId: "gone" } }));
    expect(missingRun.res.statusCode).toBe(404);
    expect(missingRun.res.body).toEqual({ error: "Run not found" });
  });

  it("replays the previous run's model set", async () => {
    stub.benchmarks = [{ id: "b1", name: "Rerun" }];
    stub.runsById = {
      all: [{
        id: "r1",
        models: [
          result({ agent: "coding" }),
          result({ provider: "google", model: "gemini", label: "Gemini", thinkingEnabled: true, toolsEnabled: true, agent: null }),
        ],
      }],
    };
    stub.runCallbacks = async () => ({ id: "r2", summary: { total: 2 } });

    const { res, errors } = await invoke("post", "/:id/runs/:runId/rerun", fakeReq({ params: { id: "b1", runId: "r1" } }));
    expect(errors).toEqual([]);
    expect(res.body).toEqual({ id: "r2", summary: { total: 2 } });
  });
});
