/**
 * Harness² for lazy-agent-service: one task through task-level recursion
 * (Propose–Probe–Compose), blind selection, experience reflection, and the
 * harnessing-level library update.
 *
 * Executor: `runSingleModel` (the benchmark trial path) with the materialized harness as
 * the system prompt. Proposer/selector/reflector: `provider.generateText`.
 */
import { createHash } from "node:crypto";
import { runSingleModel, type ModelResult } from "../BenchmarkService.ts";
import { getProvider } from "../../providers/index.ts";
import logger from "../../utils/logger.ts";
import { ASK_USER_TOOL_SCHEMA } from "../harnesses/lifecycle/AskUserTool.ts";
import { isUnchanged, materialize, type Tree } from "./HarnessTree.ts";
import { Library, hasExperience, type Experience } from "./Library.ts";
import * as prompts from "./Prompts.ts";
import type { BenchPrompts, SelectionPool } from "./Prompts.ts";
import {
  DEFAULT_MISSION_CHAR_BUDGET,
  ProposerError,
  buildMission,
  decisionsOf,
  rollBase,
  runParallel,
  runSequential,
  type Executor,
  type ModeResult,
  type Proposer,
  type RecursionDeps,
  type RunView,
} from "./Recursion.ts";

export interface ModelRef {
  provider: string;
  model: string;
  thinkingEnabled?: boolean;
  /** Run the solver through the agentic loop with tools. */
  toolsEnabled?: boolean;
}

/**
 * The DGX Spark (`vllm-2`); override with HARNESS2_IMPROVER_PROVIDER / _MODEL. With no model
 * override the route uses whatever model the provider serves: a pinned name went stale when the
 * Spark switched from GLM-5.3-Flash to DeepSeek-V4.1-Flash (ch.13 A14).
 */
export const DEFAULT_IMPROVER: ModelRef = {
  provider: process.env.HARNESS2_IMPROVER_PROVIDER || "vllm-2",
  model: process.env.HARNESS2_IMPROVER_MODEL || "",
};

export interface Harness2Request {
  taskId: string;
  /** The user request the solver runs on. */
  task: string;
  domain: string;
  baseTree: Tree;
  bench?: Omit<BenchPrompts, "work"> & { work?: string };
  k?: number;
  mode?: "parallel" | "sequential";
  solver: ModelRef;
  /**
   * Proposer/composer/selector/reflector model; defaults to DEFAULT_IMPROVER, not the
   * solver: a weak improver confabulates selections and lessons (smoke, 2026-10-19).
   */
  improver?: ModelRef;
  width?: number;
  /**
   * Who competes in blind selection. "finals" (default, upstream): the k finals only, and at
   * k=1 the single final is delivered with no selector call. "mixed": the base rollouts compete
   * too, so an unadapted answer can win when adaptation hurt.
   */
  selectionPool?: SelectionPool;
  /** Mixed into the per-task selection seed; the order is already task-specific without it. */
  seed?: number;
  libraryRoot?: string;
  project?: string;
  username?: string;
}

export interface Selection {
  /** The pick came from a selector answer or a one-candidate pool, never from a fallback. */
  ok: boolean;
  /** "" when no candidate delivered anything. */
  chosenLabel: string;
  why: string;
  /** Anonymous id → label, for audit. */
  ids: Record<string, string>;
  pool: SelectionPool;
  /** Delivered without a selector call (k=1 finals-only, or one delivered candidate). */
  trivial: boolean;
  /** The selector failed and a neutral stand-in was delivered; a fallback is never learned from. */
  fallback: boolean;
  error?: string;
}

/**
 * ok: selection succeeded. base-failed: no base rollout ran, so nothing was proposed.
 * improver-failed: every stage fell back on a proposer failure. no-output: no candidate in the
 * pool delivered. selection-fallback: the selector failed and a neutral output was delivered.
 * cancelled: the run's signal aborted; nothing after that point ran.
 */
export type Harness2Status = "ok" | "base-failed" | "improver-failed" | "no-output" | "selection-fallback" | "cancelled";

export interface Harness2Result {
  taskId: string;
  domain: string;
  status: Harness2Status;
  /** This run stored a library entry. */
  learned: boolean;
  /** Run-level problems; per-stage outcomes stay on `result.stages`. */
  errors: string[];
  result: ModeResult;
  selection: Selection;
  adoptedTree: Tree;
  /** The adopted tree is identical to the base harness (a KEEP_BASE final, or a base pick). */
  chosenTreeIsBase: boolean;
  output: string;
  experience: { edits: string; entry: Experience | null; raw: string };
  libraryEntry: string | null;
  libraryEntriesBefore: number;
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s);
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Deterministic shuffle (mulberry32) so a seed reproduces the selection order. */
export function shuffle<T>(items: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function parseExperience(reply: string): { edits: string; entry: Experience | null } {
  const edits = /<edits>([\s\S]*?)<\/edits>/.exec(reply)?.[1].trim() ?? "";
  const block = /<experience>([\s\S]*?)<\/experience>/.exec(reply)?.[1];
  if (!block) return { edits, entry: null };
  const fields: Record<string, string> = {};
  let key = "";
  for (const line of block.split("\n")) {
    const m = /^(cue|lesson|evidence|confidence):\s*(.*)$/.exec(line.trim());
    if (m) fields[(key = m[1])] = m[2];
    else if (key && line.trim()) fields[key] += ` ${line.trim()}`;
  }
  const entry = { cue: fields.cue ?? "", lesson: fields.lesson ?? "", evidence: fields.evidence ?? "", confidence: fields.confidence ?? "", edits };
  return { edits, entry: hasExperience(entry) ? entry : null };
}

/**
 * Upstream `assign_ids` seed: sha1(task|k|mode), so the shuffled order differs per task and a
 * rerun of the same task repeats it. A caller seed is mixed in when given.
 */
export function selectionSeed(taskId: string, k: number, mode: string, seed?: number): number {
  const key = `${taskId}|${k}|${mode}` + (seed === undefined ? "" : `|${seed}`);
  return parseInt(createHash("sha1").update(key).digest("hex").slice(0, 8), 16);
}

/**
 * Upstream `_fallback`: after a selector failure deliver a delivered base output, else (finals
 * pool) the first final by name. The pick is delivered but `ok` stays false, so it never teaches.
 */
function fallbackPick(sel: Selection, labels: string[], error: string): Selection {
  const chosenLabel = labels.filter((l) => l.startsWith("base")).sort()[0] ?? (sel.pool === "finals" ? [...labels].sort()[0] : "");
  if (!chosenLabel) return { ...sel, error: `${error}; no delivered base output was available for a neutral fallback` };
  return { ...sel, chosenLabel, fallback: true, error: `${error}; delivered ${chosenLabel} as a neutral fallback` };
}

/** Blind selection over the pool: the k finals (default), or base rollouts plus finals ("mixed"). */
export async function selectOutput(
  bp: BenchPrompts,
  result: ModeResult,
  propose: Proposer,
  opts: { taskId: string; pool?: SelectionPool; seed?: number; budget?: number },
): Promise<Selection> {
  const pool = opts.pool ?? "finals";
  const entrants = pool === "mixed" ? [...result.ledger.filter((l) => l.startsWith("base")), ...result.finals] : result.finals;
  const labels = entrants.filter((l) => result.rollouts[l]?.delivered);
  const sel: Selection = { ok: false, chosenLabel: "", why: "", ids: {}, pool, trivial: false, fallback: false };
  if (!labels.length) {
    return { ...sel, error: pool === "finals" ? "no final delivered an output (the finals-only pool has no base fallback)" : "no candidate delivered an output" };
  }
  if (labels.length === 1) {
    const why = pool === "finals" && result.k === 1 ? "trivial pool: single final at k=1; delivered without a selector call" : "only one candidate delivered";
    return { ...sel, ok: true, trivial: true, chosenLabel: labels[0], why, ids: { a1: labels[0] } };
  }
  const order = shuffle([...labels].sort(), selectionSeed(opts.taskId, result.k, result.mode, opts.seed));
  // Each candidate gets an equal share of the mission budget, at most 40,000 chars.
  const cap = Math.min(SELECT_CANDIDATE_CHARS, Math.floor((opts.budget ?? DEFAULT_MISSION_CHAR_BUDGET) / order.length));
  const ids = Object.fromEntries(order.map((l, i) => [`a${i + 1}`, l]));
  const body =
    prompts.select(bp, order.length, pool) +
    "\n\n# THE REQUEST\n\n" +
    bp.work +
    "\n\n# CANDIDATES\n\n" +
    Object.entries(ids).map(([id, l]) => `## ${id}\n\n${truncate(result.rollouts[l].output, cap)}`).join("\n\n");
  try {
    const reply = await propose(body, "select");
    const id = /```choice\s*\n?\s*([A-Za-z0-9_-]+)\s*\n?```/.exec(reply)?.[1];
    const why = /<why>([\s\S]*?)<\/why>/.exec(reply)?.[1].trim() ?? "";
    if (id && ids[id]) return { ...sel, ok: true, chosenLabel: ids[id], why, ids };
    return fallbackPick({ ...sel, why, ids }, labels, `selector returned no valid id (${id ?? "none"})`);
  } catch (error) {
    return fallbackPick({ ...sel, ids }, labels, `selector failed: ${errText(error)}`);
  }
}

/**
 * Per-field caps. Upstream refuses an observation limit under 10,000 chars ("in the range that
 * fabricates defects"); the mission budget compacts whole trajectories when they add up.
 */
const TRAJECTORY_CAPS = { thinking: 4_000, args: 2_000, result: 10_000, final: 20_000 };
/** Upper bound on one selector candidate (each also gets at most budget / n). */
const SELECT_CANDIDATE_CHARS = 40_000;

function trajectoryOf(r: ModelResult): string {
  const lines: string[] = [];
  if (r.thinking) lines.push(`thinking (excerpt): ${truncate(r.thinking, TRAJECTORY_CAPS.thinking)}`);
  for (const call of r.toolCalls || []) {
    const result = typeof call.result === "string" ? call.result : JSON.stringify(call.result ?? null);
    lines.push(`tool ${call.name}(${truncate(JSON.stringify(call.args ?? {}), TRAJECTORY_CAPS.args)}) -> ${call.status}: ${truncate(result, TRAJECTORY_CAPS.result)}`);
  }
  if (r.error) lines.push(`error: ${r.error}`);
  lines.push(`final output:\n${truncate(r.response || "", TRAJECTORY_CAPS.final) || "(empty)"}`);
  return lines.join("\n");
}

/**
 * The solver rollout. Every rollout ends: it gets its own AbortSignal with a deadline
 * (HARNESS2_ROLLOUT_TIMEOUT_MS, default 20 min), follows the run's cancellation, and is stopped at
 * its first `ask_user` call, because no user is attached to a harness2 rollout (the loop would
 * park the turn until an answer that never comes). A rollout that ignores its abort is abandoned
 * after `abortGraceMs`.
 */
export function makeExecutor(
  req: Harness2Request,
  opts: { signal?: AbortSignal; timeoutMs?: number; abortGraceMs?: number; runModel?: typeof runSingleModel } = {},
): Executor {
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.HARNESS2_ROLLOUT_TIMEOUT_MS) || 20 * 60_000);
  const graceMs = opts.abortGraceMs ?? 30_000;
  const runModel = opts.runModel ?? runSingleModel;
  return async (tree, label) => {
    const failed = (error: string, output = "", trajectory = "") => ({ ok: false, delivered: false, output, trajectory, error });
    if (opts.signal?.aborted) return failed("run cancelled");
    const controller = new AbortController();
    let reason = "";
    let graceTimer: NodeJS.Timeout | undefined;
    let abandon: () => void = () => {};
    const abandoned = new Promise<null>((resolve) => (abandon = () => resolve(null)));
    const stop = (why: string) => {
      if (controller.signal.aborted) return;
      reason = why;
      controller.abort(new Error(why));
      graceTimer = setTimeout(abandon, graceMs);
    };
    const deadline = setTimeout(() => stop(`rollout exceeded its ${Math.round(timeoutMs / 1000)} s deadline`), timeoutMs);
    const onCancel = () => stop("run cancelled");
    opts.signal?.addEventListener("abort", onCancel, { once: true });
    try {
      const r = await Promise.race([
        runModel(
          { id: `harness2-${req.taskId}-${label}`, name: `harness2 ${label}`, prompt: req.task, systemPrompt: materialize(tree), temperature: 0.7, maxTokens: 8192 },
          { provider: req.solver.provider, model: req.solver.model, label, thinkingEnabled: Boolean(req.solver.thinkingEnabled), toolsEnabled: Boolean(req.solver.toolsEnabled) },
          req.project || "harness2",
          req.username || "harness2",
          {
            signal: controller.signal,
            onEvent: (event) => {
              if (event.type === "tool_execution" && event.tool?.name === ASK_USER_TOOL_SCHEMA.name) {
                stop("the solver called ask_user, but no user is attached to a harness2 rollout");
              }
            },
          },
        ),
        abandoned,
      ]);
      if (!r) return failed(`${reason} (the rollout did not stop within ${Math.round(graceMs / 1000)} s and was abandoned)`);
      if (reason) return failed(reason, r.response || "", trajectoryOf(r));
      const output = r.response || "";
      return { ok: !r.error, delivered: !r.error && output.trim().length > 0, output, trajectory: trajectoryOf(r), error: r.error || "" };
    } finally {
      clearTimeout(deadline);
      clearTimeout(graceTimer);
      opts.signal?.removeEventListener("abort", onCancel);
    }
  };
}

const PROPOSER_MAX_TOKENS = 16_384;

/**
 * The improver call. A reply that never arrived is an error, never "" (which would read as
 * KEEP_BASE): empty text and all-zero usage (a cut-off generation) are retryable failures; a
 * deadline is not, because `generateText` takes no signal and the timed-out call keeps running.
 */
export function makeProposer(
  model: ModelRef,
  opts: {
    timeoutMs?: number;
    signal?: AbortSignal;
    providerOf?: (name: string) => Pick<ReturnType<typeof getProvider>, "generateText">;
  } = {},
): Proposer {
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.HARNESS2_PROPOSER_TIMEOUT_MS) || 20 * 60_000);
  const providerOf = opts.providerOf ?? getProvider;
  return async (prompt, label) => {
    if (opts.signal?.aborted) throw new ProposerError("run cancelled", false);
    const provider = providerOf(model.provider);
    logger.info(`[harness2] proposer ${label} → ${model.provider}/${model.model} (${prompt.length} chars)`);
    let timer: NodeJS.Timeout | undefined;
    let onCancel: () => void = () => {};
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProposerError(`no reply within ${Math.round(timeoutMs / 1000)} s`, false)), timeoutMs);
      onCancel = () => reject(new ProposerError("run cancelled", false));
      opts.signal?.addEventListener("abort", onCancel, { once: true });
    });
    try {
      const res = await Promise.race([
        provider.generateText([{ role: "user", content: prompt }] as never, model.model, {
          maxTokens: PROPOSER_MAX_TOKENS,
          temperature: 0.7,
          thinkingEnabled: Boolean(model.thinkingEnabled),
        }),
        deadline,
      ]);
      if (!res.text?.trim()) throw new ProposerError("empty reply");
      if (!res.usage?.inputTokens && !res.usage?.outputTokens) throw new ProposerError("reply reported zero token usage (a cut-off generation)");
      return res.text;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onCancel);
    }
  };
}

/**
 * Upstream adoption.json for the reflector: which run was submitted, how it was selected, and the
 * anonymous-id map the selector's reason is written in.
 */
function adoptionBlock(selection: Selection, chosenTreeIsBase: boolean): string {
  const lines = [
    `- submitted: \`${selection.chosenLabel}\`` +
      (selection.chosenLabel.startsWith("base") ? " (a base rollout: the BASE HARNESS, unmodified)" : " (its harness is the candidate of that label above)"),
  ];
  if (chosenTreeIsBase && !selection.chosenLabel.startsWith("base")) lines.push("- the adopted harness is IDENTICAL to the BASE HARNESS");
  lines.push(selection.trivial ? `- selection: no selector call (${selection.why})` : `- selection: blind selector over ${Object.keys(selection.ids).length} anonymous candidates`);
  if (!selection.trivial) {
    lines.push(`- anonymous ids the selector saw: ${Object.entries(selection.ids).map(([id, l]) => `${id} → ${l}`).join(", ")}`);
    if (selection.why) lines.push(`- selector's reason (written in those anonymous ids):\n${selection.why}`);
  }
  return `# ADOPTION\n\n${lines.join("\n")}`;
}

function loadHarnessLibraryContext(
  library: Library,
  taskId: string,
  errors: string[],
): { libraryEntriesBefore: number; libraryText: string } {
  try {
    const libraryEntriesBefore = library.entries().length;
    const libraryText = library.contextText({ exclude: [taskId] });
    return { libraryEntriesBefore, libraryText };
  } catch (error) {
    errors.push(`library read failed, running without it: ${errText(error)}`);
    return { libraryEntriesBefore: 0, libraryText: "" };
  }
}

function recordProposerStageFallbacks(
  result: ModeResult,
  errors: string[],
): boolean {
  const proposerDown = result.stages.filter(
    (s) => s.fellBack && s.error.startsWith("proposer failed"),
  );
  const improverFailed =
    proposerDown.length > 0 && proposerDown.length === result.stages.length;
  if (improverFailed) {
    errors.push(
      `every stage fell back on a proposer failure, so no harness was adapted: ${proposerDown[0].error}`,
    );
  } else {
    for (const s of proposerDown) {
      errors.push(`${s.label} fell back on a proposer failure: ${s.error}`);
    }
  }
  return improverFailed;
}

function resolveSelectionOutcome(
  req: Harness2Request,
  result: ModeResult,
  selection: Selection,
  improverFailed: boolean,
  errors: string[],
) {
  if (selection.error) errors.push(`selection: ${selection.error}`);
  const chosen = selection.chosenLabel
    ? result.rollouts[selection.chosenLabel]
    : undefined;
  const adoptedTree =
    !chosen || selection.chosenLabel.startsWith("base")
      ? req.baseTree
      : result.trees[selection.chosenLabel];
  let status: Harness2Status = "selection-fallback";
  if (improverFailed) status = "improver-failed";
  else if (!chosen) status = "no-output";
  else if (selection.ok) status = "ok";

  const outcome = {
    adoptedTree,
    chosenTreeIsBase: isUnchanged(req.baseTree, adoptedTree),
    output: chosen?.output ?? "",
  };
  return { chosen, adoptedTree, status, outcome };
}

async function reflectAndStoreHarnessExperience(
  req: Harness2Request,
  bp: BenchPrompts,
  base: RunView[],
  result: ModeResult,
  selection: Selection,
  adoptedTree: Tree,
  chosenTreeIsBase: boolean,
  propose: Proposer,
  library: Library,
  budget: number,
  errors: string[],
): Promise<{
  learned: boolean;
  experience: Harness2Result["experience"];
  libraryEntry: string | null;
}> {
  const candidates = result.stages.map((s) => ({
    label: s.label,
    tree: s.tree,
    rollout: result.rollouts[s.label],
  }));
  const reflection =
    buildMission(prompts.experience(bp), {
      current: req.baseTree,
      currentTitle: "BASE HARNESS",
      base,
      pool: candidates,
      decisions: decisionsOf(result.stages),
      diffBase: { name: "base", tree: req.baseTree },
      budget,
    }) + `\n\n${adoptionBlock(selection, chosenTreeIsBase)}`;
  let raw = "";
  try {
    raw = await propose(reflection, "experience");
  } catch (error) {
    errors.push(`experience reflection failed: ${errText(error)}`);
    logger.warn(`[harness2] experience reflection failed: ${errText(error)}`);
  }
  const exp = parseExperience(raw);
  let libraryEntry: string | null = null;
  if (exp.entry) {
    try {
      libraryEntry = library.add(req.taskId, adoptedTree, {
        why: selection.why,
        label: selection.chosenLabel,
        experience: exp.entry,
      });
    } catch (error) {
      errors.push(`library entry not stored: ${errText(error)}`);
    }
  }
  return {
    learned: libraryEntry !== null,
    experience: { ...exp, raw },
    libraryEntry,
  };
}

/**
 * Run one task: base rollouts → recursion → select → reflect → library. `execute` and
 * `propose` are injectable for tests; the route uses the real ones.
 */
export async function runHarness2(
  req: Harness2Request,
  deps: { execute?: Executor; propose?: Proposer; signal?: AbortSignal } & Pick<RecursionDeps, "transportBackoffMs" | "missionCharBudget"> = {},
): Promise<Harness2Result> {
  const k = req.k ?? 1;
  const pool = req.selectionPool ?? "finals";
  const bp: BenchPrompts = { ...req.bench, work: req.bench?.work || req.task };
  const signal = deps.signal;
  const execute = deps.execute ?? makeExecutor(req, { signal });
  const propose =
    deps.propose ?? makeProposer(req.improver ?? DEFAULT_IMPROVER, { signal });
  const errors: string[] = [];
  const library = new Library(req.domain, req.libraryRoot);
  const { libraryEntriesBefore, libraryText } = loadHarnessLibraryContext(
    library,
    req.taskId,
    errors,
  );
  const budget =
    deps.missionCharBudget ??
    (Number(process.env.HARNESS2_MISSION_CHAR_BUDGET) ||
      DEFAULT_MISSION_CHAR_BUDGET);
  const recDeps: RecursionDeps = {
    bp,
    execute,
    propose,
    baseTree: req.baseTree,
    libraryText,
    width: req.width ?? 2,
    transportBackoffMs: deps.transportBackoffMs,
    missionCharBudget: budget,
  };
  const finish = (
    status: Harness2Status,
    result: ModeResult,
    selection: Selection,
    rest: Partial<Harness2Result> = {},
  ): Harness2Result => ({
    taskId: req.taskId,
    domain: req.domain,
    status,
    learned: false,
    errors,
    result,
    selection,
    adoptedTree: req.baseTree,
    chosenTreeIsBase: true,
    output: "",
    experience: { edits: "", entry: null, raw: "" },
    libraryEntry: null,
    libraryEntriesBefore,
    ...rest,
  });

  const base = await rollBase(recDeps, k);
  const emptyResult = (): ModeResult => ({
    mode: req.mode === "sequential" ? "seq" : "agg",
    k,
    stages: [],
    trees: {},
    rollouts: Object.fromEntries(base.map((b) => [b.label, b])),
    finals: [],
    ledger: base.map((b) => b.label),
    similarity: null,
  });
  const noSelection: Selection = {
    ok: false,
    chosenLabel: "",
    why: "",
    ids: {},
    pool,
    trivial: false,
    fallback: false,
  };
  if (signal?.aborted) {
    errors.push("cancelled after the base rollouts");
    return finish("cancelled", emptyResult(), {
      ...noSelection,
      error: "cancelled",
    });
  }
  if (!base.some((b) => b.ok)) {
    errors.push(
      `no base rollout produced anything: ${base.map((b) => `${b.label}: ${b.error || "failed"}`).join("; ")}`,
    );
    return finish("base-failed", emptyResult(), {
      ...noSelection,
      error: "base-failed",
    });
  }

  const result =
    req.mode === "sequential"
      ? await runSequential(k, base, recDeps)
      : await runParallel(k, base, recDeps);
  if (signal?.aborted) {
    errors.push(
      "cancelled during the recursion; no selection or reflection ran",
    );
    return finish("cancelled", result, { ...noSelection, error: "cancelled" });
  }
  const improverFailed = recordProposerStageFallbacks(result, errors);
  const selection = await selectOutput(bp, result, propose, {
    taskId: req.taskId,
    pool,
    seed: req.seed,
    budget,
  });
  const { chosen, adoptedTree, status, outcome } = resolveSelectionOutcome(
    req,
    result,
    selection,
    improverFailed,
    errors,
  );
  if (status !== "ok" || !chosen?.delivered) {
    return finish(status, result, selection, outcome);
  }

  const reflected = await reflectAndStoreHarnessExperience(
    req,
    bp,
    base,
    result,
    selection,
    adoptedTree,
    outcome.chosenTreeIsBase,
    propose,
    library,
    budget,
    errors,
  );
  return finish(status, result, selection, { ...outcome, ...reflected });
}

export type { RunView };
