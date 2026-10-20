/**
 * Parallel and sequential task-level recursion — port of harness2/core/recursion.py.
 *
 * Each mode schedules 4k rollouts and 3k improvement stages, including the k shared base
 * rollouts. An invalid proposal receives one retry before inheriting the current harness.
 */
import * as prompts from "./Prompts.ts";
import type { BenchPrompts } from "./Prompts.ts";
import { diffTrees, diversity, isUnchanged, onSurface, renderTree, validateTree, type Tree } from "./HarnessTree.ts";

export const STAGE_ATTEMPTS = 2;

/** One rollout of one harness on the task. A dead rollout is recorded, never raised. */
export interface RunView {
  label: string;
  ok: boolean;
  /** The run produced a non-empty deliverable. */
  delivered: boolean;
  output: string;
  /** Readable trajectory: tool calls, results, thinking excerpt, final text. */
  trajectory: string;
  error: string;
}

export type Executor = (tree: Tree, label: string) => Promise<Omit<RunView, "label">>;
export type Proposer = (prompt: string, label: string) => Promise<string>;

export interface Stage {
  label: string;
  dim: "INV" | "DOM" | "AGG" | "COMPOSE";
  tree: Tree;
  keptBase: boolean;
  fellBack: boolean;
  error: string;
  attempts: number;
  notes: string;
}

export interface ModeResult {
  mode: "agg" | "seq";
  k: number;
  stages: Stage[];
  trees: Record<string, Tree>;
  rollouts: Record<string, RunView>;
  finals: string[];
  /** Rollout labels in schedule order (upstream Ledger). */
  ledger: string[];
  similarity: { meanJaccard: number | null } | null;
}

export interface RecursionDeps {
  bp: BenchPrompts;
  execute: Executor;
  propose: Proposer;
  baseTree: Tree;
  /** Library evidence (harnessing-level recursion); "" when the domain is empty. */
  libraryText?: string;
  width?: number;
}

/** Bounded-concurrency map that keeps input order. */
async function mapLimit<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, worker));
  return out;
}

/**
 * Apply a proposer reply to `fallback`: `<file path>` writes, `<delete path/>` removals.
 * Off-surface paths are collected in `rejected`, never applied.
 */
export function applyReply(fallback: Tree, reply: string): { tree: Tree; rejected: string[]; notes: string } {
  const tree: Tree = { ...fallback };
  const rejected: string[] = [];
  for (const m of reply.matchAll(/<file\s+path="([^"]+)"\s*>\n?([\s\S]*?)<\/file>/g)) {
    const rel = m[1].trim().replace(/^\.?\//, "").replace(/^context\/harness\//, "");
    if (onSurface(rel)) tree[rel] = m[2].replace(/\n$/, "") + "\n";
    else rejected.push(rel);
  }
  for (const m of reply.matchAll(/<delete\s+path="([^"]+)"\s*\/?>/g)) {
    const rel = m[1].trim().replace(/^\.?\//, "").replace(/^context\/harness\//, "");
    if (onSurface(rel)) delete tree[rel];
    else rejected.push(rel);
  }
  const notes = /<notes>([\s\S]*?)<\/notes>/.exec(reply)?.[1].trim() ?? reply.trim();
  return { tree, rejected, notes };
}

function rolloutBlock(rv: RunView | undefined, label: string): string {
  if (!rv) return `### rollout ${label}\n\n_(no rollout)_`;
  const status = !rv.ok ? `FAILED: ${rv.error}` : rv.delivered ? "delivered" : "PRODUCED NOTHING";
  return `### rollout ${rv.label} — ${status}\n\n${rv.trajectory}`;
}

/** Upstream context.build + mission: the job, then the evidence the job reads. */
export function buildMission(
  job: string,
  opts: {
    current: Tree;
    base: RunView[];
    libraryText?: string;
    pool?: Array<{ label: string; tree: Tree; rollout?: RunView }>;
    decisions?: Record<string, string>;
  },
): string {
  const parts = [job, "# CURRENT HARNESS\n\n" + renderTree(opts.current)];
  parts.push("# BASE ROLLOUTS (unmodified harness)\n\n" + opts.base.map((r) => rolloutBlock(r, r.label)).join("\n\n"));
  if (opts.pool?.length) {
    parts.push(
      "# CANDIDATE HARNESSES AND THEIR ROLLOUTS\n\n" +
        opts.pool
          .map((p) => {
            const d = diffTrees(opts.current, p.tree);
            const note = opts.decisions?.[p.label];
            return [
              `## candidate ${p.label}`,
              `changed vs current: added [${d.added.join(", ")}] removed [${d.removed.join(", ")}] modified [${d.modified.join(", ")}]`,
              note ? `proposer notes:\n${note}` : "",
              renderTree(p.tree),
              rolloutBlock(p.rollout, p.label),
            ].filter(Boolean).join("\n\n");
          })
          .join("\n\n"),
    );
  }
  if (opts.libraryText) {
    parts.push("# LIBRARY — earlier tasks in this domain (read-only experience)\n\n" + opts.libraryText);
  }
  return parts.join("\n\n");
}

export async function runStage(args: {
  label: string;
  dim: Stage["dim"];
  job: string;
  fallback: Tree;
  base: RunView[];
  deps: RecursionDeps;
  pool?: Array<{ label: string; tree: Tree; rollout?: RunView }>;
  decisions?: Record<string, string>;
}): Promise<Stage> {
  const { label, dim, fallback, deps } = args;
  const mission = buildMission(args.job, {
    current: fallback,
    base: args.base,
    libraryText: deps.libraryText,
    pool: args.pool,
    decisions: args.decisions,
  });
  let err = "";
  let attempts = 0;
  for (let attempt = 1; attempt <= STAGE_ATTEMPTS; attempt++) {
    attempts = attempt;
    let reply: string;
    try {
      reply = await deps.propose(
        mission + (err ? `\n\n# YOUR PREVIOUS ATTEMPT WAS REJECTED\n\n${err}\n\nFix it and reply again.` : ""),
        `${label}.a${attempt}`,
      );
    } catch (error) {
      err = `proposer failed: ${error instanceof Error ? error.message : String(error)}`;
      break;
    }
    const { tree, rejected, notes } = applyReply(fallback, reply);
    if (rejected.length) {
      err = `these files are off the editable surface and were not applied: ${rejected.slice(0, 6).join(", ")}`;
      continue;
    }
    try {
      validateTree(tree);
    } catch (error) {
      err = error instanceof Error ? error.message : String(error);
      continue;
    }
    return { label, dim, tree, keptBase: isUnchanged(fallback, tree), fellBack: false, error: "", attempts, notes };
  }
  return { label, dim, tree: { ...fallback }, keptBase: false, fellBack: true, error: err.slice(0, 400), attempts, notes: "" };
}

async function roll(deps: RecursionDeps, label: string, tree: Tree): Promise<RunView> {
  try {
    return { label, ...(await deps.execute(tree, label)) };
  } catch (error) {
    return { label, ok: false, delivered: false, output: "", trajectory: "", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Roll the k base replicates under the unmodified harness. */
export async function rollBase(deps: RecursionDeps, k: number): Promise<RunView[]> {
  return mapLimit(Array.from({ length: k }, (_, i) => `base${i + 1}`), deps.width ?? 2, (l) => roll(deps, l, deps.baseTree));
}

function record(result: ModeResult, stages: Stage[], rolls: RunView[]): void {
  for (const s of stages) {
    result.stages.push(s);
    result.trees[s.label] = s.tree;
  }
  for (const r of rolls) {
    result.rollouts[r.label] = r;
    result.ledger.push(r.label);
  }
}

/** WIDTH: 2k iid candidates from shared evidence, then k INDEPENDENT compositions. */
export async function runParallel(k: number, base: RunView[], deps: RecursionDeps): Promise<ModeResult> {
  const width = deps.width ?? 2;
  const result: ModeResult = { mode: "agg", k, stages: [], trees: {}, rollouts: {}, finals: [], ledger: [], similarity: null };
  record(result, [], base);
  const specs = Array.from({ length: k }, (_, i) => (["INV", "DOM"] as const).map((d) => ({ label: `${d.toLowerCase()}${i + 1}`, dim: d, i: i + 1 }))).flat();
  const stages = await mapLimit(specs, width, (s) =>
    runStage({ label: s.label, dim: s.dim, job: prompts.propose(deps.bp, s.dim, { k, index: s.i }), fallback: deps.baseTree, base, deps }),
  );
  record(result, stages, await mapLimit(stages, width, (s) => roll(deps, s.label, s.tree)));

  const pool = stages.map((s) => ({ label: s.label, tree: s.tree, rollout: result.rollouts[s.label] }));
  const decisions = Object.fromEntries(stages.map((s) => [s.label, s.notes || s.error]));
  const aggs = await mapLimit(Array.from({ length: k }, (_, i) => i + 1), width, (i) =>
    runStage({ label: `agg${i}`, dim: "AGG", job: prompts.aggregate(deps.bp, { k, index: i }), fallback: deps.baseTree, base, deps, pool, decisions }),
  );
  record(result, aggs, await mapLimit(aggs, width, (s) => roll(deps, s.label, s.tree)));
  result.finals = aggs.map((s) => s.label);
  result.similarity = diversity(Object.fromEntries(aggs.map((s) => [s.label, s.tree])));
  return result;
}

/** DEPTH: k nested passes over the same shared base evidence. */
export async function runSequential(k: number, base: RunView[], deps: RecursionDeps): Promise<ModeResult> {
  const width = deps.width ?? 2;
  const result: ModeResult = { mode: "seq", k, stages: [], trees: {}, rollouts: {}, finals: [], ledger: [], similarity: null };
  record(result, [], base);
  let current: Tree = { ...deps.baseTree };
  let history: Array<{ label: string; tree: Tree; rollout?: RunView }> = [];
  for (let t = 1; t <= k; t++) {
    const decisionsSoFar = () => Object.fromEntries(result.stages.map((s) => [s.label, s.notes || s.error]));
    const fallback = current;
    const stages = await mapLimit([`inv${t}`, `dom${t}`], Math.min(2, width), (label) => {
      const dim = label.startsWith("inv") ? "INV" : "DOM";
      return runStage({
        label,
        dim,
        job: prompts.propose(deps.bp, dim, { k, index: t, roundT: k > 1 ? t : undefined }),
        fallback,
        base,
        deps,
        pool: [...history],
        decisions: decisionsSoFar(),
      });
    });
    record(result, stages, await mapLimit(stages, width, (s) => roll(deps, s.label, s.tree)));
    const roundPool = [...history, ...stages.map((s) => ({ label: s.label, tree: s.tree, rollout: result.rollouts[s.label] }))];
    const ck = `c${t}`;
    const comp = await runStage({
      label: ck,
      dim: "COMPOSE",
      job: k === 1 ? prompts.aggregate(deps.bp, { k: 1, index: 1 }) : prompts.composeRound(deps.bp, { t, k }),
      fallback: current,
      base,
      deps,
      pool: roundPool,
      decisions: decisionsSoFar(),
    });
    record(result, [comp], [await roll(deps, ck, comp.tree)]);
    history = [...roundPool, { label: ck, tree: comp.tree, rollout: result.rollouts[ck] }];
    current = comp.tree;
  }
  result.finals = Array.from({ length: k }, (_, i) => `c${i + 1}`);
  return result;
}
