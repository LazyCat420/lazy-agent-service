---
part: Runtime & Pipeline
type: spec
status: verified
updated: 2026-11-13
last-verified: 2026-11-13
review-by: 2026-12-13
covers: lazy-agent-service:scripts/export_tool_schemas.py, lazy-agent-service:tool_schemas.json, lazy-agent-service:src/services/AgenticToolResolver.ts, lazy-agent-service:src/services/ToolOrchestratorService.ts, lazy-agent-service:src/services/LocalToolRouter.ts, lazy-agent-service:src/services/WebSearchService.ts, lazy-agent-service:src/services/WebExtractService.ts, scraper-service:searxng/settings.yml, tts-service:app/synth/presets.py
---

# Tools and the schema registry

The catalog is **78 tools** in `tool_schemas.json`, generated from canonical split shards
under `tool_schemas/<owner_app>/*.json` by **one generator** (ch.10 ADR-02). Dispatch is
three-way: `ToolOrchestratorService` decides local vs MCP vs bridge; `LocalToolRouter` answers
the local families in-process; everything trading goes over the trading tool bridge with the
signed tool context.

## The shard layout (78 tools)

| Owner app | Shard files | Tools |
|---|---|---|
| `trading/` (40) | `general.json` 17, `market-data.json` 7, `research-scheduling.json` 5, `trading-execution.json` 4, `watch_desk.json` 3, `parameter-governance.json` 2, `tool-chains.json` 1, `research-intelligence.json` 1 | market data, screener, SEC/institutional data, Finnhub news, whiteboard read/write/find/annotate, chat orders (`buy_stock`/`sell_stock` accept `quantity` **or** `amount_usd`), parameter governance, research scheduling |
| `html-notes/` (26) | `html-notes.json` 21, `general.json` 5 | note CRUD, canvas ×3, widgets ×5, health |
| `shared/` (4) | `web.json` 2, `news.json` 1, `quality.json` 1 | `web_search`, `scrape_url`, `news_search`, quality sensors |
| `treesearch/` (8) | `cannabis-research.json` 8 | strain research family (`strain_*`) |

Built-ins offered by the loop on top of the catalog: `think`, `execute_python`,
`emit_structured_output`, `ask_user`, `get_music`, `read_url`, `read_web_page`,
`search_news`.

### Trading tool-resolution isolation (`T3`, `f10b64d`)

`AgenticToolResolver.ts` (`isTradingToolResolutionContext`) detects trading callers whenever
`project === "vllm-trading-bot"`, `ToolOrchestratorService.isTradingRequest(project)` is true,
`tradingToolContext` / `_lazy_trading_context` is attached, `<TRADING_TOOL_CONTEXT_V1>` appears in
`systemPrompt`, conversation `ToolContext` is present, or a trading persona (`v3_*`, `board`,
`research_worker`) is active. In trading contexts, `shouldLockCoreTools` is forced `false` and
`CORE_AGENTIC_TOOLS` (including `search_web`), `CORE_ORCHESTRATOR_TOOLS`, and `system` tools are
stripped whenever no explicit caller whitelist requested them — preserving only
`ALWAYS_AVAILABLE_COGNITIVE_TOOLS` (`execute_python`, `emit_structured_output`, `think`). Pinned in
`src/services/__tests__/TradingToolResolverIsolation.test.ts`.

## The single generator

`tool_schemas/<owner_app>/*.json` is the **source of truth**; only
`scripts/export_tool_schemas.py` turns shards into the flat file:

```bash
python3 scripts/export_tool_schemas.py               # this repo's tool_schemas.json
python3 scripts/export_tool_schemas.py --check       # exit 1 if stale (gate, ch.09)
python3 scripts/export_tool_schemas.py --out PATH    # write another repo's copy
python3 scripts/export_tool_schemas.py --supports-out # version probe, exit 0 on this version
```

Unknown arguments are an error (the old exporter silently ignored them and proved nothing).
trading-service's deploy PRE_BUILD greps for `--supports-out` before running it. Every copy
(trading-service, trading-client, here) is byte-identical because one script writes them;
`owner_app` is stamped, shards sorted. Trading-service's
`tests/unit/test_schema_build_publication.py` pins atomic publish and retired-tool removal;
`ToolSchemaExport.test.ts` checks this repo's copy against the shards.

**Editing a schema:** edit the shard → run the exporter → commit both; regenerate the
trading copies with `--out` (their deploys also do it) and commit there. Recent examples:
`383a68e` (offer `whiteboard_find`, facts on `whiteboard_write`, padded covariance tickers),
`9d51b9c` + `e86316e` (`screener_query` filter description: text-valued fields, `eq`/`contains`).

## Hallucinated aliases

Models occasionally emit retired tool names. `ToolRunner.ts` maps them before lookup via
`HALLUCINATED_TOOL_ALIASES` + `resolveToolName()` (`query_market_screener → screener_query`,
`get_sec_filings → get_institutional_holdings`, `query_sec_filing → get_earnings_data`), so
one model habit never becomes a tool-not-found failure. Pinned in
`src/core/loop/__tests__/ToolRunner.test.ts`.

## Web search and extract

**`web_search`** (`POST /execute/web_search`, `WebSearchService.ts`): one shared, keyless
Exa endpoint for the whole house (the one public IP is bot-blocked everywhere else). Cache:
identical queries answered for 30 min (case/spacing-insensitive), in-flight identical queries
share one call. Pacing: one Exa call at a time, ≥1.5 s apart, network-wide; a caller waiting
>20 s gets `busy`. After any 429/rate-limit signal: 60 s cooldown, callers get
`rate_limited` immediately. **Fallback: scraper-service's SearXNG collector.** When Exa fails
or answers `ok` with no results (its keyless index misses fresh news), the same query goes to
`POST $SCRAPER_SERVICE_URL/collect` with `source: "searxng"` (timeout
`WEB_SEARCH_SEARXNG_TIMEOUT_MS`, default 20 s); a `busy` answer never falls back, so a burst
cannot pile onto SearXNG too. Only answers with results are cached. News still has
`news_search` (keyed APIs).

**`scrape_url` / extract** (`WebExtractService.ts`, `scrapeTargetGuard` in
`LocalToolRouter.ts`): refuses scraping sites with a dedicated tool (`finviz.com` →
`get_finviz_fundamentals`, `finnhub.com` → `get_finnhub_news`, `sec.gov/edgar/search` →
`get_sec_filings`) and blocks guessed corporate-IR paths (`/investors/earnings`,
`/newsroom/press-releases`, …) unless the URL came from a search in the current run
(`registerRunUrls`). Bare/malformed URLs are normalized or refused with a search-first hint;
known-dead URLs (404s recorded per run) are refused without spending the run's scrape budget;
thin content counts as success (ch.03 guard table).

## Repeat guards, read-only classification, and result bounding

Six idempotent desk tools are repeat-guarded per run (`REPEAT_GUARDED_TOOLS`, `1003bb2`):
identical args return the cached first result (`screener_query` result reuse in-run is
`ebdda0d`). Separately, `LocalToolRouter.ts` `READ_ONLY_TOOLS` classifies both
`"whiteboard_find"` and `"read_ledger_entry"` (`T2`, `f10b64d`,
`ReadLedgerAndShimLiveModel.test.ts`) as idempotent read-only queries so cycle-ledger lookups can
be retried safely on transient 5xx responses rather than treated as non-idempotent writes.
Oversized tool results are cut to the per-result limit (`SpillBuffer` /
`ToolOutputSubstituter`), the truncation is recorded, and cross-ticker contamination is
blocked at the bridge (`Cross-contamination blocked: MSFT != AAPL`).

## Tools served by the sibling services

No tool schema lives in the sibling repos; the catalog stays the single generator's output.
Two catalog tools are thin clients of scraper-service, and its collectors are the backend
other repos call directly.

| Tool (this catalog) | Sibling call | What the tool sees |
|---|---|---|
| `web_search` (fallback path) | scraper-service `POST /collect {source: "searxng"}` | `provider: "searxng"` results; SearXNG queries only `bing` and `wikipedia` (DuckDuckGo, Google and the rest bot-block the house IP) |
| `scrape_url` / web extract | scraper-service `POST /scrape {url, engine: "auto"}` | `content`, `engineUsed` (`auto (http)`, `auto (http-teaser)`, Playwright, `auto (skipped)`), `contentQuality: "thin"` when the scraper says so |

scraper-service's own collectors (`POST /collect`), for callers that use it directly
(trading-service): `reddit`, `reddit-purge`, `youtube`, `news`/`rss` (per-feed health in
`/health/feeds`), `searxng`, `edgar` (needs `SEC_USER_AGENT`), `stooq`, plus finnews,
stocktwits, twitter, kannapedia and leafly collector modules in
`app/scraper/collectors/`.

**Voices as a capability.** tts-service is not a catalog tool; clients call
`POST /api/v1/tts/synthesize` directly. Piper voices are the `.onnx` models on the NAS volume
(`GET /api/v1/tts/voices` lists them with accent aliases); the synth engine's eight voice types
(`GET /api/v1/tts/synth-voices`) are numeric presets in `app/synth/presets.py`, so adding one is
a code change, not a download.
