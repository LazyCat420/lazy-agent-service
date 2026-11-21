import { z } from "zod";
import { runCoreLoop } from "../../core/loop/CoreLoop.ts";
import type { ChatMessage, CoreModel, CoreTool } from "../../core/loop/types.ts";
import { routeLocalTool } from "../LocalToolRouter.ts";
import { reconcileAaExtractions } from "./AaNoiseReconciler.ts";
import { verifyFactsAgainstLedger } from "./FactLedgerVerifier.ts";
import {
  acquireLocalPoolTarget,
  createPoolCoreModel,
  releasePoolTarget,
} from "./LocalPoolClient.ts";
import type {
  DataCriticReport,
  ExtractedFact,
  LinearDeskRequest,
  LinearDeskResponse,
  ResearchExtractionOutput,
  TraderDecision,
} from "./types.ts";

const ExtractedFactSchema = z.object({
  fact_id: z.string().min(1),
  category: z
    .enum(["price", "valuation", "fundamental", "technical", "news", "earnings", "macro", "risk"])
    .default("fundamental"),
  metric: z.string().min(1),
  value: z.string().min(1),
  raw_number: z.number().finite().nullable().optional(),
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

function buildTraderSchema(held: boolean) {
  return z.object({
    action: held ? z.enum(["BUY", "HOLD", "SELL"]) : z.enum(["BUY", "HOLD", "AVOID"]),
    entry_mode: z.enum(["enter_now", "enter_on_condition", "none"]).default("none"),
    entry_condition: z.string().nullable().default(null),
    position_size_pct: z.number().min(0).max(100).default(0),
    stop_loss: z.number().finite().nullable().default(null),
    take_profit: z.number().finite().nullable().default(null),
    cited_fact_ids: z.array(z.string()).default([]),
    decision_thesis: z.string().min(1),
  });
}

export interface LinearStageTarget {
  boxName: string;
  modelId: string;
  sameBoxFallback: boolean;
  model: CoreModel;
  release(): void;
}

export interface LinearDeskDeps {
  acquireTarget?: (preferredMember: string | undefined, seed: number, temperature: number) => Promise<LinearStageTarget>;
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

function parseJsonStrict<T>(raw: string, schema: z.ZodType<T>, stage: string): T {
  const jsonText = stripFenceAndThink(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`${stage} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const checked = schema.safeParse(parsed);
  if (!checked.success) {
    throw new Error(`${stage} failed schema validation: ${checked.error.issues.map((i) => `${i.path.join(".")}:${i.message}`).join("; ")}`);
  }
  return checked.data;
}

function buildCoreTools(req: LinearDeskRequest, deps: LinearDeskDeps): CoreTool[] {
  const names = req.followup_tools?.length ? req.followup_tools : ["read_ledger_entry", "lazy_web_search"];
  return names
    .filter((name) => Boolean(DEFAULT_FOLLOWUP_TOOLS[name]))
    .map((name) => ({
      name,
      description: DEFAULT_FOLLOWUP_TOOLS[name].description,
      parameters: DEFAULT_FOLLOWUP_TOOLS[name].parameters,
      execute: async (args) => {
        if (deps.executeTool) return deps.executeTool(name, args, req);
        return routeLocalTool(name, args, {
          agentName: "v3_linear_extractor",
          cycleId: req.cycle_id,
          ticker: req.ticker,
        });
      },
    }));
}

async function runCoreStage(
  target: LinearStageTarget,
  messages: ChatMessage[],
  tools: CoreTool[],
  maxSteps: number,
  signal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const gen = runCoreLoop({
    model: target.model,
    tools,
    messages,
    signal: controller.signal,
    maxSteps,
    tradingRun: true,
  });
  let finalText = "";
  for (;;) {
    const step = await gen.next();
    if (step.done) {
      finalText = step.value.text || "";
      if (step.value.status !== "completed" && !finalText) {
        throw new Error(step.value.error?.message || `CoreLoop ended with status ${step.value.status}`);
      }
      return finalText;
    }
  }
}

async function defaultAcquireTarget(
  preferredMember: string | undefined,
  seed: number,
  temperature: number,
): Promise<LinearStageTarget> {
  const acquired = await acquireLocalPoolTarget(preferredMember);
  return {
    boxName: acquired.member.name,
    modelId: acquired.modelId,
    sameBoxFallback: acquired.sameBoxFallback,
    model: createPoolCoreModel(acquired, { preferredMember, seed, temperature, maxTokens: 4096 }),
    release: () => releasePoolTarget(acquired.member.name),
  };
}

function renderLedgerPrompt(req: LinearDeskRequest): string {
  const items = Object.values(req.ledger_entries || {}).map((e) => ({
    fact_id: e.fact_id,
    tool_name: e.tool_name,
    ticker: e.ticker || req.ticker,
    as_of: e.as_of || "",
    summary: (e.summary || "").slice(0, 1200),
    raw: e.raw ?? null,
  }));
  return JSON.stringify({ ticker: req.ticker, cycle_id: req.cycle_id, ledger_entries: items });
}

function extractorMessages(req: LinearDeskRequest): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are Stage 1 (Research Extractor). Organize verified objective facts, numbers, catalysts, risks, and data_gaps strictly from the supplied whiteboard_ledger (and optional read-only follow-up tools). EVERY fact must cite an exact `fact_id` (`fct_...`), exact `ticker`, and exact `raw_number` from that entry. FORBIDDEN: Do NOT recommend BUY, SELL, HOLD, or AVOID, and do NOT invent facts. Return raw JSON matching {summary, facts:[{fact_id,category,metric,value,raw_number,ticker,as_of,summary}], catalysts:[], risks:[], data_gaps:[]}.",
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
  return [
    {
      role: "system",
      content:
        "You are Stage 2 (Data Critic Auditor). Your ONLY job is to verify and clean data before decision-making — NEVER emit a trade decision or opinion. Inspect every fact (especially `uncorroborated: true` claims and deterministic `mismatches`) against `ledger_entries`. Fix wrong numbers/tickers when grounded in `ledger_entries` or drop ungrounded claims into `dropped_facts`. Return raw JSON matching {summary, facts:[...], catalysts:[], risks:[], data_gaps:[], dropped_facts:[{fact_id,reason}], notes:[]}.",
    },
    {
      role: "user",
      content: JSON.stringify({
        ticker: req.ticker,
        mismatches,
        candidate_dossier: { facts: candidateFacts, catalysts, risks, data_gaps: dataGaps },
        ledger_entries: Object.values(req.ledger_entries || {}),
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
        `You are Stage 3 (Final Trader Agent) — the sole decision maker. Analyze the verified dossier alongside portfolio_context and macro_snapshot. ${actionRule} Normal digits and percentages (e.g. '20%', '1.5x', '$185') ARE encouraged in decision_thesis. Cite supporting fct_... IDs in cited_fact_ids. Return raw JSON: {action:"${allowedActions}", entry_mode:"enter_now|enter_on_condition|none", entry_condition:string|null, position_size_pct:number, stop_loss:number|null, take_profit:number|null, cited_fact_ids:string[], decision_thesis:string}.`,
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

async function runExtractorSeed(
  req: LinearDeskRequest,
  preferredMember: string,
  seed: number,
  tools: CoreTool[],
  acquire: NonNullable<LinearDeskDeps["acquireTarget"]>,
): Promise<{ boxName: string; modelId: string; sameBoxFallback: boolean; output: ResearchExtractionOutput }> {
  const target = await acquire(preferredMember, seed, 0.2);
  try {
    const raw = await runCoreStage(target, extractorMessages(req), tools, 4, req.signal);
    const output = parseJsonStrict(raw, ResearchExtractionSchema, `Stage 1 Extractor (${preferredMember})`);
    return { boxName: target.boxName, modelId: target.modelId, sameBoxFallback: target.sameBoxFallback, output };
  } finally {
    target.release();
  }
}

async function runCriticStage(
  req: LinearDeskRequest,
  reconciled: ReturnType<typeof reconcileAaExtractions>,
  acquire: NonNullable<LinearDeskDeps["acquireTarget"]>,
): Promise<{ dossier: ResearchExtractionOutput; report: DataCriticReport }> {
  const allCandidates = [...reconciled.corroboratedFacts, ...reconciled.uncorroboratedFacts];
  const preCheck = verifyFactsAgainstLedger(allCandidates, req.ticker, req.ledger_entries);
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
    };
  }

  const target = await acquire(undefined, 303, 0.1);
  try {
    const raw = await runCoreStage(
      target,
      criticMessages(req, allCandidates, preCheck.mismatches, reconciled.catalysts, reconciled.risks, reconciled.dataGaps),
      [],
      1,
      req.signal,
    );
    const cleaned = parseJsonStrict(raw, CriticCleanupSchema, "Stage 2 Data Critic");
    const postCheck = verifyFactsAgainstLedger(cleaned.facts, req.ticker, req.ledger_entries);
    const dropped = [
      ...cleaned.dropped_facts,
      ...postCheck.mismatches.map((m) => ({ fact_id: m.fact_id, reason: m.detail })),
    ];
    return {
      dossier: {
        summary: cleaned.summary || reconciled.summary,
        facts: postCheck.verifiedFacts,
        catalysts: cleaned.catalysts,
        risks: cleaned.risks,
        data_gaps: cleaned.data_gaps,
      },
      report: {
        passed: postCheck.mismatches.length === 0,
        llm_repaired: true,
        mismatches: preCheck.mismatches,
        dropped_facts: dropped,
        notes: cleaned.notes,
      },
    };
  } finally {
    target.release();
  }
}

async function runTraderStage(
  req: LinearDeskRequest,
  dossier: ResearchExtractionOutput,
  acquire: NonNullable<LinearDeskDeps["acquireTarget"]>,
): Promise<{ decision: TraderDecision; modelId: string }> {
  const schema = buildTraderSchema(req.portfolio_context.held);
  const target = await acquire(undefined, 404, 0.2);
  try {
    const baseMsgs = traderMessages(req, dossier);
    const firstRaw = await runCoreStage(target, baseMsgs, [], 1, req.signal);
    try {
      return { decision: parseJsonStrict(firstRaw, schema, "Stage 3 Final Trader"), modelId: target.modelId };
    } catch (firstErr) {
      const retryMsgs: ChatMessage[] = [
        ...baseMsgs,
        { role: "assistant", content: firstRaw },
        {
          role: "user",
          content: `Schema repair required: ${firstErr instanceof Error ? firstErr.message : String(firstErr)}. Return valid raw JSON only.`,
        },
      ];
      const secondRaw = await runCoreStage(target, retryMsgs, [], 1, req.signal);
      return { decision: parseJsonStrict(secondRaw, schema, "Stage 3 Final Trader"), modelId: target.modelId };
    }
  } finally {
    target.release();
  }
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
  const acquire = deps.acquireTarget ?? defaultAcquireTarget;
  const tools = buildCoreTools(req, deps);

  const [seedA, seedB] = await Promise.all([
    runExtractorSeed(req, "gold-spark", 101, tools, acquire),
    runExtractorSeed(req, "dell2", 202, tools, acquire),
  ]);

  const reconciled = reconcileAaExtractions({
    boxA: seedA.boxName,
    boxB: seedB.boxName,
    modelId: seedA.modelId || seedB.modelId,
    sameBoxFallback: seedA.sameBoxFallback || seedB.sameBoxFallback || seedA.boxName === seedB.boxName,
    outputA: seedA.output,
    outputB: seedB.output,
  });

  const { dossier, report } = await runCriticStage(req, reconciled, acquire);
  const { decision, modelId } = await runTraderStage(req, dossier, acquire);

  return {
    ticker: req.ticker.toUpperCase(),
    cycle_id: req.cycle_id,
    model_id: modelId || seedA.modelId || seedB.modelId,
    dossier,
    aa_noise_metrics: reconciled.metrics,
    critic_report: report,
    decision,
  };
}
