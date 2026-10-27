---
part: Security and operations
status: approved
updated: 2026-10-16
type: record
---

# 08 — Tool Metrics (one week, 2026-10-09 → 2026-10-16)

## Date & scope

- Generated: 2026-10-16 (UTC), window = trailing 168 h.
- **Important data caveat:** both `trading-service` and `lazy-agent-service` were recreated on 2026-10-16 and use `json-file` logging with `max-size=10m, max-file=3`. Docker logs therefore only retain **~1–1.5 h** of stdout, not a full week. The only durable week-scale source is the `telemetry-service` SQLite DB (`/app/data/telemetry.db` inside the `telemetry-service` container), which holds per-tool `tool_execution` spans. Trading per-tool numbers below are from the retained docker-log window (2026-10-16 00:52–01:57 UTC) and are **not** a true week; the telemetry DB contains **no** per-tool spans from trading-service (it emits only `kind='generic'` spans).

## Tool inventory

- `tool_schemas.json`: **86 tools** (widget ×5, canvas ×3, html_notes ×22, strain ×10, trading/market ~30, research, whiteboard, watchlist, misc).
- `src/services/ToolOrchestratorService.ts` local routing: `html_notes_*`, `canvas_*`, `create_widget`…, `strain_*`, `lazy_web_search` (routes through `src/services/LocalToolRouter.ts`, which implements the `strain_*` cases).
- Built-ins also offered: `think`, `execute_python`, `emit_structured_output`, `ask_user`, `get_music`, `read_url`, `read_web_page`, `search_news`.
- Trading catalog logged via `[lazycat.tool_registry] ... Tool Execution: <tool> by <agent> - OK|SUCCESS|FAILED (<N>ms)` in `platform/lazycat-sdk/lazycat/tool_registry.py:1051`.

## Exact commands used

```bash
# local repo (read only)
python3 -c "…print names from tool_schemas.json…"
grep -nE "…tool names…" src/services/ToolOrchestratorService.ts src/services/LocalToolRouter.ts

# NAS
ssh nas 'sudo -n /usr/local/bin/docker ps --format "{{.Names}}"'
ssh nas 'sudo -n /usr/local/bin/docker logs --since 168h trading-service 2>&1 | grep "Tool Execution:"' | python3 /tmp/pp.py
ssh nas 'sudo -n /usr/local/bin/docker logs --since 168h lazy-agent-service 2>&1'   # event/retry/truncation scans
ssh nas 'sudo -n /usr/local/bin/docker exec trading-service sh -c "ls /app/logs/cycles | tail"'   # cycle jsonl have NO tool steps in last 7d (only June canaries)
ssh nas 'sudo -n /usr/local/bin/docker cp /tmp/week.py telemetry-service:/tmp/ && sudo -n /usr/local/bin/docker exec telemetry-service python3 /tmp/week.py'
# week.py: SELECT name,service_source,status,duration_ms,raw_json FROM spans WHERE kind='tool_execution' AND start_time>=now-7d, grouped by tool
```

## Table — sorted by failures × calls (descending)

Failures for lazy-agent rows include retry-injected failed attempts (`[ToolRetryInterceptor] failed tool call(s): [tool(attempt:N)]`); span status was OK after retry. Truncations = `result cut to the per-result limit`.

| Tool | Calls | Failures | Fail % | p50 ms | p95 ms | Trunc | Malformed | Top errors |
|---|---|---|---|---|---|---|---|---|
| read_url | 29 | 10 | 34% | 766 | 2210 | 0 | 0 | (error text not retained; docker log pretty-printer truncates) |
| get_music | 24 | 1 | 4% | 618 | 1619 | 0 | 0 | (same) |
| get_market_data | 6 | 3 | 50% | 88 | 240003 | 0 | 0 | `Cross-contamination blocked: MSFT != AAPL` (×2, trading) + 1 retry |
| whiteboard_read | 39 | 0 | 0% | 52 | 494 | 0 | 0 | — |
| get_finnhub_news | 10 | 0 | 0% | 56 | 192 | 4 | 0 | — (results repeatedly truncated) |
| read_web_page | 7 | 0 | 0% | 615 | 3775 | 0 | 0 | — |
| search_news | 9 | 0 | 0% | 317 | 846 | 0 | 0 | — |
| whiteboard_annotate | 4 | 0 | 0% | 54 | 63 | 0 | 0 | — |
| emit_structured_output | 5 | 0 | 0% | 5 | 6 | 0 | 0 | — |
| screener_query | 5 | 0 | 0% | 77 | 315 | 0 | 0 | — |
| get_upcoming_events | 3 | 0 | 0% | 471 | 511 | 0 | 0 | — |
| get_institutional_holdings | 3 | 0 | 0% | 171 | 420 | 0 | 0 | — |
| get_reddit_trending_stocks | 3 | 0 | 0% | 46 | 56 | 0 | 0 | — |
| whiteboard_write | 3 | 0 | 0% | 71 | 133 | 0 | 0 | — |
| list_scheduled_research | 2 | 0 | 0% | 213 | 213 | 0 | 0 | — |
| get_earnings_data | 2 | 0 | 0% | 158 | 158 | 0 | 0 | — |
| whiteboard_summarize | 2 | 0 | 0% | 266 | 266 | 0 | 0 | — |
| get_parameters | 2 | 0 | 0% | 371 | 371 | 0 | 0 | — |
| lazy_web_search | 2 | 0 | 0% | 829–850 | 850 | 0 | 0 | — |
| news_search | 2 | 0 | 0% | 3205 | 3205 | 0 | 0 | — (docker-log window only) |
| web_search | 1 | 0 | 0% | 1436 | 1436 | 0 | 0 | — (docker-log window only) |
| search_equations | 1 | 0 | 0% | 1100 | 1100 | 0 | 0 | — |
| get_polygon_price_history | 1 | 0 | 0% | 1669 | 1669 | 0 | 0 | — |
| run_equation | 1 | 0 | 0% | 141 | 141 | 0 | 0 | — |

Harness-level counters (lazy-agent-service, retained docker-log window): `MALFORMED_TOOL_CALL_JSON` = 0, `PERMISSION_DENIED` = 0, retry-guidance injections = 10, result truncations = 4 (all `mcp__lazy-agent-service__get_finnhub_news`).

## Offered but never called in the window (69 of 86 + 3 builtins)

Widget: `create_widget`, `list_widget_types`, `plan_widget`, `update_widget`, `validate_widget_html`
Canvas: `canvas_add_widget`, `canvas_modify_dom`, `canvas_read_dom`
html_notes (all 22): `html_notes_create_note` … `html_notes_app_action`
Strain (all 10): `strain_search`, `strain_detail`, `strain_terpene_profile`, `strain_forum_posts`, `strain_images`, `strain_import`, `strain_import_status`, `strain_neighbors`
Trading/risk: `calculate_hrp_allocation`, `calculate_position_size`, `calculate_risk_reward`, `calculate_stop_loss`, `forecast_volatility_garch`, `get_portfolio_covariance`, `get_portfolio_state`, `get_position_pnl`, `get_strategy_health`, `run_backtest`, `save_equation`, `get_congress_trades`, `get_finviz_fundamentals`, `get_insider_trades`, `get_options_flow`, `get_sec_filings`, `get_smart_money_leaderboard`, `get_smart_money_leads`, `get_smart_money_signal`, `get_technical_indicators`, `scrape_url`
Research/watchlist: `propose_parameter_change`, `cancel_scheduled_research`, `request_research_now`, `schedule_research`, `run_tool_chain`, `add_to_watchlist`, `buy_stock`, `remove_from_watchlist`, `sell_stock`, `watch_ticker`, `list_watches`, `clear_watch`
Builtins: `think`, `execute_python`, `ask_user`

## Takeaways for "what to improve"

1. `read_url` is the reliability outlier: 1/3 of attempts fail and get retried; no error text survives logging (the pino pretty-printer truncates messages with `…[+N]`) — fix log fidelity first, then the fetch retries.
2. `get_finnhub_news` never fails but its results are truncated 4/10 calls — the per-result limit is too small for its payload.
3. `get_market_data` fails on cross-ticker contamination guards and showed a 240 s p95 outlier; worth a timeout + stricter arg validation.
4. 69/86 catalog tools (80%) plus `think`/`execute_python`/`ask_user` had zero calls — candidates for pruning from default tool lists to cut context size.
5. Trading-service per-tool observability is missing from telemetry (only `generic` spans) and its docker logs rotate within ~1 h — add `tool_execution` spans to make week-scale metrics possible.

## read_url fixes (2026-10-16)

Durable source: telemetry-service SQLite `spans` table (`/volume1/docker/telemetry-service/data/telemetry.db` on the NAS, read-only). 38 `read_url` `tool_execution` spans in the 7 d window; 9 carried `error_message`.

### Error-class table (7 d)

| Class | Count | Example URLs |
|---|---|---|
| HTTP 404 (page does not exist) | 6 | reggaedb.org/artist/Winston+Fergus, unitedreggae.com/news/n1012, en.wikipedia.org/wiki/Winston_Fergus |
| HTTP 403 (bot block) | 2 | discogs.com/artist/251731, discogs.com/artist/283733 |
| HTTP 401 (bot block / auth) | 1 (prior window, same class) | reuters.com/markets/us/ |

Older-than-7-d spans confirm the same two dominant classes: 403s on thestreet.com, investopedia.com, apnews.com, and a 401 on reuters.com. No timeout, PDF, redirect, size-cap, or DNS failures were recorded in the window; the top cause is bot-blocking, second is dead URLs.

### What changed (lazy-agent-service, `wt-read-url`)

- `ToolOrchestratorService.executeTool` now routes `read_url` through `executeReadUrl` instead of forwarding it raw to tools-service (tools-service itself is untouched).
- Every failure is classified (`classifyReadUrlError`: `bot_blocked` 401/403, `not_found` 404/410, `server_error` 5xx, `timeout`, `network`, `other`) and logged as ONE structured line — `tool=`, `host=`, `class=`, `url=`, full untruncated `error=` — so log fidelity no longer depends on the pretty-printer.
- The model's error text now states what happened and what to do (e.g. 403 → "this site blocks automated fetchers. Do not retry this URL; try scrape_url or read_web_page, or use another source.").
- Bot-blocked (401/403) URLs fall back to our own WebExtractService (scraper-service, engine auto) before failing; 404s do not waste a fallback fetch.
- Tests: `src/services/__tests__/ReadUrlFailures.test.ts` drives the real `executeTool("read_url", …)` path against a local HTTP server standing in for tools-api + scraper-service (success passthrough, 403 fallback success, 403 fallback failure, 404 no-fallback, full-error retention, arg validation). Each fails on reverted source: the reverted code forwarded read_url raw and returned `{error: "HTTP 403: …"}` with no fallback or guidance.

### Follow-up fixes (2026-10-16, `wt-tool-fixes2`)

**`read_url` misroute (`/status/\d+` → Twitter fetcher).** tools-service's platform detector
(`tools-service/src/fetchers/web/WebContentFetcher.ts`, the twitter pattern) sends ANY URL containing
`/status/<digits>` — unless it names reddit/github/stackoverflow — to its Twitter fetcher, which
rejects real pages with `Invalid Twitter/X URL: "…"` (`TwitterFetcher.ts:41`). `executeReadUrl` now
detects that signature (`^Invalid Twitter/X URL` with a non-twitter.com/x.com host), classifies it
`misrouted`, and goes straight to the WebExtractService fallback — the page itself is fine (the
origin answers 200), so `bot_blocked` guidance ("do not retry, the site blocks bots") would be wrong.
A genuine twitter.com/x.com URL keeps the old handling.

**`get_music` (1/24 failed).** Cause NOT determinable from durable sources: all 24
`tool_exec:get_music` spans in telemetry-service are `status=OK`, `status_code=200`, with no
`events` carrying an error, and the failure's error text died with lazy-agent-service's ~1–1.5 h
docker-log retention (the `[ToolRetryInterceptor]` lines in the retained window name only
`get_market_data`). Not guessed further. What IS known: get_music is tools-service → MusicBrainz
(`MusicBrainzFetcher.ts` throws `MusicBrainz API error <status>` with no retry, and MusicBrainz
rate-limits ~1 req/s with 503s under load), so `executeGetMusic` now appends actionable guidance to
those failures (503/429 → transient upstream, wait and retry once; 4xx → check action/args; other →
retry later or another source). Non-MusicBrainz errors pass through unchanged.

**`get_finnhub_news` truncation (4/10 calls cut).** The trading bridge renders the articles as
`  Title: … | Publisher: … | Date: … | Key Facts: <≤400 chars>` lines
(`trading-service/app/tools/finance_tools.py` + `text_utils.format_db_section`), which blows the ~8k
per-result limit, and the generic cut kept whole leading lines — most articles never reached the
model. New `src/services/FinnhubNewsProjection.ts`: for `get_finnhub_news` results, `compactFinnhubNews`
(wired into both `executeTradingTool` and `McpAdapter`) replaces the text with a compact JSON
projection `{note, news: [{headline, source, datetime, summary, url?}]}` — every headline kept,
summaries ≤300 chars shrinking further only if the payload still exceeds the budget (never drop an
article). The key is `news` on purpose: prism caps a top-level array and any array under `articles`
at 10 items regardless of size, which would offload exactly these results. A normal 15-article
result (the bridge's own cap) fits whole at 300-char summaries.

Tests: `src/services/__tests__/ToolFixes20261016.test.ts` — misroute fallback (mastodon.social/status/403
through the real executeTool path against a local tools-api/scraper double, content via fallback),
x.com-not-misrouted guard, MusicBrainz 503 guidance, projection parse/30-articles-under-cap/15-whole.
Each fails on reverted source: reverted read_url classified the misroute `other` and returned the
bare error with no fallback; reverted get_music returned the bare status; reverted
get_finnhub_news cut the text and dropped headlines.

### Follow-up fixes (2026-10-27, `wt-scrape-guard`)

- **Expanded `UNSCRAPABLE_DOMAINS` (`src/services/UnscrapableDomains.ts`)**: Added `chartmill.com` and `thestreet.com` (measured 655+ and 252+ HTTP 403 blocks in `scraper-service` via Finnhub 302 redirects) alongside `seekingalpha.com`, `reuters.com`, and `streetinsider.com`.
- **Yahoo `/m/` Partner Teaser Blanking (`isPartnerTeaserUrl`, `blankUnscrapableLinks`, `FinnhubNewsProjection.ts`)**: Blanks `finance.yahoo.com/m/<uuid>` partner stub URLs in `lazy_web_search` and `get_finnhub_news` projections with a teaser note so agents use the headline/snippet instead of wasting `scrape_url` budget on 1-paragraph partner stubs.
- **Dedicated-Tool & Guessed-IR URL Guard (`scrapeTargetGuard`, `registerRunUrls`, `LocalToolRouter.ts`)**: Refuses `scrape_url` calls on `finviz.com` ($\to$ `get_finviz_fundamentals`), `finnhub.com` ($\to$ `get_finnhub_news`), and `sec.gov/edgar/search` ($\to$ `get_sec_filings`), and blocks guessed corporate IR paths (`/investors/earnings`, `/investor-relations/financials`, `/investor-centre/financial-results`, `/newsroom/press-releases`) unless the URL was returned by `lazy_web_search`, `web_search`, or `news_search` in the current run.
