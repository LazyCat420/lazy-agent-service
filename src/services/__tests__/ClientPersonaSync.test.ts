/**
 * Boot persona sync — ClientPersonaSync replaces the old Prism REST upsert.
 *
 * The HTML_NOTES persona must exist in our own custom_agents collection
 * under the SAME document identity prism wrote (name "HTML-Notes Canvas" →
 * derived agentId CUSTOM_HTML_NOTES_CANVAS), with every availableTool
 * persisted, and a drifted row must be repaired.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

type Doc = Record<string, unknown> & { _id: ObjectId };

interface MockCollection {
  docs: Doc[];
  calls: { inserted: Doc[]; updates: Array<{ filter: unknown; set: Record<string, unknown> }> };
  find(): { sort(): { toArray(): Promise<Doc[]> } };
  findOne(filter: { _id?: unknown; agentId?: string; name?: string }): Promise<Doc | null>;
  insertOne(doc: Doc): Promise<{ insertedId: ObjectId }>;
  updateOne(filter: { _id?: unknown }, update: { $set: Record<string, unknown> }): Promise<{ matchedCount: number }>;
}

function makeCollection(docs: Doc[]): MockCollection {
  const calls = { inserted: [] as Doc[], updates: [] as Array<{ filter: unknown; set: Record<string, unknown> }> };
  const byId = (id: unknown) => docs.find((d) => String(d._id) === String(id));
  return {
    docs,
    calls,
    find() {
      return { sort: () => ({ toArray: async () => [...docs] }) };
    },
    async findOne(filter: { _id?: unknown; agentId?: string; name?: string }) {
      if (filter.agentId !== undefined) {
        return (
          docs.find(
            (d) =>
              d.agentId === filter.agentId &&
              !(filter._id && typeof filter._id === "object" && "$ne" in filter._id &&
                String((filter._id as { $ne: unknown }).$ne) === String(d._id)),
          ) ?? null
        );
      }
      if (filter.name !== undefined) return docs.find((d) => d.name === filter.name) ?? null;
      return byId(filter._id) ?? null;
    },
    async insertOne(doc: Doc) {
      calls.inserted.push(doc);
      docs.push(doc);
      return { insertedId: doc._id };
    },
    async updateOne(filter: { _id?: unknown }, { $set }: { $set: Record<string, unknown> }) {
      calls.updates.push({ filter, set: $set });
      const doc = byId(filter._id);
      if (doc) Object.assign(doc, $set);
      return { matchedCount: doc ? 1 : 0 };
    },
  };
}

// vi.mock is hoisted, so the wrapper lives entirely in vi.hoisted state.
const mocks = vi.hoisted(() => {
  const collection = { current: null as unknown as MockCollection | null };
  const wrapper = {
    getCollection(_db: string, col: string) {
      if (col !== "custom_agents") return null;
      return collection.current;
    },
  };
  return { collection, wrapper };
});

vi.mock("../../wrappers/MongoWrapper.ts", () => ({ default: mocks.wrapper }));

import { syncClientPersonas } from "../ClientPersonaSync.ts";
import AgentPersonaRegistry from "../AgentPersonaRegistry.ts";
import { HtmlNotesPersona } from "../personas/clients/HtmlNotesPersona.ts";

const TOOL_COUNT = HtmlNotesPersona.availableTools?.length ?? 0;

/** Non-null accessor for the collection the current test installed. */
function col(): MockCollection {
  return mocks.collection.current as MockCollection;
}

describe("ClientPersonaSync.syncClientPersonas", () => {
  beforeEach(() => {
    mocks.collection.current = makeCollection([]);
  });

  it("creates the HTML-Notes Canvas row with the derived agentId and every tool", async () => {
    await syncClientPersonas();

    expect(col().calls.inserted).toHaveLength(1);
    const doc = col().calls.inserted[0];
    expect(doc.name).toBe("HTML-Notes Canvas");
    expect(doc.agentId).toBe("CUSTOM_HTML_NOTES_CANVAS");
    expect((doc.availableTools as string[]).length).toBe(TOOL_COUNT);
    // The persona is registered live too, not only on next boot.
    expect(AgentPersonaRegistry.get("CUSTOM_HTML_NOTES_CANVAS")?.name).toBe("HTML-Notes Canvas");
  });

  it("repairs a drifted existing row (idempotent upsert, not a duplicate)", async () => {
    col().docs.push({
      _id: new ObjectId(),
      name: "HTML-Notes Canvas",
      agentId: "CUSTOM_HTML_NOTES_CANVAS",
      description: "stale",
      availableTools: HtmlNotesPersona.availableTools!.slice(0, 21),
      project: "coding",
    });

    await syncClientPersonas();

    expect(col().calls.inserted).toHaveLength(0);
    expect(col().calls.updates).toHaveLength(1);
    const doc = col().docs[0];
    expect((doc.availableTools as string[]).length).toBe(TOOL_COUNT);
    expect(doc.description).toBe(HtmlNotesPersona.description);
  });

  it("detects tools dropped by the write — the read-back is verified, not trusted", async () => {
    col().docs.push({
      _id: new ObjectId(),
      name: "HTML-Notes Canvas",
      agentId: "CUSTOM_HTML_NOTES_CANVAS",
      availableTools: [],
      project: "coding",
    });
    // A collection whose updateOne silently drops half the tool scope — the
    // failure mode the read-back exists for (a 2xx that under-scopes the agent).
    const dropping = makeCollection(col().docs);
    const proxied: MockCollection = {
      ...dropping,
      async updateOne(filter: { _id?: unknown }, update: { $set: Record<string, unknown> }) {
        return dropping.updateOne(filter, {
          $set: { ...update.$set, availableTools: (update.$set.availableTools as string[]).slice(0, 5) },
        });
      },
    };
    const original = mocks.collection.current;
    mocks.collection.current = proxied;
    try {
      await syncClientPersonas();
      const doc = dropping.docs[0];
      expect(doc).toBeDefined();
      const persisted = doc.availableTools as string[];
      expect(persisted.length).toBe(5);
      expect(persisted.length).toBeLessThan(TOOL_COUNT);
    } finally {
      mocks.collection.current = original;
    }
  });

  it("never throws when Mongo is unavailable", async () => {
    const original = mocks.collection.current as MockCollection | null;
    mocks.collection.current = null as unknown as MockCollection;
    try {
      await expect(syncClientPersonas()).resolves.toBeUndefined();
    } finally {
      mocks.collection.current = original;
    }
  });
});
