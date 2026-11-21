/**
 * Default pool membership (no `VLLM_SHIM_POOL_MEMBERS` in the environment).
 *
 * Lives in its own file because `POOL_MEMBERS` is built once at module load:
 * the two-member suite sets the env before importing, so this file clears it
 * (vi.hoisted runs before imports) and observes the unified DeepSeek default —
 * `gold-spark,dell2`.
 */
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  delete process.env.VLLM_SHIM_POOL_MEMBERS;
});

import { POOL_MEMBERS, poolStats } from "../vllm/VllmPool.js";

describe("default pool membership", () => {
  it("module-level POOL_MEMBERS holds gold-spark (10.0.0.141) and dell2 (10.0.0.37)", () => {
    expect(POOL_MEMBERS).toHaveLength(2);
    expect(POOL_MEMBERS[0]).toMatchObject({ name: "gold-spark", ip: "10.0.0.141" });
    expect(POOL_MEMBERS[1]).toMatchObject({ name: "dell2", ip: "10.0.0.37" });
  });

  it("poolStats().members mirrors the unified two-box default", () => {
    const stats = poolStats();
    expect(stats.members).toHaveLength(2);
    expect(stats.members[0]).toMatchObject({ name: "gold-spark", ip: "10.0.0.141" });
    expect(stats.members[1]).toMatchObject({ name: "dell2", ip: "10.0.0.37" });
    expect(stats.route).toBe("/vllm-shim/qwen");
  });
});
