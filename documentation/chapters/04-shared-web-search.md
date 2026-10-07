---
part: Runtime
status: shipped
updated: 2026-10-06
review-by: 2026-11-06
---

# Shared keyless web search

`POST /execute/web_search` searches the web through Exa's free keyless endpoint, with one cache and one rate limit for every service on the network. It replaces each project scraping DuckDuckGo on its own. Implemented in [src/services/WebSearchService.ts](src/services/WebSearchService.ts) and routed in `LocalToolRouter`, next to `news_search`.

## Why

Every machine in the house leaves through one public IP, 71.198.70.27; the NAS and the workstation both report it. The free search engines bot-block that IP:

- DuckDuckGo first refused the NAS on 2026-07-27.
- On 2026-10-06 a plain `curl` from the workstation got DuckDuckGo's "bots use DuckDuckGo too" challenge, and Startpage, Ecosia, Google and Mojeek failed in the same way.

A read-only audit on 2026-10-06 found 17 DuckDuckGo code paths across the workspace. The largest automated ones:

- html-notes' health check searched about 288 times a day; fixed on 2026-10-06 (html-notes `docs/WEB_SEARCH.md`).
- treesearch-service searches on every boot.
- trading-client's chat turns web search on for news-like messages.
- Rod's tools-service `search_web` is DuckDuckGo only.

Several used the `ddgs` library, which on a blocked IP tries about nine engines for every call.

## How it works

Exa answers from its own index through an API. It does not scrape anyone's result pages, so the bot checks that block this IP do not apply. The free tier answers HTTP 429 when called too fast, so this service is the one place that calls it:

- **Cache:** identical searches are answered from memory for 30 minutes, ignoring case and spacing. Identical searches already in flight share one call.
- **Pacing:** Exa calls go out one at a time, at least 1.5 s apart, for the whole network. A caller whose turn would come more than 20 s later gets `busy` instead of waiting.
- **Rate limits:** after a 429, or a JSON-RPC error that says "rate limit", nothing is sent for 60 s, and callers get `rate_limited` immediately.
- **No scraping fallback**, on purpose. News lookups have their own tool, `news_search`, which uses keyed news APIs.

Request and reply:

```bash
curl -s -X POST http://10.0.0.16:5591/execute/web_search \
  -H 'Content-Type: application/json' -d '{"query": "hiking sandals review", "limit": 5}'
```

```json
{ "query": "hiking sandals review", "status": "ok", "provider": "exa", "cached": false,
  "results": [{ "title": "…", "url": "https://…", "snippet": "…", "published": "2026-…", "author": "" }],
  "count": 5, "search": { "calls": 12, "cacheHits": 30, "rateLimited": 0, "cooldownSeconds": 0, "…": "…" } }
```

- `status` is `ok`, `error`, `rate_limited` or `busy`.
- An `ok` with no results means Exa found nothing. Every other status says why there are no results, and also sets `is_error: true` so tool telemetry counts it as a failure.
- `search` carries the shared counters, so a caller or a health check can see what the search has been doing.

`web_search` is deliberately absent from `tool_schemas.json`. Services call it; agents do not see it. A test asserts that. Agents reach the same search through the ordinary `search_web` tool on this harness, described below.

Settings, all optional environment variables:

| Variable | Default |
| --- | --- |
| `WEB_SEARCH_EXA_URL` | `https://mcp.exa.ai/mcp` |
| `WEB_SEARCH_MIN_INTERVAL_MS` | 1500 |
| `WEB_SEARCH_CACHE_TTL_MS` | 1800000 (30 min) |
| `WEB_SEARCH_COOLDOWN_MS` | 60000 |
| `WEB_SEARCH_TIMEOUT_MS` | 15000 |
| `WEB_SEARCH_MAX_WAIT_MS` | 20000 |

## How it was verified

- A direct call to Exa's keyless endpoint from the workstation returned HTTP 200 in 1.7 s, with dated results for the day.
- `src/services/__tests__/WebSearchService.test.ts` (15 tests) drives the service with a fake Exa and a fake clock. It covers:
  - parsing, the cache and shared in-flight calls;
  - 1.5 s pacing and `busy` past 20 s;
  - the 60 s cooldown after a 429 or a rate-limit error;
  - errors that are not cached, timeouts and empty queries;
  - that no request goes anywhere but `mcp.exa.ai`.
- `src/services/__tests__/WebSearchRoute.test.ts` checks the `/execute/web_search` reply shape and the `is_error` flag.
- `npm run typecheck` is clean, and the full vitest suite passes: 73 files, 964 tests.

## `search_web` on this harness

`search_web` is the web tool every agent knows. On this service's own harness it is no longer sent to Rod's tools-service: `ToolOrchestratorService.executeTool` answers it with `executeSharedWebSearch`, which calls the shared search above.

**Why.** tools-service's `search_web` searches DuckDuckGo alone. Brave is unfunded, and trading-client clears its key at startup. So every call both failed and added to the block. Measured from the request logs over the 30 days to 2026-10-07:

- tools-service received about 270 `/agentic/web/search` calls, at most 74 in a day (2026-09-10).
- Rows written by prism show 193 `search_web` calls:
  - trading's v3 agents made 156 (Board of Directors 83, Junior Analyst 37), none after 2026-09-25;
  - `CUSTOM_OBSIDIAN_GENERAL_ASSISTANT` made 37, up to 2026-09-29.
- Rows written by this harness show 44 more, all from `CUSTOM_OBSIDIAN_GENERAL_ASSISTANT` on `/agent`, from 2026-09-18 to 2026-10-02. These are the rows without `createdAt`, from before `d8a3c10`. Their daily counts on 2026-09-30, 10-01 and 10-02 (4, 5 and 6) match tools-service's counts for those days exactly. The last DuckDuckGo searches therefore came through this harness.

**Behaviour:**

- The tool keeps its name and arguments, so DEEP_RESEARCH, MUSIC_RESEARCH and every agent moved onto this harness need no change.
- The reply keeps tools-service's shape: `{query, limit, results: [{title, url, snippet, displayUrl, published?}], totalResults, provider, cached}`.
- `siteSearch` becomes a `site:` prefix, as it does in tools-service. `dateRestrict` has no equivalent and is ignored, but results carry `published` when Exa knows the date.
- A search that did not run (`rate_limited`, `busy` or `error`) returns an `error` that names the status. The model reads it as a failure, not as an empty web.
- The session's tool allowlist is still checked first.

**Verified:**

- `src/services/__tests__/SearchWebShared.test.ts` makes any `fetch` throw, so a call that leaked to tools-service would fail it. It covers the result shape, the `site:` prefix, a rate-limited search, an empty query and the allowlist.
- With the new branch removed, 3 of its 4 tests fail. The allowlist test passes either way, by design.
- `npm run typecheck` is clean, and the full suite passes: 75 files, 972 tests.

**Agents that still run on prism** call tools-service directly, and nothing here can intercept that. Each of their repos has to deny or replace `search_web`:

- trading-service adds it to its v3 DENY policies (`handoff/no-ddg-search` in trading-service).
- music-player calls prism's `/agent` and lists `search_web` in its own tool lists, so it replaces it there.

## Callers moved onto it

Each project was moved and deployed separately:

1. html-notes search engines: done 2026-10-06.
2. treesearch-service boot enrichment and strain imports: done 2026-10-06.
3. trading-client chat web search: done 2026-10-06.
4. lazycat-sdk `grounded_research`: done 2026-10-06.
5. bittle-agent research.
6. The LLMSortObsidian plugin.
