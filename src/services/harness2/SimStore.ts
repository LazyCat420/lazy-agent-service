/**
 * Self-Improvement Memory (SIM) for Continual Recursive Self-Improvement (CRSI).
 *
 * Implements arXiv:2611.18856 §3.2–3.3 and Appendix D.1–D.3:
 *   m_i = (c_i, [(a_ij, o_ij, p_ij)]_j)
 *
 * Unlike task-indexed `Library.ts` (which stores only winning harnesses per task),
 * SIM groups edits by recurring harness problem `c_i`, preserves negative/missed and
 * superseded attempts, records pre-evaluation `predicted` vs post-evaluation `fixed`/`missed`
 * outcomes, and stamps dynamic `/v1/models` provenance (`modelFamily`, `modelId`, `upstream`).
 *
 * Strictly optimizer-facing: SIM is read only by the Harness² / CRSI Proposer and Selector,
 * never injected into live `vllm-trading-bot` solver prompts (`TradingLearningBoundary`).
 */
import fs from "node:fs";
import path from "node:path";
import { TRADING_MONGO_DB } from "../../../config.ts";
import { modelFamilyOf, type ModelFamily } from "../../platform/models/ModelProfiles.ts";
import logger from "../../utils/logger.ts";
import MongoWrapper from "../../wrappers/MongoWrapper.ts";
import { assertNoGraderVerdicts } from "./HarnessTree.ts";
import { libraryRootOf, slug } from "./Library.ts";

export type SimMemoryCondition = "none" | "problem-only" | "full";

export const SIM_COLLECTION = "harness_sim_problems";
export const SIM_PROMPT_CHAR_CAP = 48_000;

const SECRET_VALUE_RE = /\b(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/g;

export interface SimProvenance {
  domain: string;
  benchmark: string;
  upstream?: string;
  modelFamily: ModelFamily;
  modelId: string;
  agentRole?: string;
  corpusHash?: string;
  round: number;
  recordedAt: string;
}

export interface SimPerModelOutcome {
  modelFamily: ModelFamily;
  modelId: string;
  passed: number;
  total: number;
  avgLoops?: number;
  avgElapsedMs?: number;
}

export interface SimAttempt {
  round: number;
  sample: string;
  accepted: boolean;
  backfilled?: boolean;
  what: string;
  files: string[];
  rationale: string;
  predicted: string[];
  fixed: string[];
  missed: string[];
  passed: number;
  total: number;
  domain: string;
  perModel?: Record<string, SimPerModelOutcome>;
  provenance: SimProvenance;
  supersededByRound?: number;
}

export interface SimProblemEntry {
  id: string;
  name: string;
  openedRound: number;
  attempts: SimAttempt[];
}

export interface SimCarriedFrom {
  arm: string;
  domain: string;
  sourceModelId?: string;
  sourceModelFamily?: ModelFamily;
  into: string;
  targetModelId?: string;
  targetModelFamily?: ModelFamily;
}

export interface SimDocument {
  domain: string;
  nextId: number;
  carriedFrom?: SimCarriedFrom;
  aliases: Record<string, string>;
  problems: SimProblemEntry[];
  updatedAt: string;
}

export interface RecordSimAttemptInput {
  /** Existing problem id (e.g. "P3") or undefined when naming a root cause directly. */
  citedProblemId?: string;
  /** Root-cause hypothesis text `c_i`. Required when opening a new problem. */
  rootCause: string;
  round: number;
  sample: string;
  accepted: boolean;
  what: string;
  files: string[];
  rationale: string;
  predicted: string[];
  fixed: string[];
  missed: string[];
  passed: number;
  total: number;
  domain?: string;
  benchmark?: string;
  upstream?: string;
  modelId: string;
  agentRole?: string;
  corpusHash?: string;
  perModel?: Record<string, SimPerModelOutcome>;
  recordedAt?: string;
}

/** Deterministic root-cause key for exact-match merging (Appendix D.1). */
export function normalizeRootCause(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function sanitizeSimText(text: string): string {
  return text.replace(SECRET_VALUE_RE, "[REDACTED_SECRET]").trim();
}

function uniqueSorted(items: readonly string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))].sort();
}

function emptySimDocument(domain: string): SimDocument {
  return {
    domain: slug(domain),
    nextId: 1,
    aliases: {},
    problems: [],
    updatedAt: new Date().toISOString(),
  };
}

function resolveAlias(aliases: Record<string, string>, id: string): string {
  let cur = id.trim();
  const visited = new Set<string>();
  while (aliases[cur] && !visited.has(cur)) {
    visited.add(cur);
    cur = aliases[cur];
  }
  return cur;
}

function validateNoGraderLeak(input: RecordSimAttemptInput): void {
  const joined = [input.rootCause, input.what, input.rationale].join("\n");
  assertNoGraderVerdicts({ "SIM.json": joined });
}

function buildSimAttempt(docDomain: string, input: RecordSimAttemptInput): SimAttempt {
  const modelId = input.modelId.trim() || "unknown";
  const domain = (input.domain || docDomain).trim();
  const recordedAt = input.recordedAt || new Date().toISOString();
  return {
    round: input.round,
    sample: input.sample.trim() || "s1",
    accepted: input.accepted,
    what: sanitizeSimText(input.what),
    files: uniqueSorted(input.files),
    rationale: sanitizeSimText(input.rationale),
    predicted: uniqueSorted(input.predicted),
    fixed: uniqueSorted(input.fixed),
    missed: uniqueSorted(input.missed),
    passed: input.passed,
    total: input.total,
    domain,
    ...(input.perModel ? { perModel: input.perModel } : {}),
    provenance: {
      domain,
      benchmark: (input.benchmark || domain).trim(),
      ...(input.upstream ? { upstream: input.upstream } : {}),
      modelFamily: modelFamilyOf(modelId),
      modelId,
      ...(input.agentRole ? { agentRole: input.agentRole } : {}),
      ...(input.corpusHash ? { corpusHash: input.corpusHash } : {}),
      round: input.round,
      recordedAt,
    },
  };
}

function markSupersededAttempts(entry: SimProblemEntry, newAttempt: SimAttempt): void {
  if (!newAttempt.accepted || newAttempt.files.length === 0) return;
  const touched = new Set(newAttempt.files);
  for (const prev of entry.attempts) {
    if (
      prev.accepted &&
      prev.supersededByRound === undefined &&
      prev.round < newAttempt.round &&
      prev.files.some((f) => touched.has(f))
    ) {
      prev.supersededByRound = newAttempt.round;
    }
  }
}

function findOrCreateProblem(
  doc: SimDocument,
  citedProblemId: string | undefined,
  rootCause: string,
  round: number,
): SimProblemEntry {
  if (citedProblemId?.trim()) {
    const targetId = resolveAlias(doc.aliases, citedProblemId);
    const byId = doc.problems.find((p) => p.id === targetId);
    if (byId) return byId;
  }
  const cleanCause = sanitizeSimText(rootCause);
  if (!cleanCause) {
    throw new Error("SIM attempt requires a non-empty rootCause when opening or matching a problem");
  }
  const key = normalizeRootCause(cleanCause);
  const byName = doc.problems.find((p) => normalizeRootCause(p.name) === key);
  if (byName) return byName;

  const created: SimProblemEntry = {
    id: `P${doc.nextId++}`,
    name: cleanCause,
    openedRound: round,
    attempts: [],
  };
  doc.problems.push(created);
  return created;
}

/**
 * Deterministic merge of entries with identical normalized root-cause text (Appendix D.1).
 * Keeps the earliest problem ID, appends all attempts in `(round, sample)` order, and records `aliases`.
 */
export function mergeIdenticalRootCauses(doc: SimDocument): SimDocument {
  const canonicalByKey = new Map<string, SimProblemEntry>();
  const kept: SimProblemEntry[] = [];
  for (const entry of doc.problems) {
    const key = normalizeRootCause(entry.name);
    const existing = canonicalByKey.get(key);
    if (!existing) {
      canonicalByKey.set(key, entry);
      kept.push(entry);
      continue;
    }
    doc.aliases[entry.id] = existing.id;
    existing.openedRound = Math.min(existing.openedRound, entry.openedRound);
    existing.attempts.push(...entry.attempts);
    existing.attempts.sort((a, b) => a.round - b.round || a.sample.localeCompare(b.sample));
  }
  doc.problems = kept;
  return doc;
}

function formatPerModel(perModel?: Record<string, SimPerModelOutcome>): string {
  if (!perModel || Object.keys(perModel).length === 0) return "";
  const parts = Object.entries(perModel)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, m]) => {
      const loops = m.avgLoops !== undefined ? `, avgLoops=${m.avgLoops.toFixed(1)}` : "";
      return `${key}(${m.modelFamily}/${m.modelId}): ${m.passed}/${m.total}${loops}`;
    });
  return ` | per_model=[${parts.join("; ")}]`;
}

function truncateField(value: string, maxLen: number, tag: string): string {
  return value.length > maxLen ? `${value.slice(0, maxLen)}…[${tag}]` : value;
}

function renderAttemptLine(a: SimAttempt, level: 0 | 1 | 2): string {
  const sup = a.supersededByRound !== undefined ? ` (later revised in r${a.supersededByRound})` : "";
  if (level >= 2) {
    return `  - [r${a.round}/${a.sample}] accepted=${a.accepted}${sup} | passed=${a.passed}/${a.total} | fixed=${a.fixed.length} missed=${a.missed.length}`;
  }
  const what = level >= 1 ? truncateField(a.what, 140, "compacted") : a.what;
  const rationale = level >= 1 ? truncateField(a.rationale, 140, "compacted") : a.rationale;
  const files = a.files.length ? a.files.join(", ") : "(config)";
  return [
    `  - [r${a.round}/${a.sample}] accepted=${a.accepted}${sup} | domain=${a.domain} | model=${a.provenance.modelFamily}/${a.provenance.modelId}`,
    `    files: ${files}`,
    `    what: ${what}`,
    `    rationale: ${rationale}`,
    `    outcomes: passed=${a.passed}/${a.total} | predicted=[${a.predicted.join(", ")}] | fixed=[${a.fixed.join(", ")}] | missed=[${a.missed.join(", ")}]${formatPerModel(a.perModel)}`,
  ].join("\n");
}

function clampSimBudget(text: string, capChars: number): string {
  if (capChars <= 0) return "";
  if (text.length <= capChars) return text;
  const suffix = "\n…[SIM compacted to budget]";
  if (capChars <= suffix.length) return text.slice(0, capChars);
  return `${text.slice(0, capChars - suffix.length)}${suffix}`;
}

function renderFullSim(doc: SimDocument, capChars: number): string {
  if (doc.problems.length === 0 || capChars <= 0) return "";
  const levelMap = new Map<string, 0 | 1 | 2>();
  const supersededRefs: string[] = [];
  const allRefs: string[] = [];
  for (const p of doc.problems) {
    for (let idx = 0; idx < p.attempts.length; idx++) {
      const ref = `${p.id}#${idx}`;
      allRefs.push(ref);
      if (p.attempts[idx].supersededByRound !== undefined) supersededRefs.push(ref);
    }
  }

  const build = (trimNames: boolean): string => {
    const header = [
      "# SELF-IMPROVEMENT MEMORY (SIM)",
      ...(doc.carriedFrom
        ? [
            `Carried from: arm=${doc.carriedFrom.arm} (${doc.carriedFrom.domain}, model=${doc.carriedFrom.sourceModelFamily ?? "?"}/${doc.carriedFrom.sourceModelId ?? "?"}) -> ${doc.carriedFrom.into} (model=${doc.carriedFrom.targetModelFamily ?? "?"}/${doc.carriedFrom.targetModelId ?? "?"})`,
          ]
        : []),
      ...(Object.keys(doc.aliases).length
        ? [`Merged aliases: ${Object.entries(doc.aliases).map(([k, v]) => `${k}->${v}`).join(", ")}`]
        : []),
      "",
    ];
    const blocks = doc.problems.map((p) => {
      const title = trimNames ? truncateField(p.name, 140, "trimmed") : p.name;
      const rows = p.attempts.map((a, idx) => renderAttemptLine(a, levelMap.get(`${p.id}#${idx}`) ?? 0));
      return `## ${p.id} (opened r${p.openedRound}): ${title}\n${rows.join("\n")}`;
    });
    return [...header, ...blocks].join("\n\n");
  };

  let rendered = build(false);
  for (const ref of supersededRefs) {
    if (rendered.length <= capChars) return rendered;
    levelMap.set(ref, 1);
    rendered = build(false);
  }
  for (const ref of allRefs) {
    if (rendered.length <= capChars) return rendered;
    levelMap.set(ref, 2);
    rendered = build(true);
  }
  return clampSimBudget(rendered, capChars);
}

/** Render SIM according to the active transfer condition (Cold/Transfer = none, Problem-Only, Full SIM). */
export function renderSimPromptBlock(
  doc: SimDocument,
  condition: SimMemoryCondition = "full",
  capChars: number = SIM_PROMPT_CHAR_CAP,
): string {
  if (condition === "none" || doc.problems.length === 0 || capChars <= 0) return "";
  if (condition === "problem-only") {
    const lines = doc.problems.map((p) => `- ${p.id} (opened r${p.openedRound}): ${p.name}`);
    return clampSimBudget(`# SELF-IMPROVEMENT MEMORY (ROOT CAUSES ONLY)\n\n${lines.join("\n")}`, capChars);
  }
  return renderFullSim(doc, capChars);
}

export interface SimStoreOptions {
  filePath?: string;
  useMongo?: boolean;
  mongoDbName?: string;
}

/**
 * Persistent Self-Improvement Memory store.
 * Uses local JSON atomic writes when `filePath` or `HARNESS2_SIM_PATH` is set (hermetic tests/CLI),
 * and syncs with MongoDB `trading_bot.harness_sim_problems` when `useMongo` is enabled and connected.
 */
export class SimStore {
  readonly domain: string;
  readonly filePath: string;
  private readonly useMongo: boolean;
  private readonly mongoDbName: string;
  private doc: SimDocument;
  private loaded = false;

  constructor(domain: string, opts: SimStoreOptions = {}) {
    this.domain = slug(domain);
    const rootDir = process.env.HARNESS2_SIM_PATH || libraryRootOf();
    this.filePath = opts.filePath || path.join(rootDir, this.domain, "SIM.json");
    this.useMongo = opts.useMongo ?? (!opts.filePath && !process.env.HARNESS2_SIM_PATH);
    this.mongoDbName = opts.mongoDbName || TRADING_MONGO_DB;
    this.doc = this.readLocalOrEmpty();
  }

  private readLocalOrEmpty(): SimDocument {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as SimDocument;
        if (parsed && Array.isArray(parsed.problems)) return parsed;
      }
    } catch (error) {
      logger.warn(`[SimStore] failed reading local SIM ${this.filePath}: ${String(error)}`);
    }
    return emptySimDocument(this.domain);
  }

  private writeLocal(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpFile = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpFile, `${JSON.stringify(this.doc, null, 2)}\n`, "utf8");
    fs.renameSync(tmpFile, this.filePath);
  }

  private mergeRemoteIntoLocal(remote: SimDocument): void {
    if (this.doc.problems.length === 0) {
      this.doc = remote;
      return;
    }
    const combined: SimDocument = structuredClone(remote);
    combined.aliases = { ...remote.aliases, ...this.doc.aliases };
    for (const localProb of this.doc.problems) {
      const target = findOrCreateProblem(combined, undefined, localProb.name, localProb.openedRound);
      for (const att of localProb.attempts) {
        const dup = target.attempts.some(
          (x) => x.round === att.round && x.sample === att.sample && x.what === att.what,
        );
        if (!dup) target.attempts.push(structuredClone(att));
      }
    }
    combined.nextId = Math.max(remote.nextId, this.doc.nextId, combined.problems.length + 1);
    this.doc = mergeIdenticalRootCauses(combined);
  }

  /** Hydrate from MongoDB when available; merges with any in-memory/local entries so history is never lost. */
  async load(): Promise<SimDocument> {
    if (this.useMongo) {
      try {
        const db = MongoWrapper.getDb(this.mongoDbName);
        if (db) {
          const stored = await db.collection(SIM_COLLECTION).findOne({ _id: this.domain as never });
          if (stored && Array.isArray((stored as unknown as SimDocument).problems)) {
            const { _id: _ignored, ...rest } = stored as Record<string, unknown>;
            this.mergeRemoteIntoLocal(rest as unknown as SimDocument);
          }
        }
      } catch (error) {
        logger.warn(`[SimStore] Mongo load fallback to local for ${this.domain}: ${String(error)}`);
      }
    }
    this.loaded = true;
    return this.snapshot();
  }

  /** Persist to local JSON and (when enabled) upsert to MongoDB `harness_sim_problems`. */
  async save(): Promise<void> {
    this.doc.updatedAt = new Date().toISOString();
    this.writeLocal();
    if (!this.useMongo) return;
    try {
      const db = MongoWrapper.getDb(this.mongoDbName);
      if (db) {
        await db
          .collection(SIM_COLLECTION)
          .updateOne({ _id: this.domain as never }, { $set: { ...this.doc } }, { upsert: true });
      }
    } catch (error) {
      logger.warn(`[SimStore] Mongo save warning for ${this.domain}: ${String(error)}`);
    }
  }

  snapshot(): SimDocument {
    return structuredClone(this.doc);
  }

  /** Append one selected candidate's outcome (including missed/regressed attempts) and persist. */
  async recordAttempt(input: RecordSimAttemptInput): Promise<SimProblemEntry> {
    validateNoGraderLeak(input);
    if (this.useMongo && !this.loaded) {
      await this.load();
    }
    const entry = findOrCreateProblem(this.doc, input.citedProblemId, input.rootCause, input.round);
    const attempt = buildSimAttempt(this.domain, input);
    markSupersededAttempts(entry, attempt);
    entry.attempts.push(attempt);
    mergeIdenticalRootCauses(this.doc);
    await this.save();
    return structuredClone(entry);
  }

  /** Carry this source SIM into a target CRSI continuation run (cross-model or cross-dataset). */
  async carryInto(
    targetStore: SimStore,
    meta: { sourceArm: string; targetRun: string; sourceModelId?: string; targetModelId?: string },
  ): Promise<SimDocument> {
    const carried = this.snapshot();
    carried.domain = targetStore.domain;
    carried.carriedFrom = {
      arm: meta.sourceArm,
      domain: this.domain,
      ...(meta.sourceModelId
        ? { sourceModelId: meta.sourceModelId, sourceModelFamily: modelFamilyOf(meta.sourceModelId) }
        : {}),
      into: meta.targetRun,
      ...(meta.targetModelId
        ? { targetModelId: meta.targetModelId, targetModelFamily: modelFamilyOf(meta.targetModelId) }
        : {}),
    };
    targetStore.doc = carried;
    await targetStore.save();
    return targetStore.snapshot();
  }

  renderPrompt(condition: SimMemoryCondition = "full", capChars: number = SIM_PROMPT_CHAR_CAP): string {
    return renderSimPromptBlock(this.doc, condition, capChars);
  }
}
