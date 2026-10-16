/**
 * Approval decision, ask_user answer and conversation budget routes, each
 * driven against a real PromptedToolCallingHarness turn (scripted provider,
 * real ApprovalGate / ask_user tool / CostBudgetEnforcer, real express
 * routers over HTTP).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as ConfigModule from "../../config.ts";

vi.mock("../../wrappers/MongoWrapper.ts", () => {
  class MongoWrapper {
    static getDb() { return null; }
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
// Price the scripted model so the cost cap has something to measure.
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
import { pendingApprovals, pendingQuestions } from "../../services/ApprovalRegistry.ts";
import conversationRouter from "../ConversationExecutionRoute.ts";
import budgetRouter from "../ConversationBudgetRoute.ts";
import type { AgenticContext, ToolSchema } from "../../services/harnesses/types.ts";

const NOTE_CALL = '<tool_call>{"name": "take_note", "arguments": {"title": "T", "body": "B"}}</tool_call>';
const ASK_CALL =
  '<tool_call>{"name": "ask_user", "arguments": {"questions": [{"question": "Which env?", "options": [{"label": "prod"}, {"label": "dev"}]}]}}</tool_call>';

const TOOLS: ToolSchema[] = [
  { name: "take_note", description: "note", parameters: { type: "object", properties: {} } },
  { name: "ask_user", description: "ask", parameters: { type: "object", properties: {} } },
];

let server: import("node:http").Server;
let baseUrl = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/conversations", budgetRouter);
  app.use("/conversation", conversationRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  ConversationBudgetRegistry.reset();
  pendingApprovals.clear();
  pendingQuestions.clear();
});

const post = (path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function provider(responses: Array<string | { text: string; usage: Record<string, number> }>, calls: unknown[] = []) {
  return {
    generateTextStream(messages: unknown) {
      calls.push(messages);
      const next = responses.shift() ?? "";
      const { text, usage } = typeof next === "string" ? { text: next, usage: undefined } : next;
      return (async function* () {
        if (text) yield text;
        if (usage) yield { type: "usage", usage };
      })();
    },
  };
}

function makeContext(conversationId: string, prov: unknown, options: Record<string, unknown> = {}) {
  const events: Array<Record<string, unknown>> = [];
  const context = {
    options: { maxIterations: 6, maxTokens: 100000, ...options },
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
    workspaceRoot: mkdtempSync(join(tmpdir(), "ask-budget-")),
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
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(predicate()).toBe(true);
};

const notesWritten = (root: string) => existsSync(join(root, "data", "notes")) && readdirSync(join(root, "data", "notes")).length > 0;

describe("POST /conversation/approve against a parked turn", () => {
  it("resumes and runs the tool on allow", async () => {
    const { context, events } = makeContext("c-allow", provider([NOTE_CALL, "done"]), {
      policies: [{ tool: "take_note", decision: "ASK_USER", name: "confirm" }],
    });
    const turn = startTurn(context);
    await waitFor(() => pendingApprovals.has("c-allow"));
    expect(events.some((e) => e.type === "approval_required")).toBe(true);
    expect(notesWritten(context.workspaceRoot!)).toBe(false);

    const res = await post("/conversation/approve", { conversationId: "c-allow", decision: "allow" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, approved: true, decision: "allow" });
    await turn;
    expect(notesWritten(context.workspaceRoot!)).toBe(true);
  });

  it("ends the tool call with USER_REJECTED on deny and never runs it", async () => {
    const calls: Array<Array<{ content: unknown }>> = [];
    const { context } = makeContext("c-deny", provider([NOTE_CALL, "ok, skipped"], calls as unknown[]), {
      policies: [{ tool: "take_note", decision: "ASK_USER", name: "confirm" }],
    });
    const turn = startTurn(context);
    await waitFor(() => pendingApprovals.has("c-deny"));

    const res = await post("/conversation/approve", { conversationId: "c-deny", approved: false, reason: "no" });
    expect(res.status).toBe(200);
    await turn;
    expect(notesWritten(context.workspaceRoot!)).toBe(false);
    expect(JSON.stringify(calls[1])).toContain("USER_REJECTED");
  });

  it("rejects a body with no decision (400) and an unknown conversation (404)", async () => {
    expect((await post("/conversation/approve", { conversationId: "x", approved: "yes" })).status).toBe(400);
    expect((await post("/conversation/approve", { conversationId: "nobody", decision: "allow" })).status).toBe(404);
  });
});

describe("POST /conversation/answer against a parked ask_user turn", () => {
  it("continues the turn with the posted answer", async () => {
    const calls: Array<Array<{ content: unknown }>> = [];
    const { context, events } = makeContext("c-ask", provider([ASK_CALL, "deploying to dev"], calls as unknown[]), {
      autoApprove: true,
    });
    const turn = startTurn(context);
    await waitFor(() => pendingQuestions.has("c-ask"));
    const card = events.find((e) => e.type === "user_question") as { questionId: string };
    expect(card.questionId).toBeTruthy();

    const wrongCard = await post("/conversation/answer", { conversationId: "c-ask", questionId: "q-other", answer: "dev" });
    expect(wrongCard.status).toBe(404);

    const res = await post("/conversation/answer", { conversationId: "c-ask", questionId: card.questionId, answer: "dev" });
    expect(res.status).toBe(200);
    await turn;
    expect(JSON.stringify(calls[1])).toMatch(/\\"answer\\": \\"dev\\"/);

    const again = await post("/conversation/answer", { conversationId: "c-ask", questionId: card.questionId, answer: "prod" });
    expect(again.status).toBe(409);
  });
});

describe("PUT /conversations/:id/budget against a running turn", () => {
  const usage = { inputTokens: 1, outputTokens: 1 };

  it("stops the turn after the pass that exceeds the cap", async () => {
    const put = await fetch(`${baseUrl}/conversations/c-budget/budget`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxCostDollars: 0.5 }),
    });
    expect(put.status).toBe(200);
    const got = await (await fetch(`${baseUrl}/conversations/c-budget/budget`)).json();
    expect(got).toEqual({ conversationId: "c-budget", budget: { maxCostDollars: 0.5 }, paused: false });

    const calls: unknown[] = [];
    const { context, events } = makeContext(
      "c-budget",
      provider([{ text: NOTE_CALL, usage }, "never reached"], calls),
      { autoApprove: true, budgetPauseTimeoutMs: 50 },
    );
    await startTurn(context);
    // The over-budget pass's tool call is not executed; the loop goes to
    // exhaustion recovery instead of the next iteration.
    expect(notesWritten(context.workspaceRoot!)).toBe(false);
    expect(events.some((e) => e.maxCostDollars === 0.5)).toBe(true);
  });

  it("lets the same turn run when no budget is set", async () => {
    const calls: unknown[] = [];
    const { context } = makeContext("c-free", provider([{ text: NOTE_CALL, usage }, "finished"], calls), { autoApprove: true });
    await startTurn(context);
    expect(calls).toHaveLength(2);
    expect(notesWritten(context.workspaceRoot!)).toBe(true);
  });

  it("rejects a non-positive cap", async () => {
    const res = await fetch(`${baseUrl}/conversations/c-bad/budget`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxCostDollars: 0 }),
    });
    expect(res.status).toBe(400);
  });
});
