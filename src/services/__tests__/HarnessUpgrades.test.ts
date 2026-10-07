import { describe, it, expect, beforeEach } from "vitest";
import { normalizeEmptyToolContent, EMPTY_TOOL_OUTPUT_MESSAGE } from "../ToolResult.ts";
import { validateStrictToolSchema } from "../ToolOrchestratorService.ts";
import { permissionModeOf, resolvePermission, PLAN_MODE_DENIAL } from "../PermissionModes.ts";
import AgentHooks from "../AgentHooks.ts";
import { hookDenialObservation } from "../RunExecutionEngine.ts";

describe("empty tool content normalization", () => {
  it("replaces an empty string with the explicit no-output message", () => {
    expect(normalizeEmptyToolContent("")).toBe(EMPTY_TOOL_OUTPUT_MESSAGE);
  });

  it("replaces whitespace-only output", () => {
    expect(normalizeEmptyToolContent("   \n\t  ")).toBe(EMPTY_TOOL_OUTPUT_MESSAGE);
  });

  it("leaves non-empty strings, objects, and null untouched", () => {
    expect(normalizeEmptyToolContent("ok")).toBe("ok");
    expect(normalizeEmptyToolContent({ result: 1 })).toEqual({ result: 1 });
    expect(normalizeEmptyToolContent(null)).toBeNull();
  });
});

describe("strict tool schema validation", () => {
  const strict = {
    type: "object",
    properties: { ticker: { type: "string" }, limit: { type: "number" } },
    required: ["ticker", "limit"],
    additionalProperties: false,
  };

  it("accepts a strict schema", () => {
    expect(validateStrictToolSchema("get_price_history", strict)).toBeNull();
  });

  it("rejects a schema whose properties are not all required, naming the tool", () => {
    const loose = { ...strict, required: ["ticker"] };
    const violation = validateStrictToolSchema("get_price_history", loose);
    expect(violation).toContain("get_price_history");
    expect(violation).toContain("limit");
  });

  it("rejects a schema without additionalProperties: false, naming the tool", () => {
    const { additionalProperties: _ap, ...loose } = strict;
    const violation = validateStrictToolSchema("get_sec_filings", loose);
    expect(violation).toContain("get_sec_filings");
    expect(violation).toContain("additionalProperties");
  });

  it("rejects non-object parameter schemas, naming the tool", () => {
    expect(validateStrictToolSchema("bad_tool", { type: "string" })).toContain("bad_tool");
    expect(validateStrictToolSchema("worse_tool", "nope")).toContain("worse_tool");
  });

  it("rejects required entries without a matching property", () => {
    const violation = validateStrictToolSchema("ghostly", {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "ghost"],
      additionalProperties: false,
    });
    expect(violation).toContain("ghostly");
    expect(violation).toContain("ghost");
  });
});

describe("decide-hook denial", () => {
  it("short-circuits hooks.run on a decide deny", async () => {
    const hooks = new AgentHooks();
    let ran = false;
    hooks.register("beforeToolCall", async () => ({ isApproved: false }), "deny", "decide");
    hooks.register("beforeToolCall", async () => { ran = true; }, "should-not-run", "decide");
    const verdict = await hooks.run("beforeToolCall", { name: "delete_all" }, {});
    expect(verdict?.isApproved).toBe(false);
    expect(ran).toBe(false);
  });

  it("maps a deny verdict to a structured denial observation", () => {
    const denial = hookDenialObservation("delete_all", { isApproved: false });
    expect(denial).toEqual({
      success: false,
      error: "HOOK_DENIED",
      message: "Tool call 'delete_all' denied by a decide hook; no execution was performed.",
    });
    const withReason = hookDenialObservation("delete_all", { isApproved: false, message: "No." });
    expect(withReason.message).toBe("No.");
  });

  it("fires the runStop event when registered", async () => {
    const hooks = new AgentHooks();
    const seen: unknown[] = [];
    hooks.register("runStop", (ctx, out) => { seen.push(ctx, out); }, "stop-listener", "inspect");
    await hooks.run("runStop", { runId: "r1" }, { toolCalls: 2 });
    expect(seen).toEqual([{ runId: "r1" }, { toolCalls: 2 }]);
  });
});

describe("permission-mode matrix", () => {
  it("defaults missing or unknown profile modes to default", () => {
    expect(permissionModeOf({})).toBe("default");
    expect(permissionModeOf({ permissionMode: "bogus" })).toBe("default");
    expect(permissionModeOf({ permissionMode: "bypass" })).toBe("bypass");
  });

  it("requires approval for destructive tools in ALL four modes", () => {
    for (const mode of ["default", "acceptEdits", "plan", "bypass"] as const) {
      const decision = resolvePermission({ mode, effect: "destructive" });
      expect(decision.requiresApproval, mode).toBe(true);
      expect(decision.approved, mode).toBe(false);
      // and the gate is satisfied by a registered approval
      const approved = resolvePermission({ mode, effect: "destructive", approvalSatisfied: true });
      expect(approved.approved, mode).toBe(true);
    }
  });

  it("acceptEdits auto-approves writes but not destructive", () => {
    const decision = resolvePermission({ mode: "acceptEdits", effect: "write" });
    expect(decision.approved).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(resolvePermission({ mode: "acceptEdits", effect: "destructive" }).approved).toBe(false);
  });

  it("plan blocks writes until planApproved is set", () => {
    const blocked = resolvePermission({ mode: "plan", effect: "write" });
    expect(blocked.approved).toBe(false);
    expect(blocked.denial).toEqual(PLAN_MODE_DENIAL);
    expect(PLAN_MODE_DENIAL.message).toBe("plan mode: write blocked until an approved plan exists");
    const allowed = resolvePermission({ mode: "plan", effect: "write", planApproved: true });
    expect(allowed.approved).toBe(true);
    expect(allowed.denial).toBeUndefined();
  });

  it("bypass auto-approves everything except the destructive hard floor", () => {
    for (const effect of ["read", "write", "mutating"]) {
      expect(resolvePermission({ mode: "bypass", effect }).approved, effect).toBe(true);
    }
    expect(resolvePermission({ mode: "bypass", effect: "destructive" }).approved).toBe(false);
  });

  it("default mode defers to the engine's own policy flags", () => {
    const decision = resolvePermission({ mode: "default", effect: "write" });
    expect(decision.requiresApproval).toBe(false);
    expect(decision.denial).toBeUndefined();
  });
});
