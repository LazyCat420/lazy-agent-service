/**
 * Default pool membership (no `VLLM_SHIM_POOL_MEMBERS` in the environment).
 *
 * Lives in its own file because `POOL_MEMBERS` is built once at module load:
 * the two-member suite sets the env to `dell2,dell1` before importing, so this
 * file clears it (vi.hoisted runs before imports) and observes the TP=2
 * default — `dell2` alone.
 */
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  delete process.env.VLLM_SHIM_POOL_MEMBERS;
});

import { POOL_MEMBERS, poolStats } from "../vllm/VllmPool.js";

describe("default pool membership", () => {
  it("module-level POOL_MEMBERS holds only dell2 at 10.0.0.37", () => {
    expect(POOL_MEMBERS).toHaveLength(1);
    expect(POOL_MEMBERS[0]).toMatchObject({ name: "dell2", ip: "10.0.0.37" });
  });

  it("poolStats().members mirrors the single default member", () => {
    const stats = poolStats();
    expect(stats.members).toHaveLength(1);
    expect(stats.members[0]).toMatchObject({ name: "dell2", ip: "10.0.0.37" });
    expect(stats.route).toBe("/vllm-shim/qwen");
  });
});
