import { describe, it, expect, vi } from "vitest";
import {
  collectEvidence,
  enforceVerificationContract,
  isVerifierTool,
  EVIDENCE_DEMAND_PROMPT,
} from "../verify/VerificationContract.ts";
import type { ConversationMessage } from "../../services/harnesses/types.ts";

function toolTurn(
  name: string,
  result: unknown,
  id = "call_1",
): ConversationMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: [{ id, name, args: {}, result }],
  };
}

describe("isVerifierTool", () => {
  it("recognizes verifier-class tools across prefixing conventions", () => {
    for (const name of [
      "bash",
      "run_command",
      "vitest",
      "mcp__tools__run_tests",
      "npm_test",
      "lint-check",
      "verify_claim",
    ]) {
      expect(isVerifierTool(name)).toBe(true);
    }
  });

  it("rejects non-verifier tools", () => {
    for (const name of ["read_file", "get_market_data", "web_search", "take_note"]) {
      expect(isVerifierTool(name)).toBe(false);
    }
  });
});

describe("collectEvidence", () => {
  it("finds successful non-empty observations from verifier-class tools", () => {
    const messages: ConversationMessage[] = [
      toolTurn("read_file", { success: true, message: "irrelevant" }, "c0"),
      toolTurn("bash", { success: true, message: "3 tests passed" }, "c1"),
      toolTurn("bash", { success: false, message: "boom" }, "c2"),
      toolTurn("vitest", { success: true, message: "   " }, "c3"),
    ];
    const refs = collectEvidence(messages, {});
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      kind: "tool-observation",
      toolName: "bash",
      callId: "c1",
    });
    expect(refs[0].excerpt).toContain("3 tests passed");
  });

  it("accepts explicit evidence from run options", () => {
    const refs = collectEvidence([], { evidence: "manually verified diff" });
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("explicit-evidence");
  });

  it("ignores empty-string and empty-object explicit evidence", () => {
    expect(collectEvidence([], { evidence: "   " })).toHaveLength(0);
    expect(collectEvidence([], { evidence: {} })).toHaveLength(0);
    expect(collectEvidence([], {})).toHaveLength(0);
  });
});

describe("enforceVerificationContract — soft mode", () => {
  it("attaches no-evidence status and warns when no evidence exists", async () => {
    const warn = vi.fn();
    const outcome = await enforceVerificationContract({
      messages: [toolTurn("read_file", { success: true, message: "contents" })],
      options: {},
      warn,
    });
    expect(outcome.verification.status).toBe("no-evidence");
    expect(outcome.messages).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("VerificationContract");
  });

  it("reports verified without warning when evidence exists", async () => {
    const warn = vi.fn();
    const outcome = await enforceVerificationContract({
      messages: [toolTurn("bash", { success: true, message: "all green" })],
      options: {},
      warn,
    });
    expect(outcome.verification.status).toBe("verified");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("enforceVerificationContract — strict mode", () => {
  it("injects one evidence-demand turn, grants the extra turn, then reports missing", async () => {
    const runExtraTurn = vi.fn(async (messages: ConversationMessage[]) => [
      ...messages,
      {
        role: "assistant",
        content: "I cannot produce evidence.",
      } as ConversationMessage,
    ]);
    const outcome = await enforceVerificationContract({
      messages: [{ role: "assistant", content: "done, probably" }],
      options: { requireEvidence: true },
      runExtraTurn,
    });

    expect(runExtraTurn).toHaveBeenCalledTimes(1);
    const demanded = runExtraTurn.mock.calls[0][0];
    const injected = demanded[demanded.length - 1];
    expect(injected.role).toBe("system");
    expect(String(injected.content)).toBe(EVIDENCE_DEMAND_PROMPT);

    expect(outcome.verification.status).toBe("missing");
    expect(outcome.verification).toMatchObject({ demandedTurn: true });
    // Final message list carries the demand turn and the extra turn.
    expect(outcome.messages.at(-1)?.content).toContain("cannot produce evidence");
    expect(outcome.messages.some((m) => m.role === "system" && m.content === EVIDENCE_DEMAND_PROMPT)).toBe(true);
  });

  it("reports verified when the extra turn produces evidence", async () => {
    const outcome = await enforceVerificationContract({
      messages: [{ role: "assistant", content: "done" }],
      options: { requireEvidence: true },
      runExtraTurn: async (messages) => [
        ...messages,
        toolTurn("bash", { success: true, message: "vitest: 10 passed" }, "late"),
      ],
    });
    expect(outcome.verification.status).toBe("verified");
    expect(outcome.verification.status === "verified" && outcome.verification.evidence[0].toolName).toBe("bash");
  });

  it("still injects the demand message and reports missing when no extra-turn runner is supplied", async () => {
    const outcome = await enforceVerificationContract({
      messages: [{ role: "assistant", content: "done" }],
      options: { requireEvidence: true },
    });
    expect(outcome.verification.status).toBe("missing");
    expect(outcome.messages.at(-1)?.role).toBe("system");
  });
});
