/**
 * Harness tree — port of harness2/core/tree.py for this service's substrate.
 *
 * A harness is a map of relative path → file text. The editable surface here is the
 * always-on files plus on-trigger skills. Sub-agents, scripts and plugins are not part
 * of this substrate's surface (see docs/HARNESS2_PLAN_2026-10-19.md).
 */

export type Tree = Record<string, string>;

export const ALWAYS_ON = ["systemprompt.md", "guardrails.md", "memory.md", "tool_guidance.md"] as const;
const TRIGGER_FILES = ["systemprompt.md", "guardrails.md"];
/** Where `autotrigger` writes a missing trigger line (upstream opencode surface). */
const AUTOTRIGGER_FILE = "guardrails.md";

/**
 * Cap on the materialized system prompt (upstream opencode: 24,000 always-on chars). Skills
 * count too: this substrate inlines every skill body (see `materialize`).
 */
export const ALWAYS_ON_MAX = 24_000;
const SKILL_RE = /^skills\/([a-z0-9_-]+)\/SKILL\.md$/;

/** True when `rel` is on the editable surface. */
export function onSurface(rel: string): boolean {
  return (ALWAYS_ON as readonly string[]).includes(rel) || SKILL_RE.test(rel);
}

export function skillNames(tree: Tree): string[] {
  return Object.keys(tree)
    .map((rel) => SKILL_RE.exec(rel)?.[1])
    .filter((name): name is string => Boolean(name))
    .sort();
}

function frontmatter(text: string): Record<string, string> {
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(text.trimStart());
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

export function skillDescription(tree: Tree, name: string): string {
  return frontmatter(tree[`skills/${name}/SKILL.md`] || "").description || "";
}

/**
 * Machine markers of a grader's own output (upstream context.py GRADER_VERDICT_MARKERS). A
 * tripwire for a leaked verdict file, not a phrase filter: ordinary domain text ("graded as
 * BBB-") must pass.
 */
export const GRADER_VERDICT_MARKERS = [
  "deterministic_eval_summary",
  "deterministic_eval_result",
  "judge_scope_and_deterministic_status",
  "Judge findings on the rendered result",
  '"passed_count"',
  '"pass_rate"',
  '"test_pass_rate"',
] as const;

export function assertNoGraderVerdicts(tree: Tree): void {
  for (const rel of Object.keys(tree).sort()) {
    for (const m of GRADER_VERDICT_MARKERS) {
      if (rel.includes(m)) throw new Error(`harness file ${rel} has grader-verdict marker ${m} in its NAME; rename it`);
      const at = tree[rel].indexOf(m);
      if (at >= 0) {
        throw new Error(`harness file ${rel} contains grader-verdict marker ${m} at offset ${at}; remove that string`);
      }
    }
  }
}

const triggerText = (tree: Tree) => TRIGGER_FILES.map((rel) => tree[rel] || "").join("\n");

/**
 * Every problem in the tree: upstream's discard rules, the always-on invariant and the size cap.
 * Upstream `validate` collects all of them, so one retry can fix them all.
 */
export function collectTreeErrors(tree: Tree, cap: number = ALWAYS_ON_MAX): string[] {
  const errs: string[] = [];
  const off = Object.keys(tree).filter((rel) => !onSurface(rel));
  if (off.length) errs.push(`off the editable surface: ${off.join(", ")}`);
  if (!(tree["systemprompt.md"] || "").trim()) errs.push("systemprompt.md must not be empty or deleted");
  for (const rel of ALWAYS_ON) {
    const text = tree[rel] || "";
    if (text.includes("{{") || text.includes("{%")) errs.push(`${rel} contains template braces ({{ or {%)`);
  }
  const size = materialize(tree).length;
  if (size > cap) {
    errs.push(
      `the materialized system prompt is ${size} chars, over the ${cap} cap: always-on files plus every skill body ` +
        "(skills are inlined on this substrate); every token here competes with the agent's own output budget",
    );
  }
  const triggers = triggerText(tree);
  for (const name of skillNames(tree)) {
    const fm = frontmatter(tree[`skills/${name}/SKILL.md`]);
    if (fm.name !== name) errs.push(`skills/${name}/SKILL.md frontmatter needs name: ${name}`);
    if (!fm.description) errs.push(`skills/${name}/SKILL.md frontmatter needs a description:`);
    if (!triggers.includes(name)) errs.push(`skill '${name}' has no trigger line: name it verbatim in systemprompt.md or guardrails.md`);
  }
  try {
    assertNoGraderVerdicts(tree);
  } catch (error) {
    errs.push(error instanceof Error ? error.message : String(error));
  }
  return errs;
}

/** Throws one error listing every problem, with messages the proposer can act on. */
export function validateTree(tree: Tree, cap: number = ALWAYS_ON_MAX): void {
  const errs = collectTreeErrors(tree, cap);
  if (errs.length) throw new Error(errs.join(" | "));
}

/**
 * Upstream `autotrigger`: give every skill without a trigger line one in guardrails.md, unless the
 * line would push the materialized prompt over the cap. Mutates `tree`; returns the names repaired.
 */
export function autotrigger(tree: Tree, cap: number = ALWAYS_ON_MAX): string[] {
  const fixed: string[] = [];
  for (const name of skillNames(tree)) {
    if (triggerText(tree).includes(name)) continue;
    const desc = (frontmatter(tree[`skills/${name}/SKILL.md`]).description || `the ${name} workflow applies`).replace(/\.$/, "");
    const line = `- When ${desc}, use the \`${name}\` skill.`;
    if (materialize(tree).length + line.length + 2 > cap) continue;
    const cur = tree[AUTOTRIGGER_FILE] || "";
    tree[AUTOTRIGGER_FILE] = cur.trim() ? `${cur.trimEnd()}\n${line}\n` : `${line}\n`;
    fixed.push(name);
  }
  return fixed;
}

export interface TreeDiff { added: string[]; removed: string[]; modified: string[] }

export function diffTrees(base: Tree, next: Tree): TreeDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const rel of Object.keys(next)) {
    if (!(rel in base)) added.push(rel);
    else if (base[rel] !== next[rel]) modified.push(rel);
  }
  for (const rel of Object.keys(base)) if (!(rel in next)) removed.push(rel);
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort() };
}

export function isUnchanged(base: Tree, next: Tree): boolean {
  const d = diffTrees(base, next);
  return !d.added.length && !d.removed.length && !d.modified.length;
}

/**
 * The system prompt a rollout runs under. Skills follow the always-on text under their
 * own heading so the trigger line in the always-on text points at a named section.
 */
export function materialize(tree: Tree): string {
  const parts = ALWAYS_ON.map((rel) => (tree[rel] || "").trim()).filter(Boolean);
  const skills = skillNames(tree);
  if (skills.length) {
    parts.push(
      "# SKILLS\n\nUse a skill only when its trigger applies.\n\n" +
        skills.map((name) => `## skill: ${name}\n\n${tree[`skills/${name}/SKILL.md`].trim()}`).join("\n\n"),
    );
  }
  return parts.join("\n\n");
}

/** Render a tree for a prompt, one fenced file per path. */
export function renderTree(tree: Tree): string {
  const rels = Object.keys(tree).sort();
  if (!rels.length) return "_(empty)_";
  return rels.map((rel) => `<file path="${rel}">\n${tree[rel]}\n</file>`).join("\n\n");
}

/** Pairwise line-Jaccard over candidate trees, so collapse to one body is visible — upstream `diversity`. */
export function diversity(trees: Record<string, Tree>): { meanJaccard: number | null; n: number; nDistinct: number } {
  const labels = Object.keys(trees).sort();
  const lines = (t: Tree) => new Set(Object.entries(t).flatMap(([rel, text]) => text.split("\n").filter((l) => l.trim()).map((l) => `${rel}:${l}`)));
  const sets = labels.map((l) => lines(trees[l]));
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const inter = [...sets[i]].filter((x) => sets[j].has(x)).length;
      const union = new Set([...sets[i], ...sets[j]]).size;
      total += union ? inter / union : 1;
      pairs++;
    }
  }
  const nDistinct = new Set(labels.map((l) => JSON.stringify(Object.entries(trees[l]).sort()))).size;
  return { meanJaccard: pairs ? total / pairs : null, n: labels.length, nDistinct };
}
