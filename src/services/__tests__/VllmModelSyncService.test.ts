import { bootstrapLocalEnvironment } from "../bootstrap.ts";
bootstrapLocalEnvironment();

const { VllmModelSyncService } = await import("./VllmModelSyncService.ts");
const { default: SettingsService } = await import("./SettingsService.ts");
type SettingsData = import("./SettingsService.ts").SettingsData;

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
};

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
  console.log("[MOCK FETCH]", urlStr);

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
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // DGX Spark
  if (urlStr.includes("10.0.0.141:8000/v1/models")) {
    return new Response(
      JSON.stringify({
        object: "list",
        data: [{ id: "google/gemma-4-26B-A4B-it" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(JSON.stringify({}), { status: 404 });
};
globalThis.fetch = mockFetch as any;

// ── Main Test Runner ─────────────────────────────────────────
async function runTests() {
  console.log("=== VllmModelSyncService Unit Tests ===");

  try {
    // 1. Initial State assertions
    console.log("Initial settings state check...");
    if ((mockSettings.memory.extractionProvider as string) !== "vllm-2") {
      throw new Error("Initial state mismatch");
    }

    // 2. Trigger checkAndSync()
    console.log("Triggering checkAndSync()...");
    await VllmModelSyncService.checkAndSync();

    // 3. Verify auto-healing outcomes
    console.log("Verifying outcomes...");
    
    // extractionProvider should be healed to "vllm" (Jetson) to match the Qwen model
    if ((mockSettings.memory.extractionProvider as string) !== "vllm") {
      throw new Error(`Expected extractionProvider to be healed to "vllm", but got: ${mockSettings.memory.extractionProvider}`);
    }
    console.log("✓ extractionProvider successfully healed to 'vllm' (Jetson)");

    // consolidationModel (Qwen/Qwen3.6-35B-A3B-FP8) not loaded anywhere, should choose the best loaded candidate:
    // the scorer prefers Qwen models: "cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit" on "vllm"
    if ((mockSettings.memory.consolidationModel as string) !== "cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit") {
      throw new Error(`Expected consolidationModel to choose 'cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit', but got: ${mockSettings.memory.consolidationModel}`);
    }
    if ((mockSettings.memory.consolidationProvider as string) !== "vllm") {
      throw new Error(`Expected consolidationProvider to be 'vllm', but got: ${mockSettings.memory.consolidationProvider}`);
    }
    console.log("✓ consolidationModel successfully auto-resolved to loaded Qwen model");

    // subAgentModel (cyankiwi/MiniMax-M2.7-AWQ-4bit) not loaded anywhere, should fall back to general model preference scorer.
    // Score order: minimax > gemma > qwen. The loaded model on vllm-2 is "google/gemma-4-26B-A4B-it".
    // "google/gemma-4-26B-A4B-it" should be selected as the sub-agent fallback.
    if ((mockSettings.agents.subAgentModel as string) !== "google/gemma-4-26B-A4B-it") {
      throw new Error(`Expected subAgentModel to fall back to 'google/gemma-4-26B-A4B-it', but got: ${mockSettings.agents.subAgentModel}`);
    }
    if ((mockSettings.agents.subAgentProvider as string) !== "vllm-2") {
      throw new Error(`Expected subAgentProvider to be 'vllm-2', but got: ${mockSettings.agents.subAgentProvider}`);
    }
    console.log("✓ subAgentModel successfully auto-resolved to loaded Gemma model on 'vllm-2'");

    // 4. Verify PUT payload sent to prism-service
    if (!lastPutPayload) {
      throw new Error("Expected PUT /settings request to be sent, but got none");
    }
    if ((lastPutPayload.memory.extractionProvider as string) !== "vllm" || (lastPutPayload.agents.subAgentModel as string) !== "google/gemma-4-26B-A4B-it") {
      throw new Error(`PUT /settings payload is incorrect: ${JSON.stringify(lastPutPayload)}`);
    }
    console.log("✓ PUT /settings payload contains correctly healed configuration values");

    console.log("=========================================");
    console.log("ALL TESTS PASSED SUCCESSFULLY! Green TDD.");
    console.log("=========================================");
  } catch (error) {
    console.error("❌ TEST FAILED:", error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

runTests();
