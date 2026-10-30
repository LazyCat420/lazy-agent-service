/**
 * BenchmarkService — statement coverage of the benchmark runner, the assertion
 * evaluators and the CRUD helpers. Chat generation, providers, Mongo and the
 * inter-model delay are fakes; the service is real and assertions read the
 * returned run/result documents.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  handleConversation: vi.fn(),
  handleAgent: vi.fn(),
  getProvider: vi.fn(),
  isInstance: vi.fn(),
  getDb: vi.fn(),
  sleep: vi.fn(async () => {}),
}));

vi.mock("../../core/chat/ChatGeneration.ts", () => ({
  handleConversation: fakes.handleConversation,
  handleAgent: fakes.handleAgent,
}));
vi.mock("../../providers/index.ts", () => ({ getProvider: fakes.getProvider }));
vi.mock("../../providers/instance-registry.ts", () => ({ isInstance: fakes.isInstance }));
vi.mock("../../wrappers/MongoWrapper.ts", () => ({ default: { getDb: fakes.getDb } }));
vi.mock("../../utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));
vi.mock("../../config.ts", () => ({
  MODELS: {
    chat: {
      provider: "openai",
      name: "gpt-fixture",
      label: "GPT Fixture",
      modelType: "conversation",
      outputTypes: ["text"],
    },
    unlisted: {
      provider: "openai",
      name: "unlisted-model",
      label: "Unlisted",
      modelType: "conversation",
      outputTypes: ["text"],
      listed: false,
    },
    imageOnly: {
      provider: "openai",
      name: "image-only",
      label: "Image Only",
      modelType: "conversation",
      outputTypes: ["image"],
    },
    imageApi: {
      provider: "openai",
      name: "image-api",
      label: "Image API",
      modelType: "conversation",
      outputTypes: ["text"],
      imageAPI: true,
    },
    embedding: {
      provider: "openai",
      name: "embedding-model",
      label: "Embedding",
      modelType: "embedding",
      outputTypes: ["embedding"],
    },
  },
  MODEL_TYPES: { CONVERSATION: "conversation" },
  getModelByName: (name: string) =>
    name === "gpt-fixture" ? { label: "Catalog Label" } : undefined,
}));
vi.mock("@rodrigo-barraza/utilities-library", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sleep: fakes.sleep,
}));

import BenchmarkService, { runSingleModel } from "../BenchmarkService.ts";

type Event = Record<string, unknown>;

const benchmark = (overrides: Event = {}): Event => ({
  id: "bench-1",
  name: "Accuracy check",
  prompt: "What is 6*7?",
  assertions: [{ expectedValue: "42" }],
  ...overrides,
});

const model = (overrides: Event = {}): Event => ({
  provider: "openai",
  model: "gpt-fixture",
  label: "GPT Fixture",
  thinkingEnabled: false,
  toolsEnabled: false,
  ...overrides,
});

/** Chat generation fake replaying a fixed event list through the emit callback. */
function replay(events: Event[]) {
  return async (_params: unknown, emit: (event: Event) => void) => {
    for (const event of events) emit(event);
  };
}

const db = {
  collection: vi.fn(() => ({
    insertOne: vi.fn(async (doc: unknown) => ({ insertedId: "id", doc })),
    findOne: vi.fn(async () => null),
  })),
};

beforeEach(() => {
  vi.resetAllMocks();
  fakes.getProvider.mockReturnValue({});
  fakes.isInstance.mockReturnValue(false);
  fakes.getDb.mockReturnValue(db);
});

describe("evaluate", () => {
  it("matches every mode and rejects empty operands", () => {
    expect(BenchmarkService.evaluate("The Answer is 42", "answer")).toBe(true);
    expect(BenchmarkService.evaluate("42", "42", "exact")).toBe(true);
    expect(BenchmarkService.evaluate(" 42 extra", "42", "exact")).toBe(false);
    expect(BenchmarkService.evaluate("42 is the answer", "42", "startsWith")).toBe(true);
    expect(BenchmarkService.evaluate("no", "42", "startsWith")).toBe(false);
    expect(BenchmarkService.evaluate("value: 42", "\\d+", "regex")).toBe(true);
    expect(BenchmarkService.evaluate("value: x", "\\d+", "regex")).toBe(false);
    expect(BenchmarkService.evaluate("value", "([", "regex")).toBe(false);
    expect(BenchmarkService.evaluate("anything", "42", "unknown-mode")).toBe(false);
    expect(BenchmarkService.evaluate("", "42")).toBe(false);
    expect(BenchmarkService.evaluate("42", "")).toBe(false);
  });
});

describe("getConversationModels", () => {
  it("keeps only listed, text-output conversation models", () => {
    expect(BenchmarkService.getConversationModels()).toEqual([
      {
        provider: "openai",
        model: "gpt-fixture",
        label: "GPT Fixture",
        thinkingEnabled: false,
        toolsEnabled: false,
      },
    ]);
  });
});

describe("runSingleModel", () => {
  it("returns an aborted result without calling the model", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runSingleModel(benchmark() as never, model() as never, "proj", "alice", {
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      response: null,
      passed: false,
      error: "Aborted",
      latency: 0,
      usage: null,
      estimatedCost: null,
      matchMode: "contains",
    });
    expect(fakes.handleConversation).not.toHaveBeenCalled();
  });

  it("captures text, thinking, usage and cost from a passing run", async () => {
    fakes.handleConversation.mockImplementation(
      replay([
        { type: "thinking", content: "6*7 is 42" },
        { type: "chunk", content: "The answer " },
        { type: "chunk", content: "is 42" },
        { type: "done", usage: { inputTokens: 10, outputTokens: 4 }, estimatedCost: 0.002 },
      ]),
    );

    const result = await runSingleModel(
      benchmark({ systemPrompt: "Be brief", temperature: 0.2, maxTokens: 128 }) as never,
      model() as never,
      "proj",
      "alice",
    );

    expect(result).toMatchObject({
      response: "The answer is 42",
      thinking: "6*7 is 42",
      passed: true,
      matchMode: "contains",
      turnCount: 1,
      usage: { inputTokens: 10, outputTokens: 4 },
      estimatedCost: 0.002,
      error: null,
      thinkingEnabled: false,
      toolsEnabled: false,
    });
    expect(typeof result.latency).toBe("number");

    const params = fakes.handleConversation.mock.calls[0][0];
    expect(params.messages).toEqual([
      { role: "system", content: "Be brief" },
      { role: "user", content: "What is 6*7?" },
    ]);
    expect(params.temperature).toBe(0.2);
    expect(params.maxTokens).toBe(2048);
    expect(params.skipConversation).toBe(true);
    expect(params.agenticLoopEnabled).toBeUndefined();
  });

  it("uses handleAgent for agent/tools models and enables the tool catalog", async () => {
    fakes.handleAgent.mockImplementation(replay([{ type: "chunk", content: "42" }]));
    await runSingleModel(
      benchmark() as never,
      model({ agent: "analyst", toolsEnabled: true }) as never,
      null,
      "alice",
    );

    const params = fakes.handleAgent.mock.calls[0][0];
    expect(params.agent).toBe("analyst");
    expect(params.agenticLoopEnabled).toBe(true);
    expect(params.autoApprove).toBe(true);
    expect(params.maxIterations).toBe(10);
    expect(params.functionCallingEnabled).toBe(true);
    expect(params.enabledTools).toEqual(["evaluate_expression"]);
  });

  it("collects native and agentic tool calls and evaluates agent assertions", async () => {
    fakes.handleAgent.mockImplementation(
      replay([
        { type: "toolCall", status: "done", id: "c1", name: "calculate_precise", args: { a: 6 }, result: 42 },
        {
          type: "tool_execution",
          status: "error",
          tool: { id: "c2", name: "shell", args: {}, result: "denied" },
        },
        { type: "chunk", content: "done" },
        { type: "done" },
      ]),
    );

    const result = await runSingleModel(
      benchmark({
        benchmarkMode: "agent",
        agentAssertions: [
          { type: "replied" },
          { type: "used_tool_calls", operator: "gte", operand: "2" },
          { type: "max_turns", operator: "lte", operand: "3" },
        ],
      }) as never,
      model({ toolsEnabled: true }) as never,
      null,
      "alice",
    );

    expect(result.toolCalls).toEqual([
      { id: "c1", name: "calculate_precise", args: { a: 6 }, result: 42, status: "done" },
      { id: "c2", name: "shell", args: {}, result: "denied", status: "error" },
    ]);
    expect(result.passed).toBe(true);
    expect(result.response).toBe("done");
  });

  it("falls back to any-tool-call, unlimited-turn and unknown-type agent assertions", async () => {
    fakes.handleAgent.mockImplementation(
      replay([
        { type: "toolCall", status: "done", id: "c1", name: "calculate_precise" },
        { type: "chunk", content: "ok" },
      ]),
    );

    const anyTools = await runSingleModel(
      benchmark({ benchmarkMode: "agent", agentAssertions: [{ type: "used_tool_calls" }] }) as never,
      model({ toolsEnabled: true }) as never,
      null,
      "alice",
    );
    expect(anyTools.passed).toBe(true);

    const unlimited = await runSingleModel(
      benchmark({ benchmarkMode: "agent", agentAssertions: [{ type: "max_turns" }] }) as never,
      model({ toolsEnabled: true }) as never,
      null,
      "alice",
    );
    expect(unlimited.passed).toBe(true);

    const unknown = await runSingleModel(
      benchmark({ benchmarkMode: "agent", agentAssertions: [{ type: "teleported" }] }) as never,
      model({ toolsEnabled: true }) as never,
      null,
      "alice",
    );
    expect(unknown.passed).toBe(false);

    const thought = await runSingleModel(
      benchmark({ benchmarkMode: "agent", agentAssertions: [{ type: "thought" }] }) as never,
      model({ toolsEnabled: true }) as never,
      null,
      "alice",
    );
    expect(thought.passed).toBe(false);

    const ltOperator = await runSingleModel(
      benchmark({
        benchmarkMode: "agent",
        agentAssertionOperator: "OR",
        agentAssertions: [
          { type: "used_tool_calls", operator: "lt", operand: "1" },
          { type: "replied" },
        ],
      }) as never,
      model({ toolsEnabled: true }) as never,
      null,
      "alice",
    );
    expect(ltOperator.passed).toBe(true);
  });

  it("passes an agent-mode run by default when no assertions are declared", async () => {
    fakes.handleConversation.mockImplementation(replay([{ type: "chunk", content: "anything" }]));
    const result = await runSingleModel(
      benchmark({ benchmarkMode: "agent", assertions: undefined }) as never,
      model({ agent: "analyst" }) as never,
      null,
      "alice",
    );
    expect(result.passed).toBe(true);
  });

  it("requires both text and agent assertions in combined mode", async () => {
    fakes.handleConversation.mockImplementation(replay([{ type: "chunk", content: "42" }]));
    const passing = await runSingleModel(
      benchmark({
        benchmarkMode: "combined",
        agentAssertions: [{ type: "replied" }],
      }) as never,
      model() as never,
      null,
      "alice",
    );
    expect(passing.passed).toBe(true);

    const failing = await runSingleModel(
      benchmark({
        benchmarkMode: "combined",
        agentAssertions: [{ type: "thought" }],
      }) as never,
      model() as never,
      null,
      "alice",
    );
    expect(failing.passed).toBe(false);
  });

  it("honours OR-joined text assertions and missing assertion lists", async () => {
    fakes.handleConversation.mockImplementation(replay([{ type: "chunk", content: "forty two" }]));
    const orPassing = await runSingleModel(
      benchmark({
        assertions: [{ expectedValue: "42" }, { expectedValue: "forty" }],
        assertionOperator: "OR",
      }) as never,
      model() as never,
      null,
      "alice",
    );
    expect(orPassing.passed).toBe(true);

    const noAssertions = await runSingleModel(
      benchmark({ assertions: [] }) as never,
      model() as never,
      null,
      "alice",
    );
    expect(noAssertions.passed).toBe(false);
  });

  it("reports a null response when the model produced no text", async () => {
    fakes.handleConversation.mockImplementation(replay([{ type: "done" }]));
    const result = await runSingleModel(benchmark() as never, model() as never, null, "alice");
    expect(result.response).toBeNull();
    expect(result.thinking).toBeNull();
    expect(result.passed).toBe(false);
    expect(result.toolCalls).toBeNull();
  });

  it("turns an error event into a failed result carrying the message", async () => {
    fakes.handleConversation.mockImplementation(
      replay([{ type: "chunk", content: "partial" }, { type: "error", message: "rate limited" }]),
    );
    const result = await runSingleModel(benchmark() as never, model() as never, null, "alice");
    expect(result).toMatchObject({ response: null, passed: false, error: "rate limited" });
  });

  it("uses a generic error message when the error event carries none", async () => {
    fakes.handleConversation.mockImplementation(replay([{ type: "error" }]));
    const result = await runSingleModel(benchmark() as never, model() as never, null, "alice");
    expect(result.error).toBe("Unknown error");
  });

  it("turns a thrown generation error into a failed result", async () => {
    fakes.handleConversation.mockRejectedValue(new Error("socket hang up"));
    const result = await runSingleModel(benchmark() as never, model() as never, null, "alice");
    expect(result).toMatchObject({ response: null, passed: false, error: "socket hang up" });
    expect(typeof result.latency).toBe("number");
  });

  it("streams live preview events and tolerates a throwing preview callback", async () => {
    fakes.handleConversation.mockImplementation(
      replay([
        { type: "chunk", content: "42" },
        { type: "tool_execution", status: "streaming" },
        { type: "done" },
      ]),
    );
    const previews: Event[] = [];
    await runSingleModel(benchmark() as never, model() as never, null, "alice", {
      onEvent: (event) => previews.push(event),
    });
    expect(previews.map((event) => event.type)).toEqual(["chunk", "tool_execution"]);

    const throwing = await runSingleModel(benchmark() as never, model() as never, null, "alice", {
      onEvent: () => {
        throw new Error("channel closed");
      },
    });
    expect(throwing.passed).toBe(true);
  });
});

describe("runBenchmark", () => {
  it("throws when no model is available for benchmarking", async () => {
    fakes.getProvider.mockImplementation(() => {
      throw new Error("no api key");
    });
    await expect(
      BenchmarkService.runBenchmark(benchmark() as never, null, "proj", "alice"),
    ).rejects.toThrow("No models available for benchmarking");
  });

  it("runs explicit targets, tags live events and persists the run", async () => {
    fakes.handleConversation.mockImplementation(
      replay([
        { type: "chunk", content: "42" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 1 }, estimatedCost: 0.001 },
      ]),
    );
    const events: Event[] = [];
    const started: Event[] = [];
    const completed: Event[] = [];

    const run = await BenchmarkService.runBenchmark(
      benchmark() as never,
      [
        { provider: "openai", model: "gpt-fixture", display_name: "My GPT", thinkingEnabled: true },
        { provider: "other", model: "mystery" },
      ] as never,
      "proj",
      "alice",
      {
        onRunStart: (info) => started.push(info as Event),
        onModelStart: (info) => started.push(info as Event),
        onModelComplete: (result) => completed.push(result as Event),
        onEvent: (event) => events.push(event),
      },
    );

    expect(started[0]).toEqual({ totalModels: 2 });
    expect(started[1]).toMatchObject({ model: "gpt-fixture", isLocal: false });
    expect(completed).toHaveLength(2);
    expect(run.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.benchmarkId).toBe("bench-1");
    expect(run.project).toBe("proj");
    expect(run.aborted).toBe(false);
    expect(run.summary).toEqual({ total: 2, passed: 2, failed: 0, errored: 0, totalCost: 0.002 });
    expect(run.models[0]).toMatchObject({
      label: "My GPT",
      thinkingEnabled: true,
      passed: true,
      estimatedCost: 0.001,
    });
    expect(run.models[1]).toMatchObject({ label: "mystery", thinkingEnabled: false });
    expect(events[0]._sourceModel).toEqual({ provider: "openai", model: "gpt-fixture" });

    expect(db.collection).toHaveBeenCalledWith("benchmark_runs");
    const inserted = db.collection.mock.results[0].value.insertOne.mock.calls[0][0];
    expect(inserted).toEqual(run);
  });

  it("tolerates callbacks that throw", async () => {
    fakes.handleConversation.mockImplementation(replay([{ type: "chunk", content: "42" }]));
    const run = await BenchmarkService.runBenchmark(
      benchmark() as never,
      [{ provider: "openai", model: "gpt-fixture" }] as never,
      null,
      "alice",
      {
        onRunStart: () => {
          throw new Error("client gone");
        },
        onModelStart: () => {
          throw new Error("client gone");
        },
        onModelComplete: () => {
          throw new Error("client gone");
        },
      },
    );
    expect(run.summary.total).toBe(1);
    expect(run.summary.passed).toBe(1);
  });

  it("sleeps between models of the same provider bucket", async () => {
    fakes.handleConversation.mockImplementation(replay([{ type: "chunk", content: "42" }]));
    await BenchmarkService.runBenchmark(
      benchmark() as never,
      [
        { provider: "lm-studio", model: "local-a" },
        { provider: "lm-studio", model: "local-b" },
      ] as never,
      null,
      "alice",
      { onModelStart: () => {} },
    );
    expect(fakes.sleep).toHaveBeenCalledTimes(1);
    expect(fakes.sleep).toHaveBeenCalledWith(100);
    expect(fakes.isInstance).toHaveBeenCalledWith("lm-studio");
  });

  it("stops immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = await BenchmarkService.runBenchmark(
      benchmark() as never,
      [{ provider: "openai", model: "gpt-fixture" }] as never,
      null,
      "alice",
      { signal: controller.signal },
    );
    expect(run.models).toEqual([]);
    expect(run.summary.total).toBe(0);
    expect(run.aborted).toBe(true);
    expect(fakes.handleConversation).not.toHaveBeenCalled();
    expect(db.collection).not.toHaveBeenCalled();
  });

  it("records the in-flight model and stops when the signal aborts mid-run", async () => {
    const controller = new AbortController();
    fakes.handleConversation.mockImplementation(async (_params, emit) => {
      emit({ type: "chunk", content: "42" });
      controller.abort();
    });
    const completed: Event[] = [];

    const run = await BenchmarkService.runBenchmark(
      benchmark() as never,
      [
        { provider: "openai", model: "gpt-fixture" },
        { provider: "openai", model: "second-model" },
      ] as never,
      null,
      "alice",
      { signal: controller.signal, onModelComplete: (result) => completed.push(result as Event) },
    );

    expect(fakes.handleConversation).toHaveBeenCalledTimes(1);
    expect(run.models).toHaveLength(1);
    expect(run.models[0].model).toBe("gpt-fixture");
    expect(completed).toHaveLength(1);
    expect(run.aborted).toBe(true);
    expect(run.summary.total).toBe(1);
  });

  it("still returns the run when the database is unavailable", async () => {
    fakes.getDb.mockReturnValue(null);
    fakes.handleConversation.mockImplementation(replay([{ type: "chunk", content: "42" }]));
    const run = await BenchmarkService.runBenchmark(
      benchmark() as never,
      [{ provider: "openai", model: "gpt-fixture" }] as never,
      null,
      "alice",
    );
    expect(run.summary.passed).toBe(1);
  });

  it("summarises failed and errored models", async () => {
    fakes.handleConversation
      .mockImplementationOnce(replay([{ type: "chunk", content: "nope" }]))
      .mockImplementationOnce(replay([{ type: "error", message: "boom" }]));
    const run = await BenchmarkService.runBenchmark(
      benchmark() as never,
      [
        { provider: "openai", model: "wrong-answer" },
        { provider: "other", model: "erroring" },
      ] as never,
      null,
      "alice",
    );
    expect(run.summary).toEqual({ total: 2, passed: 0, failed: 1, errored: 1, totalCost: 0 });
  });
});

describe("create", () => {
  it("rejects when the database is unavailable", async () => {
    fakes.getDb.mockReturnValue(null);
    await expect(
      BenchmarkService.create({ name: "n", prompt: "p" }, "proj", "alice"),
    ).rejects.toThrow("Database not available");
  });

  it("fills defaults and persists the benchmark document", async () => {
    const document = await BenchmarkService.create(
      { name: "Defaults", prompt: "Do it" },
      "proj",
      "alice",
    );

    expect(document).toMatchObject({
      project: "proj",
      username: "alice",
      name: "Defaults",
      prompt: "Do it",
      systemPrompt: null,
      matchMode: "contains",
      benchmarkMode: "model",
      assertions: [],
      assertionOperator: "AND",
      agentAssertions: [],
      agentAssertionOperator: "AND",
      temperature: 0,
      maxTokens: 256,
      tags: [],
    });
    expect(document.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(document.createdAt).toBe(document.updatedAt);
    expect(db.collection.mock.results[0].value.insertOne).toHaveBeenCalledWith(document);
  });

  it("keeps every explicitly supplied field", async () => {
    const document = await BenchmarkService.create(
      {
        name: "Explicit",
        prompt: "Do it",
        systemPrompt: "sys",
        expectedValue: "42",
        matchMode: "exact",
        benchmarkMode: "combined",
        assertions: [{ expectedValue: "42" }],
        assertionOperator: "OR",
        agentAssertions: [{ type: "replied" }],
        agentAssertionOperator: "OR",
        temperature: 0.7,
        maxTokens: 1024,
        tags: ["math"],
      },
      null,
      "alice",
    );

    expect(document).toMatchObject({
      project: null,
      systemPrompt: "sys",
      expectedValue: "42",
      matchMode: "exact",
      benchmarkMode: "combined",
      assertionOperator: "OR",
      agentAssertionOperator: "OR",
      temperature: 0.7,
      maxTokens: 1024,
      tags: ["math"],
    });
    expect(document.assertions).toEqual([{ expectedValue: "42" }]);
    expect(document.agentAssertions).toEqual([{ type: "replied" }]);
  });
});
