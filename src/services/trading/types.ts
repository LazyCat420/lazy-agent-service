export type FactCategory =
  | "price"
  | "valuation"
  | "fundamental"
  | "technical"
  | "news"
  | "earnings"
  | "macro"
  | "risk";

export interface LedgerEntry {
  fact_id: string;
  tool_name: string;
  ticker?: string;
  as_of?: string;
  summary?: string;
  raw?: unknown;
}

export interface ExtractedFact {
  fact_id: string;
  category: FactCategory;
  metric: string;
  value: string;
  raw_number?: number | null;
  ticker?: string;
  as_of?: string;
  summary: string;
  uncorroborated?: boolean;
}

export interface ResearchExtractionOutput {
  summary: string;
  facts: ExtractedFact[];
  catalysts: string[];
  risks: string[];
  data_gaps: string[];
}

export interface AaNoiseMetrics {
  box_a: string;
  box_b: string;
  model_id: string;
  model_a?: string;
  model_b?: string;
  model_mismatch?: boolean;
  same_box_fallback: boolean;
  fact_flip_share: number;
  citation_jaccard: number;
  numeric_rel_spread_median: number | null;
  count_a: number;
  count_b: number;
  corroborated_count: number;
  uncorroborated_count: number;
}

export interface FactMismatch {
  fact_id: string;
  reason: "unknown_fact_id" | "ticker_mismatch" | "number_mismatch";
  detail: string;
}

export interface FactVerificationResult {
  verifiedFacts: ExtractedFact[];
  invalidFacts: ExtractedFact[];
  mismatches: FactMismatch[];
  hallucinationCount: number;
}

export interface DataCriticReport {
  passed: boolean;
  llm_repaired: boolean;
  mismatches: FactMismatch[];
  dropped_facts: Array<{ fact_id: string; reason: string }>;
  notes: string[];
}

export interface PortfolioContext {
  held: boolean;
  shares_owned: number;
  avg_cost: number | null;
  cash_usd: number;
  max_position_pct: number;
  equity_usd?: number;
}

export interface MacroSnapshot {
  vix?: number | null;
  spy_20d_return?: number | null;
  yield_10y_2y?: number | null;
  regime_note?: string;
}

export type TraderAction = "BUY" | "HOLD" | "AVOID" | "SELL";

export type DynamicTriggerType =
  | "price_below"
  | "price_above"
  | "rsi_14_oversold"
  | "rsi_14_overbought"
  | "sma_20_drop"
  | "sma_20_rise"
  | "sma_50_drop"
  | "sma_50_rise"
  | "sma_200_drop"
  | "sma_200_rise"
  | "trailing_drop";

export interface DynamicTriggerSpec {
  type: DynamicTriggerType;
  value: number;
}

export interface TraderDecision {
  action: TraderAction;
  entry_mode: "enter_now" | "enter_on_condition" | "watch_only";
  entry_condition: string | null;
  dynamic_trigger?: DynamicTriggerSpec | null;
  position_size_pct: number;
  stop_loss: number | null;
  take_profit: number | null;
  cited_fact_ids: string[];
  decision_thesis: string;
}

export interface LinearDeskStageTimings {
  stage1_a_ms: number;
  stage1_b_ms: number;
  stage1_wall_ms: number;
  stage2_ms: number;
  stage3_ms: number;
  total_ms: number;
}

export interface LinearDeskUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface LinearDeskRequest {
  ticker: string;
  cycle_id: string;
  ledger_entries: Record<string, LedgerEntry>;
  portfolio_context: PortfolioContext;
  macro_snapshot?: MacroSnapshot;
  followup_tools?: string[];
  signal?: AbortSignal;
}

export interface LinearDeskResponse {
  ticker: string;
  cycle_id: string;
  model_id: string;
  dossier: ResearchExtractionOutput;
  aa_noise_metrics: AaNoiseMetrics;
  critic_report: DataCriticReport;
  decision: TraderDecision;
  stage_timings_ms?: LinearDeskStageTimings;
  usage?: LinearDeskUsage;
}
