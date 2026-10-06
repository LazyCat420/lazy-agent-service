import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { EMBEDDING_REVISION, embeddingSpace } from "../../src/services/EmbeddingGemma2Client.ts";

const fixture = vi.hoisted(() => ({ log: vi.fn(), provider: vi.fn(), config: { provider: "jetson-embedding", model: "embeddinggemma-2" } }));
vi.mock("../../src/services/SettingsService.ts", () => ({ default: { getMemoryModelConfig: async () => fixture.config } }));
vi.mock("../../src/services/RequestLogger.ts", () => ({ default: { log: fixture.log } }));
vi.mock("../../src/providers/index.ts", () => ({ getProvider: fixture.provider }));
vi.mock("../../src/config.ts", () => ({ TYPES: { TEXT: "text", EMBEDDING: "embedding" }, getDefaultModels: () => ({ openai: "cloud-default" }), getPricing: () => ({}) }));
const { default: EmbeddingService, MAX_BATCH_TEXTS } = await import("../../src/services/EmbeddingService.ts");
const { default: embedRouter } = await import("../../src/routes/EmbedRoutes.ts");

const health = () => new Response(JSON.stringify({ model: "google/embeddinggemma-2", revision: EMBEDDING_REVISION, dimensions: 768, ready: true }));
let requests: Record<string, any>[] = [];
beforeEach(() => {
  vi.clearAllMocks(); requests = [];
  fixture.config = { provider: "jetson-embedding", model: "embeddinggemma-2" };
  // One-hot vector per input so order is observable after normalization.
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (!init?.body) return health();
    const body = JSON.parse(init.body); requests.push(body);
    const offset = requests.slice(0, -1).reduce((sum, request) => sum + request.input.length, 0);
    return new Response(JSON.stringify({ data: body.input.map((_text: string, i: number) => ({ index: i, embedding: Array.from({ length: body.dimensions }, (_, d) => d === offset + i ? 1 : 0) })) }));
  }));
});
afterEach(() => vi.unstubAllGlobals());

it("returns one vector per text in input order, in the same space as a single request", async () => {
  const texts = Array.from({ length: 10 }, (_, i) => `document ${i}`);
  const result = await EmbeddingService.generateMany(texts, { taskType: "query" });
  expect(result).toMatchObject({ provider: "jetson-embedding", model: "embeddinggemma-2", dimensions: 768, space: embeddingSpace(768) });
  expect(result.embeddings).toHaveLength(10);
  result.embeddings.forEach((vector, i) => expect(vector[i]).toBe(1));
  expect(requests.map(request => request.input.length)).toEqual([8, 2]);
  expect(requests.every(request => request.input_type === "query")).toBe(true);
});

it("logs one request row with counts and never the texts", async () => {
  await EmbeddingService.generateMany(["private corpus text", "second private text"], { source: "api" });
  expect(fixture.log).toHaveBeenCalledTimes(1);
  const row = fixture.log.mock.calls[0][0];
  expect(row).toMatchObject({ operation: "api:embed-batch", success: true, requestPayload: { contentType: "text-batch", count: 2, taskType: "RETRIEVAL_DOCUMENT" } });
  expect(JSON.stringify(row)).not.toContain("private");
});

it("rejects empty, oversized and non-string batches before calling the Jetson", async () => {
  for (const texts of [[], [""], ["ok", 3], Array(MAX_BATCH_TEXTS + 1).fill("x")]) {
    await expect(EmbeddingService.generateMany(texts as string[])).rejects.toMatchObject({ statusCode: 400 });
  }
  expect(requests).toHaveLength(0);
});

it("falls back to one provider call per text for an explicit cloud provider", async () => {
  const generate = vi.fn().mockResolvedValue({ embedding: [1, 0, 0], dimensions: 3 });
  fixture.provider.mockReturnValue({ generateEmbedding: generate });
  const result = await EmbeddingService.generateMany(["a", "b"], { provider: "openai" });
  expect(generate).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({ provider: "openai", model: "cloud-default", dimensions: 3, embeddings: [[1, 0, 0], [1, 0, 0]] });
});

it("POST /embed with texts returns embeddings; mixing texts with text is refused", async () => {
  const handler = (embedRouter as any).stack.find((layer: any) => layer.route?.path === "/").route.stack[0].handle;
  const call = (body: Record<string, unknown>) => new Promise<{ body?: any; error?: any }>(resolve => {
    const res: any = { json: (payload: unknown) => resolve({ body: payload }) };
    handler({ body, project: "trading", username: "test-user" }, res, (error: unknown) => resolve({ error }));
  });
  const ok = await call({ texts: ["one", "two"], input_type: "document" });
  expect(ok.body.embeddings).toHaveLength(2);
  expect(ok.body.space).toBe(embeddingSpace(768));
  const mixed = await call({ texts: ["one"], text: "two" });
  expect(mixed.error).toMatchObject({ statusCode: 400 });
});
