---
part: Operations
status: shipped
updated: 2026-10-09
---

# OpenTelemetry tracing (2026-10-09)

lazy-agent-service (deployed as `lazy-tool-service`, NAS port 5591) now sends a trace for every request it handles. The traces go to the NAS observability stack: otel-collector (port 4318), then Tempo (port 3200), then Grafana (port 3300). In Grafana's Tempo data source, search for **service name = `lazy-agent-service`**.

## Why not Beyla

Grafana Beyla was meant to trace every NAS container without code changes. It crash-looped 270 times and was removed on 2026-10-09. Beyla needs Linux kernel 4.18 or later (it uses eBPF), and the Synology NAS runs 4.4, so it can never work there. Tracing inside the service gives the same per-request timings, plus the calls made within each request.

## What is traced

`src/telemetry/otel.ts` is loaded before the app with `node --import ./dist/src/telemetry/otel.js dist/boot.js`, in both the Dockerfile `CMD` and `npm start`. It patches:

| Instrumentation | What one span records |
| --- | --- |
| http + express | one incoming request, with its Express route and middleware |
| undici | one outgoing `fetch`: calls to vault, models, tools-service and so on |
| mongodb | one MongoDB command. Only the command's shape is recorded, never its values (`enhancedDatabaseReporting: false`). |

- **Not traced:** `/health`. Docker checks it every 30 s, and those spans would bury real traffic.
- **Fails safe:** if a package is missing or the collector is down, the service runs exactly as before. Startup logs `[otel] tracing off: …` and nothing else changes.

| Setting | Default |
| --- | --- |
| `OTEL_TRACING_ENABLED=0` | tracing on (set to 0 to turn it off) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://10.0.0.16:4318` |
| `OTEL_SERVICE_NAME` | `lazy-agent-service` |

**Known gap:** spans are exported in batches every 5 s. Up to the last 5 s of spans can be lost when the container stops, because the app's own shutdown handlers exit without flushing them.

## Evidence

`npm run smoke:otel` (`scripts/otel-smoke.mjs`) starts a fake OTLP collector. It then runs a small Express app with the built module loaded exactly as production loads it.

| Check | Tracing on | `SMOKE_TRACING=0` (control) |
| --- | --- | --- |
| spans reached the collector | ok | FAIL (as expected) |
| service name set | ok | FAIL |
| express route span (`/work`) | ok | FAIL |
| outgoing fetch span (`/downstream`) | ok | FAIL |
| `/health` served (`HEALTH_HIT`) but not traced | ok | ok |

The control run shows that each check can fail. A first version of the test fetched `/health` from inside the app, so the outgoing-call span rightly contained `/health`. The test now sends that request over a raw socket, the way Docker's `wget` does.

## Benchmark: before tracing (live NAS, 2026-10-09)

Two read-only runs from WSL against `http://10.0.0.16:5591`. Times are in ms.

| Endpoint | n × concurrency | p50 | p95 | p99 | req/s |
| --- | --- | --- | --- | --- | --- |
| `/` (Express only) | 400 × 4 | 37.3–37.6 | 79–92 | 84–99 | 124–127 |
| `/settings` (one MongoDB read) | 400 × 4 | 39.0–44.7 | 91.5–91.8 | 114–131 | 88–108 |
| `/conversations?limit=20` (heavy query) | 40 × 2 | 132–171 | 296–565 | 547–1050 | 9–13 |

## Live after deploy (`d2c5152`, 2026-10-09 19:12)

- **The container runs with tracing.** `docker inspect lazy-agent-service` shows the command `["node","--import","./dist/src/telemetry/otel.js","dist/boot.js"]`, and the log has `[otel] tracing → http://10.0.0.16:4318 as lazy-agent-service`.
- **Tempo receives the traces.** Before the deploy, `/api/search/tag/service.name/values` listed only `trading-service`. After it, the list was `["lazy-agent-service","trading-service"]`. The traces include real traffic (`POST /mcp/messages`), not just the benchmark.
- **A trace shows the whole request.** One `GET /conversations` trace (`2b061de0…`) has 16 spans:
  - the HTTP request (37.3 ms);
  - every Express middleware: `authMiddleware`, `corsMiddleware`, `jsonParser`, `requestLoggerMiddleware`, `requireDb`;
  - the handler (36.6 ms);
  - eight MongoDB commands (`find model_conversations`, `find agent_conversations`, two `aggregate`s), 2.8–6.8 ms each.

## Overhead

**Before and after on the NAS cannot measure it.** After the deploy, `/` p50 was 8.6–12.7 ms (before: 37 ms) and `/settings` p50 was 8.8–9.8 ms (before: 39–45 ms). Tracing cannot make requests faster. The service had just restarted, and the NAS and WSL load differed from an hour earlier (WSL load was 27 during the baseline). The before/after comparison is confounded and is recorded here only to show that there was no visible slowdown.

**A/B under identical conditions.** The same Express app, with one route that makes an outgoing fetch, was run locally with tracing on and off in alternating rounds: 3 rounds of 3000 requests at concurrency 8, on Node 26 under testrun.

| | tracing off | tracing on | change |
| --- | --- | --- | --- |
| p50 | 2.13 ms | 3.46 ms | +1.3 ms |
| p95 | 7.30 ms | 9.87 ms | +2.6 ms |
| p99 | 34.3 ms | 37.7 ms | within noise |
| saturated throughput | 2388 req/s | 1576 req/s | −34% |
| memory (RSS) | 129 MB | 165 MB | +36 MB |

**What this means here.** Each request costs about 1.3 ms of extra CPU for its two spans (incoming and outgoing), plus about 36 MB of memory for the SDK. Real endpoints take 10–170 ms and receive a few requests per second, so that is roughly 1–10% of a request. Nothing in this service runs near the saturated rate.

**If it ever matters**, sample traces instead of recording every one: a `ParentBased(TraceIdRatioBased(0.1))` sampler in `otel.ts`. Or turn tracing off with `OTEL_TRACING_ENABLED=0`.
