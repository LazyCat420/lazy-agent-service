---
part: Features
status: verified
updated: 2026-10-09
---

# 08 — Shared Web Extract & Search Fallback

**Date:** 2026-10-09. Companion to `04-shared-web-search.md` (Exa-only era).

## What changed

1. **`WebExtractService`** (`src/services/WebExtractService.ts`, new): `scrape_url` on this
   gateway no longer forwards to tools-service. It reads through scraper-service
   (`POST /scrape`, `engine: "auto"` — http first, Chromium for JS-heavy pages) at
   `SCRAPER_SERVICE_URL` (default `http://localhost:8001`, same convention as
   treesearch's `scraper_client`), under a deterministic character budget — no LLM
   summarization:
   - ≤ `WEB_EXTRACT_CHAR_LIMIT` (default 15 000, clamp 2 000–500 000, per-call
     `char_limit`): whole text.
   - over: head+tail window (75 %/25 %, cut on line boundaries) + `[TRUNCATED]`
     footer naming the file holding the FULL clean text
     (`$WEB_EXTRACT_STORE_DIR` or `/tmp/lazy-agent-web-extract/`), so the agent
     pages the omitted middle with `read_file`. Stored text capped at 2 MB.
   - Cache: URL + bucketed char limit (2 k/5 k/15 k/50 k/500 k), 20 min TTL,
     in-flight coalescing; only successes cached; 120 s timeout.
2. **Search fallback** (`WebSearchService`): a failed Exa call (`error`,
   `rate_limited`) now falls back to scraper-service's self-hosted SearXNG
   collector (`POST /collect`, `source: "searxng"`), which answers from the LAN and
   does not share Exa's rate limits. `busy` (local queue full) does NOT trigger the
   fallback — a burst must not pile onto it. Exa stays the primary and the only
   engine for successful searches.
3. **Compact search rows**: `search_web` snippets are capped at 240 chars in the
   orchestrator reply (omp's `formatForLLM` cap), so ten results cost a fraction of
   the context one long snippet would.
4. **Tool guidance**: `scrape_url`'s schema description now teaches the
   search → extract loop ("use AFTER search_web, pick 2–3 promising URLs, read the
   stored file when truncated, prefer narrower queries over scraping many pages").
   `DeepResearchPersona` gains `scrape_url` in its tool set and matching identity
   text. `search_web`'s description still lives in tools-service (not editable here).

## Config

| Env | Default | Meaning |
| --- | --- | --- |
| `SCRAPER_SERVICE_URL` | `http://localhost:8001` | scraper-service base URL |
| `SCRAPER_API_KEY` | unset | sent as `x-scraper-key` when scraper-service arms auth |
| `WEB_EXTRACT_CHAR_LIMIT` | `15000` | default page budget |
| `WEB_EXTRACT_CACHE_TTL_MS` | `1200000` | extract cache TTL |
| `WEB_EXTRACT_TIMEOUT_MS` | `120000` | per-scrape wall clock |
| `WEB_EXTRACT_STORE_DIR` | `/tmp/lazy-agent-web-extract` | full-text store |
| `WEB_SEARCH_SEARXNG_TIMEOUT_MS` | `20000` | fallback collector timeout |

## Verification

- `src/services/__tests__/WebExtractService.test.ts` (new) + repinned
  `WebSearchService.test.ts`: 33 tests cover scrape routing, truncate-and-store,
  cache/coalescing, fallback + busy-skip, and the old "never contacts a scraping
  engine" pin replaced by the fallback contract. Full `src/services/__tests__`
  suite: 592 passed. `tsc --noEmit` clean.
- Live-path smoke (stub scraper on 127.0.0.1): long page → `truncated: true`,
  middle cut, tail kept, stored path + read hint returned, cache hit on repeat.
