import { describe, it, expect, vi, afterEach } from "vitest";
import { EmbeddingGemma2Client, EMBEDDING_REVISION, embeddingChunks, embeddingSpace } from "../../src/services/EmbeddingGemma2Client.ts";
import { compatibleVector } from "../../src/services/SemanticEmbedding.ts";

afterEach(() => vi.restoreAllMocks());
const health = () => new Response(JSON.stringify({ model: "google/embeddinggemma-2", revision: EMBEDDING_REVISION, dimensions: 768, ready: true }));
describe("shared EmbeddingGemma 2 contract", () => {
  it("chunks multibyte text without losing content", () => {
    const text = "記憶🚀".repeat(1000);
    const chunks = embeddingChunks(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every(chunk => Buffer.byteLength(chunk) <= 1800)).toBe(true);
  });
  it("preserves batch order and selects retrieval prefixes on the server", async () => {
    const requests: Record<string, any>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      if (!init?.body) return health();
      const body = JSON.parse(init.body); requests.push(body);
      return new Response(JSON.stringify({ data: body.input.map((_text, i) => ({ index: i, embedding: Array.from({ length: body.dimensions }, (_, d) => d === i ? 1 : 0) })).reverse() }));
    }));
    const results = await EmbeddingGemma2Client.embedMany(["first", "second"], "RETRIEVAL_DOCUMENT");
    expect(results[0][0]).toBe(1); expect(results[1][1]).toBe(1);
    expect(requests[0]).toMatchObject({ model: "embeddinggemma-2", input_type: "document", dimensions: 768, encoding_format: "float" });
    await EmbeddingGemma2Client.generate("search", "RETRIEVAL_QUERY", 256);
    expect(requests[1]).toMatchObject({ input_type: "query", dimensions: 256 });
  });
  it("never retries quarantine and recovers its queue for a later request", async () => {
    const inference = vi.fn().mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ index: 0, embedding: Array(768).fill(1) }] })));
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => init?.body ? inference() : health()));
    await expect(EmbeddingGemma2Client.generate("first", "document")).rejects.toMatchObject({ statusCode: 503 });
    expect(inference).toHaveBeenCalledTimes(1);
    expect((await EmbeddingGemma2Client.generate("next", "document")).embedding).toHaveLength(768);
  });
  it("rejects wrong dimensions", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => !init?.body ? health() : new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }))));
    await expect(EmbeddingGemma2Client.generate("text")).rejects.toMatchObject({ statusCode: 502 });
    await expect(EmbeddingGemma2Client.generate("text", "document", 10)).rejects.toMatchObject({ statusCode: 400 });
  });
  it("excludes same-size legacy and mismatched model spaces", () => {
    expect(compatibleVector({ vector: [1], space: "old-model" }, embeddingSpace())).toBeNull();
    expect(compatibleVector([1], embeddingSpace())).toBeNull();
    expect(compatibleVector({ vector: [1], space: embeddingSpace() }, embeddingSpace())).toBeNull();
    const vector = Array(768).fill(1);
    expect(compatibleVector({ vector, space: embeddingSpace() }, embeddingSpace())).toEqual(vector);
  });
});
