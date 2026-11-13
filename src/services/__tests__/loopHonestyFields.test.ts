/**
 * LF-06 / LF-07 (slice S-01 review follow-up): the JSON /agent reply and the
 * final SSE done event must carry answerSource ("model" | "synthetic" |
 * "partial"), finalizeReason, providerAttempts and providerRetries. Cut-off
 * or incomplete model text is "partial" — never "model". Truth is produced by
 * the real runCoreLoop exits here, and carried by the real emit wrapping in
 * AgenticLoopService's coreloop adapter path.
 */
import { describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  getSection: vi.fn(),
  getToolSchemas: vi.fn(),
  getMCPToolSchemas: vi.fn(),
  getClientToolSchemas: vi.fn(),
  ensureSchemas: vi.fn(),
  isTradingRequest: vi.fn(),
  personaGet: vi.fn(),
  toolContextGet: vi.fn(),
  toolContextGetStore: vi.fn(() => ({ has: vi.fn(() => true) })),
  toolContextSet: vi.fn(),
  toolContextEnsureLoaded: vi.fn(),
  toolContextCleanupInMemory: vi.fn(),
  startRun: vi.fn(),
  harnessGet: vi.fn(),
  getProvider: vi.fn(),
  getInstancesByType: vi.fn(),
  logChatGeneration: vi.fn(async () => {}),
  calculateTextCost: vi.fn(() => 0),
  runCoreLoopForAgent: vi.fn(),
}));

vi.mock("../SettingsService.ts", () => ({ default: { getSection: fakes.getSection } }));
vi.mock("../SettingsService.js", () => ({ default: { getSection: fakes.getSection } }));
vi.mock("../ToolOrchestratorService.ts", () => ({
  default: {
    ensureSchemas: fakes.ensureSchemas,
    getToolSchemas: fakes.getToolSchemas,
    getMCPToolSchemas: fakes.getMCPToolSchemas,
    getClientToolSchemas: fakes.getClientToolSchemas,
    isTradingRequest: fakes.isTradingRequest,
  },
}));
vi.mock("../AgentPersonaRegistry.ts", () => ({ default: { get: fakes.personaGet } }));
vi.mock("../ToolContext.ts", () => ({
  default: {
    get: fakes.toolContextGet,
    getStore: fakes.toolContextGetStore,
    set: fakes.toolContextSet,
    ensureLoaded: fakes.toolContextEnsureLoaded,
    cleanupInMemory: fakes.toolContextCleanupInMemory,
  },
}));
vi.mock("../platform/trace/HarnessInstrumenter.ts", () => ({
  HarnessInstrumenter: { startRun: fakes.startRun },
}));
vi.mock("../platform/skills/SkillRegistry.ts", () => ({
  SkillRegistry: class {
    discover() {
      return [];
    }
  },
}));
vi.mock("../harnesses/HarnessRegistry.ts", () => ({ default: { get: fakes.harnessGet } }));
vi.mock("../harnesses/lifecycle/HookInitializer.ts", () => ({
  createStandardHooks: () => ({ hooks: {} }),
}));
vi.mock("../RequestLogger.ts", () => ({
  default: { logChatGeneration: fakes.logChatGeneration },
}));
vi.mock("../utils/CostCalculator.ts", () => ({ calculateTextCost: fakes.calculateTextCost }));
vi.mock("../../core/loop/AgentRouteAdapter.ts", () => ({
  shouldUseCoreLoopForAgent: () => true,
  runCoreLoopForAgent: fakes.runCoreLoopForAgent,
}));
vi.mock("../../providers/index.ts", () => ({ getProvider: fakes.getProvider }));
vi.mock("../../providers/instance-registry.ts", () => ({
  getInstancesByType: fakes.getInstancesByType,
}));
vi.mock("../../wrappers/MongoWrapper.ts", () => ({
  default: { getDb: () => null, getCollection: () => null },
}));
vi.mock("../../../config.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MCP_STDIO_COMMANDS: ["npx"],
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() {}
    async listTools() {
      return { tools: [] };
    }
    async close() {}
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    async close() {}
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    async close() {}
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    async close() {}
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import type { SseEvent } from "../../types/SseTypes.ts";
import type { ChatRequest } from "../../types/schemas.ts";
import type { StreamChunk } from "../../types/provider.ts";
import type { CoreLoopEvent, CoreLoopResult, CoreModel, CoreModelRequest } from "../../core/loop/types.ts";
import { runCoreLoop } from "../../core/loop/CoreLoop.ts";
import { okTool, scriptedModel } from "../../core/loop/__tests__/fakes.ts";
import {
  deriveLoopHonestyFields,
  withLoopHonestyFields,
} from "../../utils/LoopHonestyFields.ts";
import { buildJsonResponseFromEvents } from "../../utils/SseUtilities.ts";
import AgenticLoopService from "../AgenticLoopService.ts";

const signal = new AbortController().signal;

async function runLoop(options: Parameters<typeof runCoreLoop>[0]): Promise<{
  result: CoreLoopResult;
  events: CoreLoopEvent[];
}> {
  const events: CoreLoopEvent[] = [];
  const generator = runCoreLoop(options);
  for (;;) {
    const step = await generator.next();
    if (step.done) return { result: step.value, events };
    events.push(step.value);
  }
}

const cutOffToolTurn = (text: string, id: string): StreamChunk[] => [
  text,
  { type: "toolCall", id, name: "widgets", args: {} },
  { type: "stopReason", stopReason: "length" },
];

describe("deriveLoopHonestyFields", () => {
  it("normal run maps to model / COMPLETED / 1 attempt / 0 retries", () => {
    expect(
      deriveLoopHonestyFields({ answerSource: "model", modelCalls: 1, providerRetries: 0 }),
    ).toEqual({ answerSource: "model", finalizeReason: "COMPLETED", providerAttempts: 1, providerRetries: 0 });
  });

  it("step-limit digest run maps to synthetic / STEP_LIMIT", () => {
    expect(
      deriveLoopHonestyFields({ answerSource: "synthetic", finalizeReason: "STEP_LIMIT", modelCalls: 4, providerRetries: 0 }),
    ).toEqual({ answerSource: "synthetic", finalizeReason: "STEP_LIMIT", providerAttempts: 4, providerRetries: 0 });
  });

  it("cut-off run maps to partial, never model", () => {
    expect(
      deriveLoopHonestyFields({ answerSource: "partial", finalizeReason: "DEADLINE_SOFT", modelCalls: 2, providerRetries: 1 }),
    ).toEqual({ answerSource: "partial", finalizeReason: "DEADLINE_SOFT", providerAttempts: 2, providerRetries: 1 });
  });

  it("one provider retry inside the turn yields providerAttempts 2", () => {
    expect(
      deriveLoopHonestyFields({ answerSource: "model", modelCalls: 2, providerRetries: 1 }),
    ).toEqual({ answerSource: "model", finalizeReason: "COMPLETED", providerAttempts: 2, providerRetries: 1 });
  });

  it("passes an unknown loop finalize reason through unchanged and floors counters", () => {
    expect(
      deriveLoopHonestyFields({ answerSource: "model", finalizeReason: "repeated_tool_call:scrape_url", modelCalls: 0, providerRetries: -3 }),
    ).toEqual({ answerSource: "model", finalizeReason: "repeated_tool_call:scrape_url", providerAttempts: 1, providerRetries: 0 });
  });
});

describe("withLoopHonestyFields", () => {
  const meta = deriveLoopHonestyFields({
    answerSource: "partial",
    finalizeReason: "CUT_OFF_TWICE",
    modelCalls: 3,
    providerRetries: 1,
  });

  it("decorates only the done event", () => {
    expect(withLoopHonestyFields({ type: "done", model: "m" }, meta)).toEqual({
      type: "done",
      model: "m",
      ...meta,
    });
    const chunk = { type: "chunk", content: "hi" };
    expect(withLoopHonestyFields(chunk, meta)).toBe(chunk);
  });
});

describe("buildJsonResponseFromEvents — honesty fields", () => {
  const body = (doneEvent: SseEvent) =>
    buildJsonResponseFromEvents(
      [{ type: "chunk", content: "final answer" }, doneEvent],
      { provider: "p", model: "m" } as unknown as ChatRequest,
    ).response as Record<string, unknown>;

  const doneWith = (result: Parameters<typeof deriveLoopHonestyFields>[0]): SseEvent =>
    ({ type: "done", provider: "p", model: "m", ...deriveLoopHonestyFields(result) }) as SseEvent;

  it("normal run replies with model / COMPLETED / 1 / 0", () => {
    const response = body(doneWith({ answerSource: "model", modelCalls: 1, providerRetries: 0 }));
    expect(response.text).toBe("final answer");
    expect(response.answerSource).toBe("model");
    expect(response.finalizeReason).toBe("COMPLETED");
    expect(response.providerAttempts).toBe(1);
    expect(response.providerRetries).toBe(0);
  });

  it("step-limit digest run replies with synthetic / STEP_LIMIT", () => {
    const response = body(
      doneWith({ answerSource: "synthetic", finalizeReason: "STEP_LIMIT", modelCalls: 5, providerRetries: 0 }),
    );
    expect(response.answerSource).toBe("synthetic");
    expect(response.finalizeReason).toBe("STEP_LIMIT");
    expect(response.providerAttempts).toBe(5);
  });

  it("cut-off run replies with partial and counts the final-pass retry", () => {
    const response = body(
      doneWith({ answerSource: "partial", finalizeReason: "DEADLINE_SOFT", modelCalls: 4, providerRetries: 1 }),
    );
    expect(response.answerSource).toBe("partial");
    expect(response.providerAttempts).toBe(4);
    expect(response.providerRetries).toBe(1);
  });

  it("omits the fields when the done event has none (older paths keep working)", () => {
    const response = body({ type: "done", provider: "p", model: "m" });
    expect("answerSource" in response).toBe(false);
    expect("finalizeReason" in response).toBe(false);
    expect("providerAttempts" in response).toBe(false);
    expect("providerRetries" in response).toBe(false);
    expect(response.text).toBe("final answer");
  });
});

describe("runCoreLoop — honesty fields on real exits", () => {
  it("clean single-turn answer: model / COMPLETED / 1 attempt / 0 retries", async () => {
    const { result } = await runLoop({
      model: scriptedModel([["All done."]]),
      tools: [],
      messages: [{ role: "user", content: "hi" }],
      signal,
      maxSteps: 8,
    });
    expect(result.answerSource).toBe("model");
    expect(result.finalizeReason).toBeUndefined();
    expect(result.modelCalls).toBe(1);
    expect(result.providerRetries).toBe(0);
    expect(deriveLoopHonestyFields(result)).toMatchObject({
      answerSource: "model",
      finalizeReason: "COMPLETED",
      providerAttempts: 1,
      providerRetries: 0,
    });
  });

  it("single length cut-off, no tool calls: partial / CUT_OFF", async () => {
    const { result } = await runLoop({
      model: scriptedModel([["truncated reply ", { type: "stopReason", stopReason: "length" }]]),
      tools: [],
      messages: [{ role: "user", content: "hi" }],
      signal,
      maxSteps: 8,
    });
    expect(result.status).toBe("completed");
    expect(result.answerSource).toBe("partial");
    expect(result.finalizeReason).toBe("CUT_OFF");
    expect(result.text).toBe("truncated reply ");
    expect(result.modelCalls).toBe(1);
    expect(result.providerRetries).toBe(0);
  });

  it("step-limit digest: synthetic / STEP_LIMIT / 2 attempts / 0 retries", async () => {
    const { result } = await runLoop({
      model: scriptedModel([[{ type: "toolCall", id: "c1", name: "widgets", args: {} }], []]),
      tools: [okTool("widgets", "42 units")],
      messages: [{ role: "user", content: "hi" }],
      signal,
      maxSteps: 1,
    });
    expect(result.status).toBe("completed");
    expect(result.answerSource).toBe("synthetic");
    expect(result.finalizeReason).toBe("STEP_LIMIT");
    expect(result.text).toContain("42 units");
    expect(result.modelCalls).toBe(2);
    expect(result.providerRetries).toBe(0);
  });

  it("cut-off twice, final pass times out: partial / CUT_OFF_TWICE", async () => {
    const timeoutCtrl = new AbortController();
    const scripted = scriptedModel([cutOffToolTurn("prefix one ", "c1"), cutOffToolTurn("prefix two ", "c2")]);
    const model: CoreModel = (request: CoreModelRequest) => {
      if (!request.finalPass) return scripted(request);
      return (async function* () {
        yield "tail fragment";
        const { promise, reject } = Promise.withResolvers<never>();
        request.signal.addEventListener("abort", () => reject(new Error("final pass aborted")));
        queueMicrotask(() => timeoutCtrl.abort());
        await promise;
      })();
    };
    const { result } = await runLoop({
      model,
      tools: [okTool("widgets", "42 units")],
      messages: [{ role: "user", content: "hi" }],
      signal,
      maxSteps: 8,
      finalPassTimeoutMs: 1000,
      finalPassSignalFor: () => timeoutCtrl.signal,
    });
    expect(result.status).toBe("completed");
    expect(result.answerSource).toBe("partial");
    expect(result.finalizeReason).toBe("CUT_OFF_TWICE");
    expect(result.text).toContain("tail fragment");
    expect(result.modelCalls).toBe(3);
    expect(result.providerRetries).toBe(0);
  });

  it("final-pass timeout after one provider retry: partial / STEP_LIMIT / 3 attempts / 1 retry", async () => {
    const timeoutCtrl = new AbortController();
    const scripted = scriptedModel([[{ type: "toolCall", id: "c1", name: "widgets", args: {} }]]);
    let finalAttempt = 0;
    const model: CoreModel = (request: CoreModelRequest) => {
      if (!request.finalPass) return scripted(request);
      finalAttempt += 1;
      if (finalAttempt === 1) {
        return (async function* () {
          yield* []; // fail before the first chunk; keeps this an async generator
          throw new Error("flaky provider");
        })();
      }
      return (async function* () {
        yield "Partial answer. ";
        const { promise, reject } = Promise.withResolvers<never>();
        request.signal.addEventListener("abort", () => reject(new Error("final pass aborted")));
        queueMicrotask(() => timeoutCtrl.abort());
        await promise;
      })();
    };
    const { result } = await runLoop({
      model,
      tools: [okTool("widgets", "42 units")],
      messages: [{ role: "user", content: "hi" }],
      signal,
      maxSteps: 1,
      finalPassTimeoutMs: 1000,
      finalPassSignalFor: () => timeoutCtrl.signal,
    });
    expect(result.status).toBe("completed");
    expect(result.answerSource).toBe("partial");
    expect(result.finalizeReason).toBe("STEP_LIMIT");
    expect(result.text).toContain("Partial answer.");
    expect(result.modelCalls).toBe(3);
    expect(result.providerRetries).toBe(1);
  });
});

describe("AgenticLoopService coreloop path — real done-event wrapping", () => {
  it("decorates the done event with the four fields and logs synthetic/partial as not-success", async () => {
    fakes.startRun.mockReturnValue({
      runManifest: { trace_id: "trace-1", run_id: "run-1" },
      rootSpan: { span_id: "span-1" },
      complete: vi.fn(),
    });
    fakes.runCoreLoopForAgent.mockResolvedValue({
      messages: [],
      usage: {},
      toolCalls: [],
      result: {
        status: "completed",
        text: "cut off text",
        messages: [],
        modelCalls: 3,
        toolCalls: 1,
        providerRetries: 1,
        finalizeReason: "STEP_LIMIT",
        answerSource: "partial",
      } satisfies CoreLoopResult,
    });
    class FakeHarness {
      static id = "coreloop-test";
      static label = "Coreloop test harness";
      private readonly ctx: { emit: (event: { type: string; [key: string]: unknown }) => void };
      constructor(context: { emit: (event: { type: string; [key: string]: unknown }) => void }) {
        this.ctx = context;
      }
      async run() {
        return { messages: [] };
      }
      async finalize() {
        this.ctx.emit({ type: "chunk", content: "cut off text" });
        this.ctx.emit({ type: "done", provider: "p", model: "m" });
      }
    }
    fakes.harnessGet.mockReturnValue(FakeHarness);

    const events: SseEvent[] = [];
    const emit = (event: { type: string; [key: string]: unknown }) =>
      events.push(event as unknown as SseEvent);
    const context = {
      options: { harness: "coreloop", topology: "topo", thoughtStructure: "linear", enableCriticGate: false },
      agent: "v3_analyst",
      project: "vllm-trading-bot",
      username: "trader",
      modelDefinition: null,
      messages: [{ role: "user", content: "analyze" }],
      agentConversationId: "ac-1",
      conversationId: "c-1",
      provider: {},
      providerName: "p",
      resolvedModel: "gpt-test",
      signal: new AbortController().signal,
      runtimeTools: { finalTools: [], resolvedEnabledTools: [] },
      emit,
      requestId: "req-1",
      clientIp: null,
    };

    await AgenticLoopService.runAgenticLoop(context as never);

    const chunk = events.find((event) => event.type === "chunk");
    const done = events.find((event) => event.type === "done");
    expect(chunk).toBeDefined();
    expect("answerSource" in (chunk as object)).toBe(false);
    expect(done).toMatchObject({
      answerSource: "partial",
      finalizeReason: "STEP_LIMIT",
      providerAttempts: 3,
      providerRetries: 1,
    });
    // LF-06: partial text is not logged as a success anymore.
    const logged = fakes.logChatGeneration.mock.calls[0]?.[0] as { success?: boolean };
    expect(logged.success).toBe(false);
    // The original emit must be restored after finalize.
    expect(context.emit).toBe(emit);
  });
});
