import { describe, expect, it } from "vitest";
import { RunRequestSchema } from "../../src/services/RunAdmission.ts";
import { ApprovalResolutionCommandSchema, RunEventSchema, RunResultSchema, RUNTIME_WIRE_CONTRACT_VERSION } from "../../src/contracts/RuntimeWire.ts";

describe("runtime wire contract", () => {
  it("exports the actual admission schema", () => {
    expect(RUNTIME_WIRE_CONTRACT_VERSION).toBe("runtime-wire.v1.0.0");
    expect(() => RunRequestSchema.parse({ profile_id: "notes", input: "read" })).not.toThrow();
  });

  it("validates approval commands and terminal run snapshots", () => {
    expect(ApprovalResolutionCommandSchema.parse({ approved: false })).toEqual({ approved: false });
    expect(RunEventSchema.parse({ id: "evt-1", run_id: "run-1", type: "approval.required", timestamp: "2026-09-19T10:00:00Z", data: {} }).type).toBe("approval.required");
    expect(RunResultSchema.parse({ run_id: "run-1", status: "waiting_for_approval", messages: [] }).status).toBe("waiting_for_approval");
  });
});
