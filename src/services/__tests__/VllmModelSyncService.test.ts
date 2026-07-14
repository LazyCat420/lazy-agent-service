import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapLocalEnvironment } from "../../bootstrap.ts";

bootstrapLocalEnvironment();

const { VllmModelSyncService } = await import("../VllmModelSyncService.ts");
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

  // Jetson
  if (urlStr.includes("10.0.0.30:8000/v1/models")) {
    return new Response(
      JSON.stringify({
        object: "list",
        data: [{ id: "cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // DGX Spark
  if (urlStr.includes("10.0.0.141:8000/v1/models")) {
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

  it("sends the healed configuration to prism-service via PUT /settings", () => {
    expect(lastPutPayload).not.toBeNull();
    expect(lastPutPayload.memory.extractionProvider).toBe("vllm");
    expect(lastPutPayload.agents.subAgentModel).toBe("google/gemma-4-26B-A4B-it");
  });
});
