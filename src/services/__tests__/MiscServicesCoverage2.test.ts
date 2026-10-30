/**
 * Miscellaneous services — RequestLogger background-call logging, the custom
 * persona registry, ChangeStream event fan-out, background housekeeping, the
 * experiment engine and web extract Q&A.
 *
 * All persistence, MinIO, filesystem, provider and settings boundaries are
 * fakes; the services themselves are real and assertions read the documents
 * they write, the payloads they broadcast and the results they return.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  getDb: vi.fn(),
  getCollection: vi.fn(),
  getPricing: vi.fn(),
  webhookEmit: vi.fn(),
  minioAvailable: vi.fn(),
  minioListObjects: vi.fn(),
  minioRemove: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  rm: vi.fn(),
  runSingleModel: vi.fn(),
  getModelByName: vi.fn(),
  settingsGetSection: vi.fn(),
  resolveAuxModel: vi.fn(),
  getAuxSelectionStats: vi.fn(),
  getProvider: vi.fn(),
  getInstanceType: vi.fn(),
  getInstancesByType: vi.fn(),
  resolveModelForInstances: vi.fn(),
}));

vi.mock("../../wrappers/MongoWrapper.ts", () => ({
  default: { getDb: fakes.getDb, getCollection: fakes.getCollection },
}));
vi.mock("../../config.ts", () => ({
  TYPES: { TEXT: "text" },
  getPricing: fakes.getPricing,
  MONGO_DB_NAME: "db",
  getModelByName: fakes.getModelByName,
}));
vi.mock("../WebhookEventBus.ts", () => ({ default: { emit: fakes.webhookEmit } }));
vi.mock("../../wrappers/MinioWrapper.ts", () => ({
  default: { isAvailable: fakes.minioAvailable, listObjects: fakes.minioListObjects, remove: fakes.minioRemove },
}));
vi.mock("node:fs/promises", () => ({
  readdir: fakes.readdir,
  stat: fakes.stat,
  rm: fakes.rm,
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock("../BenchmarkService.ts", () => ({ runSingleModel: fakes.runSingleModel }));
vi.mock("../SettingsService.ts", () => ({ default: { getSection: fakes.settingsGetSection } }));
vi.mock("../DynamicModelResolver.ts", () => ({
  DynamicModelResolver: {
    resolveAuxModel: fakes.resolveAuxModel,
    getAuxSelectionStats: fakes.getAuxSelectionStats,
  },
}));
vi.mock("../../providers/index.ts", () => ({ getProvider: fakes.getProvider }));
vi.mock("../../providers/instance-registry.ts", () => ({
  getInstanceType: fakes.getInstanceType,
  getInstancesByType: fakes.getInstancesByType,
}));
vi.mock("../../utils/ModelResolution.ts", () => ({ resolveModelForInstances: fakes.resolveModelForInstances }));
vi.mock("../../utils/CleanupRegistry.ts", () => ({ registerCleanup: vi.fn() }));
vi.mock("../../utils/logger.ts", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

import RequestLogger from "../RequestLogger.ts";
import AgentPersonaRegistry from "../AgentPersonaRegistry.ts";
import ChangeStreamService from "../ChangeStreamService.ts";
import BackgroundHousekeepingService from "../BackgroundHousekeepingService.ts";
import { ExperimentService } from "../ExperimentService.ts";
import { webExtractAnswered, __resetWebExtractForTests } from "../WebExtractService.ts";

type Any = Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  fakes.getPricing.mockReturnValue({ "model-x": { inputPerMillion: 1000, outputPerMillion: 2000 } });
  fakes.webhookEmit.mockReturnValue(undefined);
  fakes.minioAvailable.mockReturnValue(false);
  fakes.minioListObjects.mockResolvedValue([]);
  fakes.minioRemove.mockResolvedValue(undefined);
  fakes.readdir.mockRejectedValue(new Error("no such dir"));
  fakes.stat.mockResolvedValue({ isDirectory: () => true, mtimeMs: 0 });
  fakes.rm.mockResolvedValue(undefined);
  fakes.getModelByName.mockReturnValue({ label: "Model X", maxOutputTokens: 8192 });
  fakes.settingsGetSection.mockResolvedValue({ extractionProvider: "lm-studio", extractionModel: "extract-model" });
  fakes.resolveAuxModel.mockReturnValue({ provider: "aux", model: "aux-model" });
  fakes.getAuxSelectionStats.mockReturnValue({});
  fakes.getInstanceType.mockReturnValue("lm-studio");
  fakes.getInstancesByType.mockReturnValue([{ id: "lm-studio" }]);
  fakes.resolveModelForInstances.mockResolvedValue({ usable: [{ id: "lm-studio" }], modelOverrides: new Map() });
  fakes.getProvider.mockReturnValue({ generateText: vi.fn(async () => ({ text: "answered from page" })) });
  __resetWebExtractForTests();
});

describe("RequestLogger.logBackgroundLlmCall", () => {
  const insertions: Any[] = [];
  const collection = {
    insertOne: vi.fn(async (document: Any) => {
      insertions.push(document);
      return { acknowledged: true };
    }),
  };

  beforeEach(() => {
    insertions.length = 0;
    fakes.getDb.mockReturnValue({ collection: vi.fn(() => collection) });
  });

  it("logs a background call with heuristic tokens, cost and payloads", async () => {
    await RequestLogger.logBackgroundLlmCall({
      requestId: "req-1",
      endpoint: "/agent",
      operation: "agent:system-reminder",
      project: "proj",
      username: null,
      agent: null,
      provider: "lm-studio",
      model: "model-x",
      traceId: null,
      conversationId: "conv-1",
      agentConversationId: "ac-1",
      aiMessages: [{ role: "user", content: "12345678" }] as never,
      resultText: "1234",
      success: true,
      errorMessage: null,
      requestStartMs: performance.now() - 1000,
      extraRequestPayload: { teamName: "t" },
    });

    expect(insertions).toHaveLength(1);
    const document = insertions[0];
    expect(document).toMatchObject({
      requestId: "req-1",
      operation: "agent:system-reminder",
      username: "system",
      inputTokens: 2,
      outputTokens: 1,
      inputCharacters: 8,
      modalities: { textIn: true, textOut: true },
      status: "completed",
      success: true,
      agentConversationId: "ac-1",
    });
    expect(document.estimatedCost).toBe(0.004);
    expect(document.requestPayload).toMatchObject({ operation: "agent:system-reminder", teamName: "t" });
    expect(document.responsePayload).toEqual({ textPreview: "1234" });
    expect(fakes.webhookEmit).toHaveBeenCalledWith("request.created", expect.objectContaining({ requestId: "req-1" }));
  });

  it("prefers API usage over the heuristic", async () => {
    await RequestLogger.logBackgroundLlmCall({
      requestId: "req-2",
      endpoint: null,
      operation: "op",
      project: null,
      username: "alice",
      agent: "CODING",
      provider: "online",
      model: "unknown-model",
      traceId: null,
      conversationId: null,
      agentConversationId: null,
      aiMessages: [{ role: "user", content: "x".repeat(400) }] as never,
      resultText: "ignored",
      usage: { inputTokens: 7, outputTokens: 3, cacheReadInputTokens: 2, cacheCreationInputTokens: 0 },
      success: false,
      errorMessage: "boom",
      requestStartMs: performance.now() - 500,
    });

    const document = insertions[0];
    expect(document).toMatchObject({
      inputTokens: 9,
      outputTokens: 3,
      cacheReadInputTokens: 2,
      success: false,
      errorMessage: "boom",
      estimatedCost: null,
    });
    expect(document.responsePayload).toEqual({ error: "boom" });
    expect(document.cacheCreationInputTokens).toBeUndefined();
  });

  it("returns quietly when MongoDB is unavailable", async () => {
    fakes.getDb.mockReturnValue(null);
    await expect(
      RequestLogger.logBackgroundLlmCall({
        requestId: "req-3",
        endpoint: null,
        operation: "op",
        project: null,
        username: "alice",
        agent: null,
        provider: "p",
        model: "m",
        traceId: null,
        conversationId: null,
        agentConversationId: null,
        aiMessages: [] as never,
        resultText: "",
        success: true,
        errorMessage: null,
        requestStartMs: performance.now(),
      }),
    ).resolves.toBeUndefined();
    expect(fakes.webhookEmit).not.toHaveBeenCalled();
  });

  it("swallows insert failures", async () => {
    collection.insertOne.mockRejectedValueOnce(new Error("write failed"));
    await expect(
      RequestLogger.logBackgroundLlmCall({
        requestId: "req-4",
        endpoint: null,
        operation: "op",
        project: null,
        username: "alice",
        agent: null,
        provider: "p",
        model: "m",
        traceId: null,
        conversationId: null,
        agentConversationId: null,
        aiMessages: [] as never,
        resultText: "",
        success: true,
        errorMessage: null,
        requestStartMs: performance.now(),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("RequestLogger.logChatGeneration", () => {
  const insertions: Any[] = [];
  const collection = {
    insertOne: vi.fn(async (document: Any) => {
      insertions.push(document);
      return { acknowledged: true };
    }),
  };

  beforeEach(() => {
    insertions.length = 0;
    fakes.getDb.mockReturnValue({ collection: vi.fn(() => collection) });
  });

  it("builds modalities, canonical tool telemetry, option fields and payloads", async () => {
    await RequestLogger.logChatGeneration({
      requestId: "chat-1",
      endpoint: "/chat",
      operation: "chat",
      project: "proj",
      username: "alice",
      agent: "CODING",
      harness: null,
      provider: "lm-studio",
      model: "model-x",
      conversationId: "conv-1",
      success: true,
      usage: { inputTokens: 100, outputTokens: 40, reasoningOutputTokens: 5 },
      timeToGenerationSec: 0.5123,
      generationSec: 2.4567,
      totalSec: 3,
      options: {
        temperature: 0.2,
        maxTokens: 4096,
        topP: 0.9,
        topK: 40,
        frequencyPenalty: 0.1,
        presencePenalty: 0.2,
        stopSequences: ["STOP"],
        harness: "ReActHarness",
        tools: [{ name: "read_file" }, { function: { name: "list_dir" } }],
        _loadedContextLength: 32_000,
        contextLength: 16_000,
        eval_batch_size: 512,
        _loadedEvalBatchSize: 256,
      },
      messages: [
        { role: "user", content: "look", images: ["minio://img"] },
        { role: "assistant", content: "ok" },
      ] as never,
      text: "final answer",
      thinking: "reasoning",
      images: ["minio://out"],
      toolCalls: [{ id: "t1", name: "web_search", args: { query: "x" } }] as never,
      audioRef: "minio://audio",
      agenticIteration: 2,
      rateLimits: { remaining: 5 },
    });

    const document = insertions[0];
    expect(document).toMatchObject({
      requestId: "chat-1",
      harness: "ReActHarness",
      toolsUsed: true,
      toolDisplayNames: ["Web Search"],
      toolApiNames: ["web_search"],
      toolApiNameCount: 1,
      success: true,
      inputTokens: 100,
      outputTokens: 40,
      reasoningOutputTokens: 5,
      temperature: 0.2,
      maxTokens: 4096,
      topP: 0.9,
      topK: 40,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
      stopSequences: ["STOP"],
      contextLength: 32_000,
      evalBatchSize: 256,
      physicalBatchSize: 512,
      messageCount: 2,
      inputCharacters: 6,
      timeToGeneration: 0.512,
      generationTime: 2.457,
      totalTime: 3,
      rateLimits: { remaining: 5 },
    });
    expect(document.modalities).toMatchObject({
      textIn: true,
      textOut: true,
      imageIn: true,
      imageOut: true,
      audioIn: false,
      thinking: true,
      webSearch: false,
      functionCalling: true,
    });
    expect(document.requestPayload).toEqual({
      messages: [
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({ role: "assistant" }),
      ],
      tools: ["read_file", "list_dir"],
      agenticIteration: 2,
    });
    expect(document.responsePayload).toEqual({
      text: "final answer",
      thinking: "reasoning",
      images: ["minio://out"],
      toolCalls: [{ name: "Web Search", id: "t1", args: { query: "x" } }],
      audioRef: "minio://audio",
      usage: { inputTokens: 100, outputTokens: 40, reasoningOutputTokens: 5 },
    });
  });

  it("logs a minimal failed generation with null option fields", async () => {
    await RequestLogger.logChatGeneration({
      requestId: "chat-2",
      success: false,
      errorMessage: "provider down",
    });

    const document = insertions[0];
    expect(document).toMatchObject({
      requestId: "chat-2",
      success: false,
      errorMessage: "provider down",
      toolsUsed: false,
      toolDisplayNames: [],
      toolApiNames: [],
      messageCount: 0,
      inputCharacters: 0,
      temperature: null,
      maxTokens: null,
      topP: null,
      topK: null,
      frequencyPenalty: null,
      presencePenalty: null,
      stopSequences: null,
      timeToGeneration: null,
      generationTime: null,
      totalTime: null,
    });
    expect(document).not.toHaveProperty("contextLength");
    expect(document).not.toHaveProperty("evalBatchSize");
    expect(document).not.toHaveProperty("physicalBatchSize");
    expect(document.requestPayload).toEqual({ messages: [] });
    expect(document.responsePayload).toMatchObject({ text: null, thinking: null, toolCalls: null });
    expect(document.responsePayload).not.toHaveProperty("images");
    expect(document.responsePayload).not.toHaveProperty("audioRef");
  });

  it("skips logging when MongoDB is unavailable", async () => {
    fakes.getDb.mockReturnValue(null);
    await RequestLogger.logChatGeneration({ requestId: "chat-3" });
    expect(insertions).toHaveLength(0);
  });
});

describe("RequestLogger.insertPending and completePending", () => {
  const pendingId = { toString: () => "oid-pending" };
  const collection = {
    insertOne: vi.fn(async () => ({ insertedId: pendingId })),
    updateOne: vi.fn(async () => ({ matchedCount: 1 })),
  };

  beforeEach(() => {
    collection.insertOne.mockClear();
    collection.updateOne.mockClear();
    collection.insertOne.mockResolvedValue({ insertedId: pendingId });
    collection.updateOne.mockResolvedValue({ matchedCount: 1 });
    fakes.getDb.mockReturnValue({ collection: vi.fn(() => collection) });
  });

  it("inserts a minimal pending document and returns its id", async () => {
    const id = await RequestLogger.insertPending({
      requestId: "pending-1",
      operation: "chat",
      agent: "CODING",
      agentConversationId: "ac-1",
      agenticIteration: 3,
    });

    expect(id).toBe(pendingId);
    const document = collection.insertOne.mock.calls[0][0] as Any;
    expect(document).toMatchObject({
      requestId: "pending-1",
      operation: "chat",
      agent: "CODING",
      agentConversationId: "ac-1",
      agenticIteration: 3,
      status: "pending",
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: null,
      success: null,
    });
    expect(document.createdAt).toBe(document.timestamp);
    expect(document).not.toHaveProperty("parentAgentConversationId");
  });

  it("returns null without MongoDB", async () => {
    fakes.getDb.mockReturnValue(null);
    await expect(RequestLogger.insertPending({ requestId: "pending-2" })).resolves.toBeNull();
  });

  it("returns null when the insert fails", async () => {
    collection.insertOne.mockRejectedValue(new Error("write failed"));
    await expect(RequestLogger.insertPending({ requestId: "pending-3" })).resolves.toBeNull();
  });

  it("completes a pending document and emits the webhook", async () => {
    await RequestLogger.completePending(pendingId as never, {
      requestId: "pending-1",
      provider: "lm-studio",
      model: "model-x",
      success: true,
      toolApiNames: ["read_file"],
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      reasoningOutputTokens: 2,
      contextLength: 32_000,
      evalBatchSize: 512,
      physicalBatchSize: 256,
      agentConversationId: "ac-1",
      parentAgentConversationId: "parent-ac",
    });

    const update = collection.updateOne.mock.calls[0][1] as Any;
    expect(update.$set).toMatchObject({
      status: "completed",
      requestId: "pending-1",
      provider: "lm-studio",
      model: "model-x",
      success: true,
      toolApiNameCount: 1,
      agentConversationId: "ac-1",
      parentAgentConversationId: "parent-ac",
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      reasoningOutputTokens: 2,
      contextLength: 32_000,
      evalBatchSize: 512,
      physicalBatchSize: 256,
    });
    expect(fakes.webhookEmit).toHaveBeenCalledWith(
      "request.completed",
      expect.objectContaining({ _id: pendingId, status: "completed" }),
    );
    expect(collection.insertOne).not.toHaveBeenCalled();
  });

  it("omits zero cache tokens and null context fields from the update", async () => {
    await RequestLogger.completePending(pendingId as never, {
      requestId: "pending-2",
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      contextLength: null,
      evalBatchSize: null,
      physicalBatchSize: null,
    });

    const update = collection.updateOne.mock.calls[0][1] as Any;
    expect(update.$set).not.toHaveProperty("cacheReadInputTokens");
    expect(update.$set).not.toHaveProperty("cacheCreationInputTokens");
    expect(update.$set).not.toHaveProperty("reasoningOutputTokens");
    expect(update.$set).not.toHaveProperty("contextLength");
    expect(update.$set).not.toHaveProperty("agentConversationId");
    expect(update.$set.toolApiNameCount).toBe(0);
  });

  it("falls back to a full insert when the pending document is gone", async () => {
    collection.updateOne.mockResolvedValue({ matchedCount: 0 });
    await RequestLogger.completePending(pendingId as never, { requestId: "pending-3", success: true });

    expect(collection.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "pending-3", status: "completed" }),
    );
    expect(fakes.webhookEmit).not.toHaveBeenCalledWith("request.completed", expect.anything());
  });

  it("falls back to a full insert when the update throws", async () => {
    collection.updateOne.mockRejectedValue(new Error("mongo down"));
    await RequestLogger.completePending(pendingId as never, { requestId: "pending-4", success: false });

    expect(collection.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "pending-4", success: false }),
    );
  });

  it("does nothing without MongoDB", async () => {
    fakes.getDb.mockReturnValue(null);
    await RequestLogger.completePending(pendingId as never, { requestId: "pending-5" });
    expect(collection.updateOne).not.toHaveBeenCalled();
    expect(collection.insertOne).not.toHaveBeenCalled();
  });
});

describe("AgentPersonaRegistry.registerCustom", () => {
  it("ignores documents without a string agentId", () => {
    AgentPersonaRegistry.registerCustom({} as never);
    AgentPersonaRegistry.registerCustom({ agentId: 42 } as never);
    expect(AgentPersonaRegistry.has("42")).toBe(false);
  });

  it("registers a custom persona with defaults and tool policy sections", () => {
    AgentPersonaRegistry.registerCustom({
      agentId: "CUSTOMBOT",
      toolPolicy: [{ content: "never touch prod", requires: ["write_file"] }],
      enabledTools: ["read_file"],
      thinkingDefault: true,
      hasSomaticState: true,
    } as never);

    const persona = AgentPersonaRegistry.get("custombot");
    expect(persona).toMatchObject({
      id: "CUSTOMBOT",
      name: "CUSTOMBOT",
      project: "prism-chat",
      custom: true,
      identity: expect.any(Function),
      availableTools: ["read_file"],
      thinkingDefault: true,
      hasSomaticState: true,
      usesDirectoryTree: false,
    });
    expect(persona!.identity({} as never)).toBe("");
    expect(typeof persona!.toolPolicy).toBe("function");
    expect(AgentPersonaRegistry.has("custombot")).toBe(true);
    expect(AgentPersonaRegistry.list().some((entry) => entry.id === "CUSTOMBOT" && entry.custom)).toBe(true);

    AgentPersonaRegistry.unregister("CUSTOMBOT");
    expect(AgentPersonaRegistry.has("custombot")).toBe(false);
  });

  it("wraps a plain tool policy string and rebuilds policy predicates", () => {
    AgentPersonaRegistry.registerCustom({
      agentId: "POLICYBOT",
      toolPolicy: "ask before deleting",
      policies: [
        { tool: "execute_shell", decision: "DENY", pattern: "^rm -rf", field: "command" },
        { tool: "*", decision: "ASK_USER", pattern: "[" },
      ],
    } as never);

    const persona = AgentPersonaRegistry.get("POLICYBOT")!;
    expect(persona.policies).toHaveLength(2);
    expect(persona.policies![0].name).toBe("DENY(execute_shell)");
    expect(persona.policies![0].when!({ command: "rm -rf /" })).toBe(true);
    expect(persona.policies![0].when!({ command: "ls" })).toBe(false);
    expect(persona.policies![1].when).toBeUndefined();

    AgentPersonaRegistry.unregister("POLICYBOT");
  });

  it("does not unregister built-in personas or unknown ids", () => {
    AgentPersonaRegistry.unregister("");
    AgentPersonaRegistry.unregister("NOT_A_REAL_AGENT");
    expect(AgentPersonaRegistry.get("")).toBeNull();
    expect(AgentPersonaRegistry.get("NOT_A_REAL_AGENT")).toBeNull();
  });

  it("recognises agent projects", () => {
    expect(AgentPersonaRegistry.isAgentProject("")).toBe(false);
    AgentPersonaRegistry.registerCustom({ agentId: "PROJBOT", project: "custom-project" } as never);
    expect(AgentPersonaRegistry.isAgentProject("custom-project")).toBe(true);
    AgentPersonaRegistry.unregister("PROJBOT");
  });
});

describe("ChangeStreamService", () => {
  const handlers = new Map<string, (event: Any) => void>();
  const streams: Array<{ on: Any; close: Any }> = [];

  const makeStream = (collectionName: string) => {
    const stream = {
      on: vi.fn((eventName: string, handler: (event: Any) => void) => {
        handlers.set(`${collectionName}:${eventName}`, handler);
      }),
      close: vi.fn(async () => {}),
    };
    streams.push(stream);
    return stream;
  };

  const makeDb = (watchImpl?: () => Any) => ({
    collection: vi.fn((collectionName: string) => ({
      watch: vi.fn(() => (watchImpl ? watchImpl() : makeStream(collectionName))),
    })),
  });

  beforeEach(() => {
    handlers.clear();
    streams.length = 0;
  });

  it("stays unavailable when Change Streams are unsupported", async () => {
    fakes.getDb.mockReturnValue(makeDb(() => { throw new Error("not a replica set"); }));
    await ChangeStreamService.init();
    expect(ChangeStreamService.available).toBe(false);
    await ChangeStreamService.close();
  });

  it("returns early without a database", async () => {
    fakes.getDb.mockReturnValue(null);
    await ChangeStreamService.init();
    expect(ChangeStreamService.available).toBe(false);
  });

  it("broadcasts enriched conversation and request events to subscribers", async () => {
    fakes.getDb.mockReturnValue(makeDb());
    await ChangeStreamService.init();
    expect(ChangeStreamService.available).toBe(true);

    const received: Any[] = [];
    const listener = (payload: Any) => received.push(payload);
    ChangeStreamService.subscribe(listener);

    handlers.get("model_conversations:change")!({
      operationType: "update",
      documentKey: { _id: { toString: () => "oid-1" } },
      fullDocument: { id: "conv-1", isGenerating: true },
      updateDescription: { updatedFields: { title: "new", isGenerating: false } },
    });
    handlers.get("requests:change")!({
      operationType: "insert",
      documentKey: { _id: { toString: () => "oid-2" } },
      fullDocument: { id: "req-1", conversationId: "conv-1", parentAgentConversationId: "ac-parent" },
    });

    expect(received[0]).toMatchObject({
      operationType: "update",
      documentId: "oid-1",
      id: "conv-1",
      updatedFields: ["title", "isGenerating"],
      isGenerating: false,
    });
    expect(received[1]).toMatchObject({
      operationType: "insert",
      id: "req-1",
      conversationId: "conv-1",
      parentAgentConversationId: "ac-parent",
    });
    expect(received[0].timestamp).toEqual(expect.any(String));

    ChangeStreamService.unsubscribe(listener);
    handlers.get("requests:change")!({ operationType: "delete", documentKey: { _id: { toString: () => "oid-3" } } });
    expect(received).toHaveLength(2);

    await ChangeStreamService.close();
    expect(ChangeStreamService.available).toBe(false);
    expect(streams.every((entry) => entry.close.mock.calls.length > 0)).toBe(true);
  });

  it("isolates a throwing listener", async () => {
    fakes.getDb.mockReturnValue(makeDb());
    await ChangeStreamService.init();

    const received: Any[] = [];
    ChangeStreamService.subscribe(() => { throw new Error("listener blew up"); });
    ChangeStreamService.subscribe((payload) => received.push(payload));

    handlers.get("requests:change")!({ operationType: "insert", documentKey: { _id: { toString: () => "oid-4" } } });
    expect(received).toHaveLength(1);

    await ChangeStreamService.close();
  });

  it("re-opens a stream after an error", async () => {
    vi.useFakeTimers();
    fakes.getDb.mockReturnValue(makeDb());
    await ChangeStreamService.init();

    handlers.get("model_conversations:error")!(new Error("stream died"));
    await vi.advanceTimersByTimeAsync(5000);

    expect(streams.length).toBeGreaterThan(3);
    await ChangeStreamService.close();
    vi.useRealTimers();
  });
});

describe("BackgroundHousekeepingService.run", () => {
  const asyncCursor = (documents: Any[]) => ({
    [Symbol.asyncIterator]: async function* () {
      for (const document of documents) yield document;
    },
  });

  const makeDb = ({ conversations = [], agentConversations = [], deletedLogs = 5, modified = 1 }: Any = {}) => ({
    collection: vi.fn((name: string) => ({
      find: vi.fn(() => asyncCursor(name === "model_conversations" ? conversations : agentConversations)),
      updateMany: vi.fn(async () => ({ modifiedCount: modified })),
      deleteMany: vi.fn(async () => ({ deletedCount: deletedLogs })),
    })),
  });

  it("runs every task and reports their results", async () => {
    fakes.getDb.mockReturnValue(makeDb({ conversations: [{ id: "conv-1" }], agentConversations: [{ id: "conv-2" }] }));
    fakes.minioAvailable.mockReturnValue(true);
    fakes.minioListObjects.mockResolvedValue([
      "projects/p/u/up/x.png",
      "uploads/u/y.png",
      "conv-1/a.txt",
      "orphan-1/b.txt",
      "orphan-1/c.txt",
    ]);

    const result = await BackgroundHousekeepingService.run({ trigger: "boot" });

    expect(result.trigger).toBe("boot");
    expect(result.worktrees).toEqual({ pruned: [], errors: [] });
    expect(result.staleConversations).toEqual({ conversationsCleared: 1, agentConversationsCleared: 1 });
    expect(result.requestLogs).toEqual({ deleted: 5 });
    expect(result.minioOrphans).toEqual({ removed: 2 });
    expect(fakes.minioRemove).toHaveBeenCalledWith("orphan-1/b.txt");
    expect(fakes.minioRemove).toHaveBeenCalledWith("orphan-1/c.txt");
    expect(typeof result.durationMs).toBe("number");
  });

  it("prunes worktrees older than the cutoff and records stat errors", async () => {
    fakes.readdir.mockResolvedValue(["old-wt", "fresh-wt", "file.txt", "broken-wt"]);
    fakes.stat.mockImplementation(async (targetPath: string) => {
      if (targetPath.endsWith("broken-wt")) throw new Error("stat failed");
      if (targetPath.endsWith("file.txt")) return { isDirectory: () => false, mtimeMs: 0 };
      return { isDirectory: () => true, mtimeMs: targetPath.endsWith("old-wt") ? 0 : Date.now() };
    });
    fakes.getDb.mockReturnValue(makeDb());

    const result = await BackgroundHousekeepingService.run();

    expect(result.worktrees).toEqual({ pruned: ["old-wt"], errors: ["broken-wt: stat failed"] });
    expect(fakes.rm).toHaveBeenCalledWith(expect.stringContaining("old-wt"), { recursive: true, force: true });
  });

  it("records per-task failures without aborting the run", async () => {
    fakes.readdir.mockRejectedValue(new Error("no dir"));
    fakes.getDb.mockReturnValue(null);
    fakes.minioAvailable.mockReturnValue(true);
    fakes.minioListObjects.mockRejectedValue(new Error("minio down"));

    const result = await BackgroundHousekeepingService.run();

    expect(result.worktrees).toEqual({ pruned: [], errors: [] });
    expect(result.staleConversations).toEqual({ conversationsCleared: 0, agentConversationsCleared: 0 });
    expect(result.requestLogs).toEqual({ deleted: 0 });
    expect(result.minioOrphans).toEqual({ removed: 0 });
  });

  it("skips the MinIO scan when MinIO is unavailable", async () => {
    fakes.minioAvailable.mockReturnValue(false);
    fakes.getDb.mockReturnValue(makeDb());

    const result = await BackgroundHousekeepingService.run();

    expect(result.minioOrphans).toEqual({ removed: 0 });
    expect(fakes.minioListObjects).not.toHaveBeenCalled();
  });
});

describe("ExperimentService.runExperiment", () => {
  const request = (overrides: Any = {}) => ({
    benchmark: { id: "b1", name: "bench", prompt: "do it" },
    baseline: { provider: "lm-studio", model: "base-model" },
    candidate: { provider: "lm-studio", model: "candidate-model", display_name: "Candidate" },
    trials: 20,
    minDetectableEffect: 0.2,
    ...overrides,
  });

  it("reports improved when the candidate wins every trial with enough power", async () => {
    fakes.runSingleModel.mockImplementation(async (_benchmark: Any, entry: Any) => ({
      passed: entry.model === "candidate-model",
      latency: 100,
      usage: { total_tokens: 10 },
    }));

    const result = await ExperimentService.runExperiment(request() as never);

    expect(result).toMatchObject({
      powerOk: true,
      requiredTrials: 20,
      delta: 1,
      outcome: "improved",
    });
    expect(result.baseline).toMatchObject({ trials: 20, passed: 0, passRate: 0, meanLatencyMs: 100 });
    expect(result.candidate).toMatchObject({ trials: 20, passed: 20, passRate: 1 });
    expect(result.candidate.target).toMatchObject({ display_name: "Candidate" });
    expect(result.pairedDeltas).toHaveLength(20);
    expect(result.ciLower).toBeGreaterThan(0);
  });

  it("reports regressed when the candidate loses every trial", async () => {
    fakes.runSingleModel.mockImplementation(async (_benchmark: Any, entry: Any) => ({
      passed: entry.model === "base-model",
    }));

    const result = await ExperimentService.runExperiment(request() as never);
    expect(result.outcome).toBe("regressed");
    expect(result.ciUpper).toBeLessThan(0);
  });

  it("reports inconclusive below the power requirement", async () => {
    fakes.runSingleModel.mockResolvedValue({ passed: true });
    const result = await ExperimentService.runExperiment(request({ trials: 3 }) as never);
    expect(result).toMatchObject({ powerOk: false, outcome: "inconclusive", requiredTrials: 20 });
  });

  it("reports neutral when both arms perform identically", async () => {
    fakes.runSingleModel.mockResolvedValue({ passed: true });
    const result = await ExperimentService.runExperiment(
      request({ trials: 20, minDetectableEffect: 0.2 }) as never,
    );
    expect(result.powerOk).toBe(true);
    expect(result.delta).toBe(0);
    expect(result.ciLower).toBe(0);
    expect(result.ciUpper).toBe(0);
    expect(result.outcome).toBe("neutral");
  });

  it("stops early when the signal is aborted", async () => {
    const controller = new AbortController();
    fakes.runSingleModel.mockImplementation(async () => {
      controller.abort();
      return { passed: true };
    });
    const result = await ExperimentService.runExperiment(request({ signal: controller.signal }) as never);
    expect(result.baseline.trials).toBe(1);
    expect(result.candidate.trials).toBe(1);
  });

  it("collects failure reasons and defaults missing usage to zero", async () => {
    fakes.runSingleModel.mockImplementation(async (_benchmark: Any, entry: Any) => ({
      passed: false,
      error: `${entry.model} failed`,
    }));
    const result = await ExperimentService.runExperiment(request({ trials: 20 }) as never);
    expect(result.baseline.failures).toHaveLength(10);
    expect(result.baseline.failures[0]).toBe("base-model failed");
    expect(result.baseline.meanTokens).toBe(0);
    expect(result.label).toMatch(/^experiment-/);
  });
});

describe("webExtractAnswered", () => {
  const deps = (content: string) => ({
    fetch: vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, content, engine_used: "http" }),
      text: async () => "",
    })),
    now: () => Date.now(),
  });

  it("answers from the extracted page with the configured model", async () => {
    const generateText = vi.fn(async () => ({ text: "  grounded answer  " }));
    fakes.getProvider.mockReturnValue({ generateText });

    const result = await webExtractAnswered(
      "https://example.com/page",
      "What is the main point?",
      15_000,
      deps("The main point is X.") as never,
    );

    expect(result).toMatchObject({
      url: "https://example.com/page",
      answer: "grounded answer",
      truncated: false,
      engine_used: "http",
    });
    expect(result.content).toBeUndefined();
    expect(generateText).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: "system" }),
        expect.objectContaining({ role: "user", content: expect.stringContaining("The main point is X.") }),
      ]),
      "extract-model",
      expect.objectContaining({ maxTokens: 1024, thinkingEnabled: false }),
    );
  });

  it("returns the deterministic content when no question is given", async () => {
    const result = await webExtractAnswered("https://example.com/no-question", "   ", 15_000, deps("Page text.") as never);
    expect(result).toMatchObject({ answer: "Page text.", content: "Page text.", cached: false });
  });

  it("degrades to the extract when the extract itself failed", async () => {
    const result = await webExtractAnswered("https://example.com/extract-failed", "q", 15_000, deps("") as never);
    expect(result).toMatchObject({ answer: "", error: expect.any(String) });
  });

  it("falls back to the aux model when settings have no extraction model", async () => {
    fakes.settingsGetSection.mockResolvedValue({});
    fakes.resolveModelForInstances.mockResolvedValue({ usable: [{ id: "aux" }], modelOverrides: new Map([["aux", "aux-quant"]]) });

    const result = await webExtractAnswered("https://example.com/aux-fallback", "q", 15_000, deps("Some content.") as never);
    expect(result.answer).toBe("answered from page");
    expect(result.content).toBeUndefined();
    expect(fakes.resolveAuxModel).toHaveBeenCalledWith("web");
  });

  it("degrades when no aux model can be resolved", async () => {
    fakes.settingsGetSection.mockResolvedValue({});
    fakes.resolveAuxModel.mockImplementation(() => { throw new Error("none online"); });

    const result = await webExtractAnswered("https://example.com/no-aux", "q", 15_000, deps("Some content.") as never);
    expect(result).toMatchObject({ answer: "Some content.", content: "Some content." });
  });

  it("degrades when the model returns an empty answer", async () => {
    fakes.getProvider.mockReturnValue({ generateText: vi.fn(async () => ({ text: "   " })) });
    const result = await webExtractAnswered("https://example.com/empty-answer", "q", 15_000, deps("Some content.") as never);
    expect(result).toMatchObject({ answer: "Some content.", content: "Some content." });
  });

  it("degrades when the Q&A provider call throws", async () => {
    fakes.getProvider.mockReturnValue({ generateText: vi.fn(async () => { throw new Error("provider down"); }) });
    const result = await webExtractAnswered("https://example.com/provider-throws", "q", 15_000, deps("Some content.") as never);
    expect(result).toMatchObject({ answer: "Some content.", content: "Some content." });
  });

  it("degrades when the model is not loaded anywhere", async () => {
    fakes.resolveModelForInstances.mockResolvedValue({ usable: [], modelOverrides: new Map() });
    const result = await webExtractAnswered("https://example.com/not-loaded", "q", 15_000, deps("Some content.") as never);
    expect(result).toMatchObject({ answer: "Some content.", content: "Some content." });
  });
});

