import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ObjectId } from "mongodb";
import MongoWrapper from "../../wrappers/MongoWrapper.ts";
import RequestLogger from "../RequestLogger.ts";

// The harness and prism write to the same `prism.requests` collection, and its
// readers — trading's Monitor page and audit tools, prism-client — filter and
// sort on `createdAt`, prism's field name. The harness wrote only `timestamp`,
// so every time-based reader silently skipped harness calls (measured
// 2026-10-06: parity rows had createdAt=None). These tests pin the shared shape.

describe("RequestLogger writes rows the prism.requests readers can see", () => {
  let inserted: Record<string, unknown>[];
  let updates: Record<string, unknown>[];

  beforeEach(() => {
    inserted = [];
    updates = [];
    const collection = {
      insertOne: vi.fn(async (doc: Record<string, unknown>) => {
        inserted.push(doc);
        return { insertedId: new ObjectId() };
      }),
      updateOne: vi.fn(
        async (_filter: unknown, update: { $set: Record<string, unknown> }) => {
          updates.push(update.$set);
          return { modifiedCount: 1, matchedCount: 1 };
        },
      ),
    };
    vi.spyOn(MongoWrapper, "getDb").mockReturnValue({
      collection: () => collection,
    } as never);
  });

  afterEach(() => vi.restoreAllMocks());

  it("log(): createdAt mirrors timestamp and toolApiNameCount counts the tools", async () => {
    await RequestLogger.log({
      requestId: "r1",
      endpoint: "/agent",
      project: "vllm-trading-bot",
      username: "tester",
      provider: "vllm",
      model: "nemotron35",
      toolApiNames: ["get_finnhub_news", "get_quote"],
    } as never);
    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    expect(row.createdAt).toBeTypeOf("string");
    expect(row.createdAt).toBe(row.timestamp);
    expect(row.toolApiNameCount).toBe(2);
  });

  it("insertPending(): the pending row carries createdAt as well", async () => {
    await RequestLogger.insertPending({
      requestId: "r2",
      endpoint: "/agent",
      project: "vllm-trading-bot",
      username: "tester",
    } as never);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].createdAt).toBeTypeOf("string");
    expect(inserted[0].createdAt).toBe(inserted[0].timestamp);
  });

  it("completePending(): the completed row reports toolApiNameCount", async () => {
    await RequestLogger.completePending(new ObjectId(), {
      requestId: "r3",
      endpoint: "/agent",
      project: "vllm-trading-bot",
      username: "tester",
      toolApiNames: ["get_quote"],
    } as never);
    expect(updates).toHaveLength(1);
    expect(updates[0].toolApiNameCount).toBe(1);
  });

  it("negative control: with no tools the count is 0, never missing", async () => {
    await RequestLogger.completePending(new ObjectId(), {
      requestId: "r4",
      endpoint: "/agent",
      project: "vllm-trading-bot",
      username: "tester",
    } as never);
    expect(updates).toHaveLength(1);
    expect(updates[0].toolApiNameCount).toBe(0);
  });
});
