import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalCapabilityExecutor } from "../GlobalCapabilityExecutor.ts";
import {
  EVAL_CHAOS_IDS,
  executeEvalChaos,
  registerEvalChaosCapabilities,
} from "../EvalChaosCapabilities.ts";
import { CapabilityRegistry } from "../CapabilityRegistry.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("eval chaos tools", () => {
  it("returns UNKNOWN_CAPABILITY when the flag is off", async () => {
    vi.stubEnv("LAS_EVAL_CHAOS", "");
    const result = await GlobalCapabilityExecutor.execute("global.eval_chaos.throw", {}, undefined);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN_CAPABILITY");
  });

  it("throw tool fails through the executor when the flag is on", async () => {
    vi.stubEnv("LAS_EVAL_CHAOS", "1");
    const result = await GlobalCapabilityExecutor.execute("global.eval_chaos.throw", {}, undefined);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("always fails");
  });

  it("hang tool resolves as CAPABILITY_CANCELLED on abort", async () => {
    vi.stubEnv("LAS_EVAL_CHAOS", "1");
    const controller = new AbortController();
    const pending = GlobalCapabilityExecutor.execute("global.eval_chaos.hang", {}, controller.signal);
    controller.abort();
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("CAPABILITY_CANCELLED");
  });

  it("hang tool rejects via executeEvalChaos with the abort reason", async () => {
    vi.stubEnv("LAS_EVAL_CHAOS", "1");
    const controller = new AbortController();
    const pending = executeEvalChaos("global.eval_chaos.hang", controller.signal);
    controller.abort();
    await expect(pending).rejects.toBe(controller.signal.reason);
  });

  it("huge tool returns at least 2 MB", async () => {
    vi.stubEnv("LAS_EVAL_CHAOS", "1");
    const result = await GlobalCapabilityExecutor.execute("global.eval_chaos.huge", {}, undefined);
    expect(result.success).toBe(true);
    expect(typeof result.result).toBe("string");
    expect((result.result as string).length).toBeGreaterThanOrEqual(2_000_000);
  });

  it("slow tool resolves after 20 seconds under fake timers", async () => {
    vi.stubEnv("LAS_EVAL_CHAOS", "1");
    vi.useFakeTimers();
    const pending = executeEvalChaos("global.eval_chaos.slow", undefined);
    const promise = expect(pending).resolves.toEqual({ success: true, result: "slow chaos tool finished" });
    await vi.advanceTimersByTimeAsync(20_000);
    await promise;
  });

  it("unknown chaos id throws", async () => {
    vi.stubEnv("LAS_EVAL_CHAOS", "1");
    await expect(executeEvalChaos("global.eval_chaos.nope", undefined)).rejects.toThrow("unknown eval chaos tool");
  });

  it("registers all four chaos capabilities", () => {
    registerEvalChaosCapabilities();
    const ids = CapabilityRegistry.listCapabilities().map((cap) => cap.id);
    for (const id of EVAL_CHAOS_IDS) {
      expect(ids).toContain(id);
    }
  });
});
