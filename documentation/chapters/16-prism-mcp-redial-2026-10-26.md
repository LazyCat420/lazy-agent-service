---
part: Tools and shared services
status: shipped
updated: 2026-10-27
review-by: 2026-11-23
type: record
---

# Chapter 16 — Prism MCP re-dialer & LocalToolRouter repeat guards (2026-10-26 / 2026-10-27)

## Resolved tickets

| Ticket | Issue | Root cause | Fix | Commit |
|---|---|---|---|---|
| MCP-REDIAL (trading-client ch.47 row 4.3; 03-open-work §0 step 4) | After every lazy-agent-service deploy or restart, prism-service's agents lost all of this service's MCP tools until someone ran `curl -X POST http://10.0.0.16:7777/mcp-servers/6a764f9e6729baa25e6f2153/connect -H 'x-project: vllm-trading-bot' -H 'x-username: lazy-trader'` by hand. | Prism dials MCP servers only at its own boot (`MCPClientService.connectAllFromDB`). Its `connected` flag is just "an entry exists in its connection map": the entry is not removed when the transport closes, so after our restart prism kept reporting `connected: true` over a dead link. The old re-dialer lived in trading-client (`ef1705c3`) and left with the prism exit (`ab57ab38`); it also only re-dialled on `connected: false`, so it could not see this case. | `src/services/PrismMcpRedial.ts`, started from `server.listen` in `src/index.ts`. Boot: always dial (our old process took the old link with it), retry 5 s / 15 s / 60 s, then the periodic check. Every 5 min: `GET /mcp-servers`; dial when our server reads `connected: false`, **or** when this service holds no live, initialised MCP session whose client is named `prism` (`McpAdapter.countLiveClientSessions`), which catches prism's stale entry. Prism is not edited; only its HTTP interface is used. | branch `wt-mcp-redial` |
| H-5 & Wave A (`LocalToolRouter.ts`) | Trading desk agents called `whiteboard_read`, `peer_comparison`, `data_completeness`, `get_earnings_data`, and `get_upcoming_events` multiple times with identical args in a single desk run; `LocalToolRouter.ts` also carried 12 dead `music_player_*` switch arms. | Only `get_market_data` had a per-run repeat guard, and retired `music_player_*` switch cases were duplicated 12 times. | Added `REPEAT_GUARDED_TOOLS` in `src/services/LocalToolRouter.ts` covering all 6 idempotent desk tools and collapsed the `music_player_*` arms into a single `startsWith('music_player_')` check. | `1003bb2` |

## How it works

Prism endpoints (prism-service `src/routes/McpServersRoutes.ts`, read-only, 2026-10-26):

- `POST /mcp-servers/:id/connect` (line 324). Scope comes from the `x-project` / `x-username` headers. Prism's `MCPClientService.connect` replaces an existing connection of the same server first (`MCPClientService.ts` 600-602), so a repeat dial is safe. 200 `{success: true, toolCount, tools, ...}`; 200 `{success: false, authorizationRequired: true}` for OAuth servers; 404 unknown id in this scope; 409/502/503 `{error}` when the dial fails.
- `GET /mcp-servers` (line 128). The scope's servers (plus shared ones) with `id`, `enabled`, `connected`, `toolCount`, `connectedAt`. Query params instead of headers resolve another scope and answer `[]`.

Decision per periodic check:

| prism says | live `prism` session here | action |
|---|---|---|
| unreachable / non-200 / not a list | — | log, skip (no dial) |
| our id not in the list | — | log an error (wrong `PRISM_MCP_SERVER_ID` or scope), skip |
| `enabled: false` | — | leave it alone |
| `connected: false` | — | dial |
| `connected: true` | 0 | dial (stale entry), at most once per `PRISM_MCP_STALE_REDIAL_MIN_MS` (1 h); otherwise log and skip |
| `connected: true` | ≥ 1 | healthy, nothing |

Timers are chained `setTimeout`s, `unref()`'d, never overlap, and are cleared by `stop()` (registered with the shutdown cleanup). Nothing throws out of a timer; startup is never blocked. Every dial logs `[PrismMcpRedial] re-dialing prism → ... (reason: ...)` and its result.

Stale-entry guard: if the local count reads 0 over a healthy link (a different client name, an idled-out session), the stale rule would replace prism's live connection every check and could cut in-flight tool calls. So stale-entry re-dials are limited to one per hour, and if the first check after one still reads 0 live local sessions the service logs once: `[PrismMcpRedial] local session check reads 0 right after a re-dial; the stale-entry rule is unreliable here`. Seeing that line means set `PRISM_MCP_CLIENT_NAME=""` (turns the stale rule off) and investigate. Boot and `connected: false` dials are not limited.

A session counts only after the MCP initialize handshake (`Server.getClientVersion()`), so an SSE auto-reconnect that never re-initialised does not hide a dead link.

## Configuration

Set in `docker-compose.yml` (not secrets). Unset URL or ID = disabled (logged once at boot).

| Env | Default in compose | Code default |
|---|---|---|
| `PRISM_MCP_REDIAL_URL` | `http://10.0.0.16:7777` | unset (disabled) |
| `PRISM_MCP_SERVER_ID` | `6a764f9e6729baa25e6f2153` | unset (disabled) |
| `PRISM_MCP_PROJECT` | `vllm-trading-bot` | `vllm-trading-bot` |
| `PRISM_MCP_USERNAME` | `lazy-trader` | `lazy-trader` |
| `PRISM_MCP_REDIAL_INTERVAL_MS` | `300000` | `300000` |
| `PRISM_MCP_REDIAL_BOOT_DELAY_MS` | — | `5000` |
| `PRISM_MCP_REDIAL_BOOT_RETRIES_MS` | — | `5000,15000,60000` |
| `PRISM_MCP_REDIAL_TIMEOUT_MS` | — | `60000` |
| `PRISM_MCP_STALE_REDIAL_MIN_MS` | — | `3600000` |
| `PRISM_MCP_CLIENT_NAME` | empty (stale rule off, since 10-26) | `prism` (empty string turns the local-session check off) |

## How to verify after a deploy

1. Container log shows the boot dial and its result:
   `ssh <nas> "docker logs lazy-agent-service 2>&1 | grep PrismMcpRedial | tail -5"` → `enabled: ...`, `re-dialing prism → ... (reason: boot: ...)`, `prism re-connected to this service: N tools`.
2. Prism's view (`connectedAt` must be after the deploy time):
   ```
   curl -s http://10.0.0.16:7777/mcp-servers -H 'x-project: vllm-trading-bot' -H 'x-username: lazy-trader' \
     | python3 -c 'import json,sys; [print(s["name"], s["connected"], s["toolCount"], s["connectedAt"]) for s in json.load(sys.stdin) if s["id"]=="6a764f9e6729baa25e6f2153"]'
   ```

## Tests

`src/services/__tests__/PrismMcpRedial.test.ts` drives the real `PrismMcpRedialer` against a fake prism HTTP server on 127.0.0.1, and the real `McpAdapter` with real MCP SDK SSE clients: boot dial (even when prism says connected), re-dial on `connected: false`, no dial when healthy, re-dial on stale entry, disabled server left alone, wrong scope reported, boot retry with backoff, stale-entry re-dial limited to one per hour with the unreliable-check warning logged once, connected:false not limited, prism down (no crash, no unhandled rejection), `stop()`, disabled when env unset, session counting by client name.

## Not done / open

- Not deployed by this change; the orchestrator lands and deploys.
- If prism itself restarts, prism re-dials at its own boot; the periodic check covers the case where that boot dial failed because this service was down.

## Measured on the NAS, 2026-10-26: the stale rule is off

From the 07:53 UTC deploy to 16:03 UTC the boot dial worked (prism reconnected 5 s after boot, 72 tools), and the stale-entry rule then fired once an hour (08:03, 09:03 ... 16:03 UTC), each time over a healthy link. The cause is in lazy's own log: prism's SSE stream closes about every 5 minutes and reconnects 3 s later with a new session id (`SSE connection closed for session ...`, `New SSE connection request received`), and a reconnected SSE stream sends no new `initialize`, so `countLiveClientSessions("prism")`, which counts only sessions that finished the handshake, reads 0 while prism is connected and working. The hourly guard kept it to one needless re-dial an hour, as designed. Compose now sets `PRISM_MCP_CLIENT_NAME` empty, which turns the stale rule off; the boot dial and the `connected:false` re-dial stay. Turn it back on only with a session check that survives SSE reconnects.

Open, not ours to fix: why prism's SSE stream to lazy closes every ~5 minutes (an idle timeout in between is LIKELY).
