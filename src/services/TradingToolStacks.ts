/** Learned opening tool stacks for trading roles.
 *
 * A stack is the set of ticker-keyed reads a role calls in nearly every successful run.
 * It is shown to the model as one line of its system message, so the model asks for the
 * whole set in its first response and the executor runs them together. Nothing here
 * executes a tool: each call the model then makes goes through decideToolCall like any other,
 * and only tools in the run's signed catalog are ever named.
 *
 * Replaying the junior prompt and catalog on Jetson nemotron35, the parallel hint alone gave
 * 9 of 14 first responses with 2+ calls; adding this line gave 7 of 8, each the exact stack
 * (.agents/AUDIT-tool-routing-2026-10-16.md §B). Learned 2026-10-16 over 7 days only
 * v3_junior_analyst qualifies: get_upcoming_events 98 %, get_finnhub_news 95 %,
 * get_institutional_holdings 90 % of 107 successful runs; no other role has two reads at 90 %.
 */
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { TRADING_MONGO_DB } from "../../config.ts";
import logger from "../logger.ts";
import { modelFamilyOf } from "../platform/models/ModelProfiles.ts";
import { stripMcpPrefix } from "./McpPrefix.ts";
import { REUSABLE_READ_TOOLS } from "./LocalToolRouter.ts";

/** Reusable data reads keyed by the ticker; web search and scraping take free text. */
const STACKABLE = new Set([...REUSABLE_READ_TOOLS].filter((t) => t !== "lazy_web_search" && t !== "scrape_url"));
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_RUNS = 30;
const MIN_PRESENCE = 0.9;
const MAX_STACK = 4;
const REFRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;

export interface RunRecord { agent: string; cycleId: string; ticker: string; model?: string }
export interface ToolUseRecord extends RunRecord { tool: string; argsHash: string }

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

let learned = new Map<string, string[]>();
let nextRefreshAt = 0;

async function refresh(): Promise<void> {
  const db = MongoWrapper.getDb(TRADING_MONGO_DB);
  if (!db) throw new Error(`trading database ${TRADING_MONGO_DB} unavailable`);
  const scope = {
    created_at: { $gte: new Date(Date.now() - WINDOW_MS) },
    cycle_id: { $regex: "^cycle-" }, // real cycles; observation and replay runs are not habits
    agent_name: { $regex: "^v3_" },
  };
  const [runDocs, useDocs] = await Promise.all([
    db.collection("v3_agent_telemetry")
      .find({ ...scope, outcome: "SUCCESS" }, { projection: { agent_name: 1, cycle_id: 1, ticker: 1, model_used: 1 } }).toArray(),
    db.collection("agent_tool_telemetry")
      .find(scope, { projection: { agent_name: 1, cycle_id: 1, ticker: 1, tool_name: 1, args_hash: 1 } }).toArray(),
  ]);
  const run = (d: Record<string, unknown>): RunRecord => ({
    agent: String(d.agent_name),
    cycleId: String(d.cycle_id),
    ticker: String(d.ticker ?? ""),
    model: typeof d.model_used === "string" ? d.model_used : undefined,
  });
  learned = learnStacks(runDocs.map(run),
    useDocs.map((d) => ({ ...run(d), tool: String(d.tool_name), argsHash: String(d.args_hash ?? "") })));
  logger.info(`[TradingToolStacks] learned ${JSON.stringify(Object.fromEntries(learned))}`);
}

/** The learned stack for a role (preferring the model family's stack when >= MIN_RUNS exist, else
 * falling back to the role-wide stack), limited to its signed catalog. */
export function openingStack(agentName: string, allowedTools: string[], modelId?: string): string[] {
  if ((process.env.TRADING_TOOL_STACKS || "true").toLowerCase() === "false") return [];
  if (Date.now() >= nextRefreshAt) {
    nextRefreshAt = Date.now() + REFRESH_MS;
    refresh().catch((error) => {
      nextRefreshAt = Date.now() + RETRY_MS;
      logger.warn(`[TradingToolStacks] refresh failed: ${String(error)}`);
    });
  }
  const allowed = new Set(allowedTools.map(stripMcpPrefix));
  const family = modelId ? modelFamilyOf(modelId) : "unknown";
  const candidate =
    (family !== "unknown" ? learned.get(`${agentName}|${family}`) : undefined) ??
    learned.get(agentName) ??
    [];
  const stack = candidate.filter((t) => allowed.has(t));
  return stack.length >= 2 ? stack : [];
}
