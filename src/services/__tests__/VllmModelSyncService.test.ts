import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapLocalEnvironment } from "../../bootstrap.ts";

bootstrapLocalEnvironment();

const { VllmModelSyncService, isEmbeddingModel } = await import("../VllmModelSyncService.ts");
const { default: SettingsService } = await import("../SettingsService.ts");
type SettingsData = import("../SettingsService.ts").SettingsData;

// ── Mock Settings Data ───────────────────────────────────────
let mockSettings: SettingsData = {
  memory: {
    extractionProvider: "vllm-2", // Incorrect provider for Qwen
    extractionModel: "cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit",
    consolidationProvider: "vllm-2", // Incorrect provider for Qwen
    consolidationModel: "Qwen/Qwen3.6-35B-A3B-FP8",
    embeddingProvider: "lm-studio",
    embeddingModel: "text-embedding-embeddinggemma-300m",
  },
  agents: {
    subAgentProvider: "vllm-2",
    subAgentModel: "cyankiwi/MiniMax-M2.7-AWQ-4bit", // Incorrect, not loaded on either
    criticProvider: "vllm",
    criticModel: "cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit",
    reminderProvider: "",
    reminderModel: "",
    harness: "standard",
    topology: "peer_to_peer",
    dynamicToolActivation: true,
    locale: "en",
  },
  security: {
    allowEnvFiles: false,
  },
} as SettingsData;

// Override SettingsService methods to use mock data
SettingsService.get = async () => {
  return mockSettings;
};

SettingsService.update = async (data: Partial<SettingsData>) => {
  mockSettings = {
    ...mockSettings,
    ...data,
    memory: { ...mockSettings.memory, ...data.memory },
    agents: { ...mockSettings.agents, ...data.agents },
  } as SettingsData;
  return mockSettings;
};

// ── Mock Global Fetch ────────────────────────────────────────
let lastPutPayload: any = null;
const originalFetch = globalThis.fetch;

const mockFetch = async (url: string | URL | Request, options?: RequestInit): Promise<Response> => {
  const urlStr = typeof url === "string" ? url : (url instanceof Request ? url.url : String(url));

  if (urlStr.includes("/settings") && options?.method === "PUT") {
    lastPutPayload = JSON.parse(options.body as string);
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  }

  // Jetson — the registry may route through the vllm-shim (all boxes were
  // repointed at it, 146faa1), so match both the direct and shim-shaped URLs.
  if (
    urlStr.includes("10.0.0.30:8000/v1/models") ||
    urlStr.includes("vllm-shim/jetson/v1/models")
  ) {
    return new Response(
      JSON.stringify({
        object: "list",
        data: [{ id: "cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // DGX Spark — same dual matching as the Jetson block above.
  if (
    urlStr.includes("10.0.0.141:8000/v1/models") ||
    urlStr.includes("vllm-shim/gold-spark/v1/models")
  ) {
    return new Response(
      JSON.stringify({
        object: "list",
        data: [{ id: "google/gemma-4-26B-A4B-it" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(JSON.stringify({}), { status: 404 });
};

describe("VllmModelSyncService — auto-healing of stale provider/model settings", () => {
  beforeAll(async () => {
    globalThis.fetch = mockFetch as any;
    await VllmModelSyncService.checkAndSync();
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("heals extractionProvider to 'vllm' (Jetson) to match the loaded Qwen model", () => {
    expect(mockSettings.memory.extractionProvider).toBe("vllm");
  });

  it("resolves consolidation to the loaded Qwen model on 'vllm'", () => {
    // Qwen/Qwen3.6-35B-A3B-FP8 is not loaded anywhere; the scorer prefers Qwen
    // models, so the loaded AWQ build on the Jetson should be selected.
    expect(mockSettings.memory.consolidationModel).toBe("cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit");
    expect(mockSettings.memory.consolidationProvider).toBe("vllm");
  });

  it("falls back subAgentModel to the loaded Gemma model on 'vllm-2'", () => {
    // MiniMax isn't loaded on either endpoint. Preference order: minimax > gemma > qwen,
    // and the loaded model on vllm-2 is the Gemma build.
    expect(mockSettings.agents.subAgentModel).toBe("google/gemma-4-26B-A4B-it");
    expect(mockSettings.agents.subAgentProvider).toBe("vllm-2");
  });

  it("clears the critic pin instead of healing it", () => {
    // Prism's CriticGate ignores criticProvider: the review always runs on
    // the CONVERSATION's provider with the pinned model name, so a pin that
    // is perfectly valid on the Jetson 404s on every vllm-2 conversation
    // (measured: 869 failed reviews/24h, ~8-12s of retries each, then
    // "Defaulting to approve"). Empty falls back to the conversation's own
    // model, which is valid everywhere.
    expect(mockSettings.agents.criticModel).toBe("");
    expect(mockSettings.agents.criticProvider).toBe("");
  });

  it("sends the healed configuration to prism-service via PUT /settings", () => {
    expect(lastPutPayload).not.toBeNull();
    expect(lastPutPayload.memory.extractionProvider).toBe("vllm");
    expect(lastPutPayload.agents.subAgentModel).toBe("google/gemma-4-26B-A4B-it");
  });
});

// ── Regression: embedding models must never qualify for a generation role ──────
// `embeddinggemma` scores 60 via `scoreLargeModel`'s "gemma" branch, so when the
// preferred Qwen chat model was briefly unloaded the daemon healed consolidation
// onto the embedding-only instance, and every consolidation call then 404'd
// against `/v1/chat/completions`. `isEmbeddingModel` is the guard that keeps
// embedding models out of the generation-role candidate pool. These are pure
// unit tests — no global fetch/settings mutation — so they can't race the rest
// of the suite (which shares `globalThis.fetch`) the way an integration test would.
describe("VllmModelSyncService.isEmbeddingModel — generation-role exclusion guard", () => {
  it("flags embeddinggemma (the model that caused the consolidate 404s)", () => {
    expect(isEmbeddingModel("embeddinggemma", "")).toBe(true);
  });

  it("flags common embedding model names via the /embed/ heuristic", () => {
    expect(isEmbeddingModel("text-embedding-embeddinggemma-300m", "")).toBe(true);
    expect(isEmbeddingModel("BAAI/bge-large-en-v1.5-embed", "")).toBe(true);
    expect(isEmbeddingModel("intfloat/e5-embed", "")).toBe(true);
  });

  it("flags the exact model configured as the embedding role even without 'embed' in the name", () => {
    expect(isEmbeddingModel("nomic-custom-vectorizer", "nomic-custom-vectorizer")).toBe(true);
    // case-insensitive
    expect(isEmbeddingModel("Nomic-Custom-Vectorizer", "nomic-custom-vectorizer")).toBe(true);
  });

  it("does NOT flag chat/generation models — including chat Gemma and Qwen", () => {
    expect(isEmbeddingModel("google/gemma-4-26B-A4B-it", "embeddinggemma")).toBe(false);
    expect(isEmbeddingModel("cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit", "embeddinggemma")).toBe(false);
    expect(isEmbeddingModel("cyankiwi/MiniMax-M2.7-AWQ-4bit", "embeddinggemma")).toBe(false);
  });

  it("handles empty/undefined model names safely", () => {
    expect(isEmbeddingModel("", "embeddinggemma")).toBe(false);
    expect(isEmbeddingModel(undefined as unknown as string, "")).toBe(false);
  });
});

describe("VllmModelSyncService.syncScheduledTasks — auto-healing of scheduled task models", () => {
  it("heals a scheduled task when its configured model is absent on the vLLM instance", async () => {
    const { default: MongoWrapper } = await import("../../wrappers/MongoWrapper.ts");
    const mockTasks = [
      {
        id: "03c1061c-3cec-4b55-b45f-65ffe200059c",
        name: "Daily Stock Deep Research",
        provider: "vllm-2",
        model: "deepseek-v4-flash-0731",
        enabled: true,
      },
    ];

    let updatedDoc: any = null;
    const mockDb = {
      collection: () => ({
        find: () => ({
          toArray: async () => mockTasks,
        }),
        updateOne: async (query: any, update: any) => {
          updatedDoc = { query, update };
          return { modifiedCount: 1 };
        },
      }),
    };

    const originalGetDb = MongoWrapper.getDb;
    MongoWrapper.getDb = (() => mockDb as any);

    try {
      const loadedModels = new Map<string, string[]>([
        ["vllm-2", ["GLM-5.3-Flash-EXL3"]],
        ["vllm", ["cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit"]],
      ]);
      const generationCandidates = [
        { instanceId: "vllm-2", modelName: "GLM-5.3-Flash-EXL3" },
        { instanceId: "vllm", modelName: "cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit" },
      ];

      const healed = await VllmModelSyncService.syncScheduledTasks(
        loadedModels,
        generationCandidates,
        "embeddinggemma",
      );

      expect(healed).toBe(1);
      expect(updatedDoc).not.toBeNull();
      expect(updatedDoc.query).toEqual({ id: "03c1061c-3cec-4b55-b45f-65ffe200059c" });
      expect(updatedDoc.update.$set.model).toBe("GLM-5.3-Flash-EXL3");
      expect(updatedDoc.update.$set.provider).toBe("vllm-2");
    } finally {
      MongoWrapper.getDb = originalGetDb;
    }
  });

  it("heals provider to match model when model is loaded on a different vLLM instance", async () => {
    const { default: MongoWrapper } = await import("../../wrappers/MongoWrapper.ts");
    const mockTasks = [
      {
        id: "task-qwen",
        name: "Qwen Analysis",
        provider: "vllm-2",
        model: "cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit",
        enabled: true,
      },
    ];

    let updatedDoc: any = null;
    const mockDb = {
      collection: () => ({
        find: () => ({ toArray: async () => mockTasks }),
        updateOne: async (query: any, update: any) => {
          updatedDoc = { query, update };
          return { modifiedCount: 1 };
        },
      }),
    };

    const originalGetDb = MongoWrapper.getDb;
    MongoWrapper.getDb = (() => mockDb as any);

    try {
      const loadedModels = new Map<string, string[]>([
        ["vllm-2", ["GLM-5.3-Flash-EXL3"]],
        ["vllm", ["cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit"]],
      ]);
      const generationCandidates = [
        { instanceId: "vllm-2", modelName: "GLM-5.3-Flash-EXL3" },
      ];

      const healed = await VllmModelSyncService.syncScheduledTasks(
        loadedModels,
        generationCandidates,
        "embeddinggemma",
      );

      expect(healed).toBe(1);
      expect(updatedDoc.update.$set.provider).toBe("vllm");
    } finally {
      MongoWrapper.getDb = originalGetDb;
    }
  });

  it("does not mutate tasks whose configured model is already loaded and valid", async () => {
    const { default: MongoWrapper } = await import("../../wrappers/MongoWrapper.ts");
    const mockTasks = [
      {
        id: "task-valid",
        name: "GLM Task",
        provider: "vllm-2",
        model: "GLM-5.3-Flash-EXL3",
        enabled: true,
      },
    ];

    let updateCount = 0;
    const mockDb = {
      collection: () => ({
        find: () => ({ toArray: async () => mockTasks }),
        updateOne: async () => {
          updateCount++;
          return { modifiedCount: 1 };
        },
      }),
    };

    const originalGetDb = MongoWrapper.getDb;
    MongoWrapper.getDb = (() => mockDb as any);

    try {
      const loadedModels = new Map<string, string[]>([
        ["vllm-2", ["GLM-5.3-Flash-EXL3"]],
      ]);
      const generationCandidates = [
        { instanceId: "vllm-2", modelName: "GLM-5.3-Flash-EXL3" },
      ];

      const healed = await VllmModelSyncService.syncScheduledTasks(
        loadedModels,
        generationCandidates,
        "embeddinggemma",
      );

      expect(healed).toBe(0);
      expect(updateCount).toBe(0);
    } finally {
      MongoWrapper.getDb = originalGetDb;
    }
  });
});
