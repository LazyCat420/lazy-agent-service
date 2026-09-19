import { CreateRunRequest, RunEvent, RunResult } from "../../src/types/run.ts";
import { RunExecutionEngine } from "../../src/services/RunExecutionEngine.ts";
import { ProfileRegistry } from "../../src/services/ProfileRegistry.ts";
import { RunStore } from "../../src/services/RunStore.ts";
import { RunStateMachine } from "../../src/services/RunStateMachine.ts";
import AgenticLoopService from "../../src/services/AgenticLoopService.ts";
import { RunEvidenceStore } from "../../src/platform/verify/RunEvidenceStore.ts";
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";

describe("Authoritative Run API Contract & State Machine Tests", () => {
  beforeEach(async () => {
    RunExecutionEngine.reset();
    ProfileRegistry.clear();
    RunEvidenceStore.getGlobalInstance().clearAll();
    vi.restoreAllMocks();
    // Load profiles from the workspace profiles/ directory
    await ProfileRegistry.loadProfilesFromDisk(path.resolve(process.cwd(), "profiles"));
  });

  it("isolates execution requests across concurrent runs", async () => {
    const loopSpy = vi.spyOn(AgenticLoopService, "runAgenticLoop").mockImplementation(async (ctx) => {
      return {
        messages: [{ role: "assistant", content: `Response for conversation ${ctx.conversationId}` }],
      } as any;
    });

    const events1: RunEvent[] = [];
    const events2: RunEvent[] = [];

    const req1: CreateRunRequest = {
      profile_id: "trading-analyst-v1",
      input: "Query 1",
    };
    const req2: CreateRunRequest = {
      profile_id: "trading-analyst-v1",
      input: "Query 2",
    };

    const [res1, res2] = await Promise.all([
      RunExecutionEngine.startRun("run-iso-1", req1, (evt) => events1.push({ ...evt, id: "1", timestamp: "" })),
      RunExecutionEngine.startRun("run-iso-2", req2, (evt) => events2.push({ ...evt, id: "2", timestamp: "" })),
    ]);

    expect(res1.run_id).toBe("run-iso-1");
    expect(res2.run_id).toBe("run-iso-2");
    expect(res1.status).toBe("completed");
    expect(res2.status).toBe("completed");
    expect(res1.messages[0].content).toContain("run-iso-1");
    expect(res2.messages[0].content).toContain("run-iso-2");

    expect(loopSpy).toHaveBeenCalledTimes(2);
    const invokedConversationIds = [
      loopSpy.mock.calls[0][0].conversationId,
      loopSpy.mock.calls[1][0].conversationId,
    ];
    expect(invokedConversationIds).toContain("run-iso-1");
    expect(invokedConversationIds).toContain("run-iso-2");
  });

  it("handles explicit cancellation propagation to active loop", async () => {
    vi.spyOn(AgenticLoopService, "runAgenticLoop").mockImplementation(async (ctx) => {
      if (ctx.signal?.aborted) {
        throw new Error("Aborted");
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve({ messages: [] } as any);
        }, 3000);

        ctx.signal?.addEventListener("abort", () => {
          clearTimeout(timeout);
          reject(new Error("Execution cancelled by client"));
        });
      });
    });

    const emittedEvents: string[] = [];
    const runPromise = RunExecutionEngine.startRun(
      "run-cancel-1",
      {
        profile_id: "trading-analyst-v1",
        input: "Run that will be cancelled",
      },
      (evt) => emittedEvents.push(evt.type),
    );

    // Cancel asynchronously via cancelRun
    setTimeout(async () => {
      await RunExecutionEngine.cancelRun("run-cancel-1");
    }, 40);

    const result = await runPromise;
    expect(result.status).toBe("cancelled");
    expect(result.error?.code).toBe("RUN_CANCELLED");
    expect(result.error?.category).toBe("CLIENT");
    expect(emittedEvents).toContain("run.cancelled");

    const record = await RunStore.getRun("run-cancel-1");
    expect(record?.status).toBe("cancelled");
  });

  it("enforces deadline timeout and transitions to timed_out", async () => {
    vi.spyOn(AgenticLoopService, "runAgenticLoop").mockImplementation(async (ctx) => {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve({ messages: [{ role: "assistant", content: "Finished too late" }] } as any);
        }, 1000);

        ctx.signal?.addEventListener("abort", () => {
          clearTimeout(timeout);
          reject(new Error("DEADLINE_EXCEEDED"));
        });
      });
    });

    const emittedEvents: string[] = [];
    const result = await RunExecutionEngine.startRun(
      "run-deadline-1",
      {
        profile_id: "trading-analyst-v1",
        input: "Analyze huge market book",
        budget: {
          max_duration_ms: 60,
        },
      },
      (evt) => emittedEvents.push(evt.type),
    );

    expect(result.status).toBe("timed_out");
    expect(result.error?.code).toBe("DEADLINE_EXCEEDED");
    expect(result.error?.category).toBe("RESOURCE");
    expect(emittedEvents).toContain("run.failed");

    const record = await RunStore.getRun("run-deadline-1");
    expect(record?.status).toBe("timed_out");
  });

  it("proves concurrent duplicate idempotency-key test executes exactly once and signals conflict", async () => {
    const loopSpy = vi.spyOn(AgenticLoopService, "runAgenticLoop").mockImplementation(async () => {
      // Simulate 50ms execution delay to create race window
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        messages: [{ role: "assistant", content: "Deterministic valuation output" }],
      } as any;
    });

    const req1: CreateRunRequest = {
      profile_id: "trading-analyst-v1",
      input: "Evaluate trade concurrently",
      idempotency_key: "idem-concurrent-race-123",
    };
    const req2: CreateRunRequest = {
      profile_id: "trading-analyst-v1",
      input: "Evaluate trade concurrently",
      idempotency_key: "idem-concurrent-race-123",
    };

    // Fire both concurrently
    const [res1, res2] = await Promise.all([
      RunExecutionEngine.startRun("run-first-race", req1, () => {}),
      RunExecutionEngine.startRun("run-second-race", req2, () => {}),
    ]);

    // Exactly one execution occurred
    expect(loopSpy).toHaveBeenCalledTimes(1);

    // One succeeded, and the other detected conflict
    const statuses = [res1.status, res2.status];
    expect(statuses).toContain("completed");
    expect(statuses).toContain("failed");

    const conflictResult = res1.status === "failed" ? res1 : res2;
    expect(conflictResult.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(conflictResult.error?.retryable).toBe(true);
    expect(conflictResult.error?.category).toBe("CLIENT");
  });

  it("survives service restart/reload and returns cached idempotency result", async () => {
    const loopSpy = vi.spyOn(AgenticLoopService, "runAgenticLoop").mockResolvedValue({
      messages: [{ role: "assistant", content: "Durable result preserved" }],
    } as any);

    const idempotencyKey = "idem-durable-test-key-999";
    const req1: CreateRunRequest = {
      profile_id: "trading-analyst-v1",
      input: "Store in durable cache",
      idempotency_key: idempotencyKey,
    };

    const res1 = await RunExecutionEngine.startRun("run-first-durable", req1, () => {});
    expect(res1.status).toBe("completed");
    expect(loopSpy).toHaveBeenCalledTimes(1);

    // Simulate service restart: reload RunStore from persistent disk snapshot
    await RunStore.reload();

    const req2: CreateRunRequest = {
      profile_id: "trading-analyst-v1",
      input: "Store in durable cache",
      idempotency_key: idempotencyKey,
    };

    const res2 = await RunExecutionEngine.startRun("run-second-durable", req2, () => {});
    // Returned cached result from disk without second loop execution
    expect(res2.status).toBe("completed");
    expect(res2.run_id).toBe("run-first-durable");
    expect(res2.messages[0].content).toBe("Durable result preserved");
    expect(loopSpy).toHaveBeenCalledTimes(1);
  });

  it("seals context receipt, usage, and evidence records into authoritative RunRecord", async () => {
    vi.spyOn(AgenticLoopService, "runAgenticLoop").mockImplementation(async (ctx) => {
      // Simulate span creation into RunEvidenceStore
      RunEvidenceStore.getGlobalInstance().record({
        trace_id: "tr-001",
        span_id: "span-tool-001",
        run_id: "run-receipt-test",
        name: "tool:fetch_financial_statement",
        kind: "tool_execution",
        status: "OK",
        start_time: new Date().toISOString(),
        attributes: {
          tool_name: "fetch_financial_statement",
          tokens_input: 150,
          tokens_output: 50,
          input_hash: "sha256-evidence-test-hash",
        },
        events: [],
        links: [],
      });
      return {
        messages: [{ role: "assistant", content: "Analysis complete with sealed evidence" }],
      } as any;
    });

    const result = await RunExecutionEngine.startRun(
      "run-receipt-test",
      {
        profile_id: "trading-analyst-v1",
        input: "Verify balance sheet",
      },
      () => {},
    );

    expect(result.status).toBe("completed");
    expect(result.context_receipt).toBeDefined();
    expect(result.context_receipt?.receipt_id).toMatch(/^sha256-[a-f0-9]{64}$/);
    expect(result.context_receipt?.layers.prefix.hash).toBeDefined();
    expect(result.context_receipt?.layers.project_scope.hash).toBeDefined();

    expect(result.evidence_records?.length).toBeGreaterThan(0);
    expect(result.evidence_records?.[0].evidence_id).toBe("span-tool-001");
    expect(result.evidence_records?.[0].source).toBe("tool:fetch_financial_statement");

    expect(result.usage?.prompt_tokens).toBe(150);
    expect(result.usage?.completion_tokens).toBe(50);
    expect(result.usage?.tool_calls_count).toBe(1);

    // Check authoritative store
    const stored = await RunStore.getRun("run-receipt-test");
    expect(stored?.status).toBe("completed");
    expect(stored?.context_receipt?.receipt_id).toBe(result.context_receipt?.receipt_id);
    expect(stored?.evidence_records?.length).toBe(1);
  });

  it("enforces state machine transition invariants", () => {
    expect(RunStateMachine.isValidTransition("admitted", "running")).toBe(true);
    expect(RunStateMachine.isValidTransition("running", "waiting_for_tool")).toBe(true);
    expect(RunStateMachine.isValidTransition("waiting_for_tool", "running")).toBe(true);
    expect(RunStateMachine.isValidTransition("running", "completed")).toBe(true);
    expect(RunStateMachine.isValidTransition("running", "cancelled")).toBe(true);
    expect(RunStateMachine.isValidTransition("running", "timed_out")).toBe(true);

    // Terminal states cannot transition
    expect(RunStateMachine.isValidTransition("completed", "running")).toBe(false);
    expect(RunStateMachine.isValidTransition("failed", "running")).toBe(false);
    expect(RunStateMachine.isValidTransition("cancelled", "running")).toBe(false);
    expect(RunStateMachine.isValidTransition("timed_out", "running")).toBe(false);

    expect(() => {
      RunStateMachine.assertValidTransition("run-test-id", "completed", "running");
    }).toThrow("Invalid state transition for run run-test-id: cannot transition from 'completed' to 'running'");
  });

  it("rejects unauthorized runtime overrides (model, budget, tools)", async () => {
    // Model not allowed by profile
    const unapprovedModelRes = await RunExecutionEngine.startRun(
      "run-bad-model",
      {
        profile_id: "trading-analyst-v1",
        input: "Test input",
        runtime_overrides: {
          model: "unapproved-cloud-model-4",
        },
      },
      () => {},
    );
    expect(unapprovedModelRes.status).toBe("failed");
    expect(unapprovedModelRes.error?.code).toBe("INVALID_RUN_REQUEST");
    expect(unapprovedModelRes.error?.message).toContain("not permitted by profile");

    // Budget tokens exceeding profile ceiling
    const excessiveBudgetRes = await RunExecutionEngine.startRun(
      "run-bad-budget",
      {
        profile_id: "trading-analyst-v1",
        input: "Test input",
        runtime_overrides: {
          budget: {
            max_tokens: 999999, // profile ceiling is 8192
          },
        },
      },
      () => {},
    );
    expect(excessiveBudgetRes.status).toBe("failed");
    expect(excessiveBudgetRes.error?.code).toBe("INVALID_RUN_REQUEST");
    expect(excessiveBudgetRes.error?.message).toContain("exceeds profile limit");

    // Tool not in strict whitelist
    const disallowedToolRes = await RunExecutionEngine.startRun(
      "run-bad-tool",
      {
        profile_id: "trading-analyst-v1",
        input: "Test input",
        runtime_overrides: {
          tools: ["unauthorized_exec_tool"],
        },
      },
      () => {},
    );
    expect(disallowedToolRes.status).toBe("failed");
    expect(disallowedToolRes.error?.code).toBe("INVALID_RUN_REQUEST");
    expect(disallowedToolRes.error?.message).toContain("not allowed by profile");
  });

  it("fails gracefully with PROFILE_NOT_FOUND when profile does not exist", async () => {
    const emittedEvents: string[] = [];
    const result = await RunExecutionEngine.startRun(
      "run-missing-profile",
      {
        profile_id: "unknown-role-xyz",
        input: "Test input",
      },
      (evt) => emittedEvents.push(evt.type),
    );

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("PROFILE_NOT_FOUND");
    expect(result.error?.message).toContain("Profile unknown-role-xyz not found");
    expect(emittedEvents).toContain("run.failed");
  });
});
