/**
 * Library hygiene and the reflection input (documentation ch.13 §6 Phase 1 items 4 and 6). Each
 * test names the audit repro check it covers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materialize, renderTree, type Tree } from "../HarnessTree.ts";
import { Library, slug } from "../Library.ts";
import { runHarness2, type Harness2Request } from "../Harness2Service.ts";
import * as prompts from "../Prompts.ts";
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
const EXP = { cue: "c", lesson: "l", evidence: "e" };

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "harness2-lib-"));
  tmpDirs.push(d);
  return d;
};
const execute: Executor = async (tree) => {
  const output = materialize(tree).includes("Add the rows") ? "total: 42 (checked)" : "total: 41";
  return { ok: true, delivered: true, output, trajectory: `final output:\n${output}`, error: "" };
};
const req = (root: string, over: Partial<Harness2Request> = {}): Harness2Request => ({
  taskId: "t1",
  task: "Sum the rows.",
  domain: "finance",
  baseTree: BASE,
  solver: { provider: "x", model: "y" },
  k: 1,
  libraryRoot: root,
  ...over,
});
const learner: Proposer = async (_p, label) =>
  label === "select" ? "<why>a2 reconciles the total; a1 missed a row</why>\n```choice\na2\n```" : label === "experience" ? LESSON : EDIT;

describe("library scope [R6]", () => {
  it("a re-run task never reads its own entry, in the index or the blocks; another task does", async () => {
    const root = tmp();
    await runHarness2(req(root, { taskId: "t-rerun" }), { execute, propose: learner });
    const seen: Record<string, string> = {};
    const spy: Proposer = async (p, label) => ((seen[label] = p), "<notes>KEEP_BASE</notes>");
    await runHarness2(req(root, { taskId: "t-rerun" }), { execute, propose: spy });
    expect(seen["inv1.a1"]).not.toContain("## Entry t-rerun");
    expect(seen["inv1.a1"]).not.toContain("harnesses/t-rerun/");
    expect(seen["inv1.a1"]).not.toContain("# LIBRARY");
    await runHarness2(req(root, { taskId: "t-next" }), { execute, propose: spy });
    expect(seen["inv1.a1"]).toContain("## Entry t-rerun");
    expect(seen["inv1.a1"]).toContain("add a totals skill triggered from systemprompt.md");
  });
});

describe("library retention", () => {
  it("evicts the OLDEST entry by stored time, not by name [R9]", async () => {
    const lib = new Library("evict", tmp());
    const big = (c: string) => ({ "systemprompt.md": `${c.repeat(40_000)}\n` });
    lib.add("zeta-older", big("z"), { label: "agg1", experience: EXP });
    await new Promise((resolve) => setTimeout(resolve, 15));
    lib.add("alpha-newer", big("a"), { label: "agg1", experience: EXP });
    expect(lib.entriesByAge()).toEqual(["zeta-older", "alpha-newer"]);
    const ctx = lib.contextText();
    expect(ctx).toContain("## Entry alpha-newer");
    expect(ctx).not.toContain("## Entry zeta-older");
    expect(ctx).toMatch(/1 older entry was left out to fit the context cap/);
  });

  it("stamps each entry with its stored time", () => {
    const lib = new Library("stamp", tmp());
    const d = lib.add("t1", BASE, { label: "agg1", experience: EXP })!;
    expect(fs.readFileSync(path.join(d, "EXPERIENCE.md"), "utf8")).toMatch(/^- stored: \d{4}-\d{2}-\d{2}T[\d:.]+Z$/m);
  });

  it("forget() removes an entry and its index row", () => {
    const lib = new Library("forget", tmp());
    lib.add("keep", BASE, { experience: { ...EXP, cue: "keep-cue" } });
    lib.add("drop", BASE, { experience: { ...EXP, cue: "drop-cue" } });
    expect(lib.forget(["drop", "never-existed"])).toEqual(["drop"]);
    expect(lib.entries()).toEqual(["keep"]);
    const index = fs.readFileSync(lib.index, "utf8");
    expect(index).toContain("keep-cue");
    expect(index).not.toContain("drop-cue");
  });
});

describe("library paths [R10]", () => {
  it.each(["..", ".", ".hidden", "../x", "..\\x"])("%s stays inside the root", (name) => {
    const root = tmp();
    const lib = new Library(name, root);
    expect(path.relative(root, lib.dir).startsWith("..")).toBe(false);
    expect(path.dirname(lib.dir)).toBe(root);
    expect(path.dirname(new Library("x", root).entryDir(name))).toBe(path.join(root, "x", "harnesses"));
    expect(slug(name).startsWith(".")).toBe(false);
  });
});

describe("per-run and per-mode library scope (TCK-1020)", () => {
  it("without a scope the library is the one domain directory, as before", () => {
    const root = tmp();
    expect(new Library("finance", root).dir).toBe(path.join(root, "finance"));
    expect(new Library("finance", root, {}).dir).toBe(path.join(root, "finance"));
  });

  it("mode and run scopes nest under the domain and never see each other's entries", () => {
    const root = tmp();
    const shared = new Library("finance", root);
    const seq = new Library("finance", root, { mode: "sequential" });
    const run = Library.forRun("finance", { root, mode: "parallel", runId: "run-1" });
    const runOnly = new Library("finance", root, { runScope: "../run-2" });
    expect(seq.dir).toBe(path.join(root, "finance", "sequential"));
    expect(run.dir).toBe(path.join(root, "finance", "parallel", "run-1"));
    expect(path.relative(path.join(root, "finance"), runOnly.dir).startsWith("..")).toBe(false);

    shared.add("t-shared", BASE, { experience: { ...EXP, cue: "shared-cue" } });
    seq.add("t-seq", BASE, { experience: { ...EXP, cue: "seq-cue" } });
    run.add("t-run", BASE, { experience: { ...EXP, cue: "run-cue" } });

    expect(shared.entries()).toEqual(["t-shared"]);
    expect(seq.entries()).toEqual(["t-seq"]);
    expect(run.entries()).toEqual(["t-run"]);
    expect(runOnly.entries()).toEqual([]);
    expect(shared.contextText()).not.toContain("seq-cue");
    expect(seq.contextText()).not.toContain("shared-cue");
    expect(run.contextText()).not.toContain("seq-cue");
    // A scoped library's entries carry its scope as metadata.
    const text = fs.readFileSync(path.join(run.entryDir("t-run"), "EXPERIENCE.md"), "utf8");
    expect(text).toMatch(/^- mode: parallel$/m);
    expect(text).toMatch(/^- run: run-1$/m);
  });

  it("a scope that would collide with the domain's own directories is refused", () => {
    expect(() => new Library("finance", tmp(), { mode: "harnesses" })).toThrow(/collides/);
    expect(() => Library.forRun("finance", { root: tmp(), runId: "runs" })).toThrow(/collides/);
  });

  it("contextText filters one library by recorded mode and run", () => {
    const lib = new Library("mixed", tmp());
    lib.add("a", BASE, { experience: { ...EXP, cue: "par-r1" }, mode: "parallel", runId: "r1" });
    lib.add("b", BASE, { experience: { ...EXP, cue: "seq-r1" }, mode: "sequential", runId: "r1" });
    lib.add("c", BASE, { experience: { ...EXP, cue: "par-r2" }, mode: "parallel", runId: "r2" });
    lib.add("d", BASE, { experience: { ...EXP, cue: "untagged" } });

    const all = lib.contextText();
    for (const cue of ["par-r1", "seq-r1", "par-r2", "untagged"]) expect(all).toContain(cue);

    const par = lib.contextText({ mode: "parallel" });
    expect(par).toContain("par-r1");
    expect(par).toContain("par-r2");
    expect(par).not.toContain("seq-r1");
    expect(par).not.toContain("untagged");

    const r1 = lib.contextText({ runId: "r1" });
    expect(r1).toContain("par-r1");
    expect(r1).toContain("seq-r1");
    expect(r1).not.toContain("par-r2");

    const both = lib.contextText({ mode: "sequential", runId: "r1" });
    expect(both).toContain("seq-r1");
    expect(both).not.toContain("par-r1");
    expect(lib.contextText({ mode: "sequential", runId: "r2" })).toBe("");
  });

  it("runHarness2 with isolateLibrary + libraryScope learns into its own library only", async () => {
    const root = tmp();
    await runHarness2(req(root, { taskId: "t-iso", isolateLibrary: true, libraryScope: "run-a" }), {
      execute,
      propose: learner,
    });
    expect(new Library("finance", root).entries()).toEqual([]);
    const isolated = Library.forRun("finance", { root, mode: "parallel", runId: "run-a" });
    expect(isolated.entries()).toEqual(["t-iso"]);
    expect(fs.readFileSync(path.join(isolated.entryDir("t-iso"), "EXPERIENCE.md"), "utf8")).toMatch(/^- run: run-a$/m);

    // A later run in another scope does not read run-a's lesson; one in the same scope does.
    const seen: Record<string, string> = {};
    const spy: Proposer = async (p, label) => ((seen[label] = p), "<notes>KEEP_BASE</notes>");
    await runHarness2(req(root, { taskId: "t-other", isolateLibrary: true, libraryScope: "run-b" }), { execute, propose: spy });
    expect(seen["inv1.a1"]).not.toContain("## Entry t-iso");
    await runHarness2(req(root, { taskId: "t-same", isolateLibrary: true, libraryScope: "run-a" }), { execute, propose: spy });
    expect(seen["inv1.a1"]).toContain("## Entry t-iso");
  });

  it("the default run still learns into the shared domain library, tagged with its mode", async () => {
    const root = tmp();
    await runHarness2(req(root, { taskId: "t-default" }), { execute, propose: learner });
    const shared = new Library("finance", root);
    expect(shared.entries()).toEqual(["t-default"]);
    expect(fs.readFileSync(path.join(shared.entryDir("t-default"), "EXPERIENCE.md"), "utf8")).toMatch(/^- mode: parallel$/m);
  });
});

describe("reflection input [R18]", () => {
  it("shows the base harness once, diffs every candidate against it, and maps the anonymous ids", async () => {
    let reflection = "";
    const r = await runHarness2(req(tmp(), { selectionPool: "mixed" }), {
      execute,
      propose: async (p, label) => {
        if (label === "experience") return (reflection = p), "NO_ENTRY";
        return learner(p, label);
      },
    });
    const baseRender = renderTree(BASE);
    expect(reflection.split(baseRender).length - 1).toBe(1);
    expect(reflection).toContain(`# BASE HARNESS\n\n${baseRender}`);
    expect(reflection).not.toContain("# CURRENT HARNESS");
    expect(reflection).toMatch(/## candidate agg1\n\nchanged vs base: added \[skills\/totals\/SKILL\.md\] removed \[\] modified \[systemprompt\.md\]/);
    for (const [id, label] of Object.entries(r.selection.ids)) expect(reflection).toContain(`${id} → ${label}`);
    expect(reflection).toContain("a2 reconciles the total");
    expect(reflection).toContain(`- submitted: \`${r.selection.chosenLabel}\``);
  });

  it("a trivial k=1 selection says no selector ran", async () => {
    let reflection = "";
    await runHarness2(req(tmp()), {
      execute,
      propose: async (p, label) => (label === "experience" ? ((reflection = p), "NO_ENTRY") : learner(p, label)),
    });
    expect(reflection).toMatch(/- selection: no selector call \(trivial pool/);
    expect(reflection).not.toContain("anonymous ids the selector saw");
  });
});

describe("prompts restore upstream's guard rails", () => {
  it("proposers must re-verify facts copied from the library", () => {
    expect(prompts.propose({ work: "w" }, "DOM")).toMatch(/RE-VERIFY its facts against\s+the evidence in front of you/);
  });

  it("the reflector is told what an invented attribution costs", () => {
    const text = prompts.experience({ work: "w" });
    expect(text).toMatch(/an invented attribution poisons the library for every\s+later task/);
    expect(text).toMatch(/Adoption alone never establishes that an edit helped or will transfer/);
    expect(text).toMatch(/Treat every candidate as\s+evidence/);
  });
});
