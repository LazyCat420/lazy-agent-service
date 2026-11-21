# Linear Trading Desk Contract (`trading-linear-v1`)

Unified 3-stage data-first linear trading harness hosted inside `agents/lazy-agent-service` (`:5591`).
Replaces split-brain Python harness loops (`platform/lazycat-sdk`, `CrossModelCrsiService`) with one TypeScript pipeline over the `gold-spark` + `dell2` local vLLM pool.

## Endpoint

- `POST /v1/trading/linear-desk` (authenticated via `runtimeAuth` `x-runtime-token`, profile `profiles/trading-linear-v1.json`)

### Request Body (`LinearDeskRequest`)

- `ticker`: string (`1..16`)
- `cycle_id`: string (`1..160`)
- `ledger_entries`: `Record<string, LedgerEntry>` (`fact_id`, `tool_name`, `ticker?`, `as_of?`, `summary?`, `raw?`) from `trading-service` deterministic Stage 0 prefetch (`whiteboard_ledger`)
- `portfolio_context`: `{ held, shares_owned, avg_cost, cash_usd, max_position_pct, equity_usd? }`
- `macro_snapshot?`: `{ vix?, spy_20d_return?, yield_10y_2y?, regime_note? }`
- `followup_tools?`: `string[]` (defaults to `["read_ledger_entry", "lazy_web_search"]`, dispatched read-only via `LocalToolRouter`)

## 3-Stage Linear Pipeline (`runLinearDeskPipeline`)

1. **Stage 1 — `research_extractor` (Parallel A/A on `gold-spark` + `dell2`)**
   - Default `VllmPool` members: `gold-spark,dell2` (`10.0.0.141:8000` and `10.0.0.37:8888`), discovered dynamically via `GET /v1/models`.
   - `x-pool-prefer-member` pins a box per seed (`101` on `gold-spark`, `202` on `dell2`); `VllmShimService` emits `x-pool-fallback: "1"` on same-box fallback.
   - Outputs objective facts/catalysts/risks/data_gaps grounded in `fct_...` IDs (no `BUY`/`SELL`/`HOLD`/`AVOID` recommendations).
   - `AaNoiseReconciler` compares A vs. B and computes `aa_noise_metrics`: `fact_flip_share`, `citation_jaccard`, `numeric_rel_spread_median`, `corroborated_count`, `uncorroborated_count`, `same_box_fallback`.

2. **Stage 2 — `FactLedgerVerifier` (0-GPU) + `data_critic` (1-round cleanup)**
   - Deterministic `verifyFactsAgainstLedger` checks every `fact_id`, `ticker`, and `raw_number` against `ledger_entries`.
   - Invokes `data_critic` (`maxSteps=1`) only when `mismatches` or `uncorroborated_count > 0` exist to clean numbers/citations or move ungrounded claims to `dropped_facts` (never emits trade opinions).

3. **Stage 3 — `final_trader` (1 tool-less pass, unchecked decision)**
   - Sole decision maker over verified `dossier`, `portfolio_context`, and `macro_snapshot`.
   - `held=false` permits `"BUY" | "HOLD" | "AVOID"`; `held=true` permits `"BUY" | "HOLD" | "SELL"`.
   - Normal digits and percentages are permitted in `decision_thesis` alongside `cited_fact_ids`.
   - Returns `{ ticker, cycle_id, model_id, dossier, aa_noise_metrics, critic_report, decision }`.
