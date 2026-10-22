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

/**
 * Upstream's three discard rules plus the always-on invariant. Throws on the first
 * violation with a message the proposer can act on.
 */
export function validateTree(tree: Tree): void {
  const off = Object.keys(tree).filter((rel) => !onSurface(rel));
  if (off.length) throw new Error(`off the editable surface: ${off.join(", ")}`);
  if (!(tree["systemprompt.md"] || "").trim()) throw new Error("systemprompt.md must not be empty or deleted");
  for (const rel of ALWAYS_ON) {
    const text = tree[rel] || "";
    if (text.includes("{{") || text.includes("{%")) throw new Error(`${rel} contains template braces ({{ or {%)`);
  }
  const triggerText = TRIGGER_FILES.map((rel) => tree[rel] || "").join("\n");
  for (const name of skillNames(tree)) {
    const fm = frontmatter(tree[`skills/${name}/SKILL.md`]);
    if (fm.name !== name) throw new Error(`skills/${name}/SKILL.md frontmatter needs name: ${name}`);
    if (!fm.description) throw new Error(`skills/${name}/SKILL.md frontmatter needs a description:`);
    if (!triggerText.includes(name)) {
      throw new Error(`skill '${name}' has no trigger line: name it verbatim in systemprompt.md or guardrails.md`);
    }
  }
  assertNoGraderVerdicts(tree);
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

/** Pairwise Jaccard similarity over (path, text) pairs — upstream `diversity`. */
export function diversity(trees: Record<string, Tree>): { meanJaccard: number | null } {
  const labels = Object.keys(trees);
  const sets = labels.map((l) => new Set(Object.entries(trees[l]).map(([p, t]) => `${p}\u0000${t}`)));
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
  return { meanJaccard: pairs ? total / pairs : null };
}
