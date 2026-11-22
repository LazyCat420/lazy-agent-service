/** Learned opening tool stacks and recurring read-only sequences across all active agents.
 *
 * 1) Opening bundles (`learnStacks` / `openingStack`): ticker-keyed read tools a role calls in
 *    nearly every successful run, shown as one compact system line so the model batches them
 *    in its first response.
 * 2) Recurring sequences (`learnSequences`): ordered read-only bigrams/trigrams mined from both
 *    `agent_tool_telemetry` and `tool_usage_stats` across ALL agents (v3_*, user_chat,
 *    research_worker, quant_analyst, etc.), excluding probe/synthetic telemetry, and persisted
 *    to Mongo `learned_tool_stacks` for the Tools dashboard and system hints.
 */
import fs from "node:fs";
import path from "node:path";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { TRADING_MONGO_DB } from "../../config.ts";
import logger from "../logger.ts";
import { modelFamilyOf } from "../platform/models/ModelProfiles.ts";
import { stripMcpPrefix } from "./McpPrefix.ts";
import { READ_ONLY_TOOLS, REUSABLE_READ_TOOLS } from "./LocalToolRouter.ts";
import { PromotionController } from "./PromotionController.ts";
import { openingStackLine, tradingShimProfileId } from "./TradingToolProtocol.ts";

/** Reusable data reads keyed by the ticker; web search and scraping take free text. */
const STACKABLE = new Set(
  [...REUSABLE_READ_TOOLS, "get_sec_filings"].filter(
    (t) => t !== "lazy_web_search" && t !== "scrape_url",
  ),
);
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_RUNS = 30;
const MIN_PRESENCE = 0.9;
const MAX_STACK = 4;
const DEFAULT_SEQ_MIN_RUNS = 5;
const DEFAULT_SEQ_MIN_COUNT = 3;
const DEFAULT_SEQ_MIN_SUPPORT = 0.4;
const MAX_SEQUENCES_PER_GROUP = 3;
const REFRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const PROBE_SERVICE_SOURCES = new Set([
  "audit-probe",
  "boundary-probe",
  "contract-test",
  "probe",
  "manual-probe",
]);

export interface RunRecord {
  agent: string;
  cycleId: string;
  ticker: string;
  model?: string;
}

export interface ToolUseRecord extends RunRecord {
  tool: string;
  argsHash: string;
  timestamp?: number | Date;
  success?: boolean;
  serviceSource?: string;
}

export interface LearnedSequence {
  tools: string[];
  count: number;
  support: number;
  confidence: number;
  avgGapMs?: number;
}

export interface LearnedToolStackEntry {
  agent_name: string;
  opening_bundle: string[];
  sequences: Array<{
    tools: string[];
    count: number;
    support: number;
    confidence: number;
    avg_gap_ms?: number;
  }>;
  sample_runs: number;
}

let cachedCatalogReadTools: Set<string> | null = null;
function loadReadOnlyCatalogTools(): Set<string> {
  if (cachedCatalogReadTools) return cachedCatalogReadTools;
  const allowed = new Set<string>(READ_ONLY_TOOLS);
  try {
    const schemaPath = path.resolve(process.cwd(), "tool_schemas.json");
    if (fs.existsSync(schemaPath)) {
      const parsed = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as Array<{
        name?: string;
        permission?: string;
      }>;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const perm = typeof item?.permission === "string" ? item.permission.toLowerCase() : "";
          if (item?.name && (perm === "read_only" || perm === "read" || perm === "readonly")) {
            allowed.add(stripMcpPrefix(item.name));
          }
        }
      }
    }
  } catch {
    // Fall back to static READ_ONLY_TOOLS when schema file is unavailable in tests.
  }
  cachedCatalogReadTools = allowed;
  return allowed;
}

function addRunToGroup(groups: Map<string, Set<string>>, key: string, runId: string): void {
  const set = groups.get(key) ?? new Set<string>();
  set.add(runId);
  groups.set(key, set);
}

function computeStackForGroup(
  agentRuns: Set<string>,
  toolPresence: Map<string, Set<string>> | undefined,
): string[] | null {
  if (agentRuns.size < MIN_RUNS || !toolPresence) return null;
  const stack = [...toolPresence]
    .map(([tool, seen]) => ({ tool, share: seen.size / agentRuns.size }))
    .filter(({ share }) => share >= MIN_PRESENCE)
    .sort((a, b) => b.share - a.share || a.tool.localeCompare(b.tool))
    .slice(0, MAX_STACK)
    .map(({ tool }) => tool);
  return stack.length >= 2 ? stack : null;
}

/** Stack per role (and per `role|modelFamily` when model identity is recorded): stackable tools
 * the model itself called in at least MIN_PRESENCE of successful runs, most frequent first.
 * Roles/families with fewer than MIN_RUNS runs or fewer than two qualifying tools get none. */
export function learnStacks(runs: RunRecord[], uses: ToolUseRecord[]): Map<string, string[]> {
  const runsByKey = new Map<string, Set<string>>();
  const runFamilies = new Map<string, string>();
  for (const r of runs) {
    const runId = `${r.cycleId}|${r.ticker}`;
    addRunToGroup(runsByKey, r.agent, runId);
    const family = r.model ? modelFamilyOf(r.model) : "unknown";
    if (family !== "unknown") {
      const famKey = `${r.agent}|${family}`;
      addRunToGroup(runsByKey, famKey, runId);
      runFamilies.set(`${r.agent}|${runId}`, famKey);
    }
  }
  const present = new Map<string, Map<string, Set<string>>>();
  const recordPresence = (groupKey: string, tool: string, runId: string) => {
    if (!runsByKey.get(groupKey)?.has(runId)) return;
    const byTool = present.get(groupKey) ?? new Map<string, Set<string>>();
    byTool.set(tool, (byTool.get(tool) ?? new Set<string>()).add(runId));
    present.set(groupKey, byTool);
  };
  for (const u of uses) {
    if (u.argsHash.startsWith("autoroute:")) continue;
    if (u.success === false) continue;
    const tool = stripMcpPrefix(u.tool);
    const runId = `${u.cycleId}|${u.ticker}`;
    if (!STACKABLE.has(tool)) continue;
    recordPresence(u.agent, tool, runId);
    const famKey = runFamilies.get(`${u.agent}|${runId}`);
    if (famKey) recordPresence(famKey, tool, runId);
  }
  const stacks = new Map<string, string[]>();
  for (const [groupKey, groupRuns] of runsByKey) {
    const stack = computeStackForGroup(groupRuns, present.get(groupKey));
    if (stack) stacks.set(groupKey, stack);
  }
  return stacks;
}

function toTimestampMs(ts: number | Date | undefined, fallbackIdx: number): number | undefined {
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  void fallbackIdx;
  return undefined;
}

function isSubsumedByLonger(seqKey: string, selectedKeys: string[]): boolean {
  const parts = seqKey.split(">");
  if (parts.length !== 2) return false;
  return selectedKeys.some((longer) => longer.split(">").length === 3 && longer.includes(seqKey));
}

type NgramStat = { tools: string[]; runs: Set<string>; gapSum: number; gapN: number };

function recordRunStartAndNgrams(
  deduped: Array<{ tool: string; tsMs?: number }>,
  runId: string,
  ngramStats: Map<string, NgramStat>,
  startCounts: Map<string, Set<string>>,
): void {
  const seenStarts = new Set<string>();
  const seenNgrams = new Set<string>();
  for (let i = 0; i < deduped.length; i++) {
    const firstTool = deduped[i].tool;
    if (!seenStarts.has(firstTool)) {
      seenStarts.add(firstTool);
      addRunToGroup(startCounts, firstTool, runId);
    }
    for (const len of [2, 3] as const) {
      if (i + len > deduped.length) continue;
      const slice = deduped.slice(i, i + len);
      const tools = slice.map((s) => s.tool);
      if (new Set(tools).size !== len) continue;
      const key = tools.join(">");
      if (seenNgrams.has(key)) continue;
      seenNgrams.add(key);
      const stat = ngramStats.get(key) ?? { tools, runs: new Set<string>(), gapSum: 0, gapN: 0 };
      stat.runs.add(runId);
      const t0 = slice[0].tsMs;
      const tLast = slice[len - 1].tsMs;
      if (t0 !== undefined && tLast !== undefined && tLast >= t0) {
        stat.gapSum += tLast - t0;
        stat.gapN += 1;
      }
      ngramStats.set(key, stat);
    }
  }
}

function dedupeRunEvents(
  rawEvents: Array<{ tool: string; tsMs?: number }>,
): Array<{ tool: string; tsMs?: number }> {
  const sorted = [...rawEvents].sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0));
  const deduped: Array<{ tool: string; tsMs?: number }> = [];
  for (const ev of sorted) {
    if (deduped.length === 0 || deduped[deduped.length - 1].tool !== ev.tool) {
      deduped.push(ev);
    }
  }
  return deduped;
}

function scoreGroupSequences(
  groupRuns: Set<string>,
  perRunCalls: Map<string, Array<{ tool: string; tsMs?: number }>>,
  minRuns: number,
  minCount: number,
  minSupport: number,
): LearnedSequence[] {
  if (groupRuns.size < minRuns) return [];
  const totalRuns = groupRuns.size;
  const ngramStats = new Map<string, NgramStat>();
  const startCounts = new Map<string, Set<string>>();

  for (const runId of groupRuns) {
    const rawEvents = perRunCalls.get(runId);
    if (rawEvents && rawEvents.length > 0) {
      recordRunStartAndNgrams(dedupeRunEvents(rawEvents), runId, ngramStats, startCounts);
    }
  }

  const effectiveMinCount = Math.max(minCount, Math.ceil(totalRuns * minSupport));
  const candidates = [...ngramStats.entries()]
    .filter(([, s]) => s.runs.size >= effectiveMinCount)
    .map(([key, s]) => {
      const startTotal = Math.max(1, startCounts.get(s.tools[0])?.size ?? s.runs.size);
      const support = s.runs.size / totalRuns;
      const confidence = s.runs.size / startTotal;
      return {
        key,
        seq: {
          tools: s.tools,
          count: s.runs.size,
          support: Number(support.toFixed(4)),
          confidence: Number(confidence.toFixed(4)),
          ...(s.gapN > 0 ? { avgGapMs: Math.round(s.gapSum / s.gapN) } : {}),
        } satisfies LearnedSequence,
      };
    })
    .sort(
      (a, b) =>
        b.seq.tools.length - a.seq.tools.length ||
        b.seq.count - a.seq.count ||
        a.key.localeCompare(b.key),
    );

  const chosen: LearnedSequence[] = [];
  const chosenKeys: string[] = [];
  for (const cand of candidates) {
    if (isSubsumedByLonger(cand.key, chosenKeys)) continue;
    chosen.push(cand.seq);
    chosenKeys.push(cand.key);
    if (chosen.length >= MAX_SEQUENCES_PER_GROUP) break;
  }
  return chosen;
}

/** Mine ordered read-only tool bigrams/trigrams across all roles (not restricted to `v3_*`). */
export function learnSequences(
  runs: RunRecord[],
  uses: ToolUseRecord[],
  opts?: { minRuns?: number; minCount?: number; minSupport?: number },
): Map<string, LearnedSequence[]> {
  const minRuns = opts?.minRuns ?? DEFAULT_SEQ_MIN_RUNS;
  const minCount = opts?.minCount ?? DEFAULT_SEQ_MIN_COUNT;
  const minSupport = opts?.minSupport ?? DEFAULT_SEQ_MIN_SUPPORT;
  const readTools = loadReadOnlyCatalogTools();

  const runsByKey = new Map<string, Set<string>>();
  const runFamilies = new Map<string, string>();
  for (const r of runs) {
    const runId = `${r.cycleId}|${r.ticker}`;
    addRunToGroup(runsByKey, r.agent, runId);
    const family = r.model ? modelFamilyOf(r.model) : "unknown";
    if (family !== "unknown") {
      const famKey = `${r.agent}|${family}`;
      addRunToGroup(runsByKey, famKey, runId);
      runFamilies.set(`${r.agent}|${runId}`, famKey);
    }
  }

  const eventsByKey = new Map<string, Map<string, Array<{ tool: string; tsMs?: number }>>>();
  const appendEvent = (groupKey: string, runId: string, ev: { tool: string; tsMs?: number }) => {
    if (!runsByKey.get(groupKey)?.has(runId)) return;
    const byRun = eventsByKey.get(groupKey) ?? new Map<string, Array<{ tool: string; tsMs?: number }>>();
    const list = byRun.get(runId) ?? [];
    list.push(ev);
    byRun.set(runId, list);
    eventsByKey.set(groupKey, byRun);
  };

  uses.forEach((u, idx) => {
    if (u.argsHash.startsWith("autoroute:")) return;
    if (u.success === false) return;
    const tool = stripMcpPrefix(u.tool);
    if (!readTools.has(tool)) return;
    const runId = `${u.cycleId}|${u.ticker}`;
    const tsMs = toTimestampMs(u.timestamp, idx);
    const ev = { tool, ...(tsMs !== undefined ? { tsMs } : {}) };
    appendEvent(u.agent, runId, ev);
    const famKey = runFamilies.get(`${u.agent}|${runId}`);
    if (famKey) appendEvent(famKey, runId, ev);
  });

  const out = new Map<string, LearnedSequence[]>();
  for (const [groupKey, groupRuns] of runsByKey) {
    const perRun = eventsByKey.get(groupKey);
    if (!perRun) continue;
    const seqs = scoreGroupSequences(groupRuns, perRun, minRuns, minCount, minSupport);
    if (seqs.length > 0) out.set(groupKey, seqs);
  }
  return out;
}

let learned = new Map<string, string[]>();
let learnedSeqs = new Map<string, LearnedSequence[]>();
let learnedSampleCounts = new Map<string, number>();
let nextRefreshAt = 0;

function isProbeRecord(doc: Record<string, unknown>): boolean {
  const src = String(doc.service_source ?? "").trim().toLowerCase();
  if (src && PROBE_SERVICE_SOURCES.has(src)) return true;
  const cid = String(doc.cycle_id ?? "").trim().toLowerCase();
  return /^(?:cycle-)?(?:audit|probe|synthetic|replay)-|^probe-boundary-/.test(cid);
}

function normalizeDocRun(d: Record<string, unknown>): RunRecord {
  return {
    agent: String(d.agent_name || "unknown"),
    cycleId: String(d.cycle_id ?? d.conversation_id ?? "default"),
    ticker: String(d.ticker ?? ""),
    model: typeof d.model_used === "string" ? d.model_used : undefined,
  };
}

function normalizeDocUse(d: Record<string, unknown>): ToolUseRecord {
  const rawTs = d.called_at ?? d.timestamp ?? d.created_at;
  const ts =
    rawTs instanceof Date
      ? rawTs
      : typeof rawTs === "string" || typeof rawTs === "number"
        ? new Date(rawTs)
        : undefined;
  return {
    ...normalizeDocRun(d),
    tool: String(d.tool_name || ""),
    argsHash: String(d.args_hash ?? ""),
    timestamp: ts && !Number.isNaN(ts.getTime()) ? ts : undefined,
    success: d.success === undefined ? true : Boolean(d.success),
    serviceSource: typeof d.service_source === "string" ? d.service_source : undefined,
  };
}

function dedupUses(rawDocs: Record<string, unknown>[]): ToolUseRecord[] {
  const seen = new Set<string>();
  const out: ToolUseRecord[] = [];
  for (const doc of rawDocs) {
    if (isProbeRecord(doc)) continue;
    const use = normalizeDocUse(doc);
    if (!use.tool) continue;
    const tsSec = use.timestamp instanceof Date ? Math.floor(use.timestamp.getTime() / 1000) : "";
    const key = `${use.agent}|${use.cycleId}|${use.ticker}|${stripMcpPrefix(use.tool)}|${tsSec}|${use.argsHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(use);
  }
  return out;
}

function buildSnapshotEntries(
  bundles: Map<string, string[]>,
  seqs: Map<string, LearnedSequence[]>,
  sampleCounts: Map<string, number>,
): LearnedToolStackEntry[] {
  const keys = new Set([...bundles.keys(), ...seqs.keys()]);
  const entries: LearnedToolStackEntry[] = [];
  for (const key of [...keys].sort()) {
    if (key.includes("|")) continue;
    const bundle = bundles.get(key) ?? [];
    const seqList = seqs.get(key) ?? [];
    if (bundle.length === 0 && seqList.length === 0) continue;
    entries.push({
      agent_name: key,
      opening_bundle: bundle,
      sequences: seqList.map((s) => ({
        tools: s.tools,
        count: s.count,
        support: s.support,
        confidence: s.confidence,
        ...(s.avgGapMs !== undefined ? { avg_gap_ms: s.avgGapMs } : {}),
      })),
      sample_runs: sampleCounts.get(key) ?? 0,
    });
  }
  return entries;
}

async function persistLearnedStacks(
  db: ReturnType<typeof MongoWrapper.getDb>,
  entries: LearnedToolStackEntry[],
): Promise<void> {
  if (!db) return;
  try {
    const coll = db.collection("learned_tool_stacks") as unknown as {
      updateOne?: (filter: Record<string, unknown>, update: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>;
      deleteMany?: (filter: Record<string, unknown>) => Promise<unknown>;
    };
    if (typeof coll?.updateOne !== "function") return;
    const updatedAt = new Date();
    await Promise.all(
      entries.map((entry) =>
        coll.updateOne!(
          { agent_name: entry.agent_name },
          { $set: { ...entry, window_days: 7, updated_at: updatedAt } },
          { upsert: true },
        ),
      ),
    );
    if (entries.length > 0 && typeof coll?.deleteMany === "function") {
      await coll.deleteMany({ agent_name: { $nin: entries.map((e) => e.agent_name) } });
    }
  } catch (err) {
    logger.warn(`[TradingToolStacks] learned_tool_stacks persist failed: ${String(err)}`);
  }
}

export async function refreshLearnedStacks(): Promise<void> {
  const db = MongoWrapper.getDb(TRADING_MONGO_DB);
  if (!db) throw new Error(`trading database ${TRADING_MONGO_DB} unavailable`);
  const cutoff = new Date(Date.now() - WINDOW_MS);
  const probeFilter = { $nin: [...PROBE_SERVICE_SOURCES] };
  const telemetryFilter = { created_at: { $gte: cutoff }, service_source: probeFilter };
  const usageFilter = {
    $or: [{ called_at: { $gte: cutoff } }, { created_at: { $gte: cutoff } }],
    service_source: probeFilter,
  };
  const telemetryColl = db.collection("v3_agent_telemetry");
  const toolTelColl = db.collection("agent_tool_telemetry");
  const usageStatsColl = db.collection("tool_usage_stats");
  const asDocs = (res: unknown): Record<string, unknown>[] =>
    Array.isArray(res) ? (res as Record<string, unknown>[]) : [];
  const [rawRunDocs, rawTelUseDocs, rawUsageUseDocs] = (
    await Promise.all([
      telemetryColl
        .find({ ...telemetryFilter, outcome: "SUCCESS" }, { projection: { agent_name: 1, cycle_id: 1, ticker: 1, model_used: 1, service_source: 1 } })
        .toArray(),
      toolTelColl
        .find(telemetryFilter, { projection: { agent_name: 1, cycle_id: 1, ticker: 1, tool_name: 1, args_hash: 1, timestamp: 1, created_at: 1, success: 1, service_source: 1, model_used: 1 } })
        .toArray(),
      usageStatsColl
        .find(usageFilter, { projection: { agent_name: 1, cycle_id: 1, ticker: 1, tool_name: 1, args_hash: 1, called_at: 1, timestamp: 1, created_at: 1, success: 1, service_source: 1, model_used: 1 } })
        .toArray(),
    ])
  ).map(asDocs);

  const v3Runs = rawRunDocs.filter((d) => !isProbeRecord(d)).map(normalizeDocRun);
  const v3AgentsSeen = new Set(v3Runs.map((r) => r.agent));
  const combinedUses = dedupUses([...rawTelUseDocs, ...rawUsageUseDocs]);

  // Infer successful runs for non-v3 agents or agents absent from v3_agent_telemetry.
  const inferredRunMap = new Map<string, RunRecord>();
  for (const u of combinedUses) {
    if (v3AgentsSeen.has(u.agent) || u.success === false) continue;
    const key = `${u.agent}|${u.cycleId}|${u.ticker}`;
    if (!inferredRunMap.has(key)) {
      inferredRunMap.set(key, { agent: u.agent, cycleId: u.cycleId, ticker: u.ticker, model: u.model });
    }
  }
  const allRuns = [...v3Runs, ...inferredRunMap.values()];
  const sampleCounts = new Map<string, Set<string>>();
  for (const r of allRuns) addRunToGroup(sampleCounts, r.agent, `${r.cycleId}|${r.ticker}`);

  learned = learnStacks(allRuns, combinedUses);
  learnedSeqs = learnSequences(allRuns, combinedUses);
  learnedSampleCounts = new Map([...sampleCounts].map(([k, s]) => [k, s.size]));

  const snapshot = buildSnapshotEntries(learned, learnedSeqs, learnedSampleCounts);
  await persistLearnedStacks(db, snapshot);
  logger.info(
    `[TradingToolStacks] learned bundles=${JSON.stringify(Object.fromEntries(learned))} seqRoles=${learnedSeqs.size}`,
  );
}

function scheduleRefreshIfNeeded(): void {
  if (Date.now() >= nextRefreshAt) {
    nextRefreshAt = Date.now() + REFRESH_MS;
    refreshLearnedStacks().catch((error) => {
      nextRefreshAt = Date.now() + RETRY_MS;
      logger.warn(`[TradingToolStacks] refresh failed: ${String(error)}`);
    });
  }
}

function isFamilyStackPromoted(agentName: string, family: string): boolean {
  if (family === "unknown") return false;
  return Boolean(
    PromotionController.getActive(tradingShimProfileId(agentName, family)) ||
      PromotionController.getActive(tradingShimProfileId(agentName, "*")),
  );
}

/** The learned opening stack for a role, limited to its signed catalog. */
export function openingStack(
  agentName: string,
  allowedTools: string[],
  modelId?: string,
  opts?: { allowUnpromotedFamily?: boolean },
): string[] {
  if ((process.env.TRADING_TOOL_STACKS || "true").toLowerCase() === "false") return [];
  scheduleRefreshIfNeeded();
  const allowed = new Set(allowedTools.map(stripMcpPrefix));
  const family = modelId ? modelFamilyOf(modelId) : "unknown";
  const useFamily =
    family !== "unknown" &&
    (opts?.allowUnpromotedFamily === true || isFamilyStackPromoted(agentName, family));
  const candidate =
    (useFamily ? learned.get(`${agentName}|${family}`) : undefined) ??
    learned.get(agentName) ??
    [];
  const stack = candidate.filter((t) => allowed.has(t));
  return stack.length >= 2 ? stack : [];
}

/** Compact system hint combining learned opening bundle and top learned read-only sequences. */
export function openingBundleHint(
  agentName: string,
  allowedTools: string[],
  modelId?: string,
  opts?: { allowUnpromotedFamily?: boolean },
): string {
  if ((process.env.TRADING_TOOL_STACKS || "true").toLowerCase() === "false") return "";
  scheduleRefreshIfNeeded();
  const allowed = new Set(allowedTools.map(stripMcpPrefix));
  const bundle = openingStack(agentName, allowedTools, modelId, opts);
  const family = modelId ? modelFamilyOf(modelId) : "unknown";
  const useFamily =
    family !== "unknown" &&
    (opts?.allowUnpromotedFamily === true || isFamilyStackPromoted(agentName, family));
  const seqCandidates =
    (useFamily ? learnedSeqs.get(`${agentName}|${family}`) : undefined) ??
    learnedSeqs.get(agentName) ??
    [];
  const callableSeqs = seqCandidates
    .filter((s) => s.tools.every((t) => allowed.has(t)))
    .slice(0, 2);

  const lines: string[] = [];
  if (bundle.length >= 2) lines.push(openingStackLine(bundle));
  if (callableSeqs.length > 0) {
    const formatted = callableSeqs.map((s) => s.tools.join(" -> ")).join("; ");
    lines.push(`Recurring read-only tool chains (batch independent steps): ${formatted}.`);
  }
  return lines.join("\n");
}

/** Synchronous snapshot of all role-level learned bundles & sequences in memory. */
export function learnedStacksSnapshot(): LearnedToolStackEntry[] {
  return buildSnapshotEntries(learned, learnedSeqs, learnedSampleCounts);
}
