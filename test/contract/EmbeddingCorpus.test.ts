import { it, expect, vi, beforeEach } from "vitest";
import { ProviderError } from "../../src/utils/errors.ts";

const fixture = vi.hoisted(() => ({ embed: vi.fn(), collections: {} as Record<string, any> }));
vi.mock("../../src/services/EmbeddingGemma2Client.ts", async original => ({
  ...(await original<typeof import("../../src/services/EmbeddingGemma2Client.ts")>()),
  EmbeddingGemma2Client: { embedMany: fixture.embed },
}));
vi.mock("../../src/wrappers/MongoWrapper.ts", () => ({
  default: { getCollection: (_db: string, name: string) => (fixture.collections[name] ??= fake([])) },
}));
const { embeddingSpace } = await import("../../src/services/EmbeddingGemma2Client.ts");
const { CORPORA, reembedCorpus, default: EmbeddingCorpusService } = await import("../../src/services/EmbeddingCorpusService.ts");

/** In-memory collection that understands exactly the operators the worker sends. */
function get(doc: any, path: string) { return path.split(".").reduce((value, key) => value?.[key], doc); }
function matches(doc: any, filter: any): boolean {
  return Object.entries(filter).every(([key, condition]: [string, any]) => {
    if (key === "$and") return condition.every((part: any) => matches(doc, part));
    if (key === "$or") return condition.some((part: any) => matches(doc, part));
    const value = get(doc, key);
    if (condition && typeof condition === "object" && !Array.isArray(condition) && Object.keys(condition).some(k => k.startsWith("$"))) {
      return Object.entries(condition).every(([op, operand]: [string, any]) => {
        if (op === "$ne") return value !== operand;
        if (op === "$exists") return (value !== undefined) === operand;
        if (op === "$type") return operand === "string" ? typeof value === "string" : false;
        if (op === "$lt") return value < operand;
        throw new Error(`fake does not support ${op}`);
      });
    }
    return condition === null ? value === undefined || value === null : value === condition;
  });
}
function fake(docs: any[]) {
  return {
    docs,
    find(filter: any) {
      let rows = docs.filter(doc => matches(doc, filter));
      const cursor = {
        sort(spec: any) { const [[key, dir]] = Object.entries(spec) as [string, number][]; rows = [...rows].sort((a, b) => (get(a, key) < get(b, key) ? -1 : 1) * dir); return cursor; },
        limit(n: number) { rows = rows.slice(0, n); return cursor; },
        async toArray() { return rows.map(row => ({ ...row })); },
      };
      return cursor;
    },
    async bulkWrite(operations: any[]) {
      let matchedCount = 0;
      for (const { updateOne: { filter, update } } of operations) {
        const doc = docs.find(row => matches(row, filter));
        if (doc) { matchedCount++; Object.assign(doc, update.$set); }
      }
      return { matchedCount, modifiedCount: matchedCount };
    },
    async countDocuments(filter: any) { return docs.filter(doc => matches(doc, filter)).length; },
  };
}
const unit = (n: number, i: number) => Array.from({ length: n }, (_, d) => (d === i ? 1 : 0));
const corpus = (name: string) => CORPORA.find(def => def.name === name)!;

beforeEach(() => {
  vi.clearAllMocks();
  fixture.collections = {};
  fixture.embed.mockImplementation(async (texts: string[]) => texts.map((_t, i) => unit(768, i)));
});

it("re-embeds legacy and old-space harness docs, and leaves current ones alone", async () => {
  const memories = fake([
    { _id: 1, title: "Deploy", content: "use the kit", embedding: [0.1] },
    { _id: 2, content: "old model", semanticEmbedding: { vector: [1], space: "google/embeddinggemma-300m:768" } },
    { _id: 3, content: "current", semanticEmbedding: { vector: unit(768, 0), space: embeddingSpace() } },
  ]);
  const result = await reembedCorpus(corpus("harness.memories"), () => memories as any);
  expect(result).toMatchObject({ updated: 2, skippedEmpty: 0, changedDuringPass: 0, refused: 0 });
  expect(fixture.embed).toHaveBeenCalledWith(["old model", "Deploy: use the kit"], "document"); // newest _id first
  expect(memories.docs[0].semanticEmbedding).toMatchObject({ space: embeddingSpace(), sourceHash: expect.any(String) });
  expect(memories.docs[0].embedding).toEqual([0.1]); // the legacy vector stays for rollback
  expect(memories.docs[2].semanticEmbedding.vector).toEqual(unit(768, 0));
});

it("writes trading's layout: packed little-endian float32 plus the space, only for docs that store their text", async () => {
  const embeddings = fake([
    { _id: 1, embed_text: "NVDA raised guidance", embedding: Buffer.alloc(16), space: undefined },
    { _id: 2, content_preview: "legacy doc without its embedded text" },
    { _id: 3, embed_text: "", space: undefined },
  ]);
  const result = await reembedCorpus(corpus("trading.embeddings"), () => embeddings as any);
  expect(result.updated).toBe(1);
  const doc = embeddings.docs[0];
  expect(doc.space).toBe(embeddingSpace());
  expect(doc.semantic_dim).toBe(768);
  const bytes = Buffer.from(doc.semantic_embedding.buffer);
  expect(bytes.length).toBe(768 * 4);
  expect(bytes.readFloatLE(0)).toBe(1);
  expect(embeddings.docs[1].space).toBeUndefined();
});

it("does not overwrite a doc whose text changed while it was being embedded", async () => {
  const memories = fake([{ _id: 1, content: "before" }]);
  fixture.embed.mockImplementation(async (texts: string[]) => { memories.docs[0].content = "after"; return texts.map((_t, i) => unit(768, i)); });
  const result = await reembedCorpus(corpus("harness.memories"), () => memories as any);
  expect(result).toMatchObject({ updated: 0, changedDuringPass: 1 });
  expect(memories.docs[0].semanticEmbedding).toBeUndefined();
});

it("isolates a refused text so its neighbours are still written", async () => {
  const memories = fake([{ _id: 1, content: "fine one" }, { _id: 2, content: "too long" }, { _id: 3, content: "fine two" }]);
  fixture.embed.mockImplementation(async (texts: string[]) => {
    if (texts.includes("too long")) throw new ProviderError("jetson-embedding", "Embedding request refused (HTTP 400)", 400);
    return texts.map((_t, i) => unit(768, i));
  });
  const result = await reembedCorpus(corpus("harness.memories"), () => memories as any);
  expect(result).toMatchObject({ updated: 2, refused: 1 });
  expect(memories.docs[1].semanticEmbedding).toBeUndefined();
});

it("stops on quarantine instead of looping, and terminates over docs with no text", async () => {
  const memories = fake([{ _id: 1, content: "" }, { _id: 2, title: "", content: "  " }]);
  expect(await reembedCorpus(corpus("harness.memories"), () => memories as any)).toMatchObject({ updated: 0, skippedEmpty: 2 });
  fixture.embed.mockRejectedValue(new ProviderError("jetson-embedding", "Embedding service is not ready", 503));
  const busy = fake([{ _id: 1, content: "text" }]);
  await expect(reembedCorpus(corpus("harness.memories"), () => busy as any)).rejects.toMatchObject({ statusCode: 503 });
});

it("builds a conversation's text from its title, summary and linked memories", async () => {
  const conversations = fake([{ _id: 1, id: "c1", agent: "CODING", title: "Fix deploy", compactionSummary: "Kit failed", summaryEmbedding: [0.2] }]);
  const memories = fake([{ _id: 9, conversationId: "c1", agent: "CODING", title: "Cause", content: "stale env", createdAt: "2026-10-06" }]);
  await reembedCorpus(corpus("harness.agent_conversations"), name => (name === "memories" ? memories : conversations) as any);
  expect(fixture.embed).toHaveBeenCalledWith(["Fix deploy\nKit failed\nCause: stale env"], "document");
  expect(conversations.docs[0].summarySemanticEmbedding.space).toBe(embeddingSpace());
});

it("reports stale and total docs per corpus, and a run re-embeds every corpus", async () => {
  fixture.collections.memories = fake([{ _id: 1, content: "legacy memory" }]);
  fixture.collections.embeddings = fake([{ _id: 1, embed_text: "chunk" }, { _id: 2, content_preview: "no text yet" }]);
  const before = await EmbeddingCorpusService.status();
  const row = (status: any, name: string) => status.corpora.find((c: any) => c.name === name);
  expect(row(before, "harness.memories")).toMatchObject({ total: 1, stale: 1 });
  expect(row(before, "trading.embeddings")).toMatchObject({ total: 1, stale: 1 });
  await EmbeddingCorpusService.runAll();
  const after = await EmbeddingCorpusService.status();
  expect(row(after, "harness.memories")).toMatchObject({ stale: 0, lastPass: expect.objectContaining({ updated: 1 }) });
  expect(row(after, "trading.embeddings")).toMatchObject({ stale: 0, lastPass: expect.objectContaining({ updated: 1 }) });
});
