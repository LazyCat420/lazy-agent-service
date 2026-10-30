/**
 * ConversationsRoutes — merged listing, per-conversation read, message append,
 * patch, delete with cascade, and the pending-approval overlay.
 *
 * Mongo is an in-memory filter-matching stand-in; ConversationService and the
 * loop/timer services are stubs. Assertions are on the JSON and on the stored
 * documents.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import router from "../ConversationsRoutes.ts";

const stub = vi.hoisted(() => ({
  appended: null as null | { id: string; collection?: string; messages: unknown[] },
  stats: null as Record<string, unknown> | null,
  pendingApproval: { isPending: false } as Record<string, unknown>,
  pendingQuestion: { isPending: false } as Record<string, unknown>,
  timers: [] as unknown[],
  cancelled: true,
}));

vi.mock("../../services/ConversationService.ts", () => ({
  default: {
    async appendMessages(id: string, _project: string, _username: string, messages: unknown[], _meta: unknown, options: any) {
      stub.appended = { id, collection: options?.collection, messages };
      return { id, messages, updatedAt: "2026-01-02T00:00:00.000Z" };
    },
    async getConversationStats() {
      return stub.stats;
    },
  },
  buildConversationPatchFields: (input: Record<string, unknown>) => {
    const fields: Record<string, unknown> = {};
    for (const key of ["title", "messages", "systemPrompt", "settings"]) {
      if (input[key] !== undefined) fields[key] = input[key];
    }
    return fields;
  },
  enrichConversationsWithRequestCosts: (conversations: any[], aggregation: any[]) => {
    for (const row of aggregation) {
      const target = conversations.find((conversation) => conversation.id === row._id);
      if (target) {
        target.totalCost = row.totalCost;
        target.requestErrorCount = row.requestErrorCount;
      }
    }
  },
  enrichSingleConversationCost: (conversation: any, aggregation: any[]) => {
    const row = aggregation.find((entry) => entry._id === conversation.id);
    if (row) {
      conversation.totalCost = row.totalCost;
      conversation.requestErrorCount = row.requestErrorCount;
    }
  },
}));

vi.mock("../../services/ConversationTimerService.ts", () => ({
  default: {
    async listActiveTimers() {
      return stub.timers;
    },
    async cancelTimer() {
      return stub.cancelled;
    },
  },
}));

vi.mock("../../services/AgenticLoopService.ts", () => ({
  default: {
    getPendingApproval: () => stub.pendingApproval,
    getPendingQuestion: () => stub.pendingQuestion,
  },
}));

type Row = Record<string, any>;

const matches = (row: Row, filter: Row) =>
  Object.entries(filter).every(([key, expected]) => {
    if (expected && typeof expected === "object" && "$in" in expected) {
      return (expected.$in as unknown[]).includes(row[key]);
    }
    if (expected && typeof expected === "object" && "$lt" in expected) {
      return row[key] < expected.$lt;
    }
    return row[key] === expected;
  });

function fakeDb(seed: { model?: Row[]; agent?: Row[]; requests?: Row[] | Error; workflows?: Row[] } = {}) {
  const store: Record<string, Row[]> = {
    model_conversations: [...(seed.model || [])],
    agent_conversations: [...(seed.agent || [])],
    workflows: [...(seed.workflows || [])],
  };
  const cursor = (rows: Row[]) => {
    let data = rows;
    const api: any = {
      project: () => api,
      sort: () => api,
      limit: (count: number) => {
        data = data.slice(0, count);
        return api;
      },
      toArray: async () => data,
    };
    return api;
  };
  const collection = (name: string) => {
    if (name === "requests") {
      return {
        aggregate: () => ({
          toArray: async () => {
            if (seed.requests instanceof Error) throw seed.requests;
            return seed.requests || [];
          },
        }),
      };
    }
    const rows = () => store[name] || [];
    return {
      find: (filter: Row) => cursor(rows().filter((row) => matches(row, filter))),
      findOne: async (filter: Row) => rows().find((row) => matches(row, filter)) ?? null,
      countDocuments: async (filter: Row) => rows().filter((row) => matches(row, filter)).length,
      async updateOne(filter: Row, update: Row) {
        const target = rows().find((row) => matches(row, filter));
        if (!target) return { matchedCount: 0 };
        Object.assign(target, update.$set || {});
        return { matchedCount: 1 };
      },
      async deleteOne(filter: Row) {
        const index = rows().findIndex((row) => matches(row, filter));
        if (index < 0) return { deletedCount: 0 };
        store[name].splice(index, 1);
        return { deletedCount: 1 };
      },
      async deleteMany(filter: Row) {
        const kept = rows().filter((row) => !matches(row, filter));
        const deletedCount = rows().length - kept.length;
        store[name] = kept;
        return { deletedCount };
      },
    };
  };
  return { db: { collection }, store };
}

const handlerFor = (method: string, path: string) => {
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route.methods[method],
  );
  if (!layer) throw new Error(`${method} ${path} is not registered`);
  return layer.route.stack.at(-1).handle as (req: any, res: any, next: any) => Promise<unknown>;
};

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      res.headersSent = true;
      return res;
    },
  };
  return res;
}

function fakeReq(over: Record<string, unknown> = {}) {
  return {
    params: {},
    body: {},
    query: {},
    headers: { host: "prism.local" },
    project: "proj",
    username: "alice",
    db: undefined,
    ...over,
  };
}

const invoke = async (method: string, path: string, req: any) => {
  const res = fakeRes();
  const errors: unknown[] = [];
  await handlerFor(method, path)(req, res, (error: unknown) => errors.push(error));
  return { res, errors };
};

const conversation = (over: Row = {}): Row => ({
  _id: "oid",
  id: "c1",
  project: "proj",
  username: "alice",
  title: "Chat",
  updatedAt: "2026-01-01T00:00:00.000Z",
  messages: [],
  ...over,
});

beforeEach(() => {
  stub.appended = null;
  stub.stats = null;
  stub.pendingApproval = { isPending: false };
  stub.pendingQuestion = { isPending: false };
  stub.timers = [];
  stub.cancelled = true;
});

describe("GET /conversations — merged listing", () => {
  const seed = () => ({
    model: [
      conversation({ id: "c1", updatedAt: "2026-01-01T00:00:00.000Z" }),
      conversation({ id: "c2", username: "anonymous", updatedAt: "2026-01-05T00:00:00.000Z", subAgents: [{ id: "s1" }] }),
    ],
    agent: [
      conversation({ id: "a1", agent: "orchestrator", updatedAt: "2026-01-04T00:00:00.000Z" }),
      conversation({ id: "a2", agent: "worker", parentConversationId: "a1", updatedAt: "2026-01-03T00:00:00.000Z" }),
      conversation({ id: "a3", agent: "worker", parentConversationId: "a2", updatedAt: "2026-01-02T00:00:00.000Z" }),
    ],
    requests: [
      { _id: "c1", totalCost: 1.5, requestErrorCount: 2 },
      { _id: "a1", totalCost: 0.25, requestErrorCount: 0 },
    ],
  });

  it("merges both collections newest-first and pages with a cursor", async () => {
    const { db } = fakeDb(seed());
    const { res, errors } = await invoke("get", "/", fakeReq({ db, query: { limit: "2" } }));

    expect(errors).toEqual([]);
    expect(res.statusCode).toBe(200);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.items.map((item: any) => item.id)).toEqual(["c2", "a1"]);
    expect(res.body.nextCursor).toBe("2026-01-04T00:00:00.000Z");
    expect(res.body.items.map((item: any) => item.type)).toEqual(["direct", "agent"]);
    // The heavy subAgents array is stripped, the derived flag kept.
    expect(res.body.items[0].hasSubAgents).toBe(true);
    expect(res.body.items[0].subAgents).toBeUndefined();
    expect(res.body.items[1].totalCost).toBe(0.25);
    expect(res.body.items[1].requestErrorCount).toBe(0);
  });

  it("returns every item when the page is not full", async () => {
    const { db } = fakeDb(seed());
    const { res } = await invoke("get", "/", fakeReq({ db, query: { limit: "50" } }));

    expect(res.body.hasMore).toBe(false);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.items.map((item: any) => item.id)).toEqual(["c2", "a1", "a2", "a3", "c1"]);
    // Parent links in either collection mark the conversation as having sub-agents.
    expect(res.body.items[1].hasSubAgents).toBe(true);
    expect(res.body.items[2].hasSubAgents).toBe(true);
    expect(res.body.items[0].totalCost).toBeUndefined();
  });

  it("walks the descendant chain for an agent-filtered listing", async () => {
    const { db } = fakeDb(seed());
    const { res } = await invoke("get", "/", fakeReq({ db, query: { type: "agent", agent: "orchestrator", limit: "50" } }));

    expect(res.body.items.map((item: any) => item.id).sort()).toEqual(["a1", "a2", "a3"]);
    expect(res.body.items.every((item: any) => item.type === "agent")).toBe(true);
  });

  it("lists only direct conversations for type=direct and honours cursor/taskId", async () => {
    const { db } = fakeDb(seed());
    const direct = await invoke("get", "/", fakeReq({ db, query: { type: "direct" } }));
    expect(direct.res.body.items.map((item: any) => item.id)).toEqual(["c2", "c1"]);

    const older = await invoke("get", "/", fakeReq({ db, query: { type: "direct", cursor: "2026-01-05T00:00:00.000Z" } }));
    expect(older.res.body.items.map((item: any) => item.id)).toEqual(["c1"]);

    const byTask = await invoke("get", "/", fakeReq({ db, query: { taskId: "t1" } }));
    expect(byTask.res.body.items).toEqual([]);
  });

  it("rejects an invalid limit", async () => {
    const { db } = fakeDb(seed());
    const { res } = await invoke("get", "/", fakeReq({ db, query: { limit: "0" } }));
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("keeps the listing when cost aggregation fails", async () => {
    const { db } = fakeDb({ ...seed(), requests: new Error("aggregate failed") });
    const { res } = await invoke("get", "/", fakeReq({ db, query: { limit: "2" } }));

    expect(res.statusCode).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[1].totalCost).toBeUndefined();
  });

  it("keeps the listing when sub-agent enrichment fails", async () => {
    const { db } = fakeDb(seed());
    const rowsFor = (name: string) => (name === "agent_conversations" ? seed().agent : seed().model);
    const broken = {
      collection: (name: string) => {
        if (name === "requests") return db.collection(name);
        const rows = rowsFor(name);
        return {
          find: (filter: Record<string, unknown>) => {
            let data = rows.filter((row) => matches(row, filter));
            const api: any = {
              projection: null,
              project(projection: Record<string, unknown>) {
                api.projection = projection;
                return api;
              },
              sort: () => api,
              limit(count: number) {
                data = data.slice(0, count);
                return api;
              },
              async toArray() {
                // Only the sub-agent parent lookup fails.
                const keys = api.projection ? Object.keys(api.projection) : [];
                if (keys.length === 1 && keys[0] === "parentConversationId") throw new Error("mongo down");
                return data;
              },
            };
            return api;
          },
        };
      },
    };
    const { res } = await invoke("get", "/", fakeReq({ db: broken, query: { limit: "2" } }));
    expect(res.statusCode).toBe(200);
    expect(res.body.items).toHaveLength(2);
  });
});

describe("GET /conversations/:id", () => {
  it("returns a direct conversation with cost and pending overlays", async () => {
    stub.pendingApproval = { isPending: true, toolName: "write" };
    stub.pendingQuestion = { isPending: true, question: "?" };
    const { db } = fakeDb({
      model: [conversation({ id: "c1" })],
      requests: [{ _id: "c1", totalCost: 4.5, requestErrorCount: 1 }],
    });
    const { res, errors } = await invoke("get", "/:id", fakeReq({ db, params: { id: "c1" } }));

    expect(errors).toEqual([]);
    expect(res.body).toMatchObject({
      id: "c1",
      type: "direct",
      totalCost: 4.5,
      requestErrorCount: 1,
      pendingApproval: { isPending: true, toolName: "write" },
      pendingQuestion: { isPending: true, question: "?" },
    });
  });

  it("falls back to the stored cost when the aggregation fails", async () => {
    const { db } = fakeDb({
      model: [conversation({ id: "c1", totalCost: 9 })],
      requests: new Error("no requests collection"),
    });
    const { res } = await invoke("get", "/:id", fakeReq({ db, params: { id: "c1" } }));

    expect(res.body.totalCost).toBe(9);
    expect(res.body.pendingApproval).toBeUndefined();
    expect(res.body.pendingQuestion).toBeUndefined();
  });

  it("returns an agent conversation with stats and a derived sub-agent flag", async () => {
    stub.stats = { messages: 3 };
    const { db } = fakeDb({ agent: [conversation({ id: "a1", agent: "orchestrator", subAgents: [{ id: "s" }] })] });
    const { res } = await invoke("get", "/:id", fakeReq({ db, params: { id: "a1" } }));

    expect(res.body).toMatchObject({ id: "a1", type: "agent", stats: { messages: 3 }, hasSubAgents: true });
  });

  it("leaves an existing sub-agent flag and missing stats alone", async () => {
    const { db } = fakeDb({ agent: [conversation({ id: "a1", hasSubAgents: true, subAgents: [] })] });
    const { res } = await invoke("get", "/:id", fakeReq({ db, params: { id: "a1" } }));

    expect(res.body.hasSubAgents).toBe(true);
    expect(res.body.stats).toBeUndefined();
  });

  it("answers 404 when neither collection has the conversation", async () => {
    const { db } = fakeDb();
    const { res } = await invoke("get", "/:id", fakeReq({ db, params: { id: "missing" } }));
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "Conversation not found" });
  });

  it("uses the default anonymous username filter when no user header is present", async () => {
    const { db } = fakeDb({ model: [conversation({ id: "c1", username: "anonymous" })] });
    const { res } = await invoke("get", "/:id", fakeReq({ db, params: { id: "c1" }, username: undefined }));
    expect(res.body.id).toBe("c1");
  });
});

describe("POST /conversations/:id/messages", () => {
  it("rejects an empty message list", async () => {
    const { db } = fakeDb();
    const { res } = await invoke("post", "/:id/messages", fakeReq({ db, params: { id: "c1" }, body: { messages: [] } }));
    expect(res.statusCode).toBe(400);
  });

  it("appends to a direct conversation", async () => {
    const { db } = fakeDb({ model: [conversation({ id: "c1" })] });
    const messages = [{ role: "user", content: "hi" }];
    const { res } = await invoke("post", "/:id/messages", fakeReq({ db, params: { id: "c1" }, body: { messages, conversationMeta: { a: 1 } } }));

    expect(res.body).toMatchObject({ id: "c1", type: "direct" });
    expect(stub.appended).toEqual({ id: "c1", collection: undefined, messages });
  });

  it("appends to an agent conversation", async () => {
    const { db } = fakeDb({ agent: [conversation({ id: "a1" })] });
    const { res } = await invoke("post", "/:id/messages", fakeReq({ db, params: { id: "a1" }, body: { messages: [{ role: "user", content: "hi" }] } }));

    expect(res.body.type).toBe("agent");
    expect(stub.appended).toEqual({ id: "a1", collection: "agent_conversations", messages: [{ role: "user", content: "hi" }] });
  });

  it("answers 404 when the conversation exists in neither collection", async () => {
    const { db } = fakeDb();
    const { res } = await invoke("post", "/:id/messages", fakeReq({ db, params: { id: "nope" }, body: { messages: [{ role: "user", content: "hi" }] } }));
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "Conversation not found" });
  });
});

describe("PATCH /conversations/:id", () => {
  it("rejects an invalid patch body", async () => {
    const { db } = fakeDb();
    const { res } = await invoke("patch", "/:id", fakeReq({ db, params: { id: "c1" }, body: { title: 42 } }));
    expect(res.statusCode).toBe(400);
  });

  it("updates a direct conversation and returns it", async () => {
    const { db, store } = fakeDb({ model: [conversation({ id: "c1" })] });
    const { res } = await invoke("patch", "/:id", fakeReq({ db, params: { id: "c1" }, body: { title: "Renamed", systemPrompt: "be nice" } }));

    expect(res.body).toMatchObject({ id: "c1", type: "direct", title: "Renamed", systemPrompt: "be nice" });
    expect(store.model_conversations[0].title).toBe("Renamed");
  });

  it("falls through to an agent conversation", async () => {
    const { db, store } = fakeDb({ agent: [conversation({ id: "a1" })] });
    const { res } = await invoke("patch", "/:id", fakeReq({ db, params: { id: "a1" }, body: { title: "Agent renamed" } }));

    expect(res.body).toMatchObject({ id: "a1", type: "agent", title: "Agent renamed" });
    expect(store.agent_conversations[0].title).toBe("Agent renamed");
  });

  it("answers 404 when nothing matched", async () => {
    const { db } = fakeDb();
    const { res } = await invoke("patch", "/:id", fakeReq({ db, params: { id: "nope" }, body: { title: "x" } }));
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /conversations/:id", () => {
  it("deletes a direct conversation and its descendant tree", async () => {
    const { db, store } = fakeDb({
      model: [
        conversation({ id: "c1" }),
        conversation({ id: "c2", parentConversationId: "c1" }),
        conversation({ id: "c3", parentConversationId: "c2" }),
      ],
      agent: [conversation({ id: "a1", parentConversationId: "c1" })],
    });
    const { res } = await invoke("delete", "/:id", fakeReq({ db, params: { id: "c1" } }));

    expect(res.body).toEqual({ success: true, id: "c1", type: "direct", descendantsDeleted: 3 });
    expect(store.model_conversations).toEqual([]);
    expect(store.agent_conversations).toEqual([]);
  });

  it("deletes an agent conversation with no descendants", async () => {
    const { db, store } = fakeDb({ agent: [conversation({ id: "a1" })] });
    const { res } = await invoke("delete", "/:id", fakeReq({ db, params: { id: "a1" } }));

    expect(res.body).toEqual({ success: true, id: "a1", type: "agent", descendantsDeleted: 0 });
    expect(store.agent_conversations).toEqual([]);
  });

  it("answers 404 when the conversation is in neither collection", async () => {
    const { db } = fakeDb();
    const { res } = await invoke("delete", "/:id", fakeReq({ db, params: { id: "nope" } }));
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "Conversation not found" });
  });
});

describe("conversation timers", () => {
  it("lists active timers", async () => {
    stub.timers = [{ timerId: "t1" }];
    const { db } = fakeDb();
    const { res } = await invoke("get", "/:id/timers", fakeReq({ db, params: { id: "c1" } }));
    expect(res.body).toEqual([{ timerId: "t1" }]);
  });

  it("reports whether a timer was cancelled", async () => {
    stub.cancelled = false;
    const { db } = fakeDb();
    const { res } = await invoke("post", "/:id/timers/:timerId/cancel", fakeReq({ db, params: { id: "c1", timerId: "t1" } }));
    expect(res.body).toEqual({ success: false });
  });
});
