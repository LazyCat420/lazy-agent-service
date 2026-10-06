import { it, expect, vi, beforeEach } from "vitest";
const fixture = vi.hoisted(() => ({ provider: vi.fn(), generate: vi.fn(), config: { provider: "jetson-embedding", model: "embeddinggemma-2" } }));
vi.mock("../../src/providers/index.ts", () => ({ getProvider: fixture.provider }));
vi.mock("../../src/services/SettingsService.ts", () => ({ default: { getMemoryModelConfig: async () => fixture.config } }));
vi.mock("../../src/services/RequestLogger.ts", () => ({ default: { log: vi.fn() } }));
vi.mock("../../src/config.ts", () => ({ TYPES: { TEXT: "text", EMBEDDING: "embedding" }, getDefaultModels: () => ({ openai: "cloud-default" }), getPricing: () => ({}) }));
const { default: EmbeddingService } = await import("../../src/services/EmbeddingService.ts");
beforeEach(() => {
  vi.clearAllMocks(); fixture.config = { provider: "jetson-embedding", model: "embeddinggemma-2" };
  fixture.generate.mockResolvedValue({ embedding: Array(768).fill(1), dimensions: 768 });
  fixture.provider.mockReturnValue({ generateEmbedding: fixture.generate });
});
it("resolves default and legacy instance callers to the shared Jetson client", async () => {
  const result = await EmbeddingService.generate("document");
  expect(result).toMatchObject({ provider: "jetson-embedding", model: "embeddinggemma-2", dimensions: 768 });
  expect(fixture.generate).toHaveBeenCalledWith("document", "embeddinggemma-2", { taskType: "RETRIEVAL_DOCUMENT" });
  await EmbeddingService.generate("document", { provider: "vllm-3" });
  expect(fixture.provider).toHaveBeenLastCalledWith("jetson-embedding");
});
it("preserves an explicit cloud provider", async () => {
  await EmbeddingService.generate("document", { provider: "openai" });
  expect(fixture.provider).toHaveBeenCalledWith("openai");
  expect(fixture.generate).toHaveBeenCalledWith("document", "cloud-default", {});
});
it("honors the configured model before the provider default", async () => {
  fixture.config = { provider: "openai", model: "configured-model" };
  const result = await EmbeddingService.generate("query", { taskType: "RETRIEVAL_QUERY" });
  expect(result.model).toBe("configured-model");
  expect(fixture.generate).toHaveBeenCalledWith("query", "configured-model", { taskType: "RETRIEVAL_QUERY" });
});
