/**
 * LocalProviderGateway — normalizers, capability detection, VRAM estimation,
 * HuggingFace enrichment, model filtering and aggregate statistics.
 * The real modules run; only the provider registry, the instance registry and
 * the HuggingFace HTTP endpoint are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDERS, TYPES } from "../../constants.ts";

const fakes = vi.hoisted(() => ({
  listInstances: vi.fn(),
  getInstance: vi.fn(),
  isInstance: vi.fn(),
  getInstanceType: vi.fn(),
  listInstanceTypes: vi.fn(),
  getInstancesByType: vi.fn(),
  getProvider: vi.fn(),
}));

vi.mock("../../providers/index.ts", () => ({ getProvider: fakes.getProvider }));
vi.mock("../../providers/instance-registry.ts", () => ({
  listInstances: fakes.listInstances,
  getInstance: fakes.getInstance,
  isInstance: fakes.isInstance,
  getInstanceType: fakes.getInstanceType,
  listInstanceTypes: fakes.listInstanceTypes,
  getInstancesByType: fakes.getInstancesByType,
}));

import gateway, { LocalProviderGateway } from "../local-provider/index.ts";
import {
  normalizeLmStudioModel,
  normalizeOllamaModel,
  normalizeOpenAICompatModel,
  normalizeVllmModel,
  NORMALIZER_BY_TYPE,
  HF_ENRICHED_TYPES,
} from "../local-provider/normalizers.ts";
import { detectCapabilities } from "../local-provider/detectCapabilities.ts";
import { estimateVRAM, estimateVRAMForModel } from "../local-provider/vramEstimation.ts";
import {
  fetchHuggingFaceMetadata,
  enrichWithHuggingFace,
} from "../local-provider/hfMetadata.ts";
import type { ModelEntry } from "../local-provider/types.ts";

const GiB = 1024 ** 3;

const baseEntry = (): ModelEntry => ({
  name: "some-model",
  label: "some-model",
  modelType: "conversation",
  inputTypes: [TYPES.TEXT],
  outputTypes: [TYPES.TEXT],
  supportsSystemPrompt: true,
  streaming: true,
  pricing: { inputPerMillion: 0, outputPerMillion: 0 },
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeLmStudioModel", () => {
  it("maps full LLM metadata and capability flags", () => {
    const entry = normalizeLmStudioModel({
      key: "qwen3-8b",
      display_name: "Qwen3 8B",
      type: "llm",
      quantization: { name: "Q4_K_M", bits_per_weight: 4.5 },
      max_context_length: 32768,
      size_bytes: 5 * GiB,
      params_string: "8B",
      architecture: "qwen3",
      publisher: "alibaba",
      loaded_instances: [{ id: "inst-1" }],
      capabilities: { reasoning: true, trained_for_tool_use: true },
    });

    expect(entry.label).toBe("Qwen3 8B (Q4_K_M)");
    expect(entry.modelType).toBe("conversation");
    expect(entry.inputTypes).toEqual([TYPES.TEXT]);
    expect(entry.tools).toEqual(["Thinking", "Tool Calling"]);
    expect(entry.thinking).toBe(true);
    expect(entry.vision).toBeUndefined();
    expect(entry.contextLength).toBe(32768);
    expect(entry.size).toBe("5.00 GB");
    expect(entry.params).toBe("8B");
    expect(entry.quantization).toBe("Q4_K_M");
    expect(entry.bitsPerWeight).toBe(4.5);
    expect(entry.architecture).toBe("qwen3");
    expect(entry.publisher).toBe("alibaba");
    expect(entry.loaded).toBe(true);
    expect(entry._raw).toBeTypeOf("object");
  });

  it("marks embedding models as non-streaming with no capability flags", () => {
    const entry = normalizeLmStudioModel({ key: "nomic-embed", type: "embedding" });

    expect(entry.label).toBe("nomic-embed");
    expect(entry.modelType).toBe("embed");
    expect(entry.inputTypes).toEqual([TYPES.TEXT]);
    expect(entry.outputTypes).toEqual([TYPES.EMBEDDING]);
    expect(entry.supportsSystemPrompt).toBe(false);
    expect(entry.streaming).toBe(false);
    expect(entry.defaultTemperature).toBeUndefined();
    expect(entry.tools).toBeUndefined();
    expect(entry.thinking).toBeUndefined();
    expect(entry.loaded).toBeUndefined();
  });

  it("detects vision from the model name", () => {
    const entry = normalizeLmStudioModel({ key: "qwen2.5-vl-7b" });
    expect(entry.vision).toBe(true);
    expect(entry.inputTypes).toContain(TYPES.IMAGE);
    expect(entry.inputTypes).toContain(TYPES.VIDEO);
  });
});

describe("normalizeOllamaModel", () => {
  it("uses model name, details and loaded state", () => {
    const entry = normalizeOllamaModel({
      model: "llama3:8b",
      name: "llama3:8b",
      size: 4 * GiB,
      details: { family: "llama", parameter_size: "8B" },
      loaded_instances: [{}],
    });

    expect(entry.name).toBe("llama3:8b");
    expect(entry.label).toBe("llama3:8b");
    expect(entry.modelType).toBe("conversation");
    expect(entry.tools).toEqual(["Tool Calling"]);
    expect(entry.thinking).toBeUndefined();
    expect(entry.params).toBe("8B");
    expect(entry.architecture).toBe("llama");
    expect(entry.size).toBe("4.00 GB");
    expect(entry.loaded).toBe(true);
  });

  it("falls back to name and handles missing details", () => {
    const entry = normalizeOllamaModel({ name: "mistral" });

    expect(entry.name).toBe("mistral");
    expect(entry.label).toBe("mistral");
    expect(entry.tools).toEqual(["Tool Calling"]);
    expect(entry.params).toBeUndefined();
    expect(entry.architecture).toBeUndefined();
    expect(entry.size).toBeUndefined();
    expect(entry.loaded).toBeUndefined();
  });
});

describe("normalizeOpenAICompatModel", () => {
  it("parses params, quantization and publisher from the id", () => {
    const entry = normalizeOpenAICompatModel({ id: "Qwen/Qwen3-8B-AWQ" });

    expect(entry.name).toBe("Qwen/Qwen3-8B-AWQ");
    expect(entry.label).toBe("Qwen/Qwen3-8B-AWQ (AWQ)");
    expect(entry.params).toBe("8B");
    expect(entry.quantization).toBe("AWQ");
    expect(entry.publisher).toBe("Qwen");
    expect(entry.tools).toEqual(["Thinking", "Tool Calling"]);
    expect(entry.thinking).toBe(true);
    expect(entry.vision).toBeUndefined();
  });

  it("prefers key over id and leaves capability fields off when unknown", () => {
    const entry = normalizeOpenAICompatModel({
      key: "plain-model",
      id: "ignored",
      display_name: "Plain",
    });

    expect(entry.name).toBe("plain-model");
    expect(entry.label).toBe("Plain");
    expect(entry.tools).toBeUndefined();
    expect(entry.thinking).toBeUndefined();
    expect(entry.vision).toBeUndefined();
    expect(entry.params).toBeUndefined();
    expect(entry.quantization).toBeUndefined();
    expect(entry.publisher).toBeUndefined();
  });
});

describe("normalizeVllmModel", () => {
  it("forces Tool Calling and maxOutputTokens on models without tools", () => {
    const entry = normalizeVllmModel({ id: "plain-model" });

    expect(entry.tools).toEqual(["Tool Calling"]);
    expect(entry.maxOutputTokens).toBe(50000);
  });

  it("does not duplicate an existing Tool Calling entry", () => {
    const entry = normalizeVllmModel({ id: "qwen3-8b" });

    expect(entry.tools).toEqual(["Thinking", "Tool Calling"]);
    expect(entry.tools?.filter((t) => t === "Tool Calling")).toHaveLength(1);
  });
});

describe("normalizer registry", () => {
  it("maps provider types to their normalizer and lists HF-enriched types", () => {
    expect(NORMALIZER_BY_TYPE[PROVIDERS.LM_STUDIO]).toBe(normalizeLmStudioModel);
    expect(NORMALIZER_BY_TYPE[PROVIDERS.OLLAMA]).toBe(normalizeOllamaModel);
    expect(NORMALIZER_BY_TYPE[PROVIDERS.VLLM]).toBe(normalizeVllmModel);
    expect(NORMALIZER_BY_TYPE[PROVIDERS.LLAMA_CPP]).toBe(normalizeOpenAICompatModel);
    expect(HF_ENRICHED_TYPES.has(PROVIDERS.VLLM)).toBe(true);
    expect(HF_ENRICHED_TYPES.has(PROVIDERS.OLLAMA)).toBe(false);
  });
});

describe("detectCapabilities", () => {
  it("returns text-only defaults for an empty name", () => {
    const caps = detectCapabilities(null);

    expect(caps.thinking).toBe(false);
    expect(caps.functionCalling).toBe(false);
    expect(caps.vision).toBe(false);
    expect(caps.video).toBe(false);
    expect(caps.audio).toBe(false);
    expect(caps.tools).toEqual([]);
    expect(caps.inputTypes).toEqual([TYPES.TEXT]);
    expect(caps.outputTypes).toEqual([TYPES.TEXT]);
  });

  it("honours provider capability metadata", () => {
    const caps = detectCapabilities("unknown-model", {
      capabilities: { reasoning: true, trained_for_tool_use: true, vision: true },
    });

    expect(caps.thinking).toBe(true);
    expect(caps.functionCalling).toBe(true);
    expect(caps.vision).toBe(true);
    expect(caps.tools).toEqual(["Thinking", "Tool Calling"]);
    expect(caps.inputTypes).toEqual([TYPES.TEXT, TYPES.IMAGE]);
  });

  it("detects audio models by name", () => {
    const caps = detectCapabilities("qwen2-audio");

    expect(caps.audio).toBe(true);
    expect(caps.inputTypes).toEqual([TYPES.TEXT, TYPES.AUDIO]);
    expect(caps.tools).toEqual(["Tool Calling"]);
  });
});

describe("estimateVRAM", () => {
  it("returns null without model data or size", () => {
    expect(estimateVRAM(null)).toBeNull();
    expect(estimateVRAM(undefined)).toBeNull();
    expect(estimateVRAM({ key: "x", size_bytes: 0 })).toBeNull();
  });

  it("estimates GPU memory from GGUF metadata", () => {
    const result = estimateVRAM({
      key: "qwen3-8b",
      size_bytes: 5 * GiB,
      params_string: "8B",
      architecture: "qwen3",
      quantization: { bits_per_weight: 4 },
    });

    expect(result).not.toBeNull();
    expect(result?.totalLayers).toBe(36);
    expect(result?.archParams).toEqual({
      layers: 36,
      kvHeads: 8,
      headDim: 128,
      attnRatio: 1,
      isKnown: true,
    });
    expect(result?.gpuGiB as number).toBeGreaterThan(0);
    expect(result?.cpuOffloaded).toBe(false);
  });

  it("reports CPU offload when the GPU budget is exceeded", () => {
    const result = estimateVRAM(
      { key: "big", size_bytes: 40 * GiB, params_string: "70B", architecture: "llama" },
      { gpuTotalGiB: 8, gpuBaselineGiB: 2 },
    );

    expect(result?.cpuOffloaded).toBe(true);
    expect(result?.gpuGiB).toBe(6);
    expect(result?.totalGiB as number).toBeGreaterThan(6);
  });

  it("honours explicit layer/context options and vision surcharge", () => {
    const noVision = estimateVRAM(
      { key: "m", size_bytes: 6 * GiB, params_string: "8B", architecture: "llama" },
      { gpuLayers: 0 },
    );
    const withVision = estimateVRAM(
      {
        key: "m",
        size_bytes: 6 * GiB,
        params_string: "8B",
        architecture: "llama",
        capabilities: { vision: true },
      },
      { contextLength: 8192, flashAttention: false },
    );

    // gpuLayers: 0 puts every weight on the CPU; only the KV cache stays on the GPU.
    expect(noVision?.cpuOffloaded).toBe(false);
    expect(noVision?.gpuGiB as number).toBeGreaterThan(0);
    expect(noVision?.gpuGiB as number).toBeLessThan(1);
    expect(noVision?.totalGiB).toBeCloseTo(6 + (noVision?.gpuGiB as number), 5);
    expect(withVision?.gpuGiB as number).toBeGreaterThan(0);
  });
});

describe("estimateVRAMForModel", () => {
  it("returns null when the provider is unknown or cannot list models", async () => {
    fakes.getProvider.mockReturnValueOnce(undefined);
    expect(await estimateVRAMForModel("missing", "any")).toBeNull();

    fakes.getProvider.mockReturnValueOnce({});
    expect(await estimateVRAMForModel("no-list", "any")).toBeNull();
  });

  it("finds the model by id and returns its estimate", async () => {
    fakes.getProvider.mockReturnValueOnce({
      listModels: async () => ({
        data: [
          { id: "other", size_bytes: 0 },
          {
            id: "qwen3-8b",
            size_bytes: 5 * GiB,
            params_string: "8B",
            architecture: "qwen3",
          },
        ],
      }),
    });

    const result = await estimateVRAMForModel("lm-studio", "qwen3-8b");
    expect(result?.totalLayers).toBe(36);
  });

  it("returns null when no listed model matches the key", async () => {
    fakes.getProvider.mockReturnValueOnce({
      listModels: async () => ({ models: [{ id: "a", size_bytes: 1 }] }),
    });

    expect(await estimateVRAMForModel("lm-studio", "b")).toBeNull();
  });
});

describe("fetchHuggingFaceMetadata", () => {
  it("returns parsed metadata and caches it", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        config: { architectures: ["Qwen3ForCausalLM"], model_type: "qwen3" },
        pipeline_tag: "text-generation",
        tags: ["text-generation"],
        author: "Qwen",
        safetensors: { total: 8_000_000_000, parameters: { BF16: 8_000_000_000 } },
        usedStorage: 16 * GiB,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const meta = await fetchHuggingFaceMetadata("Qwen/Cache-Test-1");
    expect(meta).toEqual({
      architectures: ["Qwen3ForCausalLM"],
      modelType: "qwen3",
      pipelineTag: "text-generation",
      tags: ["text-generation"],
      author: "Qwen",
      totalParams: 8_000_000_000,
      totalSize: 16 * GiB,
      paramsByDtype: { BF16: 8_000_000_000 },
    });

    const again = await fetchHuggingFaceMetadata("Qwen/Cache-Test-1");
    expect(again).toEqual(meta);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches null on a non-ok response", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchHuggingFaceMetadata("gated/model-x")).toBeNull();
    expect(await fetchHuggingFaceMetadata("gated/model-x")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches null when the request throws", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchHuggingFaceMetadata("offline/model-y")).toBeNull();
    expect(await fetchHuggingFaceMetadata("offline/model-y")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("defaults missing fields to empty/null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );

    expect(await fetchHuggingFaceMetadata("bare/model-z")).toEqual({
      architectures: [],
      modelType: null,
      pipelineTag: null,
      tags: [],
      author: null,
      totalParams: null,
      totalSize: null,
      paramsByDtype: null,
    });
  });
});

describe("enrichWithHuggingFace", () => {
  const stubMeta = (body: Record<string, unknown>) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => body })),
    );
  };

  it("returns the entry untouched when the key is not namespaced", async () => {
    const entry = baseEntry();
    const result = await enrichWithHuggingFace(entry, "local-model");
    expect(result).toBe(entry);
  });

  it("returns the entry untouched when metadata is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    const entry = baseEntry();
    const result = await enrichWithHuggingFace(entry, "org/enrich-missing");
    expect(result).toEqual(entry);
  });

  it("adds vision, video and audio input types plus metadata overrides", async () => {
    stubMeta({
      config: { architectures: ["LlavaForConditionalGeneration"] },
      pipeline_tag: "video-text-to-text",
      tags: ["vision", "audio"],
      author: "org",
      safetensors: { total: 8_000_000_000 },
      usedStorage: 4 * GiB,
    });

    const entry = await enrichWithHuggingFace(baseEntry(), "org/enrich-full");
    expect(entry.vision).toBe(true);
    expect(entry.inputTypes).toEqual([TYPES.TEXT, TYPES.IMAGE, TYPES.VIDEO, TYPES.AUDIO]);
    expect(entry.params).toBe("8B");
    expect(entry.size).toBe("4.00 GB");
    expect(entry.architecture).toBe("LlavaForConditionalGeneration");
    expect(entry.publisher).toBe("org");
  });

  it("does not duplicate input types already present", async () => {
    stubMeta({ pipeline_tag: "image-text-to-text", tags: [] });
    const entry = baseEntry();
    entry.inputTypes = [TYPES.TEXT, TYPES.IMAGE];

    const result = await enrichWithHuggingFace(entry, "org/enrich-dup");
    expect(result.inputTypes).toEqual([TYPES.TEXT, TYPES.IMAGE]);
  });
});

describe("LocalProviderGateway._matchesFilter", () => {
  const gw = new LocalProviderGateway();
  const richModel: ModelEntry = {
    ...baseEntry(),
    name: "Qwen3-8B-Vision",
    label: "Qwen3 8B (Q4_K_M)",
    thinking: true,
    tools: ["Thinking", "Tool Calling"],
    vision: true,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE, TYPES.VIDEO, TYPES.AUDIO],
    loaded: true,
  };

  it("accepts any model for an empty filter", () => {
    expect(gw._matchesFilter(richModel, {})).toBe(true);
  });

  it("rejects when each requested capability is missing", () => {
    const plain = baseEntry();
    expect(gw._matchesFilter(plain, { thinking: true })).toBe(false);
    expect(gw._matchesFilter(plain, { functionCalling: true })).toBe(false);
    expect(gw._matchesFilter(plain, { vision: true })).toBe(false);
    expect(gw._matchesFilter(plain, { video: true })).toBe(false);
    expect(gw._matchesFilter(plain, { audio: true })).toBe(false);
  });

  it("accepts capability matches", () => {
    const filter = {
      thinking: true,
      functionCalling: true,
      vision: true,
      video: true,
      audio: true,
    };
    expect(gw._matchesFilter(richModel, filter)).toBe(true);
  });

  it("filters on modelType", () => {
    expect(gw._matchesFilter(richModel, { modelType: "conversation" })).toBe(true);
    expect(gw._matchesFilter(richModel, { modelType: "embed" })).toBe(false);
  });

  it("filters on loaded state", () => {
    expect(gw._matchesFilter(richModel, { loaded: true })).toBe(true);
    expect(gw._matchesFilter(richModel, { loaded: false })).toBe(false);
    expect(gw._matchesFilter(baseEntry(), { loaded: true })).toBe(false);
    expect(gw._matchesFilter(baseEntry(), { loaded: false })).toBe(true);
  });

  it("matches the query against name or label case-insensitively", () => {
    expect(gw._matchesFilter(richModel, { query: "vision" })).toBe(true);
    expect(gw._matchesFilter(richModel, { query: "Q4_K_M" })).toBe(true);
    expect(gw._matchesFilter(richModel, { query: "llama" })).toBe(false);
  });
});

describe("LocalProviderGateway._fetchModelsForInstance", () => {
  const gw = new LocalProviderGateway();

  it("returns [] when the provider is unknown", async () => {
    fakes.getProvider.mockReturnValueOnce(undefined);
    expect(
      await gw._fetchModelsForInstance(
        { id: "ghost", type: PROVIDERS.OLLAMA } as never,
        100,
        false,
      ),
    ).toEqual([]);
  });

  it("returns [] when the provider cannot list models", async () => {
    fakes.getProvider.mockReturnValueOnce({});
    expect(
      await gw._fetchModelsForInstance(
        { id: "no-list", type: PROVIDERS.OLLAMA } as never,
        100,
        false,
      ),
    ).toEqual([]);
  });

  it("returns [] when listing throws", async () => {
    fakes.getProvider.mockReturnValueOnce({
      listModels: async () => {
        throw new Error("connection refused");
      },
    });
    expect(
      await gw._fetchModelsForInstance(
        { id: "down", type: PROVIDERS.OLLAMA } as never,
        100,
        false,
      ),
    ).toEqual([]);
  });

  it("returns [] for an empty or non-array model list", async () => {
    fakes.getProvider.mockReturnValueOnce({ listModels: async () => ({ models: [] }) });
    expect(
      await gw._fetchModelsForInstance(
        { id: "empty", type: PROVIDERS.OLLAMA } as never,
        100,
        false,
      ),
    ).toEqual([]);

    fakes.getProvider.mockReturnValueOnce({
      listModels: async () => ({ models: "nope" as never }),
    });
    expect(
      await gw._fetchModelsForInstance(
        { id: "bad", type: PROVIDERS.OLLAMA } as never,
        100,
        false,
      ),
    ).toEqual([]);
  });

  it("returns [] when the instance type has no normalizer", async () => {
    fakes.getProvider.mockReturnValueOnce({
      listModels: async () => ({ models: [{ id: "m" }] }),
    });
    expect(
      await gw._fetchModelsForInstance(
        { id: "weird", type: "unregistered-type" } as never,
        100,
        false,
      ),
    ).toEqual([]);
  });

  it("normalizes ollama models", async () => {
    fakes.getProvider.mockReturnValueOnce({
      listModels: async () => ({
        models: [{ model: "llama3:8b", size: 4 * GiB, details: { family: "llama" } }],
      }),
    });

    const models = await gw._fetchModelsForInstance(
      { id: "ollama", type: PROVIDERS.OLLAMA } as never,
      100,
      true,
    );
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe("llama3:8b");
    expect(models[0].architecture).toBe("llama");
  });

  it("enriches vLLM models with HuggingFace metadata", async () => {
    fakes.getProvider.mockReturnValueOnce({
      listModels: async () => ({ data: [{ id: "org/fetch-enrich-1" }] }),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ config: { architectures: ["LlamaForCausalLM"] }, author: "org" }),
      })),
    );

    const models = await gw._fetchModelsForInstance(
      { id: "vllm", type: PROVIDERS.VLLM } as never,
      100,
      true,
    );
    expect(models[0].architecture).toBe("LlamaForCausalLM");
    expect(models[0].publisher).toBe("org");
    expect(models[0].maxOutputTokens).toBe(50000);
  });

  it("skips enrichment when enrich is false", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fakes.getProvider.mockReturnValueOnce({
      listModels: async () => ({ data: [{ id: "org/fetch-enrich-2" }] }),
    });

    const models = await gw._fetchModelsForInstance(
      { id: "vllm", type: PROVIDERS.VLLM } as never,
      100,
      false,
    );
    expect(models[0].architecture).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the un-enriched entry when a single enrichment fails", async () => {
    fakes.getProvider.mockReturnValueOnce({
      listModels: async () => ({ data: [{ id: "org/enrich-throws" }] }),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );

    const models = await gw._fetchModelsForInstance(
      { id: "vllm", type: PROVIDERS.VLLM } as never,
      100,
      true,
    );
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe("org/enrich-throws");
  });
});

describe("LocalProviderGateway.getStats", () => {
  it("aggregates models, capabilities and concurrency across instances", async () => {
    fakes.listInstances.mockReturnValue([
      { id: "lm-studio", type: PROVIDERS.LM_STUDIO, instanceNumber: 1, concurrency: 2 },
      { id: "vllm", type: PROVIDERS.VLLM, instanceNumber: 1, concurrency: 4 },
    ]);
    fakes.getInstance.mockImplementation((id: string) =>
      id === "lm-studio"
        ? { id, type: PROVIDERS.LM_STUDIO }
        : { id, type: PROVIDERS.VLLM },
    );
    fakes.getProvider.mockImplementation((id: string) =>
      id === "lm-studio"
        ? {
            listModels: async () => ({
              models: [
                {
                  key: "qwen3-8b",
                  loaded_instances: [{}],
                  capabilities: { reasoning: true, vision: true },
                },
                { key: "nomic-embed", type: "embedding" },
              ],
            }),
          }
        : { listModels: async () => ({ data: [{ id: "org/served-model" }] }) },
    );

    const stats = await gateway.getStats();

    expect(stats.instances).toBe(2);
    expect(stats.totalModels).toBe(3);
    expect(stats.loadedModels).toBe(1);
    expect(stats.conversationModels).toBe(2);
    expect(stats.embeddingModels).toBe(1);
    expect(stats.modelsByInstance).toEqual({ "lm-studio": 2, vllm: 1 });
    expect(stats.modelsByType).toEqual({ [PROVIDERS.LM_STUDIO]: 2, [PROVIDERS.VLLM]: 1 });
    expect(stats.capabilityDistribution).toEqual({
      thinking: 1,
      functionCalling: 2,
      vision: 1,
      video: 0,
      audio: 0,
    });
    expect(stats.concurrency).toEqual({
      total: 6,
      byType: { [PROVIDERS.LM_STUDIO]: 2, [PROVIDERS.VLLM]: 4 },
      byInstance: { "lm-studio": 2, vllm: 4 },
    });
  });

  it("returns zeroed stats when no instances are registered", async () => {
    fakes.listInstances.mockReturnValue([]);

    const stats = await gateway.getStats();

    expect(stats.totalModels).toBe(0);
    expect(stats.modelsByInstance).toEqual({});
    expect(stats.concurrency.total).toBe(0);
  });
});
