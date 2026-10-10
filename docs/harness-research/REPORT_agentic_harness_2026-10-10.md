# Agentic Harness Research Report — Hermes Agent, Claude Code, Web Search (2026-10-10)

**Mode:** Understand / Plan (read-only research; no code changed).
**Sources:** hermes-agent.nousresearch.com/docs, NousResearch/hermes-agent repo (agent-loop.md, web-search docs), code.claude.com/docs, Mikhail Shilkov's Claude Code web-tools teardown (2025-10-06), prior local audits (`PRISM_HARNESS_AUDIT_2026-10-08.md`, `PLAN_hermes.md`, `PLAN_claude_code.md`, `PLAN_oh_my_pi.md`).
**Claim labels:** CONFIRMED (source doc read directly) / LIKELY / UNVERIFIED.

---

## 1. Hermes Agent (Nous Research) — harness internals

### 1.1 Agent loop (`AIAgent` in `run_agent.py`) — CONFIRMED
- Single core class: prompt assembly (`prompt_builder.py`), provider/API-mode selection, interruptible calls, tool dispatch, compression, retries, fallback.
- **Three API modes** (`chat_completions`, `codex_responses`, `anthropic_messages`) all normalize to one internal OpenAI-style message format; mode resolved explicitly → provider → base-URL heuristic.
- **Strict role alternation** enforced: never two assistant or two user messages back-to-back; only `tool` role may repeat (parallel results). Providers reject malformed histories.
- **Interruptible API calls**: HTTP call runs in a background thread; an interrupt event abandons the response — partial responses are never injected into history.
- **Parallel tool calls** via `ThreadPoolExecutor`; results reinserted in *original call order* regardless of completion order. Interactive tools (e.g. `clarify`) force sequential.
- **Agent-level tool interception**: `todo`, `memory`, `session_search`, `delegate_task` are handled *before* the registry because they mutate agent state directly — synthetic tool results, no external call.
- **Iteration budget**: default 500/agent; subagents capped at 50 via `delegation.max_iterations`; at 100% the agent returns a summary of work done (graceful stop, not a crash).
- **Fallback model**: on 429/5xx/401 walk `fallback_providers`; auxiliary tasks (vision, compression, web extraction) have *independent* fallback chains (`auxiliary.*` config).

### 1.2 Compression & memory — CONFIRMED
- Preflight compression at >50% context; gateway auto-compress at 85%.
- Order matters: **memory flushes to disk BEFORE compression** (no data loss), middle turns summarized, last N=20 messages kept verbatim, tool call/result pairs never split, new session lineage id issued.
- Sessions persisted each turn (SQLite) → `/resume`; memory in `MEMORY.md` / `USER.md`.
- 8 callback surfaces (`tool_progress`, `thinking`, `reasoning`, `clarify`, `step`, `stream_delta`, `tool_gen`, `status`) drive CLI/gateway/ACP UIs — the harness is observability-first.

### 1.3 Web search & extract (`web_search`, `web_extract`) — CONFIRMED
- **Multi-provider backend table**: Firecrawl (default), SearXNG (free self-hosted), Brave, DDGS (no key), Exa, Parallel, Tavily, Perplexity, Keenable, xAI, OpenAI Codex. **Search and extract providers are chosen independently** (e.g. SearXNG search + Firecrawl extract).
- **Keyless free-tier ring**: fresh install with zero keys rotates round-robin across Exa/Parallel/Firecrawl/Keenable public tiers; rate-limit or 4xx/5xx retries on next vendor (multi-hop). Any present API key always wins; `web.keyless_fallback: false` disables.
- **Deterministic extraction budget, no LLM summarization**: ≤15,000 chars returned whole; larger → head+tail (75/25, cut on markdown line boundaries) + `[TRUNCATED]` footer that names the on-disk file and the exact `read_file` call to page the middle. 2 MB disk cap. Per-call `char_limit` override. 120s wall-clock timeout per provider.
- **Caching with fan-out coalescing**: search memoized in-process; extracts cached to `~/.hermes/cache/web/` shared across CLI/gateway/subagents; concurrent identical searches coalesce to one backend request (first caller pays); limit values bucketed to 10/20/50/100 so near-duplicates share cache. Only successful responses cached. **localhost/private IPs never cached** (stale dev-server prevention) + `cache_exempt_hosts` for tunnels.
- **JS-heavy pages**: `browser_navigate` + `browser_snapshot` (accessibility tree) instead of extraction.

### 1.4 What Hermes does that our prior PLAN_hermes.md did NOT cover
| # | Mechanism | Prior plan gap |
|---|---|---|
| H1 | Multi-provider web layer with keyless fallback ring + per-capability split | Prior plan had no web tools at all |
| H2 | Head+tail truncation with *spill-to-file + paging pointer* (deterministic, no LLM) | Prior plan: prompt discipline only |
| H3 | Subagent fan-out search coalescing + shared disk cache | Absent |
| H4 | Independent fallback chains per auxiliary capability (vision/compress/web) | Absent |
| H5 | Memory-flush-before-compression ordering + never-split tool pairs | Absent |
| H6 | Graceful budget-exhaustion summary (not error) | Absent |

---

## 2. Claude Code harness — what it does (and how it searches)

### 2.1 Core loop — CONFIRMED (docs + source analyses)
- Single main agentic loop; tool schemas + system prompt re-sent each turn; loop runs until the model stops issuing tool calls or budget is hit.
- **Hooks** (`PreToolUse` etc.) can block/deny tool calls before execution — the best safety seam; permission modes (default/acceptEdits/plan/bypass) with floors that never auto-approve destructive ops.
- Markdown subagents (own context, allowlist, permission mode), lazy-loaded SKILL.md skills, layered CLAUDE.md memory. (Details in PLAN_claude_code.md, still valid.)

### 2.2 WebFetch — CONFIRMED (Shilkov teardown)
- Schema: `{url, prompt}` — **prompt is REQUIRED; the tool never returns raw page content**, only a fast-model (Haiku) answer to the question.
- Pipeline: URL normalize (≤2k chars, https upgrade, strip credentials) → **server-side domain deny-list check** (`claude.ai/api/web/domain_info`) → fetch (same-host redirects auto; cross-host returns redirect metadata so the agent must re-consent) → 10 MB fetch cap, 15-min cache → HTML→Markdown (Turndown) → truncate 100 KB → Haiku pass with anti-injection pinned prompt (quotes ≤125 chars, paraphrase everything else).
- **Why**: cost/context control (page never reaches the main model), injection resistance (must trick two models through paraphrase), copyright hygiene.

### 2.3 WebSearch — CONFIRMED
- Server-side Anthropic search tool; schema `{query, allowed_domains?, blocked_domains?}`.
- Results parsed to **title + url only** — `page_age` and `encrypted_content` are discarded. Content is *never* pulled into search results; the agent must issue an explicit `WebFetch`. Search results stay tiny; fetching is an explicit, auditable decision.

### 2.4 Key design lessons for our web stack
1. **Search returns links, not content.** The agent decides what to fetch; every fetch is a separate observable step.
2. **Fetch answers a question; it does not dump the page.** A cheap model pre-filters between raw HTML and the main context.
3. **Domain gating before fetch**; cross-host redirects re-consented.
4. Quote-length limits + paraphrase in the summarizer prompt (injection + IP hygiene).

---

## 3. Gap audit: lazy-agent-service vs. both harnesses

Current state (from 2026-10-08 audit + repo tree): `AgenticLoopService.ts`, `ToolOrchestratorService`, 4-layer context assembly with budget receipts, LifecycleMemory provenance, contract-versioned run/profile JSON (v1.2), replay manifests. Existing plans cover Hermes prompt discipline, CC hooks/permission modes/subagents/skills, prism offloading/approvals/ModelProfiles/mailbox/goals/hooks.

**Audit of the NEW findings (not already in any local plan):**

| # | Capability (source) | Our status | Verdict | Evidence |
|---|---|---|---|---|
| N1 | Web tool pair (search=links, fetch=question+cheap-model answer) | No model-callable web tools in `tool_schemas/` (trading, html-notes, treesearch, shared only) | **MISSING — highest ROI** | `tool_schemas/` listing, CONFIRMED |
| N2 | Multi-provider web backends + keyless fallback ring | N/A | Build SearXNG/DDGS (free) first; ring optional | CONFIRMED doc |
| N3 | Deterministic head+tail page truncation w/ spill-to-file + `read_file` paging | `compactToolResultsForPressure` caps at 50k chars, hard cut (per prism audit) | Partial overlap with prism item #1 — **unify**: one truncation policy for tool results AND pages | CONFIRMED |
| N4 | Web result caching + subagent fan-out coalescing + never-cache-localhost | Absent | Needed the moment N1 ships and any subagent profiles exist | CONFIRMED |
| N5 | Domain deny-list + cross-host redirect re-consent | Absent | Fold into N1 `web_fetch` tool | CONFIRMED |
| N6 | Aux-task independent fallback chains (vision/compress/web models) | Single provider chain | Cheap, config-level; aligns with PLAN_dynamic_model_resolution | CONFIRMED (Hermes doc) |
| N7 | Memory-flush-before-compression + never split tool pairs during compression | Compression exists? — compression lives in context assembly; ordering guarantee UNVERIFIED in our code | Verify before claiming gap | UNVERIFIED |
| N8 | Budget-exhaustion graceful summary | Loop end behavior UNVERIFIED | Verify; likely small fix | UNVERIFIED |
| N9 | Strict role-alternation validation before provider submit | UNVERIFIED in AgenticLoopService | Cheap pre-flight validator; Hermes proved providers reject malformed histories | CONFIRMED risk, UNVERIFIED locally |
| N10 | Parallel tool-call execution with order-restored results | UNVERIFIED (orchestrator may be sequential) | Verify; matters for trading fan-out | UNVERIFIED |

**Cross-check against 2026-10-08 prism plan:** N3 unifies with prism item #1 (offload store). N1/N2/N3 should land as ONE web-capability slice ahead of prism item #1 or as part of it, not as competing truncation schemes. Keep and don't regress our differentiators (budget receipts, LifecycleMemory, contracts) — neither Hermes nor Claude Code publishes anything equivalent.

---

## 4. Plan (ordered, each slice independently landable in its own `wt-` worktree)

**W1 — `web_search` + `web_fetch` tools (new slice, before prism item #1)**
- `src/tool_schemas/shared/web.json` + handlers:
  - `web_search(query, allowed_domains?, blocked_domains?) → [{title, url}]` only. Backends: SearXNG (self-host docker, free) then DDGS fallback; provider key → paid path later (Hermes pattern H1).
  - `web_fetch(url, prompt)` → fetch → HTML→markdown → domain gate → **cheap-model Q&A pass** (CC pattern 2.4) → answer only. No raw page ever into main context. Long-page: head+tail cut on line boundaries + spill file + paging pointer (Hermes H2) — share ONE truncation util with `compactToolResultsForPressure`.
- Acceptance: replayed trading/news turn where the model must fetch two URLs; identity fields survive via spill file; localhost URLs bypass cache; blocked domain returns structured denial.
- Non-goals: browser automation, keyless ring (config-level later), scraping beyond reader extraction.

**W2 — Web result cache + coalescing (lands with W1 or immediately after)**
- In-process memo for search; disk cache for fetches keyed by normalized URL, TTL 20 min; concurrent identical fetches coalesced; never cache localhost/`127.0.0.1`/private ranges; `cache_exempt_hosts` config.
- Acceptance: two concurrent identical `web_fetch` calls → one upstream request; second `web_fetch` of a hot-reload dev server reflects a change (no cache).

**W3 — Pre-flight alternation + role-shape validator (small, independent)**
- Validate message history shape before every provider submit (Hermes rule §1.1); on violation, repair by merging, not erroring. Also verify N7/N8/N10 during this slice and file findings.
- Acceptance: unit test with doubled assistant messages repaired; audit note for N7/N8/N10 updated with CONFIRMED/UNVERIFIED resolution.

**W4 — Aux fallback chains + graceful budget summary (config + loop polish)**
- `auxiliary.web/compress/vision` fallback provider lists; budget-exhaustion path returns a work-done summary observation instead of an error.
- Acceptance: primary web backend down → automatic secondary used, logged; loop hitting `maxTurns` returns summary not exception.

**Deferred / already planned elsewhere:** CC hooks & permission modes (PLAN_claude_code.md), prism offloading & approvals & ModelProfiles & mailbox (PRISM_HARNESS_AUDIT plan items 1–6), Hermes XML prompted-tool adapter (PLAN_hermes.md). W1's truncation util must be the shared primitive prism item #1 adopts — do not build both.

**Non-goals:** keyless free-tier ring, xAI/OpenAI server-side tools, coordinator worktrees, benchmark CI, ACP.

**Verification (per workspace rules):** each slice via `testrun`; vitest for handlers; replay against stored trading turn payloads; docs chapter + `documentation/build_docs.py` before deploy; `deploy.sh` (image `lazy-tool-service`), verify `/health` + one live `/agent` run.

**Zero unverifiable claims check:** N1–N6, H1–H5, CC sections — CONFIRMED with cited sources. N7–N10 marked UNVERIFIED and are scheduled for verification in W3, not assumed. ASSUMPTION-1: a self-hosted SearXNG instance is acceptable to run in our NAS stack (validation path: W1 setup; fallback DDGS needs no infra).
