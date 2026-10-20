/**
 * Harness² for lazy-agent-service: one task through task-level recursion
 * (Propose–Probe–Compose), blind selection, experience reflection, and the
 * harnessing-level library update.
 *
 * Executor: `runSingleModel` (the benchmark trial path) with the materialized harness as
 * the system prompt. Proposer/selector/reflector: `provider.generateText`.
 */
import { runSingleModel, type ModelResult } from "../BenchmarkService.ts";
import { getProvider } from "../../providers/index.ts";
import logger from "../../utils/logger.ts";
import { materialize, renderTree, type Tree } from "./HarnessTree.ts";
import { Library, type Experience } from "./Library.ts";
import * as prompts from "./Prompts.ts";
import type { BenchPrompts } from "./Prompts.ts";
import { buildMission, rollBase, runParallel, runSequential, type Executor, type ModeResult, type Proposer, type RunView } from "./Recursion.ts";

export interface ModelRef {
  provider: string;
  model: string;
  thinkingEnabled?: boolean;
  /** Run the solver through the agentic loop with tools. */
  toolsEnabled?: boolean;
}

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
  /** Proposer/composer/selector/reflector model; defaults to the solver. */
  improver?: ModelRef;
  width?: number;
  seed?: number;
  libraryRoot?: string;
  project?: string;
  username?: string;
}

export interface Selection {
  chosenLabel: string;
  why: string;
  /** Anonymous id → label, for audit. */
  ids: Record<string, string>;
  error?: string;
}

export interface Harness2Result {
  taskId: string;
  domain: string;
  result: ModeResult;
  selection: Selection;
  adoptedTree: Tree;
  output: string;
  experience: { edits: string; entry: Experience | null; raw: string };
  libraryEntry: string | null;
  libraryEntriesBefore: number;
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s);

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
  return { edits, entry: entry.cue.trim() && entry.lesson.trim() && entry.evidence.trim() ? entry : null };
}

/** Blind selection over the base rollouts and the finals (upstream "mixed" pool). */
export async function selectOutput(bp: BenchPrompts, result: ModeResult, propose: Proposer, seed: number): Promise<Selection> {
  const labels = [...result.ledger.filter((l) => l.startsWith("base")), ...result.finals].filter((l) => result.rollouts[l]?.delivered);
  if (!labels.length) return { chosenLabel: "base1", why: "", ids: {}, error: "no candidate delivered an output" };
  if (labels.length === 1) return { chosenLabel: labels[0], why: "only one candidate delivered", ids: { a1: labels[0] } };
  const order = shuffle(labels, seed);
  const ids = Object.fromEntries(order.map((l, i) => [`a${i + 1}`, l]));
  const body =
    prompts.select(bp, order.length) +
    "\n\n# THE REQUEST\n\n" +
    bp.work +
    "\n\n# CANDIDATES\n\n" +
    Object.entries(ids).map(([id, l]) => `## ${id}\n\n${truncate(result.rollouts[l].output, 12_000)}`).join("\n\n");
  try {
    const reply = await propose(body, "select");
    const id = /```choice\s*\n?\s*([A-Za-z0-9_-]+)\s*\n?```/.exec(reply)?.[1];
    const why = /<why>([\s\S]*?)<\/why>/.exec(reply)?.[1].trim() ?? "";
    if (id && ids[id]) return { chosenLabel: ids[id], why, ids };
    return { chosenLabel: order[0], why, ids, error: `selector returned no valid id (${id ?? "none"}); took ${order[0]}` };
  } catch (error) {
    return { chosenLabel: order[0], why: "", ids, error: `selector failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function trajectoryOf(r: ModelResult): string {
  const lines: string[] = [];
  if (r.thinking) lines.push(`thinking (excerpt): ${truncate(r.thinking, 1500)}`);
  for (const call of r.toolCalls || []) {
    lines.push(`tool ${call.name}(${truncate(JSON.stringify(call.args ?? {}), 400)}) -> ${call.status}: ${truncate(typeof call.result === "string" ? call.result : JSON.stringify(call.result ?? null), 800)}`);
  }
  if (r.error) lines.push(`error: ${r.error}`);
  lines.push(`final output:\n${truncate(r.response || "", 6000) || "(empty)"}`);
  return lines.join("\n");
}

export function makeExecutor(req: Harness2Request): Executor {
  return async (tree, label) => {
    const r = await runSingleModel(
      { id: `harness2-${req.taskId}-${label}`, name: `harness2 ${label}`, prompt: req.task, systemPrompt: materialize(tree), temperature: 0.7, maxTokens: 8192 },
      { provider: req.solver.provider, model: req.solver.model, label, thinkingEnabled: Boolean(req.solver.thinkingEnabled), toolsEnabled: Boolean(req.solver.toolsEnabled) },
      req.project || "harness2",
      req.username || "harness2",
    );
    const output = r.response || "";
    return { ok: !r.error, delivered: !r.error && output.trim().length > 0, output, trajectory: trajectoryOf(r), error: r.error || "" };
  };
}

export function makeProposer(model: ModelRef): Proposer {
  return async (prompt, label) => {
    const provider = getProvider(model.provider);
    logger.info(`[harness2] proposer ${label} → ${model.provider}/${model.model} (${prompt.length} chars)`);
    const res = await provider.generateText([{ role: "user", content: prompt }] as never, model.model, {
      maxTokens: 16_384,
      temperature: 0.7,
      thinkingEnabled: Boolean(model.thinkingEnabled),
    });
    return res.text || "";
  };
}

/**
 * Run one task: base rollouts → recursion → select → reflect → library. `execute` and
 * `propose` are injectable for tests; the route uses the real ones.
 */
export async function runHarness2(
  req: Harness2Request,
  deps: { execute?: Executor; propose?: Proposer } = {},
): Promise<Harness2Result> {
  const k = req.k ?? 1;
  const bp: BenchPrompts = { ...req.bench, work: req.bench?.work || req.task };
  const execute = deps.execute ?? makeExecutor(req);
  const propose = deps.propose ?? makeProposer(req.improver ?? req.solver);
  const library = new Library(req.domain, req.libraryRoot);
  const libraryEntriesBefore = library.entries().length;
  const recDeps = { bp, execute, propose, baseTree: req.baseTree, libraryText: library.contextText(), width: req.width ?? 2 };

  const base = await rollBase(recDeps, k);
  const result = req.mode === "sequential" ? await runSequential(k, base, recDeps) : await runParallel(k, base, recDeps);
  const selection = await selectOutput(bp, result, propose, req.seed ?? 0);
  const adoptedTree = selection.chosenLabel.startsWith("base") ? req.baseTree : result.trees[selection.chosenLabel];

  const pool = result.stages.map((s) => ({ label: s.label, tree: s.tree, rollout: result.rollouts[s.label] }));
  const decisions = Object.fromEntries(result.stages.map((s) => [s.label, s.notes || s.error]));
  const reflection =
    buildMission(prompts.experience(bp), { current: req.baseTree, base, pool, decisions }) +
    `\n\n# SUBMITTED\n\nThe submitted output came from \`${selection.chosenLabel}\`.` +
    (selection.why ? `\nSelector's reason:\n${selection.why}` : "") +
    `\n\n# BASE HARNESS (context/base_harness)\n\n${renderTree(req.baseTree)}`;
  let raw = "";
  try {
    raw = await propose(reflection, "experience");
  } catch (error) {
    logger.warn(`[harness2] experience reflection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const exp = parseExperience(raw);
  const libraryEntry = exp.entry
    ? library.add(req.taskId, adoptedTree, { why: selection.why, label: selection.chosenLabel, experience: exp.entry })
    : null;

  return {
    taskId: req.taskId,
    domain: req.domain,
    result,
    selection,
    adoptedTree,
    output: result.rollouts[selection.chosenLabel]?.output ?? "",
    experience: { ...exp, raw },
    libraryEntry,
    libraryEntriesBefore,
  };
}

export type { RunView };
