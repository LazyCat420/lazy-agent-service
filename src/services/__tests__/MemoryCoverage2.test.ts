/**
 * MemoryService + MemoryExtractor — coverage of store/dedup, fact extraction,
 * similarity search, listing, updates, prompt formatting, the extraction
 * watermark path and the afterResponse hook. Mongo, the embedding provider,
 * the LLM provider, settings, watermark storage and telemetry are fakes; the
 * services and their parsing/normalisation helpers are real, and assertions
 * read the persisted documents and returned values.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_IDS, STATUS_MESSAGES, SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";

const fakes = vi.hoisted(() => ({
  generateEmbedding: vi.fn(),
  getMemoryModelConfig: vi.fn(),
  getSection: vi.fn(),
  getProvider: vi.fn(),
  generateText: vi.fn(),
  localeGet: vi.fn(),
  logBackgroundLlmCall: vi.fn(),
  checkAndRun: vi.fn(),
  readWatermark: vi.fn(),
  writeWatermark: vi.fn(),
  selectExtractionSpan: vi.fn(),
  runWithRequestPriority: vi.fn(),
  getCollection: vi.fn(),
  getDb: vi.fn(),
  getInstanceType: vi.fn(),
  getInstancesByType: vi.fn(),
  resolveModelForInstances: vi.fn(),
  getPricing: vi.fn(),
}));

vi.mock("../../config.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MONGO_DB_NAME: "test-db",
  getPricing: fakes.getPricing,
}));
vi.mock("../../wrappers/MongoWrapper.ts", () => ({
  default: { getCollection: fakes.getCollection, getDb: fakes.getDb },
}));
vi.mock("../EmbeddingService.ts", () => ({
  default: { generate: fakes.generateEmbedding },
}));
vi.mock("../SettingsService.ts", () => ({
  default: { getMemoryModelConfig: fakes.getMemoryModelConfig, getSection: fakes.getSection },
}));
vi.mock("../../providers/index.ts", () => ({ getProvider: fakes.getProvider }));
vi.mock("../../providers/instance-registry.ts", () => ({
  getInstanceType: fakes.getInstanceType,
  getInstancesByType: fakes.getInstancesByType,
}));
vi.mock("../../utils/ModelResolution.ts", () => ({
  resolveModelForInstances: fakes.resolveModelForInstances,
}));
vi.mock("../PromptLocaleService.ts", () => ({
  default: { get: fakes.localeGet },
}));
vi.mock("../RequestLogger.ts", () => ({
  default: { logBackgroundLlmCall: fakes.logBackgroundLlmCall },
}));
vi.mock("../MemoryConsolidationService.ts", () => ({
  default: { checkAndRun: fakes.checkAndRun },
}));
vi.mock("../memory/ExtractionWatermark.ts", () => ({
  readWatermark: fakes.readWatermark,
  writeWatermark: fakes.writeWatermark,
  selectExtractionSpan: fakes.selectExtractionSpan,
}));
vi.mock("../RequestPriority.ts", () => ({
  runWithRequestPriority: fakes.runWithRequestPriority,
}));
vi.mock("../../utils/logger.ts", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

import MemoryService from "../MemoryService.ts";
import MemoryExtractor from "../MemoryExtractor.ts";

const SPACE = "test:3:";

type Doc = Record<string, unknown>;

/** Chainable fake collection whose find/aggregate results are supplied per test. */
let findResults: Doc[][];
let aggregateResults: Doc[][];
let inserted: Doc[];
let updated: Array<{ filter: Doc; update: Doc }>;
let findOneResult: Doc | null;
let deletedCount: number;
let indexes: Doc[];
let countTotal: number;

function chain(result: Doc[]) {
  const builder: Record<string, unknown> = {
    toArray: async () => structuredClone(result),
    project: () => builder,
    sort: () => builder,
    limit: () => builder,
    skip: () => builder,
  };
  return builder;
}

const collection = {
  find: () => chain(findResults.shift() ?? []),
  insertOne: async (doc: Doc) => {
    inserted.push(structuredClone(doc));
    return { acknowledged: true };
  },
  countDocuments: async () => countTotal,
  aggregate: () => chain(aggregateResults.shift() ?? []),
  deleteOne: async () => ({ deletedCount }),
  findOne: async () => structuredClone(findOneResult),
  updateOne: async (filter: Doc, update: Doc) => {
    updated.push({ filter, update });
    return { modifiedCount: 1 };
  },
  createIndex: async (spec: Doc) => {
    indexes.push(spec);
    return "idx";
  },
};

const vec = (x: number) => ({ embedding: [x, 1 - x, 0], space: SPACE });

beforeEach(() => {
  vi.clearAllMocks();
  findResults = [];
  aggregateResults = [];
  inserted = [];
  updated = [];
  indexes = [];
  findOneResult = null;
  deletedCount = 0;
  countTotal = 0;
  fakes.getCollection.mockReturnValue(collection);
  fakes.generateEmbedding.mockResolvedValue(vec(1));
  fakes.getMemoryModelConfig.mockResolvedValue({ provider: "lm-studio", model: "chat-model" });
  fakes.getSection.mockResolvedValue({ extractionProvider: "lm-studio", extractionModel: "chat-model", embeddingModel: "embed-model" });
  fakes.getProvider.mockReturnValue({ generateText: fakes.generateText });
  fakes.localeGet.mockImplementation((_locale: string, key: string) => `prompt:${key}`);
  fakes.readWatermark.mockResolvedValue(null);
  fakes.writeWatermark.mockResolvedValue(undefined);
  fakes.selectExtractionSpan.mockImplementation((span: Doc[]) => ({
    span,
    reason: "ok",
    hasUserAuthored: true,
  }));
  fakes.runWithRequestPriority.mockImplementation(async (_priority: string, run: () => Promise<unknown>) => run());
  fakes.getPricing.mockReturnValue({
    "chat-model": { inputPerMillion: 1, outputPerMillion: 2 },
    "embed-model": { inputPerMillion: 0.5 },
  });
  fakes.getInstanceType.mockReturnValue("lm-studio");
  fakes.getInstancesByType.mockReturnValue([{ id: "lm-studio" }]);
  fakes.resolveModelForInstances.mockResolvedValue({
    usable: [{ id: "lm-studio" }],
    modelOverrides: new Map([["lm-studio", "chat-model-v2"]]),
  });
});

describe("MemoryService.store", () => {
  it("rejects a missing agent identifier", async () => {
    await expect(MemoryService.store({ agent: "", content: "x" })).rejects.toThrow(
      "MemoryService.store requires an agent identifier",
    );
  });

  it("rejects empty content", async () => {
    await expect(MemoryService.store({ agent: AGENT_IDS.CODING, content: "" })).rejects.toThrow(
      "MemoryService.store requires content",
    );
  });

  it("persists a coding memory and coerces an unknown type to project", async () => {
    const stored = await MemoryService.store({
      agent: AGENT_IDS.CODING,
      project: "proj",
      username: "alice",
      type: "not-a-type",
      title: "Decision",
      content: "Use the boring design",
    });

    expect(stored).toMatchObject({
      agent: AGENT_IDS.CODING,
      project: "proj",
      username: "alice",
      type: "project",
      title: "Decision",
      content: "Use the boring design",
      semanticEmbedding: { vector: [1, 0, 0], space: SPACE },
    });
    expect(stored).not.toBeNull();
    expect(typeof (stored as Doc).id).toBe("string");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ type: "project", content: "Use the boring design" });
  });

  it("keeps a valid coding memory type", async () => {
    const stored = await MemoryService.store({
      agent: AGENT_IDS.CODING,
      type: "feedback",
      content: "Never mock the database",
    });
    expect(stored).toMatchObject({ type: "feedback" });
  });

  it("generates the embedding with every provenance option and embeds title + content", async () => {
    await MemoryService.store({
      agent: "LUPOS",
      project: "proj",
      username: "bob",
      title: "Prefs",
      content: "likes tea",
      conversationId: "conv-1",
      traceId: "trace-1",
      agentConversationId: "ac-1",
      endpoint: "/agent",
    });

    expect(fakes.generateEmbedding).toHaveBeenCalledWith("Prefs: likes tea", {
      source: "memory",
      taskType: "RETRIEVAL_DOCUMENT",
      project: "proj",
      conversationId: "conv-1",
      traceId: "trace-1",
      agentConversationId: "ac-1",
      endpoint: "/agent",
      agent: "LUPOS",
      username: "bob",
    });
    expect(inserted[0]).toMatchObject({
      conversationId: "conv-1",
      agentConversationId: "ac-1",
      project: "proj",
      username: "bob",
      type: "other",
    });
  });

  it("skips a near-duplicate memory and returns null", async () => {
    findResults.push([{ semanticEmbedding: { vector: [1, 0, 0], space: SPACE } }]);
    const stored = await MemoryService.store({ agent: "LUPOS", content: "same fact" });
    expect(stored).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  it("ignores legacy vectors from another embedding space when deduplicating", async () => {
    findResults.push([{ semanticEmbedding: { vector: [1, 0, 0], space: "old:3:" } }]);
    const stored = await MemoryService.store({ agent: "LUPOS", content: "fresh fact" });
    expect(stored).not.toBeNull();
    expect(inserted).toHaveLength(1);
  });
});

describe("MemoryService.extractAndStore", () => {
  it("returns an empty list when the model extracts no facts", async () => {
    fakes.generateText.mockResolvedValue({ text: "[]" });
    const stored = await MemoryService.extractAndStore({
      guildId: "g1",
      messages: [{ role: "user", content: "hi" }],
      participants: [{ id: "u1", username: "alice" }],
    });
    expect(stored).toEqual([]);
  });

  it("returns an empty list when the model answer is not a JSON array", async () => {
    fakes.generateText.mockResolvedValue({ text: '{"oops": true}' });
    expect(await MemoryService.extractAndStore({ messages: [], participants: [] })).toEqual([]);
  });

  it("stores facts above the confidence floor and drops low-confidence ones", async () => {
    fakes.generateText.mockResolvedValue({
      text: JSON.stringify([
        { fact: "alice prefers tea", aboutUserId: "u1", aboutUsername: "alice", confidence: 0.9, category: "preference" },
        { fact: "bob prefers coffee", aboutUserId: "u2", aboutUsername: "bob", confidence: 0.2 },
        { fact: "no user id", aboutUsername: "carol", confidence: 0.9 },
      ]),
    });

    const stored = await MemoryService.extractAndStore({
      guildId: "g1",
      channelId: "c1",
      messages: [{ name: "alice", content: "I like tea" }],
      participants: [{ id: "u1", username: "alice", displayName: "Alice" }],
      sourceMessageId: "msg-1",
      traceId: "trace-1",
      project: "proj",
      endpoint: "/agent",
    });

    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      agent: "LUPOS",
      project: "proj",
      type: "preference",
      content: "alice prefers tea",
      guildId: "g1",
      channelId: "c1",
      aboutUserId: "u1",
      aboutUsername: "alice",
      confidence: 0.9,
      sourceMessageId: "msg-1",
    });
    expect(fakes.logBackgroundLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "memory:extract", success: true, project: "proj" }),
    );
  });

  it("propagates provider failures and logs the failed call", async () => {
    fakes.generateText.mockRejectedValue(new Error("provider down"));
    await expect(
      MemoryService.extractAndStore({ messages: [], participants: [] }),
    ).rejects.toThrow("provider down");
    expect(fakes.logBackgroundLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, errorMessage: "provider down" }),
    );
  });

  it("continues past a per-fact storage failure and keeps the others", async () => {
    fakes.generateText.mockResolvedValue({
      text: JSON.stringify([
        { fact: "first fact", aboutUserId: "u1", aboutUsername: "alice", confidence: 0.9 },
        { fact: "second fact", aboutUserId: "u2", aboutUsername: "bob", confidence: 0.9 },
      ]),
    });
    const originalInsert = collection.insertOne;
    let calls = 0;
    collection.insertOne = async (doc: Doc) => {
      calls += 1;
      if (calls === 1) throw new Error("write conflict");
      inserted.push(structuredClone(doc));
      return { acknowledged: true };
    };
    try {
      const stored = await MemoryService.extractAndStore({ messages: [], participants: [] });
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ content: "second fact" });
    } finally {
      collection.insertOne = originalInsert;
    }
  });
});

describe("MemoryService.search", () => {
  it("requires an agent identifier", async () => {
    await expect(MemoryService.search({ agent: "", queryText: "q" })).rejects.toThrow(
      "MemoryService.search requires an agent identifier",
    );
  });

  it("returns nothing when the collection is empty", async () => {
    findResults.push([]);
    expect(await MemoryService.search({ agent: "LUPOS", queryText: "tea" })).toEqual([]);
  });

  it("scores, filters by relevance and sorts descending", async () => {
    findResults.push([
      { _id: "a", type: "user", title: null, content: "strong match about tea", createdAt: new Date().toISOString(), semanticEmbedding: { vector: [1, 0, 0], space: SPACE } },
      { _id: "b", type: "user", content: "weak match", createdAt: new Date().toISOString(), semanticEmbedding: { vector: [0.1, 0.9, 0], space: SPACE } },
      { _id: "c", content: "legacy vector", createdAt: new Date().toISOString(), semanticEmbedding: { vector: [1, 0, 0], space: "old:3:" } },
      { _id: "d", content: "untitled", createdAt: new Date().toISOString(), semanticEmbedding: { vector: [0.5, 0.5, 0], space: SPACE } },
    ]);

    const results = await MemoryService.search({
      agent: "LUPOS",
      guildId: "g1",
      userIds: ["u1", "u2"],
      queryText: "tea",
      limit: 2,
      project: "proj",
      conversationId: "conv-1",
      traceId: "trace-1",
      agentConversationId: "ac-1",
      endpoint: "/agent",
      username: "alice",
    });

    expect(results.map((row) => row.id)).toEqual(["a", "d"]);
    expect(results[0]).toMatchObject({
      type: "user",
      title: "strong match about tea",
      content: "strong match about tea",
      age: "today",
      ageDays: 0,
    });
    expect(results[0].score).toBeCloseTo(1, 5);
    expect(results[1]).toMatchObject({ title: "untitled", type: "other" });
  });
});

describe("MemoryService list / discover / delete / update / format / indexes", () => {
  it("lists memories with filters and the total count", async () => {
    findResults.push([{ id: "m1" }]);
    countTotal = 7;
    const result = await MemoryService.list({
      agent: "LUPOS",
      project: "proj",
      guildId: "g1",
      userId: "u1",
      type: "user",
      limit: 5,
      skip: 10,
    });
    expect(result).toEqual({ memories: [{ id: "m1" }], total: 7 });
  });

  it("aggregates discoverable project/agent combos", async () => {
    aggregateResults.push([{ project: "proj", agent: "CODING", count: 3 }]);
    expect(await MemoryService.discoverCombos()).toEqual([
      { project: "proj", agent: "CODING", count: 3 },
    ]);
  });

  it("deletes a memory and reports whether a document was removed", async () => {
    deletedCount = 1;
    expect(await MemoryService.delete("m1")).toBe(true);
    deletedCount = 0;
    expect(await MemoryService.delete("m2")).toBe(false);
  });

  it("remove delegates to delete", async () => {
    deletedCount = 1;
    expect(await MemoryService.remove("m1")).toBe(true);
  });

  it("re-embeds when content changes and keeps the stored title", async () => {
    findOneResult = { project: "proj", title: "Old title", content: "old body" };
    const changed = await MemoryService.update("m1", { content: "new body" });
    expect(changed).toBe(true);
    expect(fakes.generateEmbedding).toHaveBeenCalledWith("Old title: new body", {
      source: "memory",
      taskType: "RETRIEVAL_DOCUMENT",
      project: "proj",
    });
    expect(updated[0].update.$set).toMatchObject({
      content: "new body",
      semanticEmbedding: { vector: [1, 0, 0], space: SPACE },
    });
    expect(updated[0].filter).toEqual({ id: "m1" });
  });

  it("embeds the bare content when no title exists and the document is gone", async () => {
    findOneResult = null;
    await MemoryService.update("m2", { title: undefined, content: "body only" });
    expect(fakes.generateEmbedding).toHaveBeenCalledWith("body only", {
      source: "memory",
      taskType: "RETRIEVAL_DOCUMENT",
      project: undefined,
    });
  });

  it("skips re-embedding when only the type changes", async () => {
    await MemoryService.update("m3", { type: "reference" });
    expect(fakes.generateEmbedding).not.toHaveBeenCalled();
    expect(updated[0].update.$set).toMatchObject({ type: "reference" });
    expect(updated[0].update.$set.semanticEmbedding).toBeUndefined();
  });

  it("formats memories for the prompt with badges, ages and staleness caveats", () => {
    expect(MemoryService.formatForPrompt([])).toBe("");
    const text = MemoryService.formatForPrompt([
      { type: "user", title: "Role", content: "engineer", age: "today", createdAt: new Date().toISOString() },
      {
        type: "project",
        title: "Deadline",
        content: "ship friday",
        age: "47 days ago",
        createdAt: new Date(Date.now() - 47 * 86_400_000).toISOString(),
      },
    ]);
    expect(text).toContain("- [user] **Role**: engineer");
    expect(text).toContain("- [project] **Deadline** (47 days ago): ship friday");
    expect(text).toContain("47 days old");
  });

  it("does nothing when no database handle exists", async () => {
    fakes.getDb.mockReturnValue(null);
    await expect(MemoryService.ensureIndexes()).resolves.toBeUndefined();
    expect(indexes).toHaveLength(0);
  });

  it("creates every index on the memories collection", async () => {
    fakes.getDb.mockReturnValue({ collection: () => collection });
    await MemoryService.ensureIndexes();
    expect(indexes).toHaveLength(6);
    expect(indexes).toContainEqual({ agent: 1, project: 1 });
    expect(indexes).toContainEqual({ id: 1 });
  });
});

// ─── MemoryExtractor ──────────────────────────────────────────────────────────

const message = (role: string, content: string, extra: Doc = {}) => ({ role, content, ...extra });

const extractionContext = (overrides: Doc = {}) => ({
  project: "proj",
  username: "alice",
  messages: [
    message("user", "Please refactor the parser"),
    message("assistant", "Done, extracted the helper"),
    message("user", "Great, also update docs"),
    message("assistant", "Docs updated"),
  ],
  agentConversationId: "ac-1",
  conversationId: "conv-1",
  endpoint: "/agent",
  agent: "CODING",
  toolCalls: [],
  emit: vi.fn(),
  activeProviderName: "lm-studio",
  activeResolvedModel: "chat-model",
  ...overrides,
});

const extractedResponse = (memories: Doc[]) => ({
  text: JSON.stringify(memories),
  usage: { inputTokens: 100, outputTokens: 20 },
});

describe("MemoryExtractor.extractAndStore — skip guards", () => {
  it("skips the isolated trading project", async () => {
    expect(await MemoryExtractor.extractAndStore(extractionContext({ project: "vllm-trading-bot" }))).toEqual([]);
    expect(fakes.generateText).not.toHaveBeenCalled();
  });

  it("skips when fewer than four messages are present", async () => {
    expect(
      await MemoryExtractor.extractAndStore(
        extractionContext({ messages: [message("user", "hi"), message("assistant", "hello")] }),
      ),
    ).toEqual([]);
    expect(fakes.generateText).not.toHaveBeenCalled();
  });

  it("skips when the main agent already saved a memory", async () => {
    expect(
      await MemoryExtractor.extractAndStore(
        extractionContext({ toolCalls: [{ name: "save_memory" }] }),
      ),
    ).toEqual([]);
    expect(fakes.generateText).not.toHaveBeenCalled();
  });

  it("skips when the settings section cannot be read", async () => {
    fakes.getSection.mockRejectedValue(new Error("no settings"));
    expect(
      await MemoryExtractor.extractAndStore(extractionContext({ activeProviderName: undefined, activeResolvedModel: undefined })),
    ).toEqual([]);
  });

  it("skips when no extraction provider/model is configured", async () => {
    fakes.getSection.mockResolvedValue({});
    expect(
      await MemoryExtractor.extractAndStore(extractionContext({ activeProviderName: undefined, activeResolvedModel: undefined })),
    ).toEqual([]);
  });

  it("skips when the watermark span is empty", async () => {
    fakes.selectExtractionSpan.mockReturnValue({ span: [], reason: "nothing-new", hasUserAuthored: true });
    expect(await MemoryExtractor.extractAndStore(extractionContext())).toEqual([]);
    expect(fakes.generateText).not.toHaveBeenCalled();
  });

  it("skips when the new span carries no user-authored message", async () => {
    fakes.selectExtractionSpan.mockReturnValue({ span: [message("assistant", "x")], reason: "ok", hasUserAuthored: false });
    expect(await MemoryExtractor.extractAndStore(extractionContext())).toEqual([]);
    expect(fakes.generateText).not.toHaveBeenCalled();
  });
});

describe("MemoryExtractor.extractAndStore — happy path", () => {
  it("extracts, stores and reports usage for new memories", async () => {
    fakes.generateText.mockResolvedValue(
      extractedResponse([
        { type: "feedback", title: "No DB mocks", content: "Never mock Mongo in tests" },
        { type: "nonsense", title: "Badge", content: "Coerced type" },
        { type: "user", title: "", content: "missing title is skipped" },
      ]),
    );

    const emit = vi.fn();
    const stored = await MemoryExtractor.extractAndStore(extractionContext({ emit }));

    expect(stored).toEqual([
      { type: "feedback", id: expect.any(String), title: "No DB mocks" },
      { type: "project", id: expect.any(String), title: "Badge" },
    ]);
    expect(inserted.map((doc) => doc.type)).toEqual(["feedback", "project"]);
    expect(fakes.writeWatermark).toHaveBeenCalledWith("conv-1", expect.any(Array));
    expect(fakes.logBackgroundLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "memory:extract",
        success: true,
        usage: { inputTokens: 100, outputTokens: 20 },
        extraRequestPayload: { messageCount: 4 },
      }),
    );

    expect(emit).toHaveBeenCalledWith({
      type: SERVER_SENT_EVENT_TYPES.USAGE_UPDATE,
      operation: "memory:extract",
      usage: { requests: 1, inputTokens: 100, outputTokens: 20, estimatedCost: expect.any(Number) },
    });
    expect(emit).toHaveBeenCalledWith({
      type: "usage_update",
      operation: "memory:embed",
      usage: { requests: 2, inputTokens: 100, outputTokens: 0, estimatedCost: 0.00005 },
    });
  });

  it("falls back to the configured provider when no sibling instance serves the model", async () => {
    fakes.resolveModelForInstances.mockResolvedValue({ usable: [], modelOverrides: new Map() });
    fakes.generateText.mockResolvedValue(extractedResponse([]));
    await MemoryExtractor.extractAndStore(extractionContext());
    expect(fakes.getProvider).toHaveBeenCalledWith("lm-studio");
  });

  it("uses the overridden model from the resolved instance", async () => {
    fakes.generateText.mockResolvedValue(extractedResponse([]));
    await MemoryExtractor.extractAndStore(extractionContext());
    expect(fakes.getProvider).toHaveBeenCalledWith("lm-studio");
    expect(fakes.generateText).toHaveBeenCalledWith(expect.any(Array), "chat-model-v2", expect.objectContaining({ maxTokens: 1000 }));
  });

  it("filters non-extractable messages out of the transcript prompt", async () => {
    fakes.generateText.mockResolvedValue(extractedResponse([]));
    const ctx = extractionContext({
      messages: [
        message("user", "[tool-only turn]"),
        message("assistant", "[Component]"),
        message("user", "[System: injected]"),
        message("user", "Your previous response contained only internal reasoning"),
        message("user", "Do not repeat your reasoning"),
        message("system", "system rules"),
        message("user", "  "),
        message("user", "Real question"),
        message("assistant", "Real answer", { _isSystemWarning: true }),
      ],
    });
    await MemoryExtractor.extractAndStore(ctx);
    expect(fakes.selectExtractionSpan).toHaveBeenCalledWith(
      [{ role: "user", content: "Real question" }],
      null,
    );
  });

  it("returns an empty list when the response is not a recognised memory structure", async () => {
    fakes.generateText.mockResolvedValue({ text: "not json at all" });
    expect(await MemoryExtractor.extractAndStore(extractionContext())).toEqual([]);
  });

  it("returns an empty list and logs when the provider fails", async () => {
    fakes.generateText.mockRejectedValue(new Error("model offline"));
    expect(await MemoryExtractor.extractAndStore(extractionContext())).toEqual([]);
    expect(fakes.logBackgroundLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, errorMessage: "model offline" }),
    );
    expect(fakes.writeWatermark).not.toHaveBeenCalled();
  });

  it("accepts memories wrapped in the extractedMemories envelope", async () => {
    fakes.generateText.mockResolvedValue({
      text: JSON.stringify({ extractedMemories: [{ type: "user", title: "Role", content: "engineer" }] }),
    });
    const stored = await MemoryExtractor.extractAndStore(extractionContext());
    expect(stored).toEqual([{ type: "user", id: expect.any(String), title: "Role" }]);
  });

  it("accepts a single memory object response", async () => {
    fakes.generateText.mockResolvedValue({
      text: JSON.stringify({ type: "project", title: "Deadline", content: "ship friday" }),
    });
    const stored = await MemoryExtractor.extractAndStore(extractionContext());
    expect(stored).toHaveLength(1);
  });

  it("skips duplicates reported by MemoryService.store", async () => {
    fakes.generateText.mockResolvedValue(
      extractedResponse([{ type: "user", title: "Dup", content: "already known" }]),
    );
    findResults.push([{ semanticEmbedding: { vector: [1, 0, 0], space: SPACE } }]);
    expect(await MemoryExtractor.extractAndStore(extractionContext())).toEqual([]);
    expect(inserted).toHaveLength(0);
  });

  it("continues when one memory fails to persist", async () => {
    fakes.generateText.mockResolvedValue(
      extractedResponse([
        { type: "user", title: "First", content: "one" },
        { type: "user", title: "Second", content: "two" },
      ]),
    );
    const originalInsert = collection.insertOne;
    let calls = 0;
    collection.insertOne = async (doc: Doc) => {
      calls += 1;
      if (calls === 1) throw new Error("write conflict");
      inserted.push(structuredClone(doc));
      return { acknowledged: true };
    };
    try {
      const stored = await MemoryExtractor.extractAndStore(extractionContext());
      expect(stored).toEqual([{ type: "user", id: expect.any(String), title: "Second" }]);
    } finally {
      collection.insertOne = originalInsert;
    }
  });
});

describe("MemoryExtractor — token estimation and usage emission", () => {
  it("estimates tokens when the provider returns no usage", async () => {
    fakes.generateText.mockResolvedValue({
      text: JSON.stringify([]),
    });
    const emit = vi.fn();
    await MemoryExtractor.extractAndStore(extractionContext({ emit }));
    const logged = fakes.logBackgroundLlmCall.mock.calls[0][0];
    expect(logged.usage).toBeNull();
    expect(logged.resultText).toBe(JSON.stringify([]));
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: SERVER_SENT_EVENT_TYPES.USAGE_UPDATE,
        usage: expect.objectContaining({
          inputTokens: expect.any(Number),
          outputTokens: expect.any(Number),
        }),
      }),
    );
    expect(emit.mock.calls[0][0].usage.estimatedCost).toBeGreaterThanOrEqual(0);
  });

  it("reports a null embed cost when the embedding model has no pricing", async () => {
    fakes.getPricing.mockReturnValue({ "chat-model": { inputPerMillion: 1, outputPerMillion: 2 } });
    fakes.generateText.mockResolvedValue(
      extractedResponse([{ type: "user", title: "Role", content: "engineer" }]),
    );
    const emit = vi.fn();
    await MemoryExtractor.extractAndStore(extractionContext({ emit }));
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "memory:embed", usage: expect.objectContaining({ estimatedCost: null }) }),
    );
  });

  it("does not emit usage when there is no emit callback", async () => {
    fakes.generateText.mockResolvedValue(
      extractedResponse([{ type: "user", title: "Role", content: "engineer" }]),
    );
    const stored = await MemoryExtractor.extractAndStore(extractionContext({ emit: null }));
    expect(stored).toHaveLength(1);
  });
});

describe("MemoryExtractor.createHook", () => {
  it("emits a status event and triggers consolidation when memories were stored", async () => {
    fakes.generateText.mockResolvedValue(
      extractedResponse([{ type: "user", title: "Role", content: "engineer" }]),
    );
    const emit = vi.fn();
    const { promise, resolve: consolidationRan } = Promise.withResolvers<void>();
    fakes.checkAndRun.mockImplementation(() => consolidationRan());
    const handler = MemoryExtractor.createHook();
    await handler(
      extractionContext({ emit }) as never,
      { _text: "answer", messages: extractionContext().messages, toolCalls: [] } as never,
    );
    await promise;

    expect(emit).toHaveBeenCalledWith({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.MEMORIES_UPDATED,
      count: 1,
    });
    expect(fakes.checkAndRun).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "proj",
        username: "alice",
        agent: "CODING",
        traceId: null,
        endpoint: "/agent",
        broadcast: expect.any(Function),
      }),
    );
    const broadcast = fakes.checkAndRun.mock.calls[0][0].broadcast as (payload: Doc) => void;
    broadcast({ type: "consolidation" });
    expect(emit).toHaveBeenCalledWith({ type: "consolidation" });
  });

  it("runs consolidation without a broadcast callback when there is no emit channel", async () => {
    fakes.generateText.mockResolvedValue(
      extractedResponse([{ type: "user", title: "Role", content: "engineer" }]),
    );
    const { promise, resolve: consolidationRan } = Promise.withResolvers<void>();
    fakes.checkAndRun.mockImplementation(() => consolidationRan());
    const handler = MemoryExtractor.createHook();
    await handler(
      extractionContext({ emit: null }) as never,
      { _text: "answer", messages: extractionContext().messages, toolCalls: [] } as never,
    );
    await promise;
    expect(fakes.checkAndRun.mock.calls[0][0]).toMatchObject({ broadcast: undefined });
  });
});
