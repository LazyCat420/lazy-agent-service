/**
 * TCK-2002: a DENY policy settles a call before full-auto / autoApprove can
 * answer an ask (ToolAuthorization.ts decideToolCall, DENY-before-auto ordering).
 *
 * No network, no live services: the policy engine and decision function are real.
 */
import { describe, expect, it } from "vitest";

import { allow, deny } from "../PolicyEngine.ts";
import type { PolicyRule } from "../PolicyEngine.ts";
import { decideToolCall } from "../ToolAuthorization.ts";
import type { AuthorizationInput } from "../ToolAuthorization.ts";

function fullAutoInput(overrides: Partial<AuthorizationInput>): AuthorizationInput {
  return {
    name: "execute_command",
    args: { command: "rm -rf build" },
    isAllowListed: true,
    policies: [],
    autoApprove: true,
    unattended: true,
    ...overrides,
  };
}

const DENY_SHELL: PolicyRule[] = [deny("execute_command", { name: "no-shell" })];
const ALLOW_WRITE: PolicyRule[] = [allow("write_file", { name: "trust-writes" })];

describe("decideToolCall: DENY policy beats full-auto / autoApprove", () => {
  it("denies a DENY-policy call under autoApprove, naming the policy", () => {
    const decision = decideToolCall(fullAutoInput({ policies: DENY_SHELL, autoApprove: true }));
    expect(decision.verdict).toBe("deny");
    expect(decision.verdict === "deny" && decision.deniedBy).toBe("policy");
    expect(decision.reason).toContain("no-shell");
  });

  it("denies a DENY-policy call under autoApprove even when not unattended", () => {
    const decision = decideToolCall(
      fullAutoInput({ policies: DENY_SHELL, autoApprove: true, unattended: false }),
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.verdict === "deny" && decision.deniedBy).toBe("policy");
    expect(decision.reason).toContain("no-shell");
  });

  it("denies a DENY-policy call under autoApprove for a write tier tool", () => {
    const decision = decideToolCall(
      fullAutoInput({
        name: "write_file",
        args: { path: "secrets.env" },
        policies: [deny("write_file", { name: "no-secret-writes" })],
        autoApprove: true,
      }),
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.verdict === "deny" && decision.deniedBy).toBe("policy");
    expect(decision.reason).toContain("no-secret-writes");
  });

  it("still denies a DENY-policy call when a person has answered allow", () => {
    const decision = decideToolCall(
      fullAutoInput({ policies: DENY_SHELL, autoApprove: false, answer: { decision: "allow" } }),
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.verdict === "deny" && decision.deniedBy).toBe("policy");
  });
});

describe("decideToolCall: ALLOW policy with autoApprove", () => {
  it("allows a policy-ALLOW call under autoApprove", () => {
    const decision = decideToolCall(
      fullAutoInput({ name: "write_file", args: { path: "notes.md" }, policies: ALLOW_WRITE, autoApprove: true }),
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.reason).toContain("trust-writes");
  });

  it("allows a write tier call with no policy under autoApprove", () => {
    const decision = decideToolCall(
      fullAutoInput({ name: "write_file", args: { path: "notes.md" }, policies: [], autoApprove: true }),
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.reason).toBe("auto_approve");
  });
});
