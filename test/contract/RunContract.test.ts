import { CreateRunRequest, RunEvent } from "../../src/types/run.ts";
import { RunExecutionEngine } from "../../src/services/RunExecutionEngine.ts";
import { ProfileRegistry } from "../../src/services/ProfileRegistry.ts";
import AgenticLoopService from "../../src/services/AgenticLoopService.ts";
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("Run API Contract Tests", () => {
  beforeEach(() => {
    RunExecutionEngine.reset();
    ProfileRegistry.clear();
    vi.restoreAllMocks();
  });

  it("isolates execution requests", async () => {
    const loopSpy = vi.spyOn(AgenticLoopService, "runAgenticLoop").mockImplementation(async (ctx) => {
      return {
        messages: [{ role: "assistant", content: `Response for conversation ${ctx.conversationId}` }],
      } as any;
    });

    const events1: RunEvent[] = [];
    const events2: RunEvent[] = [];

    const req1: CreateRunRequest = {
      profileId: "trading-analyst",
      input: "Query 1",
    };
    const req2: CreateRunRequest = {
      profileId: "trading-analyst",
      input: "Query 2",
    };

    const [res1, res2] = await Promise.all([
      RunExecutionEngine.startRun("run-iso-1", req1, (evt) => events1.push({ ...evt, id: "1", timestamp: "" })),
      RunExecutionEngine.startRun("run-iso-2", req2, (evt) => events2.push({ ...evt, id: "2", timestamp: "" })),
    ]);

    expect(res1.id).toBe("run-iso-1");
    expect(res2.id).toBe("run-iso-2");
    expect(res1.status).toBe("completed");
    expect(res2.status).toBe("completed");
    expect(res1.messages[0].content).toContain("run-iso-1");
    expect(res2.messages[0].content).toContain("run-iso-2");

    expect(loopSpy).toHaveBeenCalledTimes(2);
    expect(loopSpy.mock.calls[0][0].conversationId).toBe("run-iso-1");
    expect(loopSpy.mock.calls[1][0].conversationId).toBe("run-iso-2");
  });

  it("handles cancellation propagation", async () => {
    const abortController = new AbortController();

    vi.spyOn(AgenticLoopService, "runAgenticLoop").mockImplementation(async (ctx) => {
      if (ctx.signal?.aborted) {
        throw new Error("Aborted");
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve({ messages: [] } as any);
        }, 5000);

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
        profileId: "trading-analyst",
        input: "Run that will be cancelled",
        signal: abortController.signal,
      },
      (evt) => emittedEvents.push(evt.type),
    );

    // Cancel asynchronously
    setTimeout(() => {
      abortController.abort();
    }, 50);

    const result = await runPromise;
    expect(result.status).toBe("cancelled");
    expect(result.error?.code).toBe("RUN_CANCELLED");
    expect(emittedEvents).toContain("run.cancelled");
  });

  it("enforces budget limits (retries and tool calls)", async () => {
    let capturedOptions: any = null;
    vi.spyOn(AgenticLoopService, "runAgenticLoop").mockImplementation(async (ctx) => {
      capturedOptions = ctx.options;
      return { messages: [] } as any;
    });

    const req: CreateRunRequest = {
      profileId: "trading-analyst",
      input: "Check financial data",
      budget: {
        maxTokens: 4096,
        maxToolCalls: 7,
        maxRetries: 2,
        maxDurationMs: 30000,
      },
    };

    const result = await RunExecutionEngine.startRun("run-budget-1", req, () => {});
    expect(result.status).toBe("completed");
    expect(capturedOptions).toBeDefined();
    expect(capturedOptions.maxIterations).toBe(7);
  });

  it("prevents duplicate requests via idempotency key", async () => {
    const loopSpy = vi.spyOn(AgenticLoopService, "runAgenticLoop").mockResolvedValue({
      messages: [{ role: "assistant", content: "Deterministic trade evaluation" }],
    } as any);

    const req1: CreateRunRequest = {
      profileId: "trading-analyst",
      input: "Evaluate trade",
      idempotencyKey: "idem-key-abc-123",
    };

    const res1 = await RunExecutionEngine.startRun("run-first", req1, () => {});
    expect(res1.id).toBe("run-first");
    expect(res1.status).toBe("completed");
    expect(loopSpy).toHaveBeenCalledTimes(1);

    // Second call with same idempotency key
    const req2: CreateRunRequest = {
      profileId: "trading-analyst",
      input: "Evaluate trade",
      idempotencyKey: "idem-key-abc-123",
    };

    const res2 = await RunExecutionEngine.startRun("run-second", req2, () => {});
    // Second call returns original cached result
    expect(res2.id).toBe("run-first");
    expect(res2.status).toBe("completed");
    expect(loopSpy).toHaveBeenCalledTimes(1); // loop was NOT called a second time!
  });

  it("fails gracefully when profile is not found", async () => {
    const emittedEvents: string[] = [];
    const result = await RunExecutionEngine.startRun(
      "run-missing-profile",
      {
        profileId: "unknown-role-xyz",
        input: "Test input",
      },
      (evt) => emittedEvents.push(evt.type),
    );

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("RUN_FAILED");
    expect(result.error?.message).toContain("Profile unknown-role-xyz not found");
    expect(emittedEvents).toContain("run.failed");
  });
});
