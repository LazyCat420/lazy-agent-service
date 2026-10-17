/**
 * ToolAuthorization precedence table (audit AUDIT-tool-authorization-2026-10-16).
 *
 * Fixed order: allow-list → DENY policy → hook deny → ask vs allow. autoApprove,
 * profile admission and a person's answer only ever answer an ask; nothing
 * after a deny can turn it into an allow.
 */
import { describe, expect, it } from "vitest";

import { allow, askUser, deny, denyAll } from "../PolicyEngine.ts";
import type { PolicyRule } from "../PolicyEngine.ts";
import { decideToolCall, deniedToolResult } from "../ToolAuthorization.ts";
import type { AuthorizationInput, DeniedBy } from "../ToolAuthorization.ts";

const throwingPredicate = (): boolean => {
  throw new Error("args unreadable");
};

function input(overrides: Partial<AuthorizationInput>): AuthorizationInput {
  return {
    name: "write_file",
    args: { path: "notes.md" },
    isAllowListed: true,
    policies: [],
    autoApprove: false,
    unattended: false,
    ...overrides,
  };
}

interface Row {
  label: string;
  input: Partial<AuthorizationInput>;
  verdict: "allow" | "deny" | "ask";
  deniedBy?: DeniedBy;
  reason?: string;
}

const DENY_SHELL: PolicyRule[] = [deny("execute_command", { name: "no-shell" })];

const ROWS: Row[] = [
  // ── 1. allow-list ────────────────────────────────────────────
  {
    label: "a tool the run did not offer is denied even with autoApprove and an APPROVE policy",
    input: { isAllowListed: false, autoApprove: true, policies: [allow("write_file")] },
    verdict: "deny",
    deniedBy: "scope",
  },
  {
    label: "the allow-list binds a profile-admitted run",
    input: { isAllowListed: false, asksResolvedByProfile: true },
    verdict: "deny",
    deniedBy: "scope",
  },
  // ── 2. DENY policy ───────────────────────────────────────────
  {
    label: "DENY under autoApprove stays denied",
    input: { name: "execute_command", policies: DENY_SHELL, autoApprove: true },
    verdict: "deny",
    deniedBy: "policy",
    reason: "Denied by policy: no-shell",
  },
  {
    label: "DENY under autoApprove + unattended stays a policy deny",
    input: { name: "execute_command", policies: DENY_SHELL, autoApprove: true, unattended: true },
    verdict: "deny",
    deniedBy: "policy",
  },
  {
    label: "a person's allow cannot override DENY",
    input: { name: "execute_command", policies: DENY_SHELL, answer: { decision: "allow" } },
    verdict: "deny",
    deniedBy: "policy",
  },
  {
    label: "profile admission cannot override DENY",
    input: { name: "execute_command", policies: DENY_SHELL, asksResolvedByProfile: true },
    verdict: "deny",
    deniedBy: "policy",
  },
  {
    label: "DENY beats an APPROVE policy for the same tool",
    input: {
      name: "execute_command",
      policies: [allow("execute_command"), deny("execute_command", { name: "no-shell" })],
      autoApprove: true,
    },
    verdict: "deny",
    deniedBy: "policy",
  },
  {
    label: "DENY beats a hook denial (reported as the policy)",
    input: { name: "execute_command", policies: DENY_SHELL, hookDenial: "critic says no" },
    verdict: "deny",
    deniedBy: "policy",
  },
  {
    label: "a DENY whose predicate throws still applies (fails closed)",
    input: {
      name: "execute_command",
      policies: [deny("execute_command", { name: "rm-guard", when: throwingPredicate })],
      autoApprove: true,
    },
    verdict: "deny",
    deniedBy: "policy",
  },
  {
    label: "a read-only tool under a wildcard DENY is denied",
    input: { name: "read_file", policies: [denyAll()], autoApprove: true },
    verdict: "deny",
    deniedBy: "policy",
  },
  // ── 3. hook deny ─────────────────────────────────────────────
  {
    label: "a hook denial binds under autoApprove",
    input: { name: "execute_command", hookDenial: "critic says no", autoApprove: true },
    verdict: "deny",
    deniedBy: "hook",
    reason: "critic says no",
  },
  {
    label: "a hook denial beats an APPROVE policy",
    input: { policies: [allow("write_file")], hookDenial: "critic says no" },
    verdict: "deny",
    deniedBy: "hook",
  },
  {
    label: "a hook denial binds a read-only tool",
    input: { name: "read_file", hookDenial: "blocked path" },
    verdict: "deny",
    deniedBy: "hook",
  },
  // ── 4. allow without asking ──────────────────────────────────
  {
    label: "an APPROVE policy allows a write tool without asking",
    input: { policies: [allow("write_file", { name: "notes-ok" })] },
    verdict: "allow",
    reason: "Approved by policy: notes-ok",
  },
  {
    label: "an APPROVE policy whose predicate throws is skipped (the call asks)",
    input: { policies: [allow("write_file", { when: throwingPredicate })] },
    verdict: "ask",
  },
  {
    label: "a read-only tool runs without asking",
    input: { name: "read_file" },
    verdict: "allow",
    reason: "read_only",
  },
  // ── 5. ask, and what answers it ──────────────────────────────
  {
    label: "a write tool asks",
    input: {},
    verdict: "ask",
    reason: "requires_approval",
  },
  {
    label: "an unknown tool is write tier and asks",
    input: { name: "some_mcp_tool" },
    verdict: "ask",
  },
  {
    label: "an ASK_USER policy makes a read-only tool ask",
    input: { name: "read_file", policies: [askUser("read_file", { name: "confirm-read" })] },
    verdict: "ask",
    reason: "Requires approval: confirm-read",
  },
  {
    label: "autoApprove answers an ask",
    input: { name: "execute_command", autoApprove: true },
    verdict: "allow",
    reason: "auto_approve",
  },
  {
    label: "autoApprove answers an ASK_USER policy",
    input: { policies: [askUser("write_file")], autoApprove: true },
    verdict: "allow",
    reason: "auto_approve",
  },
  {
    label: "autoApprove answers an ask on an unattended run",
    input: { autoApprove: true, unattended: true },
    verdict: "allow",
    reason: "auto_approve",
  },
  {
    label: "profile admission answers an ask",
    input: { name: "execute_command", asksResolvedByProfile: true },
    verdict: "allow",
    reason: "profile_admission",
  },
  {
    label: "a person's allow answers an ask",
    input: { answer: { decision: "allow" } },
    verdict: "allow",
    reason: "user_approved",
  },
  {
    label: "a person's deny ends the call with their reason",
    input: { answer: { decision: "deny", reason: "use staging" } },
    verdict: "deny",
    deniedBy: "user",
    reason: "use staging",
  },
  {
    label: "a person's deny without a reason",
    input: { answer: { decision: "deny" } },
    verdict: "deny",
    deniedBy: "user",
    reason: "user_rejected",
  },
  {
    label: "an unattended run denies an ask instead of waiting",
    input: { unattended: true },
    verdict: "deny",
    deniedBy: "unattended",
  },
];

describe("decideToolCall precedence", () => {
  it.each(ROWS)("$label", (row) => {
    const decision = decideToolCall(input(row.input));
    expect(decision.verdict).toBe(row.verdict);
    if (row.deniedBy) {
      expect(decision.verdict === "deny" && decision.deniedBy).toBe(row.deniedBy);
    } else {
      expect(decision).not.toHaveProperty("deniedBy");
    }
    if (row.reason) expect(decision.reason).toBe(row.reason);
  });

  it("reports the tier the approval card shows", () => {
    expect(decideToolCall(input({ name: "execute_command" }))).toMatchObject({ tier: 3, tierLabel: "danger" });
    expect(decideToolCall(input({ name: "write_file" }))).toMatchObject({ tier: 2, tierLabel: "write" });
    expect(decideToolCall(input({ name: "read_file" }))).toMatchObject({ tier: 1, tierLabel: "auto" });
  });
});

describe("deniedToolResult", () => {
  it.each([
    ["scope", "PERMISSION_DENIED", "not whitelisted"],
    ["policy", "POLICY_DENIED", "Tool execution denied by policy: Denied by policy: no-shell"],
    ["hook", "BLOCKED_BY_SAFETY_HOOK", "safety hook: critic says no"],
    ["user", "USER_REJECTED", "manually rejected by the user"],
    ["unattended", "APPROVAL_UNAVAILABLE", "needs a person's approval"],
  ] as const)("a %s denial reports %s", (deniedBy, error, message) => {
    const reason = deniedBy === "policy" ? "Denied by policy: no-shell" : "critic says no";
    const result = deniedToolResult("execute_command", {
      verdict: "deny",
      deniedBy,
      reason,
      tier: 3,
      tierLabel: "danger",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe(error);
    expect(result.message).toContain(message);
  });
});
