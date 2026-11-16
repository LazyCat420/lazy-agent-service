/**
 * Coverage2 for route handlers whose hot functions had no coverage:
 * Platform tool telemetry, Execute dispatch, Webhook SSE stream and
 * custom agents.
 *
 * Handlers are invoked directly with fake req/res objects (no server), and
 * every service/DB boundary is a deterministic stand-in. Assertions are on
 * the response status/payload or on the boundary call the handler makes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type * as NodeFs from "node:fs";

// ExecuteRoutes appends failures to `data/dlq.jsonl` relative to the cwd; keep
// the suite from writing into the checkout by stubbing that single call.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const actualDefault = actual.default;
  return {
    ...actual,
    default: {
      ...actualDefault,
      promises: {
        ...actualDefault.promises,
        appendFile: vi.fn(async () => undefined),
      },
    },
  };
});

const fakes = vi.hoisted(() => ({
  provider: null as null | Record<string, unknown>,
  providerById: new Map<string, Record<string, unknown>>(),
  isInstance: (id: string) => id === "lm-studio",
  db: null as null | Record<string, unknown>,
  dbCalls: [] as Array<{ collection: string; method: string; args: unknown[] }>,
  orchestrator: {
    active: [] as Array<Record<string, unknown>>,
    descendants: [] as Array<Record<string, unknown>>,
    stopResult: { aborted: 0 } as Record<string, unknown>,
  },
  mongo: {
    collection: null as null | Record<string, unknown>,
  },
  scheduled: {
    listTasks: async () => [] as Array<Record<string, unknown>>,
    listAllTasks: async () => [] as Array<Record<string, unknown>>,
    createTask: null as null | ((task: Record<string, unknown>) => Promise<unknown>),
    updateTask: null as null | ((...args: unknown[]) => Promise<unknown>),
    deleteTask: async () => true,
  },
  experiment: { runExperiment: null as null | ((req: unknown) => Promise<unknown>) },
  memory: {
    store: null as null | ((input: Record<string, unknown>) => Promise<unknown>),
    list: async () => ({ memories: [], total: 0 }),
  },
  embeddings: {
    generate: async () => ({ embedding: [0.1, 0.2], space: "test:2:cosine" }),
  },
  webhookBus: {
    replay: [] as Array<Record<string, unknown>>,
    listenerCount: 2,
    subscribers: [] as Array<(event: Record<string, unknown>) => void>,
    subscribed: [] as Array<(event: Record<string, unknown>) => void>,
  },
  customAgents: {
    list: async () => [],
    create: null as null | ((data: Record<string, unknown>) => Promise<unknown>),
    get: null as null | ((id: string) => Promise<unknown>),
    update: null as null | ((id: string, updates: Record<string, unknown>) => Promise<unknown>),
    remove: async () => true,
  },
  personas: { registered: [] as unknown[], unregistered: [] as string[] },
  dispatch: {
    result: null as unknown,
    error: null as Error | null,
    calls: [] as Array<{ toolName: string; args: Record<string, unknown>; ctx: Record<string, unknown> }>,
  },
  classify: null as null | ((result: unknown) => { success: boolean; errorMessage?: string }),
  chat: {
    sseCalls: [] as Array<{ params: Record<string, unknown>; handler: unknown }>,
    jsonCalls: [] as Array<{ params: Record<string, unknown>; handler: unknown }>,
  },
  localGateway: {
    estimateVRAM: null as null | ((model: unknown, opts: Record<string, unknown>) => unknown),
  },
}));

vi.mock("../../providers/index.ts", () => ({
  getProvider: (id: string) => fakes.providerById.get(id) ?? fakes.provider,
}));

vi.mock("../../providers/instance-registry.ts", () => ({
  isInstance: fakes.isInstance,
}));

vi.mock("../../services/local-provider/index.ts", () => ({
  default: {
    estimateVRAM: (model: unknown, opts: Record<string, unknown>) =>
      fakes.localGateway.estimateVRAM?.(model, opts) ?? null,
  },
}));

vi.mock("../../wrappers/MongoWrapper.ts", () => ({
  default: {
    getDb: () => {
      if (!fakes.db) throw new Error("Database not connected: trading_bot");
      return fakes.db;
    },
    getCollection: () => fakes.mongo.collection,
  },
}));

vi.mock("../../wrappers/MongoWrapper.ts", () => ({
  default: {
    getDb: () => {
      if (!fakes.db) throw new Error("Database not connected: trading_bot");
      return fakes.db;
    },
    getCollection: () => fakes.mongo.collection,
  },
}));

vi.mock("../../services/MemoryService.ts", () => ({
  default: {
    store: (input: Record<string, unknown>) => fakes.memory.store?.(input),
    list: fakes.memory.list,
  },
}));

vi.mock("../../services/MemoryConsolidationService.ts", () => ({
  default: {},
}));

vi.mock("../../services/EmbeddingService.ts", () => ({
  default: { generate: fakes.embeddings.generate },
}));

vi.mock("../../services/WebhookEventBus.ts", () => ({
  default: {
    getReplayBuffer: () => fakes.webhookBus.replay,
    get listenerCount() {
      return fakes.webhookBus.listenerCount;
    },
    subscribe: (handler: (event: Record<string, unknown>) => void) => {
      fakes.webhookBus.subscribed.push(handler);
      fakes.webhookBus.subscribers.push(handler);
    },
    unsubscribe: (handler: (event: Record<string, unknown>) => void) => {
      fakes.webhookBus.subscribers = fakes.webhookBus.subscribers.filter(
        (candidate) => candidate !== handler,
      );
    },
  },
}));

vi.mock("../../services/CustomAgentService.ts", () => ({
  default: {
    list: fakes.customAgents.list,
    create: (data: Record<string, unknown>) => fakes.customAgents.create?.(data),
    get: (id: string) => fakes.customAgents.get?.(id),
    update: (id: string, updates: Record<string, unknown>) =>
      fakes.customAgents.update?.(id, updates),
    delete: fakes.customAgents.remove,
  },
}));

vi.mock("../../services/AgentPersonaRegistry.ts", () => ({
  default: {
    registerCustom: (agent: unknown) => fakes.personas.registered.push(agent),
    unregister: (agentId: string) => fakes.personas.unregistered.push(agentId),
  },
}));

vi.mock("../../services/ToolDispatch.ts", () => ({
  dispatchTool: async (
    toolName: string,
    args: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => {
    fakes.dispatch.calls.push({ toolName, args, ctx });
    if (fakes.dispatch.error) throw fakes.dispatch.error;
    return fakes.dispatch.result;
  },
}));

vi.mock("../../services/ToolResult.ts", () => ({
  classifyToolResult: (result: unknown) =>
    fakes.classify?.(result) ?? { success: true },
}));

vi.mock("../../core/chat/ChatGeneration.ts", () => ({
  handleAgent: "agent-handler",
}));

vi.mock("../ApprovalDecisionRoute.ts", () => ({
  handleApprovalDecision: () => () => undefined,
}));

vi.mock("../QuestionAnswerHandler.ts", () => ({
  handleQuestionAnswer: () => () => undefined,
}));

vi.mock("../../utils/SseUtilities.ts", () => ({
  initSseResponse: (res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
  },
  handleSseRequest: async (
    _req: Request,
    _res: Response,
    params: Record<string, unknown>,
    handler: unknown,
  ) => {
    fakes.chat.sseCalls.push({ params, handler });
  },
  handleJsonRequest: async (
    _req: Request,
    _res: Response,
    _next: NextFunction,
    params: Record<string, unknown>,
    handler: unknown,
  ) => {
    fakes.chat.jsonCalls.push({ params, handler });
  },
}));

// ── Harness helpers ────────────────────────────────────────

interface RouteLayer {
  route?: { path: string; stack: Array<{ method: string; handle: RequestHandler }> };
}

/** Pull a route handler out of an express Router without booting a server. */
const getHandler = (
  router: unknown,
  method: string,
  path: string,
): RequestHandler => {
  // `Router.stack` is an express internal, absent from the public typings.
  const routerWithStack = router as unknown as { stack: RouteLayer[] };
  const layers = routerWithStack.stack.filter(
    (entry) => entry.route?.path === path,
  );
  if (layers.length === 0) throw new Error(`route ${method} ${path} not found`);
  for (const layer of layers) {
    const match = layer.route?.stack.find(
      (entry) => entry.method === method.toLowerCase(),
    );
    if (match) return match.handle;
  }
  throw new Error(`handler ${method} ${path} not found`);
};

/** All handlers on a route, in registration order (middleware first). */
const getRouteHandlers = (
  router: unknown,
  method: string,
  path: string,
): RequestHandler[] => {
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

interface FakeResponseState {
  statusCode: number;
  body: unknown;
  headers: Record<string, string | number>;
  writes: string[];
  ended: boolean;
  sent: boolean;
  finishHandlers: Array<() => void>;
}

const makeRes = () => {
  const state: FakeResponseState = {
    statusCode: 200,
    body: undefined,
    headers: {},
    writes: [],
    ended: false,
    sent: false,
    finishHandlers: [],
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
    getHeader(name: string) {
      return state.headers[name];
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
    on(event: string, handler: () => void) {
      if (event === "finish") state.finishHandlers.push(handler);
      return res;
    },
    get headersSent() {
      return state.sent;
    },
    get destroyed() {
      return state.ended;
    },
    get writableEnded() {
      return state.ended;
    },
    socket: { setNoDelay() {}, uncork() {}, cork() {}, destroyed: false },
  };
  return { res, state };
};

const makeReq = (overrides: Record<string, unknown> = {}) => {
  const closeHandlers: Array<() => void> = [];
  const req = {
    query: {},
    params: {},
    body: {},
    headers: {},
    method: "POST",
    originalUrl: "/test",
    ip: "127.0.0.1",
    on(event: string, handler: () => void) {
      if (event === "close") closeHandlers.push(handler);
      return req;
    },
    ...overrides,
  };
  return { req, closeHandlers };
};

const nextSpy = () => {
  const calls: unknown[] = [];
  const next = ((error?: unknown) => {
    if (error) calls.push(error);
  }) as NextFunction;
  return { next, calls };
};

// ── Platform tool telemetry ────────────────────────────────

import platformRouter from "../PlatformRoutes.ts";

interface PlatformDoc {
  _id: string;
  total_calls?: number;
  success_count?: number;
  failure_count?: number;
  avg_ms?: number;
  last_called?: string | Date | null;
  last_error?: string | null;
  sources?: string[];
}

const platformDb = (
  statsDocs: PlatformDoc[],
  recentDocs: Array<Record<string, unknown>>,
) => ({
  collection: (name: string) => ({
    aggregate: (pipeline: unknown[]) => {
      fakes.dbCalls.push({ collection: name, method: "aggregate", args: [pipeline] });
      return { toArray: async () => statsDocs };
    },
    find: (match: Record<string, unknown>, options: Record<string, unknown>) => {
      fakes.dbCalls.push({ collection: name, method: "find", args: [match, options] });
      return { toArray: async () => recentDocs };
    },
  }),
});

const statsDocs: PlatformDoc[] = [
  {
    _id: "mcp__lazy-agent-service__canvas_add_widget",
    total_calls: 2,
    success_count: 1,
    failure_count: 1,
    avg_ms: 10,
    last_called: "2026-01-01T00:00:00.000Z",
    last_error: "first error",
    sources: ["a"],
  },
  {
    _id: "canvas_add_widget",
    total_calls: 3,
    success_count: 3,
    failure_count: 0,
    avg_ms: 20,
    last_called: "2026-01-02T00:00:00.000Z",
    sources: ["b", "a"],
  },
  { _id: "ghost_tool" },
];

describe("PlatformRoutes /stats", () => {
  beforeEach(() => {
    fakes.dbCalls.length = 0;
    fakes.db = platformDb(statsDocs, []);
  });
  afterEach(() => {
    fakes.db = null;
  });

  it("folds prefixed and bare spellings into one canonical row", async () => {
    const handler = getHandler(platformRouter, "get", "/stats");
    const { res, state } = makeRes();
    await handler(
      makeReq({ query: {} }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    const body = state.body as {
      hours: number;
      total_calls: number;
      tools: Array<Record<string, unknown>>;
    };
    expect(body.hours).toBe(24);
    expect(body.total_calls).toBe(5);

    const canvas = body.tools.find((row) => row.canonical_name === "canvas_add_widget");
    expect(canvas).toMatchObject({
      tool_name: "canvas_add_widget",
      total_calls: 5,
      success_count: 4,
      failure_count: 1,
      avg_ms: 16,
      last_called: "2026-01-02T00:00:00.000Z",
      last_error: "first error",
      sources: ["a", "b"],
      owner_app: "html-notes",
      in_registry: true,
      success_rate: 0.8,
      avg_latency_ms: 16,
    });

    const ghost = body.tools.find((row) => row.canonical_name === "ghost_tool");
    expect(ghost).toMatchObject({
      total_calls: 0,
      success_rate: 1,
      owner_app: "shared",
      in_registry: false,
    });
  });

  it("applies the owner_app filter and service window", async () => {
    const handler = getHandler(platformRouter, "get", "/stats");
    const { res, state } = makeRes();
    await handler(
      makeReq({
        query: { owner_app: "html-notes", service: "lazy-agent-service", hours: "9999" },
      }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    const body = state.body as { hours: number; tools: Array<Record<string, unknown>> };
    expect(body.hours).toBe(168); // clamped
    expect(body.tools.length).toBeGreaterThan(0);
    expect(body.tools.every((row) => row.owner_app === "html-notes")).toBe(true);

    const pipeline = fakes.dbCalls[0].args[0] as Array<Record<string, unknown>>;
    expect(pipeline[0]).toMatchObject({
      $match: { service_source: "lazy-agent-service" },
    });
  });

  it("answers 503 when the trading database is not registered", async () => {
    fakes.db = null;
    const handler = getHandler(platformRouter, "get", "/stats");
    const { res, state } = makeRes();
    await handler(
      makeReq({ query: {} }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(503);
    expect(state.body).toMatchObject({ hint: expect.stringContaining("MONGO_URI") });
  });
});

describe("PlatformRoutes /recent", () => {
  beforeEach(() => {
    fakes.dbCalls.length = 0;
  });
  afterEach(() => {
    fakes.db = null;
  });

  it("lists recent calls with canonical names and filters", async () => {
    fakes.db = platformDb([], [
      {
        id: "row-1",
        tool_name: "mcp__lazy-agent-service__canvas_add_widget",
        agent_name: "coding",
        cycle_id: "cycle-1",
        service_source: "lazy-agent-service",
        execution_ms: 12,
        success: false,
        error_message: "boom",
        args_hash: "abc",
        was_blocked: false,
        called_at: "2026-01-03T00:00:00.000Z",
      },
    ]);

    const handler = getHandler(platformRouter, "get", "/recent");
    const { res, state } = makeRes();
    await handler(
      makeReq({
        query: { limit: "500", tool: "canvas", failures_only: "true" },
      }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.body).toEqual({
      limit: 200, // clamped
      total: 1,
      calls: [
        {
          id: "row-1",
          tool_name: "mcp__lazy-agent-service__canvas_add_widget",
          canonical_name: "canvas_add_widget",
          agent_name: "coding",
          cycle_id: "cycle-1",
          service_source: "lazy-agent-service",
          execution_ms: 12,
          success: false,
          error_message: "boom",
          args_hash: "abc",
          was_blocked: false,
          called_at: "2026-01-03T00:00:00.000Z",
        },
      ],
    });

    const [match, options] = fakes.dbCalls[0].args as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(match).toMatchObject({
      service_source: { $ne: "probe" },
      tool_name: { $regex: "canvas", $options: "i" },
      success: false,
    });
    expect(options).toEqual({ sort: { called_at: -1 }, limit: 200 });
  });
});

// ── Platform failure storms ────────────────────────────────

describe("PlatformRoutes /storms", () => {
  beforeEach(() => {
    fakes.dbCalls.length = 0;
  });
  afterEach(() => {
    fakes.db = null;
  });

  it("groups consecutive failures per agent, cycle and tool", async () => {
    const docs = [
      {
        tool_name: "mcp__lazy-agent-service__get_quote",
        agent_name: "trader",
        cycle_id: "cycle-1",
        service_source: "lazy-agent-service",
        success: false,
        error_message: "timeout",
        called_at: "2026-01-01T00:00:00.000Z",
      },
      {
        tool_name: "mcp__lazy-agent-service__get_quote",
        agent_name: "trader",
        cycle_id: "cycle-1",
        service_source: "lazy-agent-service",
        success: false,
        error_message: "timeout again",
        called_at: "2026-01-01T00:00:30.000Z",
      },
      {
        tool_name: "mcp__lazy-agent-service__get_quote",
        agent_name: "trader",
        cycle_id: "cycle-1",
        service_source: "lazy-agent-service",
        success: true,
        called_at: "2026-01-01T00:01:00.000Z",
      },
      {
        tool_name: "mcp__lazy-agent-service__get_quote",
        agent_name: "trader",
        cycle_id: "cycle-2",
        service_source: "lazy-agent-service",
        success: false,
        error_message: "single failure",
        called_at: "2026-01-01T00:02:00.000Z",
      },
    ];
    fakes.db = {
      collection: () => ({
        find: () => ({ toArray: async () => docs }),
      }),
    };

    const handler = getHandler(platformRouter, "get", "/storms");
    const { res, state } = makeRes();
    await handler(
      makeReq({ query: { hours: "12", min_failures: "2" } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.body).toEqual({
      hours: 12,
      min_failures: 2,
      total_storms: 1,
      storms: [
        {
          tool_name: "get_quote",
          agent_name: "trader",
          cycle_id: "cycle-1",
          service_source: "lazy-agent-service",
          failures: 2,
          first_failure: "2026-01-01T00:00:00.000Z",
          last_failure: "2026-01-01T00:00:30.000Z",
          span_seconds: 30,
          last_error: "timeout again",
        },
      ],
    });
  });

  it("answers 503 when the trading database is not registered", async () => {
    fakes.db = null;
    const handler = getHandler(platformRouter, "get", "/storms");
    const { res, state } = makeRes();
    await handler(
      makeReq({ query: {} }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(503);
  });
});

// ── Execute route ──────────────────────────────────────────

import executeRouter from "../ExecuteRoutes.ts";
import { TOOL_CONTEXT_ARG, signToolContext } from "../../services/TradingToolContext.ts";

const executeHandler = () => {
  const handlers = getRouteHandlers(executeRouter, "post", "/:toolName");
  return handlers[handlers.length - 1];
};

describe("ExecuteRoutes POST /:toolName", () => {
  beforeEach(() => {
    fakes.dispatch.calls.length = 0;
    fakes.dispatch.error = null;
    fakes.dispatch.result = { ok: true };
    fakes.classify = () => ({ success: true });
    process.env.TRADING_TOOL_CONTEXT_KEY = "test-signing-key";
  });
  afterEach(() => {
    delete process.env.TRADING_TOOL_CONTEXT_KEY;
  });

  it("refuses tools outside the conversation whitelist", async () => {
    const handler = executeHandler();
    const { res, state } = makeRes();
    await handler(
      makeReq({
        params: { toolName: "delete_everything" },
        headers: { "x-conversation-id": "conv-1" },
        body: {},
      }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.body).toMatchObject({
      success: false,
      error: "PERMISSION_DENIED",
    });
    expect((state.body as { message: string }).message).toContain("delete_everything");
    expect(fakes.dispatch.calls).toEqual([]);
  });

  it("dispatches an allowed tool and returns its result", async () => {
    fakes.dispatch.result = { quotes: [1, 2] };
    fakes.classify = () => ({ success: true });
    const handler = executeHandler();
    const { res, state } = makeRes();
    await handler(
      makeReq({
        params: { toolName: "get_quote" },
        headers: { "x-agent": "trader", "x-ticker": "AAPL", "x-project": "p" },
        body: { arguments: { symbol: "AAPL" } },
      }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.body).toEqual({ quotes: [1, 2] });
    expect(fakes.dispatch.calls).toEqual([
      {
        toolName: "get_quote",
        args: { symbol: "AAPL" },
        ctx: { agentName: "trader", cycleId: "", ticker: "AAPL", project: "p", transport: "rest" },
      },
    ]);
  });

  it("passes gated widget refusals straight through", async () => {
    const gated = { success: false, error: "PLANNING_REQUIRED" };
    fakes.dispatch.result = gated;
    const handler = executeHandler();
    const { res, state } = makeRes();
    await handler(
      makeReq({ params: { toolName: "canvas_add_widget" }, body: {} }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.body).toEqual(gated);
  });

  it("answers 500 and reports failures when dispatch throws", async () => {
    fakes.dispatch.error = new Error("tool exploded");
    const handler = executeHandler();
    const { res, state } = makeRes();
    await handler(
      makeReq({ params: { toolName: "get_quote" }, body: {} }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(500);
    expect(state.body).toEqual({ error: "tool exploded", code: 500 });
  });

  it("uses the signed trading capability instead of headers", async () => {
    const token = signToolContext({
      project: "vllm-trading-bot",
      agentName: "signed-agent",
      cycleId: "cycle-7",
      ticker: "MSFT",
      conversationId: "conv-7",
      allowedTools: ["get_quote"],
      expiresAt: Date.now() + 60_000,
    });

    const handler = executeHandler();
    const { res } = makeRes();
    await handler(
      makeReq({
        params: { toolName: "get_quote" },
        headers: { "x-agent": "spoofed" },
        body: { arguments: { [TOOL_CONTEXT_ARG]: token, symbol: "MSFT" } },
      }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(fakes.dispatch.calls[0].ctx).toMatchObject({
      agentName: "signed-agent",
      cycleId: "cycle-7",
      ticker: "MSFT",
    });
  });

  it("falls back to the refusal when the capability is invalid", async () => {
    const handler = executeHandler();
    const { res } = makeRes();
    await handler(
      makeReq({
        params: { toolName: "get_quote" },
        headers: { "x-agent": "header-agent", "x-conversation-id": "conv-h" },
        body: { arguments: { [TOOL_CONTEXT_ARG]: "bogus.token", ticker: "TSLA" } },
      }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(fakes.dispatch.calls[0].ctx).toMatchObject({
      agentName: "header-agent",
      cycleId: "conv-h",
      ticker: "TSLA",
    });
  });
});

// ── Webhook routes ─────────────────────────────────────────

import webhookRouter from "../WebhookRoutes.ts";

const sseEvent = (eventType: string, data: Record<string, unknown> = {}) => ({
  eventType,
  timestamp: "2026-01-01T00:00:00.000Z",
  data: { agent: "coding", provider: "openai", project: "p", ...data },
});

const parseWrites = (writes: string[]) =>
  writes
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.replace(/^data: /, "").trim()) as Record<string, unknown>);

describe("WebhookRoutes GET /requests/stream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakes.webhookBus.subscribers = [];
    fakes.webhookBus.subscribed = [];
    fakes.webhookBus.replay = [];
    fakes.webhookBus.listenerCount = 2;
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("replays matching events, forwards live ones and pings", async () => {
    fakes.webhookBus.replay = [
      sseEvent("agent_start"),
      sseEvent("agent_start", { agent: "other" }),
      sseEvent("model_end"),
    ];

    const handler = getHandler(webhookRouter, "get", "/requests/stream");
    const { req, closeHandlers } = makeReq({
      query: { agent: "coding", events: "agent_start,*", since: "cursor-1" },
    });
    const { res, state } = makeRes();
    await handler(req as unknown as Request, res as unknown as Response, nextSpy().next);

    expect(state.headers["Content-Type"]).toBe("text/event-stream");
    const writes = parseWrites(state.writes);
    expect(writes[0]).toEqual(sseEvent("agent_start"));
    expect(writes[1]).toEqual(sseEvent("model_end"));
    expect(writes[2]).toMatchObject({ type: "connected", listenerCount: 3 });
    expect(writes).toHaveLength(3);

    // Live event that matches the agent filter.
    fakes.webhookBus.subscribers[0](sseEvent("agent_start"));
    // Live event filtered out by agent.
    fakes.webhookBus.subscribers[0](sseEvent("agent_start", { agent: "other" }));
    const afterLive = parseWrites(state.writes);
    expect(afterLive).toHaveLength(4);
    expect(afterLive[3]).toEqual(sseEvent("agent_start"));

    vi.advanceTimersByTime(60_000);
    expect(state.writes.filter((chunk) => chunk === ": ping\n\n").length).toBeGreaterThan(0);

    closeHandlers.forEach((fn) => fn());
    expect(fakes.webhookBus.subscribers).toHaveLength(0);
    const pingCount = state.writes.filter((chunk) => chunk === ": ping\n\n").length;
    vi.advanceTimersByTime(60_000);
    expect(state.writes.filter((chunk) => chunk === ": ping\n\n")).toHaveLength(pingCount);
  });

  it("applies provider and project filters", async () => {
    const handler = getHandler(webhookRouter, "get", "/requests/stream");
    const { req, closeHandlers } = makeReq({
      query: { provider: "openai", project: "p" },
    });
    const { res, state } = makeRes();
    await handler(req as unknown as Request, res as unknown as Response, nextSpy().next);

    const subscriber = fakes.webhookBus.subscribers[0];
    subscriber(sseEvent("model_end"));
    subscriber(sseEvent("model_end", { provider: "anthropic" }));
    subscriber(sseEvent("model_end", { project: "other" }));

    expect(parseWrites(state.writes).filter((event) => event.type !== "connected")).toHaveLength(1);
    closeHandlers.forEach((fn) => fn());
  });
});

// ── Custom agents ──────────────────────────────────────────

import customAgentsRouter from "../CustomAgentsRoutes.ts";

describe("CustomAgentsRoutes GET / (trusted-peer fallback)", () => {
  const handlers = () => getRouteHandlers(customAgentsRouter, "get", "/");
  const readReq = (ip: string) =>
    makeReq({ method: "GET", originalUrl: "/custom-agents", ip, get: () => undefined }).req as unknown as Request;

  it("serves the list to a trusted peer that presents no token [A9]", async () => {
    const { res, state } = makeRes();
    const nextCalls: unknown[] = [];
    await handlers()[0](readReq("127.0.0.1"), res as unknown as Response, (error?: unknown) => {
      nextCalls.push(error);
    });
    expect(nextCalls).toEqual([undefined]);
    await handlers().at(-1)!(readReq("127.0.0.1"), res as unknown as Response, nextSpy().next);
    expect(state.statusCode).toBe(200);
    // The mocked service returns its default empty list; reaching it proves the fallback passed.
    expect(state.body).toEqual([]);
  });

  it("rejects an untrusted peer that presents no token", async () => {
    const { res, state } = makeRes();
    await handlers()[0](readReq("10.0.0.99"), res as unknown as Response, nextSpy().next);
    expect(state.statusCode).toBe(401);
    expect(state.body).toEqual({ error: { code: "RUNTIME_UNAUTHORIZED" } });
  });
});

describe("CustomAgentsRoutes PUT /:id", () => {
  beforeEach(() => {
    fakes.personas.registered.length = 0;
    fakes.personas.unregistered.length = 0;
  });

  /** Middleware first, route handler last: auth is the gate, these tests drive the body. */
  const handlers = () => getRouteHandlers(customAgentsRouter, "put", "/:id");
  const handler = () => handlers().at(-1)!;

  it("fails closed without a runtime secret and rejects a missing token [A9]", async () => {
    for (const name of ["RUNTIME_API_TOKEN", "RUNTIME_AUTH_SECRET", "INTERNAL_EXECUTE_TOKEN"]) vi.stubEnv(name, "");
    const unconfigured = makeRes();
    await handlers()[0](
      makeReq({ params: { id: "a1" }, body: { name: "x" }, get: () => undefined }).req as unknown as Request,
      unconfigured.res as unknown as Response,
      nextSpy().next,
    );
    expect(unconfigured.state.statusCode).toBe(503);

    vi.stubEnv("RUNTIME_API_TOKEN", "routes-coverage-runtime-token");
    try {
      const unauthenticated = makeRes();
      await handlers()[0](
        makeReq({ params: { id: "a1" }, body: { name: "x" }, get: () => undefined }).req as unknown as Request,
        unauthenticated.res as unknown as Response,
        nextSpy().next,
      );
      expect(unauthenticated.state.statusCode).toBe(401);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a non-object body", async () => {
    const { res, state } = makeRes();
    await handler()(
      makeReq({ params: { id: "a1" }, body: null }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(400);
    expect(state.body).toEqual({ error: "Request body must be an object" });
  });

  it("answers 404 for an unknown agent", async () => {
    fakes.customAgents.get = async () => null;
    const { res, state } = makeRes();
    await handler()(
      makeReq({ params: { id: "a1" }, body: { description: "x" } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(404);
    expect(state.body).toEqual({ error: "Agent not found" });
  });

  it("re-registers the persona when the agentId changes", async () => {
    fakes.customAgents.get = async () => ({ id: "a1", agentId: "old-agent" });
    const updated = { id: "a1", agentId: "new-agent", name: "Renamed" };
    fakes.customAgents.update = async () => updated;

    const { res, state } = makeRes();
    await handler()(
      makeReq({ params: { id: "a1" }, body: { name: "Renamed" } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.body).toEqual(updated);
    expect(fakes.personas.unregistered).toEqual(["old-agent"]);
    expect(fakes.personas.registered).toEqual([updated]);
  });

  it("keeps the registration when the agentId is unchanged", async () => {
    fakes.customAgents.get = async () => ({ id: "a1", agentId: "same-agent" });
    const updated = { id: "a1", agentId: "same-agent", enabled: false };
    fakes.customAgents.update = async () => updated;

    const { res, state } = makeRes();
    await handler()(
      makeReq({ params: { id: "a1" }, body: { enabled: false } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.body).toEqual(updated);
    expect(fakes.personas.unregistered).toEqual([]);
    expect(fakes.personas.registered).toEqual([updated]);
  });

  it("maps duplicate names to 409", async () => {
    fakes.customAgents.get = async () => ({ id: "a1", agentId: "a1" });
    fakes.customAgents.update = async () => {
      throw new Error("Agent with that name already exists");
    };
    const { res, state } = makeRes();
    await handler()(
      makeReq({ params: { id: "a1" }, body: { name: "dup" } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(409);
    expect(state.body).toEqual({ error: "Agent with that name already exists" });
  });
});

