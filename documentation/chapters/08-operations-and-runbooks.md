---
part: Operations & Quality
type: runbook
status: verified
updated: 2026-11-06
last-verified: 2026-11-06
review-by: 2026-12-06
covers: lazy-agent-service:deploy.sh, lazy-agent-service:package.json, lazy-agent-service:scripts/export_tool_schemas.py, lazy-agent-service:src/boot/server.ts
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

`deploy.sh` builds the image, pushes to the registry, recreates the NAS container and gates
on health. Verify after:

1. `GET http://10.0.0.16:5591/health` → 200 (the boot endpoint registry logs the same list).
2. Container log shows `[otel] tracing ...` **on**, and no `[PrismMcpRedial]`-era lines
   (that service was retired with prism, `ee61164`).
3. `GET :5591/obsidian-completions` → `{version: 1, durableVaultChat: true}`.
4. `GET :5591/api/wallgarden/models` → Jetson gate telemetry present
   (`maxInFlight: 2, inFlight, queued, rejected`).
5. Grafana Tempo (`:3300`): a span for your own health call within a minute, service
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
