/**
 * Selection, learning gates and run status (documentation ch.13 §6 Phase 1 items 1, 2, 5, 7 and
 * the finals-only pool). Each test names the audit repro check it turns into NOT REPRODUCED.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materialize, validateTree, type Tree } from "../HarnessTree.ts";
import { runHarness2, selectionSeed, type Harness2Request } from "../Harness2Service.ts";
import type { Executor, Proposer } from "../Recursion.ts";

const BASE: Tree = { "systemprompt.md": "You are a careful analyst.\n" };
const SKILL = `---\nname: totals\ndescription: checks totals\n---\nAdd the rows, compare to the total.\n`;
const EDIT = `<file path="systemprompt.md">You are a careful analyst. When totals appear, use the \`totals\` skill.</file>
<file path="skills/totals/SKILL.md">${SKILL}</file>
<notes>base rollout 1 reported 41 against rows summing to 42</notes>`;
const LESSON = `<edits>component: skills/totals/SKILL.md\nverdict: helped</edits>
<experience>
cue: a deliverable reports a total over listed rows
lesson: add a totals skill triggered from systemprompt.md
evidence: agg1 rollout reported 42 vs base 41
confidence: medium, one rollout each
</experience>`;

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "harness2-sel-"));
  tmpDirs.push(d);
  return d;
};

const execute: Executor = async (tree) => {
  const output = materialize(tree).includes("Add the rows") ? "total: 42 (checked)" : "total: 41";
  return { ok: true, delivered: true, output, trajectory: `final output:\n${output}`, error: "" };
};
const req = (over: Partial<Harness2Request> = {}): Harness2Request => ({
  taskId: "t1",
  task: "Sum the rows.",
  domain: "finance",
  baseTree: BASE,
  solver: { provider: "x", model: "y" },
  k: 1,
  libraryRoot: tmp(),
  ...over,
});
/** Records every proposer call; `select` and `experience` answers are configurable. */
const recorder = (answers: { select?: string; experience?: string; stage?: string } = {}) => {
  const calls: string[] = [];
  const propose: Proposer = async (_prompt, label) => {
    calls.push(label);
    if (label === "select") return answers.select ?? "<why>ok</why>\n```choice\na1\n```";
    if (label === "experience") return answers.experience ?? LESSON;
    return answers.stage ?? (label.startsWith("dom") || label.startsWith("agg") ? EDIT : "<notes>KEEP_BASE</notes>");
  };
  return { calls, propose };
};

describe("selection pool (Q1 default: finals only, upstream)", () => {
  it("k=1 delivers the single final with no selector call [R17]", async () => {
    const { calls, propose } = recorder();
    const r = await runHarness2(req(), { execute, propose });
    expect(calls).not.toContain("select");
    expect(r.selection).toMatchObject({ ok: true, trivial: true, pool: "finals", chosenLabel: "agg1", ids: { a1: "agg1" } });
    expect(r.output).toBe("total: 42 (checked)");
    expect(r.status).toBe("ok");
  });

  it("the mixed pool is opt-in: base rollouts compete and the selector runs at k=1", async () => {
    const { calls, propose } = recorder();
    const r = await runHarness2(req({ selectionPool: "mixed" }), { execute, propose });
    expect(calls).toContain("select");
    expect(Object.values(r.selection.ids).sort()).toEqual(["agg1", "base1"]);
  });

  it("k=2 finals-only pool holds the finals and never a base rollout", async () => {
    let selectPrompt = "";
    const propose: Proposer = async (p, label) => {
      if (label === "select") return (selectPrompt = p), "<why>ok</why>\n```choice\na2\n```";
      return label === "experience" ? "NO_ENTRY" : EDIT;
    };
    const r = await runHarness2(req({ k: 2 }), { execute, propose });
    expect(Object.values(r.selection.ids).sort()).toEqual(["agg1", "agg2"]);
    expect(selectPrompt).toMatch(/No\s+candidate is privileged/);
    expect(selectPrompt).not.toMatch(/UNMODIFIED\s+harness/);
  });
});

describe("selector candidates share the mission budget", () => {
  it("8 long candidates are each cut to budget / n, with upstream's truncation-marker sentence [R19]", async () => {
    let selectPrompt = "";
    const long: Executor = async () => ({ ok: true, delivered: true, output: "row\n".repeat(12_500), trajectory: "final output: (long)", error: "" });
    const propose: Proposer = async (p, label) => {
      if (label === "select") return (selectPrompt = p), "<why>ok</why>\n```choice\na1\n```";
      return label === "experience" ? "NO_ENTRY" : "<notes>KEEP_BASE</notes>";
    };
    await runHarness2(req({ k: 4, selectionPool: "mixed" }), { execute: long, propose, missionCharBudget: 240_000 });
    expect(selectPrompt.match(/^## a\d+$/gm)).toHaveLength(8);
    expect(selectPrompt.length).toBeLessThan(240_000 + 8_000);
    expect(selectPrompt).toMatch(/…\[truncated 20000 chars\]/);
    expect(selectPrompt).toMatch(/renderer-truncation marker\s+inserted for this comparison is not a defect/);
  });
});

describe("per-task selection seed [R1]", () => {
  it("is sha1(task|k|mode)-derived: stable for a task, different across tasks", () => {
    expect(selectionSeed("t1", 1, "agg")).toBe(selectionSeed("t1", 1, "agg"));
    expect(selectionSeed("t1", 1, "agg")).not.toBe(selectionSeed("t2", 1, "agg"));
    expect(selectionSeed("t1", 1, "agg")).not.toBe(selectionSeed("t1", 1, "seq"));
    expect(selectionSeed("t1", 1, "agg", 7)).not.toBe(selectionSeed("t1", 1, "agg"));
  });

  it("a selector that always answers a1 does not always land on the same harness", async () => {
    const picks = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const { propose } = recorder({ experience: "NO_ENTRY" });
      const r = await runHarness2(req({ taskId: `task-${i}`, selectionPool: "mixed" }), { execute, propose });
      picks.add(r.selection.chosenLabel);
    }
    expect([...picks].sort()).toEqual(["agg1", "base1"]);
  });
});

describe("learning is gated on a successful selection [R4, R5]", () => {
  it("nothing delivered: status no-output, no reflection, no library entry [R4]", async () => {
    const { calls, propose } = recorder();
    const r = await runHarness2(req(), {
      execute: async () => ({ ok: true, delivered: false, output: "", trajectory: "final output:\n(empty)", error: "" }),
      propose,
    });
    expect(r.status).toBe("no-output");
    expect(r.selection.ok).toBe(false);
    expect(calls).not.toContain("experience");
    expect(r.libraryEntry).toBeNull();
    expect(r.learned).toBe(false);
  });

  it.each([
    ["finals", "agg1"],
    ["mixed", "base1"],
  ] as const)("selector failure (%s pool): a neutral fallback is delivered but never learned from [R5]", async (pool, expected) => {
    const { calls, propose } = recorder({ select: "I could not decide." });
    const r = await runHarness2(req({ k: 2, selectionPool: pool }), { execute, propose });
    expect(r.status).toBe("selection-fallback");
    expect(r.selection).toMatchObject({ ok: false, fallback: true, chosenLabel: expected });
    expect(r.output).not.toBe("");
    expect(calls).not.toContain("experience");
    expect(r.libraryEntry).toBeNull();
    expect(r.errors.join(" ")).toMatch(/selector returned no valid id/);
  });

  it("a successful selection reflects and stores one entry", async () => {
    const root = tmp();
    const { calls, propose } = recorder();
    const r = await runHarness2(req({ libraryRoot: root }), { execute, propose });
    expect(calls).toContain("experience");
    expect(r.learned).toBe(true);
    expect(fs.existsSync(path.join(root, "finance", "harnesses", "t1", "EXPERIENCE.md"))).toBe(true);
    expect(r.chosenTreeIsBase).toBe(false);
  });
});

describe("run status", () => {
  it("every base rollout failed: base-failed with zero improver calls [R12]", async () => {
    const { calls, propose } = recorder();
    const r = await runHarness2(req({ k: 2 }), {
      execute: async () => {
        throw new Error("solver provider down");
      },
      propose,
    });
    expect(r.status).toBe("base-failed");
    expect(calls).toEqual([]);
    expect(r.result.ledger).toEqual(["base1", "base2"]);
    expect(r.errors[0]).toMatch(/solver provider down/);
  });

  it("every stage fell back on a proposer failure: improver-failed, nothing learned", async () => {
    const calls: string[] = [];
    const propose: Proposer = async (_p, label) => {
      calls.push(label);
      throw new Error("model GLM-5.3-Flash-EXL3-TF does not exist");
    };
    const r = await runHarness2(req(), { execute, propose, transportBackoffMs: 0 });
    expect(r.status).toBe("improver-failed");
    expect(r.learned).toBe(false);
    expect(calls).not.toContain("experience");
    expect(r.errors[0]).toMatch(/every stage fell back on a proposer failure/);
    expect(r.chosenTreeIsBase).toBe(true);
  });

  it("KEEP_BASE everywhere adopts a tree identical to the base", async () => {
    const { propose } = recorder({ stage: "<notes>KEEP_BASE</notes>", experience: "NO_ENTRY" });
    const r = await runHarness2(req(), { execute, propose });
    expect(r.status).toBe("ok");
    expect(r.chosenTreeIsBase).toBe(true);
  });
});

describe("grader-verdict tripwire uses upstream's machine markers [R7]", () => {
  it("ordinary finance wording passes; a machine marker is rejected", () => {
    expect(() => validateTree({ "systemprompt.md": "Treat any bond graded as BBB- or better as investment grade.\n" })).not.toThrow();
    expect(() => validateTree({ "systemprompt.md": "summary: deterministic_eval_summary\n" })).toThrow(/grader-verdict marker/);
  });

  it("a lesson that trips the tripwire is reported, never thrown out of the run", async () => {
    const tripped = LESSON.replace("lesson: add a totals skill", 'lesson: copy {"pass_rate": 1} into memory.md and add a totals skill');
    const { propose } = recorder({ experience: tripped });
    const r = await runHarness2(req(), { execute, propose });
    expect(r.status).toBe("ok");
    expect(r.learned).toBe(false);
    expect(r.errors.join(" ")).toMatch(/library entry not stored: .*grader-verdict marker/);
  });
});
