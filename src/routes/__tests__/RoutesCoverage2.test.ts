/**
 * Coverage2 for route handlers whose hot functions had no coverage:
 * LM Studio load/unload/stream, Platform tool telemetry, Orchestrator
 * sub-agents, Skills/Rules updates, Execute dispatch, Experiment runs,
 * Text/Media listings, ScheduledTasks creation, agent memories, webhooks,
 * conversation execution, custom agents and VRAM benchmark machines.
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
  prism: { allowed: true },
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

vi.mock("../../services/OrchestratorService.ts", () => ({
  default: {
    listSubAgents: () => fakes.orchestrator.active,
    listAllDescendantSubAgents: () => fakes.orchestrator.descendants,
    abortSubAgentsByConversation: async () => fakes.orchestrator.stopResult,
    getSubAgentStatus: () => null,
  },
}));

vi.mock("../../services/ScheduledTaskService.ts", () => ({
  default: {
    listTasks: fakes.scheduled.listTasks,
    listAllTasks: fakes.scheduled.listAllTasks,
    createTask: (task: Record<string, unknown>) =>
      fakes.scheduled.createTask?.(task),
    updateTask: (...args: unknown[]) => fakes.scheduled.updateTask?.(...args),
    deleteTask: fakes.scheduled.deleteTask,
  },
}));

vi.mock("../../services/ExperimentService.ts", () => ({
  ExperimentService: {
    runExperiment: (req: unknown) => fakes.experiment.runExperiment?.(req),
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

vi.mock("../../services/prism/PrismProxyService.ts", () => ({
  PrismProxyService: {
    isToolAllowed: () => fakes.prism.allowed,
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

/** The last handler on a route (skipping middleware such as requireDb). */
const getFinalHandler = (
  router: unknown,
  method: string,
  path: string,
): RequestHandler => {
  const handlers = getRouteHandlers(router, method, path);
  return handlers[handlers.length - 1];
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

// ── LM Studio routes ───────────────────────────────────────

import lmStudioRouter from "../LmStudioRoutes.ts";

const lmProvider = () => ({
  listModels: async () => ({
    models: [
      { key: "loaded-model", loaded_instances: [{ id: "inst-loaded" }] },
      { key: "cold-model", loaded_instances: [] },
    ],
  }),
  ensureModelLoaded: async (model: string) => ({ alreadyLoaded: model === "loaded-model" }),
  unloadModel: async () => undefined,
  loadModel: async () => undefined,
});

describe("LmStudioRoutes /load", () => {
  beforeEach(() => {
    fakes.providerById.clear();
    fakes.providerById.set("lm-studio", lmProvider());
  });

  it("rejects a body without a model", async () => {
    const handler = getHandler(lmStudioRouter, "post", "/load");
    const { req } = makeReq({ body: {} });
    const { res, state } = makeRes();
    await handler(req as unknown as Request, res as unknown as Response, nextSpy().next);
    expect(state.statusCode).toBe(400);
    expect(state.body).toEqual({ error: "Missing 'model' in request body" });
  });

  it("reports whether the model was already loaded", async () => {
    const handler = getHandler(lmStudioRouter, "post", "/load");
    const { res, state } = makeRes();
    await handler(
      makeReq({ body: { model: "loaded-model" } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.body).toEqual({ model: "loaded-model", alreadyLoaded: true });
  });

  it("loads a cold model with its options", async () => {
    const seen: Array<{ model: string; options: Record<string, unknown> }> = [];
    const provider = lmProvider();
    provider.ensureModelLoaded = async (model: string, options: Record<string, unknown>) => {
      seen.push({ model, options });
      return { alreadyLoaded: false };
    };
    fakes.providerById.set("lm-studio", provider);

    const handler = getHandler(lmStudioRouter, "post", "/load");
    const { res, state } = makeRes();
    await handler(
      makeReq({
        body: {
          model: "cold-model",
          context_length: 8192,
          flash_attention: true,
          parallel: 2,
          unified_kv_cache: false,
        },
      }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.body).toEqual({ model: "cold-model", alreadyLoaded: false });
    expect(seen).toEqual([
      {
        model: "cold-model",
        options: {
          context_length: 8192,
          flash_attention: true,
          parallel: 2,
          unified_kv_cache: false,
        },
      },
    ]);
  });
});

describe("LmStudioRoutes /load-stream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakes.providerById.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a body without a model", async () => {
    const handler = getHandler(lmStudioRouter, "post", "/load-stream");
    const { res, state } = makeRes();
    await handler(
      makeReq({ body: {} }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(400);
  });

  it("streams progress and completion for a cold model", async () => {
    const provider = lmProvider();
    const deferred = Promise.withResolvers<void>();
    provider.loadModel = () => deferred.promise;
    fakes.providerById.set("lm-studio", provider);

    const handler = getHandler(lmStudioRouter, "post", "/load-stream");
    const { req } = makeReq({ body: { model: "cold-model" } });
    const { res, state } = makeRes();

    const running = handler(
      req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    await vi.advanceTimersByTimeAsync(1200);
    deferred.resolve();
    await vi.advanceTimersByTimeAsync(400);
    await running;

    const events = state.writes.map((line) =>
      JSON.parse(line.replace(/^data: /, "")),
    );
    expect(events[0]).toEqual({ type: "start", model: "cold-model" });
    expect(events.some((event) => event.type === "progress")).toBe(true);
    expect(events.some((event) => event.type === "complete")).toBe(true);
    expect(state.ended).toBe(true);
  });

  it("skips loading when the model is already loaded", async () => {
    fakes.providerById.set("lm-studio", lmProvider());
    const handler = getHandler(lmStudioRouter, "post", "/load-stream");
    const { res, state } = makeRes();
    await handler(
      makeReq({ body: { model: "loaded-model" } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    const events = state.writes.map((line) =>
      JSON.parse(line.replace(/^data: /, "")),
    );
    expect(events).toEqual([
      { type: "start", model: "loaded-model" },
      { type: "progress", progress: 1 },
      { type: "complete", alreadyLoaded: true },
    ]);
    expect(state.ended).toBe(true);
  });

  it("emits an error event when the load fails", async () => {
    const provider = lmProvider();
    provider.loadModel = async () => {
      throw new Error("out of memory");
    };
    fakes.providerById.set("lm-studio", provider);

    const handler = getHandler(lmStudioRouter, "post", "/load-stream");
    const { res, state } = makeRes();
    const running = handler(
      makeReq({ body: { model: "cold-model" } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    await vi.advanceTimersByTimeAsync(600);
    await running;

    const events = state.writes.map((line) =>
      JSON.parse(line.replace(/^data: /, "")),
    );
    expect(events).toContainEqual({ type: "error", message: "out of memory" });
    expect(state.ended).toBe(true);
  });

  it("stops when the client disconnects", async () => {
    const provider = lmProvider();
    const deferred = Promise.withResolvers<void>();
    provider.loadModel = () => deferred.promise;
    fakes.providerById.set("lm-studio", provider);

    const handler = getHandler(lmStudioRouter, "post", "/load-stream");
    const { req, closeHandlers } = makeReq({ body: { model: "cold-model" } });
    const { res, state } = makeRes();
    const running = handler(
      req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    await vi.advanceTimersByTimeAsync(10);
    closeHandlers.forEach((handlerFn) => handlerFn());
    await vi.advanceTimersByTimeAsync(400);
    deferred.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await running;

    const events = state.writes.map((line) =>
      JSON.parse(line.replace(/^data: /, "")),
    );
    expect(events.some((event) => event.type === "complete")).toBe(false);
    expect(state.ended).toBe(true);
  });
});

describe("LmStudioRoutes /unload", () => {
  beforeEach(() => {
    fakes.providerById.clear();
    fakes.providerById.set("lm-studio", lmProvider());
  });

  it("requires instance_id", async () => {
    const handler = getHandler(lmStudioRouter, "post", "/unload");
    const { res, state } = makeRes();
    await handler(
      makeReq({ body: {} }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(400);
    expect(state.body).toEqual({ error: "Missing 'instance_id' in request body" });
  });

  it("unloads the instance", async () => {
    const handler = getHandler(lmStudioRouter, "post", "/unload");
    const { res, state } = makeRes();
    await handler(
      makeReq({ body: { instance_id: "inst-1" } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.body).toEqual({ success: true, instance_id: "inst-1" });
  });
});

describe("LmStudioRoutes /estimate", () => {
  beforeEach(() => {
    fakes.providerById.clear();
    fakes.providerById.set("lm-studio", lmProvider());
    fakes.localGateway.estimateVRAM = () => ({ totalGiB: 7.5 });
  });
  afterEach(() => {
    fakes.localGateway.estimateVRAM = null;
  });

  const handler = () => getHandler(lmStudioRouter, "post", "/estimate");

  it("requires a model name", async () => {
    const { res, state } = makeRes();
    await handler()(
      makeReq({ body: {} }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(400);
    expect(state.body).toEqual({ error: "Missing 'model' in request body" });
  });

  it("answers 404 for an unknown model", async () => {
    const { res, state } = makeRes();
    await handler()(
      makeReq({ body: { model: "missing" } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(404);
    expect(state.body).toEqual({ error: "Model 'missing' not found" });
  });

  it("delegates the estimate to the local provider gateway", async () => {
    const seen: Array<{ model: Record<string, unknown>; options: Record<string, unknown> }> = [];
    fakes.localGateway.estimateVRAM = (model, options) => {
      seen.push({ model, options });
      return { totalGiB: 7.5 };
    };
    const provider = lmProvider();
    provider.listModels = async () => ({ models: [{ key: "loaded-model", size_bytes: 1024 }] });
    fakes.providerById.set("lm-studio", provider);

    const { res, state } = makeRes();
    await handler()(
      makeReq({
        body: {
          model: "loaded-model",
          contextLength: 8192,
          gpuLayers: 24,
          flashAttention: false,
          offloadKvCache: false,
        },
      }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.body).toEqual({ totalGiB: 7.5 });
    expect(seen[0]).toEqual({
      model: { key: "loaded-model", size_bytes: 1024 },
      options: {
        contextLength: 8192,
        gpuLayers: 24,
        flashAttention: false,
        offloadKvCache: false,
      },
    });
  });

  it("answers 400 when the gateway cannot estimate", async () => {
    fakes.localGateway.estimateVRAM = () => null;
    const provider = lmProvider();
    provider.listModels = async () => ({ models: [{ key: "loaded-model" }] });
    fakes.providerById.set("lm-studio", provider);

    const { res, state } = makeRes();
    await handler()(
      makeReq({ body: { model: "loaded-model" } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(400);
    expect(state.body).toEqual({ error: "Could not estimate VRAM for this model" });
  });
});

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

// ── Orchestrator sub-agents ────────────────────────────────

import orchestratorRouter from "../OrchestratorRoutes.ts";

const orchestratorCollection = (children: Array<Record<string, unknown>>) => ({
  findOne: async () => ({
    id: "conv-root",
    agentConversationId: "agent-root",
    subAgents: [{ agentId: "persisted-root", description: "root worker" }],
  }),
  find: () => ({
    toArray: async () => children,
  }),
});

describe("OrchestratorRoutes /sub-agents", () => {
  beforeEach(() => {
    fakes.orchestrator.descendants = [];
    fakes.orchestrator.active = [];
  });

  it("merges persisted descendants with live sub-agents", async () => {
    fakes.mongo.collection = orchestratorCollection([
      {
        id: "child-1",
        agentConversationId: "agent-child-1",
        subAgents: [{ agentId: "persisted-child", description: "child worker" }],
      },
    ]);
    fakes.orchestrator.descendants = [
      { agentId: "persisted-root", description: "live root", status: "running" },
      { agentId: "live-only", description: "live only", status: "running" },
    ];

    const handler = getHandler(orchestratorRouter, "get", "/sub-agents");
    const { res, state } = makeRes();
    await handler(
      makeReq({ query: { conversationId: "conv-root" } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    const body = state.body as { subAgents: Array<Record<string, unknown>> };
    expect(body.subAgents.map((agent) => agent.agentId).sort()).toEqual([
      "live-only",
      "persisted-child",
      "persisted-root",
    ]);
    // Live state wins over the persisted snapshot.
    const root = body.subAgents.find((agent) => agent.agentId === "persisted-root");
    expect(root?.description).toBe("live root");
  });

  it("falls back to the active list when persistence is unavailable", async () => {
    fakes.mongo.collection = null;
    fakes.orchestrator.descendants = [
      { agentId: "active-1", description: "active worker" },
    ];

    const handler = getHandler(orchestratorRouter, "get", "/sub-agents");
    const { res, state } = makeRes();
    await handler(
      makeReq({ query: { conversationId: "conv-root" } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.body).toEqual({
      subAgents: [{ agentId: "active-1", description: "active worker" }],
    });
  });

  it("lists active sub-agents without a conversation filter", async () => {
    fakes.orchestrator.active = [{ agentId: "active-2" }];
    const handler = getHandler(orchestratorRouter, "get", "/sub-agents");
    const { res, state } = makeRes();
    await handler(
      makeReq({ query: {} }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.body).toEqual({ subAgents: [{ agentId: "active-2" }] });
  });
});

// ── Skills / Rules updates ─────────────────────────────────

import skillsRouter from "../SkillsRoutes.ts";
import rulesRouter from "../RulesRoutes.ts";
import { ObjectId } from "mongodb";

const idOf = () => new ObjectId().toString();

const skillDb = (current: Record<string, unknown> | null, updated: Record<string, unknown> | null) => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const collection = {
    findOne: async (...args: unknown[]) => {
      calls.push({ method: "findOne", args });
      return current;
    },
    findOneAndUpdate: async (...args: unknown[]) => {
      calls.push({ method: "findOneAndUpdate", args });
      return updated;
    },
  };
  return { db: { collection: () => collection }, calls };
};

describe("SkillsRoutes PUT /:id", () => {
  it("rejects an empty name", async () => {
    const { db } = skillDb(null, null);
    const handler = getHandler(skillsRouter, "put", "/:id");
    const { next, calls } = nextSpy();
    const { res } = makeRes();
    await handler(
      makeReq({ params: { id: idOf() }, body: { name: "" }, db }).req as unknown as Request,
      res as unknown as Response,
      next,
    );
    expect(calls).toHaveLength(1);
    expect((calls[0] as Error).name).toBe("ZodError");
  });

  it("regenerates the embedding when content changes", async () => {
    const id = idOf();
    const { db, calls } = skillDb(
      { name: "old", description: "d", content: "old content" },
      { _id: new ObjectId(id), name: "new", description: "d", content: "new content" },
    );

    const handler = getHandler(skillsRouter, "put", "/:id");
    const { res, state } = makeRes();
    await handler(
      makeReq({
        params: { id },
        body: { content: "new content" },
        db,
      }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    const updateCall = calls.find((call) => call.method === "findOneAndUpdate");
    expect(updateCall).toBeTruthy();
    const set = (updateCall?.args[1] as { $set: Record<string, unknown> }).$set;
    expect(set.content).toBe("new content");
    expect(set.semanticEmbedding).toEqual({
      vector: [0.1, 0.2],
      space: "test:2:cosine",
    });
    expect(state.body).toMatchObject({ id, name: "new" });
  });

  it("skips embedding work when only enabled changes", async () => {
    const id = idOf();
    const { db, calls } = skillDb(null, { _id: new ObjectId(id), name: "kept", enabled: false });

    const handler = getHandler(skillsRouter, "put", "/:id");
    const { res, state } = makeRes();
    await handler(
      makeReq({ params: { id }, body: { enabled: false }, db }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(calls.map((call) => call.method)).toEqual(["findOneAndUpdate"]);
    expect(state.body).toMatchObject({ id, enabled: false });
  });

  it("answers 404 when the skill is missing", async () => {
    const { db } = skillDb(null, null);
    const handler = getHandler(skillsRouter, "put", "/:id");
    const { res, state } = makeRes();
    await handler(
      makeReq({ params: { id: idOf() }, body: { enabled: true }, db }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(404);
    expect(state.body).toEqual({ error: "Skill not found" });
  });
});

describe("RulesRoutes PUT /:id", () => {
  const ruleDb = (updated: Record<string, unknown> | null) => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    return {
      db: {
        collection: () => ({
          findOneAndUpdate: async (...args: unknown[]) => {
            calls.push({ method: "findOneAndUpdate", args });
            return updated;
          },
        }),
      },
      calls,
    };
  };

  it("updates an existing rule", async () => {
    const id = idOf();
    const { db, calls } = ruleDb({ _id: new ObjectId(id), name: "rule", enabled: false });
    const handler = getHandler(rulesRouter, "put", "/:id");
    const { res, state } = makeRes();
    await handler(
      makeReq({ params: { id }, body: { enabled: false }, db }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.body).toMatchObject({ id, name: "rule", enabled: false });
    const set = (calls[0].args[1] as { $set: Record<string, unknown> }).$set;
    expect(set.enabled).toBe(false);
    expect(set).toHaveProperty("updatedAt");
  });

  it("answers 404 when the rule is missing", async () => {
    const { db } = ruleDb(null);
    const handler = getHandler(rulesRouter, "put", "/:id");
    const { res, state } = makeRes();
    await handler(
      makeReq({ params: { id: idOf() }, body: { enabled: true }, db }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(404);
    expect(state.body).toEqual({ error: "Rule not found" });
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
    fakes.prism.allowed = true;
    fakes.classify = () => ({ success: true });
    process.env.TRADING_TOOL_CONTEXT_KEY = "test-signing-key";
  });
  afterEach(() => {
    delete process.env.TRADING_TOOL_CONTEXT_KEY;
  });

  it("refuses tools outside the conversation whitelist", async () => {
    fakes.prism.allowed = false;
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

// ── Experiment route ───────────────────────────────────────

import experimentRouter from "../ExperimentRoutes.ts";

const experimentResult = {
  label: "exp-1",
  baseline: {
    target: { provider: "openai", model: "a" },
    trials: 2,
    passed: 1,
    passRate: 0.5,
    meanLatencyMs: 10,
    meanTokens: 5,
    failures: ["timeout"],
  },
  candidate: {
    target: { provider: "openai", model: "b" },
    trials: 2,
    passed: 2,
    passRate: 1,
    meanLatencyMs: 12,
    meanTokens: 6,
    failures: [],
  },
  pairedDeltas: [
    { trial: 0, passedBaseline: true, passedCandidate: false },
    { trial: 1, passedBaseline: true, passedCandidate: true },
  ],
  delta: 0.5,
  ciLower: -0.1,
  ciUpper: 0.9,
  powerOk: false,
  requiredTrials: 20,
  outcome: "inconclusive",
};

describe("ExperimentRoutes POST /", () => {
  beforeEach(() => {
    fakes.experiment.runExperiment = async () => experimentResult;
  });

  it("validates the benchmark and arm configuration", async () => {
    const handler = getHandler(experimentRouter, "post", "/");
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, "Missing benchmark.prompt"],
      [{ benchmark: { prompt: "x" } }, "Missing baseline provider/model"],
      [
        { benchmark: { prompt: "x" }, baseline: { provider: "a", model: "m" } },
        "Missing candidate provider/model",
      ],
      [
        {
          benchmark: { prompt: "x" },
          baseline: { provider: "a", model: "m" },
          candidate: { provider: "b", model: "n" },
          trials: 1,
        },
        "trials must be an integer between 2 and 500",
      ],
    ];
    for (const [body, error] of cases) {
      const { res, state } = makeRes();
      await handler(
        makeReq({ body }).req as unknown as Request,
        res as unknown as Response,
        nextSpy().next,
      );
      expect(state.statusCode).toBe(400);
      expect(state.body).toEqual({ error });
    }
  });

  it("runs the experiment and appends the attribution report", async () => {
    const seen: unknown[] = [];
    fakes.experiment.runExperiment = async (request) => {
      seen.push(request);
      return experimentResult;
    };

    const handler = getHandler(experimentRouter, "post", "/");
    const { res, state } = makeRes();
    await handler(
      makeReq({
        body: {
          benchmark: { prompt: "What is 2+2?" },
          baseline: { provider: "openai", model: "a" },
          candidate: { provider: "openai", model: "b" },
          trials: 20,
          minDetectableEffect: 0.2,
          label: "exp-1",
        },
      }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(seen[0]).toMatchObject({
      benchmark: { prompt: "What is 2+2?" },
      trials: 20,
      minDetectableEffect: 0.2,
      label: "exp-1",
      project: "experiment",
      username: "experiment",
    });

    const body = state.body as {
      outcome: string;
      attribution: { divergence: { firstDivergentTrial: number | null } };
    };
    expect(body.outcome).toBe("inconclusive");
    expect(body.attribution.divergence.firstDivergentTrial).toBe(0);
  });
});

// ── Text route ─────────────────────────────────────────────

import textRouter from "../TextRoutes.ts";

const aggregateDb = (
  resolve: (pipeline: Record<string, unknown>[], callIndex: number) => unknown,
) => {
  let callIndex = 0;
  return {
    collection: (name: string) => ({
      aggregate: (pipeline: Record<string, unknown>[]) => {
        fakes.dbCalls.push({ collection: name, method: "aggregate", args: [pipeline] });
        const result = resolve(pipeline, callIndex++);
        return { toArray: async () => result };
      },
    }),
  };
};

describe("TextRoutes GET /", () => {
  beforeEach(() => {
    fakes.dbCalls.length = 0;
  });
  afterEach(() => {
    fakes.db = null;
  });

  it("maps assistant and user rows with provider/model facets", async () => {
    fakes.db = aggregateDb((pipeline) =>
      pipeline.some((stage) => "$count" in stage)
        ? [{ total: 2 }]
        : [
            {
              convId: "c1",
              convTitle: undefined,
              project: "p",
              username: "u",
              role: "assistant",
              content: "hello",
              timestamp: "2026-01-02T00:00:00.000Z",
              model: "openai/gpt-4o",
              estimatedCost: 0.01,
              images: 2,
            },
            {
              convId: "c2",
              convTitle: "Second",
              project: "p",
              username: "u",
              role: "user",
              content: "hi",
              timestamp: "2026-01-01T00:00:00.000Z",
              images: 0,
            },
          ],
    );

    const handler = getHandler(textRouter, "get", "/");
    const { res, state } = makeRes();
    await handler(
      makeReq({
        project: "p",
        db: fakes.db,
        query: {
          page: "1",
          limit: "10",
          origin: "ai",
          search: "hel",
          provider: "openai",
          model: "openai/gpt-4o",
          from: "2026-01-01",
          to: "2026-01-31",
        },
      }).req as unknown as Request,
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
          estimatedCost: 0.01,
          hasImages: true,
          timestamp: "2026-01-02T00:00:00.000Z",
        },
        {
          content: "hi",
          origin: "user",
          role: "user",
          convId: "c2",
          convTitle: "Second",
          project: "p",
          username: "u",
          model: undefined,
          estimatedCost: undefined,
          hasImages: false,
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
      total: 2,
      page: 1,
      limit: 10,
      providers: ["openai"],
      models: ["openai/gpt-4o"],
    });

    const pipeline = fakes.dbCalls[0].args[0] as Array<Record<string, unknown>>;
    expect(pipeline[0]).toEqual({
      $match: {
        project: "p",
        updatedAt: { $gte: "2026-01-01", $lte: "2026-01-31" },
      },
    });
    expect(pipeline).toContainEqual({ $match: { role: "assistant" } });
    expect(pipeline).toContainEqual({
      $match: { content: { $regex: "hel", $options: "i" } },
    });
    expect(pipeline).toContainEqual({
      $match: { model: { $regex: "^openai/", $options: "i" } },
    });
    expect(pipeline).toContainEqual({ $match: { model: "openai/gpt-4o" } });
    // Paging stages are appended only to the items pipeline (second aggregate).
    const itemsPipeline = fakes.dbCalls[1].args[0] as Array<Record<string, unknown>>;
    expect(itemsPipeline.slice(-2)).toEqual([{ $skip: 0 }, { $limit: 10 }]);
    expect(itemsPipeline).not.toContainEqual({ $count: "total" });
  });

  it("rejects an out-of-range page", async () => {
    fakes.db = aggregateDb(() => []);
    const handler = getHandler(textRouter, "get", "/");
    const { res, state } = makeRes();
    await handler(
      makeReq({ project: "p", query: { page: "0" } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(400);
    expect((state.body as { error: string }).error).toContain("page");
  });
});

// ── Media route ────────────────────────────────────────────

import mediaRouter from "../MediaRoutes.ts";

const convItemsFixture = [
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
    provider: "openai",
  },
  {
    url: "https://cdn/b.png",
    mediaType: "image",
    convId: "c1",
    convTitle: "Chat",
    project: "p",
    username: "u",
    role: "assistant",
    timestamp: "2026-01-03T00:00:00.000Z",
    model: "openai/gpt-4o",
    provider: "openai",
  },
];

const requestItemsFixture = [
  {
    url: "https://cdn/b.png",
    mediaType: "image",
    convId: null,
    convTitle: "Agent Generation",
    project: "p",
    username: "u",
    role: "assistant",
    timestamp: "2026-01-03T00:00:00.000Z",
    model: "openai/gpt-4o",
    provider: "openai",
  },
  {
    url: "https://cdn/c.png",
    mediaType: "image",
    convId: null,
    convTitle: "Agent Generation",
    project: "p",
    username: "u",
    role: "assistant",
    timestamp: "2026-01-04T00:00:00.000Z",
    model: "openai/gpt-4o",
    provider: "openai",
    agent: "lupos",
  },
];

describe("MediaRoutes GET /", () => {
  beforeEach(() => {
    fakes.dbCalls.length = 0;
    fakes.db = aggregateDb((_pipeline, callIndex) =>
      callIndex === 0 ? convItemsFixture : requestItemsFixture,
    );
  });
  afterEach(() => {
    fakes.db = null;
  });

  it("merges agent-generated images and dedupes by url", async () => {
    const handler = getHandler(mediaRouter, "get", "/");
    const { res, state } = makeRes();
    await handler(
      makeReq({
        project: "p",
        db: fakes.db,
        query: {
          page: "1",
          limit: "10",
          type: "image",
          origin: "ai",
          search: "chart",
          provider: "openai",
          model: "openai/gpt-4o",
          from: "2026-01-01",
          to: "2026-01-31",
        },
      }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    const body = state.body as {
      total: number;
      providers: string[];
      models: string[];
      data: Array<Record<string, unknown>>;
    };
    expect(body.total).toBe(3);
    expect(body.providers).toEqual(["openai"]);
    expect(body.models).toEqual(["openai/gpt-4o"]);
    expect(body.data.map((item) => item.url)).toEqual([
      "https://cdn/c.png",
      "https://cdn/b.png",
      "https://cdn/a.png",
    ]);
    expect(body.data[0]).toMatchObject({
      origin: "ai",
      convTitle: "Agent Generation",
      agent: "lupos",
    });
    expect(body.data[2]).toMatchObject({
      origin: "user",
      convTitle: "Untitled",
    });
    expect(body.data[2]).not.toHaveProperty("agent");

    // Conversation pipeline carries the project + window scope and filters.
    const convPipeline = fakes.dbCalls[0].args[0] as Array<Record<string, unknown>>;
    expect(convPipeline[0]).toEqual({
      $match: {
        project: "p",
        updatedAt: { $gte: "2026-01-01", $lte: "2026-01-31" },
      },
    });
    expect(convPipeline).toContainEqual({ $match: { mediaType: "image" } });
    expect(convPipeline).toContainEqual({ $match: { role: "assistant" } });
    expect(convPipeline).toContainEqual({ $match: { provider: "openai" } });

    const requestPipeline = fakes.dbCalls[1].args[0] as Array<Record<string, unknown>>;
    expect(requestPipeline[0]).toEqual({
      $match: {
        project: "p",
        operation: { $in: ["agent:image", "agent:iteration"] },
        success: true,
        "responsePayload.images": { $exists: true, $ne: [] },
        timestamp: { $gte: "2026-01-01", $lte: "2026-01-31" },
        provider: "openai",
        model: "openai/gpt-4o",
        "requestPayload.messages.content": { $regex: "chart", $options: "i" },
      },
    });
  });

  it("skips the request collection for audio-only queries", async () => {
    const handler = getHandler(mediaRouter, "get", "/");
    const { res, state } = makeRes();
    await handler(
      makeReq({ project: "p", db: fakes.db, query: { type: "audio" } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(fakes.dbCalls).toHaveLength(1);
    expect(state.body).toMatchObject({ total: 2, page: 1, limit: 100 });
  });

  it("skips the request collection for user-origin queries", async () => {
    const handler = getHandler(mediaRouter, "get", "/");
    const { res, state } = makeRes();
    await handler(
      makeReq({ project: "p", db: fakes.db, query: { origin: "user" } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(fakes.dbCalls).toHaveLength(1);
    expect(state.body).toMatchObject({ total: 2 });
  });

  it("rejects an unknown media type", async () => {
    const handler = getHandler(mediaRouter, "get", "/");
    const { res, state } = makeRes();
    await handler(
      makeReq({ project: "p", db: fakes.db, query: { type: "video" } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(400);
    expect((state.body as { error: string }).error).toContain("type");
  });
});

// ── Scheduled tasks ────────────────────────────────────────

import scheduledRouter from "../ScheduledTasksRoutes.ts";

describe("ScheduledTasksRoutes POST /", () => {
  beforeEach(() => {
    fakes.scheduled.createTask = async () => ({ id: "task-1" });
  });

  it("rejects a body missing required fields", async () => {
    const handler = getHandler(scheduledRouter, "post", "/");
    const { res, state } = makeRes();
    await handler(
      makeReq({ body: { name: "n" } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(400);
    expect(state.body).toEqual({
      error: "Missing required fields: name, prompt, provider, model, scheduleType",
    });
  });

  it("creates the task with defaults and caller scope", async () => {
    const seen: Array<Record<string, unknown>> = [];
    fakes.scheduled.createTask = async (task) => {
      seen.push(task);
      return { id: "task-1", ...task };
    };

    const handler = getHandler(scheduledRouter, "post", "/");
    const { res, state } = makeRes();
    await handler(
      makeReq({
        project: "proj",
        username: "alice",
        body: {
          name: "nightly",
          prompt: "summarise",
          scheduleType: "daily",
          scheduleTime: "03:00",
        },
      }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.statusCode).toBe(201);
    expect(seen[0]).toMatchObject({
      name: "nightly",
      prompt: "summarise",
      scheduleType: "daily",
      scheduleTime: "03:00",
      agent: null,
      enabled: true,
      project: "proj",
      username: "alice",
    });
    expect(seen[0].provider).toBeTruthy();
    expect(seen[0].model).toBeTruthy();
    expect(state.body).toMatchObject({ id: "task-1", project: "proj" });
  });

  it("answers 500 when creation fails", async () => {
    fakes.scheduled.createTask = async () => {
      throw new Error("db down");
    };
    const handler = getHandler(scheduledRouter, "post", "/");
    const { res, state } = makeRes();
    await handler(
      makeReq({
        body: { name: "n", prompt: "p", scheduleType: "daily" },
      }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(500);
    expect(state.body).toEqual({ error: "Failed to create scheduled task" });
  });
});

// ── Agent memories ─────────────────────────────────────────

import memoriesRouter from "../AgentMemoriesRoutes.ts";

describe("AgentMemoriesRoutes POST /", () => {
  it("requires content", async () => {
    const handler = getHandler(memoriesRouter, "post", "/");
    const { res, state } = makeRes();
    await handler(
      makeReq({ body: {} }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(400);
    expect(state.body).toEqual({ error: "content is required" });
  });

  it("reports near-duplicates instead of storing", async () => {
    const seen: Array<Record<string, unknown>> = [];
    fakes.memory.store = async (input) => {
      seen.push(input);
      return null;
    };
    const handler = getHandler(memoriesRouter, "post", "/");
    const { res, state } = makeRes();
    await handler(
      makeReq({ body: { content: "remember this" } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.body).toEqual({
      duplicate: true,
      message: "Near-duplicate memory already exists",
    });
    expect(seen[0]).toMatchObject({
      content: "remember this",
      type: "project",
      endpoint: "/agent-memories",
    });
  });

  it("returns the stored memory without its embedding vector", async () => {
    fakes.memory.store = async () => ({
      id: "mem-1",
      content: "remember this",
      semanticEmbedding: { vector: [0.1, 0.2], space: "test:2:cosine" },
    });
    const handler = getHandler(memoriesRouter, "post", "/");
    const { res, state } = makeRes();
    await handler(
      makeReq({
        body: { content: "remember this", agent: "CODING", project: "p", username: "u" },
      }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.body).toEqual({ id: "mem-1", content: "remember this" });
  });
});

// ── Webhook routes ─────────────────────────────────────────

import webhookRouter from "../WebhookRoutes.ts";

const webhookDb = (overrides: Record<string, unknown>) => ({
  collection: () => ({
    insertOne: async (doc: Record<string, unknown>) => {
      fakes.dbCalls.push({ collection: "webhooks", method: "insertOne", args: [doc] });
      return { acknowledged: true };
    },
    findOneAndUpdate: async (...args: unknown[]) => {
      fakes.dbCalls.push({ collection: "webhooks", method: "findOneAndUpdate", args });
      return "result" in overrides ? overrides.result : null;
    },
    deleteOne: async (...args: unknown[]) => {
      fakes.dbCalls.push({ collection: "webhooks", method: "deleteOne", args });
      return { deletedCount: "deletedCount" in overrides ? overrides.deletedCount : 1 };
    },
  }),
});

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

describe("WebhookRoutes POST /subscriptions", () => {
  beforeEach(() => {
    fakes.dbCalls.length = 0;
  });
  afterEach(() => {
    fakes.db = null;
  });

  const handler = () => getFinalHandler(webhookRouter, "post", "/subscriptions");

  it("requires a string url", async () => {
    fakes.db = webhookDb({});
    const { res, state } = makeRes();
    await handler()(
      makeReq({ body: { url: 42 } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(400);
    expect(state.body).toEqual({ error: "url is required and must be a string" });
  });

  it("rejects unparseable and non-http urls", async () => {
    fakes.db = webhookDb({});
    const cases: Array<[string, string]> = [
      ["not a url", "url must be a valid URL"],
      ["ftp://example.com/hook", "url must use http or https protocol"],
    ];
    for (const [url, error] of cases) {
      const { res, state } = makeRes();
      await handler()(
        makeReq({ body: { url } }).req as unknown as Request,
        res as unknown as Response,
        nextSpy().next,
      );
      expect(state.statusCode).toBe(400);
      expect(state.body).toEqual({ error });
    }
  });

  it("persists a subscription and returns its secret", async () => {
    fakes.db = webhookDb({});
    const { res, state } = makeRes();
    await handler()(
      makeReq({
        db: fakes.db,
        body: { url: "https://example.com/hook", events: ["agent_start"], filter: { agent: "coding" } },
      }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.statusCode).toBe(201);
    const body = state.body as {
      subscription: { id: string; secret: string; enabled: boolean; events: string[] };
    };
    expect(body.subscription.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.subscription.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(body.subscription.enabled).toBe(true);
    expect(body.subscription.events).toEqual(["agent_start"]);

    const inserted = fakes.dbCalls[0].args[0] as Record<string, unknown>;
    expect(inserted).toMatchObject({
      url: "https://example.com/hook",
      secret: body.subscription.secret,
      filter: { agent: "coding" },
      enabled: true,
    });
    expect(inserted.createdAt).toEqual(expect.any(String));
  });
});

describe("WebhookRoutes PATCH /subscriptions/:id", () => {
  beforeEach(() => {
    fakes.dbCalls.length = 0;
  });
  afterEach(() => {
    fakes.db = null;
  });

  const handler = () => getFinalHandler(webhookRouter, "patch", "/subscriptions/:id");

  it("validates a replacement url", async () => {
    fakes.db = webhookDb({});
    const cases: Array<[string, string]> = [
      ["nope", "url must be a valid URL"],
      ["ftp://example.com/hook", "url must use http or https protocol"],
    ];
    for (const [url, error] of cases) {
      const { res, state } = makeRes();
      await handler()(
        makeReq({ params: { id: "sub-1" }, body: { url } }).req as unknown as Request,
        res as unknown as Response,
        nextSpy().next,
      );
      expect(state.statusCode).toBe(400);
      expect(state.body).toEqual({ error });
    }
  });

  it("toggles enabled without touching the url", async () => {
    fakes.db = webhookDb({ result: { id: "sub-1", enabled: false } });
    const { res, state } = makeRes();
    await handler()(
      makeReq({ db: fakes.db, params: { id: "sub-1" }, body: { enabled: false } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.body).toEqual({ subscription: { id: "sub-1", enabled: false } });
    const [filter, update, options] = fakes.dbCalls[0].args as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
      Record<string, unknown>,
    ];
    expect(filter).toEqual({ id: "sub-1" });
    expect(update.$set.enabled).toBe(false);
    expect(update.$set).not.toHaveProperty("url");
    expect(update.$set.updatedAt).toEqual(expect.any(String));
    expect(options).toEqual({ returnDocument: "after", projection: { secret: 0 } });
  });

  it("answers 404 for a missing subscription", async () => {
    fakes.db = webhookDb({ result: null });
    const { res, state } = makeRes();
    await handler()(
      makeReq({ db: fakes.db, params: { id: "missing" }, body: { enabled: true } }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );
    expect(state.statusCode).toBe(404);
    expect(state.body).toEqual({ error: "Subscription not found" });
  });

  it("replaces url, events and filter together", async () => {
    fakes.db = webhookDb({ result: { id: "sub-1", url: "https://new.test/hook" } });
    const { res, state } = makeRes();
    await handler()(
      makeReq({
        db: fakes.db,
        params: { id: "sub-1" },
        body: {
          url: "https://new.test/hook",
          events: ["*"],
          filter: { project: "p" },
        },
      }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.body).toEqual({
      subscription: { id: "sub-1", url: "https://new.test/hook" },
    });
    const update = fakes.dbCalls[0].args[1] as { $set: Record<string, unknown> };
    expect(update.$set).toMatchObject({
      url: "https://new.test/hook",
      events: ["*"],
      filter: { project: "p" },
    });
  });

  it("forwards database failures to the error handler", async () => {
    fakes.db = {
      collection: () => ({
        findOneAndUpdate: async () => {
          throw new Error("mongo down");
        },
      }),
    };
    const { res } = makeRes();
    const { next, calls } = nextSpy();
    await handler()(
      makeReq({ db: fakes.db, params: { id: "sub-1" }, body: { enabled: true } }).req as unknown as Request,
      res as unknown as Response,
      next,
    );
    expect(calls).toHaveLength(1);
    expect((calls[0] as Error).message).toBe("mongo down");
  });
});

// ── Conversation execution ─────────────────────────────────

import conversationRouter from "../ConversationExecutionRoute.ts";

describe("ConversationExecutionRoute POST /", () => {
  beforeEach(() => {
    fakes.chat.sseCalls.length = 0;
    fakes.chat.jsonCalls.length = 0;
  });

  const handler = () => getHandler(conversationRouter, "post", "/");

  it("routes agent requests through SSE with loop flags forced on", async () => {
    const { res } = makeRes();
    await handler()(
      makeReq({
        project: "p",
        username: "u",
        clientIp: "1.2.3.4",
        workspaceRoot: "/ws",
        agent: "coding",
        query: {},
        body: { agent: "coding", message: "hi" },
      }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(fakes.chat.sseCalls).toHaveLength(1);
    expect(fakes.chat.sseCalls[0].params).toMatchObject({
      agent: "coding",
      message: "hi",
      functionCallingEnabled: true,
      agenticLoopEnabled: true,
      project: "p",
      username: "u",
      clientIp: "1.2.3.4",
      workspaceRoot: "/ws",
    });
    expect(fakes.chat.sseCalls[0].handler).toBe("agent-handler");
  });

  it("routes agent requests through JSON when stream=false", async () => {
    const { res } = makeRes();
    const { next, calls } = nextSpy();
    await handler()(
      makeReq({
        project: "p",
        query: { stream: "false" },
        body: { agenticLoopEnabled: true },
      }).req as unknown as Request,
      res as unknown as Response,
      next,
    );

    expect(fakes.chat.jsonCalls).toHaveLength(1);
    expect(fakes.chat.jsonCalls[0].params).toMatchObject({
      agenticLoopEnabled: true,
      functionCallingEnabled: true,
      agent: null,
    });
    expect(fakes.chat.jsonCalls[0].handler).toBe("agent-handler");
    expect(calls).toEqual([]);
  });

  it("routes plain completions through SSE by default", async () => {
    const { res } = makeRes();
    await handler()(
      makeReq({
        project: "p",
        username: "u",
        query: {},
        body: { model: "openai/gpt-4o" },
      }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(fakes.chat.sseCalls).toHaveLength(1);
    expect(fakes.chat.sseCalls[0].params).toEqual({
      model: "openai/gpt-4o",
      project: "p",
      username: "u",
      clientIp: undefined,
    });
    expect(fakes.chat.sseCalls[0].handler).toBeUndefined();
  });

  it("routes plain completions through JSON when stream=false", async () => {
    const { res } = makeRes();
    const { next } = nextSpy();
    await handler()(
      makeReq({
        project: "p",
        query: { stream: "false" },
        body: { model: "openai/gpt-4o" },
      }).req as unknown as Request,
      res as unknown as Response,
      next,
    );

    expect(fakes.chat.jsonCalls).toHaveLength(1);
    expect(fakes.chat.jsonCalls[0].params).toEqual({
      model: "openai/gpt-4o",
      project: "p",
      username: undefined,
      clientIp: undefined,
    });
    expect(fakes.chat.jsonCalls[0].handler).toBeUndefined();
  });
});

// ── Custom agents ──────────────────────────────────────────

import customAgentsRouter from "../CustomAgentsRoutes.ts";

describe("CustomAgentsRoutes PUT /:id", () => {
  beforeEach(() => {
    fakes.personas.registered.length = 0;
    fakes.personas.unregistered.length = 0;
  });

  const handler = () => getHandler(customAgentsRouter, "put", "/:id");

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

// ── VRAM benchmark machines ────────────────────────────────

import vramRouter from "../VramBenchmarksRoutes.ts";

describe("VramBenchmarksRoutes GET /machines", () => {
  beforeEach(() => {
    fakes.dbCalls.length = 0;
  });
  afterEach(() => {
    fakes.db = null;
  });

  it("maps grouped machine documents with rounded VRAM", async () => {
    fakes.db = {
      collection: () => ({
        aggregate: (pipeline: unknown[]) => {
          fakes.dbCalls.push({ collection: "vram", method: "aggregate", args: [pipeline] });
          return {
            toArray: async () => [
              {
                _id: "dgx-spark",
                gpu: "GB10",
                gpuVramMiB: 128000,
                gpuVendor: "NVIDIA",
                gpuDriver: "580.1",
                cpu: "Grace",
                ramGiB: 128,
                ramSpeedMHz: 0,
                ramType: "",
                platform: "linux",
                motherboard: null,
                benchmarkCount: 7,
                lastRun: "2026-01-05T00:00:00.000Z",
              },
              {
                _id: "wsl-box",
                gpu: null,
                gpuVramMiB: null,
                gpuVendor: null,
                gpuDriver: null,
                cpu: null,
                ramGiB: null,
                benchmarkCount: 1,
                lastRun: "2026-01-01T00:00:00.000Z",
              },
            ],
          };
        },
      }),
    };

    const handler = getHandler(vramRouter, "get", "/machines");
    const { res, state } = makeRes();
    await handler(
      makeReq({ db: fakes.db, query: {} }).req as unknown as Request,
      res as unknown as Response,
      nextSpy().next,
    );

    expect(state.body).toEqual([
      {
        hostname: "dgx-spark",
        gpu: "GB10",
        gpuVramGB: 125,
        gpuVendor: "NVIDIA",
        gpuDriver: "580.1",
        cpu: "Grace",
        ramGiB: 128,
        ramSpeedMHz: null,
        ramType: null,
        platform: "linux",
        motherboard: null,
        benchmarkCount: 7,
        lastRun: "2026-01-05T00:00:00.000Z",
      },
      {
        hostname: "wsl-box",
        gpu: null,
        gpuVramGB: null,
        gpuVendor: null,
        gpuDriver: null,
        cpu: null,
        ramGiB: null,
        ramSpeedMHz: null,
        ramType: null,
        platform: null,
        motherboard: null,
        benchmarkCount: 1,
        lastRun: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const pipeline = fakes.dbCalls[0].args[0] as Array<Record<string, unknown>>;
    expect(pipeline[0]).toEqual({
      $match: { "system.hostname": { $exists: true } },
    });
    expect(pipeline[pipeline.length - 1]).toEqual({ $sort: { benchmarkCount: -1 } });
  });
});
