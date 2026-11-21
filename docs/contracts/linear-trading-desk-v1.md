# Linear Trading Desk Contract (`trading-linear-v1`, Contract `v1.0.0`)

Unified 3-stage data-first linear trading harness hosted inside `agents/lazy-agent-service` (`:5591`).
Replaces split-brain Python harness loops (`platform/lazycat-sdk`, `CrossModelCrsiService`) with one TypeScript pipeline over the `gold-spark` + `dell2` local vLLM pool.

### HTTP API Surface Update

- **Added:** `POST /v1/trading/linear-desk` (`runtimeAuth` protected).
- **Removed:** `POST /harness2/crsi/selftest` (cross-repo grep across `apps/`, `agents/`, `finance/` confirmed zero callers outside the retired `CrossModelCrsi` module).

## Endpoint

- `POST /v1/trading/linear-desk` (`runtimeAuth` `x-runtime-token`, loading `profiles/trading-linear-v1.json`: enforces `max_duration_ms=180000`, `max_tool_calls=6` shared across Stage 1 seeds via synchronous slot reservation, `allowed_local_tools`, per-turn `maxTokens=4096`, and Stage 3 schema `max_retries=1`).

### Request Body (`LinearDeskRequest`)

- `ticker`: string (`1..16`)
- `cycle_id`: string (`1..160`)
- `ledger_entries`: `Record<string, LedgerEntry>` (`fact_id`, `tool_name`, `ticker?`, `as_of?`, `summary?`, `raw?`) from `trading-service` deterministic Stage 0 prefetch (`whiteboard_ledger`)
- `portfolio_context`: `{ held, shares_owned, avg_cost, cash_usd, max_position_pct, equity_usd? }`
- `macro_snapshot?`: `{ vix?, spy_20d_return?, yield_10y_2y?, regime_note? }`
- `followup_tools?`: `string[]` (filtered by `profiles/trading-linear-v1.json` `allowed_local_tools`, bounded by `budget_limits.max_tool_calls=6`, dispatched via `LocalToolRouter`)

## 3-Stage Linear Pipeline (`runLinearDeskPipeline`)

1. **Stage 1 — `research_extractor` (Parallel A/A on `gold-spark` + `dell2`)**
   - Default `VllmPool` members: `gold-spark,dell2` (`10.0.0.141:8000` and `10.0.0.37:8888`), discovered dynamically via `GET /v1/models`, respecting `VllmShimService.semaphoreFor(member)` concurrency limits and `budget_limits.max_duration_ms=180000`.
   - `x-pool-prefer-member` pins a box per seed (`101` on `gold-spark`, `202` on `dell2`); sibling seed abort cancels the paired call if either seed rejects. `VllmShimService` emits `x-pool-fallback: "1"` whenever delivery falls back to a non-preferred box.
   - Outputs objective facts/catalysts/risks/data_gaps grounded in `fct_...` IDs (no `BUY`/`SELL`/`HOLD`/`AVOID` recommendations).
   - `AaNoiseReconciler` compares deduplicated A vs. B facts and computes `aa_noise_metrics`: `model_a`, `model_b`, `model_mismatch`, `fact_flip_share`, `citation_jaccard`, `numeric_rel_spread_median`, `corroborated_count`, `uncorroborated_count`, `same_box_fallback`.

2. **Stage 2 — `FactLedgerVerifier` (0-GPU) + `data_critic` (1-round cleanup)**
   - Deterministic `verifyFactsAgainstLedger` uses `Object.hasOwn` lookup, checks ledger entry & fact `ticker`, and enforces numeric grounding for numeric categories (`price`, `valuation`, `fundamental`, `technical`) or digit-bearing values against structured `entry.raw` fields (excluding date tokens).
   - Invokes `data_critic` (`maxSteps=1`) only when `mismatches` or `uncorroborated_count > 0` exist to clean numbers/citations or move ungrounded claims to `dropped_facts`; Critic output is strictly constrained to Stage 1 candidate `fact_id`s with `uncorroborated` provenance preserved (never emits trade opinions).

3. **Stage 3 — `final_trader` (1 tool-less pass, unchecked decision)**
   - Sole decision maker over verified `dossier`, `portfolio_context`, and `macro_snapshot`, bounded by `budget_limits.max_retries=1` for schema repair.
   - `held=false` permits `"BUY" | "HOLD" | "AVOID"`; `held=true` permits `"BUY" | "HOLD" | "SELL"`.
   - Normal digits and percentages are permitted in `decision_thesis` alongside `cited_fact_ids`.
   - Returns `{ ticker, cycle_id, model_id, dossier, aa_noise_metrics, critic_report, decision }`.
