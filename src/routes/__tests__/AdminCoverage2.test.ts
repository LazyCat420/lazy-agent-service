/**
 * Coverage2 for admin route handlers with CRAP > 60:
 * agent-conversation stats/list, content workflows/media/text, LM Studio
 * load/estimate, request list/associations, system live snapshot and the
 * conversation list filter/merge/enrichment path.
 *
 * Handlers run with fake req/res objects; DB access is a deterministic
 * stand-in passed as `req.db`, and the provider boundary is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { COLLECTIONS } from "../../constants.ts";

const fakes = vi.hoisted(() => ({
  lmStudio: {
    listModels: async () => ({ models: [] as Array<Record<string, unknown>> }),
    ensureModelLoaded: async (_model: string, _options: Record<string, unknown>) => ({
      alreadyLoaded: false,
    }),
    unloadModel: async (_instanceId: string) => undefined,
  },
}));

vi.mock("../../providers/index.ts", () => ({
  getProvider: () => fakes.lmStudio,
}));

// ── Harness helpers ────────────────────────────────────────

interface RouteLayer {
  route?: { path: string; stack: Array<{ method: string; handle: RequestHandler }> };
}

const getRouteHandlers = (
  router: unknown,
  method: string,
  path: string,
): RequestHandler[] => {
  // `Router.stack` is an express internal, absent from the public typings.
  const routerWithStack = router as unknown as { stack: RouteLayer[] };
  const layers = routerWithStack.stack.filter(
    (entry) => entry.route?.path === path,
  );
  if (layers.length === 0) throw new Error(`route ${method} ${path} not found`);
  const lowerMethod = method.toLowerCase();
  for (const layer of layers) {
    const handlers = (layer.route?.stack ?? [])
      .filter((entry) => entry.method === lowerMethod)
      .map((entry) => entry.handle);
    if (handlers.length > 0) return handlers;
  }
  throw new Error(`handler ${method} ${path} not found`);
};

const getFinalHandler = (
  router: unknown,
  method: string,
  path: string,
): RequestHandler => {
  const handlers = getRouteHandlers(router, method, path);
  return handlers[handlers.length - 1];
};

interface FakeResponseState {
  statusCode: number;
  body: unknown;
  headers: Record<string, string | number>;
  writes: string[];
  ended: boolean;
  sent: boolean;
}

const makeRes = () => {
  const state: FakeResponseState = {
    statusCode: 200,
    body: undefined,
    headers: {},
    writes: [],
    ended: false,
    sent: false,
  };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      state.sent = true;
      return res;
    },
    setHeader(name: string, value: string | number) {
      state.headers[name] = value;
      return res;
    },
    writeHead(code: number, headers?: Record<string, string>) {
      state.statusCode = code;
      Object.assign(state.headers, headers ?? {});
      state.sent = true;
      return res;
    },
    write(chunk: string) {
      state.writes.push(chunk);
      state.sent = true;
      return true;
    },
    end() {
      state.ended = true;
      state.sent = true;
      return res;
    },
    on() {
      return res;
    },
    get headersSent() {
      return state.sent;
    },
    get writableEnded() {
      return state.ended;
    },
  };
  return { res, state };
};

const makeReq = (overrides: Record<string, unknown> = {}) => ({
  query: {},
  params: {},
  body: {},
  headers: {},
  method: "GET",
  originalUrl: "/admin",
  ip: "127.0.0.1",
  on() {
    return undefined;
  },
  ...overrides,
});

const nextSpy = () => {
  const calls: unknown[] = [];
  const next = ((error?: unknown) => {
    if (error) calls.push(error);
  }) as NextFunction;
  return { next, calls };
};

/** Chainable cursor stand-in returning a fixed document list. */
const cursor = (documents: unknown[]) => {
  const chain = {
    project: () => chain,
    sort: () => chain,
    skip: () => chain,
    limit: () => chain,
    toArray: async () => documents,
  };
  return chain;
};

interface DbFakes {
  [collectionName: string]: {
    find?: (filter: Record<string, unknown>, options?: Record<string, unknown>) => unknown;
    findOne?: (filter: Record<string, unknown>) => Promise<unknown>;
    countDocuments?: (filter: Record<string, unknown>) => Promise<number>;
    distinct?: (field: string, filter?: Record<string, unknown>) => Promise<unknown[]>;
    aggregate?: (pipeline: unknown[]) => { toArray: () => Promise<unknown[]> };
  };
}

const makeDb = (collections: DbFakes) => ({
  collection: (name: string) => {
    const fake = collections[name];
    if (!fake) throw new Error(`unexpected collection ${name}`);
    return fake;
  },
});

const calls: Array<{ collection: string; method: string; args: unknown[] }> = [];

// ── AdminAgentConversationRoutes ───────────────────────────

import {
  agentConversationRouter,
  conversationStatsRouter,
} from "../admin/AdminAgentConversationRoutes.ts";

const statsRequests = [
  {
    estimatedCost: 0.5,
    inputTokens: 10,
    outputTokens: 5,
    provider: "openai",
    model: "openai/gpt-4o",
    operation: "chat",
    modalities: { text: true, image: false },
    toolApiNames: ["get_quote"],
    agentConversationId: "conv-1",
    timestamp: "2026-01-01T00:00:00.000Z",
  },
  {
    estimatedCost: 0.25,
    inputTokens: 3,
    cacheReadInputTokens: 2,
    cacheCreationInputTokens: 1,
    reasoningOutputTokens: 4,
    provider: "anthropic",
    model: "anthropic/sonnet",
    operation: "agent",
    modalities: { image: true },
    toolApiNames: ["get_quote", "canvas_add_widget"],
    agentConversationId: "child-1",
    timestamp: "2026-01-01T00:01:00.000Z",
  },
];

describe("AdminAgentConversationRoutes GET /:id/stats", () => {
  afterEach(() => {
    fakes.lmStudio.listModels = async () => ({ models: [] });
  });

  it("aggregates tokens, cost, modalities and tool usage", async () => {
    const db = makeDb({
      [COLLECTIONS.REQUESTS]: {
        distinct: async () => ["child-1"],
        find: () => cursor(statsRequests),
      },
    });

    const handler = getFinalHandler(conversationStatsRouter, "get", "/:id/stats");
    const { res, state } = makeRes();
    await handler(
      makeReq({ params: { id: "conv-1" }, db }) as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.body).toEqual({
      agentConversationId: "conv-1",
      requestCount: 2,
      subAgentRequestCount: 1,
      totalCost: 0.75,
      totalInputTokens: 13,
      totalOutputTokens: 5,
      totalTokens: 18,
      totalCacheReadInputTokens: 2,
      totalCacheCreationInputTokens: 1,
      totalReasoningOutputTokens: 4,
      providers: ["openai", "anthropic"],
      models: ["openai/gpt-4o", "anthropic/sonnet"],
      operations: ["chat", "agent"],
      modalities: { text: true, image: true },
      toolCounts: { get_quote: 2, canvas_add_widget: 1 },
      totalElapsedTime: 60,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    });
  });

  it("answers 404 when the conversation has no requests", async () => {
    const db = makeDb({
      [COLLECTIONS.REQUESTS]: {
        distinct: async () => [],
        find: () => cursor([]),
      },
    });

    const handler = getFinalHandler(conversationStatsRouter, "get", "/:id/stats");
    const { res, state } = makeRes();
    await handler(
      makeReq({ params: { id: "empty" }, db }) as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.statusCode).toBe(404);
    expect(state.body).toEqual({ error: "No requests found for this conversation" });
  });
});

describe("AdminAgentConversationRoutes GET /", () => {
  it("overlays request-log cost onto agent conversations", async () => {
    const db = makeDb({
      [COLLECTIONS.AGENT_CONVERSATIONS]: {
        find: (filter) => {
          calls.push({ collection: "agentConversations", method: "find", args: [filter] });
          return cursor([
            { id: "conv-1", project: "p", totalCost: 0.1, updatedAt: "2026-01-02T00:00:00.000Z" },
            { id: "conv-2", project: "p", totalCost: 5, updatedAt: "2026-01-01T00:00:00.000Z" },
          ]);
        },
        countDocuments: async () => 2,
      },
      [COLLECTIONS.REQUESTS]: {
        aggregate: (pipeline) => {
          calls.push({ collection: "requests", method: "aggregate", args: [pipeline] });
          return {
            toArray: async () => [
              { _id: "conv-1", totalCost: 0.9 },
              { _id: "conv-2", totalCost: 1 },
            ],
          };
        },
      },
    });

    const handler = getFinalHandler(agentConversationRouter, "get", "/");
    const { res, state } = makeRes();
    await handler(
      makeReq({
        db,
        query: { project: "p", search: "chat", from: "2026-01-01", to: "2026-01-31", limit: "10" },
      }) as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    const body = state.body as {
      data: Array<Record<string, unknown>>;
      total: number;
      page: number;
      limit: number;
    };
    expect(body.total).toBe(2);
    expect(body.limit).toBe(10);
    expect(body.page).toBe(1);
    expect(body.data[0].totalCost).toBe(0.9);
    // The existing cost is kept when it is larger than the request-log sum.
    expect(body.data[1].totalCost).toBe(5);

    const filter = calls.find((call) => call.collection === "agentConversations")?.args[0] as
      Record<string, unknown>;
    expect(filter).toMatchObject({
      project: "p",
      updatedAt: { $gte: "2026-01-01", $lte: "2026-01-31" },
    });
    expect(filter.$or).toEqual([
      { title: { $regex: "chat", $options: "i" } },
      { project: { $regex: "chat", $options: "i" } },
      { agent: { $regex: "chat", $options: "i" } },
    ]);
  });
});

// ── AdminLmStudioRoutes ────────────────────────────────────

import lmStudioRouter from "../admin/AdminLmStudioRoutes.ts";

describe("AdminLmStudioRoutes POST /load", () => {
  it("requires a model name", async () => {
    const handler = getFinalHandler(lmStudioRouter, "post", "/load");
    const { res, state } = makeRes();
    await handler(
      makeReq({ body: {} }) as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(400);
    expect(state.body).toEqual({ error: "Missing 'model' in request body" });
  });

  it("forwards the load options and reports the loaded state", async () => {
    const seen: Array<{ model: string; options: Record<string, unknown> }> = [];
    fakes.lmStudio.ensureModelLoaded = async (model, options) => {
      seen.push({ model, options });
      return { alreadyLoaded: true };
    };

    const handler = getFinalHandler(lmStudioRouter, "post", "/load");
    const { res, state } = makeRes();
    await handler(
      makeReq({
        body: {
          model: "qwen",
          context_length: 8192,
          flash_attention: false,
          offload_kv_cache_to_gpu: true,
          eval_batch_size: 512,
          parallel: 2,
          unified_kv_cache: true,
        },
      }) as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.body).toEqual({ model: "qwen", alreadyLoaded: true });
    expect(seen).toEqual([
      {
        model: "qwen",
        options: {
          context_length: 8192,
          flash_attention: false,
          offload_kv_cache_to_gpu: true,
          eval_batch_size: 512,
          parallel: 2,
          unified_kv_cache: true,
        },
      },
    ]);
  });
});

describe("AdminLmStudioRoutes POST /estimate", () => {
  it("requires a model name", async () => {
    const handler = getFinalHandler(lmStudioRouter, "post", "/estimate");
    const { res, state } = makeRes();
    await handler(
      makeReq({ body: {} }) as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(400);
    expect(state.body).toEqual({ error: "Missing 'model' in request body" });
  });

  it("answers 404 for an unknown model", async () => {
    fakes.lmStudio.listModels = async () => ({ models: [{ key: "other" }] });
    const handler = getFinalHandler(lmStudioRouter, "post", "/estimate");
    const { res, state } = makeRes();
    await handler(
      makeReq({ body: { model: "missing" } }) as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(404);
    expect(state.body).toEqual({ error: "Model 'missing' not found" });
  });

  it("estimates memory from the model metadata", async () => {
    fakes.lmStudio.listModels = async () => ({
      models: [
        {
          key: "qwen35",
          size_bytes: 4 * 1024 ** 3,
          quantization: { bits_per_weight: 4 },
          architecture: "qwen35",
          params_string: "8B",
          capabilities: { vision: false },
        },
      ],
    });

    const handler = getFinalHandler(lmStudioRouter, "post", "/estimate");
    const { res, state } = makeRes();
    await handler(
      makeReq({
        body: { model: "qwen35", contextLength: 8192, gpuLayers: 32 },
      }) as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    const body = state.body as {
      totalLayers: number;
      archParams: { layers: number };
      totalGiB?: number;
      weightsGiB?: number;
    };
    expect(body.totalLayers).toBe(body.archParams.layers);
    expect(body.archParams.layers).toBeGreaterThan(0);
    expect(typeof body.totalGiB).toBe("number");
  });
});

// ── AdminContentRoutes ─────────────────────────────────────

import contentRouter from "../admin/AdminContentRoutes.ts";

describe("AdminContentRoutes GET /workflows", () => {
  it("filters workflows through matching conversations", async () => {
    const db = makeDb({
      [COLLECTIONS.MODEL_CONVERSATIONS]: {
        distinct: async (field, filter) => {
          calls.push({ collection: "conversations", method: "distinct", args: [field, filter] });
          return ["conv-1", "conv-2"];
        },
      },
      [COLLECTIONS.WORKFLOWS]: {
        find: (filter) => {
          calls.push({ collection: "workflows", method: "find", args: [filter] });
          return cursor([{ _id: "w1", name: "flow", stepCount: 3 }]);
        },
        countDocuments: async () => 1,
      },
    });

    const handler = getFinalHandler(contentRouter, "get", "/workflows");
    const { res, state } = makeRes();
    await handler(
      makeReq({
        db,
        query: {
          project: "p",
          provider: "openai",
          model: "openai/gpt-4o",
          guildId: "g1",
          userName: "alice",
          from: "2026-01-01",
          to: "2026-01-31",
          limit: "5",
        },
      }) as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.body).toEqual({
      data: [{ _id: "w1", name: "flow", stepCount: 3 }],
      total: 1,
      page: 1,
      limit: 5,
    });

    const convFilter = calls.find((call) => call.collection === "conversations")?.args[1];
    expect(convFilter).toEqual({
      project: "p",
      providers: "openai",
      "messages.model": "openai/gpt-4o",
    });

    const workflowFilter = calls.find((call) => call.collection === "workflows")?.args[0];
    expect(workflowFilter).toMatchObject({
      guildId: "g1",
      userName: { $regex: "alice", $options: "i" },
      createdAt: { $gte: "2026-01-01", $lte: "2026-01-31" },
      conversationIds: { $elemMatch: { $in: ["conv-1", "conv-2"] } },
    });
  });
});

describe("AdminContentRoutes GET /media", () => {
  afterEach(() => {
    calls.length = 0;
  });

  it("merges conversation and agent-generated media", async () => {
    const convItems = [
      {
        url: "https://cdn/a.png",
        mediaType: "image",
        convId: "c1",
        convTitle: null,
        project: "p",
        username: "u",
        role: "user",
        timestamp: "2026-01-01T00:00:00.000Z",
        model: "openai/gpt-4o",
      },
    ];
    const requestItems = [
      {
        url: "https://cdn/b.png",
        mediaType: "image",
        convId: null,
        convTitle: "Agent Generation",
        project: "p",
        username: "u",
        role: "assistant",
        timestamp: "2026-01-02T00:00:00.000Z",
        model: "openai/gpt-4o",
        agent: "lupos",
      },
    ];

    const db = makeDb({
      [COLLECTIONS.MODEL_CONVERSATIONS]: {
        distinct: async (field) => (field === "project" ? ["p"] : ["u"]),
        aggregate: () => ({ toArray: async () => convItems }),
      },
      [COLLECTIONS.REQUESTS]: {
        distinct: async (field) => (field === "project" ? ["p", "other"] : ["u", "z"]),
        aggregate: () => ({ toArray: async () => requestItems }),
      },
    });

    const handler = getFinalHandler(contentRouter, "get", "/media");
    const { res, state } = makeRes();
    await handler(
      makeReq({
        db,
        query: { project: "p", search: "chart", from: "2026-01-01", to: "2026-01-31" },
      }) as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    const body = state.body as {
      data: Array<Record<string, unknown>>;
      total: number;
      projects: string[];
      usernames: string[];
      page: number;
      limit: number;
    };
    expect(body.total).toBe(2);
    expect(body.data.map((item) => item.url)).toEqual([
      "https://cdn/b.png",
      "https://cdn/a.png",
    ]);
    expect(body.data[0]).toMatchObject({ origin: "ai", agent: "lupos" });
    expect(body.data[1]).toMatchObject({ origin: "user", convTitle: "Untitled" });
    expect(body.projects).toEqual(["other", "p"]);
    expect(body.usernames).toEqual(["u", "z"]);
  });
});

describe("AdminContentRoutes GET /text", () => {
  it("maps rows and counts the filtered set", async () => {
    let aggregateCall = 0;
    const db = makeDb({
      [COLLECTIONS.MODEL_CONVERSATIONS]: {
        aggregate: () => {
          const result =
            aggregateCall++ === 0
              ? [{ total: 1 }]
              : [
                  {
                    convId: "c1",
                    convTitle: undefined,
                    project: "p",
                    username: "u",
                    role: "assistant",
                    content: "hello",
                    timestamp: "2026-01-01T00:00:00.000Z",
                    model: "openai/gpt-4o",
                    estimatedCost: 0.02,
                    images: 1,
                  },
                ];
          return { toArray: async () => result };
        },
      },
    });

    const handler = getFinalHandler(contentRouter, "get", "/text");
    const { res, state } = makeRes();
    await handler(
      makeReq({ db, query: { project: "p", origin: "ai", search: "hel", limit: "5" } }) as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.body).toEqual({
      data: [
        {
          content: "hello",
          origin: "ai",
          role: "assistant",
          convId: "c1",
          convTitle: "Untitled",
          project: "p",
          username: "u",
          model: "openai/gpt-4o",
          estimatedCost: 0.02,
          hasImages: true,
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
      total: 1,
      page: 1,
      limit: 5,
    });
  });
});

// ── AdminRequestRoutes ─────────────────────────────────────

import requestRouter from "../admin/AdminRequestRoutes.ts";

describe("AdminRequestRoutes GET /", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("builds the filter from csv params, workspace and date range", async () => {
    const db = makeDb({
      [COLLECTIONS.MODEL_CONVERSATIONS]: {
        find: (filter) => {
          calls.push({ collection: "conversations", method: "find", args: [filter] });
          return cursor([{ id: "conv-1" }]);
        },
      },
      [COLLECTIONS.AGENT_CONVERSATIONS]: {
        find: () => cursor([{ id: "agent-1" }]),
      },
      [COLLECTIONS.REQUESTS]: {
        find: (filter) => {
          calls.push({ collection: "requests", method: "find", args: [filter] });
          return cursor([{ requestId: "r1", success: true }]);
        },
        countDocuments: async () => 1,
      },
    });

    const handler = getFinalHandler(requestRouter, "get", "/");
    const { res, state } = makeRes();
    await handler(
      makeReq({
        db,
        query: {
          project: "p",
          username: "u",
          model: "openai/gpt-4o",
          workspace: "/ws",
          provider: "openai,anthropic",
          endpoint: "/chat,/responses",
          operation: "chat",
          agent: "coding",
          success: "true,false",
          from: "2026-01-01",
          to: "2026-01-31",
          sort: "estimatedCost",
          limit: "20",
        },
      }) as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.body).toEqual({
      data: [{ requestId: "r1", success: true }],
      total: 1,
      page: 1,
      limit: 20,
    });

    const filter = calls.find((call) => call.collection === "requests")?.args[0] as
      Record<string, unknown>;
    expect(filter).toMatchObject({
      project: "p",
      username: "u",
      model: "openai/gpt-4o",
      provider: { $in: ["openai", "anthropic"] },
      endpoint: { $in: ["/chat", "/responses"] },
      operation: "chat",
      agent: "coding",
      success: { $in: [true, false] },
      timestamp: { $gte: "2026-01-01", $lte: "2026-01-31" },
      $or: [
        { conversationId: { $in: ["conv-1"] } },
        { agentConversationId: { $in: ["agent-1"] } },
        { parentAgentConversationId: { $in: ["agent-1"] } },
      ],
    });
  });

  it("maps a single success csv value to a boolean", async () => {
    const db = makeDb({
      [COLLECTIONS.REQUESTS]: {
        find: (filter) => {
          calls.push({ collection: "requests", method: "find", args: [filter] });
          return cursor([]);
        },
        countDocuments: async () => 0,
      },
    });

    const handler = getFinalHandler(requestRouter, "get", "/");
    const { res, state } = makeRes();
    await handler(
      makeReq({ db, query: { success: "false" } }) as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.body).toEqual({ data: [], total: 0, page: 1, limit: expect.any(Number) });
    const filter = calls.find((call) => call.collection === "requests")?.args[0] as
      Record<string, unknown>;
    expect(filter.success).toBe(false);
  });
});

describe("AdminRequestRoutes GET /:id/associations", () => {
  it("answers 404 for an unknown request", async () => {
    const db = makeDb({
      [COLLECTIONS.REQUESTS]: {
        findOne: async () => null,
      },
    });

    const handler = getFinalHandler(requestRouter, "get", "/:id/associations");
    const { res, state } = makeRes();
    await handler(
      makeReq({ params: { id: "missing" }, db }) as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(404);
    expect(state.body).toEqual({ error: "Request not found" });
  });

  it("collects conversations, workflows and trace groups", async () => {
    const db = makeDb({
      [COLLECTIONS.REQUESTS]: {
        findOne: async () => ({ requestId: "r1", conversationId: "conv-1" }),
        aggregate: () => ({
          toArray: async () => [
            {
              _id: "trace-1",
              project: "p",
              username: "u",
              requestCount: 4,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T01:00:00.000Z",
            },
          ],
        }),
      },
      [COLLECTIONS.MODEL_CONVERSATIONS]: {
        find: () => cursor([{ id: "conv-1", title: "Chat", traceId: "trace-1" }]),
      },
      [COLLECTIONS.WORKFLOWS]: {
        find: () => cursor([{ _id: { toString: () => "wf-1" }, name: null }]),
      },
    });

    const handler = getFinalHandler(requestRouter, "get", "/:id/associations");
    const { res, state } = makeRes();
    await handler(
      makeReq({ params: { id: "r1" }, db }) as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.body).toEqual({
      conversations: [{ id: "conv-1", title: "Chat", traceId: "trace-1" }],
      workflows: [
        {
          id: "wf-1",
          name: "Untitled Workflow",
          nodeCount: 0,
          edgeCount: 0,
          source: "prism-client",
        },
      ],
      traces: [
        {
          id: "trace-1",
          project: "p",
          username: "u",
          requestCount: 4,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T01:00:00.000Z",
        },
      ],
    });
  });
});

// ── AdminSystemRoutes ──────────────────────────────────────

import systemRouter from "../admin/AdminSystemRoutes.ts";

describe("AdminSystemRoutes GET /live", () => {
  it("summarises active conversations and recent requests", async () => {
    const db = makeDb({
      [COLLECTIONS.MODEL_CONVERSATIONS]: {
        find: () =>
          cursor([
            {
              id: "c1",
              project: "p",
              username: "u",
              title: "Live",
              updatedAt: "2026-01-01T00:05:00.000Z",
              messages: [
                { role: "user", content: "hi" },
                { role: "assistant", content: [{ type: "text", text: "hello" }] },
              ],
              providers: ["openai"],
              isGenerating: true,
            },
            {
              id: "c2",
              project: "p",
              username: "u",
              title: "Costly",
              updatedAt: "2026-01-01T00:04:00.000Z",
              messages: [{ role: "user", content: [{ type: "image", url: "x" }], estimatedCost: 0.3 }],
            },
          ]),
      },
      [COLLECTIONS.REQUESTS]: {
        find: () => cursor([{ requestId: "r1" }]),
        countDocuments: async () => 10,
      },
    });

    const handler = getFinalHandler(systemRouter, "get", "/live");
    const { res, state } = makeRes();
    await handler(
      makeReq({ db, query: { minutes: "5" } }) as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    const body = state.body as {
      conversations: Array<Record<string, unknown>>;
      recentRequests: unknown[];
      requestsPerMinute: number;
      activeCount: number;
    };
    expect(body.activeCount).toBe(2);
    expect(body.requestsPerMinute).toBe(2);
    expect(body.recentRequests).toEqual([{ requestId: "r1" }]);
    expect(body.conversations[0]).toMatchObject({
      id: "c1",
      messageCount: 2,
      lastMessage: "hello",
      lastMessageRole: "assistant",
      isGenerating: true,
      providers: ["openai"],
    });
    // Cost falls back to the sum of message costs; array content without text is null.
    expect(body.conversations[1]).toMatchObject({
      lastMessage: null,
      lastMessageRole: "user",
      isGenerating: false,
      providers: [],
      totalCost: 0.3,
    });
  });
});

// ── AdminConversationRoutes ────────────────────────────────

import adminConversationRouter from "../admin/AdminConversationRoutes.ts";

describe("AdminConversationRoutes GET /", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("merges direct and agent conversations and enriches them", async () => {
    const db = makeDb({
      [COLLECTIONS.MODEL_CONVERSATIONS]: {
        find: (filter) => {
          calls.push({ collection: "direct", method: "find", args: [filter] });
          return cursor([
            {
              id: "direct-1",
              project: "p",
              username: "u",
              updatedAt: "2026-01-02T00:00:00.000Z",
              totalCost: 0.5,
              messageCount: 2,
            },
          ]);
        },
        countDocuments: async () => 1,
      },
      [COLLECTIONS.AGENT_CONVERSATIONS]: {
        find: (filter) => {
          calls.push({ collection: "agent", method: "find", args: [filter] });
          return cursor([
            {
              id: "agent-1",
              project: "p",
              agent: "coding",
              updatedAt: "2026-01-03T00:00:00.000Z",
              totalCost: 0.2,
              messageCount: 4,
            },
          ]);
        },
        countDocuments: async () => 1,
      },
      [COLLECTIONS.REQUESTS]: {
        find: () =>
          cursor([
            {
              conversationId: "direct-1",
              inputTokens: 10,
              outputTokens: 20,
              model: "openai/gpt-4o",
              tokensPerSec: 40,
              totalTime: 500,
              toolDisplayNames: ["Quote"],
              toolApiNames: ["get_quote"],
              estimatedCost: 0.1,
            },
            {
              agentConversationId: "agent-1",
              inputTokens: 5,
              outputTokens: 5,
              model: "anthropic/sonnet",
              tokensPerSec: 60,
              totalTime: 300,
              estimatedCost: 0.4,
            },
          ]),
      },
    });

    const handler = getFinalHandler(adminConversationRouter, "get", "/");
    const { res, state } = makeRes();
    await handler(
      makeReq({
        db,
        query: {
          project: "p",
          username: "u",
          provider: "openai",
          model: "openai/gpt-4o",
          search: "chat",
          from: "2026-01-01",
          to: "2026-01-31",
          limit: "10",
        },
      }) as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    const body = state.body as {
      data: Array<Record<string, unknown>>;
      total: number;
      page: number;
      limit: number;
    };
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(10);
    expect(body.data.map((item) => item.id)).toEqual(["agent-1", "direct-1"]);

    const agent = body.data[0];
    expect(agent).toMatchObject({
      type: "agent",
      requestCount: 1,
      inputTokens: 5,
      outputTokens: 5,
      totalCost: 0.4,
      avgTokensPerSec: 60,
      totalLatency: 300,
      models: ["anthropic/sonnet"],
    });

    const direct = body.data[1];
    expect(direct).toMatchObject({
      type: "direct",
      requestCount: 1,
      inputTokens: 10,
      outputTokens: 20,
      totalCost: 0.5,
      avgTokensPerSec: 40,
      totalLatency: 500,
      toolDisplayNames: ["Quote"],
      toolApiNames: ["get_quote"],
    });

    const filter = calls.find((call) => call.collection === "direct")?.args[0] as
      Record<string, unknown>;
    expect(filter).toMatchObject({
      project: "p",
      username: "u",
      providers: "openai",
      "messages.model": "openai/gpt-4o",
      updatedAt: { $gte: "2026-01-01", $lte: "2026-01-31" },
    });
    expect(filter.$or).toEqual([
      { title: { $regex: "chat", $options: "i" } },
      { project: { $regex: "chat", $options: "i" } },
      { username: { $regex: "chat", $options: "i" } },
    ]);
  });

  it("limits the list to agent conversations when agent is set", async () => {
    const db = makeDb({
      [COLLECTIONS.AGENT_CONVERSATIONS]: {
        find: () => cursor([]),
        countDocuments: async () => 0,
      },
      [COLLECTIONS.REQUESTS]: {
        find: () => cursor([]),
      },
    });

    const handler = getFinalHandler(adminConversationRouter, "get", "/");
    const { res, state } = makeRes();
    await handler(
      makeReq({ db, query: { agent: "coding" } }) as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.body).toMatchObject({ data: [], total: 0 });
  });
});

