import { describe, it, expect, beforeEach } from "vitest";
import { normalizeEmptyToolContent, EMPTY_TOOL_OUTPUT_MESSAGE } from "../ToolResult.ts";
import { validateStrictToolSchema } from "../ToolOrchestratorService.ts";
import {
  decideProfileToolCall,
  permissionModeOf,
  PLAN_MODE_DENIAL_REASON,
  type ProfileToolCall,
} from "../ProfileAuthorization.ts";
import type { AgentProfile } from "../ProfileRegistry.ts";
import { deniedToolResult } from "../ToolAuthorization.ts";
import AgentHooks from "../AgentHooks.ts";

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

  it("allows optional parameters (required stays as authored, not forced all-required)", () => {
    // DeepSeek server-strict demands every property in `required`; client-side
    // we do not — the real catalog is full of optional parameters and forcing
    // them would change each tool's contract.
    const loose = { ...strict, required: ["ticker"] };
    expect(validateStrictToolSchema("get_price_history", loose)).toBeNull();
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

  it("maps a hook deny to BLOCKED_BY_SAFETY_HOOK through decideToolCall", () => {
    const decision = decideProfileToolCall(call("fixture.delete_all", { effect: "destructive" }, { hookDenial: "No." }));
    expect(decision).toMatchObject({ verdict: "deny", deniedBy: "hook", reason: "No." });
    if (decision.verdict !== "deny") throw new Error("expected deny");
    expect(deniedToolResult("fixture.delete_all", decision)).toEqual({
      success: false,
      error: "BLOCKED_BY_SAFETY_HOOK",
      message: "Tool execution was denied by a safety hook: No.",
    });
  });

  it("fires the runStop event when registered", async () => {
    const hooks = new AgentHooks();
    const seen: unknown[] = [];
    hooks.register("runStop", (ctx, out) => { seen.push(ctx, out); }, "stop-listener", "inspect");
    await hooks.run("runStop", { runId: "r1" }, { toolCalls: 2 });
    expect(seen).toEqual([{ runId: "r1" }, { toolCalls: 2 }]);
  });
});

type LocalPolicy = NonNullable<AgentProfile["local_tool_policy"]>[string];

/** A /v1/runs profile call for the fixture local tool `name` with `policy`. */
function call(
  name: string,
  policy: LocalPolicy | undefined,
  extra: Partial<ProfileToolCall> & { mode?: string } = {},
): ProfileToolCall {
  const { mode, ...rest } = extra;
  const profile = {
    profile_id: "fixture",
    tool_policy: { whitelist: [name] },
    local_tool_policy: policy ? { [name]: policy } : {},
    ...(mode ? { permissionMode: mode } : {}),
  } as unknown as AgentProfile;
  return { profile, name, args: {}, planApproved: false, unattended: false, ...rest };
}

describe("permission-mode matrix (decideProfileToolCall)", () => {
  it("defaults missing or unknown profile modes to default", () => {
    expect(permissionModeOf({})).toBe("default");
    expect(permissionModeOf({ permissionMode: "bogus" })).toBe("default");
    expect(permissionModeOf({ permissionMode: "bypass" })).toBe("bypass");
  });

  it("asks for destructive tools in ALL four modes; only a person answers", () => {
    for (const mode of ["default", "acceptEdits", "plan", "bypass"]) {
      const planApproved = mode === "plan";
      expect(decideProfileToolCall(call("fixture.wipe", { effect: "destructive" }, { mode, planApproved })).verdict, mode).toBe("ask");
      expect(
        decideProfileToolCall(call("fixture.wipe", { effect: "destructive" }, { mode, planApproved, answer: { decision: "allow" } })).verdict,
        mode,
      ).toBe("allow");
      const rejected = decideProfileToolCall(call("fixture.wipe", { effect: "destructive" }, { mode, planApproved, answer: { decision: "deny" } }));
      expect(rejected).toMatchObject({ verdict: "deny", deniedBy: "user" });
      const unattended = decideProfileToolCall(call("fixture.wipe", { effect: "destructive" }, { mode, planApproved, unattended: true }));
      expect(unattended).toMatchObject({ verdict: "deny", deniedBy: "unattended" });
    }
  });

  it("acceptEdits auto-approves confirmed writes but not destructive", () => {
    expect(decideProfileToolCall(call("fixture.save", { effect: "write", requires_confirmation: true }, { mode: "acceptEdits" })).verdict).toBe("allow");
    expect(decideProfileToolCall(call("fixture.save", { effect: "write", requires_confirmation: true })).verdict).toBe("ask");
    expect(decideProfileToolCall(call("fixture.wipe", { effect: "destructive" }, { mode: "acceptEdits" })).verdict).toBe("ask");
  });

  it("plan denies writes (POLICY_DENIED) until planApproved is set, and no answer overrides it", () => {
    const blocked = decideProfileToolCall(call("fixture.save", { effect: "write" }, { mode: "plan", answer: { decision: "allow" } }));
    expect(blocked).toMatchObject({ verdict: "deny", deniedBy: "policy" });
    expect(blocked.reason).toContain(PLAN_MODE_DENIAL_REASON);
    if (blocked.verdict !== "deny") throw new Error("expected deny");
    expect(deniedToolResult("fixture.save", blocked).error).toBe("POLICY_DENIED");
    expect(decideProfileToolCall(call("fixture.save", { effect: "write" }, { mode: "plan", planApproved: true })).verdict).toBe("allow");
    expect(decideProfileToolCall(call("fixture.read", { effect: "read" }, { mode: "plan" })).verdict).toBe("allow");
  });

  it("bypass auto-approves every non-destructive ask, never the destructive hard floor", () => {
    for (const effect of ["read", "write"] as const) {
      expect(decideProfileToolCall(call("fixture.tool", { effect, requires_confirmation: true }, { mode: "bypass" })).verdict, effect).toBe("allow");
    }
    expect(decideProfileToolCall(call("fixture.wipe", { effect: "destructive" }, { mode: "bypass" })).verdict).toBe("ask");
  });

  it("a hook DENY is not overridable by bypass or a person's yes", () => {
    const decision = decideProfileToolCall(call("fixture.save", { effect: "write" }, { mode: "bypass", hookDenial: "blocked", answer: { decision: "allow" } }));
    expect(decision).toMatchObject({ verdict: "deny", deniedBy: "hook" });
  });

  it("default mode admits an unconfirmed write by profile policy", () => {
    expect(decideProfileToolCall(call("fixture.save", { effect: "write" })).verdict).toBe("allow");
  });

  it("denies a non-whitelisted tool (PERMISSION_DENIED) and a local tool without local_tool_policy (POLICY_DENIED)", () => {
    const unlisted = decideProfileToolCall({ ...call("fixture.save", { effect: "write" }), name: "fixture.other" });
    expect(unlisted).toMatchObject({ verdict: "deny", deniedBy: "scope" });
    const unregistered = decideProfileToolCall(call("fixture.save", undefined, { mode: "bypass" }));
    expect(unregistered).toMatchObject({ verdict: "deny", deniedBy: "policy" });
  });
});
