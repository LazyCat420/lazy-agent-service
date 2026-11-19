/**
 * Cross-Model Continual Recursive Self-Improvement (CRSI) with Self-Improvement Memory (SIM)
 * for the V3 Trading Cycle (`arXiv:2611.18856` §3.2–3.3, §4.3.3 `S2: Unified synthesis`).
 *
 * Strictly off-cycle and fail-closed:
 * 1. Refuses to start or aborts immediately if `trading_bot.pipeline_state` is busy.
 * 2. Splits frozen `pipeline_trace_blobs` deterministically into disjoint `evolve` and `holdout` sets;
 *    `holdout` cases never enter Proposer, Selector, or `SimStore` (§B.2).
 * 3. Evaluates candidate `TradingShimInterlockConfig` harnesses across BOTH live local model families
 *    (`gold-spark` DeepSeek + `dell1`/`dell2` Qwen, discovered dynamically from `/v1/models`).
 * 4. Gates promotion through `PromotionController` (`offline_candidate -> shadow -> canary_5`) with
 *    paired bootstrap CI and per-family non-inferiority validity hard gates.
 */
import { createHash } from "node:crypto";
import { TRADING_MONGO_DB } from "../../../config.ts";
import { modelFamilyOf, type ModelFamily } from "../../platform/models/ModelProfiles.ts";
import logger from "../../utils/logger.ts";
import MongoWrapper from "../../wrappers/MongoWrapper.ts";
import { stripMcpPrefix } from "../McpPrefix.ts";
import { PromotionController, type GateEvaluation } from "../PromotionController.ts";
import {
  applyTradingToolProtocol,
  isTradingToolErrorContent,
  registerShimInterlockConfig,
  tradingShimProfileId,
  type TradingShimInterlockConfig,
} from "../TradingToolProtocol.ts";
import { parseSimManifest } from "./Recursion.ts";
import { SIM_GUIDANCE, SIM_MANIFEST_FORMAT } from "./Prompts.ts";
import { SimStore, type SimMemoryCondition, type SimPerModelOutcome } from "./SimStore.ts";

export const MIN_CRSI_HOLDOUT_CASES = 30;
const BUSY_STATUSES = new Set(["starting", "running", "collecting", "analyzing", "trading"]);

const SUBSTANTIVE_ROLE_KEYS: Record<string, readonly string[]> = {
  v3_quant_analyst: ["summary", "risk_metrics"],
  v3_fundamental_analyst: ["summary", "pillars"],
  v3_junior_analyst: ["summary", "key_findings"],
};

export interface ModelEndpointTarget {
  label: string;
  baseUrl: string;
  modelId: string;
  modelFamily: ModelFamily;
}

export interface FrozenTradingCase {
  caseId: string;
  cycleId: string;
  ticker: string;
  agentRole: string;
  split: "evolve" | "holdout";
  recordedModel: string;
  recordedLoops: number;
  systemPrompt: string;
  userPrompt: string;
  allowedTools: string[];
  tools: Array<Record<string, unknown>>;
  toolFixtures: Record<string, string[]>;
}

export interface RolloutEvaluation {
  caseId: string;
  endpointLabel: string;
  modelId: string;
  modelFamily: ModelFamily;
  artifactValid: boolean;
  evidenceCompleted: boolean;
  loopsUsed: number;
  elapsedMs: number;
  interlockFired: string | null;
  compositeScore: number;
  finalPreview: string;
  error?: string;
}

export interface ArmSummary {
  nRollouts: number;
  validityRate: number;
  evidenceRate: number;
  avgLoops: number;
  avgElapsedMs: number;
  meanScore: number;
  byFamily: Record<string, SimPerModelOutcome & { validityRate: number; meanScore: number }>;
}

export interface HoldoutVerdict {
  status: "passed" | "failed" | "underpowered" | "invalid_run";
  pairedCases: number;
  minHoldoutCases: number;
  delta: number;
  ciLow: number;
  ciHigh: number;
  baseline: ArmSummary;
  candidate: ArmSummary;
  hardGates: GateEvaluation[];
  promotedChannel: string | null;
}

export interface ChatTurnResponse {
  content: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
}

export type ChatTurnFn = (
  target: ModelEndpointTarget,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<ChatTurnResponse>;

export type ImproverFn = (prompt: string, label: string, signal?: AbortSignal) => Promise<string>;

export function deterministicSplit(cycleId: string, ticker: string): "evolve" | "holdout" {
  const digest = createHash("sha256").update(`${cycleId}|${ticker.toUpperCase()}`).digest();
  return (digest[0] & 1) === 0 ? "evolve" : "holdout";
}

/** Deterministic PRNG (mulberry32) for reproducible paired bootstrap CIs. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pairedBootstrapCi(
  diffs: readonly number[],
  seed = 20261118,
  resamples = 2000,
): { delta: number; ciLow: number; ciHigh: number } {
  if (diffs.length === 0) return { delta: 0, ciLow: 0, ciHigh: 0 };
  const mean = (arr: readonly number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const delta = mean(diffs);
  if (diffs.length === 1) return { delta, ciLow: delta, ciHigh: delta };
  const rng = makeRng(seed);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < diffs.length; i++) {
      sum += diffs[Math.floor(rng() * diffs.length)];
    }
    means.push(sum / diffs.length);
  }
  means.sort((a, b) => a - b);
  const loIdx = Math.floor(0.025 * (resamples - 1));
  const hiIdx = Math.ceil(0.975 * (resamples - 1));
  return { delta, ciLow: means[loIdx], ciHigh: means[hiIdx] };
}

/** Refuse to Leak: assert zero holdout case IDs appear in optimizer prompts or SIM. */
export function assertNoHoldoutLeak(text: string, holdoutCases: readonly FrozenTradingCase[]): void {
  for (const c of holdoutCases) {
    if (text.includes(c.caseId)) {
      throw new Error(`Holdout leakage violation: ${c.caseId} appeared in optimizer/SIM context`);
    }
  }
}

/** Strip injected shim protocol wrapper from stored snapshots so replay re-applies protocol cleanly. */
export function stripStoredProtocolPrefix(systemContent: string): string {
  const withoutHeader = systemContent.replace(/^\[TRADING TOOL EXECUTION CONTRACT v1\]\n[\s\S]*?\n\n/, "");
  return withoutHeader
    .replace(/\n\nIndependent lookups go in ONE response:[\s\S]*$/, "")
    .replace(/\n\nUsual opening bundle for this role[\s\S]*$/, "")
    .trim();
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const candidates = [cleaned];
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }
  for (const cand of candidates) {
    try {
      const parsed = JSON.parse(cand) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

export function isValidRoleArtifact(rawText: string, agentRole: string): boolean {
  const parsed = extractJsonObject(rawText);
  if (!parsed) return false;
  const payload =
    parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
      ? (parsed.data as Record<string, unknown>)
      : parsed;
  const required = SUBSTANTIVE_ROLE_KEYS[agentRole] ?? ["summary"];
  return required.some((k) => {
    const val = payload[k];
    return val !== undefined && val !== null && val !== "" && JSON.stringify(val) !== "{}" && JSON.stringify(val) !== "[]";
  });
}

export function computeCompositeScore(
  artifactValid: boolean,
  evidenceCompleted: boolean,
  loopsUsed: number,
  maxTurns: number,
): number {
  if (!artifactValid || !evidenceCompleted) return 0;
  const efficiency = Math.max(0, 1 - Math.max(0, loopsUsed - 1) / Math.max(1, maxTurns));
  return Number((0.7 + 0.3 * efficiency).toFixed(6));
}

function simulateFixtureToolCall(
  fc: FrozenTradingCase,
  toolName: string,
  rawArgs: string,
  cursors: Map<string, number>,
): { content: string; isReadSuccess: boolean } {
  const cleanName = stripMcpPrefix(toolName);
  if (cleanName === "run_equation") {
    try {
      const parsedArgs = JSON.parse(rawArgs || "{}") as { code?: string };
      const code = String(parsedArgs.code || "");
      const hasDictOut = /\bout\s*=\s*\{/.test(code) && !/json\.dumps|join\(|str\(/.test(code);
      if (hasDictOut) {
        return {
          content: "Equation execution failed: Equation execution failed: TypeError: float() argument must be a string or a real number, not 'dict'",
          isReadSuccess: false,
        };
      }
    } catch {
      return { content: "Equation execution failed: SyntaxError: invalid tool JSON arguments", isReadSuccess: false };
    }
  }
  const recorded = fc.toolFixtures[cleanName];
  if (recorded && recorded.length > 0) {
    const idx = cursors.get(cleanName) ?? 0;
    cursors.set(cleanName, Math.min(idx + 1, recorded.length - 1));
    const content = recorded[idx];
    const failed = isTradingToolErrorContent(content);
    return { content, isReadSuccess: !failed };
  }
  return {
    content: JSON.stringify({ ticker: fc.ticker, tool: cleanName, status: "ok", source: "frozen_fixture" }),
    isReadSuccess: true,
  };
}

/** Execute one deterministic multi-turn replay of a frozen case on one live/stub model endpoint. */
export async function replayFrozenCase(args: {
  frozenCase: FrozenTradingCase;
  target: ModelEndpointTarget;
  interlock: TradingShimInterlockConfig | null;
  openingStack?: string[];
  maxTurns?: number;
  chatTurn: ChatTurnFn;
  signal?: AbortSignal;
}): Promise<RolloutEvaluation> {
  const { frozenCase: fc, target, interlock, chatTurn, signal } = args;
  const maxTurns = args.maxTurns ?? 8;
  const startedAt = Date.now();
  const cursors = new Map<string, number>();
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: fc.systemPrompt },
    { role: "user", content: fc.userPrompt },
  ];
  let loopsUsed = 0;
  let readSuccessCount = 0;
  let interlockFired: string | null = null;
  let finalText = "";

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      const prepared = applyTradingToolProtocol(
        { model: target.modelId, messages, tools: fc.tools, temperature: 0.1, min_p: 0, max_tokens: 4096 },
        fc.allowedTools,
        args.openingStack ?? [],
        interlock,
      );
      if (prepared.interlockFired && !interlockFired) interlockFired = prepared.interlockFired;
      const reply = await chatTurn(target, prepared.body, signal);
      if (!reply.toolCalls.length) {
        finalText = reply.content || "";
        break;
      }
      loopsUsed += 1;
      messages.push({
        role: "assistant",
        content: reply.content,
        tool_calls: reply.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        })),
      });
      for (const call of reply.toolCalls) {
        const sim = simulateFixtureToolCall(fc, call.name, call.arguments, cursors);
        if (sim.isReadSuccess) readSuccessCount += 1;
        messages.push({ role: "tool", tool_call_id: call.id, content: sim.content });
      }
    }

    if (!finalText.trim()) {
      messages.push({
        role: "user",
        content: "Time, budget or step limit reached. Do not call tools. Answer the user now using only the information already gathered.",
      });
      const wall = applyTradingToolProtocol(
        { model: target.modelId, messages, tools: fc.tools, tool_choice: "none", temperature: 0.1, min_p: 0, max_tokens: 4096 },
        fc.allowedTools,
        args.openingStack ?? [],
        interlock,
      );
      if (wall.interlockFired && !interlockFired) interlockFired = wall.interlockFired;
      const wallReply = await chatTurn(target, wall.body, signal);
      finalText = wallReply.content || "";
    }

    const artifactValid = isValidRoleArtifact(finalText, fc.agentRole);
    const evidenceCompleted = readSuccessCount > 0;
    return {
      caseId: fc.caseId,
      endpointLabel: target.label,
      modelId: target.modelId,
      modelFamily: target.modelFamily,
      artifactValid,
      evidenceCompleted,
      loopsUsed,
      elapsedMs: Date.now() - startedAt,
      interlockFired,
      compositeScore: computeCompositeScore(artifactValid, evidenceCompleted, loopsUsed, maxTurns),
      finalPreview: finalText.slice(0, 240),
    };
  } catch (error) {
    return {
      caseId: fc.caseId,
      endpointLabel: target.label,
      modelId: target.modelId,
      modelFamily: target.modelFamily,
      artifactValid: false,
      evidenceCompleted: false,
      loopsUsed,
      elapsedMs: Date.now() - startedAt,
      interlockFired,
      compositeScore: 0,
      finalPreview: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function summarizeArm(evals: readonly RolloutEvaluation[]): ArmSummary {
  const n = evals.length;
  if (n === 0) {
    return { nRollouts: 0, validityRate: 0, evidenceRate: 0, avgLoops: 0, avgElapsedMs: 0, meanScore: 0, byFamily: {} };
  }
  const sum = (fn: (e: RolloutEvaluation) => number) => evals.reduce((a, e) => a + fn(e), 0);
  const byFam = new Map<string, RolloutEvaluation[]>();
  for (const e of evals) {
    const list = byFam.get(e.modelFamily) ?? [];
    list.push(e);
    byFam.set(e.modelFamily, list);
  }
  const byFamily: ArmSummary["byFamily"] = {};
  for (const [fam, rows] of byFam) {
    const valid = rows.filter((r) => r.artifactValid && r.evidenceCompleted).length;
    byFamily[fam] = {
      modelFamily: rows[0].modelFamily,
      modelId: rows[0].modelId,
      passed: valid,
      total: rows.length,
      avgLoops: Number((rows.reduce((a, r) => a + r.loopsUsed, 0) / rows.length).toFixed(2)),
      avgElapsedMs: Math.round(rows.reduce((a, r) => a + r.elapsedMs, 0) / rows.length),
      validityRate: Number((valid / rows.length).toFixed(4)),
      meanScore: Number((rows.reduce((a, r) => a + r.compositeScore, 0) / rows.length).toFixed(6)),
    };
  }
  const validAll = evals.filter((e) => e.artifactValid && e.evidenceCompleted).length;
  return {
    nRollouts: n,
    validityRate: Number((validAll / n).toFixed(4)),
    evidenceRate: Number((evals.filter((e) => e.evidenceCompleted).length / n).toFixed(4)),
    avgLoops: Number((sum((e) => e.loopsUsed) / n).toFixed(2)),
    avgElapsedMs: Math.round(sum((e) => e.elapsedMs) / n),
    meanScore: Number((sum((e) => e.compositeScore) / n).toFixed(6)),
    byFamily,
  };
}

/**
 * Fail-closed check whether the live trading pipeline is busy (`pipeline_state.singleton_id == "current"`
 * or any running `v3_system_commands`). Returns `true` (busy) if the DB handle is missing or the query throws.
 */
export async function isTradingPipelineBusy(mongoDbName = TRADING_MONGO_DB): Promise<boolean> {
  try {
    const db = MongoWrapper.getDb(mongoDbName);
    if (!db) {
      logger.warn(`[CrossModelCRSI] MongoDB ${mongoDbName} unavailable during busy check; failing closed.`);
      return true;
    }
    const [state, runningCmd] = await Promise.all([
      db.collection("pipeline_state").findOne({ singleton_id: "current" } as never),
      db.collection("v3_system_commands").findOne({ status: "running" } as never),
    ]);
    const status = String((state as Record<string, unknown> | null)?.status || "").toLowerCase();
    return BUSY_STATUSES.has(status) || Boolean(runningCmd);
  } catch (error) {
    logger.warn(`[CrossModelCRSI] busy check failed (${String(error)}); failing closed.`);
    return true;
  }
}

/** Discover live model ID dynamically from `/v1/models` — never hardcode model slugs. */
export async function discoverLiveEndpointTarget(label: string, baseUrl: string): Promise<ModelEndpointTarget> {
  const cleanUrl = baseUrl.replace(/\/+$/, "");
  const res = await fetch(`${cleanUrl}/v1/models`, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`Endpoint ${label} (${cleanUrl}/v1/models) answered HTTP ${res.status}`);
  const data = (await res.json()) as { data?: Array<{ id?: string; task?: string }> };
  const usable = (data.data ?? []).filter(
    (m) => m?.id && !["embed", "embedding", "rerank"].includes(String(m.task || "generate")),
  );
  if (usable.length === 0 || !usable[0].id) {
    throw new Error(`Endpoint ${label} (${cleanUrl}) serves no usable generation model`);
  }
  const modelId = usable[0].id;
  return { label, baseUrl: cleanUrl, modelId, modelFamily: modelFamilyOf(modelId) };
}

export function defaultHttpChatTurn(): ChatTurnFn {
  return async (target, body, signal) => {
    const payload = {
      ...body,
      model: target.modelId,
      stream: false,
      chat_template_kwargs: { enable_thinking: false, thinking: false },
    };
    const res = await fetch(`${target.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: signal ?? AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`${target.label} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
        };
      }>;
    };
    const msg = json.choices?.[0]?.message;
    const toolCalls = (msg?.tool_calls ?? []).map((tc, i) => ({
      id: tc.id || `call-${i}`,
      name: tc.function?.name || "unknown",
      arguments: tc.function?.arguments || "{}",
    }));
    return { content: msg?.content ?? null, toolCalls };
  };
}

function extractFixturesFromMessages(messages: Array<Record<string, unknown>>): {
  recordedLoops: number;
  toolFixtures: Record<string, string[]>;
} {
  const idToTool = new Map<string, string>();
  const toolFixtures: Record<string, string[]> = {};
  let recordedLoops = 0;
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      recordedLoops += 1;
      for (const tc of m.tool_calls as Array<Record<string, unknown>>) {
        const fn = tc.function as Record<string, unknown> | undefined;
        if (typeof tc.id === "string" && typeof fn?.name === "string") {
          idToTool.set(tc.id, stripMcpPrefix(fn.name));
        }
      }
    } else if (m.role === "tool" && typeof m.tool_call_id === "string" && typeof m.content === "string") {
      const name = idToTool.get(m.tool_call_id);
      if (!name) continue;
      toolFixtures[name] = toolFixtures[name] ?? [];
      toolFixtures[name].push(m.content);
    }
  }
  return { recordedLoops, toolFixtures };
}

function selectDeepestEventsByCase(events: Array<Record<string, unknown>>): Map<string, Record<string, unknown>> {
  const deepestByCase = new Map<string, Record<string, unknown>>();
  for (const ev of events) {
    const cycleId = String(ev.cycle_id || "");
    const ticker = String(ev.ticker || "").toUpperCase();
    const snap = ev.snapshot as { hash?: string; bytes?: number } | undefined;
    if (!cycleId || !ticker || !snap?.hash) continue;
    const caseId = `${cycleId}|${ticker}`;
    const prevBytes = ((deepestByCase.get(caseId)?.snapshot as { bytes?: number } | undefined)?.bytes) ?? 0;
    if (!deepestByCase.has(caseId) || (snap.bytes ?? 0) > prevBytes) deepestByCase.set(caseId, ev);
  }
  return deepestByCase;
}

function parseFrozenCaseFromBlob(
  caseId: string,
  ev: Record<string, unknown>,
  rawContent: string,
  agentRole: string,
): FrozenTradingCase | null {
  const payload = JSON.parse(rawContent) as Record<string, unknown>;
  const msgs = Array.isArray(payload.messages) ? (payload.messages as Array<Record<string, unknown>>) : [];
  const sys = msgs.find((m) => m.role === "system" && typeof m.content === "string");
  const usr = msgs.find((m) => m.role === "user" && typeof m.content === "string");
  const tools = Array.isArray(payload.tools) ? (payload.tools as Array<Record<string, unknown>>) : [];
  if (!sys || !usr || tools.length === 0) return null;

  const { recordedLoops, toolFixtures } = extractFixturesFromMessages(msgs);
  const allowedTools = tools
    .map((t) => stripMcpPrefix(String((t.function as Record<string, unknown> | undefined)?.name || "")))
    .filter(Boolean);
  const cycleId = String(ev.cycle_id);
  const ticker = String(ev.ticker).toUpperCase();
  return {
    caseId,
    cycleId,
    ticker,
    agentRole,
    split: deterministicSplit(cycleId, ticker),
    recordedModel: String(payload.model || "unknown"),
    recordedLoops,
    systemPrompt: stripStoredProtocolPrefix(String(sys.content)),
    userPrompt: String(usr.content),
    allowedTools,
    tools,
    toolFixtures,
  };
}

/** Build a read-only frozen replay corpus from `trading_bot.pipeline_trace_events` + `pipeline_trace_blobs`. */
export async function buildFrozenTradingCorpus(opts: {
  agentRole: string;
  maxCases?: number;
  mongoDbName?: string;
}): Promise<{ corpusHash: string; evolve: FrozenTradingCase[]; holdout: FrozenTradingCase[] }> {
  const db = MongoWrapper.getDb(opts.mongoDbName || TRADING_MONGO_DB);
  if (!db) throw new Error("MongoDB trading_bot unavailable for frozen corpus build");
  const maxCases = opts.maxCases ?? 80;
  const events = await db
    .collection("pipeline_trace_events")
    .find(
      {
        agent: opts.agentRole,
        stage: "provider.payload",
        "snapshot.truncated": false,
        cycle_id: { $regex: "^cycle-" },
      },
      { sort: { created_at: -1 }, limit: maxCases * 8 },
    )
    .toArray();

  const deepestByCase = selectDeepestEventsByCase(events as Array<Record<string, unknown>>);
  const cases: FrozenTradingCase[] = [];
  for (const [caseId, ev] of [...deepestByCase.entries()].slice(0, maxCases)) {
    const snap = ev.snapshot as { hash: string };
    const blobDoc = await db.collection("pipeline_trace_blobs").findOne({ _id: snap.hash as never });
    const content = (blobDoc as Record<string, unknown> | null)?.content;
    if (typeof content !== "string") continue;
    const parsedCase = parseFrozenCaseFromBlob(caseId, ev, content, opts.agentRole);
    if (parsedCase) cases.push(parsedCase);
  }

  cases.sort((a, b) => a.caseId.localeCompare(b.caseId));
  const corpusHash = createHash("sha256")
    .update(cases.map((c) => `${c.caseId}:${c.recordedLoops}`).join("\n"))
    .digest("hex")
    .slice(0, 24);
  return {
    corpusHash,
    evolve: cases.filter((c) => c.split === "evolve"),
    holdout: cases.filter((c) => c.split === "holdout"),
  };
}

function sanitizeInterlockConfig(parsed: Record<string, unknown>, version: string): TradingShimInterlockConfig {
  const errCap = Number(parsed.maxConsecutiveToolErrors ?? 0);
  const warnAt = Number(parsed.turnWarnThreshold ?? 0);
  const rawHint = typeof parsed.toolErrorHint === "string" ? parsed.toolErrorHint.trim() : "";
  return {
    version,
    matchNativeExhaustionNotice: Boolean(parsed.matchNativeExhaustionNotice),
    ...(errCap >= 1 && errCap <= 6 ? { maxConsecutiveToolErrors: Math.round(errCap) } : {}),
    ...(warnAt >= 3 && warnAt <= 12 ? { turnWarnThreshold: Math.round(warnAt) } : {}),
    ...(rawHint ? { toolErrorHint: rawHint.slice(0, 240) } : {}),
  };
}

export function parseProposedInterlock(
  reply: string,
  version: string,
): { config: TradingShimInterlockConfig | null; citedProblemId?: string; rootCause: string; predicted: string[]; rationale: string } {
  const manifest = parseSimManifest(reply, "CRSI interlock proposal");
  const jsonBlock = /```json\s*([\s\S]*?)```/i.exec(reply)?.[1] ?? reply;
  const parsed = extractJsonObject(jsonBlock);
  const baseFields = {
    citedProblemId: manifest?.citedProblemId,
    predicted: manifest?.predicted ?? [],
  };
  if (!parsed) {
    return {
      ...baseFields,
      config: null,
      rootCause: manifest?.rootCause || "unparsed proposal",
      rationale: manifest?.rationale || "unparsed",
    };
  }
  return {
    ...baseFields,
    config: sanitizeInterlockConfig(parsed, version),
    rootCause: manifest?.rootCause || "Cross-model tool-loop divergence",
    rationale: manifest?.rationale || "Unified S2 synthesis proposal",
  };
}

function buildS2ImproverPrompt(args: {
  agentRole: string;
  round: number;
  currentConfig: TradingShimInterlockConfig | null;
  evolveEvals: readonly RolloutEvaluation[];
  simText: string;
}): string {
  const failures = args.evolveEvals
    .filter((e) => !e.artifactValid || !e.evidenceCompleted || e.loopsUsed >= 5)
    .map(
      (e) =>
        `- case=${e.caseId} | model=${e.modelFamily}/${e.modelId} | valid=${e.artifactValid} | evidence=${e.evidenceCompleted} | loops=${e.loopsUsed} | preview=${JSON.stringify(e.finalPreview.slice(0, 100))}`,
    );
  return [
    `You are optimizing the lazy-agent-service shim interlock for trading seat \`${args.agentRole}\` across Qwen and DeepSeek (round ${args.round}).`,
    `Current config: ${JSON.stringify(args.currentConfig ?? { baseline: true })}`,
    "# EVOLVE-SPLIT MULTI-MODEL OBSERVATIONS (S2 UNIFIED SYNTHESIS)",
    failures.length ? failures.join("\n") : "_(all evolve rollouts clean and <= 4 loops)_",
    args.simText ? `${SIM_GUIDANCE}\n\n${SIM_MANIFEST_FORMAT}\n\n${args.simText}` : SIM_MANIFEST_FORMAT,
    "# OUTPUT FORMAT",
    "Emit `<diagnosis problem=\"NEW|P1\">...</diagnosis>`, `<predicted>case_ids</predicted>`, `<rationale>...</rationale>`, and one ```json block with fields from `{ matchNativeExhaustionNotice: boolean, maxConsecutiveToolErrors: 1..6, turnWarnThreshold: 3..12, toolErrorHint: string }`.",
  ].join("\n\n");
}

async function evaluateSplitAcrossModels(args: {
  cases: readonly FrozenTradingCase[];
  targets: readonly ModelEndpointTarget[];
  interlockByFamily: (family: ModelFamily) => TradingShimInterlockConfig | null;
  chatTurn: ChatTurnFn;
  maxTurns?: number;
  checkBusy?: () => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<RolloutEvaluation[]> {
  const results: RolloutEvaluation[] = [];
  for (const c of args.cases) {
    if (args.signal?.aborted) throw new Error("CRSI run aborted");
    if (args.checkBusy && (await args.checkBusy())) {
      throw new Error("Live trading cycle became busy; aborting off-cycle CRSI replay immediately");
    }
    const perTarget = await Promise.all(
      args.targets.map((target) =>
        replayFrozenCase({
          frozenCase: c,
          target,
          interlock: args.interlockByFamily(target.modelFamily),
          maxTurns: args.maxTurns,
          chatTurn: args.chatTurn,
          signal: args.signal,
        }),
      ),
    );
    results.push(...perTarget);
  }
  return results;
}

function computePairedCaseDiffs(
  holdoutCases: readonly FrozenTradingCase[],
  baselineEvals: readonly RolloutEvaluation[],
  candidateEvals: readonly RolloutEvaluation[],
): number[] {
  const diffs: number[] = [];
  const meanScore = (rows: RolloutEvaluation[]) => rows.reduce((acc, r) => acc + r.compositeScore, 0) / rows.length;
  for (const c of holdoutCases) {
    const bCase = baselineEvals.filter((e) => e.caseId === c.caseId);
    const kCase = candidateEvals.filter((e) => e.caseId === c.caseId);
    if (bCase.length > 0 && bCase.length === kCase.length) {
      diffs.push(meanScore(kCase) - meanScore(bCase));
    }
  }
  return diffs;
}

function evaluateValidityHardGates(baseline: ArmSummary, candidate: ArmSummary): GateEvaluation[] {
  const families = new Set([...Object.keys(baseline.byFamily), ...Object.keys(candidate.byFamily)]);
  const gates: GateEvaluation[] = [];
  for (const fam of families) {
    const baseVal = baseline.byFamily[fam]?.validityRate ?? 0;
    const candVal = candidate.byFamily[fam]?.validityRate ?? 0;
    gates.push({
      gate: `non_inferior_validity_${fam}`,
      passed: candVal >= baseVal,
      detail: `${fam} validity candidate=${candVal} vs baseline=${baseVal}`,
    });
  }
  return gates;
}

function buildCandidateInterlockVersion(
  corpusHash: string,
  simCondition: SimMemoryCondition,
  round: number,
  cfg: Omit<TradingShimInterlockConfig, "version">,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        corpusHash,
        simCondition,
        round,
        matchNativeExhaustionNotice: Boolean(cfg.matchNativeExhaustionNotice),
        maxConsecutiveToolErrors: cfg.maxConsecutiveToolErrors ?? null,
        turnWarnThreshold: cfg.turnWarnThreshold ?? null,
        toolErrorHint: cfg.toolErrorHint ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 8);
  return `crsi-${corpusHash.slice(0, 8)}-${simCondition}-r${round}-${digest}`;
}

function dryRunTargetChannel(allGatesPassed: boolean, delta: number, ciLow: number, underpowered: boolean, promoteToCanary?: boolean): string {
  if (!allGatesPassed || !(delta > 0 && ciLow > 0)) return "offline_candidate";
  if (underpowered || !promoteToCanary) return "shadow";
  return "canary_5";
}

function promoteVerifiedInterlock(args: {
  profileId: string;
  config: TradingShimInterlockConfig;
  allGatesPassed: boolean;
  underpowered: boolean;
  promoteToCanary?: boolean;
  dryRun?: boolean;
  delta: number;
  ciLow: number;
  ciHigh: number;
  nCases: number;
  minCases: number;
  hardGates: GateEvaluation[];
}): string {
  if (args.dryRun) {
    return dryRunTargetChannel(args.allGatesPassed, args.delta, args.ciLow, args.underpowered, args.promoteToCanary);
  }
  if (!args.allGatesPassed || !(args.delta > 0 && args.ciLow > 0)) {
    return "offline_candidate";
  }
  registerShimInterlockConfig(args.profileId, args.config);
  const existing = PromotionController.get(args.profileId, args.config.version);
  if (existing && existing.channel !== "offline_candidate") {
    return existing.channel;
  }
  PromotionController.register(args.profileId, args.config.version);
  const exp = { outcome: "improved" as const, delta: args.delta, ciLower: args.ciLow, ciUpper: args.ciHigh };
  const toShadow = PromotionController.transition({
    profileId: args.profileId,
    version: args.config.version,
    from: "offline_candidate",
    to: "shadow",
    reason: `CRSI holdout delta=${args.delta.toFixed(4)} ciLow=${args.ciLow.toFixed(4)} n=${args.nCases}`,
    experiment: exp,
    hardGates: args.hardGates,
  });
  if (!toShadow.ok) return "offline_candidate";
  if (args.underpowered || !args.promoteToCanary) return "shadow";
  const toCanary = PromotionController.transition({
    profileId: args.profileId,
    version: args.config.version,
    from: "shadow",
    to: "canary_5",
    reason: `CRSI holdout passed n=${args.nCases} >= ${args.minCases}`,
    experiment: exp,
    hardGates: args.hardGates,
  });
  return toCanary.ok ? "canary_5" : "shadow";
}

export function evaluateHoldoutAndPromote(args: {
  agentRole: string;
  targetFamily: ModelFamily;
  candidateConfig: TradingShimInterlockConfig;
  holdoutCases: readonly FrozenTradingCase[];
  baselineEvals: readonly RolloutEvaluation[];
  candidateEvals: readonly RolloutEvaluation[];
  minHoldoutCases?: number;
  promoteToCanary?: boolean;
  dryRun?: boolean;
  seed?: number;
}): HoldoutVerdict {
  const minCases = args.minHoldoutCases ?? MIN_CRSI_HOLDOUT_CASES;
  const baseline = summarizeArm(args.baselineEvals);
  const candidate = summarizeArm(args.candidateEvals);
  const diffs = computePairedCaseDiffs(args.holdoutCases, args.baselineEvals, args.candidateEvals);
  const { delta, ciLow, ciHigh } = pairedBootstrapCi(diffs, args.seed ?? 20261118);
  const hardGates = evaluateValidityHardGates(baseline, candidate);
  const allGatesPassed = hardGates.every((g) => g.passed);
  const underpowered = diffs.length < minCases;
  const status: HoldoutVerdict["status"] = !allGatesPassed
    ? "failed"
    : underpowered
      ? "underpowered"
      : delta > 0 && ciLow > 0
        ? "passed"
        : "failed";
  const promotedChannel = promoteVerifiedInterlock({
    profileId: tradingShimProfileId(args.agentRole, args.targetFamily),
    config: args.candidateConfig,
    allGatesPassed,
    underpowered,
    promoteToCanary: args.promoteToCanary,
    dryRun: args.dryRun,
    delta,
    ciLow,
    ciHigh,
    nCases: diffs.length,
    minCases,
    hardGates,
  });
  return {
    status,
    pairedCases: diffs.length,
    minHoldoutCases: minCases,
    delta: Number(delta.toFixed(6)),
    ciLow: Number(ciLow.toFixed(6)),
    ciHigh: Number(ciHigh.toFixed(6)),
    baseline,
    candidate,
    hardGates,
    promotedChannel,
  };
}

function classifyPredictedOutcomes(
  predicted: readonly string[],
  holdout: readonly FrozenTradingCase[],
  beforeEvals: readonly RolloutEvaluation[],
  afterEvals: readonly RolloutEvaluation[],
): { cleanPredicted: string[]; fixed: string[]; missed: string[] } {
  const holdoutIds = new Set(holdout.map((h) => h.caseId));
  const cleanPredicted = predicted.filter((id) => !holdoutIds.has(id));
  const fixed: string[] = [];
  const missed: string[] = [];
  const sumScore = (rows: RolloutEvaluation[]) => rows.reduce((s, r) => s + r.compositeScore, 0);
  for (const caseId of cleanPredicted) {
    const before = beforeEvals.filter((e) => e.caseId === caseId);
    const after = afterEvals.filter((e) => e.caseId === caseId);
    const improved =
      after.length > 0 &&
      after.every((a) => a.artifactValid && a.evidenceCompleted) &&
      sumScore(after) > sumScore(before);
    if (improved) fixed.push(caseId);
    else missed.push(caseId);
  }
  return { cleanPredicted, fixed, missed };
}

async function runSingleCrsiRound(args: {
  round: number;
  agentRole: string;
  corpus: { corpusHash: string; evolve: FrozenTradingCase[]; holdout: FrozenTradingCase[] };
  targets: readonly ModelEndpointTarget[];
  improverTarget: ModelEndpointTarget;
  simStore: SimStore;
  simCondition: SimMemoryCondition;
  retained: TradingShimInterlockConfig | null;
  currentEvals: RolloutEvaluation[];
  currentSummary: ArmSummary;
  chatTurn: ChatTurnFn;
  improver: ImproverFn;
  maxTurns?: number;
  checkBusy?: () => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<{
  retained: TradingShimInterlockConfig | null;
  currentEvals: RolloutEvaluation[];
  currentSummary: ArmSummary;
}> {
  const simText = args.simCondition === "none" ? "" : args.simStore.renderPrompt(args.simCondition);
  assertNoHoldoutLeak(simText, args.corpus.holdout);
  const prompt = buildS2ImproverPrompt({
    agentRole: args.agentRole,
    round: args.round,
    currentConfig: args.retained,
    evolveEvals: args.currentEvals,
    simText,
  });
  assertNoHoldoutLeak(prompt, args.corpus.holdout);

  const reply = await args.improver(prompt, `crsi-r${args.round}`, args.signal);
  const parsed = parseProposedInterlock(reply, `crsi-${args.corpus.corpusHash.slice(0, 8)}-${args.simCondition}-r${args.round}`);
  if (!parsed.config) {
    return { retained: args.retained, currentEvals: args.currentEvals, currentSummary: args.currentSummary };
  }
  const candidateConfig: TradingShimInterlockConfig = {
    ...parsed.config,
    version: buildCandidateInterlockVersion(args.corpus.corpusHash, args.simCondition, args.round, parsed.config),
  };

  const candEvals = await evaluateSplitAcrossModels({
    cases: args.corpus.evolve,
    targets: args.targets,
    interlockByFamily: (fam) => (fam === "qwen" ? candidateConfig : null),
    chatTurn: args.chatTurn,
    maxTurns: args.maxTurns,
    checkBusy: args.checkBusy,
    signal: args.signal,
  });
  const candSummary = summarizeArm(candEvals);
  const accepted =
    candSummary.meanScore >= args.currentSummary.meanScore &&
    candSummary.validityRate >= args.currentSummary.validityRate;
  const { cleanPredicted, fixed, missed } = classifyPredictedOutcomes(
    parsed.predicted,
    args.corpus.holdout,
    args.currentEvals,
    candEvals,
  );

  if (args.simCondition !== "none") {
    await args.simStore.recordAttempt({
      citedProblemId: parsed.citedProblemId,
      rootCause: parsed.rootCause,
      round: args.round,
      sample: `r${args.round}`,
      accepted,
      what: JSON.stringify(candidateConfig),
      files: ["TradingToolProtocol.ts"],
      rationale: parsed.rationale,
      predicted: cleanPredicted,
      fixed,
      missed,
      passed: Math.round(candSummary.validityRate * candSummary.nRollouts),
      total: candSummary.nRollouts,
      domain: args.simStore.domain,
      benchmark: "trading_trace_evolve",
      upstream: args.improverTarget.label,
      modelId: args.improverTarget.modelId,
      agentRole: args.agentRole,
      corpusHash: args.corpus.corpusHash,
      perModel: candSummary.byFamily,
    });
  }

  if (!accepted) {
    return { retained: args.retained, currentEvals: args.currentEvals, currentSummary: args.currentSummary };
  }
  return { retained: candidateConfig, currentEvals: candEvals, currentSummary: candSummary };
}

/** Run N rounds of S2 Unified Cross-Model CRSI on `evolve`, recording to `SimStore`, then verify on `holdout`. */
export async function runCrossModelCrsi(opts: {
  agentRole: string;
  corpus: { corpusHash: string; evolve: FrozenTradingCase[]; holdout: FrozenTradingCase[] };
  targets: readonly ModelEndpointTarget[];
  improverTarget: ModelEndpointTarget;
  simStore: SimStore;
  simCondition?: SimMemoryCondition;
  rounds?: number;
  maxTurns?: number;
  minHoldoutCases?: number;
  promoteToCanary?: boolean;
  chatTurn?: ChatTurnFn;
  improver?: ImproverFn;
  checkBusy?: () => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<{
  retainedConfig: TradingShimInterlockConfig | null;
  evolveBaseline: ArmSummary;
  evolveFinal: ArmSummary;
  holdoutVerdict: HoldoutVerdict | null;
  roundsRun: number;
}> {
  const chatTurn = opts.chatTurn ?? defaultHttpChatTurn();
  const simCondition = opts.simCondition ?? "full";
  const rounds = opts.rounds ?? 2;
  const improver: ImproverFn =
    opts.improver ??
    (async (prompt, _label, signal) => {
      const reply = await chatTurn(
        opts.improverTarget,
        { messages: [{ role: "user", content: prompt }], temperature: 0.3, max_tokens: 2048 },
        signal,
      );
      return reply.content || "";
    });

  let retained: TradingShimInterlockConfig | null = null;
  let currentEvals = await evaluateSplitAcrossModels({
    cases: opts.corpus.evolve,
    targets: opts.targets,
    interlockByFamily: () => null,
    chatTurn,
    maxTurns: opts.maxTurns,
    checkBusy: opts.checkBusy,
    signal: opts.signal,
  });
  const evolveBaseline = summarizeArm(currentEvals);
  let currentSummary = evolveBaseline;

  for (let round = 1; round <= rounds; round++) {
    const step = await runSingleCrsiRound({
      round,
      agentRole: opts.agentRole,
      corpus: opts.corpus,
      targets: opts.targets,
      improverTarget: opts.improverTarget,
      simStore: opts.simStore,
      simCondition,
      retained,
      currentEvals,
      currentSummary,
      chatTurn,
      improver,
      maxTurns: opts.maxTurns,
      checkBusy: opts.checkBusy,
      signal: opts.signal,
    });
    retained = step.retained;
    currentEvals = step.currentEvals;
    currentSummary = step.currentSummary;
  }

  if (!retained || opts.corpus.holdout.length === 0) {
    return { retainedConfig: retained, evolveBaseline, evolveFinal: currentSummary, holdoutVerdict: null, roundsRun: rounds };
  }

  const [holdBase, holdCand] = await Promise.all([
    evaluateSplitAcrossModels({
      cases: opts.corpus.holdout,
      targets: opts.targets,
      interlockByFamily: () => null,
      chatTurn,
      maxTurns: opts.maxTurns,
      checkBusy: opts.checkBusy,
      signal: opts.signal,
    }),
    evaluateSplitAcrossModels({
      cases: opts.corpus.holdout,
      targets: opts.targets,
      interlockByFamily: (fam) => (fam === "qwen" ? retained : null),
      chatTurn,
      maxTurns: opts.maxTurns,
      checkBusy: opts.checkBusy,
      signal: opts.signal,
    }),
  ]);

  const holdoutVerdict = evaluateHoldoutAndPromote({
    agentRole: opts.agentRole,
    targetFamily: "qwen",
    candidateConfig: retained,
    holdoutCases: opts.corpus.holdout,
    baselineEvals: holdBase,
    candidateEvals: holdCand,
    minHoldoutCases: opts.minHoldoutCases,
    promoteToCanary: opts.promoteToCanary,
  });

  logger.info(
    `[CrossModelCRSI] ${opts.agentRole}: evolve ${evolveBaseline.meanScore.toFixed(3)} -> ${currentSummary.meanScore.toFixed(3)}; holdout=${holdoutVerdict.status} (delta=${holdoutVerdict.delta}, ciLow=${holdoutVerdict.ciLow}, channel=${holdoutVerdict.promotedChannel})`,
  );
  return { retainedConfig: retained, evolveBaseline, evolveFinal: currentSummary, holdoutVerdict, roundsRun: rounds };
}

/** Built-in A/A, Known-Answer, and Mutation controls proving the CRSI evaluator discriminates cleanly. */
export async function runCrsiSelftest(): Promise<{
  passed: boolean;
  checks: Record<string, boolean>;
  verdicts: { aa: HoldoutVerdict; knownAnswer: HoldoutVerdict; mutation: HoldoutVerdict };
}> {
  const targets: ModelEndpointTarget[] = [
    { label: "gold-spark", baseUrl: "http://127.0.0.1:1", modelId: "DeepSeek-V4.1-Flash-1017", modelFamily: "deepseek" },
    { label: "dell1", baseUrl: "http://127.0.0.1:2", modelId: "Qwen3.8-Flash-Next", modelFamily: "qwen" },
  ];
  const holdout: FrozenTradingCase[] = Array.from({ length: 32 }, (_, i) => ({
    caseId: `stub-cycle-${i}|T${i % 4}`,
    cycleId: `stub-cycle-${i}`,
    ticker: `T${i % 4}`,
    agentRole: "v3_quant_analyst",
    split: "holdout",
    recordedModel: "Qwen3.8-Flash-Next",
    recordedLoops: 8,
    systemPrompt: "You are a quant analyst.",
    userPrompt: `## Ticker: T${i % 4}`,
    allowedTools: ["get_polygon_price_history", "run_equation"],
    tools: [
      { type: "function", function: { name: "get_polygon_price_history", parameters: { type: "object" } } },
      { type: "function", function: { name: "run_equation", parameters: { type: "object" } } },
    ],
    toolFixtures: { get_polygon_price_history: ['{"price_rows":252}'] },
  }));

  const stubChat = (mutant: boolean): ChatTurnFn => async (target, body) => {
    const msgs = body.messages as Array<{ role: string; content?: string; tool_calls?: unknown[] }>;
    const toolTurns = msgs.filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls)).length;
    const lastMsg = String(msgs[msgs.length - 1]?.content || "");
    if (mutant && target.modelFamily === "qwen") {
      return { content: "corrupted non-json prose", toolCalls: [] };
    }
    if (toolTurns === 0) {
      return {
        content: null,
        toolCalls: [{ id: "p1", name: "get_polygon_price_history", arguments: '{"ticker":"T0"}' }],
      };
    }
    if (target.modelFamily === "deepseek") {
      return { content: '{"summary":"ok","risk_metrics":{"vol":0.2}}', toolCalls: [] };
    }
    // Qwen loops on dict `run_equation` until interlock `[tool-retry]` fires or wall is hit.
    if (lastMsg.includes("[TRADING INTERLOCK v1]") || body.tool_choice === "none") {
      return { content: '{"summary":"ok","risk_metrics":{"vol":0.2}}', toolCalls: [] };
    }
    return {
      content: null,
      toolCalls: [{ id: `e${toolTurns}`, name: "run_equation", arguments: '{"code":"out = {\\"a\\": 1}"}' }],
    };
  };

  const winnerCfg: TradingShimInterlockConfig = {
    version: "selftest-winner-1",
    maxConsecutiveToolErrors: 2,
    matchNativeExhaustionNotice: true,
    toolErrorHint: "Emit scalar output.",
  };
  const baseEvals = await evaluateSplitAcrossModels({
    cases: holdout,
    targets,
    interlockByFamily: () => null,
    chatTurn: stubChat(false),
    maxTurns: 6,
  });
  const winEvals = await evaluateSplitAcrossModels({
    cases: holdout,
    targets,
    interlockByFamily: (fam) => (fam === "qwen" ? winnerCfg : null),
    chatTurn: stubChat(false),
    maxTurns: 6,
  });
  const mutEvals = await evaluateSplitAcrossModels({
    cases: holdout,
    targets,
    interlockByFamily: (fam) => (fam === "qwen" ? { version: "selftest-mutant-1" } : null),
    chatTurn: stubChat(true),
    maxTurns: 6,
  });

  const aa = evaluateHoldoutAndPromote({
    agentRole: "v3_quant_analyst",
    targetFamily: "qwen",
    candidateConfig: { version: "selftest-aa-1" },
    holdoutCases: holdout,
    baselineEvals: baseEvals,
    candidateEvals: baseEvals,
    dryRun: true,
  });
  const knownAnswer = evaluateHoldoutAndPromote({
    agentRole: "v3_quant_analyst",
    targetFamily: "qwen",
    candidateConfig: winnerCfg,
    holdoutCases: holdout,
    baselineEvals: baseEvals,
    candidateEvals: winEvals,
    dryRun: true,
  });
  const mutation = evaluateHoldoutAndPromote({
    agentRole: "v3_quant_analyst",
    targetFamily: "qwen",
    candidateConfig: { version: "selftest-mutant-1" },
    holdoutCases: holdout,
    baselineEvals: baseEvals,
    candidateEvals: mutEvals,
    dryRun: true,
  });

  const checks = {
    aaSpansZero: aa.ciLow <= 0 && aa.ciHigh >= 0 && aa.status !== "passed",
    knownAnswerPassed: knownAnswer.status === "passed" && knownAnswer.delta > 0 && knownAnswer.ciLow > 0,
    mutationBlocked: mutation.status === "failed" && mutation.delta < 0 && mutation.promotedChannel === "offline_candidate",
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    verdicts: { aa, knownAnswer, mutation },
  };
}
