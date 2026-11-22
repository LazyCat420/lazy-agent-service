import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import logger from "../../logger.js";
import { runCoreLoop } from "../../core/loop/CoreLoop.ts";
import type { ChatMessage, CoreModel, CoreTool } from "../../core/loop/types.ts";
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

function normalizeTraderDecision(raw: {
  action: TraderDecision["action"];
  entry_mode?: "enter_now" | "enter_on_condition" | "watch_only";
  entry_condition: string | null;
  dynamic_trigger: TraderDecision["dynamic_trigger"];
  position_size_pct: number;
  stop_loss: number | null;
  take_profit: number | null;
  cited_fact_ids: string[];
  decision_thesis: string;
}): TraderDecision {
  if (raw.action === "SELL") {
    return { ...raw, entry_mode: "enter_now", dynamic_trigger: null };
  }
  if (raw.action === "HOLD" || raw.action === "AVOID") {
    return { ...raw, entry_mode: "watch_only", dynamic_trigger: null };
  }
  if (raw.entry_mode === "enter_on_condition" && raw.dynamic_trigger) {
    return { ...raw, entry_mode: "enter_on_condition", dynamic_trigger: raw.dynamic_trigger };
  }
  if (raw.entry_mode === "watch_only" || raw.entry_mode === "enter_on_condition") {
    return { ...raw, entry_mode: "watch_only", dynamic_trigger: null };
  }
  return {
    ...raw,
    entry_mode: raw.position_size_pct > 0 ? "enter_now" : "watch_only",
    dynamic_trigger: null,
  };
}

function buildTraderSchema(held: boolean) {
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
      decision_thesis: z.string().min(1),
    })
    .transform((raw) => normalizeTraderDecision(raw));
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

async function runCoreStage(
  target: LinearStageTarget,
  messages: ChatMessage[],
  tools: CoreTool[],
  maxSteps: number,
  signal?: AbortSignal,
): Promise<CoreStageRunResult> {
  const t0 = Date.now();
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
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
  let promptTokens = 0;
  let completionTokens = 0;
  for (;;) {
    const step = await gen.next();
    if (!step.done) {
      const ev = step.value;
      if (ev && "type" in ev && ev.type === "usage") {
        promptTokens += Number(ev.usage.inputTokens ?? ev.usage.prompt_tokens ?? 0);
        completionTokens += Number(ev.usage.outputTokens ?? ev.usage.completion_tokens ?? 0);
      }
      continue;
    }
    const finalText = step.value.text || "";
    if (signal?.aborted || controller.signal.aborted || step.value.status === "cancelled") {
      const reason = signal?.reason ?? controller.signal.reason;
      if (reason instanceof DOMException && reason.name === "TimeoutError") {
        throw new PipelineTimeoutError(reason.message || "Linear stage timed out");
      }
      throw reason instanceof Error ? reason : new Error(step.value.error?.message || "Stage aborted");
    }
    if (step.value.status !== "completed" && !finalText) {
      throw mapStageFailure(step.value.error);
    }
    return {
      text: finalText,
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
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
): Promise<LinearStageTarget> {
  const acquired = await acquireLocalPoolTarget(preferredMember);
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

function renderLedgerPrompt(req: LinearDeskRequest): string {
  const items = Object.entries(req.ledger_entries || {}).map(([key, e]) =>
    formatPromptLedgerEntry(e, req.ticker, key),
  );
  return JSON.stringify({ ticker: req.ticker, cycle_id: req.cycle_id, ledger_entries: items });
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
        "You are Stage 2 (Data Critic Auditor). Your ONLY job is to verify and clean data before decision-making — NEVER emit a trade decision or opinion. Inspect every fact (especially `uncorroborated: true` claims and deterministic `mismatches`) against `ledger_entries`. Fix wrong numbers/tickers when grounded in `ledger_entries` or drop ungrounded claims into `dropped_facts`. Only include repaired or audited facts in `facts` (already-verified corroborated facts are preserved automatically unless listed in `dropped_facts`). Keep each fact `summary`, `dropped_facts[].reason`, and `notes` concise (<= 80 chars, no unescaped double-quotes), with at most 3 `notes`. Return raw JSON matching {facts:[...], catalysts:[], risks:[], data_gaps:[], dropped_facts:[{fact_id,reason}], notes:[]}.",
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

function traderMessages(
  req: LinearDeskRequest,
  dossier: ResearchExtractionOutput,
): ChatMessage[] {
  const held = req.portfolio_context.held;
  const allowedActions = held ? "BUY | HOLD | SELL" : "BUY | HOLD | AVOID";
  const actionRule = held
    ? "The portfolio currently holds this ticker; valid actions are BUY, HOLD, SELL."
    : "The portfolio does NOT hold this ticker; SELL is forbidden — valid actions are BUY, HOLD, AVOID.";
  return [
    {
      role: "system",
      content:
        `You are Stage 3 (Final Trader Agent) — the sole decision maker. Analyze the verified dossier alongside portfolio_context and macro_snapshot. ${actionRule} Normal digits and percentages (e.g. '20%', '1.5x', '$185') ARE encouraged in decision_thesis. Cite supporting fct_... IDs in cited_fact_ids. Use entry_mode="enter_now" to act immediately, "watch_only" for HOLD/AVOID or passive monitoring, or "enter_on_condition" ONLY on BUY accompanied by a structured dynamic_trigger ({type:"price_below|price_above|rsi_14_oversold|rsi_14_overbought|sma_20_drop|sma_20_rise|sma_50_drop|sma_50_rise|sma_200_drop|sma_200_rise|trailing_drop", value:number}). Return raw JSON: {action:"${allowedActions}", entry_mode:"enter_now|enter_on_condition|watch_only", entry_condition:string|null, dynamic_trigger:{type:string,value:number}|null, position_size_pct:number, stop_loss:number|null, take_profit:number|null, cited_fact_ids:string[], decision_thesis:string}.`,
    },
    {
      role: "user",
      content: JSON.stringify({
        ticker: req.ticker,
        portfolio_context: req.portfolio_context,
        macro_snapshot: req.macro_snapshot || {},
        verified_dossier: dossier,
      }),
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
}> {
  const t0 = Date.now();
  const target = await acquire(seedCfg.preferredMember, seedCfg.seed, 0.2, 2560, deadlineAtMs);
  try {
    const { data, usage } = await parseStageWithRepair(
      target,
      extractorMessages(req),
      seedCfg.tools,
      seedCfg.maxSteps,
      ResearchExtractionSchema,
      `Stage 1 Extractor (${seedCfg.preferredMember})`,
      req.signal,
    );
    return {
      boxName: target.boxName,
      modelId: target.modelId,
      sameBoxFallback: target.sameBoxFallback,
      output: data,
      usage,
      elapsedMs: Math.max(0, Date.now() - t0),
    };
  } finally {
    target.release();
  }
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
}> {
  const effectiveSignal = combinedSignal ?? scopedReq.signal;
  const allCandidates = [...reconciled.corroboratedFacts, ...reconciled.uncorroboratedFacts];
  const preCheck = verifyFactsAgainstLedger(allCandidates, scopedReq.ticker, scopedReq.ledger_entries);
  const needsLlmCritic = preCheck.mismatches.length > 0 || reconciled.uncorroboratedFacts.length > 0;

  if (!needsLlmCritic) {
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
  const target = await acquire(undefined, 303, 0.1, 3584, deadlineAtMs);
  try {
    let cleaned: z.infer<typeof CriticCleanupSchema>;
    let stageUsage = emptyUsage();
    try {
      const parsed = await parseStageWithRepair(
        target,
        criticMessages(scopedReq, allCandidates, preCheck.mismatches, reconciled.catalysts, reconciled.risks, reconciled.dataGaps),
        [],
        1,
        CriticCleanupSchema,
        "Stage 2 Data Critic",
        effectiveSignal,
      );
      cleaned = parsed.data;
      stageUsage = parsed.usage;
    } catch (err) {
      if (effectiveSignal?.aborted || scopedReq.signal?.aborted || !(err instanceof StageParseError)) throw err;
      const errMsg = err.message;
      logger.warn(`[LinearDesk] Stage 2 Data Critic LLM fallback for ${scopedReq.ticker} (${scopedReq.cycle_id}): ${errMsg}`);
      const fallbackDropped = preCheck.mismatches.map((m) => ({ fact_id: m.fact_id, reason: m.detail }));
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
          dropped_facts: fallbackDropped,
          notes: [`critic_llm_fallback: ${errMsg.slice(0, 160)}`],
        },
        usage: stageUsage,
        elapsedMs: Math.max(0, Date.now() - t0),
      };
    }
    const dropped = [...cleaned.dropped_facts];
    const explicitDropIds = new Set(cleaned.dropped_facts.map((d) => d.fact_id));
    const admittedById = new Map<string, ExtractedFact>();
    for (const f of cleaned.facts) {
      const origin = candidateById.get(f.fact_id);
      if (!origin) {
        dropped.push({ fact_id: f.fact_id, reason: "not_in_stage1_candidates" });
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
      dropped.push({ fact_id: m.fact_id, reason: m.detail });
    }
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
        dropped_facts: dropped,
        notes: cleaned.notes,
      },
      usage: stageUsage,
      elapsedMs: Math.max(0, Date.now() - t0),
    };
  } finally {
    target.release();
  }
}

async function runTraderStage(
  req: LinearDeskRequest,
  dossier: ResearchExtractionOutput,
  acquire: NonNullable<LinearDeskDeps["acquireTarget"]>,
  deadlineAtMs?: number,
): Promise<{ decision: TraderDecision; modelId: string; usage: LinearDeskUsage; elapsedMs: number }> {
  const t0 = Date.now();
  const schema = buildTraderSchema(req.portfolio_context.held);
  const target = await acquire(undefined, 404, 0.2, 1536, deadlineAtMs);
  try {
    const { data, usage } = await parseStageWithRepair(
      target,
      traderMessages(req, dossier),
      [],
      1,
      schema,
      "Stage 3 Final Trader",
      req.signal,
    );
    return {
      decision: data,
      modelId: target.modelId,
      usage,
      elapsedMs: Math.max(0, Date.now() - t0),
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
        { preferredMember: "gold-spark", seed: 101, tools: stage1Tools, maxSteps: stage1MaxSteps },
        acquire,
        deadlineAtMs,
      ),
      runExtractorSeed(
        scopedReq,
        { preferredMember: "dell2", seed: 202, tools: stage1Tools, maxSteps: stage1MaxSteps },
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

  return {
    ticker: req.ticker.toUpperCase(),
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
  };
}
