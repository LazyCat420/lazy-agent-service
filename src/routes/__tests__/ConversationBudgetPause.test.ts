/**
 * Durable conversation budget + budget pause, driven against a real
 * PromptedToolCallingHarness turn (scripted provider, real CostBudgetEnforcer,
 * real BudgetPauseRegistry, real express router). Only the Mongo collection
 * is an in-memory stand-in.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as ConfigModule from "../../config.ts";

const store = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("../../wrappers/MongoWrapper.ts", () => {
  const collection = {
    async findOne({ conversationId }: { conversationId: string }) {
      return store.get(conversationId) ?? null;
    },
    async replaceOne({ conversationId }: { conversationId: string }, doc: Record<string, unknown>) {
      store.set(conversationId, doc);
    },
    async deleteOne({ conversationId }: { conversationId: string }) {
      return { deletedCount: store.delete(conversationId) ? 1 : 0 };
    },
  };
  class MongoWrapper {
    static getDb() { return null; }
    static getClient() { return null; }
    static getCollection() { return collection; }
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
vi.mock("../../config.ts", async (importOriginal) => {
  const original = await importOriginal<typeof ConfigModule>();
  return {
    ...original,
    getPricing: () => ({ "priced-model": { inputPerMillion: 1_000_000, outputPerMillion: 1_000_000 } }),
  };
});

import PromptedToolCallingHarness from "../../services/harnesses/PromptedToolCallingHarness.ts";
import AgenticLoopState from "../../services/AgenticLoopState.ts";
import ConversationBudgetRegistry from "../../services/ConversationBudgetRegistry.ts";
import budgetRouter from "../ConversationBudgetRoute.ts";
import type { AgenticContext, ToolSchema } from "../../services/harnesses/types.ts";

const NOTE_CALL = '<tool_call>{"name": "take_note", "arguments": {"title": "T", "body": "B"}}</tool_call>';
const TOOLS: ToolSchema[] = [
  { name: "take_note", description: "note", parameters: { type: "object", properties: {} } },
];
const usage = { inputTokens: 1, outputTokens: 1 }; // $2 at the mocked price

let server: import("node:http").Server;
let baseUrl = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/conversations", budgetRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  store.clear();
  ConversationBudgetRegistry.reset();
});

const send = (method: string, id: string, body?: unknown) =>
  fetch(`${baseUrl}/conversations/${id}/budget`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

function provider(responses: Array<string | { text: string; usage: Record<string, number> }>) {
  return {
    generateTextStream() {
      const next = responses.shift() ?? "";
      const { text, usage: u } = typeof next === "string" ? { text: next, usage: undefined } : next;
      return (async function* () {
        if (text) yield text;
        if (u) yield { type: "usage", usage: u };
      })();
    },
  };
}

function makeContext(conversationId: string, prov: unknown, options: Record<string, unknown> = {}) {
  const events: Array<Record<string, unknown>> = [];
  const context = {
    options: { maxIterations: 6, maxTokens: 100000, autoApprove: true, ...options },
    messages: [{ role: "user", content: "go" }],
    project: "test",
    username: "tester",
    modelDefinition: null,
    agentConversationId: conversationId,
    conversationId,
    provider: prov,
    providerName: "mock",
    resolvedModel: "priced-model",
    signal: null,
    emit: (event: Record<string, unknown>) => events.push(event),
    runtimeTools: { finalTools: TOOLS, resolvedEnabledTools: null },
    workspaceRoot: mkdtempSync(join(tmpdir(), "budget-pause-")),
    requestId: `req-${conversationId}`,
    traceId: `trace-${conversationId}`,
  } as unknown as AgenticContext;
  return { context, events };
}

function startTurn(context: AgenticContext) {
  const state = new AgenticLoopState({ originalMessageCount: context.messages.length });
  return new PromptedToolCallingHarness(context, state, context.runtimeTools!).run();
}

const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 300 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(predicate()).toBe(true);
};

const notesWritten = (root: string) =>
  existsSync(join(root, "data", "notes")) && readdirSync(join(root, "data", "notes")).length > 0;

describe("conversation budget persistence", () => {
  it("is read back by a fresh registry instance (survives a restart)", async () => {
    expect((await send("PUT", "c-persist", { maxCostDollars: 3, maxTotalTokens: 500 })).status).toBe(200);
    expect((await send("PATCH", "c-persist", { maxCostDollars: 4 })).status).toBe(200);

    vi.resetModules();
    const Fresh = (await import("../../services/ConversationBudgetRegistry.ts")).default;
    expect(Fresh).not.toBe(ConversationBudgetRegistry);
    expect(await Fresh.get("c-persist")).toEqual({ maxCostDollars: 4, maxTotalTokens: 500 });

    expect((await send("DELETE", "c-persist")).status).toBe(200);
    expect(await Fresh.get("c-persist")).toBeNull();
  });
});

describe("budget pause against a running turn", () => {
  it("pauses at the cap and resumes the SAME turn, running the tool, when the cap is raised", async () => {
    await send("PUT", "c-resume", { maxCostDollars: 0.5 });
    const { context, events } = makeContext("c-resume", provider([{ text: NOTE_CALL, usage }, "finished"]), {
      budgetPauseTimeoutMs: 10_000,
    });
    const turn = startTurn(context);

    await waitFor(() => events.some((e) => e.type === "budget_paused"));
    expect(events.find((e) => e.type === "budget_paused")).toMatchObject({
      conversationId: "c-resume",
      maxCostDollars: 0.5,
    });
    // Parked: the over-budget pass's tool has not run.
    expect(notesWritten(context.workspaceRoot!)).toBe(false);
    expect((await (await send("GET", "c-resume")).json()).paused).toBe(true);

    // A raise that still does not clear the spend keeps it paused.
    expect((await (await send("PUT", "c-resume", { maxCostDollars: 1 })).json()).resumed).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect((await (await send("GET", "c-resume")).json()).paused).toBe(true);
    expect(notesWritten(context.workspaceRoot!)).toBe(false);

    const raised = await send("PUT", "c-resume", { maxCostDollars: 100 });
    expect((await raised.json()).resumed).toBe(true);
    await turn;
    expect(events.some((e) => e.type === "budget_resumed")).toBe(true);
    expect(notesWritten(context.workspaceRoot!)).toBe(true);
  });

  it("ends the turn when the pause times out unraised", async () => {
    await send("PUT", "c-timeout", { maxCostDollars: 0.5 });
    const { context, events } = makeContext("c-timeout", provider([{ text: NOTE_CALL, usage }, "never"]), {
      budgetPauseTimeoutMs: 60,
    });
    await startTurn(context);
    expect(events.some((e) => e.type === "budget_paused")).toBe(true);
    expect(events.some((e) => e.type === "budget_resumed")).toBe(false);
    expect(events.some((e) => e.maxCostDollars === 0.5 && e.message !== undefined)).toBe(true);
    expect(notesWritten(context.workspaceRoot!)).toBe(false);
  });

  it("ends a paused turn when the budget is deleted", async () => {
    await send("PUT", "c-delete", { maxCostDollars: 0.5 });
    const { context, events } = makeContext("c-delete", provider([{ text: NOTE_CALL, usage }, "never"]), {
      budgetPauseTimeoutMs: 10_000,
    });
    const turn = startTurn(context);
    await waitFor(() => events.some((e) => e.type === "budget_paused"));
    const res = await send("DELETE", "c-delete");
    expect((await res.json()).stopped).toBe(true);
    await turn;
    expect(notesWritten(context.workspaceRoot!)).toBe(false);
  });
});
