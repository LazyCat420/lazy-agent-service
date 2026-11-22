import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import logger from "../../logger.js";
import { runCoreLoop } from "../../core/loop/CoreLoop.ts";
import type { ChatMessage, CoreLoopEvent, CoreLoopResult, CoreModel, CoreTool } from "../../core/loop/types.ts";
import { routeLocalTool } from "../LocalToolRouter.ts";
import { reconcileAaExtractions } from "./AaNoiseReconciler.ts";
import { verifyFactsAgainstLedger } from "./FactLedgerVerifier.ts";
import {
  acquireLocalPoolTarget,
  createPoolCoreModel,
  PipelineTimeoutError,
  PoolUnavailableError,
} from "./LocalPoolClient.ts";
import type {
  DataCriticReport,
  ExtractedFact,
  LedgerEntry,
  LinearDeskRequest,
  LinearDeskResponse,
  LinearDeskUsage,
  LinearStagePromptEcho,
  ReplayTraderRequest,
  ReplayTraderResponse,
  ResearchExtractionOutput,
  TraderDecision,
} from "./types.ts";

interface LinearProfilePolicy {
  maxDurationMs: number;
  maxToolCalls: number;
  maxRetries: number;
  allowedTools: Set<string>;
}

function loadLinearProfilePolicy(): LinearProfilePolicy {
  const fallback: LinearProfilePolicy = {
    maxDurationMs: 600_000,
    maxToolCalls: 6,
    maxRetries: 1,
    allowedTools: new Set(["read_ledger_entry", "lazy_web_search", "get_upcoming_events"]),
  };
  try {
    const profilePath = resolve(process.cwd(), "profiles", "trading-linear-v1.json");
    const parsed = JSON.parse(readFileSync(profilePath, "utf8")) as {
      budget_limits?: { max_duration_ms?: number; max_tool_calls?: number; max_retries?: number };
      allowed_local_tools?: string[];
    };
    const allowed = new Set<string>();
    for (const ref of parsed.allowed_local_tools || []) {
      const noVersion = ref.split("@")[0];
      const shortName = noVersion.split(".").pop();
      if (shortName) allowed.add(shortName);
    }
    return {
      maxDurationMs: parsed.budget_limits?.max_duration_ms ?? fallback.maxDurationMs,
      maxToolCalls: parsed.budget_limits?.max_tool_calls ?? fallback.maxToolCalls,
      maxRetries: parsed.budget_limits?.max_retries ?? fallback.maxRetries,
      allowedTools: allowed.size > 0 ? allowed : fallback.allowedTools,
    };
  } catch (err) {
    logger.warn(
      `[LinearDesk] Failed to load profiles/trading-linear-v1.json (${err instanceof Error ? err.message : String(err)}); using fallback limits`,
    );
    return fallback;
  }
}

const LINEAR_PROFILE = loadLinearProfilePolicy();
export const LINEAR_DESK_MAX_DURATION_MS = LINEAR_PROFILE.maxDurationMs;

const VALID_CATEGORIES = [
  "price",
  "valuation",
  "fundamental",
  "technical",
  "news",
  "earnings",
  "macro",
  "risk",
] as const;

const ExtractedFactSchema = z.object({
  fact_id: z.string().min(1),
  category: z
    .preprocess((v) => {
      if (typeof v !== "string") return "fundamental";
      const low = v.trim().toLowerCase();
      return (VALID_CATEGORIES as readonly string[]).includes(low) ? low : "fundamental";
    }, z.enum(VALID_CATEGORIES))
    .default("fundamental"),
  metric: z.string().min(1),
  value: z.preprocess(
    (v) => (typeof v === "number" && Number.isFinite(v) ? String(v) : v),
    z.string().min(1),
  ) as z.ZodType<string>,
  raw_number: z.preprocess((v) => {
    if (typeof v === "string") {
      const cleaned = v.replace(/,/g, "").trim();
      if (cleaned) {
        const parsed = Number(cleaned);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return v;
  }, z.number().finite().nullable().optional()),
  ticker: z.string().optional(),
  as_of: z.string().optional(),
  summary: z.string().default(""),
});

const ResearchExtractionSchema = z.object({
  summary: z.string().default(""),
  facts: z.array(ExtractedFactSchema).default([]),
  catalysts: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  data_gaps: z.array(z.string()).default([]),
});

const CriticCleanupSchema = z.object({
  summary: z.string().default(""),
  facts: z.array(ExtractedFactSchema).default([]),
  catalysts: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  data_gaps: z.array(z.string()).default([]),
  dropped_facts: z
    .array(z.object({ fact_id: z.string(), reason: z.string() }))
    .default([]),
  notes: z.array(z.string()).default([]),
});

const DynamicTriggerSchema = z.object({
  type: z.enum([
    "price_below",
    "price_above",
    "rsi_14_oversold",
    "rsi_14_overbought",
    "sma_20_drop",
    "sma_20_rise",
    "sma_50_drop",
    "sma_50_rise",
    "sma_200_drop",
    "sma_200_rise",
    "trailing_drop",
  ]),
  value: z.number().finite().positive(),
});

function normalizeTraderDecision(
  raw: {
    action: TraderDecision["action"];
    entry_mode?: "enter_now" | "enter_on_condition" | "watch_only";
    entry_condition: string | null;
    dynamic_trigger: TraderDecision["dynamic_trigger"];
    position_size_pct: number;
    stop_loss: number | null;
    take_profit: number | null;
    cited_fact_ids: string[];
    cited_playbook_ids: string[];
    decision_thesis: string;
  },
  allowedPlaybookIds?: ReadonlySet<string>,
): TraderDecision {
  const citedPlaybooks = Array.from(
    new Set(
      raw.cited_playbook_ids
        .map((id) => id.trim())
        .filter((id) => Boolean(id) && (allowedPlaybookIds?.has(id) ?? false)),
    ),
  );
  const base = { ...raw, cited_playbook_ids: citedPlaybooks };
  if (raw.action === "SELL") {
    return { ...base, entry_mode: "enter_now", dynamic_trigger: null };
  }
  if (raw.action === "HOLD" || raw.action === "AVOID") {
    return { ...base, entry_mode: "watch_only", dynamic_trigger: null };
  }
  if (raw.entry_mode === "enter_on_condition" && raw.dynamic_trigger) {
    return { ...base, entry_mode: "enter_on_condition", dynamic_trigger: raw.dynamic_trigger };
  }
  if (raw.entry_mode === "watch_only" || raw.entry_mode === "enter_on_condition") {
    return { ...base, entry_mode: "watch_only", dynamic_trigger: null };
  }
  return {
    ...base,
    entry_mode: raw.position_size_pct > 0 ? "enter_now" : "watch_only",
    dynamic_trigger: null,
  };
}

function buildTraderSchema(held: boolean, allowedPlaybookIds?: ReadonlySet<string>) {
  return z
    .object({
      action: held ? z.enum(["BUY", "HOLD", "SELL"]) : z.enum(["BUY", "HOLD", "AVOID"]),
      entry_mode: z.preprocess(
        (v) => (v === "none" || v === "" || v == null ? undefined : String(v).trim()),
        z.enum(["enter_now", "enter_on_condition", "watch_only"]).optional(),
      ),
      entry_condition: z.string().nullable().default(null),
      dynamic_trigger: DynamicTriggerSchema.nullable().default(null),
      position_size_pct: z.number().min(0).max(100).default(0),
      stop_loss: z.number().finite().nullable().default(null),
      take_profit: z.number().finite().nullable().default(null),
      cited_fact_ids: z.array(z.string()).default([]),
      cited_playbook_ids: z.array(z.string()).default([]),
      decision_thesis: z.string().min(1),
    })
    .transform((raw) => normalizeTraderDecision(raw, allowedPlaybookIds));
}

export interface LinearStageTarget {
  boxName: string;
  modelId: string;
  sameBoxFallback: boolean;
  model: CoreModel;
  release(): void;
}

export interface LinearDeskDeps {
  acquireTarget?: (
    preferredMember: string | undefined,
    seed: number,
    temperature: number,
    maxTokens?: number,
    deadlineAtMs?: number,
    signal?: AbortSignal,
  ) => Promise<LinearStageTarget>;
  executeTool?: (toolName: string, args: Record<string, unknown>, req: LinearDeskRequest) => Promise<unknown>;
}

const DEFAULT_FOLLOWUP_TOOLS: Record<string, { description: string; parameters: Record<string, unknown> }> = {
  read_ledger_entry: {
    description: "Expand a ledger entry (fct_...) from whiteboard_ledger when you need fuller detail.",
    parameters: {
      type: "object",
      properties: {
        ticker: { type: "string" },
        entry_id: { type: "string" },
        tool_name: { type: "string" },
        max_chars: { type: "integer" },
      },
    },
  },
  lazy_web_search: {
    description: "Search recent financial news if a specific gap is missing from the ledger.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["query"],
    },
  },
  get_upcoming_events: {
    description: "Fetch upcoming earnings/catalyst calendar dates for the ticker.",
    parameters: {
      type: "object",
      properties: { ticker: { type: "string" } },
      required: ["ticker"],
    },
  },
};

function stripFenceAndThink(raw: string): string {
  const noThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fenced = noThink.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : noThink;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) return candidate.slice(start, end + 1);
  return candidate;
}

export class StageParseError extends Error {
  readonly statusCode = 422;
  readonly code = "STAGE_PARSE_ERROR";
}

function parseJsonStrict<T>(raw: string, schema: z.ZodType<T>, stage: string): T {
  const jsonText = stripFenceAndThink(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new StageParseError(`${stage} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const checked = schema.safeParse(parsed);
  if (!checked.success) {
    throw new StageParseError(`${stage} failed schema validation: ${checked.error.issues.map((i) => `${i.path.join(".")}:${i.message}`).join("; ")}`);
  }
  return checked.data;
}

function reserveToolCallSlot(budget: { calls: number; maxCalls: number }): void {
  if (budget.calls >= budget.maxCalls) {
    throw new Error(`Follow-up tool budget exhausted (max ${budget.maxCalls})`);
  }
  budget.calls += 1;
}

function buildCoreTools(
  req: LinearDeskRequest,
  deps: LinearDeskDeps,
  budget: { calls: number; maxCalls: number },
): CoreTool[] {
  const names = Array.isArray(req.followup_tools) ? req.followup_tools : ["read_ledger_entry", "lazy_web_search"];
  return names
    .filter((name) => Boolean(DEFAULT_FOLLOWUP_TOOLS[name]) && LINEAR_PROFILE.allowedTools.has(name))
    .map((name) => ({
      name,
      description: DEFAULT_FOLLOWUP_TOOLS[name].description,
      parameters: DEFAULT_FOLLOWUP_TOOLS[name].parameters,
      execute: async (args) => {
        reserveToolCallSlot(budget);
        if (deps.executeTool) return deps.executeTool(name, args, req);
        return routeLocalTool(name, args, {
          agentName: "v3_linear_extractor",
          cycleId: req.cycle_id,
          ticker: req.ticker,
          signal: req.signal,
        });
      },
    }));
}

interface CoreStageRunResult {
  text: string;
  usage: LinearDeskUsage;
  elapsedMs: number;
}

function emptyUsage(): LinearDeskUsage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

function addUsage(acc: LinearDeskUsage, delta: LinearDeskUsage): LinearDeskUsage {
  return {
    prompt_tokens: acc.prompt_tokens + delta.prompt_tokens,
    completion_tokens: acc.completion_tokens + delta.completion_tokens,
    total_tokens: acc.total_tokens + delta.total_tokens,
  };
}

function mapStageFailure(error?: { code: string; message: string }): Error {
  if (error?.code === "POOL_UNAVAILABLE") return new PoolUnavailableError(error.message);
  if (error?.code === "PIPELINE_TIMEOUT") return new PipelineTimeoutError(error.message);
  return new Error(error?.message || "CoreLoop stage failed");
}

function linkAbortSignal(signal?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal?.aborted) {
    controller.abort(signal.reason);
  } else if (signal) {
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller;
}

function accumulateStageUsage(ev: unknown, totals: { prompt: number; completion: number }): void {
  if (typeof ev !== "object" || ev === null || !("type" in ev) || ev.type !== "usage") return;
  const typed = ev as Extract<CoreLoopEvent, { type: "usage" }>;
  const usage = typed.usage as {
    inputTokens?: number;
    prompt_tokens?: number;
    outputTokens?: number;
    completion_tokens?: number;
  };
  totals.prompt += Number(usage.inputTokens ?? usage.prompt_tokens ?? 0);
  totals.completion += Number(usage.outputTokens ?? usage.completion_tokens ?? 0);
}

function resolveStageFinalText(
  stepValue: CoreLoopResult,
  signal: AbortSignal | undefined,
  controllerSignal: AbortSignal,
): string {
  const finalText = stepValue.text || "";
  if (signal?.aborted || controllerSignal.aborted || stepValue.status === "cancelled") {
    const reason = signal?.reason ?? controllerSignal.reason;
    if (reason instanceof DOMException && reason.name === "TimeoutError") {
      throw new PipelineTimeoutError(reason.message || "Linear stage timed out");
    }
    throw reason instanceof Error ? reason : new Error(stepValue.error?.message || "Stage aborted");
  }
  if (stepValue.status !== "completed" && !finalText) {
    throw mapStageFailure(stepValue.error);
  }
  return finalText;
}

async function runCoreStage(
  target: LinearStageTarget,
  messages: ChatMessage[],
  tools: CoreTool[],
  maxSteps: number,
  signal?: AbortSignal,
): Promise<CoreStageRunResult> {
  const t0 = Date.now();
  const controller = linkAbortSignal(signal);
  const gen = runCoreLoop({
    model: target.model,
    tools,
    messages,
    signal: controller.signal,
    maxSteps,
    tradingRun: true,
    providerRetries: 0,
    disableFinalPassOnProviderError: true,
  });
  const totals = { prompt: 0, completion: 0 };
  for (;;) {
    const step = await gen.next();
    if (!step.done) {
      if (step.value) accumulateStageUsage(step.value, totals);
      continue;
    }
    const text = resolveStageFinalText(step.value, signal, controller.signal);
    return {
      text,
      usage: {
        prompt_tokens: totals.prompt,
        completion_tokens: totals.completion,
        total_tokens: totals.prompt + totals.completion,
      },
      elapsedMs: Math.max(0, Date.now() - t0),
    };
  }
}

async function defaultAcquireTarget(
  preferredMember: string | undefined,
  seed: number,
  temperature: number,
  maxTokens = 2560,
  deadlineAtMs?: number,
  signal?: AbortSignal,
): Promise<LinearStageTarget> {
  const acquired = await acquireLocalPoolTarget(preferredMember, signal, deadlineAtMs);
  const stateTarget: LinearStageTarget = {
    boxName: acquired.member.name,
    modelId: acquired.modelId,
    sameBoxFallback: acquired.sameBoxFallback,
    model: undefined as unknown as CoreModel,
    release: () => acquired.release(),
  };
  stateTarget.model = createPoolCoreModel(acquired, {
    preferredMember,
    seed,
    temperature,
    maxTokens,
    signal,
    deadlineAtMs,
    onFailover: (nextMember, nextModelId) => {
      stateTarget.boxName = nextMember.name;
      stateTarget.modelId = nextModelId;
      stateTarget.sameBoxFallback = Boolean(preferredMember) && nextMember.name !== preferredMember;
    },
  });
  return stateTarget;
}

function compactPromptRaw(raw: unknown, hasSummary: boolean): unknown {
  if (raw === undefined || raw === null) return undefined;
  try {
    const serialized = JSON.stringify(raw);
    if (serialized.length <= 600) return raw;
    return hasSummary ? undefined : serialized.slice(0, 600);
  } catch {
    return undefined;
  }
}

function formatPromptLedgerEntry(
  e: LedgerEntry,
  fallbackTicker: string,
  recordKey = "",
): Record<string, unknown> {
  const summary = (e.summary || "").slice(0, 500);
  const raw = compactPromptRaw(e.raw, Boolean(summary));
  return {
    fact_id: (e.fact_id || recordKey).trim(),
    tool_name: e.tool_name,
    ticker: e.ticker || fallbackTicker,
    as_of: e.as_of || "",
    summary,
    ...(raw !== undefined ? { raw } : {}),
  };
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function messageText(msg?: ChatMessage): string {
  if (!msg) return "";
  return typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
}

function buildPromptEcho(params: {
  stage: LinearStagePromptEcho["stage"];
  role: LinearStagePromptEcho["role"];
  artifactType: LinearStagePromptEcho["artifact_type"];
  messages: ChatMessage[];
  modelId: string | null;
  box: string;
  elapsedMs: number;
}): LinearStagePromptEcho {
  const system = messageText(params.messages[0]);
  const user = messageText(params.messages[1]);
  return {
    stage: params.stage,
    role: params.role,
    artifact_type: params.artifactType,
    system,
    user,
    system_sha256: sha256Hex(system),
    user_sha256: sha256Hex(user),
    model_id: params.modelId || null,
    box: params.box,
    elapsed_ms: params.elapsedMs,
  };
}

function renderLedgerPrompt(req: LinearDeskRequest): string {
  const items = Object.entries(req.ledger_entries || {}).map(([key, e]) =>
    formatPromptLedgerEntry(e, req.ticker, key),
  );
  const payload: Record<string, unknown> = {
    ticker: req.ticker,
    cycle_id: req.cycle_id,
    ledger_entries: items,
  };
  if (req.directives && req.directives.length > 0) {
    payload.active_directives = req.directives;
  }
  return JSON.stringify(payload);
}

function extractorMessages(req: LinearDeskRequest): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are Stage 1 (Research Extractor). Select at most 8 of the most decision-relevant verified objective facts, plus at most 4 items each in catalysts, risks, and data_gaps strictly from the supplied whiteboard_ledger (and optional read-only follow-up tools). Keep summary concise (<= 100 chars). EVERY fact must cite an exact `fact_id` (`fct_...`), exact `ticker`, and exact `raw_number` from that entry. FORBIDDEN: Do NOT recommend BUY, SELL, HOLD, or AVOID, and do NOT invent facts. Return compact raw JSON matching {summary, facts:[{fact_id,category,metric,value,raw_number,ticker,as_of,summary}], catalysts:[], risks:[], data_gaps:[]}.",
    },
    { role: "user", content: renderLedgerPrompt(req) },
  ];
}

function criticMessages(
  req: LinearDeskRequest,
  candidateFacts: ExtractedFact[],
  mismatches: ReturnType<typeof verifyFactsAgainstLedger>["mismatches"],
  catalysts: string[],
  risks: string[],
  dataGaps: string[],
): ChatMessage[] {
  const citedIds = new Set(candidateFacts.map((f) => (f.fact_id || "").trim()));
  const scopedLedger = Object.entries(req.ledger_entries || {})
    .filter(([key, e]) => citedIds.has((e.fact_id || key).trim()))
    .map(([key, e]) => formatPromptLedgerEntry(e, req.ticker, key));
  return [
    {
      role: "system",
      content:
        "You are Stage 2 (Data Critic Auditor). Your ONLY job is to verify and clean data before decision-making — NEVER emit a trade decision or opinion. Inspect every fact (especially `uncorroborated: true` claims and deterministic `mismatches`) against `ledger_entries`. Fix wrong numbers/tickers when grounded in `ledger_entries` or drop ungrounded claims into `dropped_facts`. Only include repaired or audited facts in `facts` (already-verified corroborated facts are preserved automatically unless listed in `dropped_facts`). Never list kept or repaired facts in `dropped_facts`; record audit remarks for kept facts in `notes` instead. Keep each fact `summary`, `dropped_facts[].reason`, and `notes` concise (<= 80 chars, no unescaped double-quotes), with at most 3 `notes`. Return raw JSON matching {facts:[...], catalysts:[], risks:[], data_gaps:[], dropped_facts:[{fact_id,reason}], notes:[]}.",
    },
    {
      role: "user",
      content: JSON.stringify({
        ticker: req.ticker,
        mismatches,
        candidate_dossier: { facts: candidateFacts, catalysts, risks, data_gaps: dataGaps },
        ledger_entries: scopedLedger,
      }),
    },
  ];
}

const TECH_REGEX_FIELDS: ReadonlyArray<readonly [string, RegExp]> = [
  ["price", /Price:\s*\$?([-+]?\d+(?:,\d{3})*(?:\.\d+)?)/i],
  ["sma_20", /SMA_?20:\s*\$?([-+]?\d+(?:,\d{3})*(?:\.\d+)?)/i],
  ["sma_50", /SMA_?50:\s*\$?([-+]?\d+(?:,\d{3})*(?:\.\d+)?)/i],
  ["sma_200", /SMA_?200:\s*\$?([-+]?\d+(?:,\d{3})*(?:\.\d+)?)/i],
  ["rsi_14", /RSI[-_]?14:\s*([-+]?\d+(?:\.\d+)?)/i],
  ["atr_14", /ATR[-_]?14:\s*\$?([-+]?\d+(?:,\d{3})*(?:\.\d+)?)/i],
  ["macd_histogram", /MACD\s+histogram:\s*([-+]?\d+(?:\.\d+)?)/i],
  ["adx_14", /ADX[-_]?14:\s*([-+]?\d+(?:\.\d+)?)/i],
  ["support", /Support:\s*\$?([-+]?\d+(?:,\d{3})*(?:\.\d+)?)/i],
  ["resistance", /Resistance:\s*\$?([-+]?\d+(?:,\d{3})*(?:\.\d+)?)/i],
];

const TECH_OBJECT_KEYS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["price", ["price", "close", "last_close"]],
  ["sma_20", ["sma_20"]],
  ["sma_50", ["sma_50"]],
  ["sma_200", ["sma_200"]],
  ["rsi_14", ["rsi_14"]],
  ["atr_14", ["atr_14"]],
  ["macd_histogram", ["macd_histogram"]],
  ["adx_14", ["adx_14"]],
  ["support", ["support"]],
  ["resistance", ["resistance"]],
];

function asPlainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseTechnicalObject(rawObj: Record<string, unknown>, out: Record<string, unknown>): number {
  let count = 0;
  for (const [targetKey, aliases] of TECH_OBJECT_KEYS) {
    for (const alias of aliases) {
      const val = rawObj[alias];
      if (typeof val === "number" && Number.isFinite(val)) {
        out[targetKey] = val;
        count++;
        break;
      }
    }
  }
  return count;
}

function parseTechnicalText(text: string, out: Record<string, unknown>): number {
  let count = 0;
  for (const [field, re] of TECH_REGEX_FIELDS) {
    if (out[field] !== undefined) continue;
    const m = text.match(re);
    if (!m) continue;
    const num = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(num)) {
      out[field] = num;
      count++;
    }
  }
  return count;
}

function applyTechnicalIndicatorEntry(
  entry: LedgerEntry,
  key: string,
  out: Record<string, unknown>,
): void {
  if (out.fact_id === undefined) {
    out.fact_id = (entry.fact_id || key).trim();
  }
  if (out.as_of === undefined && entry.as_of) {
    out.as_of = entry.as_of;
  }
  const rawObj = asPlainObject(entry.raw);
  let matchedCount = rawObj ? parseTechnicalObject(rawObj, out) : 0;
  const text = typeof entry.raw === "string" && entry.raw.trim() ? entry.raw : (entry.summary || "");
  if (text) {
    matchedCount += parseTechnicalText(text, out);
  }
  if (matchedCount === 0 && text && out.excerpt === undefined) {
    out.excerpt = text.slice(0, 400);
  }
}

function applyQuantPrecomputeFields(
  entry: LedgerEntry,
  key: string,
  out: Record<string, unknown>,
): void {
  const fid = (entry.fact_id || key).trim();
  if (fid && out.quant_fact_id === undefined) {
    out.quant_fact_id = fid;
  }
  const raw = asPlainObject(entry.raw);
  if (!raw) return;
  const atrStop = asPlainObject(raw.atr_stop_2x);
  if (atrStop && typeof atrStop.stop_loss_price === "number" && Number.isFinite(atrStop.stop_loss_price)) {
    out.stop_2x_atr = atrStop.stop_loss_price;
  }
  const garch = asPlainObject(raw.garch);
  if (garch && typeof garch.vol_signal === "string" && garch.vol_signal) {
    out.garch_vol = garch.vol_signal;
  }
}

function extractMarketTechnicals(req: LinearDeskRequest): Record<string, unknown> | undefined {
  const wantTicker = req.ticker.trim().toUpperCase();
  const out: Record<string, unknown> = {};
  let found = false;
  for (const [key, entry] of Object.entries(req.ledger_entries || {})) {
    if (!entry) continue;
    const entryTicker = (entry.ticker || "").trim().toUpperCase();
    if (entryTicker && entryTicker !== wantTicker) continue;
    if (entry.tool_name === "get_technical_indicators") {
      found = true;
      applyTechnicalIndicatorEntry(entry, key, out);
    } else if (entry.tool_name === "quant_math_precompute") {
      found = true;
      applyQuantPrecomputeFields(entry, key, out);
    }
  }
  return found && Object.keys(out).length > 0 ? out : undefined;
}

function traderMessages(
  req: LinearDeskRequest,
  dossier: ResearchExtractionOutput,
): ChatMessage[] {
  const held = req.portfolio_context.held;
  const allowedActions = held ? "BUY | HOLD | SELL" : "BUY | HOLD | AVOID";
  const actionRule = held
    ? "The portfolio currently holds this ticker; valid actions are BUY, HOLD, SELL."
    : "The portfolio does NOT hold this ticker; SELL is forbidden — valid actions are BUY, HOLD, AVOID.";
  const hasPlaybook = Boolean(req.playbook_bullets && req.playbook_bullets.length > 0);
  const playbookRule = hasPlaybook
    ? " If playbook_rules are supplied, follow applicable rules and list their pb_... IDs in cited_playbook_ids (or [] if none applied)."
    : "";
  const playbookField = hasPlaybook ? ", cited_playbook_ids:string[]" : "";
  const marketTechnicals = extractMarketTechnicals(req);
  const userPayload: Record<string, unknown> = {
    ticker: req.ticker,
    portfolio_context: req.portfolio_context,
    ...(marketTechnicals ? { market_technicals: marketTechnicals } : {}),
    macro_snapshot: req.macro_snapshot || {},
    verified_dossier: dossier,
  };
  if (req.directives && req.directives.length > 0) {
    userPayload.active_directives = req.directives;
  }
  if (req.playbook_bullets && req.playbook_bullets.length > 0) {
    userPayload.playbook_rules = req.playbook_bullets.map((b) => ({
      id: b.id,
      ...(b.section ? { section: b.section } : {}),
      text: b.text,
    }));
  }
  if (req.ticker_history_card && req.ticker_history_card.length > 0) {
    userPayload.prior_ticker_outcomes = req.ticker_history_card;
  }
  return [
    {
      role: "system",
      content:
        `You are Stage 3 (Final Trader Agent) — the sole decision maker. Analyze the verified dossier alongside portfolio_context, market_technicals (when supplied), and macro_snapshot. ${actionRule}${playbookRule} Normal digits and percentages (e.g. '20%', '1.5x', '$185') ARE encouraged in decision_thesis. Cite supporting fct_.../wbl_... IDs in cited_fact_ids. Use entry_mode="enter_now" to act immediately, "watch_only" for HOLD/AVOID or passive monitoring, or "enter_on_condition" ONLY on BUY accompanied by a structured dynamic_trigger ({type:"price_below|price_above|rsi_14_oversold|rsi_14_overbought|sma_20_drop|sma_20_rise|sma_50_drop|sma_50_rise|sma_200_drop|sma_200_rise|trailing_drop", value:number}). Return raw JSON: {action:"${allowedActions}", entry_mode:"enter_now|enter_on_condition|watch_only", entry_condition:string|null, dynamic_trigger:{type:string,value:number}|null, position_size_pct:number, stop_loss:number|null, take_profit:number|null, cited_fact_ids:string[]${playbookField}, decision_thesis:string}.`,
    },
    {
      role: "user",
      content: JSON.stringify(userPayload),
    },
  ];
}

function filterToStage1List(criticItems: string[], stage1Items: string[]): string[] {
  const byNorm = new Map<string, string>();
  for (const item of stage1Items) {
    const key = item.trim().toLowerCase();
    if (key && !byNorm.has(key)) byNorm.set(key, item);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of criticItems) {
    const key = item.trim().toLowerCase();
    const canonical = byNorm.get(key);
    if (canonical && !seen.has(key)) {
      seen.add(key);
      out.push(canonical);
    }
  }
  return out;
}

async function parseStageWithRepair<T>(
  target: LinearStageTarget,
  initialMessages: ChatMessage[],
  tools: CoreTool[],
  maxSteps: number,
  schema: z.ZodType<T>,
  label: string,
  signal?: AbortSignal,
): Promise<{ data: T; usage: LinearDeskUsage; elapsedMs: number }> {
  let messages = initialMessages;
  let totalUsage = emptyUsage();
  let totalElapsedMs = 0;
  const maxAttempts = Math.max(1, 1 + LINEAR_PROFILE.maxRetries);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const res = await runCoreStage(target, messages, tools, maxSteps, signal);
    totalUsage = addUsage(totalUsage, res.usage);
    totalElapsedMs += res.elapsedMs;
    try {
      return {
        data: parseJsonStrict(res.text, schema, label),
        usage: totalUsage,
        elapsedMs: totalElapsedMs,
      };
    } catch (err) {
      if (signal?.aborted || !(err instanceof StageParseError) || attempt + 1 >= maxAttempts) throw err;
      messages = [
        ...messages,
        { role: "assistant", content: res.text },
        {
          role: "user",
          content: `Schema repair required: ${err.message}. Return valid raw JSON only.`,
        },
      ];
    }
  }
  throw new Error(`${label} exhausted retry budget`);
}

interface ExtractorSeedConfig {
  stageName: "research_extractor_a" | "research_extractor_b";
  preferredMember: string;
  seed: number;
  tools: CoreTool[];
  maxSteps: number;
}

async function runExtractorSeed(
  req: LinearDeskRequest,
  seedCfg: ExtractorSeedConfig,
  acquire: NonNullable<LinearDeskDeps["acquireTarget"]>,
  deadlineAtMs?: number,
): Promise<{
  boxName: string;
  modelId: string;
  sameBoxFallback: boolean;
  output: ResearchExtractionOutput;
  usage: LinearDeskUsage;
  elapsedMs: number;
  echo: LinearStagePromptEcho;
}> {
  const t0 = Date.now();
  const target = await acquire(seedCfg.preferredMember, seedCfg.seed, 0.2, 2560, deadlineAtMs, req.signal);
  try {
    const msgs = extractorMessages(req);
    const { data, usage } = await parseStageWithRepair(
      target,
      msgs,
      seedCfg.tools,
      seedCfg.maxSteps,
      ResearchExtractionSchema,
      `Stage 1 Extractor (${seedCfg.preferredMember})`,
      req.signal,
    );
    const elapsedMs = Math.max(0, Date.now() - t0);
    return {
      boxName: target.boxName,
      modelId: target.modelId,
      sameBoxFallback: target.sameBoxFallback,
      output: data,
      usage,
      elapsedMs,
      echo: buildPromptEcho({
        stage: seedCfg.stageName,
        role: "linear_research_extractor",
        artifactType: "desk_note",
        messages: msgs,
        modelId: target.modelId,
        box: target.boxName,
        elapsedMs,
      }),
    };
  } finally {
    target.release();
  }
}

function deduplicateDroppedFacts(
  candidates: Array<{ fact_id: string; reason: string }>,
  keptIds: Set<string>,
): Array<{ fact_id: string; reason: string }> {
  const deduped: Array<{ fact_id: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    const fid = (item.fact_id || "").trim();
    if (!fid || keptIds.has(fid) || seen.has(fid)) continue;
    seen.add(fid);
    deduped.push({ fact_id: fid, reason: item.reason });
  }
  return deduped;
}

function finalizeCriticCleanup(params: {
  scopedReq: LinearDeskRequest;
  reconciled: ReturnType<typeof reconcileAaExtractions>;
  preCheck: ReturnType<typeof verifyFactsAgainstLedger>;
  candidateById: Map<string, ExtractedFact>;
  cleaned: z.infer<typeof CriticCleanupSchema>;
  stageUsage: LinearDeskUsage;
  elapsedMs: number;
  echo: LinearStagePromptEcho;
}) {
  const { scopedReq, reconciled, preCheck, candidateById, cleaned, stageUsage, elapsedMs, echo } = params;
  const rawDropped = [...cleaned.dropped_facts];
  const explicitDropIds = new Set(cleaned.dropped_facts.map((d) => d.fact_id));
  const admittedById = new Map<string, ExtractedFact>();
  for (const f of cleaned.facts) {
    const origin = candidateById.get(f.fact_id);
    if (!origin) {
      rawDropped.push({ fact_id: f.fact_id, reason: "not_in_stage1_candidates" });
      continue;
    }
    admittedById.set(f.fact_id, {
      ...f,
      uncorroborated: origin.uncorroborated ?? false,
    });
  }
  // Preserve pre-verified Stage 1 facts unless explicitly dropped by the critic (claude:R3-F1)
  for (const verifiedPre of preCheck.verifiedFacts) {
    if (!admittedById.has(verifiedPre.fact_id) && !explicitDropIds.has(verifiedPre.fact_id)) {
      admittedById.set(verifiedPre.fact_id, verifiedPre);
    }
  }
  const postCheck = verifyFactsAgainstLedger(Array.from(admittedById.values()), scopedReq.ticker, scopedReq.ledger_entries);
  for (const m of postCheck.mismatches) {
    rawDropped.push({ fact_id: m.fact_id, reason: m.detail });
  }
  const keptIds = new Set(postCheck.verifiedFacts.map((f) => f.fact_id));
  return {
    dossier: {
      summary: reconciled.summary,
      facts: postCheck.verifiedFacts,
      catalysts: filterToStage1List(cleaned.catalysts, reconciled.catalysts),
      risks: filterToStage1List(cleaned.risks, reconciled.risks),
      data_gaps: filterToStage1List(cleaned.data_gaps, reconciled.dataGaps),
    },
    report: {
      passed: postCheck.mismatches.length === 0,
      llm_repaired: true,
      mismatches: preCheck.mismatches,
      dropped_facts: deduplicateDroppedFacts(rawDropped, keptIds),
      notes: cleaned.notes,
    },
    usage: stageUsage,
    elapsedMs,
    echo,
  };
}

async function runCriticStage(
  scopedReq: LinearDeskRequest,
  reconciled: ReturnType<typeof reconcileAaExtractions>,
  acquire: NonNullable<LinearDeskDeps["acquireTarget"]>,
  combinedSignal?: AbortSignal,
  deadlineAtMs?: number,
): Promise<{
  dossier: ResearchExtractionOutput;
  report: DataCriticReport;
  usage: LinearDeskUsage;
  elapsedMs: number;
  echo?: LinearStagePromptEcho;
}> {
  const effectiveSignal = combinedSignal ?? scopedReq.signal;
  const allCandidates = [...reconciled.corroboratedFacts, ...reconciled.uncorroboratedFacts];
  const preCheck = verifyFactsAgainstLedger(allCandidates, scopedReq.ticker, scopedReq.ledger_entries);
  if (preCheck.mismatches.length === 0 && reconciled.uncorroboratedFacts.length === 0) {
    return {
      dossier: {
        summary: reconciled.summary,
        facts: preCheck.verifiedFacts,
        catalysts: reconciled.catalysts,
        risks: reconciled.risks,
        data_gaps: reconciled.dataGaps,
      },
      report: { passed: true, llm_repaired: false, mismatches: [], dropped_facts: [], notes: [] },
      usage: emptyUsage(),
      elapsedMs: 0,
    };
  }

  const candidateById = new Map<string, ExtractedFact>();
  for (const cand of allCandidates) {
    if (!candidateById.has(cand.fact_id) || cand.uncorroborated === false) {
      candidateById.set(cand.fact_id, cand);
    }
  }

  const t0 = Date.now();
  const target = await acquire(undefined, 303, 0.1, 3584, deadlineAtMs, effectiveSignal);
  try {
    const msgs = criticMessages(
      scopedReq,
      allCandidates,
      preCheck.mismatches,
      reconciled.catalysts,
      reconciled.risks,
      reconciled.dataGaps,
    );
    try {
      const parsed = await parseStageWithRepair(
        target,
        msgs,
        [],
        1,
        CriticCleanupSchema,
        "Stage 2 Data Critic",
        effectiveSignal,
      );
      const elapsedMs = Math.max(0, Date.now() - t0);
      return finalizeCriticCleanup({
        scopedReq,
        reconciled,
        preCheck,
        candidateById,
        cleaned: parsed.data,
        stageUsage: parsed.usage,
        elapsedMs,
        echo: buildPromptEcho({
          stage: "data_critic",
          role: "linear_data_critic",
          artifactType: "critic_report",
          messages: msgs,
          modelId: target.modelId,
          box: target.boxName,
          elapsedMs,
        }),
      });
    } catch (err) {
      if (effectiveSignal?.aborted || scopedReq.signal?.aborted || !(err instanceof StageParseError)) throw err;
      const errMsg = err.message;
      const elapsedMs = Math.max(0, Date.now() - t0);
      logger.warn(`[LinearDesk] Stage 2 Data Critic LLM fallback for ${scopedReq.ticker} (${scopedReq.cycle_id}): ${errMsg}`);
      return {
        dossier: {
          summary: reconciled.summary,
          facts: preCheck.verifiedFacts,
          catalysts: reconciled.catalysts,
          risks: reconciled.risks,
          data_gaps: reconciled.dataGaps,
        },
        report: {
          passed: preCheck.mismatches.length === 0,
          llm_repaired: false,
          mismatches: preCheck.mismatches,
          dropped_facts: preCheck.mismatches.map((m) => ({ fact_id: m.fact_id, reason: m.detail })),
          notes: [`critic_llm_fallback: ${errMsg.slice(0, 160)}`],
        },
        usage: emptyUsage(),
        elapsedMs,
        echo: buildPromptEcho({
          stage: "data_critic",
          role: "linear_data_critic",
          artifactType: "critic_report",
          messages: msgs,
          modelId: target.modelId,
          box: target.boxName,
          elapsedMs,
        }),
      };
    }
  } finally {
    target.release();
  }
}

async function runTraderStage(
  req: LinearDeskRequest,
  dossier: ResearchExtractionOutput,
  acquire: NonNullable<LinearDeskDeps["acquireTarget"]>,
  deadlineAtMs?: number,
): Promise<{
  decision: TraderDecision;
  modelId: string;
  usage: LinearDeskUsage;
  elapsedMs: number;
  echo: LinearStagePromptEcho;
}> {
  const t0 = Date.now();
  const allowedPlaybookIds = new Set(
    (req.playbook_bullets ?? []).map((bullet) => bullet.id.trim()).filter(Boolean),
  );
  const schema = buildTraderSchema(req.portfolio_context.held, allowedPlaybookIds);
  const target = await acquire(undefined, 404, 0.2, 1536, deadlineAtMs, req.signal);
  try {
    const msgs = traderMessages(req, dossier);
    const { data, usage } = await parseStageWithRepair(
      target,
      msgs,
      [],
      1,
      schema,
      "Stage 3 Final Trader",
      req.signal,
    );
    const elapsedMs = Math.max(0, Date.now() - t0);
    return {
      decision: data,
      modelId: target.modelId,
      usage,
      elapsedMs,
      echo: buildPromptEcho({
        stage: "final_trader",
        role: "linear_final_trader",
        artifactType: "final_decision",
        messages: msgs,
        modelId: target.modelId,
        box: target.boxName,
        elapsedMs,
      }),
    };
  } finally {
    target.release();
  }
}

export function findMissingLedgerFollowupSlots(entries: Record<string, LedgerEntry>): string[] {
  const present = new Set(
    Object.values(entries || {})
      .map((e) => (e?.tool_name || "").trim())
      .filter(Boolean),
  );
  const missing: string[] = [];
  if (!present.has("get_market_data")) missing.push("market");
  if (!present.has("get_finviz_fundamentals") && !present.has("get_earnings_data")) missing.push("fundamentals");
  if (!present.has("get_finnhub_news") && !present.has("lazy_web_search")) missing.push("news");
  if (!present.has("get_upcoming_events")) missing.push("events");
  return missing;
}

/**
 * Unified 3-stage Linear Trading Pipeline inside `lazy-agent-service`:
 *   1. Research Extractor (Parallel A/A across `gold-spark` and `dell2`)
 *   2. Deterministic `FactLedgerVerifier` + 1-round Data Critic cleanup
 *   3. Unchecked Final Trader Agent (`BUY|HOLD|AVOID` unheld, `BUY|HOLD|SELL` held)
 */
export async function runLinearDeskPipeline(
  req: LinearDeskRequest,
  deps: LinearDeskDeps = {},
): Promise<LinearDeskResponse> {
  const pipelineStart = Date.now();
  const deadlineAtMs = pipelineStart + LINEAR_PROFILE.maxDurationMs;
  const acquire = deps.acquireTarget ?? defaultAcquireTarget;
  const pipelineAbort = new AbortController();
  const deadlineSignal = AbortSignal.timeout(LINEAR_PROFILE.maxDurationMs);
  const signals = [pipelineAbort.signal, deadlineSignal, ...(req.signal ? [req.signal] : [])];
  const combinedSignal = AbortSignal.any(signals);
  const scopedReq: LinearDeskRequest = { ...req, signal: combinedSignal };
  const tools = buildCoreTools(scopedReq, deps, { calls: 0, maxCalls: LINEAR_PROFILE.maxToolCalls });
  const missingSlots = findMissingLedgerFollowupSlots(req.ledger_entries || {});
  const skipPrefetchedFollowups = missingSlots.length === 0 && !deps.executeTool;
  const stage1Tools = skipPrefetchedFollowups ? [] : tools;
  const stage1MaxSteps = skipPrefetchedFollowups ? 1 : 3;

  const stage1Start = Date.now();
  let seedA: Awaited<ReturnType<typeof runExtractorSeed>>;
  let seedB: Awaited<ReturnType<typeof runExtractorSeed>>;
  try {
    [seedA, seedB] = await Promise.all([
      runExtractorSeed(
        scopedReq,
        {
          stageName: "research_extractor_a",
          preferredMember: "gold-spark",
          seed: 101,
          tools: stage1Tools,
          maxSteps: stage1MaxSteps,
        },
        acquire,
        deadlineAtMs,
      ),
      runExtractorSeed(
        scopedReq,
        {
          stageName: "research_extractor_b",
          preferredMember: "dell2",
          seed: 202,
          tools: stage1Tools,
          maxSteps: stage1MaxSteps,
        },
        acquire,
        deadlineAtMs,
      ),
    ]);
  } catch (err) {
    pipelineAbort.abort(err);
    throw err;
  }
  const stage1WallMs = Math.max(0, Date.now() - stage1Start);

  const reconciled = reconcileAaExtractions({
    boxA: seedA.boxName,
    boxB: seedB.boxName,
    modelId: seedA.modelId || seedB.modelId,
    modelA: seedA.modelId,
    modelB: seedB.modelId,
    sameBoxFallback: seedA.sameBoxFallback || seedB.sameBoxFallback || seedA.boxName === seedB.boxName,
    outputA: seedA.output,
    outputB: seedB.output,
  });

  const criticRes = await runCriticStage(scopedReq, reconciled, acquire, combinedSignal, deadlineAtMs);
  const traderRes = await runTraderStage(scopedReq, criticRes.dossier, acquire, deadlineAtMs);
  const totalUsage = addUsage(
    addUsage(seedA.usage, seedB.usage),
    addUsage(criticRes.usage, traderRes.usage),
  );
  const promptEcho: LinearStagePromptEcho[] = [
    seedA.echo,
    seedB.echo,
    ...(criticRes.echo ? [criticRes.echo] : []),
    traderRes.echo,
  ];
  const upperTicker = req.ticker.toUpperCase();

  return {
    ticker: upperTicker,
    cycle_id: req.cycle_id,
    model_id: traderRes.modelId || seedA.modelId || seedB.modelId,
    dossier: criticRes.dossier,
    aa_noise_metrics: reconciled.metrics,
    critic_report: criticRes.report,
    decision: traderRes.decision,
    stage_timings_ms: {
      stage1_a_ms: seedA.elapsedMs,
      stage1_b_ms: seedB.elapsedMs,
      stage1_wall_ms: stage1WallMs,
      stage2_ms: criticRes.elapsedMs,
      stage3_ms: traderRes.elapsedMs,
      total_ms: Math.max(0, Date.now() - pipelineStart),
    },
    usage: totalUsage,
    prompt_echo: promptEcho,
    learning_identity: {
      conversation_id: `${req.cycle_id}:${upperTicker}:${randomUUID()}`,
      output_hash: sha256Hex(JSON.stringify(traderRes.decision)),
    },
  };
}

/**
 * Offline Stage 3 replay entrypoint: evaluates `runTraderStage` over a saved
 * Stage 2 verified dossier with zero Stage 1/2 calls and zero external tools.
 */
export async function runLinearTraderReplay(
  req: ReplayTraderRequest,
  deps: LinearDeskDeps = {},
): Promise<ReplayTraderResponse> {
  const deadlineAtMs = Date.now() + LINEAR_PROFILE.maxDurationMs;
  const acquire = deps.acquireTarget ?? defaultAcquireTarget;
  const deadlineSignal = AbortSignal.timeout(LINEAR_PROFILE.maxDurationMs);
  const combinedSignal = AbortSignal.any([
    deadlineSignal,
    ...(req.signal ? [req.signal] : []),
  ]);
  const upperTicker = req.ticker.toUpperCase();
  const stageReq: LinearDeskRequest = {
    ticker: upperTicker,
    cycle_id: req.cycle_id,
    ledger_entries: {},
    portfolio_context: req.portfolio_context,
    macro_snapshot: req.macro_snapshot,
    directives: req.directives,
    playbook_bullets: req.playbook_bullets,
    ticker_history_card: req.ticker_history_card,
    signal: combinedSignal,
  };
  const traderRes = await runTraderStage(stageReq, req.dossier, acquire, deadlineAtMs);
  return {
    ticker: upperTicker,
    cycle_id: req.cycle_id,
    model_id: traderRes.modelId,
    box: traderRes.echo.box,
    decision: traderRes.decision,
    prompt_echo: traderRes.echo,
    usage: traderRes.usage,
    elapsed_ms: traderRes.elapsedMs,
  };
}
