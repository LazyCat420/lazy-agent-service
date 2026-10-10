---
part: Features
status: verified
updated: 2026-10-10
---

# Web Harness Hardening (2026-10-10)

Implements `docs/harness-research/REPORT_agentic_harness_2026-10-10.md` slices W1–W4.
Mode: Implement. Repo: `lazy-agent-service` (worktree `wt-web-harness` → `main`).

## Context

`WebSearchService.ts` (Exa keyless + SearXNG fallback, cache + coalescing + pacing) and
`WebExtractService.ts` (deterministic truncate-and-store) landed 2026-10-09. This change adds
the safety and resilience layers from the research report: SSRF/domain gates, a cheap-model
Q&A pass, role-alternation pre-flight, pair-safe compaction with memory flush, and
per-capability auxiliary model chains.

## Changes

### 1. Web extract safety gates — `WebExtractService.ts`
- `isBlockedHost(url)`: blocks non-HTTPS, `localhost`, `*.local`, single-label hosts, loopback
  and private/link-local ranges (127/8, 10/8, 172.16–31, 192.168/16, 169.254/16, ::1,
  fe80::/10, fc00::/7). `ALLOW_PRIVATE_URLS=1` overrides. Blocked fetches return a structured
  error result — never throw, never cached.
- `WEB_BLOCKED_DOMAINS` deny-list (host + subdomain suffix match), always enforced.
- `WEB_CACHE_EXEMPT_HOSTS` (exact / `*.` wildcard / domain-suffix): always fetched live,
  never cached (staging/tunnel/dev-server freshness).

### 2. Cheap-model Q&A pass — `webExtractAnswered`
`scrape_url` gains an optional `prompt`. When set, one cheap LLM call (SettingsService
`memory.extractionProvider`/`extractionModel`, the same resolution CompactionService uses)
answers the question from the truncated page content with an anti-injection pinned system
prompt (answer only from content, ≤125-char verbatim quotes, paraphrase otherwise). Provider
missing or LLM failure → graceful degrade to the deterministic extract. Only the deterministic
extract is cached; answers are not.

### 3. Role-alternation pre-flight — harness submission
`normalizeRoleAlternation(messages)` runs on every provider submission: merges consecutive
same-role non-tool messages, preserves assistant(toolCalls)→tool-results→assistant shape,
drops orphan tool results (warned), constrains system messages to position 0.

### 4. Pair-safe compaction + memory flush — `CompactionService.ts`
The compacted/dropped range is now pair-aware: an assistant message with tool calls and its
tool results are dropped together, never split. Persistent memory is flushed before
summarization; flush failure logs and continues (never blocks compaction).

### 5. Auxiliary fallback chains — `DynamicModelResolver.ts`
`resolveAuxModel("web" | "vision" | "compression")` resolves side-task models independently
of the main chat chain: env (`AUX_<CAP>_PROVIDER`/`AUX_<CAP>_MODEL`) → capability→role
tiering (web/compression→summarizer tier, vision→vision-pattern models) → existing
online-provider fallback. Chains are isolated: one capability failing does not affect the
others or main chat.

### Already satisfied (verified, no change)
- **Budget exhaustion**: `lifecycle/ExhaustionRecovery.ts` runs a tool-free recovery pass that
  emits `ITERATION_LIMIT_REACHED` and a progress summary — no exception (N8).
- **Parallel tool calls**: `ToolOrchestratorService.executeToolCalls` uses `Promise.all`;
  results restore original call order by index (N10). Note: `ChatRoutes.handleConversation`
  executes sequentially — that is the chat-route path, not the harness; left unchanged.

## Verification
- `WebExtractService.test.ts` — 33/33 (blocked hosts with zero network calls, allow override,
  deny-list + never-cached, exempt-host live fetch, truncation, handler dispatch).
- `DynamicModelResolver.aux.test.ts` — 10/10 (env priority, tier fall-through, chain
  independence, vision pattern match).
- `RoleAlternation.test.ts`, `CompactionPair.test.ts` — see worktree test run.

## Non-goals
Keyless free-tier ring, browser automation, xAI/OpenAI server-side tools, ChatRoutes
sequential loop, coordinator worktrees.

## Trading-profile enablement + live verification (2026-10-10, commits 284366b, d8d78e2)

- `web_search` (shared WebSearchService: Exa keyless → SearXNG fallback) enabled for all three trading
  analyst profiles; `global.web.search` capability rewired from Bing/Google News RSS to the shared
  backend (result shape unchanged, `source` carries the provider; signal-aware cancellation preserved).
- Resolver bug fixed: `trading.research.*` capability-id whitelist entries granted ZERO tools in the
  resolver — action grants now map a whitelist id's last segment to the catalog tool name
  (AgenticToolResolver). Verified via `resolve-check` for all three profiles.
- `trading-analyst-v1` whitelist had stale pre-rename `mcp__lazy-tool-service__*` prefixes → renamed.
- `tool_schemas/shared/web.json` `web_search` owner set to `trading` so it ships in the trading catalog.
- Run-path fix (d8d78e2): direct API runs (`/v1/runs` without a trading-client shim) supplied no
  `local_tool_schemas`, so profile-admitted tools were callable in name only
  (`LOCAL_TOOL_SCHEMA_MISSING`). RunExecutionEngine now admits catalog schemas from `tool_schemas.json`
  for enabled trading-project tools; the warning now lists only tools still missing.
- **Live test**: POST `/v1/runs` (project `vllm-trading-bot`, profile `trading-junior-analyst-v1`,
  model `GLM-5.3-Flash-EXL3-TF` on vllm-2): native tool call to `web_search` executed, status ok,
  10 results. Note: `nemotron35` (Jetson) emits tool calls as text and is not usable for this path.
- `web_search` vs `lazy_web_search` are NOT duplicates: web_search = general web index (Exa/SearXNG);
  lazy_web_search = news-recency (trading-service Bing/Google News RSS), contract-frozen into v3
  agents/evals. `web_search`/`search_web` already share one handler.
- ARIA audit: no accessibility-tree/ARIA-snapshot extraction anywhere. scraper-service's Playwright
  engine uses `innerText` heuristics (article/main/paragraphs); aria-label appears only for close-button
  selectors. WebExtractService consumes the resulting plain text. ARIA snapshots would be a new
  capability, not a change to existing extraction.
