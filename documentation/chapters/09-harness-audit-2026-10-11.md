---
part: Agent loop and harness
status: in-progress
updated: 2026-10-26
review-by: 2026-11-09
type: plan
---

# Harness Audit + Handoff Plan (2026-10-11)

> **Docs audit 2026-10-26: in progress. Phase C is partly done; Phase D has barely started.**
> Each item below was checked against `origin/main` (`a0ac42b`) and the consumer repos, not
> against this plan's own claims:
>
> | Item | State | Evidence |
> |---|---|---|
> | 12 music-player | partly | `llm.py` now points at `:5591` (`apps/api/app/services/llm.py:184-186`, music-player `c89c6da`). Still missing: `MUSIC_RUNTIME_ENABLED` defaults to `"false"` (`apps/api/app/agent/harness.py:472`), there is no `tool_schemas/music-player/`, and there is no `MUSIC_PLAYER_URL`; the URL is still hard-coded at `src/services/LocalToolRouter.ts:330` |
> | 13 trading-service off prism | **done** | trading-service `dc46829c` (2026-10-16) removed `PRISM_ENABLED`/`PRISM_URL`/prism-proxy. One leftover mention: `app/audit/boundary_probe.py` |
> | 14 html-notes | partly, not re-verified | html-notes `915a8aa`; health/MCP/STT, `.venv/` and `ddgs` not re-checked in this pass |
> | 15 lazycat-sdk | partly | `LLMClient` defaults to the harness (`lazycat/config.py:13`, `:5591`); `EmbedClient` does not exist (0 hits) |
> | 16 Obsidian `lazy_web_search` | not started | 0 hits for `/execute/web_search` in `LLMSortObsidian-Plugin/src`; the hub still routes it to trading (`LocalToolRouter.ts:485`) |
> | 17 office-client + portal | not verified | no prism hits in office-client `src` (proves nothing on its own); portal-service is Rod's repo |
> | 18 tools-service DDG | **outside our ownership** | `duckduckgo` is still in `src/services/AgenticWebService.ts`, but tools-service is Rod's repo (workspace AGENTS.md). An item for him, not for this plan's developer |
> | 19 Tier 0 golden-trace eval | not started | 0 hits for golden-trace; only a building block exists (`prefixHash`, `src/platform/context/ContextAssembly.ts:198`) |
> | 20 frozen per-repo suites | not started | `ConfidenceInterval`/`BenchmarkService` predate the plan; the Harness² eval (`1c61156`) is a different benchmark |
> | 21 BFCL / τ²-bench | not started | 0 hits for `bfcl`, `tau2` or `evalscope` |
> | 22 Terminal-Bench | not started | conditional ("only if we host coding agents") |
> | 23 §5 features | partly | #7, the MCP client, is back (`3ddeeba` 2026-10-16, stdio allowlist `d1deebd`); 0 hits for `todo_write`, `search_conversations` or `/fork`. #6, #9 and #10 not checked |
>
> No remaining item needs a prism-service edit.

> **Progress (2026-10-11, same day):** Phase A (items 1–6) and Phase B (items 7–11) are
> fixed and landed — see the chapter "Harness Audit Fixes + Security Bench". Phases C and D
> (consumer cutover, evals) are still open.

Mode: Assess → Plan. Nothing in `src/` was changed. This chapter audits every harness commit
from 2026-10-06 to 2026-10-10 (`main` @ `8bc1f20`), checks each consumer repo's wiring, compares
the harness with outside agent harnesses, and leaves an ordered plan for the next developer.

Claim labels: **CONFIRMED** = reproduced live or read in code at a cited line; **REPORTED** =
found by a review pass, cited, not independently re-run; **ASSUMPTION** = needs a check first.

## 1. Measured baseline

| Check | Result | Label |
|---|---|---|
| `tsc --noEmit` (worktree at `8bc1f20`) | clean | CONFIRMED |
| `vitest run` (testrun, 4 workers) | **115 files / 1336 tests pass**, 16 s | CONFIRMED |
| `scripts/benchmarks/harness-bench.mts 50` | truncateAndStore 0.015 ms ± 0.003; normalizeRoleAlternation 0.003 ms; microcompact(20 turns) 0.267 ms ± 0.057 | CONFIRMED |
| NAS `GET :5591/health`, `:8001/health` | 200 / scraper build `0653afc1` | CONFIRMED |
| `POST /execute/web_search` "NVIDIA earnings date" | `provider: exa`, 1.4 s; repeat → `cached: true` | CONFIRMED |
| `web_search` with `allowed_domains:["docs.python.org"]` | only docs.python.org results | CONFIRMED |
| `POST /execute/scrape_url` to `127.0.0.1`, `169.254.169.254`, `0x7f000001`, `[::ffff:127.0.0.1]` | all refused (loopback/link-local) | CONFIRMED |
| `POST /execute/scrape_url` with `prompt` | **prompt ignored; raw page cut at 8000 chars** (see D5) | CONFIRMED |

Green tests do not cover the defects below: most of them sit on wiring paths that no test
exercises (dead registries, the `/execute` route, the live tail, real-abort behaviour).

`harness-bench` is a micro-benchmark of pure functions only. There is **no agent-quality eval**
(task success, tool-call accuracy, regression gate) — see §5.

## 2. Commit-by-commit verdicts

| Commit(s) | Claim | Verdict |
|---|---|---|
| f152755, 245bc29 | shared Exa search, cache + pacing; `search_web` answered by it | VERIFIED (live) |
| bc1049a | shared extract via scraper-service, truncate-and-store, SearXNG fallback | PARTIAL — stored files never deleted; cache key ignores exact char limit |
| a22ac8c | SSRF/domain gates on scrape_url | PARTIAL — string-host check only (D6) |
| a22ac8c | role-alternation pre-flight | PARTIAL — orphan check ignores `tool_call_id` (D10) |
| a22ac8c | pair-safe compaction + memory flush | VERIFIED; flush has no timeout |
| a22ac8c | aux model chains web/vision/compression | PARTIAL — only `web` has a caller |
| bca2fd9 | unattended approvals | PARTIAL — inline deny works; `UnattendedPolicy.ts`/`ApprovalRegistry.ts` only imported by tests |
| bca2fd9 | model profiles | VERIFIED |
| bca2fd9 | turn mailbox + non-blocking questions | **DEAD** — drained, never posted to |
| bca2fd9 | goal gate | **DEAD** — no code creates goals; per-run `GoalStore` queue |
| 2660324 | offload + `retrieve_offloaded_content` | **BROKEN** (D2) |
| 3e65c57 | re-run failed durable jobs | VERIFIED; also re-runs user-cancelled (499) jobs |
| d2c5152 | OpenTelemetry | UNTESTED beyond smoke; hard-coded exporter host, no shutdown flush |
| 1118c09 | code interpreter | **BROKEN — security** (D3) |
| e23d775 | parallel chat tools | PARTIAL — order preserved, but writes run concurrently, unbounded |
| e23d775 | run resume | UNTESTED — `getMessages` drops toolCalls → orphan tool rows |
| e23d775 | live tail | **BROKEN** (D4) |
| e23d775 | domain filters | PARTIAL — filter after fetch; allow-list over ≤10 results often empty "ok"; test asserts schema text only |
| 284366b | web_search for trading profiles; capability-id grants | PARTIAL — trading path bypasses new handlers (D5); last-segment grant can match any server's same-named tool, untested |
| d8d78e2 | `LOCAL_TOOL_SCHEMA_MISSING` catalog fallback | **BROKEN** (D1) |
| b772cac, 140626c | batch `/embed`, `/v1/embeddings` | VERIFIED |
| 88f77b8 | first-party `/chat` UI | VERIFIED |
| e1bc1b6 | /chat survives client disconnect | PARTIAL (D9) |

Line-level review covered the web stack, loop, tool resolution, runs, chat and embeddings;
receipts/embedding-migration commits (26a47c7…f583999, 18a031f, 13698be, 1ae5dfe, 6098253,
dfa1c84, f4d6e86, a3293ec, 4dfc571, 9040a9d) were checked at file level only.

## 3. Defects (ranked)

**D1 High — catalog fallback kills direct API runs.** `RunExecutionEngine.ts:520-531` advertises
`mcp__lazy-agent-service__scrape_url`; `processToolCall` only allows exact whitelist names
(`trading-junior-analyst-v1` lists `trading.research.scrape_url`) → `POLICY_VIOLATION` →
`executeAdmittedTool` throws (≈line 615) → run fails. The analyst profile has no
`local_tool_policy` → `TOOL_POLICY_MISSING`. REPORTED.

**D2 High — offloaded content can't be retrieved.** Three separate `OffloadStore` instances
(`OffloadPolicy.ts:80`, `ToolExecutor.ts:47`, `AgenticLoopService.ts:382`); `ensureLoaded`
reads the file once (`OffloadStore.ts:147`). After the first retrieve, newer offload ids are
"not found". Fixed `.tmp` filename races; up to 200×5 MB rewritten per put. CONFIRMED (code).

**D3 High (security) — model JS runs in the service process.** `CodeInterpreter.ts:168`
`new Function(...)`, reached from `PromptedToolCallingHarness.ts:458-463` before whitelist and
approval gate. Static scan bypassable (`globalThis["process"]["env"]`); a sync `while(true){}`
freezes the whole service (deadline only races async). Trigger: prompt injection from any
scraped page on a prompted-xml run. CONFIRMED (code).

**D4 Medium — live tail duplicates events.** `RunRoutes.ts:168-190`: with `Last-Event-ID`,
`lastId` stays at the cursor so the first poll resends replayed events; overlapping async
`setInterval` callbacks resend again; orphaned "running" runs are polled forever. REPORTED.

**D5 Medium — trading and `/execute` bypass the new web code.** `ToolOrchestratorService.ts:1380`
checks `isTradingToolCall` first → `routeLocalTool`. `web_search` there (`LocalToolRouter.ts:454`)
ignores `siteSearch`/domain filters/abort; `scrape_url` falls to trading-service's Python bridge:
no SSRF gate of ours, no `prompt` Q&A, hard 8000-char cut. CONFIRMED live.

**D6 Medium — SSRF gaps.** `GlobalCapabilityExecutor.ts:341-370,516-530` (`global.web.read_page`,
`fetch_metadata`, granted to `trading-strategy-chat-v1`) call `fetch` with no host check, allow
http/private IPs/redirects, merge model headers, read whole body. `isBlockedHost` misses
`0.0.0.0` and `100.64.0.0/10`; DNS names resolving private (`127.0.0.1.nip.io`) and
scraper-followed redirects unchecked. REPORTED.

**D7 Medium — scrape_url+prompt reports failure as success.** `ToolOrchestratorService.ts:1781-1804`:
failed extract → `answer:""`, error in `content` → `{success:true, answer:""}`; the
"Extraction did not run" branch is unreachable. REPORTED.

**D8 Medium — webSearch cancellation incomplete.** `WebSearchService.ts:261-301`: abort doesn't
stop the backend fetch; in-flight entry dropped while still running (duplicate Exa call,
result never cached); abort listener never removed; joiners ignore own signal; abort resolves
`{status:"error"}` so callers report `WEB_SEARCH_FAILED` not `CAPABILITY_CANCELLED` — the
cancellation test passes only because its mock rejects. REPORTED.

**D9 Medium — /chat can't be stopped by disconnect.** `SseUtilities.ts:223-229` + e1bc1b6: a
/chat SSE without `conversationId` has an un-abortable controller. `AgentSessionRegistry.cleanup`
deletes by id unconditionally → overlapping requests make `/agent/stop` 404. REPORTED.

**D10 Medium — `reasoning_content` is never round-tripped.** Read at `openai-compat.ts:641,730`,
never written back into assistant messages. DeepSeek thinking-mode-with-tools returns 400
without it (https://api-docs.deepseek.com/guides/thinking_mode/); interleaved-thinking models
lose their chain across tool turns. CONFIRMED (code).

**D11 Low** — `RoleAlternation.ts:64` orphan check doesn't match `tool_call_id`; merge drops the
second message's images/array content (132-137). Extract tmp files never cleaned. Compaction
memory flush re-extracts whole history with no timeout. `FAIL-OPEN` in
`PrismProxyService.ts:92`: an unregistered conversation is allowed every tool.
`/execute/*` has no auth (LAN-open). `web_search` returns `"published":"N/A"` strings, not null.

## 4. Consumer repos — is the hub actually the hub?

| Repo | How it reaches the harness | Still on prism? | Verdict |
|---|---|---|---|
| trading-service | `PRISM_URL=:5591/prism-proxy` (set only in `deploy.sh:105`); `/embed`; `/v1/runs` only if `USE_V2_SDK=true` (default false) | **Yes** — `PRISM_ENABLED=True` (`config.py:358`); prism-proxy forwards turns to `:7777` (`PrismProxyService.ts:106`); `/chat` callers hit prism | PARTIAL |
| html-notes | `LAZY_AGENT_URL=:5591`: `/agent`, `/execute/web_search`, `/execute/news_search` | health, MCP bootstrap, `/config`, STT still read prism (`app/main.py:3594-3655,1235-1251`, `routes/message.py:28,3503`) | PARTIAL |
| music-player | `RuntimeClient` gated by `MUSIC_RUNTIME_ENABLED=false` | **Yes, primary** — `llm.py:22` → `:7777/agent`; chat advisor too | BROKEN — 12 `music_player_*` handlers (`LocalToolRouter.ts:313-352`, hard-coded `10.0.0.16:8002`) have **no schema**, so no model is offered them |
| LLMSortObsidian | `:5591` `/embed`, `/execute/web_search`, `/agent`, `/v1/runs`, `/obsidian-completions` | opt-in only | OK — but `/execute/lazy_web_search` falls through to trading-service |
| treesearch-service | `/execute/web_search`; 8 `strain_*` routes exist | no | OK |
| office-client | OmniChat → `/prism-api` → `:7777` | **fully** | NOT MIGRATED |
| portal-service | LLM dashboard reads prism's Mongo `requests` | data only | PARTIAL — harness turns invisible |
| tools-service | prism's tool backend; scrapes DDG HTML (`AgenticWebService.ts:91`), vault `SEARCH_PROVIDER_PRIORITY=duckduckgo` | n/a | rule violation (not on the harness path) |
| lazycat-sdk 0.4.0 | `RuntimeClient`, `ToolExecutor`, `grounded_research` | `LLMClient` defaults to `:7777` (`config.py:12`) | PARTIAL — no embed client; consumers mount the working tree unpinned |

Bottom line: the **web search hub is live and used** by html-notes, Obsidian, treesearch and the
harness itself. The **agent loop hub is not**: trading, music-player and office-client still run
their turns in prism's loop.

## 5. Outside harnesses — what we are missing

Already present (grep-verified): never-silent results, strict schemas, stuck detector, skills,
subagents + `delegate`, prompted-xml harness, offload store, model profiles + context discovery,
role pre-flight, pair-safe compaction, aux chains, parallel tools, abort/steering, SSE cursor
replay, OTel, `cache_control`, `json_schema` output, search+fetch split.

Missing or partial, ranked by value/effort:

1. **`reasoning_content` round-trip** (S) — D10. DeepSeek docs above.
2. **Prefix-stable prompt assembly** (S–M) — deterministic tool order, static text first, no
   timestamps before the cache point; test that the prefix hash is stable across turns. Biggest
   vLLM prefix-cache win for trading cycles.
3. **Agent-intercepted `todo_write`** (S) — only an emoji entry exists (`ToolOrchestratorService.ts:1283`).
   Claude Code TodoWrite / Hermes `todo`.
4. **`search_conversations` handler** (S–M) — schema/locale exist, no handler. Hermes `session_search`.
5. **Durable turn resume for every repo** (M) — today only Obsidian jobs. Codex `exec resume`, Hermes SQLite.
6. **Async delegation + fan-out join through `TurnMailbox`** (M) — also gives the dead mailbox a producer.
7. **MCP client behind a whitelist + taint check** (M) — removed in `9113901`; Claude Code / Codex / Goose.
8. **Conversation checkpoints/fork** (M) — event id/parentId DAG (pi), `/runs/:id/fork?at=`. Gemini CLI `/restore`.
9. **Background memory reflection, git-versioned** (M–L) — Letta context repositories.
10. **User-configurable hooks (command/http)** (M) — `AgentHooks.ts` is code-only.

Not recommended: heavy OS sandbox for a general shell (we host no coding tenants) — but D3
must still be fixed; self-writing skills (unproven).

Sources: https://code.claude.com/docs/en/hooks, https://code.claude.com/docs/en/mcp,
https://hermes-agent.nousresearch.com/docs, https://geminicli.com/docs/cli/checkpointing/,
https://www.letta.com/blog/context-repositories,
https://docs.claude.com/en/docs/agents-and-tools/tool-use/tool-search-tool,
https://docs.claude.com/en/docs/build-with-claude/context-editing. Prior research:
`docs/harness-research/REPORT_agentic_harness_2026-10-10.md`.

## 6. Handoff plan (one item at a time: plan → implement → test → land)

Each item: own `wt-<topic>` worktree, testrun, regression test that fails before the fix,
land, deploy (`deploy-kit: npm run deploy -- --only=lazy-tool-service --skip-pull`), live check.

**Phase A — safety and correctness (do first)**
1. **D3 code interpreter**: run JS in `node:vm` inside a `worker_threads` Worker with
   `resourceLimits` and a hard `terminate()` timeout, empty globals; gate behind the profile
   whitelist + approval. Accept: `globalThis["process"]` returns undefined; `while(true){}`
   is killed in ≤5 s while `/health` stays responsive.
2. **D6 SSRF**: one `assertPublicUrl()` (resolve DNS, check every A/AAAA, block 0.0.0.0/8,
   100.64/10, existing ranges; re-check on each redirect, `redirect:"manual"`); use it in
   `WebExtractService`, `GlobalCapabilityExecutor` read_page/fetch_metadata. Drop model
   headers; stream with byte cap. Accept: `127.0.0.1.nip.io`, redirect-to-private refused.
3. **D2 offload**: single shared `OffloadStore` singleton; reload on miss (or per-id files);
   unique tmp names. Accept: offload A, retrieve A, offload B, retrieve B succeeds.
4. **D1 catalog fallback**: map catalog names back to whitelist capability ids before policy
   check, or exclude unadmittable tools; give `trading-analyst-v1` a `local_tool_policy`.
   Accept: a direct `/v1/runs` trading run calling scrape_url completes.
5. **D5 + D7 web path unification**: route `web_search`/`scrape_url` to
   `executeSharedWebSearch`/`executeWebExtract` **before** `isTradingToolCall`, and in
   `LocalToolRouter` for `/execute`; fix the failure-as-success branch. Accept: live
   `/execute/scrape_url` with `prompt` returns `answer`; a blocked URL returns `success:false`.
6. **D10 reasoning round-trip** in `openai-compat.ts` (keep on tool turns, per provider).
   Accept: replay with a DeepSeek-thinking fixture produces no 400.

**Phase B — finish what was claimed**
7. D8 cancellation (pass `AbortSignal` to the backend fetch, keep in-flight entry until settle,
   remove listener, throw `AbortError`); make the cancellation test use the real function.
8. D4 live tail (advance `lastId` after replay, serialize polls, stop on stale runs) + test.
9. D9 /chat stop (always register a controller; cleanup only if the entry is ours).
10. Dead wiring: either wire or delete `UnattendedPolicy`/`ApprovalRegistry`, turn mailbox
    producers, goal creation, vision/compression aux chains. Per the stale-test rule, delete
    tests for whatever is removed.
11. D11 lows (role-alternation `tool_call_id`, tmp cleanup, flush timeout, `published:null`,
    FAIL-OPEN → fail-closed with an allow-list, `/execute` API key).

**Phase C — make the hub the hub**
12. music-player: add `tool_schemas/music-player/*.json` for the 12 handlers, make the URL
    configurable (`MUSIC_PLAYER_URL`), then enable `MUSIC_RUNTIME_ENABLED` and move `llm.py`
    off `:7777`.
13. trading-service: flip to the native `/agent` (or `/v1/runs`) path behind a flag, A/B one
    cycle, then `PRISM_ENABLED=False`; make the non-deploy default `:5591`, not vault's `:7777`.
14. html-notes: health/MCP/config/STT from the harness, not prism; untrack `.venv/`, drop `ddgs`.
15. lazycat-sdk: add `EmbedClient` (`/embed`, `/v1/embeddings`), default `LLMClient` to the
    harness, publish a pinned version consumers install.
16. Obsidian: point `lazy_web_search` at `/execute/web_search` so it no longer needs trading.
17. office-client + portal-service: OmniChat via the harness; portal reads harness telemetry.
18. tools-service: stop DDG HTML scraping; vault `SEARCH_PROVIDER_PRIORITY` → shared search.

**Phase D — evals and the missing features (§5 list, in that order)**
19. **Tier 0 eval (every PR, no GPU)**: golden-trace replay of stored trading/notes turns with
    a mock provider; deterministic scorers (schema validity, identity fields after offload,
    outcome, tool-call count, prefix-hash stable, role alternation, reasoning round-trip).
20. **Per-repo frozen task suites** (20–50 each: trading verdict fields, notes retrieve+cite,
    music metadata, Obsidian folder accuracy vs labels); 3 runs, bootstrap CI via
    `ConfidenceInterval.ts`; store in `BenchmarkService`; gate landings on regressions.
21. **Tier 1 nightly (testrun `--gpu`)**: BFCL v4 non-live AST + multi-turn via evalscope
    (skip its web-search subset — no search-engine scraping), τ²-bench retail/airline with a
    small local user simulator; native vs prompted-xml harness A/B on the same model.
22. **Tier 2 weekly sample**: Terminal-Bench 2.0 via Harbor (20-task subset) against
    `/v1/runs`, mini-swe-agent baseline — only if we host coding agents.
23. §5 features 2–10.

## 7. Evidence

- Worktree `wt-harness-audit` at `8bc1f20`; tsc/vitest/bench logs in its `.checks/` (gitignored).
- Live probes run 2026-10-11 against `10.0.0.16:5591` and `:8001` (requests in §1).
