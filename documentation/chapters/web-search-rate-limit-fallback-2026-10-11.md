---
part: Tools and shared services
status: shipped
updated: 2026-10-26
type: record
---

# Web Search: Exa's Rate Limit Is Not an Empty Answer (2026-10-11)

**Commit `66fab33`.**

> **Docs audit 2026-10-26: still shipped.** `66fab33` is an ancestor of
> `origin/main` (`a0ac42b`) and nothing since 2026-10-11 reverts it. `review-by` removed.

## Symptom

In html-notes, news and general questions (tested with nemotron35) came back
with no summary at all. `/execute/web_search` returned 0 results.

## Root cause

1. Exa's keyless MCP reports its free-tier rate limit as **HTTP 200** with
   `_meta["ai.exa/rateLimited"]: true` and the text "You've hit Exa's free MCP
   rate limit". `WebSearchService.callExa` read that as a successful search
   with 0 results.
2. That empty "success" skipped the SearXNG fallback and was **cached for 30
   minutes**, so the same question stayed empty.
3. The fallback could not have worked anyway. `SCRAPER_SERVICE_URL` defaulted
   to localhost inside the container (ECONNREFUSED).

## Fix (`src/services/WebSearchService.ts`, `docker-compose.yml`)

- `_meta["ai.exa/rateLimited"]`, or no results plus "rate limit" in the text,
  starts the Exa cooldown and marks the call `rateLimited`.
- Any Exa reply without results falls back to SearXNG through
  scraper-service `/collect`.
- Only an ok reply with at least 1 result is cached.
- `SCRAPER_SERVICE_URL` defaults to `http://10.0.0.16:8001`.

Tests: 2 new cases in `src/services/__tests__/WebSearchService.test.ts`. The
full suite has 1394 passing.

## Related

The other half of the "summarises only one link" problem was in html-notes:
a double model filter, plus Google News links the scraper can't read. See
html-notes chapter `music-swap-live-news-and-news-summaries`.
