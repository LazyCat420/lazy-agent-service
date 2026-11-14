---
part: Operations & Quality
type: runbook
status: verified
updated: 2026-11-13
last-verified: 2026-11-13
review-by: 2026-12-13
covers: lazy-agent-service:deploy.sh, lazy-agent-service:package.json, lazy-agent-service:scripts/export_tool_schemas.py, lazy-agent-service:src/boot/server.ts, lazy-agent-service:src/boot/healthProbe.ts, lazy-agent-service:src/services/vllm/VllmShimService.ts, lazy-agent-service:config.ts, scraper-service:OPERATIONS.md, scraper-service:deploy.sh, spark-console:deploy.sh, tts-service:docker-compose.yml
---

# Operations and runbooks

Deployed on the Synology NAS as container **`lazy-agent-service`** on **:5591** (registry ID
`lazy-tool-service`; compose bind-mounts `./runtime-data`, so harness2 libraries and
obsidian-completions survive redeploys).

> **Rule first:** deploy this service **only when no trading cycle is running**. A restart
> breaks in-flight cycles whose tools and models route through it. Check the trading preflight
> / pipeline state first.

## Deploy

```bash
cd agents/lazy-agent-service
npm test                                    # green suite before landing
git push origin main                        # integrator only
npm run deploy                              # = bash deploy.sh
```

`deploy.sh` runs `npm run lint` in `PRE_TEST` (blocking deploys on any ESLint error, `S-14`
`c2f2d9c` / `466a83d`), builds the image, pushes to the registry, recreates the NAS container
and gates on health. Verify after:

1. `GET http://10.0.0.16:5591/health` → `200` with `status: "ok"` when Mongo and all enabled
   vLLM boxes answer within 2 s, `200` with `status: "degraded"` on partial box outage, or `503`
   with `status: "down"` if Mongo or every enabled box is down (`S-13`, `healthProbe.ts`, cached
   10 s; `jetson-2` is skipped unless `ENABLE_JETSON_2=1`).
2. `GET http://10.0.0.16:5591/vllm-shim/gold-spark/v1/models` → live served model catalog; after
   a `spark-console` serving-mode swap, a stale-model `/v1/chat/completions` call auto-heals on
   `404` and returns `X-Vllm-Shim-Live-Model` (`S-10`, `f10b64d`).
3. Container log shows `[otel] tracing ...` **on**, and no `[PrismMcpRedial]`-era lines
   (that service was retired with prism, `ee61164`).
4. `GET :5591/obsidian-completions` → `{version: 1, durableVaultChat: true}`.
5. `GET :5591/api/wallgarden/models` → Jetson gate telemetry present
   (`maxInFlight: 2, inFlight, queued, rejected`).
6. Grafana Tempo (`:3300`): a span for your own non-health call within a minute, service
   `lazy-agent-service` (`/health` itself is untraced by design).

## Regenerate `tool_schemas.json`

```bash
python3 scripts/export_tool_schemas.py            # from tool_schemas/<owner_app>/*.json
python3 scripts/export_tool_schemas.py --check    # must exit 0 (also runs as a gate)
python3 scripts/export_tool_schemas.py --out <other-repo>/tool_schemas.json
```

Commit the shards **and** the generated file together. `--check` exiting non-zero after your
edit means you forgot the regeneration. trading-service/trading-client copies refresh in
their own PRE_BUILD steps (which first probe `--supports-out`); byte-identity is proven by
`cmp` and `ToolSchemaExport.test.ts` (ch.05).

## MCP registration (current) and the Prism-era redial (historical)

There is **no Prism MCP re-registration any more**: prism-service was removed from the stack
2026-10-31 (`ee61164`); `PrismMcpRedial.ts`, `PrismProxyService.ts`, `PrismAttribution.ts`
and the `PRISM_MCP_*` compose variables are deleted and nothing forwards to `:7777`. If you
see a `PrismMcpRedial` or `prism-proxy` line in a current deploy, that is a regression —
open a P1 ticket.

Current MCP operations:

```bash
curl -s http://10.0.0.16:5591/mcp-servers | python3 -m json.tool   # registry rows: enabled/connected
curl -s -X POST http://10.0.0.16:5591/mcp-servers/<id>/connect     # re-dial an sse/http row
```

A stdio row will be refused unless its exact command is in `MCP_STDIO_COMMANDS` (ch.12).
Boot auto-connect runs `connectAllFromDB` through the same guard.

## Diagnosing a tool timeout / stuck run

1. **Is it the model or the tool?** Grafana Tempo: the request span shows which outgoing
   `fetch` span is open. A 240 000 ms p95 on one tool (the historical `get_market_data`
   figure) is a tool problem; slow first-token across tools is a box problem.
2. **Box health:** `DynamicModelResolver` probes instances live; check boot logs for the
   single-box fallback line — one online box takes all jobs and everything queues.
3. **Jetson saturation:** `GET /api/wallgarden/models` gate counters;
   `JetsonGateRejectedError` (503) after 90 s in queue means background traffic is being
   shed as designed (ch.04).
4. **Tool queue / rate limits:** `[ToolRetryInterceptor]` failure lines and
   `rate_limited`/`busy` returns from `web_search` mean Exa cooldown (60 s) or queue
   saturation, not a bug.
5. **Durable jobs:** stuck obsidian-completions? `GET /obsidian-completions/:id` reports
   status, `job.partial`, `job.activeTools`, live reasoning — a restart marks running jobs
   failed with an interruption note and never replays them.
6. **Evidence rows:** the requests collection + `tool_execution` spans in
   `/app/data/telemetry.db` give per-call outcome and latency for the window (ch.07).

## Log access (NAS)

```bash
ssh nas 'sudo -n /usr/local/bin/docker logs --since 1h lazy-agent-service 2>&1 | grep -E "Tool Retry|TOOL_STALL|otel" | tail -40'
```

stdout retention is ~1–1.5 h (`max-size=10m, max-file=3`); anything older comes from the
durable sources above. Long agent sessions keep running when the SSE client disconnects —
stop one deliberately via `POST /agent/stop`, never by killing the container.

## MCP network rows after TCK-1019

An `sse`/`streamable-http` row that pointed at a LAN host (`10.0.0.x`) or at the NAS itself now
gets `403` on save and is skipped at boot. To keep one, add its host or origin to
`MCP_HTTP_ALLOWLIST` (comma-separated) in the deploy environment and redeploy; then
`POST /mcp-servers/<id>/connect`. A `403` on that route names the refusal reason. URL
credentials are never accepted — move them to headers or OAuth.

## scraper-service runbooks

Detailed history and every measurement: `agents/scraper-service/OPERATIONS.md`.

**Deploy.** `./deploy.sh` (deploy-kit wrapper) first stages `app/scraper` from
`finance/trading/trading-service/app/scraper` and `lazycat/` from `platform/lazycat-sdk` —
both gitignored here — then builds and redeploys on the NAS. An engine fix therefore lands in
trading-service; a clean `git diff` in scraper-service proves nothing about the image.

**Is the host's pid space safe?**

```bash
curl -s http://10.0.0.16:8001/health/pids    # status ok | warn | critical | unknown
curl -s http://10.0.0.16:8001/health         # admission, rate_limiter, failure_cache, engine_counters, browser_slots
```

`warn` (≥40% of `pid_max`) means look now; `critical` (≥60%) means act: the 2026-08-20 outage
failed `fork()` at 64%. Find the owner of the tasks on the NAS before restarting anything —
the pressure may be another container. What bounds this service: `init: true` (tini reaps
orphans), `AdmissionGate` (`SCRAPER_ADMISSION_INFLIGHT=8`, `SCRAPER_ADMISSION_WAITING=16`, fast
`429` + `Retry-After: 5`), and `SCRAPER_MAX_BROWSERS` (default 4 per uvicorn worker).
`pids_limit` is silently discarded on this kernel — do not rely on it.

**A domain or feed stopped producing.** `GET /health/feeds` shows per-feed failures sorted
worst-first across the 26 active `RSS_FEEDS` (dead Yahoo Finance RSS removed in `S-18`,
`f4e85233`; visibility only — feeds are never skipped). A domain skip (`good_count == 0`,
`thin_streak >= 5`, last thin within 24 h) clears on the next good response, and
`browser_is_hopeless` (`browser_successes == 0`, `browser_tries >= 5`, last browser try within
24 h) skips Playwright escalation for 24 h while leaving one daily probe. `/app/logs` persists
three cross-worker SQLite WAL databases across `uvicorn --workers 2`: `failure_cache.db` (schema
v2, 7-day dead-link TTL, `lost_writes` tracked on `/health`), `rate_limiter.db`
(`SharedRateLimiter` + RFC-9110 `Retry-After`), and `scraper_metrics.db` (`engine_counters` with
`auto.skipped == sum(skip_reasons.values())`). Rows older than `SCRAPER_DOMAIN_MAX_AGE_S` (90
days) are pruned.

**SEC collector errors** with `set SEC_USER_AGENT` mean the identity is missing from the
scraper's environment; set it there (never in git) and redeploy.

## spark-console runbooks

The console runs on goldspark as the user unit `spark-console.service`
(`systemctl --user status|restart spark-console.service`,
`journalctl --user -u spark-console.service -f`). Restarting it never drops an in-flight
completion — `bench-proxy.py` is a separate process.

**Deploy.** The NAS gateway (`:8801`, `gateway.py`) is deployed with `npm run deploy` from
this working tree; use `npm run deploy -- --skip-pull` so a deployment does not replace newer
Gold Spark code with GitHub's older source.

**Switch the served model.** Use the console (`POST /api/serving-mode/{mode}`), never the start
scripts by hand: the console stops the outgoing deployment first, rewrites `omp-model` and
restarts the omp session (ch.04). Expect goldspark's model endpoint to be down for the whole
stop + start.

**The LLM vanished during a render.** That is the render-permit working: a ComfyUI render on a
box the LLM uses suspended it. It comes back by itself only with `auto_resume` on, after the
contending ComfyUI queues are idle for 300 s; otherwise toggle `deepseek` on.

**The LLM is stuck in `error`.** The reconciler retries up to 3 times in 15 min, then stops.
Read `GET /api/audit/crashes`, fix the cause, and toggle the LLM off and on.

**Boxes unreachable after a reboot (UFW, 2026-11-03).** goldspark and msi-spark once came up
with UFW allowing only 22 and 8888: the console (`8800`), bench proxy (`8000`), engine
(`8001`), ComfyUI (`8188`) and omp-ttyd (`7681`) were blocked from the LAN, and NFS (`2049`,
`111`) and NCCL were blocked on the fabric, so `dsv41` failed to boot on its NFS mount. The
standing rules allow all traffic on `192.168.177.0/24` and `192.168.178.0/24` and open those
five LAN ports on goldspark. Check with `nc -zv 192.168.177.11 2049` from msi-spark.

**A Dell box is not serving.** `boxes.json` must point at the real repo directory
(`~/Documents/github/Qwen3.8-Flash-Next-Single-DGX-Spark-TensorFold`); the reconciler
auto-launches it unless an operator stopped it (`POST /api/box/{box}/llm/on` re-enables).

## tts-service runbooks

**Deploy.** `./deploy.sh` builds and redeploys the NAS container (`3032:8080`). Piper models
live on the NAS at `/volume1/docker/tts-models`, mounted at `/app/data/piper_models`; adding a
voice is copying its `.onnx` + `.json` there, no rebuild — voices are resolved by path on
each request. An unknown voice name logs a warning and falls back to the `default` alias
(`en_US-lessac-medium`), so "wrong voice" is usually a missing file, not an error.

**500s from Piper on multi-sentence text.** onnxruntime 1.18.1's memory-pattern optimisation
corrupts ScatterND on the second run of a session, and Piper runs once per sentence. The
service builds its own `InferenceSession` with `enable_mem_pattern = False`; the per-voice lock
and retry are backstops. If 500s return after a dependency change, re-run the repro in
`tts-service/HANDOFF.md` first.

**Memory.** At most two Piper voices are resident (`MAX_LOADED_VOICES = 2`, LRU); the synth
engine needs no model files and caches up to 64 rendered clips.
