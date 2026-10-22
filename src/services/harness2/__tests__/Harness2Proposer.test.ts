/**
 * Proposer contract, stage retries, validation and evidence size (documentation ch.13 §6 Phase 1
 * item 3, the Q2 cap and the mission budget). Each test names the audit repro check it covers.
 */
import { describe, expect, it } from "vitest";
import { autotrigger, collectTreeErrors, diversity, materialize, validateTree, type Tree } from "../HarnessTree.ts";
import { makeProposer } from "../Harness2Service.ts";
import * as prompts from "../Prompts.ts";
import { ProposerError, rollBase, runParallel, runStage, type Executor, type Proposer, type RecursionDeps } from "../Recursion.ts";

const BASE: Tree = { "systemprompt.md": "You are a careful analyst.\n" };
const SKILL = (name: string, description = "checks totals") => `---\nname: ${name}\ndescription: ${description}\n---\nAdd the rows, compare to the total.\n`;
const EDIT = `<file path="systemprompt.md">You are a careful analyst. When totals appear, use the \`totals\` skill.</file>
<file path="skills/totals/SKILL.md">${SKILL("totals")}</file>
<notes>base rollout 1 reported 41 against rows summing to 42</notes>`;

const execute: Executor = async (tree) => {
  const output = materialize(tree).includes("Add the rows") ? "total: 42 (checked)" : "total: 41";
  return { ok: true, delivered: true, output, trajectory: `final output:\n${output}`, error: "" };
};
const deps = (propose: Proposer, over: Partial<RecursionDeps> = {}): RecursionDeps => ({
  bp: { work: "Sum the rows." },
  execute,
  propose,
  baseTree: BASE,
  width: 2,
  transportBackoffMs: 0,
  ...over,
});
const stage = (propose: Proposer, over: Partial<RecursionDeps> = {}) =>
  runStage({ label: "dom1", dim: "DOM", job: "job", fallback: BASE, base: [], deps: deps(propose, over) });

describe("a reply that never arrived is a failure, never KEEP_BASE", () => {
  it("an empty reply gets a second transport attempt, then the stage falls back with the cause [R2]", async () => {
    const calls: string[] = [];
    const st = await stage(async (_p, label) => (calls.push(label), ""));
    expect(calls).toEqual(["dom1.a1", "dom1.a1"]);
    expect(st).toMatchObject({ fellBack: true, keptBase: false });
    expect(st.error).toMatch(/^proposer failed: empty reply \(after 2 transport attempts\)/);
  });

  it("a whole mode of empty replies records every stage as a proposer failure [R2]", async () => {
    const d = deps(async () => "   ");
    const r = await runParallel(1, await rollBase(d, 1), d);
    expect(r.stages.every((s) => s.fellBack && !s.keptBase && s.error.startsWith("proposer failed"))).toBe(true);
  });

  it("one transport error is retried and the second reply is used [R13]", async () => {
    let calls = 0;
    const st = await stage(async () => {
      if (++calls === 1) throw new Error("ECONNRESET");
      return EDIT;
    });
    expect(calls).toBe(2);
    expect(st.fellBack).toBe(false);
    expect(Object.keys(st.tree)).toContain("skills/totals/SKILL.md");
  });

  it("a non-retryable failure (a deadline) is not sent a second time", async () => {
    let calls = 0;
    const st = await stage(async () => {
      calls++;
      throw new ProposerError("no reply within 1200 s", false);
    });
    expect(calls).toBe(1);
    expect(st.error).toMatch(/no reply within 1200 s \(after 1 transport attempt\)/);
  });

  it("transport attempts wait backoff × (attempt − 1)", async () => {
    const at: number[] = [];
    await stage(async () => (at.push(Date.now()), ""), { transportBackoffMs: 120 });
    expect(at).toHaveLength(2);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(100);
  });
});

describe("makeProposer reads the provider result honestly", () => {
  const provider = (res: { text: string; usage: { inputTokens: number; outputTokens: number } } | Promise<never>) => ({
    generateText: async () => res as never,
  });
  const model = { provider: "vllm-2", model: "m" };

  it.each([
    ["empty text", { text: "  ", usage: { inputTokens: 10, outputTokens: 0 } }, /empty reply/],
    ["all-zero usage", { text: "<notes>KEEP_BASE</notes>", usage: { inputTokens: 0, outputTokens: 0 } }, /zero token usage/],
  ])("%s throws a retryable ProposerError", async (_name, res, msg) => {
    const propose = makeProposer(model, { providerOf: () => provider(res) });
    const error = await propose("p", "inv1.a1").catch((e) => e);
    expect(error).toBeInstanceOf(ProposerError);
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(msg);
  });

  it("a deadline throws a non-retryable ProposerError", async () => {
    const propose = makeProposer(model, { timeoutMs: 20, providerOf: () => provider(new Promise<never>(() => {})) });
    const error = await propose("p", "inv1.a1").catch((e) => e);
    expect(error).toBeInstanceOf(ProposerError);
    expect(error.retryable).toBe(false);
  });

  it("a real reply passes through", async () => {
    const propose = makeProposer(model, { providerOf: () => provider({ text: "<notes>KEEP_BASE</notes>", usage: { inputTokens: 9, outputTokens: 4 } }) });
    expect(await propose("p", "inv1.a1")).toBe("<notes>KEEP_BASE</notes>");
  });
});

describe("rejections and retries", () => {
  it("a reply cut off inside a <file> block is rejected, not half-applied [R3]", async () => {
    const half = `<file path="systemprompt.md">You are a careful analyst. When totals appear, use the \`totals\` skill.</file>\n<file path="skills/totals/SKILL.md">---\nname: totals\ndescription: checks to`;
    const prompts2: string[] = [];
    const st = await stage(async (p) => (prompts2.push(p), half));
    expect(st.fellBack).toBe(true);
    expect(st.error).toMatch(/cut off inside the <file path="skills\/totals\/SKILL.md"> block/);
    expect(prompts2[1]).toMatch(/YOUR PREVIOUS ATTEMPT WAS REJECTED/);
  });

  it("the retry shows the rejected harness and notes, and edits that harness [R21]", async () => {
    const first = `<file path="systemprompt.md">Analyst. When totals appear, use the \`totals\` skill. MARK-SYS</file>
<file path="skills/totals/SKILL.md">${SKILL("other")}</file><notes>UNIQUE-MARKER-42</notes>`;
    // The retry fixes only the frontmatter; the systemprompt edit from the first reply must survive.
    const second = `<file path="skills/totals/SKILL.md">${SKILL("totals")}</file><notes>fixed the name</notes>`;
    const seen: string[] = [];
    const st = await stage(async (p) => (seen.push(p), seen.length === 1 ? first : second));
    expect(seen[1]).toContain("UNIQUE-MARKER-42");
    expect(seen[1]).toContain("MARK-SYS");
    expect(seen[1]).toMatch(/frontmatter needs name: totals/);
    expect(st.fellBack).toBe(false);
    expect(st.tree["systemprompt.md"]).toContain("MARK-SYS");
    expect(st.tree["skills/totals/SKILL.md"]).toContain("name: totals");
  });

  it("a missing trigger line is repaired before validation (upstream autotrigger)", async () => {
    const reply = `<file path="skills/totals/SKILL.md">${SKILL("totals", "a table reports a total.")}</file><notes>n</notes>`;
    const st = await stage(async () => reply);
    expect(st).toMatchObject({ fellBack: false, repaired: ["totals"] });
    expect(st.tree["guardrails.md"]).toBe("- When a table reports a total, use the `totals` skill.\n");
  });

  it("autotrigger skips a line that would break the cap", () => {
    const tree: Tree = { "systemprompt.md": "x".repeat(400), "skills/totals/SKILL.md": SKILL("totals") };
    expect(autotrigger(tree, materialize(tree).length + 10)).toEqual([]);
    expect(tree["guardrails.md"]).toBeUndefined();
  });
});

describe("validation", () => {
  it("lists every problem in one message [R8]", () => {
    const errs = collectTreeErrors({ "systemprompt.md": "Hi {{name}}", "skills/abc/SKILL.md": "---\nname: other\n---\nbody\n" });
    expect(errs).toHaveLength(4);
    expect(() => validateTree({ "systemprompt.md": "Hi {{name}}", "skills/abc/SKILL.md": "---\nname: other\n---\nbody\n" })).toThrow(
      /template braces.* \| .*name: abc.* \| .*description.* \| .*no trigger line/,
    );
  });

  it("caps the materialized prompt at 24,000 chars, skills included [R15, Q2]", () => {
    expect(() => validateTree({ "systemprompt.md": "rule\n".repeat(40_000) })).toThrow(/over the 24000 cap/);
    const skillHeavy: Tree = {
      "systemprompt.md": "Analyst. When totals appear, use the `totals` skill.\n",
      "skills/totals/SKILL.md": `---\nname: totals\ndescription: checks totals\n---\n${"step\n".repeat(5_000)}`,
    };
    expect(() => validateTree(skillHeavy)).toThrow(/skills are inlined/);
  });

  it("the proposer is told skills cost the same and count toward the cap", () => {
    expect(prompts.SURFACE).toMatch(/a skill costs the same context as always-on prose/);
    expect(prompts.SURFACE).toMatch(/MUST STAY UNDER\s+24,000 CHARS/);
    expect(prompts.SURFACE).not.toMatch(/ALWAYS-ON PROSE IS THE EXPENSIVE OPTION/);
  });
});

describe("evidence and metrics", () => {
  it("diversity is line-Jaccard: a one-line edit to a 50-line file is ~0.96 similar [R11]", () => {
    const body = Array.from({ length: 50 }, (_, i) => `rule ${i}`).join("\n");
    const d = diversity({ a: { "systemprompt.md": body }, b: { "systemprompt.md": body.replace("rule 7", "rule seven") } });
    expect(d.meanJaccard).toBeCloseTo(49 / 51, 3);
    expect(d).toMatchObject({ n: 2, nDistinct: 2 });
  });

  it("every mission says truncation markers are ours", async () => {
    let p = "";
    await stage(async (prompt) => ((p = prompt), "<notes>KEEP_BASE</notes>"));
    expect(p).toMatch(/inserted by this mission's renderer, not by the solver/);
  });

  it("k=4 with tool-heavy trajectories stays within the mission budget and says it was compacted [R20]", async () => {
    const traj = Array.from({ length: 20 }, (_, i) => `tool search_${i}(${"a".repeat(2_000)}) -> success: ${"r".repeat(10_000)}`).join("\n");
    let maxAgg = 0;
    let aggPrompt = "";
    const d = deps(
      async (p, label) => {
        if (label.startsWith("agg") && p.length > maxAgg) [maxAgg, aggPrompt] = [p.length, p];
        return EDIT;
      },
      { execute: async () => ({ ok: true, delivered: true, output: "o", trajectory: traj, error: "" }), missionCharBudget: 240_000 },
    );
    await runParallel(4, await rollBase(d, 4), d);
    expect(maxAgg).toBeLessThanOrEqual(240_000);
    expect(aggPrompt).toMatch(/THIS EVIDENCE WAS COMPACTED/);
    expect(aggPrompt).toMatch(/…\[compacted: \d+ chars of this trajectory omitted/);
  });
});
