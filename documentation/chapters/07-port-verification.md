# 07 — Port verification (2026-10-16)

Live proof that LazyCat420's apps run on lazy-agent-service (NAS :5591) with no Prism (:7777) traffic.
Source: NAS `docker logs` for `prism-service`, `lazy-agent-service`, `trading-service`; Mongo via `trading-service`.

## Prism traffic
- After the 07:47 UTC trading restart: **0** non-`/health` requests to prism-service through 09:05 UTC.
  Last caller before cutover: `vllm-trading-bot/lazy-trader GET /mcp-servers` 07:46:30.
- `/prism-proxy` on lazy-agent-service: **0** hits since 07:47.

## Trading cycle `cycle-v3-1792140750` (command `job-ae99dd1e`, AAPL/MSFT/NVDA)
- Started 08:52:30, `pipeline_state.status = done` 08:59:37. `trading-service` logged
  `prism_client.url set to http://10.0.0.16:5591 (PRISM_ENABLED=False)`.
- `analysis_results`: 3 rows. AAPL `v3_delta` HOLD conf 68 (5.1 KB result); NVDA `v3_delta_escalated` HOLD conf 68
  (31 KB result, RESEARCH → DEBATE → PM all SUCCESS); MSFT `v3_glance` skipped by the triage gate (no news, 1 h old),
  conf 0 by design.
- lazy-agent-service served the cycle's `POST /agent` (`vllm-trading-bot/lazycat-sdk`), `/embed`, `/chat`, `/agent/stop`.
- Not harness faults: yfinance 404s for symbols extracted from news (WRP, KONE); one AAPL claim-verification warning
  (2 of 6 numeric claims mismatched).

## html-notes
- `POST :8035/session/message` (JWST research ask) → 200 in 43 s, streamed a `data_card` widget; tools ran on
  lazy-agent-service (`/execute/news_search`, `/execute/web_search`); prism-service 0 hits.
- The `default/anonymous GET /config` poller (~2/min, from the NAS docker gateway) is html-notes' health probe
  (`app/main.py _agent_dependency_status`) and model list (`routes/message.py:28`); they now send scope headers.

## Music-player / strategy chat
- music-player `POST /agent` (music-player/admin) and trading strategy chat `/v1/runs` served natively.

## After Prism code removal (deployed 2026-10-16 09:59–10:14 UTC)
lazycat-sdk `19a2a52` (`agent_client`/`AgentClient`, `LAZY_AGENT_URL`), trading-service `dc46829c` (no `PRISM_ENABLED`
branches), trading-client `ab57ab38`, html-notes `915a8aa`, lazy-agent-service `727da8e`. NAS trading `.env` lost its
dead `PRISM_URL=:7777` / `PRISM_ENABLED=True` lines (backup `.env.bak-prism-removal-20261016`).

### Cycle #2 `cycle-v3-1792145034` (AMD/GOOGL/TSLA)
All three analysed on the native harness: AMD `v3_delta_escalated` HOLD 68 (35 KB), GOOGL `v3_delta` HOLD 70,
TSLA `v3_delta_escalated` HOLD 68 (32 KB); 142 pipeline events, 0 with status error/failed.

### Harness parity (`scripts/harness/parity_check.py`, 09:50–10:05 UTC)
| work | prism | ours |
|---|---|---|
| 6 boundary contracts | 6/6 PASS | 6/6 PASS (cut_stream 1 s, was 3–45 s) |
| v3_junior_analyst replay | answered, artifact, 45 s | answered, artifact, 71 s |
| v3_fundamental_analyst replay | answered, artifact, 132 s | answered, artifact, 127 s |
| v3_quant_analyst replay | answered, artifact, 99 s | answered, artifact, 73 s |
Oneshot arm skipped: cycle #2 went live. Only difference: prism forced a final turn on the junior replay; ours finished without needing one.

### Success rate (prism.requests, project vllm-trading-bot, `/agent`)
- Ours, every row after 10:06 UTC (native only): **162/165 success** (2 rows still `pending`, 1 failure).
- Prism baseline (ch.05): 197/300.

### `/prism-proxy`
Kept until 2026-10-23: its only caller is the parity tool's prism arm (comparison runs). Delete then if production
hits stay at 0.

### read_url (ch.08) live
`/agent` with `read_url` on `https://www.wsj.com/finance` → model told "HTTP 401 … site blocks automated fetchers";
log `[ReadUrl] tool=read_url host=www.wsj.com class=bot_blocked … error=HTTP 401`. Known gap: tools-service routes any URL
matching `/status/<n>` to its Twitter fetcher (`WebContentFetcher.ts:31`, Rod's repo), so such URLs come back as
"Invalid Twitter/X URL" and are classified `bot_blocked`.

## Outbound Prism calls removed

2026-10-16 (wt-no-prism-out) — `lazy-agent-service` no longer calls
`prism-service` (:7777) on any of its own code paths. This service is the
gateway; the live evidence that motivated this change was prism logging
`PUT /settings 200 [lazy-agent-service/admin]` every time this service
restarted, meaning healed settings were written to a second store the running
gateway then kept serving stale.

- `VllmModelSyncService.updateSettings` writes healed settings only through
  our own `SettingsService.update` (no `PUT ${REAL_PRISM_URL}/settings`, no
  direct-DB-vs-prism divergence). Verified by
  `src/services/__tests__/VllmModelSyncService.test.ts` ("writes the healed
  configuration through SettingsService, with no fetch to prism").
- `WallgardenService.callPrismChat` now calls the in-process
  `handleConversation` (the same handler the `POST /chat` route uses) instead
  of `POST ${REAL_PRISM_URL}/chat?stream=false`. Verified by
  `src/services/wallgarden/__tests__/WallgardenNoPrismOut.test.ts`.
- `PrismAttribution` headers are now used only by `PrismProxyService` (kept
  until 2026-10-23 for parity runs). Stale comments in `src/index.ts`
  (vllm-shim "sits below prism") and `MusicResearchPersona` (lazy_web_search
  "only resolves on real prism") updated to current reality.
- `grep -rn "7777\|REAL_PRISM_URL" src | grep -v __tests__` lists only
  `src/services/prism/PrismProxyService.ts`.

## Post-port cycle #3 findings (2026-10-16)

Cycle `cycle-v3-1792183632` (META/AMZN/NFLX) completed with 0 Prism requests and
tool_execution spans from both services. It surfaced three bugs, all fixed and
deployed (trading-service `18582e6c`, lazycat-sdk `ffdc12c`):

| Symptom | Cause | Fix |
|---|---|---|
| Board repair `EMPTY RESPONSE ... usage={}` | lazy-agent `/chat` streams SSE only with `Accept: text/event-stream` or `?stream=true`; `_chat_toolless_impl` sent neither and parsed the JSON reply as `''` | request SSE explicitly; `test_toolless_chat_requests_sse.py` |
| `Failed to fetch whiteboard summary: Expecting value` | 16 `whiteboard_entries` rows held plain-text content; `json.loads` raised and dropped the whole board | `_decode_content` in `whiteboard.py`; tests in `test_whiteboard_delivery.py` |
| `screener_query` validation failed (2 errors), AMZN triage forced to FULL | model sent list args JSON-encoded as strings | `ToolRegistry._validate_input` decodes JSON-string arrays/objects and retries; `test_registry_json_string_args.py` |

Note: lazy-agent's `/chat` docstring says "Default: SSE"; the code defaults to JSON.
Any other client that relies on the Prism-style default must send the Accept header.

## Post-port finding: harness memories reached trading runs (2026-10-16)

After the cutover, valuation `screener_query` use fell from 33/37 runs to 1/6
(fundamental and quant whiteboard writes fell with it); 5 of 6 valuation runs
answered on the first turn with no tool call. The provider payloads
(`pipeline_trace_events` stage `provider.payload`) show the system prompt,
tools, `tool_choice` and sampling byte-identical before and after. The one
difference: our assembler put 12-26k chars of `[Agent Memory]` and
`## Past Successful Workflows` in front of every V3 brief ("do not redundantly
fetch data already provided", other tickers' figures). Prism never sent them:
its memory fetch and workflow retrieval failed on every call
(`Unknown provider "jetson-embedding"`, 960 + 959 in 72 h; `0 new memories
injected` for every V3 assembly). `filterTradingPayload` only matched prism's
`<agent-memory>`-style tags, so it let our untagged blocks through with
`excluded_tags: []`.

Replay of the six post-cut valuation payloads against Gold Spark (same
sampling, 4 runs each): first-turn tool call 4/24 with the blocks, 16/24
without them.

Fix: the assembler skips skills, memories and workflows when
`excludesLearnedState(project)` (trading, boundary enabled), and the boundary
filter strips the native untagged blocks from the `[System Context]` message.
Tests: `system-prompt/__tests__/tradingLearnedState.test.ts`,
`TradingLearningBoundary.test.ts` ("strips our native assembler's untagged
skills, memories and workflows").
