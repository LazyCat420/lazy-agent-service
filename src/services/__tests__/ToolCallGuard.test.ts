import { describe, it, expect, beforeEach } from "vitest";
import {
  guardedRun,
  callKey,
  recordAttempt,
  resetGuard,
  GUARD_CONFIG,
} from "../ToolCallGuard.ts";

const key = (args: unknown = { ticker: "NVDA" }) => callKey("get_sec_filings", args);

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe("ToolCallGuard", () => {
  beforeEach(() => resetGuard());

  it("coalesces identical in-flight calls into a single execution", async () => {
    const gate = deferred<string>();
    let executions = 0;

    // 200 concurrent identical calls — the shape of the 2026-07-14 storm.
    const calls = Array.from({ length: 200 }, () =>
      guardedRun({
        toolName: "get_sec_filings",
        key: key(),
        run: async () => {
          executions += 1;
          return gate.promise;
        },
      }),
    );

    gate.resolve("filings");
    const results = await Promise.all(calls);

    expect(executions).toBe(1);
    expect(results).toHaveLength(200);
    expect(new Set(results)).toEqual(new Set(["filings"]));
  });

  it("does not coalesce calls with different arguments", async () => {
    let executions = 0;
    const run = async () => {
      executions += 1;
      return "ok";
    };
    await Promise.all([
      guardedRun({ toolName: "t", key: key({ ticker: "NVDA" }), run }),
      guardedRun({ toolName: "t", key: key({ ticker: "AMD" }), run }),
    ]);
    expect(executions).toBe(2);
  });

  it("frees the in-flight slot so later identical calls re-execute", async () => {
    let executions = 0;
    const run = async () => {
      executions += 1;
      return "ok";
    };
    await guardedRun({ toolName: "t", key: key(), run });
    await guardedRun({ toolName: "t", key: key(), run });
    expect(executions).toBe(2);
  });

  it("escalates repeats: allow → prefer_cache → refuse", () => {
    const verdicts: string[] = [];
    for (let i = 0; i < GUARD_CONFIG.REPEAT_REFUSE_AT; i++) {
      verdicts.push(recordAttempt("t", key(), { cycleId: "c1" }).verdict);
    }
    expect(verdicts[0]).toBe("allow");
    expect(verdicts[GUARD_CONFIG.REPEAT_SOFT_AT - 1]).toBe("prefer_cache");
    expect(verdicts[GUARD_CONFIG.REPEAT_REFUSE_AT - 1]).toBe("refuse");
  });

  it("scopes the ledger per cycle so one runaway agent cannot starve another", () => {
    for (let i = 0; i < GUARD_CONFIG.REPEAT_REFUSE_AT; i++) {
      recordAttempt("t", key(), { cycleId: "noisy" });
    }
    expect(recordAttempt("t", key(), { cycleId: "quiet" }).verdict).toBe("allow");
  });

  it("refuses a runaway repeat with actionable guidance, not a bare error", async () => {
    const run = async () => "fresh";
    let last: unknown;
    for (let i = 0; i < GUARD_CONFIG.REPEAT_REFUSE_AT; i++) {
      last = await guardedRun({
        toolName: "get_sec_filings",
        key: key(),
        scope: { cycleId: "c1" },
        run,
      });
    }
    const refusal = last as Record<string, unknown>;
    expect(refusal.is_error).toBe(true);
    expect(refusal.guard).toBe("repeat_call");
    // The text must tell the model what to do instead — a bare refusal just
    // gets retried, which is the behaviour that caused the incident.
    expect(String(refusal.error)).toMatch(/different tool|change/i);
  });

  it("serves cache instead of re-executing once repeats turn soft", async () => {
    let executions = 0;
    const run = async () => {
      executions += 1;
      return "fresh";
    };
    const cached = () => "cached-value";

    const results: unknown[] = [];
    for (let i = 0; i < GUARD_CONFIG.REPEAT_SOFT_AT; i++) {
      results.push(
        await guardedRun({ toolName: "t", key: key(), scope: { cycleId: "c" }, cached, run }),
      );
    }
    expect(results[GUARD_CONFIG.REPEAT_SOFT_AT - 1]).toBe("cached-value");
    expect(executions).toBeLessThan(GUARD_CONFIG.REPEAT_SOFT_AT);
  });

  it("caps concurrency per tool and fails fast rather than queueing", async () => {
    const gate = deferred<string>();
    let peak = 0;
    let active = 0;

    const run = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
      return "ok";
    };

    // Distinct args so nothing coalesces — this exercises the semaphore alone.
    const calls = Array.from({ length: GUARD_CONFIG.MAX_CONCURRENCY + 4 }, (_, i) =>
      guardedRun({ toolName: "busy_tool", key: callKey("busy_tool", { i }), run }),
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(peak).toBeLessThanOrEqual(GUARD_CONFIG.MAX_CONCURRENCY);

    gate.resolve("ok");
    await Promise.all(calls);
  });

  it("releases the slot even when the tool throws", async () => {
    const boom = guardedRun({
      toolName: "t",
      key: key(),
      run: async () => {
        throw new Error("upstream exploded");
      },
    });
    await expect(boom).rejects.toThrow("upstream exploded");

    // A leaked slot would make this hang or refuse; it should just run.
    const after = await guardedRun({ toolName: "t", key: key({ x: 1 }), run: async () => "ok" });
    expect(after).toBe("ok");
  });
});
