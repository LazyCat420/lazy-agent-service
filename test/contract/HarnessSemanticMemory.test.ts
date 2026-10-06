import { describe, it, expect, vi, beforeEach } from "vitest";
import { embeddingSpace } from "../../src/services/EmbeddingGemma2Client.ts";
const fixture = vi.hoisted(() => ({ rows: [] as any[], write: vi.fn(), embed: vi.fn(), query: vi.fn() }));
vi.mock("../../src/wrappers/MongoWrapper.ts", () => {
  const collection = { findOne: async () => null, updateOne: fixture.write, insertOne: fixture.write, countDocuments: async () => fixture.rows.length,
    find: (filter: unknown) => { fixture.query(filter); const cursor = { project: () => cursor, sort: () => cursor, limit: () => cursor, toArray: async () => fixture.rows }; return cursor; } };
  return { default: { getDb: () => ({ collection: () => collection }), getCollection: () => collection } };
});
vi.mock("../../src/services/EmbeddingService.ts", () => ({ default: { generate: fixture.embed } }));
const { default: WorkflowMemoryService } = await import("../../src/services/WorkflowMemoryService.ts");
const { default: MemoryService } = await import("../../src/services/MemoryService.ts");
const { default: ConversationEmbeddingService } = await import("../../src/services/ConversationEmbeddingService.ts");
beforeEach(() => {
  vi.clearAllMocks(); fixture.rows = [];
  fixture.embed.mockResolvedValue({ embedding: Array(768).fill(1 / Math.sqrt(768)), space: embeddingSpace() });
});
describe("semantic memory on arbitrary harness projects", () => {
  it("stores successful workflows outside the persona project list", async () => {
    const messages = [{ role: "user", content: "Review repo" }, { role: "assistant", content: "Reading" }, { role: "tool", content: "Source" }, { role: "assistant", content: "Reviewed", toolCalls: [1, 2, 3].map(i => ({ name: `read_${i}`, args: {}, result: { ok: true } })) }];
    await WorkflowMemoryService.extractAndPersist({ conversationId: "run", agentConversationId: "run", project: "repo-with-no-persona", username: "test-user", messages } as any, { messages });
    expect(fixture.embed).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ taskType: "RETRIEVAL_DOCUMENT" }));
    expect(fixture.write).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ $set: expect.objectContaining({ project: "repo-with-no-persona", semanticEmbedding: expect.objectContaining({ space: embeddingSpace() }) }) }), { upsert: true });
  });
  it("creates a summary record for a general run without an existing conversation", async () => {
    await ConversationEmbeddingService.generateAndPersist({ conversationId: "run", agentConversationId: "run", project: "repo-with-no-persona", username: "test-user", agent: null, traceId: null, endpoint: "/v1/runs", title: "Review repo", messageCount: 6 });
    expect(fixture.write).toHaveBeenCalledWith({ id: "run", project: "repo-with-no-persona", username: "test-user" }, expect.objectContaining({ $set: expect.objectContaining({ summarySemanticEmbedding: expect.objectContaining({ space: embeddingSpace() }) }) }), { upsert: true });
  });
  it("does not rank equal-dimension legacy vectors against new queries", async () => {
    fixture.rows = [{ _id: "legacy", embedding: Array(768).fill(1), content: "legacy", createdAt: new Date().toISOString() }, { _id: "current", semanticEmbedding: { vector: Array(768).fill(1), space: embeddingSpace() }, content: "current", createdAt: new Date().toISOString() }];
    const results = await MemoryService.search({ agent: "CODING", project: "repo-with-no-persona", queryText: "review" });
    expect(results.map(row => row.id)).toEqual(["current"]);
    expect(fixture.embed).toHaveBeenCalledWith("review", expect.objectContaining({ taskType: "RETRIEVAL_QUERY" }));
    expect(fixture.query).toHaveBeenCalledWith({ agent: "CODING", project: "repo-with-no-persona" });
  });
});
