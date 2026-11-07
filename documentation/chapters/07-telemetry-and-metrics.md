---
part: Runtime & Pipeline
type: spec
status: verified
updated: 2026-11-06
last-verified: 2026-11-06
review-by: 2026-12-06
covers: lazy-agent-service:src/telemetry/otel.ts, lazy-agent-service:scripts/otel-smoke.mjs, lazy-agent-service:src/services/RequestLogger.ts
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
