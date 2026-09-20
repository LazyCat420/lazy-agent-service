import { describe, expect, it } from "vitest";
import { DecisionRequestSchema } from "../../src/decision-fabric/contracts.ts";
import { RunRequestSchema } from "../../src/services/RunAdmission.ts";
import { ApprovalResolutionCommandSchema, RunEventSchema, RunResultSchema, RUNTIME_WIRE_CONTRACT_VERSION } from "../../src/contracts/RuntimeWire.ts";

describe("runtime wire contract", () => {
  it("exports the actual admission and decision schemas", () => {
    expect(RUNTIME_WIRE_CONTRACT_VERSION).toBe("runtime-wire.v1.0.0");
    expect(() => RunRequestSchema.parse({ profile_id: "notes", input: "read" })).not.toThrow();
    expect(() => DecisionRequestSchema.parse({
      requestId: "00000000-0000-4000-8000-000000000001", runId: "run-1",
      capability: "semantic.choice.v1", questionId: "agent.evidence_sufficiency.v1",
      policyVersion: "shadow.v1", dataClassification: "public", state: "{}",
      questions: { insufficient_evidence: { type: "choice", instructions: "Choose", criteria: { insufficient_evidence: "No", ready: "Yes" }, requiredAbstainOption: true } },
      constraints: { maxLatencyMs: 100, shadowOnly: true, noSideEffects: true, maxAttempts: 1 },
    })).not.toThrow();
  });

  it("validates approval commands and terminal run snapshots", () => {
    expect(ApprovalResolutionCommandSchema.parse({ approved: false })).toEqual({ approved: false });
    expect(RunEventSchema.parse({ id: "evt-1", run_id: "run-1", type: "approval.required", timestamp: "2026-09-19T10:00:00Z", data: {} }).type).toBe("approval.required");
    expect(RunResultSchema.parse({ run_id: "run-1", status: "waiting_for_approval", messages: [] }).status).toBe("waiting_for_approval");
  });
});
