import { describe, expect, it } from "vitest";
import { decideApprovalAsk, resolveBudgetAction } from "../../../src/platform/approval/UnattendedPolicy.ts";
import {
  decide,
  get,
  register,
  retireOrphaned,
} from "../../../src/platform/approval/ApprovalRegistry.ts";
import type { UnattendedOptions } from "../../../src/platform/approval/UnattendedPolicy.ts";

const opts = (over: Partial<UnattendedOptions> = {}): UnattendedOptions => ({
  unattended: false,
  ...over,
});

describe("resolveBudgetAction", () => {
  it.each([
    ["explicit stop wins over unattended", { unattended: true }, "stop", "stop"],
    ["explicit pause wins over unattended", { unattended: true }, "pause", "pause"],
    ["unattended defaults to stop", { unattended: true }, undefined, "stop"],
    ["autoApprove defaults to stop", { unattended: false, autoApprove: true }, undefined, "stop"],
    ["attended defaults to pause", { unattended: false }, undefined, "pause"],
  ])("%s", (_name, o, onBudgetReached, expected) => {
    expect(resolveBudgetAction(opts(o), { onBudgetReached })).toBe(expected);
  });
});

describe("decideApprovalAsk", () => {
  it("denies unattended asks with a model-readable message naming the tool", () => {
    const d = decideApprovalAsk(opts({ unattended: true }), { tool: "scrape_url" });
    expect(d.kind).toBe("deny");
    expect(d.message).toContain("scrape_url");
    expect(d.message).toContain("Unattended run");
  });

  it("approves when autoApprove", () => {
    expect(decideApprovalAsk(opts({ unattended: true, autoApprove: true }), { tool: "t" }).kind).toBe("approve");
    expect(decideApprovalAsk(opts({ autoApprove: true }), { tool: "t" }).kind).toBe("approve");
  });

  it("defers for an attended run", () => {
    expect(decideApprovalAsk(opts(), { tool: "t" })).toEqual({ kind: "defer", message: "" });
  });
});

describe("ApprovalRegistry", () => {
  it("resolves register() on approve and refuses to re-decide a settled ask", async () => {
    const waiter = register("ask-1", { runId: "run-1", tool: "scrape_url" });
    expect(get("ask-1")?.status).toBe("pending");
    expect(decide("ask-1", "approved")?.status).toBe("approved");
    await expect(waiter).resolves.toMatchObject({ status: "approved" });
    expect(decide("ask-1", "denied")).toBeUndefined();
    expect(get("ask-1")?.status).toBe("approved");
  });

  it("resolves register() on deny", async () => {
    const waiter = register("ask-2", { runId: "run-2", tool: "whiteboard_annotate" });
    decide("ask-2", "denied", "policy");
    await expect(waiter).resolves.toMatchObject({ status: "denied", decidedBy: "policy" });
  });

  it("times out a pending ask so it never hangs", async () => {
    const waiter = register("ask-3", { runId: "run-3", tool: "t" }, 10);
    await expect(waiter).resolves.toMatchObject({ status: "timeout" });
  });

  it("retires orphaned pending asks of a dead run and resolves their waiters", async () => {
    const waiter = register("ask-4", { runId: "run-4", tool: "t" });
    register("ask-5", { runId: "run-9", tool: "t" });
    const retired = retireOrphaned("run-4");
    expect(retired.map(r => r.status)).toEqual(["retired"]);
    await expect(waiter).resolves.toMatchObject({ status: "retired" });
    expect(get("ask-5")?.status).toBe("pending");
    // Re-retiring is a no-op for already-settled asks.
    expect(retireOrphaned("run-4")).toEqual([]);
  });
});
