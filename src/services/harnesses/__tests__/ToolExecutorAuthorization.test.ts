/**
 * executeToolBatch authorization (audit AUDIT-tool-authorization-2026-10-16).
 *
 * Before the rebuild, ApprovalGate approved every call under autoApprove
 * (DENY policies included) and ToolExecutor discarded the beforeToolCall
 * verdict. These tests drive the real executor: a denied call never reaches
 * ToolOrchestratorService and its denial is the call's one result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AgentHooks from "../../AgentHooks.ts";
import { pendingApprovals } from "../../ApprovalRegistry.ts";
import type { PendingToolApprovalEntry } from "../../ApprovalRegistry.ts";
import { allow, deny } from "../../PolicyEngine.ts";
import type { PolicyRule } from "../../PolicyEngine.ts";
import ToolOrchestratorService from "../../ToolOrchestratorService.ts";
import { executeToolBatch } from "../lifecycle/ToolExecutor.ts";
import type { AgenticContext, AgenticOptions, ResolvedTools, ToolCall, ToolResult } from "../types.ts";

const DENY_SHELL: PolicyRule[] = [deny("execute_command", { name: "no-shell" })];

let executed: string[];
let events: Array<Record<string, unknown>>;

function makeContext(
  conversationId: string,
  options: Partial<AgenticOptions>,
  extra: Partial<AgenticContext> = {},
): AgenticContext {
  return {
    project: "test",
    username: "tester",
    agent: null,
    agentConversationId: conversationId,
    conversationId,
    traceId: "trace",
    providerName: "mock",
    resolvedModel: "mock-model",
    emit: (event: Record<string, unknown>) => events.push(event),
    options: { ...options },
    ...extra,
  } as unknown as AgenticContext;
}

const tools: ResolvedTools = { finalTools: [], resolvedEnabledTools: null };

function run(toolCalls: ToolCall[], context: AgenticContext, hooks = new AgentHooks()): Promise<ToolResult[]> {
  return executeToolBatch(toolCalls, context, tools, hooks, {} as never);
}

function resultsFor(results: ToolResult[], id: string): ToolResult[] {
  return results.filter((result) => result.id === id);
}

/** The gate registers its waiter after the durable records are written. */
function waitForApproval(conversationId: string): Promise<PendingToolApprovalEntry> {
  return vi.waitFor(() => {
    const entry = pendingApprovals.get(conversationId);
    if (entry?.type !== "tool") throw new Error(`no approval card for ${conversationId}`);
    return entry;
  });
}

beforeEach(() => {
  executed = [];
  events = [];
  vi.spyOn(ToolOrchestratorService, "isStreamable").mockReturnValue(false);
  vi.spyOn(ToolOrchestratorService, "executeTool").mockImplementation(async (name: string) => {
    executed.push(name);
    return { ok: true };
  });
  vi.spyOn(ToolOrchestratorService, "executeToolStreaming").mockImplementation(async (name: string) => {
    executed.push(name);
    return { ok: true };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  pendingApprovals.clear();
});

describe("executeToolBatch: a deny is terminal", () => {
  it("a DENY policy under autoApprove never executes and is reported once", async () => {
    const after = vi.fn();
    const hooks = new AgentHooks();
    hooks.register("afterToolCall", after, "after", "inspect");
    const context = makeContext("deny-auto", { autoApprove: true, policies: DENY_SHELL });

    const results = await run(
      [
        { id: "shell", name: "execute_command", args: { command: "rm -rf /" } },
        { id: "write", name: "write_file", args: { path: "a.md", content: "x" } },
      ],
      context,
      hooks,
    );

    expect(executed).toEqual(["write_file"]);
    const denial = resultsFor(results, "shell");
    expect(denial).toHaveLength(1);
    expect(denial[0].result).toMatchObject({
      success: false,
      error: "POLICY_DENIED",
      message: expect.stringContaining("no-shell"),
    });
    expect(after.mock.calls.filter(([toolCall]) => toolCall.id === "shell")).toHaveLength(1);
    expect(events.some((event) => event.type === "approval_required")).toBe(false);
    expect(
      events.filter((event) => String(event.message ?? "").startsWith("Tool call denied (policy)")),
    ).toHaveLength(1);
  });

  it("a DENY policy under autoApprove + unattended (trading's options) never executes", async () => {
    const context = makeContext("deny-trading", { autoApprove: true, unattended: true, policies: DENY_SHELL });
    const results = await run([{ id: "shell", name: "execute_command", args: { command: "ls" } }], context);
    expect(executed).toEqual([]);
    expect(resultsFor(results, "shell")[0].result).toMatchObject({ error: "POLICY_DENIED" });
  });

  it("a DENY policy binds a profile-admitted run (runtimeToolExecutor)", async () => {
    const runtimeCalls: string[] = [];
    const context = makeContext(
      "deny-profile",
      { policies: DENY_SHELL },
      {
        runtimeToolExecutor: async (toolCall: ToolCall) => {
          runtimeCalls.push(toolCall.name);
          return { ok: true };
        },
      },
    );
    const results = await run(
      [
        { id: "shell", name: "execute_command", args: { command: "ls" } },
        { id: "write", name: "write_file", args: { path: "a.md" } },
      ],
      context,
    );
    expect(runtimeCalls).toEqual(["write_file"]);
    expect(resultsFor(results, "shell")[0].result).toMatchObject({ error: "POLICY_DENIED" });
  });

  it("a beforeToolCall hook denial under autoApprove never executes", async () => {
    const hooks = new AgentHooks();
    hooks.register(
      "beforeToolCall",
      async (toolCall: ToolCall) =>
        toolCall.name === "execute_command" ? { isApproved: false, reason: "critic says no" } : undefined,
      "critic",
      "decide",
    );
    const context = makeContext("deny-hook", { autoApprove: true });
    const results = await run(
      [
        { id: "shell", name: "execute_command", args: { command: "rm -rf /" } },
        { id: "read", name: "read_file", args: { path: "a.md" } },
      ],
      context,
      hooks,
    );
    expect(executed).toEqual(["read_file"]);
    const denial = resultsFor(results, "shell");
    expect(denial).toHaveLength(1);
    expect(denial[0].result).toMatchObject({
      error: "BLOCKED_BY_SAFETY_HOOK",
      message: expect.stringContaining("critic says no"),
    });
  });

  it("hooks never see a call a policy already denied", async () => {
    const seen: string[] = [];
    const hooks = new AgentHooks();
    hooks.register(
      "beforeToolCall",
      async (toolCall: ToolCall) => {
        seen.push(toolCall.name);
      },
      "observer",
      "decide",
    );
    const context = makeContext("deny-before-hook", { autoApprove: true, policies: DENY_SHELL });
    await run(
      [
        { id: "shell", name: "execute_command", args: {} },
        { id: "read", name: "read_file", args: {} },
      ],
      context,
      hooks,
    );
    expect(seen).toEqual(["read_file"]);
  });

  it("a call outside the allow-list never executes, whatever the policies say", async () => {
    const context = makeContext("deny-scope", { autoApprove: true, policies: [allow("get_market_data")] });
    const results = await run(
      [{ id: "md", name: "get_market_data", args: {}, isUnauthorized: true }],
      context,
    );
    expect(executed).toEqual([]);
    expect(resultsFor(results, "md")[0].result).toMatchObject({ error: "PERMISSION_DENIED" });
  });

  it("an unattended run without autoApprove denies an ask instead of waiting", async () => {
    const context = makeContext("unattended", { unattended: true });
    const results = await run([{ id: "write", name: "write_file", args: {} }], context);
    expect(executed).toEqual([]);
    expect(pendingApprovals.has("unattended")).toBe(false);
    expect(resultsFor(results, "write")[0].result).toMatchObject({ error: "APPROVAL_UNAVAILABLE" });
  });
});

describe("executeToolBatch: a person answers only asks", () => {
  it("approve-all cannot reach a DENY in the same batch; it only clears the ask", async () => {
    const context = makeContext("approve-all", { policies: DENY_SHELL });
    const pending = run(
      [
        { id: "shell", name: "execute_command", args: { command: "ls" } },
        { id: "write", name: "write_file", args: { path: "a.md" } },
      ],
      context,
    );
    const entry = await waitForApproval("approve-all");
    // Only the ask is put to the person; the denied call never gets a card.
    expect(entry.toolCalls.map((toolCall) => toolCall.name)).toEqual(["write_file"]);
    entry.resolve({ isApproved: true, shouldApproveAll: true });
    const results = await pending;

    expect(executed).toEqual(["write_file"]);
    expect(resultsFor(results, "shell")[0].result).toMatchObject({ error: "POLICY_DENIED" });
    expect(context.options.autoApprove).toBe(true);
    const cards = events.filter((event) => event.type === "approval_required");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ toolCall: { name: "write_file" } });
  });

  it("an approval whose edited arguments match a DENY predicate stays denied", async () => {
    const policies = [deny("write_file", { name: "no-env", when: (args) => String(args.path).endsWith(".env") })];
    const context = makeContext("edited", { policies });
    const pending = run([{ id: "write", name: "write_file", args: { path: "notes.md" } }], context);
    const entry = await waitForApproval("edited");
    entry.resolve({ isApproved: true, editedArgs: { write: { path: "prod.env" } } });
    const results = await pending;

    expect(executed).toEqual([]);
    expect(resultsFor(results, "write")[0].result).toMatchObject({ error: "POLICY_DENIED" });
  });

  it("a person's deny is reported once with their reason and never executes", async () => {
    const context = makeContext("person-deny", {});
    const pending = run([{ id: "write", name: "write_file", args: { path: "a.md" } }], context);
    const entry = await waitForApproval("person-deny");
    entry.resolve({ isApproved: false, denialReason: "use staging" });
    const results = await pending;

    expect(executed).toEqual([]);
    const denial = resultsFor(results, "write");
    expect(denial).toHaveLength(1);
    expect(denial[0].result).toMatchObject({
      error: "USER_REJECTED",
      message: expect.stringContaining("use staging"),
    });
  });
});
