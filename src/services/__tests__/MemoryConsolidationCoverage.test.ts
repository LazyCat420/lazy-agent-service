/**
 * MemoryConsolidationService — coverage of the batch planner, action applier
 * and the conversational partition path. Provider, Mongo, memory CRUD,
 * clustering and tracking are fakes; the service and its prompt/batch builders
 * are real, and assertions read the persisted memory documents and the
 * returned consolidation summaries.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  generateText: vi.fn(),
  getProvider: vi.fn(),
  getInstanceType: vi.fn(),
  getInstancesByType: vi.fn(),
  resolveModelForInstances: vi.fn(),
  getDb: vi.fn(),
  getSection: vi.fn(),
  getMemoryModelConfig: vi.fn(),
  personaGet: vi.fn(),
  memoryRemove: vi.fn(),
  memoryStore: vi.fn(),
  logBackgroundLlmCall: vi.fn(),
  findClusters: vi.fn(),
  partitionConversationalMemories: vi.fn(),
  findStaleConversationalMemories: vi.fn(),
  canRunToday: vi.fn(),
  resetRunCount: vi.fn(),
  recordHistory: vi.fn(),
}));

vi.mock("../../../config.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MONGO_DB_NAME: "test-db",
}));
vi.mock("../../config.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPricing: () => ({ "chat-model": { inputPerMillion: 1, outputPerMillion: 2 } }),
}));
vi.mock("../SettingsService.ts", () => ({
  default: {
    getSection: fakes.getSection,
    getMemoryModelConfig: fakes.getMemoryModelConfig,
  },
}));
vi.mock("../../providers/index.ts", () => ({ getProvider: fakes.getProvider }));
vi.mock("../../providers/instance-registry.ts", () => ({
  getInstanceType: fakes.getInstanceType,
  getInstancesByType: fakes.getInstancesByType,
}));
vi.mock("../../utils/ModelResolution.ts", () => ({
  resolveModelForInstances: fakes.resolveModelForInstances,
}));
vi.mock("../../wrappers/MongoWrapper.ts", () => ({ default: { getDb: fakes.getDb } }));
vi.mock("../MemoryService.ts", () => ({
  default: { remove: fakes.memoryRemove, store: fakes.memoryStore },
}));
vi.mock("../RequestLogger.ts", () => ({
  default: { logBackgroundLlmCall: fakes.logBackgroundLlmCall },
}));
vi.mock("../AgentPersonaRegistry.ts", () => ({ default: { get: fakes.personaGet } }));
vi.mock("../memory/ClusterDetection.ts", () => ({
  findClusters: fakes.findClusters,
  CONVERSATIONAL_CLUSTER_THRESHOLD: 0.8,
  CLUSTER_THRESHOLD: 0.75,
}));
vi.mock("../memory/ConsolidationTracker.ts", () => ({
  SESSIONS_BETWEEN_RUNS: 5,
  getRunCount: vi.fn().mockResolvedValue(0),
  incrementRunCount: vi.fn(),
  resetRunCount: fakes.resetRunCount,
  recordHistory: fakes.recordHistory,
  canRunToday: fakes.canRunToday,
  getHistory: vi.fn().mockResolvedValue([]),
}));
vi.mock("../memory/ConversationalMemoryPartitioner.ts", () => ({
  partitionConversationalMemories: fakes.partitionConversationalMemories,
  findStaleConversationalMemories: fakes.findStaleConversationalMemories,
}));
vi.mock("../../utils/logger.ts", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

import MemoryConsolidationService from "../MemoryConsolidationService.ts";

type Memory = {
  id: string;
  type: string;
  content: string;
  createdAt: string;
  title?: string | null;
  aboutUserId?: string;
  aboutUsername?: string;
  sourceUserId?: string;
  sourceUsername?: string;
  guildId?: string;
};

const memory = (id: string, overrides: Partial<Memory> = {}): Memory => ({
  id,
  type: "project",
  content: `memory ${id}`,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

let storedMemories: Memory[];
let memories: Memory[];
let broadcasted: Array<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  storedMemories = [];
  memories = [memory("m1"), memory("m2")];
  broadcasted = [];
  fakes.canRunToday.mockResolvedValue(true);
  fakes.getMemoryModelConfig.mockResolvedValue({ provider: "local", model: "chat-model" });
  fakes.getSection.mockResolvedValue({});
  fakes.getInstanceType.mockReturnValue("lm-studio");
  fakes.getInstancesByType.mockReturnValue([{ id: "lm-studio" }]);
  fakes.resolveModelForInstances.mockResolvedValue({
    usable: [{ id: "lm-studio" }],
    modelOverrides: new Map(),
  });
  fakes.getProvider.mockReturnValue({ generateText: fakes.generateText });
  fakes.generateText.mockResolvedValue({ text: JSON.stringify({ actions: [] }) });
  fakes.findClusters.mockReturnValue([]);
  fakes.personaGet.mockReturnValue(null);
  fakes.memoryRemove.mockResolvedValue(undefined);
  fakes.memoryStore.mockImplementation(async (document: Memory) => {
    storedMemories.push(document);
    return { id: `stored-${storedMemories.length}` };
  });
  fakes.getDb.mockReturnValue({
    collection: () => ({
      find: () => ({
        project: () => ({ toArray: async () => structuredClone(memories) }),
      }),
    }),
  });
});

const run = (overrides: Record<string, unknown> = {}) =>
  MemoryConsolidationService.consolidate({
    agent: "coding",
    project: "proj",
    username: "alice",
    trigger: "manual",
    broadcast: (event: Record<string, unknown>) => broadcasted.push(event),
    ...overrides,
  } as never);

describe("consolidate — guards", () => {
  it("skips when the daily budget is exhausted", async () => {
    fakes.canRunToday.mockResolvedValue(false);
    const result = await run();
    expect(result).toEqual({ skipped: true, reason: "daily_limit_reached", total: 0 });
    expect(fakes.getDb).not.toHaveBeenCalled();
  });

  it("skips when fewer than two memories exist and resets the run counter", async () => {
    memories = [memory("only")];
    const result = await run();
    expect(result).toEqual({ skipped: true, reason: "insufficient memories", total: 1 });
    expect(fakes.resetRunCount).toHaveBeenCalledWith("proj");
  });

  it("refuses an embedding model configured for consolidation", async () => {
    fakes.getMemoryModelConfig.mockResolvedValue({ provider: "local", model: "google/embeddinggemma-2" });
    const result = await run();
    expect(result).toEqual({ skipped: true, reason: "consolidation_model_is_embedding", total: 2 });
    expect(fakes.generateText).not.toHaveBeenCalled();
  });

  it("fails when no sibling instance serves the configured model", async () => {
    fakes.resolveModelForInstances.mockResolvedValue({ usable: [], modelOverrides: new Map() });
    fakes.getInstancesByType.mockReturnValue([{ id: "lm-studio" }, { id: "lm-studio-2" }]);
    await expect(run()).rejects.toThrow(
      'Model resolution failed: "chat-model" is not loaded on any instances of provider type "lm-studio".',
    );
  });

  it("skips when clustering finds no candidates", async () => {
    fakes.findClusters.mockReturnValue([]);
    const result = await run();
    expect(result).toEqual({ skipped: true, reason: "no candidates", total: 2 });
    expect(fakes.resetRunCount).toHaveBeenCalledWith("proj");
  });
});

describe("consolidate — default path", () => {
  it("merges a cluster through the LLM and persists the summary", async () => {
    fakes.findClusters.mockReturnValue([[memory("m1"), memory("m2")]]);
    fakes.generateText.mockResolvedValue({
      text: JSON.stringify({
        actions: [
          {
            type: "merge",
            sourceIds: ["m1", "m2"],
            merged: { type: "project", title: "Merged", content: "combined content" },
            reason: "duplicate",
          },
        ],
      }),
      usage: { inputTokens: 120, outputTokens: 30 },
    });

    const result = await run({ endpoint: "/agent" });

    expect(fakes.memoryRemove.mock.calls.map((call) => call[0])).toEqual(["m1", "m2"]);
    expect(storedMemories).toHaveLength(1);
    expect(storedMemories[0]).toMatchObject({
      agent: "coding",
      project: "proj",
      username: "alice",
      type: "project",
      title: "Merged",
      content: "combined content",
      conversationId: null,
      endpoint: "/agent",
    });
    expect(result).toEqual({
      merged: 2,
      deleted: 0,
      errors: 0,
      actionsApplied: 1,
      batchCount: 1,
      summary: "Merged 2, deleted 0 (1 batches)",
      total: 2,
      trigger: "manual",
      durationMs: expect.any(Number),
    });

    // Usage update carries the API-reported token counts and computed cost.
    const usageEvent = broadcasted[0];
    expect(usageEvent.type).toBe("usage_update");
    expect(usageEvent.operation).toBe("memory:consolidate");
    expect(usageEvent.usage).toMatchObject({ requests: 1, inputTokens: 120, outputTokens: 30 });
    expect(usageEvent.usage.estimatedCost).toBeCloseTo(0.00018, 8);
    expect(broadcasted[1]).toMatchObject({
      type: "memory_consolidation_complete",
      project: "proj",
      merged: 2,
      actionsApplied: 1,
    });
    expect(fakes.recordHistory).toHaveBeenCalledWith(
      "proj",
      "manual",
      2,
      expect.any(Array),
      "Merged 2, deleted 0 (1 batches)",
      expect.any(Number),
    );
    expect(fakes.resetRunCount).toHaveBeenCalledWith("proj");
  });

  it("deletes stale memories and counts failures as errors", async () => {
    fakes.findClusters.mockReturnValue([[memory("m1"), memory("m2")]]);
    fakes.generateText.mockResolvedValue({
      text: JSON.stringify({
        actions: [
          { type: "delete", id: "m3", reason: "obsolete" },
          { type: "merge", sourceIds: ["m4", "m5"], merged: { content: "merged" } },
          { type: "delete" },
          { type: "merge", sourceIds: ["m6"], merged: { content: "too few" } },
          { type: "merge", sourceIds: ["m7", "m8"] },
        ],
      }),
    });
    fakes.memoryRemove.mockImplementation(async (id: string) => {
      if (id === "m4") throw new Error("write conflict");
    });

    const result = await run();

    expect(fakes.memoryRemove.mock.calls.map((call) => call[0])).toEqual(["m3", "m4"]);
    expect(result).toMatchObject({ merged: 0, deleted: 1, errors: 1, actionsApplied: 5 });
  });

  it("returns no actions when the LLM output is unparseable or empty", async () => {
    fakes.findClusters.mockReturnValue([[memory("m1"), memory("m2")]]);
    fakes.generateText.mockResolvedValue({ text: "not json at all" });
    const unparseable = await run();
    expect(unparseable).toEqual({ actions: 0, summary: "No consolidation needed", total: 2 });
    expect(fakes.memoryRemove).not.toHaveBeenCalled();

    fakes.generateText.mockResolvedValue({ text: "" });
    expect(await run()).toEqual({ actions: 0, summary: "No consolidation needed", total: 2 });
  });

  it("treats an LLM failure as an empty action list", async () => {
    fakes.findClusters.mockReturnValue([[memory("m1"), memory("m2")]]);
    fakes.generateText.mockRejectedValue(new Error("model offline"));
    const result = await run();
    expect(result).toEqual({ actions: 0, summary: "No consolidation needed", total: 2 });
    expect(fakes.logBackgroundLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, errorMessage: "model offline" }),
    );
  });

  it("keeps the summary when the broadcast channel throws", async () => {
    fakes.findClusters.mockReturnValue([[memory("m1"), memory("m2")]]);
    fakes.generateText.mockResolvedValue({
      text: JSON.stringify({ actions: [{ type: "delete", id: "m1" }] }),
    });
    const result = await run({
      broadcast: () => {
        throw new Error("SSE closed");
      },
    });
    expect(result).toMatchObject({ deleted: 1, actionsApplied: 1 });
  });
});

describe("consolidate — conversational agent", () => {
  beforeEach(() => {
    fakes.personaGet.mockReturnValue({
      id: "lupos",
      type: "conversational",
      availableTools: ["*"],
    });
    fakes.findStaleConversationalMemories.mockReturnValue([]);
  });

  it("clusters per observer→subject partition and preserves attribution on merge", async () => {
    const paired = [
      memory("c1", {
        type: "other",
        aboutUserId: "u-about",
        aboutUsername: "Ada",
        sourceUserId: "u-source",
        sourceUsername: "Bob",
        guildId: "g1",
      }),
      memory("c2", {
        type: "other",
        aboutUserId: "u-about",
        aboutUsername: "Ada",
        sourceUserId: "u-source",
        sourceUsername: "Bob",
        guildId: "g1",
      }),
      memory("c3", {
        type: "other",
        aboutUserId: "u-about",
        aboutUsername: "Ada",
        sourceUserId: "u-other",
        sourceUsername: "Cy",
        guildId: "g1",
      }),
    ];
    memories = paired;
    fakes.partitionConversationalMemories.mockReturnValue(
      new Map([
        ["about->source", paired],
        ["singleton", [memory("solo")]],
        ["empty", [memory("e1"), memory("e2")]],
      ]),
    );
    fakes.findClusters.mockImplementation((partition: Memory[]) =>
      partition.some((item) => item.id === "c1") ? [[paired[0], paired[1]]] : [],
    );
    fakes.generateText.mockResolvedValue({
      text: JSON.stringify({
        actions: [
          {
            type: "merge",
            sourceIds: ["c1", "c2", "c3"],
            merged: { title: "Ada likes tea", content: "Ada likes tea" },
          },
        ],
      }),
    });

    const result = await run({ agent: "lupos", guildId: "g1", trigger: "conversation_threshold" });

    expect(fakes.getInstancesByType).toHaveBeenCalled();
    expect(storedMemories).toHaveLength(1);
    expect(storedMemories[0]).toMatchObject({
      agent: "lupos",
      type: "other",
      title: "Ada likes tea",
      metadata: {
        aboutUserId: "u-about",
        aboutUsername: "Ada",
        sourceUserId: "u-source",
        sourceUsername: "Bob",
        guildId: "g1",
        mergedSources: [
          { sourceUserId: "u-source", sourceUsername: "Bob" },
          { sourceUserId: "u-other", sourceUsername: "Cy" },
        ],
      },
    });
    expect(result).toMatchObject({ merged: 3, batchCount: 1, trigger: "conversation_threshold" });
  });

  it("skips a conversational run when no partition has candidates", async () => {
    fakes.partitionConversationalMemories.mockReturnValue(
      new Map([
        ["solo", [memory("s1")]],
        ["quiet", [memory("q1"), memory("q2")]],
      ]),
    );
    fakes.findClusters.mockReturnValue([]);
    fakes.findStaleConversationalMemories.mockReturnValue([]);

    memories = [memory("q1"), memory("q2")];
    const result = await run({ agent: "lupos", guildId: "g1", project: null });

    expect(result).toEqual({ skipped: true, reason: "no candidates", total: 2 });
    expect(fakes.resetRunCount).toHaveBeenCalledWith("g1");
  });
});
