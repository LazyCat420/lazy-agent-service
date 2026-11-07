---
part: Runtime & Pipeline
type: spec
status: verified
updated: 2026-11-07
last-verified: 2026-11-07
review-by: 2026-12-07
covers: lazy-agent-service:src/telemetry/otel.ts, lazy-agent-service:scripts/otel-smoke.mjs, lazy-agent-service:src/services/RequestLogger.ts, spark-console:request_throughput.py, spark-console:subscription_usage.py, spark-console:health_monitor.py, scraper-service:scraper_main.py, tts-service:app/piper_manager.py
---

# Telemetry and metrics

Three independent evidence layers: OpenTelemetry spans for request timing, durable request
rows for per-call audit, and tool-execution spans for per-tool latency/error metrics. "Did it
run, how long, did it fail?" is always answerable from stored data, never from memory.

## OpenTelemetry tracing

`src/telemetry/otel.ts` is loaded **before the app** —
`node --import ./dist/src/telemetry/otel.js dist/boot.js` in both the Dockerfile `CMD` and
`npm start` — and exports OTLP to the NAS observability stack:
otel-collector `:4318` → Tempo `:3200` → Grafana `:3300`. Search Grafana/Tempo for
**service name = `lazy-agent-service`**. (Beyla is not an option: the Synology kernel 4.4
predates eBPF; it crash-looped 270 times and was removed 2026-10-09.)

| Instrumentation | One span records |
|---|---|
| http + express | one incoming request with its Express route and middleware |
| undici | one outgoing `fetch` (vault, models, tools-service, …) |
| mongodb | one command — shape only, never values (`enhancedDatabaseReporting: false`) |

- `/health` is **not traced** (Docker polls it every 30 s; spans would bury real traffic).
- **Fails safe:** a missing package or dead collector changes nothing; boot logs
  `[otel] tracing off: …`.
- Settings: `OTEL_TRACING_ENABLED=0` disables; `OTEL_EXPORTER_OTLP_ENDPOINT` default
  `http://10.0.0.16:4318`; `OTEL_SERVICE_NAME` default `lazy-agent-service`.
- Known gap: batches export every 5 s, so the last ≤5 s of spans can be lost on container
  stop (the app's own shutdown handlers exit without flushing). If it ever matters, sample
  (`ParentBased(TraceIdRatioBased(0.1))`) instead of switching tracing off.

`npm run smoke:otel` (`scripts/otel-smoke.mjs`) proves the wiring against a fake OTLP
collector using the exact production load order, with a `SMOKE_TRACING=0` control run so every
check can fail: spans arrive, service name set, express route span, outgoing fetch span, and
`/health` served-but-untraced (requested over a raw socket, the way Docker's wget does it).

## Audit log — request rows

`RequestLogger` middleware writes a row for **every** handled request to the shared requests
collection (the historical `prism.requests` shape, kept so dashboards and audits reading the
collection keep working). Each row carries `timestamp` **and** `createdAt` (equal, pinned by
`RequestLoggerPrismParity.test.ts` — prism-era fix `d8a3c10`, still the contract), project /
username scope, tool/API name counts, and outcome. Trading's Monitor and the cycle audits
read these rows; a missing `createdAt` silently hides runs from every time-based reader.

## Per-tool metrics

Tool calls emit `tool_execution` spans into the telemetry-service SQLite DB
(`/app/data/telemetry.db`, spans table: `name`, `service_source`, `status`, `duration_ms`,
`raw_json`) — the only durable week-scale source, because container stdout is capped
(`json-file`, `max-size=10m, max-file=3` ≈ 1–1.5 h retention). Per-tool tables therefore
report, per tool: calls, failures, fail %, p50/p95 ms, truncations, malformed args, top
errors.

Caveats the metrics readers must know:

- A failure row from `[ToolRetryInterceptor] failed tool call(s): [tool(attempt:N)]` counts
  even when the retry eventually succeeded (span status OK) — fail % is pre-retry.
- `Trunc` counts results cut to the per-result limit (ch.03/05).
- Cross-contamination refusals (`Cross-contamination blocked: …`) are real refusals with
  100 %-of-that-tool failure share; they are guards working, not transport failures.
- Trading per-tool rows also print to stdout
  (`[lazycat.tool_registry] Tool Execution: <tool> by <agent> - OK|FAILED (<N>ms)`,
  lazycat-sdk `tool_registry.py`), but that is a window source, not history.

Benchmark baselines for read-only endpoints (400×4, NAS-local) sit at p50 ≈ 37–45 ms for
Express/one-Mongo-read paths and are re-measured whenever tracing changes.

## Fleet telemetry: spark-console

spark-console is the platform's hardware and model telemetry source. Folded from
spark-console's chapters 01, 02, 04 and 05.

### Live state and history

- **Live (15 min).** `hist` holds a 180-point deque per box for `mem`, `util`, `power` (GPU
  rail), `temp` and `plug` (wall), sampled every 5 s, plus `tok_s`; exposed in `GET /api/status`.
- **Tiered history.** `history.json` holds `1h`, `24h`, `7d`, `30d` and `1y` tiers, served by
  `GET /api/series?tier=`. `Tier._series()` pads a series first seen at runtime to the current
  bucket count, and `ts_load()` re-pads everything to one length, so a series added after a mode
  switch never misaligns with the others.
- **Per-model throughput.** Series are keyed by model, not box: `m:<slug>:tok` (generated
  tok/s), `m:<slug>:ptok` (prompt tok/s), `m:<slug>:w` (measured wall watts) and
  `m:<slug>:rail` (GPU rail watts), summed over every box serving that model — both Dells serve
  `Qwen3.8-Flash-Next`, so its line is their sum. `/api/series` returns a `models` registry
  (slug, id, boxes, fields) so a model that has since been unloaded still appears in history.
- **Temperature.** A dedicated `temp` history tab with an 85 °C throttle line, per-period
  current/peak summary, and node-card sparklines coloured amber at 70–79 °C and red at ≥80 °C.

### Reading TensorFold engines correctly

DeepSeek v4.1 on TensorFold exports no `tensorfold_health` namespace and its token counters only
advance when a request **finishes**, so `llm_live()` derives:

| Figure | Source |
|---|---|
| `tok_s` | Δ`generation_tokens_total` + Δ`generation_tokens_running` over the sampling interval (a negative sum — restart or cancel — discards the interval) |
| `prefill_tok_s` | Δ`prompt_tokens_total` / Δ`request_prefill_seconds_sum` |
| `kv_pct` | `max(kv_cache_usage_ratio{pool=N})` — the fullest pool, never the sum |
| `itl_avg_s`, `itl_p95_s` | `request_time_per_output_token_seconds` histogram |
| speculative acceptance | `mtp_accepted_total` / `mtp_drafted_total` |
| TTFT | `time_to_first_token_seconds` histogram |

GLM's live `tensorfold_health:completion_tokens_total` is used alone (adding the gauge to a live
counter would double-count). `live_token_counter` is true only for live sources, so the
"highest observed" maximum never records a completion-batch spike.

### Watts: wall versus rail

`<box>_plug` is the smart-strip outlet, `<box>_power` the GPU rail (`nvidia-smi`/`tegrastats`).
`serve_watts()` returns `None` when the wall reads below half the rail of the same hardware — a
mis-mapped or switched-off outlet, not that box's power — and `drop_implausible_outlets()`
un-maps such an outlet (`state["outlet_dropped"]`). The Dells have no strip outlet (wall
unknown, rail measured); the Jetson has a metered outlet but no SSH, so its rail is unknown. The
**model compare** widget (`tok/W`, `tok/s vs W`, `eff trend`, `token share`, `leaderboard`)
therefore ranks by tok/J on one named denominator at a time and reports how many models it
covers; it never mixes wall and rail inside one figure.

### Request throughput (`request_throughput.py`)

`bench-proxy.py` records every request through `:8000` in a ledger. From it:

- **Solo tok/s** (`SoloLedger`, `solo_summary`) uses only successful, complete, token-counted
  requests with peak concurrency exactly 1 and no contradicting overlap evidence:
  `sum(completion_tokens - 1) / sum((total_ms - ttft_ms) / 1000)`. Requests that hit the token
  limit or were interrupted are excluded; missing timing shows `—`.
- **Parallel average** (`aggregate_summary`) divides the same qualifying tokens by the **union
  of decode intervals**, so overlapping time counts once and prefill/idle gaps are excluded.
- **Combined maximum** is the highest observed output-token counter increase over the actual
  elapsed time between successful engine observations; it survives restarts and is an observed
  rate, not a hardware limit.
- A serving-mode switch, or unknown proxy coverage, disables solo verification until a fresh
  proof succeeds (`bench-concurrency-guard.py` routes local `:8001` calls through `:8000`).

### Token usage counter (`subscription_usage.py`)

Rolling windows `1h`, `5h`, `24h`, `7d`, `30d` and `all_time` over three sources:

| Source | Read from | Accounting |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | deduplicated by `message.id` (terminal record wins); input, output, cache read, 5 m and 1 h cache writes; incremental cursor per host |
| Google Antigravity / Argon | `~/.gemini/antigravity/` transcripts, read-only SQLite fallback | explicit usage when present, else calibrated `ceil(utf8_bytes / 4)`; model resolved per conversation |
| Self-hosted models | `~/.omp/stats.db`, read-only, aggregated in SQL | engine counters per `model · provider` row; `anthropic` and `google-antigravity` providers excluded to avoid double counting; `api_equiv_usd` always 0 |

Provider totals are `claude`, `google_argon`, `combined` (subscriptions only — never local),
`local` and `everything`. The 30-day API-equivalent cost is compared against the configured
subscription prices for an ROI figure. The workstation pushes its counts every 30 s
(`spark-sub-usage.timer` → `POST /api/subscription-usage`), persisted atomically to
`DATA_DIR/subscription_usage.json`.

### Incidents

Auto-heal restarts and container crashes are recorded by `autoheal_audit` and served by
`GET /api/audit/crashes`. `health_monitor.py` holds the read-only monitoring views the console
imports (`freshness` — `fresh`/`stale`/`unavailable` per sample, `ActivityMonitor`,
`parse_container_snapshot`, `kernel_error_view`); by design no observation there triggers a
restart, and a missing measurement never means an idle or crashed host.

## scraper-service health signals

| Signal | Route | Meaning |
|---|---|---|
| Liveness + counters | `GET /health` | HTTP client and browser dependency up; `engine_counters` (per-engine outcomes recorded by `record_engine_outcome`) and browser-slot usage |
| Engines (deep) | `GET /health/engines` | launches real browsers; by hand only |
| Search engines | `GET /health/search-engines` | SearXNG sidecar engines |
| Feeds | `GET /health/feeds` | per RSS feed: `last_success_at`, `last_failure_at`, `consecutive_failures`, `last_error` (from `feed_status`) |
| Host pid pressure | `GET /health/pids` | `/proc/loadavg` running/total tasks and last pid against `/proc/sys/kernel/pid_max`; `warn` at `SCRAPER_PID_WARN_RATIO` (0.4), `critical` at `SCRAPER_PID_CRIT_RATIO` (0.6); always 200, non-`ok` logged as a warning |

`/proc/loadavg` is not pid-namespaced, so inside the container `total_tasks` counts every task
on the NAS — which is the number that ran out on 2026-08-20 (fork failed at 21,024 of 32,768).
Domain quality (`domain_quality`) decides skips; feed status is visibility only — a feed is
never skipped.

## tts-service health signals

`GET /health` reports liveness and `engines: ["piper", "synth"]`. The Piper manager logs every
load and LRU eviction (`[PiperTTS] … slots used`, `Evicted '<voice>' from memory (LRU)`), which
is the record to read when synthesis latency jumps (a cache miss loads a model from the NAS
volume).
