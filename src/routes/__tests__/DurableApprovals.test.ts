import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { mkdtempSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real harness turns + the real approve route; only Mongo is an in-memory
// stand-in so a "restart" (fresh store instance, empty registry) can be
// simulated against the same database contents.
const database = vi.hoisted(() => {
  const documents: Array<Record<string, unknown>> = [];
  const matchesFilter = (doc: Record<string, unknown>, filter: Record<string, unknown>) =>
    Object.entries(filter).every(([key, value]) => doc[key] === value);
  const pendingDecisions = {
    async insertMany(docs: Array<Record<string, unknown>>) {
      for (const doc of docs) documents.push(structuredClone(doc));
    },
    find(filter: Record<string, unknown>) {
      return { toArray: async () => documents.filter((doc) => matchesFilter(doc, filter)).map((doc) => ({ ...doc })) };
    },
    async updateOne(filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) {
      const doc = documents.find((candidate) => matchesFilter(candidate, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(doc, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  return { documents, pendingDecisions, connected: true };
});
vi.mock("../../wrappers/MongoWrapper.ts", () => {
  class MongoWrapper {
    static getDb() {
      return database.connected
        ? { collection: (name: string) => (name === "pending_decisions" ? database.pendingDecisions : null) }
        : null;
    }
    static getCollection() { return null; }
    static getClient() { return null; }
  }
  return { default: MongoWrapper };
});
vi.mock("../../services/RequestLogger.ts", () => ({
  default: { insertPending: async () => null, logChatGeneration: async () => {}, log: async () => {} },
}));
vi.mock("../../platform/trace/TraceExporter.ts", () => {
  class TraceExporter {
    private static instance = new TraceExporter();
    static getGlobalInstance() { return TraceExporter.instance; }
    enqueueSpan() {}
    getQueuedSpans() { return []; }
  }
  return { TraceExporter };
});

import PromptedToolCallingHarness from "../../services/harnesses/PromptedToolCallingHarness.ts";
import AgenticLoopState from "../../services/AgenticLoopState.ts";
import PendingApprovalStore from "../../services/PendingApprovalStore.ts";
import AgenticLoopService from "../../services/AgenticLoopService.ts";
import { pendingApprovals } from "../../services/ApprovalRegistry.ts";
import conversationRouter from "../ConversationExecutionRoute.ts";
import type { AgenticContext, ToolSchema } from "../../services/harnesses/types.ts";

const NOTE_CALL = '<tool_call>{"name": "take_note", "arguments": {"title": "T", "body": "B"}}</tool_call>';
const TOOLS: ToolSchema[] = [
  {
    name: "take_note",
    description: "note",
    parameters: {
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string" } },
      required: ["title", "body"],
    },
  },
];
const ASK = [{ tool: "take_note", decision: "ASK_USER", name: "confirm" }];

let server: import("node:http").Server;
let baseUrl = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/conversation", conversationRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  database.documents.length = 0;
  database.connected = true;
  pendingApprovals.clear();
});

const post = (body: unknown) =>
  fetch(`${baseUrl}/conversation/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function provider(responses: string[], calls: unknown[] = []) {
  return {
    generateTextStream(messages: unknown) {
      calls.push(messages);
      const text = responses.shift() ?? "";
      return (async function* () {
        if (text) yield text;
      })();
    },
  };
}

function makeContext(conversationId: string, prov: unknown) {
  return {
    options: { maxIterations: 6, maxTokens: 100000, policies: ASK },
    messages: [{ role: "user", content: "go" }],
    project: "test",
    username: "tester",
    modelDefinition: null,
    agentConversationId: conversationId,
    conversationId,
    provider: prov,
    providerName: "mock",
    resolvedModel: "m",
    signal: null,
    emit: () => {},
    runtimeTools: { finalTools: TOOLS, resolvedEnabledTools: null },
    workspaceRoot: mkdtempSync(join(tmpdir(), "durable-approvals-")),
    requestId: `req-${conversationId}`,
    traceId: `trace-${conversationId}`,
  } as unknown as AgenticContext;
}

function startTurn(context: AgenticContext) {
  const state = new AgenticLoopState({ originalMessageCount: context.messages.length });
  return new PromptedToolCallingHarness(context, state, context.runtimeTools!).run();
}

const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(predicate()).toBe(true);
};

const notesText = (root: string) => {
  const dir = join(root, "data", "notes");
  return existsSync(dir) ? readdirSync(dir).map((file) => readFileSync(join(dir, file), "utf8")).join("\n") : "";
};

describe("durable pending approvals", () => {
  it("persists the pending call so a fresh store (restart) still reads it", async () => {
    const context = makeContext("c-restart", provider([NOTE_CALL, "done"]));
    const turn = startTurn(context);
    await waitFor(() => pendingApprovals.has("c-restart"));

    const afterRestart = new PendingApprovalStore();
    const pending = await afterRestart.listPending("c-restart");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ name: "take_note", status: "pending", args: { title: "T", body: "B" } });

    await post({ conversationId: "c-restart", decision: "allow" });
    await turn;
  });

  it("stores a decision with delivered:false when no turn is running (restart), then 409s a second one", async () => {
    const context = makeContext("c-orphan", provider([NOTE_CALL, "done"]));
    const turn = startTurn(context);
    await waitFor(() => pendingApprovals.has("c-orphan"));
    // The process "restarts": the live turn's registry entry is gone, the database record stays.
    const live = pendingApprovals.get("c-orphan")!;
    pendingApprovals.clear();

    const res = await post({ conversationId: "c-orphan", decision: "allow" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, delivered: false });
    expect(database.documents[0]).toMatchObject({ status: "decided", delivered: false });

    const again = await post({ conversationId: "c-orphan", decision: "deny" });
    expect(again.status).toBe(409);

    // release the orphaned in-process turn so the test ends cleanly
    (live.resolve as (value: unknown) => void)({ isApproved: false });
    await turn;
  });

  it("answers 409 for a call that was already decided", async () => {
    const context = makeContext("c-stale", provider([NOTE_CALL, "done"]));
    const turn = startTurn(context);
    await waitFor(() => pendingApprovals.has("c-stale"));
    const toolCallId = (await new PendingApprovalStore().listPending("c-stale"))[0].itemId;

    expect((await post({ conversationId: "c-stale", toolCallId, decision: "allow" })).status).toBe(200);
    await turn;
    const stale = await post({ conversationId: "c-stale", toolCallId, decision: "allow" });
    expect(stale.status).toBe(409);
  });

  it("lets exactly one of two concurrent decisions win (conditional write)", async () => {
    const context = makeContext("c-race", provider([NOTE_CALL, "done"]));
    const turn = startTurn(context);
    await waitFor(() => pendingApprovals.has("c-race"));
    const toolCallId = (await new PendingApprovalStore().listPending("c-race"))[0].itemId;

    // Both decisions read the call as pending before either writes: only the
    // conditional write on the record can tell them apart.
    const outcomes = await Promise.all([
      AgenticLoopService.decideApproval("c-race", { isApproved: true, toolCallId }),
      AgenticLoopService.decideApproval("c-race", { isApproved: false, toolCallId }),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["already_decided", "decided"]);
    await turn;
  });

  it("runs the tool with editedArgs the user approved", async () => {
    const context = makeContext("c-edit", provider([NOTE_CALL, "done"]));
    const turn = startTurn(context);
    await waitFor(() => pendingApprovals.has("c-edit"));
    const toolCallId = (await new PendingApprovalStore().listPending("c-edit"))[0].itemId;

    const res = await post({
      conversationId: "c-edit",
      toolCallId,
      decision: "allow",
      editedArgs: { title: "EditedTitle", body: "EditedBody" },
    });
    expect(res.status).toBe(200);
    await turn;
    const notes = notesText(context.workspaceRoot!);
    expect(notes).toContain("EditedTitle");
    expect(notes).toContain("EditedBody");
    expect(notes).not.toContain("# T\n");
  });

  it("rejects editedArgs that fail the tool schema, or that accompany a deny (400), leaving the call pending", async () => {
    const context = makeContext("c-bad-edit", provider([NOTE_CALL, "done"]));
    const turn = startTurn(context);
    await waitFor(() => pendingApprovals.has("c-bad-edit"));
    const toolCallId = (await new PendingApprovalStore().listPending("c-bad-edit"))[0].itemId;

    const invalid = await post({ conversationId: "c-bad-edit", toolCallId, decision: "allow", editedArgs: { title: 7 } });
    expect(invalid.status).toBe(400);
    const onDeny = await post({ conversationId: "c-bad-edit", toolCallId, decision: "deny", editedArgs: { title: "x", body: "y" } });
    expect(onDeny.status).toBe(400);
    expect(pendingApprovals.has("c-bad-edit")).toBe(true);

    await post({ conversationId: "c-bad-edit", toolCallId, decision: "allow" });
    await turn;
  });

  it("gives the model the denial reason, bounded", async () => {
    const calls: Array<Array<{ content: unknown }>> = [];
    const context = makeContext("c-reason", provider([NOTE_CALL, "ok"], calls as unknown[]));
    const turn = startTurn(context);
    await waitFor(() => pendingApprovals.has("c-reason"));

    const long = `use staging instead ${"x".repeat(900)}`;
    expect((await post({ conversationId: "c-reason", decision: "deny", reason: long })).status).toBe(200);
    await turn;
    const seen = JSON.stringify(calls[1]);
    expect(seen).toContain("USER_REJECTED");
    expect(seen).toContain("use staging instead");
    expect(seen).not.toContain("x".repeat(600));
    expect(notesText(context.workspaceRoot!)).toBe("");
  });
});
