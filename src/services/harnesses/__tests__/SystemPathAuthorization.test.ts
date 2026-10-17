/**
 * System-initiated tool paths under decideToolCall
 * (AUDIT-tool-authorization-2026-10-16, U2 and U4).
 *
 * U2: the post-write validator shells out through execute_command, so a
 *     persona DENY on execute_command (or the run not offering it, or no one
 *     to answer its ask) means no validator runs.
 * U4: exit_plan_mode is an approval request: autoApprove answers it, but a
 *     DENY policy or a gate denial rejects the plan even under autoApprove.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AgenticLoopState from "../../AgenticLoopState.ts";
import { deny } from "../../PolicyEngine.ts";
import type { PolicyRule } from "../../PolicyEngine.ts";
import ToolOrchestratorService from "../../ToolOrchestratorService.ts";
import { TOOL_NAMES } from "../../ToolTaxonomyConstants.ts";
import { handleExitPlanMode } from "../lifecycle/PlanModeController.ts";
import { validateAfterToolExecution } from "../lifecycle/ValidationInterceptor.ts";
import type {
  AgenticContext,
  AgenticOptions,
  PassState,
  ResolvedTools,
  ToolCall,
  ToolResult,
} from "../types.ts";

let events: Array<Record<string, unknown>>;
let shellCalls: string[];

function makeContext(options: Partial<AgenticOptions>): AgenticContext {
  return {
    project: "test",
    username: "tester",
    agent: null,
    agentConversationId: "conv-system-paths",
    conversationId: "conv-system-paths",
    traceId: "trace",
    providerName: "mock",
    resolvedModel: "mock-model",
    workspaceRoot: process.cwd(),
    emit: (event: Record<string, unknown>) => events.push(event),
    options: { ...options },
  } as unknown as AgenticContext;
}

const SHELL_OFFERED: ResolvedTools = {
  finalTools: [{ name: TOOL_NAMES.RUN_COMMAND, description: "run a shell command" }],
  resolvedEnabledTools: null,
};
const SHELL_NOT_OFFERED: ResolvedTools = { finalTools: [], resolvedEnabledTools: null };
const DENY_SHELL: PolicyRule[] = [deny(TOOL_NAMES.RUN_COMMAND, { name: "no-shell" })];

const write: ToolCall = { id: "w1", name: TOOL_NAMES.WRITE_FILE, args: { path: "src/example.ts", content: "x" } };
const writeResult: ToolResult = { id: "w1", name: TOOL_NAMES.WRITE_FILE, result: { ok: true } } as ToolResult;

beforeEach(() => {
  events = [];
  shellCalls = [];
  vi.spyOn(ToolOrchestratorService, "executeTool").mockImplementation(async (name: string) => {
    shellCalls.push(name);
    return { exitCode: 1, stdout: "src/example.ts(1,1): error TS1005: ';' expected." };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("post-write validator (U2): execute_command authorization", () => {
  it("runs the shell validator when the run offers execute_command and autoApprove answers its ask", async () => {
    const feedback = await validateAfterToolExecution([write], [writeResult], makeContext({ autoApprove: true }), SHELL_OFFERED);
    expect(shellCalls).toEqual([TOOL_NAMES.RUN_COMMAND]);
    expect(feedback).toHaveLength(1);
  });

  it("a persona DENY on execute_command skips the validator, even under autoApprove", async () => {
    const feedback = await validateAfterToolExecution(
      [write],
      [writeResult],
      makeContext({ autoApprove: true, policies: DENY_SHELL }),
      SHELL_OFFERED,
    );
    expect(shellCalls).toEqual([]);
    expect(feedback).toEqual([]);
  });

  it("skips the validator when the run does not offer execute_command", async () => {
    const feedback = await validateAfterToolExecution([write], [writeResult], makeContext({ autoApprove: true }), SHELL_NOT_OFFERED);
    expect(shellCalls).toEqual([]);
    expect(feedback).toEqual([]);
  });

  it("never waits on an ask: without autoApprove the validator is skipped", async () => {
    const feedback = await validateAfterToolExecution([write], [writeResult], makeContext({}), SHELL_OFFERED);
    expect(shellCalls).toEqual([]);
    expect(feedback).toEqual([]);
  });
});

describe("plan approval (U4): exit_plan_mode follows decideToolCall", () => {
  const exitCall: ToolCall = { id: "p1", name: TOOL_NAMES.EXIT_PLAN_MODE, args: {} };

  function planState(): AgenticLoopState {
    const state = new AgenticLoopState();
    state.planModeActive = true;
    state.planModeText = "1. Read the file\n2. Edit the file";
    return state;
  }

  function pass(): PassState {
    return { streamedText: "" } as unknown as PassState;
  }

  it("autoApprove approves the plan when nothing denies it", async () => {
    const state = planState();
    const results: ToolResult[] = [{ id: "p1", name: TOOL_NAMES.EXIT_PLAN_MODE, result: { ok: true } } as ToolResult];
    const outcome = await handleExitPlanMode(exitCall, pass(), results, [], makeContext({ autoApprove: true }), state);
    expect(outcome.shouldContinueLoop).toBe(true);
    expect(state.planModeActive).toBe(false);
    expect(events.find((event) => event.type === "plan_proposal")?.autoApproved).toBe(true);
  });

  it("a DENY policy on exit_plan_mode rejects the plan under autoApprove", async () => {
    const state = planState();
    const results: ToolResult[] = [{ id: "p1", name: TOOL_NAMES.EXIT_PLAN_MODE, result: { ok: true } } as ToolResult];
    const outcome = await handleExitPlanMode(
      exitCall,
      pass(),
      results,
      [],
      makeContext({ autoApprove: true, policies: [deny(TOOL_NAMES.EXIT_PLAN_MODE, { name: "no-plans" })] }),
      state,
    );
    expect(outcome.shouldContinueLoop).toBe(false);
    expect(state.planModeActive).toBe(true);
    expect(events.find((event) => event.type === "plan_proposal")?.autoApproved).toBe(false);
  });

  it("a gate denial of the exit_plan_mode call rejects the plan under autoApprove", async () => {
    const state = planState();
    const results: ToolResult[] = [
      {
        id: "p1",
        name: TOOL_NAMES.EXIT_PLAN_MODE,
        result: { success: false, error: "BLOCKED_BY_SAFETY_HOOK", message: "Tool execution was denied by a safety hook: no" },
      } as ToolResult,
    ];
    const outcome = await handleExitPlanMode(exitCall, pass(), results, [], makeContext({ autoApprove: true }), state);
    expect(outcome.shouldContinueLoop).toBe(false);
    expect(state.planModeActive).toBe(true);
  });

  it("an unattended run without autoApprove rejects the plan instead of waiting", async () => {
    const state = planState();
    const results: ToolResult[] = [{ id: "p1", name: TOOL_NAMES.EXIT_PLAN_MODE, result: { ok: true } } as ToolResult];
    const outcome = await handleExitPlanMode(exitCall, pass(), results, [], makeContext({ unattended: true }), state);
    expect(outcome.shouldContinueLoop).toBe(false);
    expect(state.planModeActive).toBe(true);
  });
});
