import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GoalStore, InvalidGoalIdError, type Goal } from "../../../src/platform/goals/GoalStore.ts";
import { evaluateGoal } from "../../../src/platform/goals/GoalGate.ts";
import type { VerifierResult } from "../../../src/platform/verify/DeterministicVerifiers.ts";

const dir = mkdtempSync(join(tmpdir(), "goal-store-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeStore(): GoalStore {
  return new GoalStore({ goalsDir: join(dir, `goals-${Math.random().toString(36).slice(2)}`) });
}

function passed(name: string, evidence: string[]): VerifierResult {
  return { passed: true, verifier_name: name, evidence_refs: evidence };
}

function failed(name: string): VerifierResult {
  return { passed: false, verifier_name: name, evidence_refs: [], reason: "no evidence" };
}

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    goal_id: "g1",
    conversation_id: "c1",
    text: "add login tests",
    criteria: ["login"],
    status: "active",
    budget: { spent: 0, cap: 0 },
    created_at: "2026-10-08T00:00:00.000Z",
    updated_at: "2026-10-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("GoalStore", () => {
  let store: GoalStore;

  beforeEach(() => {
    store = makeStore();
  });

  it("round-trips a goal through create/get/listByConversation", async () => {
    const created = await store.create({
      conversation_id: "conv-1",
      text: "ship the feature",
      criteria: ["tests", "lint"],
      budget: { cap: 5 },
    });
    expect(created.status).toBe("active");
    expect(created.budget).toEqual({ spent: 0, cap: 5 });
    expect(created.goal_id).toBeTruthy();

    expect(await store.get(created.goal_id)).toEqual(created);
    expect(await store.get("missing")).toBeNull();

    const listed = await store.listByConversation("conv-1");
    expect(listed).toHaveLength(1);
    expect(listed[0].text).toBe("ship the feature");
    expect(await store.listByConversation("conv-other")).toEqual([]);
  });

  it("persists across store instances and writes atomically (no temp files left)", async () => {
    const goalsDir = join(dir, `goals-${Math.random().toString(36).slice(2)}`);
    const first = new GoalStore({ goalsDir });
    const created = await first.create({ conversation_id: "conv-2", text: "persist me" });

    const reopened = new GoalStore({ goalsDir });
    expect(await reopened.get(created.goal_id)).toEqual(created);

    // On-disk JSON matches, and the temp+rename write left no debris.
    const raw = JSON.parse(readFileSync(join(goalsDir, "goals.json"), "utf8"));
    expect(raw).toHaveLength(1);
    expect(raw[0].text).toBe("persist me");
    expect(readdirSync(goalsDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(join(goalsDir, "goals.json"))).toBe(true);
  });

  it("handles an empty/corrupt store file gracefully", async () => {
    const goalsDir = join(dir, `goals-${Math.random().toString(36).slice(2)}`);
    const store = new GoalStore({ goalsDir });
    expect(await store.listByConversation("c")).toEqual([]);
  });

  it("rejects unsafe conversation ids", async () => {
    await expect(store.create({ conversation_id: "../escape", text: "x" })).rejects.toThrow(
      InvalidGoalIdError,
    );
    await expect(store.listByConversation("a/b")).rejects.toThrow(InvalidGoalIdError);
  });

  it("throws on update of a missing goal", async () => {
    await expect(store.updateStatus("nope", "achieved")).rejects.toThrow("not found");
    await expect(store.addBudgetSpend("nope", 1)).rejects.toThrow("not found");
  });
});

describe("GoalStore status transitions", () => {
  let store: GoalStore;
  let goalId: string;

  beforeEach(async () => {
    store = makeStore();
    goalId = (
      await store.create({ conversation_id: "c", text: "t" })
    ).goal_id;
  });

  it("active -> paused -> active -> achieved", async () => {
    expect((await store.updateStatus(goalId, "paused")).status).toBe("paused");
    expect((await store.updateStatus(goalId, "active")).status).toBe("active");
    const achieved = await store.achieve(goalId);
    expect(achieved.status).toBe("achieved");
    expect(achieved.updated_at >= achieved.created_at).toBe(true);
  });

  it("abandon records abandoned status", async () => {
    expect((await store.abandon(goalId)).status).toBe("abandoned");
  });

  it("accumulates budget spend", async () => {
    await store.addBudgetSpend(goalId, 1.5);
    const after = await store.addBudgetSpend(goalId, 2);
    expect(after.budget.spent).toBe(3.5);
  });

  it("rejects negative spend", async () => {
    await expect(store.addBudgetSpend(goalId, -1)).rejects.toThrow("non-negative");
  });
});

describe("evaluateGoal verdict matrix", () => {
  it("budget_exhausted takes precedence and emits a stop directive", () => {
    const outcome = evaluateGoal(goal({ budget: { spent: 5, cap: 5 } }), {
      verifierResults: [passed("tests", ["login ok"])],
      toolEvents: [],
    });
    expect(outcome.verdict).toBe("budget_exhausted");
    expect(outcome.directive).toContain("exhausted");
  });

  it("achieved only when verifiers pass AND criteria met", () => {
    const input = {
      verifierResults: [passed("vitest", ["login tests passed"])],
      toolEvents: [],
    };
    expect(evaluateGoal(goal({ criteria: ["login"] }), input).verdict).toBe("achieved");
    // passing verifier but unmet criterion
    expect(evaluateGoal(goal({ criteria: ["login", "teardown"] }), input).verdict).toBe(
      "off_track",
    );
    // criteria met but a verifier failed
    expect(
      evaluateGoal(goal({ criteria: ["login"] }), {
        verifierResults: [passed("vitest", ["login ok"]), failed("lint")],
        toolEvents: [],
      }).verdict,
    ).toBe("off_track");
  });

  it("matches criteria case-insensitively across evidence and tool observations", () => {
    const outcome = evaluateGoal(goal({ criteria: ["LOGIN"] }), {
      verifierResults: [passed("tests", [])],
      toolEvents: [{ tool: "run_command", success: true, observation: "LOGIN flow verified" }],
    });
    expect(outcome.verdict).toBe("achieved");
  });

  it("off_track on failing verifier emits a corrective directive naming gaps", () => {
    const outcome = evaluateGoal(goal({ criteria: ["login", "audit log"] }), {
      verifierResults: [failed("tests")],
      toolEvents: [],
    });
    expect(outcome.verdict).toBe("off_track");
    expect(outcome.directive).toContain("audit log");
  });

  it("on_track when there is nothing to judge yet", () => {
    expect(
      evaluateGoal(goal({ criteria: [] }), { verifierResults: [], toolEvents: [] }).verdict,
    ).toBe("on_track");
  });
});
