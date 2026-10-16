/**
 * ch.06 item 3 — DENY policies are final in every mode.
 *
 * prism's AutoApprovalEngine reads the agent's policies before full auto
 * (explainCall: "Deny — from permission rules or agent policies. Final in
 * every mode, full auto and sub-agents included"). Ours returned
 * `full_auto` before the policies were read, so trading's DENY policies
 * (execute_command, execute_javascript, …) never applied under
 * `autoApprove: true`.
 */
import { describe, expect, it } from "vitest";

import AutoApprovalEngine from "../AutoApprovalEngine.ts";
import type { ToolCall } from "../harnesses/types.ts";

const call = (name: string): ToolCall => ({ id: "t1", name, args: {} });

describe("AutoApprovalEngine: DENY before full-auto", () => {
  it("a DENY policy refuses a call under fullAuto (was full_auto-approved)", () => {
    const engine = new AutoApprovalEngine({
      fullAuto: true,
      policies: [
        { tool: "execute_command", decision: "DENY", name: "trading boundary" },
      ],
    });
    const result = engine.check(call("execute_command"));
    expect(result.isApproved).toBe(false);
  });

  it("a DENY policy refuses a Tier-1 tool under fullAuto", () => {
    const engine = new AutoApprovalEngine({
      fullAuto: true,
      policies: [{ tool: "search_web", decision: "DENY", name: "no net" }],
    });
    expect(engine.check(call("search_web")).isApproved).toBe(false);
  });

  it("full auto still approves what no policy decided", () => {
    const engine = new AutoApprovalEngine({
      fullAuto: true,
      policies: [{ tool: "execute_command", decision: "DENY", name: "x" }],
    });
    expect(engine.check(call("get_market_data")).isApproved).toBe(true);
  });

  it("an ASK_USER policy is answered yes by full auto (prism: full auto answers an ask)", () => {
    const engine = new AutoApprovalEngine({
      fullAuto: true,
      policies: [{ tool: "write_file", decision: "ASK_USER", name: "confirm" }],
    });
    expect(engine.check(call("write_file")).isApproved).toBe(true);
  });

  it("an ASK_USER policy asks without full auto", () => {
    const engine = new AutoApprovalEngine({
      fullAuto: false,
      policies: [{ tool: "write_file", decision: "ASK_USER", name: "confirm" }],
    });
    expect(engine.check(call("write_file")).isApproved).toBe(false);
  });
});
