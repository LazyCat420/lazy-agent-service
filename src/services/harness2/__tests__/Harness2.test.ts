import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materialize, validateTree, type Tree } from "../HarnessTree.ts";
import { Library } from "../Library.ts";
import { applyReply, rollBase, runParallel, runSequential, type Executor, type Proposer, type RecursionDeps } from "../Recursion.ts";
import { parseExperience, runHarness2 } from "../Harness2Service.ts";

const BASE: Tree = { "systemprompt.md": "You are a careful analyst.\n" };
const SKILL = (name: string) => `---\nname: ${name}\ndescription: checks totals\n---\nAdd the rows, compare to the total.\n`;

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "harness2-test-"));
  tmpDirs.push(d);
  return d;
};

/** The solver "follows" the harness: output reflects whether the skill reached its prompt. */
const executor: Executor = async (tree) => {
  const sys = materialize(tree);
  const output = sys.includes("Add the rows") ? "total: 42 (checked)" : "total: 41";
  return { ok: true, delivered: true, output, trajectory: `final output:\n${output}`, error: "" };
};

const editReply = `<file path="systemprompt.md">You are a careful analyst. When totals appear, use the \`totals\` skill.</file>
<file path="skills/totals/SKILL.md">${SKILL("totals")}</file>
<notes>base rollout 1 reported 41 against rows summing to 42</notes>`;

describe("harness tree validation (upstream discard rules)", () => {
  it.each([
    ["empty system prompt", { "systemprompt.md": "  " }, /must not be empty/],
    ["template braces", { "systemprompt.md": "Hi {{name}}" }, /template braces/],
    ["skill with no trigger", { ...BASE, "skills/totals/SKILL.md": SKILL("totals") }, /no trigger line/],
    ["skill name mismatch", { "systemprompt.md": "use totals", "skills/totals/SKILL.md": SKILL("other") }, /name: totals/],
    ["off surface", { ...BASE, "scripts/x.py": "print(1)" }, /off the editable surface/],
    ["grader leak", { "systemprompt.md": "Do what the grader expects." }, /grader verdict/],
  ])("rejects %s", (_name, tree, msg) => {
    expect(() => validateTree(tree as Tree)).toThrow(msg);
  });

  it("accepts a triggered skill and materializes it into the system prompt", () => {
    const { tree, rejected } = applyReply(BASE, editReply);
    expect(rejected).toEqual([]);
    expect(() => validateTree(tree)).not.toThrow();
    expect(materialize(tree)).toContain("## skill: totals");
  });
});

describe("task-level recursion", () => {
  const deps = (propose: Proposer): RecursionDeps => ({ bp: { work: "Sum the rows." }, execute: executor, propose, baseTree: BASE, width: 3 });

  it.each(["parallel", "sequential"] as const)("%s k=2 schedules 4k rollouts and 3k stages", async (mode) => {
    const d = deps(async () => editReply);
    const base = await rollBase(d, 2);
    const r = mode === "parallel" ? await runParallel(2, base, d) : await runSequential(2, base, d);
    expect(r.ledger).toHaveLength(8);
    expect(r.stages).toHaveLength(6);
    expect(r.finals).toEqual(mode === "parallel" ? ["agg1", "agg2"] : ["c1", "c2"]);
    // The edited harness changed behavior in the probe rollouts; the base did not.
    expect(r.rollouts.base1.output).toBe("total: 41");
    expect(r.rollouts[r.finals[0]].output).toBe("total: 42 (checked)");
  });

  it("retries an invalid proposal once with the rejection, then falls back to the current harness", async () => {
    const seen: string[] = [];
    const bad = `<file path="skills/totals/SKILL.md">${SKILL("totals")}</file><notes>x</notes>`;
    const d = deps(async (prompt) => (seen.push(prompt), bad));
    const r = await runParallel(1, await rollBase(d, 1), d);
    const inv = r.stages.find((s) => s.label === "inv1")!;
    expect(inv.fellBack).toBe(true);
    expect(inv.attempts).toBe(2);
    expect(inv.tree).toEqual(BASE);
    expect(inv.error).toMatch(/no trigger line/);
    expect(seen.some((p) => p.includes("YOUR PREVIOUS ATTEMPT WAS REJECTED") && p.includes("no trigger line"))).toBe(true);
  });

  it("KEEP_BASE reply keeps the tree unchanged and is not a fallback", async () => {
    const d = deps(async () => "<notes>KEEP_BASE</notes>");
    const r = await runParallel(1, await rollBase(d, 1), d);
    expect(r.stages.every((s) => s.keptBase && !s.fellBack)).toBe(true);
  });

  it("composer sees every candidate's tree and rollout", async () => {
    let aggPrompt = "";
    const d = deps(async (prompt, label) => {
      if (label.startsWith("agg")) aggPrompt = prompt;
      return label.startsWith("dom") ? editReply : "<notes>KEEP_BASE</notes>";
    });
    await runParallel(1, await rollBase(d, 1), d);
    expect(aggPrompt).toContain("## candidate inv1");
    expect(aggPrompt).toContain("## candidate dom1");
    expect(aggPrompt).toContain("total: 42 (checked)");
  });
});

describe("harnessing-level recursion (library)", () => {
  it("refuses an entry without cue/lesson/evidence and writes nothing", () => {
    const lib = new Library("finance", tmp());
    expect(lib.add("t1", BASE, { experience: { cue: "x", lesson: "", evidence: "y" } })).toBeNull();
    expect(lib.entries()).toEqual([]);
    expect(lib.contextText()).toBe("");
  });

  it("parses NO_ENTRY as no library entry", () => {
    expect(parseExperience("<edits>component: x</edits>\nNO_ENTRY").entry).toBeNull();
  });

  it("an adopted harness + lesson from task 1 reaches every proposer of task 2 in the same domain only", async () => {
    const root = tmp();
    const reflection = `<edits>component: skills/totals/SKILL.md\nverdict: helped</edits>
<experience>
cue: a deliverable reports a total over listed rows
lesson: add a totals skill triggered from systemprompt.md
evidence: inv1/dom1 rollouts reported 42 vs base 41
confidence: medium, one rollout each
</experience>`;
    const propose1: Proposer = async (p, label) =>
      label === "select"
        ? `<why>matches rows</why>\n\`\`\`choice\n${/## (a\d+)\n\ntotal: 42/.exec(p)![1]}\n\`\`\``
        : label === "experience"
          ? reflection
          : editReply;
    const req = { taskId: "t1", task: "Sum the rows.", domain: "finance", baseTree: BASE, solver: { provider: "x", model: "y" }, k: 1, libraryRoot: root };
    const r1 = await runHarness2(req, { execute: executor, propose: propose1 });
    expect(r1.libraryEntry).not.toBeNull();
    expect(fs.readFileSync(path.join(r1.libraryEntry!, "harness", "skills", "totals", "SKILL.md"), "utf8")).toContain("Add the rows");
    expect(fs.readFileSync(path.join(root, "finance", "INDEX.md"), "utf8")).toContain("cue:     a deliverable reports a total");

    const prompts2: Record<string, string> = {};
    const propose2: Proposer = async (p, label) => ((prompts2[label] = p), "<notes>KEEP_BASE</notes>");
    await runHarness2({ ...req, taskId: "t2" }, { execute: executor, propose: propose2 });
    for (const label of ["inv1.a1", "dom1.a1", "agg1.a1"]) {
      expect(prompts2[label]).toContain("add a totals skill triggered from systemprompt.md");
    }

    const prompts3: Record<string, string> = {};
    await runHarness2({ ...req, taskId: "t3", domain: "legal" }, { execute: executor, propose: async (p, l) => ((prompts3[l] = p), "<notes>KEEP_BASE</notes>") });
    expect(prompts3["inv1.a1"]).not.toContain("LIBRARY");
  });
});
