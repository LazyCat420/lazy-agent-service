/**
 * Parallel and sequential task-level recursion — port of harness2/core/recursion.py.
 *
 * Each mode schedules 4k rollouts and 3k improvement stages, including the k shared base
 * rollouts. An invalid proposal receives one retry, editing what it sent, before inheriting the
 * current harness. A proposer call gets 2 transport attempts; a reply that never arrives is a
 * failure, never a KEEP_BASE.
 */
import * as prompts from "./Prompts.ts";
import type { BenchPrompts } from "./Prompts.ts";
import { autotrigger, diffTrees, diversity, isUnchanged, onSurface, renderTree, validateTree, type Tree } from "./HarnessTree.ts";

export const STAGE_ATTEMPTS = 2;
/** Upstream config.TRANSPORT_ATTEMPTS: calls per proposal before the stage falls back. */
export const TRANSPORT_ATTEMPTS = 2;
/** Default mission size (≈ 60–80k tokens): the Jetson's nemotron35 serves 100k tokens of context. */
export const DEFAULT_MISSION_CHAR_BUDGET = 240_000;
/** Smallest trajectory slice compaction keeps per rollout. */
const MIN_TRAJECTORY_CHARS = 2_000;
/** Cap on the rejected harness echoed back into a retry prompt. */
const RETRY_TREE_CHARS = 30_000;

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

/** A proposer call that produced no usable reply. `retryable: false` skips the second transport attempt. */
export class ProposerError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "ProposerError";
  }
}

export interface Stage {
  label: string;
  dim: "INV" | "DOM" | "AGG" | "COMPOSE";
  tree: Tree;
  keptBase: boolean;
  fellBack: boolean;
  error: string;
  attempts: number;
  notes: string;
  /** Skills that `autotrigger` gave a trigger line before validation. */
  repaired: string[];
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
  similarity: ReturnType<typeof diversity> | null;
}

export interface RecursionDeps {
  bp: BenchPrompts;
  execute: Executor;
  propose: Proposer;
  baseTree: Tree;
  /** Library evidence (harnessing-level recursion); "" when the domain is empty. */
  libraryText?: string;
  width?: number;
  /** Wait before transport attempt n is backoff × (n - 1); upstream uses 10 s. */
  transportBackoffMs?: number;
  /** Mission size above which rollout trajectories are compacted. */
  missionCharBudget?: number;
}

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Stage label → its notes, or its error when it fell back (what later stages read as decisions). */
export function decisionsOf(stages: Stage[]): Record<string, string> {
  return Object.fromEntries(stages.map((s) => [s.label, s.notes || s.error]));
}

const relOf = (raw: string) => raw.trim().replace(/^\.?\//, "").replace(/^context\/harness\//, "");
const FILE_OPEN = /<file\s+path="([^"]+)"\s*>/g;
const FILE_BLOCK = /<file\s+path="([^"]+)"\s*>\n?([\s\S]*?)<\/file>/g;

/**
 * Apply a proposer reply to `fallback`: `<file path>` writes, `<delete path/>` removals.
 * Off-surface paths are collected in `rejected`, never applied. `unterminated` names the first
 * `<file>` block that never closes (a reply cut off mid-file).
 */
export function applyReply(fallback: Tree, reply: string): { tree: Tree; rejected: string[]; notes: string; unterminated: string | null } {
  const tree: Tree = { ...fallback };
  const rejected: string[] = [];
  const complete = new Set<number>();
  for (const m of reply.matchAll(FILE_BLOCK)) {
    complete.add(m.index);
    const rel = relOf(m[1]);
    if (onSurface(rel)) tree[rel] = m[2].replace(/\n$/, "") + "\n";
    else rejected.push(rel);
  }
  const open = [...reply.matchAll(FILE_OPEN)].find((m) => !complete.has(m.index));
  for (const m of reply.matchAll(/<delete\s+path="([^"]+)"\s*\/?>/g)) {
    const rel = relOf(m[1]);
    if (onSurface(rel)) delete tree[rel];
    else rejected.push(rel);
  }
  const notes = /<notes>([\s\S]*?)<\/notes>/.exec(reply)?.[1].trim() ?? reply.trim();
  return { tree, rejected, notes, unterminated: open ? relOf(open[1]) : null };
}

/** Keep the start and end of `text` within `limit` chars, marking the cut as ours. */
function compact(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  return `${text.slice(0, head)}\n…[compacted: ${text.length - limit} chars of this trajectory omitted to fit the mission budget]…\n${text.slice(-tail)}`;
}

function rolloutBlock(rv: RunView | undefined, label: string, limit = Infinity): string {
  if (!rv) return `### rollout ${label}\n\n_(no rollout)_`;
  const status = !rv.ok ? `FAILED: ${rv.error}` : rv.delivered ? "delivered" : "PRODUCED NOTHING";
  return `### rollout ${rv.label} — ${status}\n\n${compact(rv.trajectory, limit)}`;
}

const TRUNCATION_NOTE =
  "Markers such as `…[truncated N chars]` or `…[compacted …]…` inside this evidence were inserted by this " +
  "mission's renderer, not by the solver. Do not diagnose them as a solver failure.";

export interface MissionOptions {
  current: Tree;
  /** Heading for `current` (default "CURRENT HARNESS"). */
  currentTitle?: string;
  base: RunView[];
  libraryText?: string;
  pool?: Array<{ label: string; tree: Tree; rollout?: RunView }>;
  decisions?: Record<string, string>;
  /** What candidate diffs are measured against (default: `current`, named "current"). */
  diffBase?: { name: string; tree: Tree };
  /** Compact rollout trajectories when the mission would exceed this many chars. */
  budget?: number;
}

/** Upstream context.build + mission: the job, then the evidence the job reads. */
export function buildMission(job: string, opts: MissionOptions): string {
  const render = (limit: number, compacted: string) => {
    const ref = opts.diffBase ?? { name: "current", tree: opts.current };
    const parts = [job, compacted ? `${TRUNCATION_NOTE}\n\n${compacted}` : TRUNCATION_NOTE, `# ${opts.currentTitle ?? "CURRENT HARNESS"}\n\n${renderTree(opts.current)}`];
    parts.push("# BASE ROLLOUTS (unmodified harness)\n\n" + opts.base.map((r) => rolloutBlock(r, r.label, limit)).join("\n\n"));
    if (opts.pool?.length) {
      parts.push(
        "# CANDIDATE HARNESSES AND THEIR ROLLOUTS\n\n" +
          opts.pool
            .map((p) => {
              const d = diffTrees(ref.tree, p.tree);
              const note = opts.decisions?.[p.label];
              return [
                `## candidate ${p.label}`,
                isUnchanged(ref.tree, p.tree)
                  ? `IDENTICAL to the ${ref.name} harness: any difference between its rollout and the base rollouts is sampling noise, not an effect of an edit.`
                  : `changed vs ${ref.name}: added [${d.added.join(", ")}] removed [${d.removed.join(", ")}] modified [${d.modified.join(", ")}]`,
                note ? `proposer notes:\n${note}` : "",
                renderTree(p.tree),
                rolloutBlock(p.rollout, p.label, limit),
              ].filter(Boolean).join("\n\n");
            })
            .join("\n\n"),
      );
    }
    if (opts.libraryText) {
      parts.push("# LIBRARY — earlier tasks in this domain (read-only experience)\n\n" + opts.libraryText);
    }
    return parts.join("\n\n");
  };
  const full = render(Infinity, "");
  const budget = opts.budget ?? Infinity;
  if (full.length <= budget) return full;
  const rollouts = [...opts.base, ...(opts.pool ?? []).map((p) => p.rollout).filter((r): r is RunView => Boolean(r))];
  const trajectoryChars = rollouts.reduce((n, r) => n + r.trajectory.length, 0);
  // Reserve room for the compaction note (~300 chars) and each trajectory's marker (~100 chars).
  const share = Math.floor((budget - (full.length - trajectoryChars) - 400) / Math.max(1, rollouts.length)) - 120;
  const limit = Math.max(MIN_TRAJECTORY_CHARS, share);
  return render(
    limit,
    `THIS EVIDENCE WAS COMPACTED to fit a ${budget}-char mission budget: each rollout trajectory longer than ` +
      `${limit} chars keeps its start and its end, and the middle is replaced by a \`…[compacted …]…\` marker.`,
  );
}

/**
 * One proposer call with upstream's transport policy: TRANSPORT_ATTEMPTS tries with backoff, and
 * an empty reply counts as a failed attempt. Throws when no attempt produced a reply.
 */
async function callProposer(deps: RecursionDeps, prompt: string, label: string): Promise<string> {
  let last = "";
  let attempt = 0;
  while (attempt < TRANSPORT_ATTEMPTS) {
    attempt++;
    if (attempt > 1) await sleep((deps.transportBackoffMs ?? 10_000) * (attempt - 1));
    try {
      const reply = await deps.propose(prompt, label);
      if (reply.trim()) return reply;
      last = "empty reply";
    } catch (error) {
      last = errText(error);
      if (error instanceof ProposerError && !error.retryable) break;
    }
  }
  throw new ProposerError(`${last} (after ${attempt} transport attempt${attempt > 1 ? "s" : ""})`);
}

/** What a retry sees: the rejection, the harness the rejected reply produced, and its notes. */
function retryBlock(err: string, rejectedTree: Tree, fallback: Tree, rejectedNotes: string): string {
  const d = diffTrees(fallback, rejectedTree);
  const changed = [...d.added, ...d.modified];
  const shown = changed.length ? renderTree(Object.fromEntries(changed.map((rel) => [rel, rejectedTree[rel]]))) : "_(no file changed)_";
  const clipped = shown.length > RETRY_TREE_CHARS ? `${shown.slice(0, RETRY_TREE_CHARS)}\n…[truncated ${shown.length - RETRY_TREE_CHARS} chars]` : shown;
  return [
    "# YOUR PREVIOUS ATTEMPT WAS REJECTED",
    err,
    "Your previous reply produced the harness below. It was NOT adopted. Fix it: reply with file blocks that " +
      "edit THIS rejected harness. Files you do not mention keep the content shown here, and files not shown " +
      "are unchanged from CURRENT HARNESS." +
      (d.removed.length ? ` Your reply deleted: ${d.removed.join(", ")}.` : ""),
    clipped,
    rejectedNotes ? `Your previous notes (excerpt):\n${rejectedNotes.slice(0, 2_000)}` : "",
    "Reply again.",
  ]
    .filter(Boolean)
    .join("\n\n");
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
    budget: deps.missionCharBudget ?? DEFAULT_MISSION_CHAR_BUDGET,
  });
  let err = "";
  let attempts = 0;
  // Upstream writes a rejected tree back into the workspace, so the retry edits what it sent.
  let working: Tree = fallback;
  let workingNotes = "";
  for (let attempt = 1; attempt <= STAGE_ATTEMPTS; attempt++) {
    attempts = attempt;
    let reply: string;
    try {
      reply = await callProposer(deps, mission + (err ? `\n\n${retryBlock(err, working, fallback, workingNotes)}` : ""), `${label}.a${attempt}`);
    } catch (error) {
      err = `proposer failed: ${errText(error)}`;
      break;
    }
    const { tree, rejected, notes, unterminated } = applyReply(working, reply);
    working = tree;
    workingNotes = notes;
    if (unterminated) {
      err =
        `your reply was cut off inside the <file path="${unterminated}"> block (no closing </file>); the complete ` +
        "blocks before it were applied. Write shorter files, or fewer of them, and close every block";
      continue;
    }
    if (rejected.length) {
      err = `these files are off the editable surface and were not applied: ${rejected.slice(0, 6).join(", ")}`;
      continue;
    }
    const repaired = autotrigger(tree);
    try {
      validateTree(tree);
    } catch (error) {
      err = errText(error);
      continue;
    }
    return { label, dim, tree, keptBase: isUnchanged(fallback, tree), fellBack: false, error: "", attempts, notes, repaired };
  }
  return { label, dim, tree: { ...fallback }, keptBase: false, fellBack: true, error: err.slice(0, 400), attempts, notes: "", repaired: [] };
}

async function roll(deps: RecursionDeps, label: string, tree: Tree): Promise<RunView> {
  try {
    return { label, ...(await deps.execute(tree, label)) };
  } catch (error) {
    return { label, ok: false, delivered: false, output: "", trajectory: "", error: errText(error) };
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
  const decisions = decisionsOf(stages);
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
        decisions: decisionsOf(result.stages),
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
      decisions: decisionsOf(result.stages),
    });
    record(result, [comp], [await roll(deps, ck, comp.tree)]);
    history = [...roundPool, { label: ck, tree: comp.tree, rollout: result.rollouts[ck] }];
    current = comp.tree;
  }
  result.finals = Array.from({ length: k }, (_, i) => `c${i + 1}`);
  return result;
}
