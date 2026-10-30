/**
 * AdminStatsRoutes — every aggregate endpoint, driven by a queue of
 * aggregation results. Assertions are on the JSON the admin UI receives:
 * default zeroes, id fallbacks, derived counts and granularity selection.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import router from "../admin/AdminStatsRoutes.ts";

const stub = vi.hoisted(() => ({
  agents: [] as Array<{ id: string }>,
  personas: {} as Record<string, Record<string, unknown>>,
  roots: [] as string[],
}));

vi.mock("../../services/AgentPersonaRegistry.ts", () => ({
  default: {
    list: () => stub.agents,
    get: (id: string) => stub.personas[id] ?? null,
  },
}));

vi.mock("../../services/ToolOrchestratorService.ts", () => ({
  default: { getWorkspaceRoots: () => stub.roots },
}));

vi.mock("../../utils/logger.ts", () => ({
  default: { error: () => {}, warn: () => {}, info: () => {} },
}));

type Queue = Array<unknown>;

function fakeDb(spec: {
  requests?: Queue;
  workflows?: Queue;
  model_conversations?: Queue;
  agent_conversations?: Queue;
  conversationCount?: number;
  workspaceDocs?: { model?: Array<{ id: string }>; agent?: Array<{ id: string }> };
} = {}) {
  const queues: Record<string, Queue> = {
    requests: [...(spec.requests || [])],
    workflows: [...(spec.workflows || [])],
    model_conversations: [...(spec.model_conversations || [])],
    agent_conversations: [...(spec.agent_conversations || [])],
  };
  const workspaceDocs = spec.workspaceDocs || {};
  const collection = (name: string) => ({
    aggregate: () => ({
      toArray: async () => {
        const queue = queues[name] || [];
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next ?? [];
      },
    }),
    find: () => ({
      project: () => ({
        toArray: async () => {
          const docs = name === "model_conversations" ? workspaceDocs.model : workspaceDocs.agent;
          return docs || [];
        },
      }),
    }),
    countDocuments: async () => spec.conversationCount ?? 0,
  });
  return { db: { collection } };
}

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
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      res.headersSent = true;
      return res;
    },
  };
  return res;
}

function fakeReq(over: Record<string, unknown> = {}) {
  return { params: {}, body: {}, query: {}, headers: {}, db: undefined, ...over };
}

const invoke = async (path: string, req: any) => {
  const res = fakeRes();
  const errors: unknown[] = [];
  await handlerFor("get", path)(req, res, (error: unknown) => {
    if (error !== undefined) errors.push(error);
  });
  return { res, errors };
};

beforeEach(() => {
  stub.agents = [];
  stub.personas = {};
  stub.roots = [];
});

describe("GET /admin/stats", () => {
  it("merges the aggregate row over zero defaults and adds derived counts", async () => {
    stub.agents = [{ id: "a1" }, { id: "a2" }];
    stub.roots = ["/w1", "/w2", "/w3"];
    const { db } = fakeDb({
      requests: [[{ totalRequests: 12, totalCost: 3.5, successCount: 10, errorCount: 2 }], [{ total: 7 }], [{ total: 4 }]],
      conversationCount: 9,
    });
    const { res, errors } = await invoke("/", fakeReq({ db, query: { project: "proj", from: "2026-01-01", to: "2026-01-31" } }));

    expect(errors).toEqual([]);
    expect(res.body).toMatchObject({
      totalRequests: 12,
      totalCost: 3.5,
      successCount: 10,
      errorCount: 2,
      traceCount: 4,
      totalToolCalls: 7,
      conversationCount: 9,
      agentCount: 2,
      workspaceCount: 3,
    });
    // Fields the aggregate did not return keep their zero defaults.
    expect(res.body.totalInputTokens).toBe(0);
    expect(res.body.avgLatency).toBe(0);
  });

  it("scopes by workspace through both conversation collections", async () => {
    const { db } = fakeDb({
      requests: [[], [], []],
      workspaceDocs: { model: [{ id: "c1" }, { id: "c2" }], agent: [{ id: "a1" }] },
    });
    const { res } = await invoke("/", fakeReq({ db, query: { workspace: "/w" } }));
    expect(res.body.conversationCount).toBe(0);
    expect(res.body.traceCount).toBe(0);
  });

  it("forwards aggregation failures", async () => {
    const { db } = fakeDb({ requests: [new Error("aggregate failed")] });
    const { errors } = await invoke("/", fakeReq({ db }));
    expect(errors[0]).toMatchObject({ message: "aggregate failed" });
  });
});

describe("GET /admin/stats/projects", () => {
  it("joins workflow, conversation and trace counts onto each project row", async () => {
    const { db } = fakeDb({
      requests: [
        [
          { _id: "proj", totalRequests: 5, totalTokens: 100, _models: ["gpt", null, "gemini"], _providers: ["openai", ""], modelCount: 2, providerCount: 1 },
          { _id: null, totalRequests: 1, _models: [], _providers: [] },
        ],
        [{ _id: "proj", traceCount: 4 }],
      ],
      workflows: [[{ _id: "proj", workflowCount: 2 }]],
      model_conversations: [[{ _id: "proj", conversationCount: 3 }]],
    });
    const { res, errors } = await invoke("/projects", fakeReq({ db, query: { project: "proj", provider: "openai", model: "gpt,gemini", workspace: "/w", from: "2026-01-01" } }));

    expect(errors).toEqual([]);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      project: "proj",
      models: ["gpt", "gemini"],
      providers: ["openai"],
      workflowCount: 2,
      conversationCount: 3,
      traceCount: 4,
    });
    // A null project falls back to "any" and has no linked counts.
    expect(res.body[1]).toMatchObject({ project: "any", workflowCount: 0, conversationCount: 0, traceCount: 0 });
  });

  it("forwards aggregation failures", async () => {
    const { db } = fakeDb({ requests: [new Error("boom")] });
    const { errors } = await invoke("/projects", fakeReq({ db }));
    expect(errors[0]).toMatchObject({ message: "boom" });
  });
});

describe("GET /admin/stats/users", () => {
  it("maps rows and defaults a null username to any", async () => {
    const { db } = fakeDb({
      requests: [[
        { _id: "alice", totalRequests: 3, totalTokens: 30, totalCost: 1, avgLatency: 12, lastRequest: "2026-01-01" },
        { _id: null, totalRequests: 1 },
      ]],
    });
    const { res } = await invoke("/users", fakeReq({ db }));
    expect(res.body).toEqual([
      { username: "alice", totalRequests: 3, totalTokens: 30, totalCost: 1, avgLatency: 12, lastRequest: "2026-01-01" },
      { username: "any", totalRequests: 1, totalTokens: undefined, totalCost: undefined, avgLatency: undefined, lastRequest: undefined },
    ]);
  });
});

describe("GET /admin/stats/models", () => {
  it("attaches conversation and trace counts keyed by model and provider", async () => {
    const { db } = fakeDb({
      requests: [
        [
          { _id: { model: "gpt", provider: "openai" }, totalRequests: 4, toolsUsed: true },
          { _id: { model: "gemini", provider: "google" }, totalRequests: 2, toolsUsed: false },
        ],
        [{ _id: { model: "gpt", provider: "openai" }, conversationCount: 3 }],
        [{ _id: { model: "gemini", provider: "google" }, traceCount: 2 }],
      ],
    });
    const { res } = await invoke("/models", fakeReq({ db }));
    expect(res.body[0]).toMatchObject({ model: "gpt", provider: "openai", toolsUsed: true, conversationCount: 3, workflowCount: 0, traceCount: 0 });
    expect(res.body[1]).toMatchObject({ model: "gemini", provider: "google", toolsUsed: false, conversationCount: 0, traceCount: 2 });
  });
});

describe("GET /admin/stats/tools", () => {
  it("ranks the top models and agents per tool", async () => {
    const { db } = fakeDb({
      requests: [[{
        _id: "get_weather",
        totalCalls: 10,
        totalRequests: 4,
        _models: ["gpt", "gpt", "gemini", null, "a", "b", "c"],
        _agents: ["atlas", "atlas", null, "coding"],
        _providers: ["openai", null],
        successCount: 9,
        failureCount: 1,
      }]],
    });
    const { res } = await invoke("/tools", fakeReq({ db, query: { tool: "get_weather" } }));
    expect(res.body[0]).toMatchObject({
      tool: "get_weather",
      providers: ["openai"],
      topModels: [{ model: "gpt", count: 2 }, { model: "gemini", count: 1 }, { model: "a", count: 1 }, { model: "b", count: 1 }, { model: "c", count: 1 }],
      topAgents: [{ agent: "atlas", count: 2 }, { agent: "coding", count: 1 }],
    });
  });
});

describe("GET /admin/stats/endpoints", () => {
  it("maps endpoint rows with an any fallback", async () => {
    const { db } = fakeDb({
      requests: [[{ _id: "chat", totalRequests: 5, totalTokens: 50, successRate: 0.9 }, { _id: null, totalRequests: 1 }]],
    });
    const { res } = await invoke("/endpoints", fakeReq({ db }));
    expect(res.body[0]).toMatchObject({ endpoint: "chat", totalRequests: 5, successRate: 0.9 });
    expect(res.body[1]).toMatchObject({ endpoint: "any", totalRequests: 1 });
  });
});

describe("GET /admin/stats/costs", () => {
  it("groups provider, endpoint and model costs under each project", async () => {
    const facet = [{
      totals: [{ totalCost: 10, totalInputTokens: 1000, totalOutputTokens: 500, totalRequests: 20, avgTokensPerSec: 42 }],
      byProject: [{ _id: "proj", totalCost: 10, totalRequests: 20 }, { _id: null, totalCost: 1, totalRequests: 1 }],
      byProvider: [{ _id: "openai", totalCost: 10, totalRequests: 20 }, { _id: null, totalCost: 1, totalRequests: 1 }],
      byModel: [{ _id: { model: "gpt", provider: "openai" }, totalCost: 10 }, { _id: {}, totalCost: 1 }],
      byEndpoint: [{ _id: "chat", totalCost: 10 }, { _id: null, totalCost: 1 }],
      byProjectProvider: [{ _id: { project: "proj", provider: "openai" }, totalCost: 10 }, { _id: {}, totalCost: 1 }],
      byProjectEndpoint: [{ _id: { project: "proj", endpoint: "chat" }, totalCost: 10 }, { _id: {}, totalCost: 1 }],
      byProjectModel: [{ _id: { project: "proj", model: "gpt", provider: "openai" }, totalCost: 10 }, { _id: {}, totalCost: 1 }],
    }];
    const { db } = fakeDb({ requests: [facet] });
    const { res, errors } = await invoke("/costs", fakeReq({ db, query: { from: "2026-01-01" } }));

    expect(errors).toEqual([]);
    expect(res.body.totals).toEqual({ totalCost: 10, totalInputTokens: 1000, totalOutputTokens: 500, totalRequests: 20, avgTokensPerSec: 42 });
    expect(res.body.byProject[0]).toMatchObject({
      project: "proj",
      byProvider: [{ provider: "openai", totalCost: 10 }],
      byEndpoint: [{ endpoint: "chat", totalCost: 10 }],
      byModel: [{ model: "gpt", provider: "openai", totalCost: 10 }],
    });
    expect(res.body.byProject[1]).toMatchObject({
      project: "any",
      byProvider: [{ provider: "any", totalCost: 1 }],
      byEndpoint: [{ endpoint: "any", totalCost: 1 }],
      byModel: [{ model: "any", provider: "any", totalCost: 1 }],
    });
    expect(res.body.byProvider[1]).toMatchObject({ provider: "any", totalCost: 1 });
    expect(res.body.byModel[1]).toMatchObject({ model: "any", provider: "any", totalCost: 1 });
    expect(res.body.byEndpoint[1]).toMatchObject({ endpoint: "any", totalCost: 1 });
  });

  it("returns zero totals when the facet has no rows", async () => {
    const { db } = fakeDb({
      requests: [[{ totals: [], byProject: [], byProvider: [], byModel: [], byEndpoint: [], byProjectProvider: [], byProjectEndpoint: [], byProjectModel: [] }]],
    });
    const { res } = await invoke("/costs", fakeReq({ db }));
    expect(res.body.totals).toEqual({
      totalCost: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRequests: 0,
      avgTokensPerSec: undefined,
    });
    expect(res.body.byProject).toEqual([]);
  });
});

describe("GET /admin/stats/timeline", () => {
  const timelineReq = (query: Record<string, unknown>) => fakeReq({
    db: fakeDb({ requests: [[{ _id: "2026-01-01T00:00", requests: 4, tokens: 40, cost: 0.4, avgLatency: 12.6, successes: 2 }, { _id: "2026-01-01T00:05", requests: 0, tokens: 0, cost: 0, avgLatency: null, successes: 0 }]] }).db,
    query,
  });

  it("defaults to 5min for a day and rounds latency and success rate", async () => {
    const { res } = await invoke("/timeline", timelineReq({ hours: "24" }));
    expect(res.body.granularity).toBe("5min");
    expect(res.body.defaultGranularity).toBe("5min");
    expect(res.body.validGranularities).toEqual(["1min", "5min", "15min", "1hr"]);
    expect(res.body.data[0]).toEqual({ hour: "2026-01-01T00:00", requests: 4, tokens: 40, cost: 0.4, avgLatency: 13, successRate: 50 });
    // No requests → 100% success and zero latency.
    expect(res.body.data[1]).toMatchObject({ avgLatency: 0, successRate: 100 });
  });

  it("uses the explicit from/to span and honours a valid granularity", async () => {
    const { res } = await invoke("/timeline", timelineReq({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T00:01:00.000Z", granularity: "5s" }));
    expect(res.body.granularity).toBe("5s");
    expect(res.body.validGranularities).toEqual(["1s", "5s", "15s"]);
  });

  it("rejects a granularity outside the span's bounds", async () => {
    const { res } = await invoke("/timeline", timelineReq({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T00:01:00.000Z", granularity: "1hr" }));
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('Invalid granularity "1hr"');
  });

  it("covers each granularity tier and its bucket expression", async () => {
    const spans: Array<[string, string, string]> = [
      ["2026-01-01T00:00:00.000Z", "2026-01-01T00:01:00.000Z", "1s"],
      ["2026-01-01T00:00:00.000Z", "2026-01-01T00:01:00.000Z", "15s"],
      ["2026-01-01T00:00:00.000Z", "2026-01-01T00:05:00.000Z", "30s"],
      ["2026-01-01T00:00:00.000Z", "2026-01-01T00:05:00.000Z", "1min"],
      ["2026-01-01T00:00:00.000Z", "2026-01-01T00:20:00.000Z", "5min"],
      ["2026-01-01T00:00:00.000Z", "2026-01-01T02:00:00.000Z", "15min"],
      ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "1hr"],
      ["2026-01-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z", "4hr"],
      ["2026-01-01T00:00:00.000Z", "2026-01-06T00:00:00.000Z", "1day"],
      ["2026-01-01T00:00:00.000Z", "2026-01-20T00:00:00.000Z", "1week"],
    ];
    for (const [from, to, granularity] of spans) {
      const { res } = await invoke("/timeline", timelineReq({ from, to, granularity }));
      expect(res.statusCode).toBe(200);
      expect(res.body.granularity).toBe(granularity);
    }
  });
});

describe("GET /admin/stats/agents", () => {
  it("joins persona metadata and deduplicated ids", async () => {
    stub.personas = { atlas: { name: "Atlas", type: "orchestrator", custom: true } };
    const { db } = fakeDb({
      requests: [[
        {
          _id: "atlas",
          totalRequests: 6,
          _models: ["gpt", null, "gpt"],
          _providers: ["openai", ""],
          _convIds: ["c1", null, "c1"],
          _traceIds: ["t1", null],
          successCount: 5,
          errorCount: 1,
        },
        { _id: null, totalRequests: 1 },
      ]],
    });
    const { res } = await invoke("/agents", fakeReq({ db }));
    expect(res.body[0]).toMatchObject({
      agent: "atlas",
      name: "Atlas",
      type: "orchestrator",
      custom: true,
      modelCount: 2,
      providerCount: 1,
      conversationCount: 2,
      sessionCount: 1,
    });
    expect(res.body[1]).toMatchObject({ agent: "", name: "", type: "", custom: false, modelCount: 0 });
  });
});
