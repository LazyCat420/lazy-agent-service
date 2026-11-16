---
part: Operations & Quality
type: reference
status: verified
updated: 2026-11-14
last-verified: 2026-11-14
review-by: 2026-12-14
covers: lazy-agent-service:.github/workflows/quality.yml, lazy-agent-service:deploy.sh, lazy-agent-service:scripts/quality/crap.mjs, lazy-agent-service:scripts/quality/dry.mjs, lazy-agent-service:scripts/quality/arch.mjs, lazy-agent-service:scripts/quality/prompt-budget.mjs, lazy-agent-service:scripts/eval/run-basic-eval.mjs, lazy-agent-service:scripts/audit-harness2-loop.ts, lazy-agent-service:scripts/otel-smoke.mjs, lazy-agent-service:src/boot/__tests__/healthProbe.test.ts, lazy-agent-service:src/services/__tests__/CanonicalProviderBudget.finalize.test.ts, lazy-agent-service:src/services/__tests__/ReadLedgerAndShimLiveModel.test.ts, lazy-agent-service:src/services/__tests__/TradingToolResolverIsolation.test.ts, lazy-agent-service:src/utils/__tests__/loopHonestyFields.test.ts, scraper-service:tests/test_health_probe_and_feeds.py, spark-console:tests/test_spark_console_telemetry.py, tts-service:tests/test_synth_engine.py
---

# Verification and gates

Every "done" claim in this repo must be reproducible by a named command. This chapter is the
index of which claim is proven by which gate. The quality programme itself (how the numbers
moved, the decomposition batches, the methodology adopted) is git history; the ledger entries
are tickets `TCK-*` in `documentation/tickets.jsonl`.

## The one command

```bash
npm run verify        # typecheck → lint → tests → dry → arch → prompt   (~35 s on main)
```

`verify` deliberately does **not** run `prettier --check`: the repo has never been
Prettier-formatted (406 files) and a mass reformat would bury every real diff. It is wired to
CI in `.github/workflows/quality.yml` (push/PR). The local pre-push hook is owned by the
workspace secret scanner, so the quality gate lives in CI, not in a second local hook. A
nightly job runs the full `npm run quality` (coverage + CRAP + dead code) with report
artifacts.

Every test, build or server run on `main` goes through
`testrun --wait 30m -- <command>`; never run one inside `.worktrees/`.

## Blocking gates

| Gate | Command | Threshold | Status |
|---|---|---|---|
| Types | `npm run typecheck` | 0 errors | blocking |
| Lint | `npm run lint` | ESLint `complexity` **error at 20**, `max-depth` 5, `max-params` 6, `max-lines-per-function` 150 (also enforced in `deploy.sh` `PRE_TEST`, `S-14` `c2f2d9c`) | 0 errors |
| CRAP | `npm run quality:crap` | **0** functions over McCabe 30, **0** over CRAP 60 | done (ratchet `ded73cf`) |
| Duplication | `npm run quality:dry` | logic duplication ≤ 8 % (declarative tables excluded) | 2.26 % (177 clones) |
| Architecture | `npm run quality:arch` | 0 dependency errors (`services-no-routes` is an error; `no-circular` is a warning pending the cycle cleanup) | 0 errors |
| Prompt budget | `npm run quality:prompt` | compact tool catalog ≤ 50 % of full, full ≤ 15,000 tokens | 2,918 / 12,888 (22.6 %) |
| Dead code | `npm run quality:deadcode` | report only | non-blocking (knip) |

Tests: `npm test` (vitest, excludes `**/.worktrees/**`). Baseline for the programme was
180 files / 1,930 tests; the quality pass landed **193 files / 2,000 tests (~16 s)** and
statement coverage moved 44.77 % → 47.85 % in one wave, then to **82.4 %** in the coverage
waves that closed the CRAP tail (2026-10-31, `ded73cf`).

## Named proofs (behavior → test)

| Behavior | Test / script |
|---|---|
| every caller endpoint lands on a native route (no `/prism-proxy`, no `:7777`) | `src/routes/__tests__/NativePrismExitRoutes.test.ts` |
| request rows carry `createdAt` equal to `timestamp` + `toolApiNameCount` (prism audit shape) | `src/services/__tests__/RequestLoggerPrismParity.test.ts` |
| shipped `tool_schemas.json` matches the `tool_schemas/<owner_app>/` shards | `src/services/__tests__/ToolSchemaExport.test.ts` + `python3 scripts/export_tool_schemas.py --check` |
| `POST /execute` fails closed: 503 when `EXECUTE_API_KEY` is unset, 401 without the key once set, 200 with it (signed `_lazy_trading_context` accepted either way) | `src/routes/__tests__/ExecuteApiKey.test.ts` |
| `POST /harness2/run` requires `runtimeAuth`: 401 without the token, 503 when no secret is configured | `src/routes/__tests__/Harness2Routes.test.ts` |
| Canvas persona upserted natively at boot | `src/services/__tests__/ClientPersonaSync.test.ts` |
| Harness² schedule, gates, proposer contract, library, selection | `src/services/harness2/__tests__/` — `Harness2.test.ts`, `Harness2Executor.test.ts`, `Harness2Library.test.ts`, `Harness2Proposer.test.ts`, `Harness2Selection.test.ts` (95 tests after the audit's Phase 1; the pre-audit green suite covered none of the 20 defects) |
| sandbox walls proven independently (ablation: each attack lands with its wall off, is blocked with it on) | `scripts/benchmarks/sandbox-redteam.mts` (6/6 PASS) |
| hallucinated tool names resolve to canonical tools; string/Python-repr arg coercion | `src/core/loop/__tests__/ToolRunner.test.ts` |
| trading-boundary: signed context required for `vllm-trading-bot`; markup-recovered calls carry it | `src/services/__tests__/NativeTradingBoundary.test.ts`, `src/providers/__tests__/` vllm/openai-compat cases |
| Harness² library scoped per mode and per run; `- mode:`/`- run:` recorded and filtered; reserved scope names refused (TCK-1020) | `src/services/harness2/__tests__/Harness2Library.test.ts`, `src/routes/__tests__/Harness2Routes.test.ts` |
| loop honesty fields (`answerSource`, `finalizeReason` including single-turn `CUT_OFF`, `providerAttempts`, `providerRetries`) emitted on SSE `done` and JSON `/agent` responses (`S-01`) | `src/utils/__tests__/loopHonestyFields.test.ts` |
| deep `GET /health` probe: 2 s raced Mongo + enabled vLLM `/v1/models` checks (`ok` / `degraded` / `down`), 10 s shared-flight cache, URL credential redaction, disabled `jetson-2` excluded (`S-13`) | `src/boot/__tests__/healthProbe.test.ts` |
| `/vllm-shim` `404` model-swap auto-heal (`X-Vllm-Shim-Live-Model` header + non-stream JSON `"model"` stamp, `S-10`) and `read_ledger_entry` in `LocalToolRouter.READ_ONLY_TOOLS` (`T2`) | `src/services/__tests__/ReadLedgerAndShimLiveModel.test.ts` |
| trading tool-resolution isolation: `AgenticToolResolver` unlocks core tools and strips unrequested `CORE_AGENTIC_TOOLS` / `search_web` / `CORE_ORCHESTRATOR_TOOLS` / `system` tools (`T3`) | `src/services/__tests__/TradingToolResolverIsolation.test.ts` |
| zero-byte failed stream with no usage chunks refunds the full speculative token reservation in `CanonicalProviderBudget.reconcileStreamBudget` so `CoreLoop` `PROVIDER_RETRY` does not trigger premature `TOKEN_BUDGET` finalization (`TCK-1028`, `e54d523`, `ed4b40c`) | `src/services/__tests__/CanonicalProviderBudget.finalize.test.ts` |
| mid-stream failure after yielding text chunks without usage telemetry retains `inputReserve + min(outputReserve, emittedBytes)` while allowing follow-up streams to complete (`R1-F2`, `ed4b40c`) | `src/services/__tests__/CanonicalProviderBudget.finalize.test.ts` |
| stream yielding a partial/empty usage chunk (`sawUsageChunk`) with zero text bytes before failing retains `inputReserve` instead of refunding to `0` (`R1-F3`, `ed4b40c`) | `src/services/__tests__/CanonicalProviderBudget.finalize.test.ts` |

## Audit and boundary scripts

| Script | What it reproduces |
|---|---|
| `scripts/audit-harness2-loop.ts` | the 20 Harness² audit defects (check ids `R1…R21`, fake deps, no network) — was 20/20 defects at audit time |
| `scripts/audit-trading-tool-boundary.ts` | the trading tool boundary (signed context, budget, refusals) |
| `scripts/harness2-live-check.ts`, `scripts/learning-boundary-replay.ts` | live LAN-model Harness² checks and the learning-boundary replay |
| `scripts/otel-smoke.mjs` (`npm run smoke:otel`) | span export reaches OTLP `:4318` → Tempo |
| `scripts/export_tool_schemas.py --check` / `--supports-out` | schema freshness gate + exporter-version probe (the trading deploys refuse a stale exporter) |

## Live evaluation (measured, not narrated)

`scripts/eval/run-basic-eval.mjs` runs 8 questions × profiles (`trading`, `html-notes`)
against the deployed service with a GLM-5.3 judge; question sets are
`scripts/eval/questions.json` and `chaos-questions.json`. The 2026-10-30 comparison
(deployed `57572df`) held grades at 14 PASS / 2 WEAK while wall time fell
1,688 s → 1,144 s (−32 %); artifacts under `.checks/`. Judge independence is a product
rule: `CriticGate` judges with a different model of the same provider and reports
`judgeIndependent`.

Parity against the retired prism loop was measured through **trading's own caller code**
(`trading-service scripts/harness/parity_check.py`), never log replays — prism strips
`systemPrompt`, `enabledTools` and `autoApprove` from stored requests, and without
`autoApprove` the `ApprovalGate` waits the full 120 s on every call. Six boundary-probe
contracts (oversized tool result, copied-text gate, forced final turn, cut stream,
hung tool, SSE vocabulary) all held on this loop (`f4d6e86`, 2026-10-07).

## Deploy-time verification

Deploy this service **only when no trading cycle is running** — a restart breaks in-flight
cycles that route tools and models through it. After deploys that touch tools or routing:
check the NAS log for `POST /execute/* 401` spikes, confirm the MCP tool list is non-empty
for a trading agent, and run `npm run smoke:otel`. Library and session state under
`runtime-data/` survives redeploys (bind mount, `docker-compose.yml`).

## The sibling services' gates

Each sibling is a Python repo tested with pytest from its own root, through `testrun` like
everything else. Counts below are the runs recorded on 2026-11-07 for the ledger's
`verified_by`.

| Repo | Command | Result (2026-11-07) | What it proves |
|---|---|---|---|
| scraper-service | `python3 -m pytest -q tests/` | 14 passed (2026-11-14) | `read_pid_pressure` ok/warn/critical/unknown, `/health/pids`, `bing`/`wikipedia` search-engine probe caching, `feed_status` / `/health/feeds`, and retirement of `test_edgar_stooq.py` + `twscrape` (Wave 1) |
| spark-console | `python3 -m pytest -q tests/test_solo_throughput.py tests/test_live_throughput.py tests/test_spark_console_telemetry.py tests/test_health_monitor.py` | 125 passed | solo/aggregate throughput rules, live TensorFold counters, per-model series alignment and summing, temperature history, remote-LLM reconciliation, monitoring views (TCK-1022) |
| tts-service | `python3 -m pytest -q tests/test_synth_engine.py` | 6 passed | reciter/prosody, frames, Klatt voice controls, post-conditioning of every preset, and the HTTP endpoints (TCK-1023) |

Stale contract tests covering deleted Wave 4C modules (`test/contract/AttributionAnalyzer.test.ts` and `test/contract/ExperimentStats.test.ts`) were removed alongside `AttributionAnalyzer.ts` and `ExperimentService.ts`, and `documentation/build_docs.py` + `documentation/index.html` were synced with `--project agent` (`b6ed40e`) so cross-project staging validates cleanly. `spark-console` also has DOM checks (`node tests/dashboard-ui.cjs`, `node tests/throughput-max-ui.cjs`) for the dashboard.

Wave 5 cleanup (`TCK-1028`, `e54d523`, `ed4b40c`) removed four zero-caller modules (`src/data/benchmarkPresets.ts`, `src/services/orchestrator/definitionRegistry.ts`, `src/services/orchestrator/TopologyRegistry.ts`, and `src/services/harnesses/strategies/ThoughtStructureRegistry.ts`) along with their stale doc-comment cross-references across `ReActHarness.ts`, `GraphOfThoughtsStrategy.ts`, `TreeOfThoughtsStrategy.ts`, and the eight `src/services/orchestrator/routers/*Router.ts` files, while retaining `WorkflowMemoryService.ts` (active in `src/services/system-prompt/index.ts` and `HookInitializer.ts` for `prism-chat`/non-trading projects) and `src/services/harnesses/RunningSummary.ts` (active in `PromptedToolCallingHarness.ts`). The same change also updated `CanonicalProviderBudget.reconcileStreamBudget` (`sawUsageChunk` tracking + deduplicated fallback charge) to release zero-byte, zero-usage failed stream reservations before `CoreLoop` `PROVIDER_RETRY` while retaining `inputReserve + Math.min(outputReserve, emittedBytes)` for mid-stream or partial-usage failures.

Named sibling proofs:

| Behavior | Test |
|---|---|
| two boxes serving one model sum into one per-model series; registry carries id and boxes | `spark-console/tests/test_spark_console_telemetry.py::test_per_model_throughput_sums_serving_boxes_and_registers_model` |
| runtime-named series stay bucket-aligned across a gap and a save/load | `…::test_tier_named_series_stay_bucket_aligned` |
| Dell standalone LLMs auto-launch and honour an operator stop | `…::test_remote_llm_reconciliation_and_autolaunch` |
| temperature tracked in live history and rendered in the dashboard | `…::test_temperature_telemetry_live_history`, `…::test_index_html_temperature_chart_and_sparklines` |
| self-hosted token counts never enter the subscription total or ROI | `spark-console/tests/test_subscription_usage.py` |
| host pid pressure classified and served with 200 | `scraper-service/tests/test_health_probe_and_feeds.py` |
| every synth preset renders clean audio; HTTP routes answer | `tts-service/tests/test_synth_engine.py` |
