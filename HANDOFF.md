---
part: Consumer apps
status: shipped
type: record
updated: 2026-10-31
---

# HANDOFF — CRAP 0, complexity ratchet at error 20, tested boot (2026-10-31)

The quality tail of the 2026-10-29 gates closed. Measured on `main` after the
batch (`npm run quality:crap`, 5,189 functions):

| metric | 2026-10-29 (`57572df`) | now |
|---|---|---|
| CRAP > 60 | 353 | **0** |
| McCabe > 30 | 0 | **0** (max 20) |
| ESLint `complexity` | warn 20 | **error 20**, 0 findings |
| coverage | stmts 47.85 / fn 56.14 | **82.39 / 82.66** (lines 83.53) |
| duplication (logic) | 2.26 % | **2.14 %** |
| architecture | 0 errors / 137 warn | 0 errors / 144 warn |
| tests | 3,306 | **3,344** (241 files) |

**Boot is no longer untestable.** `src/index.ts` was 724 lines and the only
thing over CRAP 60; it is now 33 lines over three tested modules:
`src/boot/server.ts` (`createHttpRuntime` — middleware, health, routes, error
handler, WSS), `src/boot/indexes.ts` (`INDEX_DEFINITIONS`),
`src/boot/runtime.ts` (`connectDatabases`, `ensureCollectionIndexes`,
`clearStaleGenerationFlags`, `loadCustomAgents`, `consolidateAllProjects`,
`runConsolidationSweep`/`runHousekeepingSweep` as single ticks plus their
timer wrappers, table-driven `startDaemons`, `initMinio`, `startRuntime`,
`logStartupBanner`, `onListening`). Every dependency is injected, so
`src/boot/__tests__/runtime.test.ts` drives behaviour with fakes and no
timers (24 tests). `PlatformRoutesTradingDb.test.ts` used to grep `index.ts`
source text for boot order; it now calls `connectDatabases` with fakes.

**Complexity.** 95 functions sat at cx 21–53. Five agents decomposed them in
disjoint file groups — utils/providers/core, harnesses, orchestrator,
routes/request-logger, remaining services — by pure in-file helper extraction
(no exported signature, log text, prompt text or side-effect order changed),
then the two functions the inventory missed (`RuntimeClient.readEvents` 24 →
`extractDataPayload`/`isValidRunEvent`; `authMiddleware` 22 →
`resolveProject`/`resolveClientIp`/`applyToRequestContext`). `RequestLogger.log`
went 53 → 3; `ConfigRoutes` persona list 38 → 2; `ToolOrchestratorService`
`executeToolStreaming` 36 → 7. The rule is now `["error", 20]`.

**Coverage fix for the last CRAP offender:** the extraction left
`emitRetrySpans` (cx 9, coverage 0) at CRAP 90 — the only failure.
`ToolRetryInterceptorSpans.test.ts` drives `buildToolRetryGuidance` with a
stopped `TraceExporter` and asserts the emitted span (name, kind, status,
trace/run/parent ids, attributes), the circuit-breaker case (no span) and the
success case (no span).

**Verified:** `npm run verify` exit 0 (241 files / 3,344 tests, 0 lint errors,
70 warnings); `npm run quality:crap` PASS (cx>30 0, CRAP>60 0); dry 2.138 %;
arch 0 errors; prompt budget PASS (compact 22.6 % of full).
Live boot on `8eed5ac`: indexes 48/48, AutoDream 24 h, housekeeping boot +
6 h schedule, banner on port 7778, `/health` 200, vLLM shims (`jetson`,
`gold-spark`, `jetson-2`) responding, `nemotron35` chat completing and
releasing the GPU lock.

**Next:** real `no-circular` cycles (144 warnings) then make that rule an
error; knip exports/types against `CONTRACT_OWNERSHIP.md`; per-directory
coverage floors; `max-depth`/`max-params`/`max-lines-per-function` still warn —
ratchet those the same way when their counts reach 0.

---

# HANDOFF — `scrape_url` no longer advertises a file it cannot read (2026-10-31)

Measured after `cc3308a` (31 scrape_url calls, 15 failed): the malformed bucket
did not disappear, and its cause was not the URL text. Three calls were
`scrape_url` on `/tmp/lazy-agent-web-extract/<hash>.txt` and
`file:///tmp/lazy-agent-web-extract/...` — the truncated-extract footer told the
model "the full text is stored at <path> — read it", and `readHint` said
`read_file "<path>"`, but no tool in this service is `read_file`. The agent
tried the only tool it had on the path, which failed as a malformed URL and
spent a budget slot.

- `truncateAndStore` footer now says "call scrape_url again on this same URL
  with a higher char_limit (up to 500,000)"; the full text stays in the per-URL
  cache, so the re-call costs no second fetch. `readHint` and
  `WebExtractAnsweredResult.stored_file` are deleted; `storedPath` stays on the
  result for the store sweeper but is never put in a tool payload.
- `ToolOrchestratorService` no longer emits `stored_path` / `read_hint` on the
  `scrape_url`, `read_url` fallback, or answered paths.
- `tool_schemas/shared/web.json` (+ regenerated `tool_schemas.json` and
  trading-service's copy) states the re-call instead of the file.
- Budget visibility: `chargeScrape`'s refusal only fires on the call that
  exceeds the budget, so 4 of 31 calls were spent on refusals. Every successful
  scrape now carries `scrape_budget: {used, budget, remaining}`
  (`UnscrapableDomains.scrapeBudgetStatus`), so the model can plan the rest of
  its run instead of discovering the wall by hitting it.

**Verified:** `npm run verify` exit 0 — 239 files / 3,317 tests, 0 lint errors
(182 warnings), dry 2.25 %, arch 0 errors / 144 warnings, prompt budget PASS.
Tests pin: the footer names the re-call and not the path, the tool result never
contains a `/tmp` path or `stored_path`/`read_hint`, and a successful scrape
carries the budget counter.


# HANDOFF — `scrape_url` scheme normalization + actionable retry message (2026-10-30, `cc3308a`)

Root cause of the October `scrape_url` failures (68 rows, all `v3_fundamental_analyst`,
41.7 % of 1,042 calls failed overall): models pass search results the way the page
shows them — `domain.tld/path` with no scheme — and the handler required
`/^https?:\/\//i`, so the call died before any scrape. The error text
("Try again later or use another source") then pushed the model to retry the same
bad URL or abandon the source.

- `src/utils/ScrapeUrl.ts` (`normalizeScrapeUrl`): full `http(s)` URLs untouched;
  `//host` → `https://host`; bare `domain.tld[:port][/path]` → `https://…`;
  relative paths and bare words returned unchanged so the guard still rejects them.
  Dependency-free on purpose: `LocalToolRouter` needs it before the SSRF guard,
  deny-list and budget checks, and importing `WebExtractService` there would pull
  the provider registry into every router consumer (it broke a router test suite).
- `routeScrapeUrlTool` normalizes once and passes the normalized URL to
  `scrapeTargetGuard`, `unscrapableDomainOf`, `chargeScrape` and the extractor.
- `ToolOrchestratorService.webExtractFailure` replaces both generic failure
  strings: a malformed argument now says "Call scrape_url again with the full URL
  including https:// (copy it from the search results)", other failures say
  "Try another URL or source", and every failure echoes `(url: …)` so the
  telemetry row keeps the value that failed instead of only its hash.
- `tool_schemas/shared/web.json` (+ regenerated `tool_schemas.json`) states the
  requirement on the `url` parameter. No `pattern` was added: bare domains are now
  accepted, so `^https?://` would reject valid input at the client.

**Verified:** `npm run verify` exit 0 — 239 files / 3,315 tests, 0 lint errors,
dry 2.26 %, arch 0 errors, prompt budget PASS. Live on `cc3308a`
(synology 2026-10-30T22:20:05Z): `/health` ok; `POST /execute/scrape_url
{"url":"/investors/earnings"}` → `success:false` with the retry guidance and
`(url: /investors/earnings)`; `{"url":"example.com"}` → scraped as
`https://example.com` (thin-content error, i.e. the request reached the scraper);
deployed `tool_schemas.json` carries the new description.

# HANDOFF — CRAP cleanup: 353 → 3 hot functions (2026-10-30)

The CRAP debt left by the 2026-10-29 entry was paid down with coverage, not
refactoring. Two waves of test-only slices (21 + 17 new test files, 1,306 tests)
covered every function that was over CRAP 60 with zero coverage.

| metric | 2026-10-29 (`57572df`) | 2026-10-30 (`HEAD`) |
|---|---|---|
| CRAP > 60 | 353 (ceiling 360) | **3** (ceiling 3) |
| McCabe > 30 | 0 | **0** |
| coverage stmts / br / fn / lines | 47.85 / 42.94 / 56.14 / 48.20 | **81.71 / 73.91 / 81.85 / 82.79** |
| tests | 193 files / 2,000 | **239 files / 3,306** |
| duplication (logic) | 2.26 % | 2.26 % (unchanged) |

The 3 remaining are the process bootstrap in `src/index.ts`: the boot IIFE
(cx 22), the 24-hour consolidation `setInterval` callback and the
`server.listen` callback. They only run in the deployed process, so they are
covered by the live deploy + `/health` check rather than by a unit test;
extracting them into an injectable `bootstrap()` is the next step if the gate
should reach 0.

**Real bug found by the new tests:** `GET /admin/stats/timeline?hours=24`
read `Date.now()` twice, so the span was a few milliseconds over a day and
fell into the 3-day tier — it returned 15-minute buckets instead of 5-minute
ones. Fixed in `AdminStatsRoutes.ts` by taking one clock reading; the new
`AdminStatsCoverage.test.ts` pins it (it was intermittently green before,
depending on whether both readings landed in the same millisecond).

**Verified:** `npm run verify` exit 0 (3,306 tests, 0 lint errors);
`npm run quality:crap` PASS with `--max-crap-count 3`; arch 0 errors;
dry 2.26 %.

# HANDOFF — measured quality gates + model-agnostic harness (2026-10-29)

First real measurement of this repo's code quality. The 2026-10-28 entry below
claimed "0 functions over McCabe 30"; the first CRAP run contradicted it
(19 over 30, max 91). Both are now true: **0 over 30**, measured.

| metric | before (`266a0ef`) | after (`57572df`) |
|---|---|---|
| functions measured | 4,715 | 4,889 |
| McCabe > 30 | 19 (max 91) | **0** |
| CRAP > 60 | 374 | **353** (ratchet ceiling 360) |
| coverage | stmts 44.77 / br 39.71 / fn 53.70 / lines 44.96 | **47.85 / 42.94 / 56.14 / 48.20** |
| duplication (logic) | 2.94 % (205 clones) | **2.26 %** (177 clones) |
| architecture | 3 `services-no-routes` errors, 109 cycles | **0 errors**, 137 warn (barrel cycles) |
| dead code (knip) | 230 findings | 228 (0 unused files, 58 exports, 165 types, 5 dup) |
| tests | 180 files / 1,930 | **193 files / 2,000** |
| `npm run verify` | — | ~35 s |

**Landed:** `scripts/quality/{crap,dry,arch,deadcode,prompt-budget}.mjs`,
dependency-cruiser + knip configs, ESLint complexity ratchet, `npm run verify`,
`.github/workflows/quality.yml` (push/PR gate + nightly full report). Chat
generation moved to `src/core/chat/ChatGeneration.ts`, removing all three
`services-no-routes` violations. Deduped admin query filters, definition
registries, ToT/GoT plumbing, frontmatter parsing, somatic keyword effects.
Provider payload builders + per-event stream reducers (anthropic/openai/google,
MemoryConsolidation, RequestLogger, VllmModelSync). Routes: shared
`parseCsvFilter`, definition router factory, handler decompositions
(Audio/Platform/Conversations/Media/AdminConversation/Embed). Services:
`ConversationService.appendMessages`, `ScheduledTaskService.tick`,
`llama-cpp.getServerProps`, `EmbeddingService.generate`.

**Model-agnostic harness:** catalog `ttsSteering` replaces
`model.startsWith("inworld-tts-2")`; openai reasoning reads catalog `thinking`
(unknown model → reasoning-safe path); `getModelProfile` is catalog-first
(limits, `thinkingLevels`, `thinking`) with name patterns only as fallback.
`code_health` tool (deterministic, in-process, no FS/shell/network) lets an
agent measure the files it wrote before claiming done. `CriticGate` picks a
different model of the same provider and reports `judgeIndependent`.
Prompt budget gate: full tool catalog 12,888 tok vs compact 2,918 tok (22.6 %);
10 descriptions over 600 chars (`canvas_add_widget` 6,862) reported, not gated.

**Verified:** `npm run verify` exit 0; `quality:crap` 0 over cx 30 / 353 over
CRAP 60 (ceiling 360); `quality:deadcode` 228; `quality:prompt` PASS. Deleted 5
files with no importers (`db.ts`, `SkillService.ts`, `RepositoryMapService.ts`,
`memory/index.ts`, `somatic/index.ts`) after a repo-wide grep; 2,000/2,000 tests
still green. Reports: `.checks/quality-2026-10-30/`.

**Deployed:** `main@57572df` → synology NAS, build 96 s, `/health` returns
`{"status":"ok"}`. Live eval re-run on the deployed build (same script, same 8
questions × 2 profiles, GLM judge, concurrency 1):

| profile | grades | wall s before → after | tool calls | tokens |
|---|---|---|---|---|
| trading | 7 PASS / 1 WEAK → same | 810 → 578 (−29 %) | 21 → 22 | 68,433 → 75,736 |
| html-notes | 7 PASS / 1 WEAK → same | 877 → 566 (−36 %) | 12 → 13 | 46,865 → 48,404 |
| total | 14 PASS / 2 WEAK → same | **1,688 → 1,144 (−32 %)** | 33 → 35 | 115,298 → 124,140 (+7.7 %) |

LIKELY, not proven: 16 live runs with one sample per question, so wall-time
variance and backend load are uncontrolled; grades and tool counts show no
regression, and tokens rose slightly with the extra tool calls.

**Next session:** raise coverage where CRAP is high, then lower
`--max-crap-count` (360 → 300 → …) and tighten ESLint `complexity` to error 20;
fix real `no-circular` cycles; decide the 228 knip exports/types against
`CONTRACT_OWNERSHIP.md`; add per-directory coverage floors.

---

# HANDOFF — Phase 8 `/lego` CRAP Decomposition (2026-10-28)

- Decomposed all **69 functions** in `lazy-agent-service/src` that exceeded McCabe cyclomatic complexity 30 into single-responsibility helpers (`<= 15` complexity each), reducing max complexity across all 2,644 functions in `lazy-agent-service/src` to **30** (`0` functions `> 30`).
- Key decomposed modules include `RunExecutionEngine.ts`, `WorkflowExecutionService.ts`, `ChatRoutes.ts`, `ReActHarness.ts`, `BaseAgenticHarness.ts`, `CoreLoop.ts`, `GraphOfThoughtsStrategy.ts`, `TreeOfThoughtsStrategy.ts`, `LmStudioProvider.ts`, `OpenAICompatibleProvider.ts`, `ToolExecutor.ts`, `ContextPressureManager.ts`, and `VllmModelSyncService.ts`.

---

# HANDOFF — topic roles by batch, a FIT rating, seeds that reach the model (2026-09-06)

**Deployed:** see the youtube-wallgarden handoff for the live verification;
this service's commit is `feat(wallgarden): topic roles by batch, a FIT rating,
seeds that reach the model`.
**Companion:** `youtube-wallgarden` (roles + composed queue + era-aware slate)
and `trading-service` scraper (upload dates on every search row).

## What this change is

An audit of "why does the feed pull random topics" traced 75% of every
brainstorm batch to a prompt quota that told the model to LEAVE the user's
scene (40% lateral, 25% wildcard, 10% time-shift), at temperature 0.9–1.05,
with each batch seeing ONE liked cluster and told to ignore the rest. The
rater then graded phrase anchoring with no idea who the viewer was, so an
on-anchor, off-taste topic rated A / weight 8.

- **Roles are decided by the BATCH.** `planBrainstormBatches` (pure) makes one
  blended CORE batch that sees every cluster at 0.6, ADJACENT batches
  allocated across clusters by their `size` (largest remainder; tiny clusters
  pool into one mixed batch), and one small EXPLORE batch at 0.9 once
  `n >= 20`. Server clamp: 100 topics, 6 batches. `brainstormTopics` now
  returns `{topic, role, cluster}`; on a duplicate the first role wins. The
  model is never asked to self-label — that would break the truncation
  salvage in `extractTopicsFromResponse`.
- **FIT next to ANCHORING.** `rateTopics(topics, model, provider, {taste,
  roles})` appends the FIT rubric and sends the profile, liked titles and
  interests. Weight = f(tier, fit): A/HIGH 8, A/MED 6, B/HIGH 4, B/MED 3; LOW
  is dropped unless the role is explore (floor 2); a topic the rater never
  graded gets `UNRATED_WEIGHT = 2` with `unrated: true`, not B's 4. Without
  `taste` the prompt is byte-identical to before (the extract path).
  `rateFit: false` on the request is the control arm.
- `/similar` renders every seed strongest-first and the failed-shape line it
  has accepted-and-dropped since it was written; quota 60/30/10 at 0.7; its
  output is rated (role adjacent) and returned as `rated` next to the
  unchanged `topics`.
- `promptVariant` is forwarded and echoed. Grounding evidence renders view
  counts and upload years when the client sends `results[]`, and the judge
  may answer `DEAD`. Candidate classification accepts `description`.

Old clients see no change: `topics` stays `string[]` on both routes and every
new input is optional.

## Verify

```bash
npx tsc --noEmit && npx vitest run src/services/wallgarden
```

`TopicRoles.test.ts` asserts on the OUTBOUND `/chat` bodies: exactly one CORE
body listing every cluster, exactly one EXPLORE, no body carries the old
"~40% LATERAL" quota, every body carries the anchor test, core is cooler than
explore, FIT evidence appears only with taste, LOW/explore/unrated weights,
`/similar` carries all seeds + FAILED + "60% ADJACENT", DEAD is accepted.

## Traps

- `VllmModelSyncService.test.ts` fails in a worktree that symlinks
  `node_modules` (it saves `globalThis.fetch` at module load and shares it);
  it passes in the primary checkout. Not touched by this change.
- `JetsonPin.test.ts` has a 5 s per-test timeout that trips when four test
  files cold-import the service on a loaded box; `--no-file-parallelism`
  makes it deterministic.
- The brainstorm call count is now `<= 6` generation batches + rating
  batches. Brainstorm is manual-only on the client, so this is acceptable,
  but `BRAINSTORM_MAX_BATCHES` is the knob if the Jetson thrashes.

---

# HANDOFF — measured outcomes now reach the topic prompts (2026-08-22)

**Deployed:** yes, `561c62a` on `main`, live 23:04Z.
**Companion:** `youtube-wallgarden@ed93812` derives the outcomes and owns the
A/B instrumentation.

## What this change is

Three classes of MEASURED result are rendered into the brainstorm and similar
prompts by `buildOutcomesBlock` — WORKED (liked/played), IGNORED (shown
repeatedly, never touched), SLOP (grounding gate said the real results were
generic).

Until now this service computed all of that and threw it away: grounding
verdicts were returned to the client and never fed back, A/B tiers likewise,
and `failedExamples` — the one field that instructs the model to *"study their
SHAPE"* — was being handed `burnedQueries.slice(-10)`, the same array the model
already receives one line further up the prompt.

IGNORED is the half worth the tokens. Those topics were produced by a previous
run of this very prompt, surfaced repeatedly, and never touched. The user never
rejected them by hand, so they appear in no blacklist.

Also fixed: `/similar` destructured `failedExamples` away, so a field the client
has always sent never reached the model on that route.

## The result: no measurable difference (yet)

Three paired runs against the live Jetson, same seeds, synthetic outcomes:

| arm | n | filler-shaped | tier-A |
|---|---|---|---|
| flat | 30 | 3 (10%) | 29 (96%) |
| stats | 30 | 3 (10%) | 28 (93%) |

Within noise. The first pair looked better for the stats arm by eye and that
did not survive n=30.

This is a real result, not a failed deploy: the block demonstrably reaches the
model (the tests assert on the outbound `/chat` body, not on the builder's
return value), it costs under 1k tokens against a 65,536 window, and it is
withheld entirely when there is nothing measured to say. It is simply **not yet
shown to beat the free context**. The client ships `wgPromptAB()` to settle it
on real engagement once the counters fill.

## Traps this encodes

- **Assert on the outbound body, not the builder.** A block that is built and
  then dropped is a failure mode this repo has hit twice — `failedExamples` on
  `/similar` (fixed here) and `topicPolicies`, which the wallgarden client
  pushes to the sync service to this day and which goes nowhere because it is
  not in `SYNC_FIELDS`.
- **Adding a field is three edits, not one:** the interface, the route
  destructure, AND the forward call. I left a duplicated identifier in the
  brainstorm destructure on the first pass and the forward call still did not
  have it; `tsc` caught the duplicate, nothing would have caught the omission
  but the test.
- Input scaling stays safe: a full brainstorm was ~2k tokens and the worst-case
  outcomes block is capped near 1k, against 65,536.

## Open items (carried forward)

- No shim concurrency cap for the Jetson — `VLLM_SHIM_MAX_CONCURRENT_JETSON`
  is the lever if parallel batches thrash.
- `VllmModelSyncService.test.ts` still has 5 failures, confirmed pre-existing
  against pristine HEAD.

---

# HANDOFF — wallgarden is pinned to the Jetson, and a client hint could outvote the server (2026-08-22)

**Deployed:** yes. `8456371` on `main`, live on synology at 22:11Z, verified
against the Jetson's own GPU counters (below).
**Companion change:** `youtube-wallgarden@b29bdf0` — the dashboard side.

## What this change is

Every wallgarden LLM call now runs on the **Jetson** (`vllm`,
10.0.0.30:8000, `cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit`). Gold Spark (`vllm-2`) is
deliberately **not** a fallback: it is shared with the trading stack, and
wallgarden's background topic churn should not contend for it. If the Jetson is
down these routes now throw, which the dashboard already toasts and backs off
exponentially — the correct behaviour for a non-urgent feature.

All seven LLM entry points (`brainstormTopics`, `rateTopics`,
`extractVideoTopics`, `generateTasteProfile`, `judgeTopicGrounding`,
`generateSimilarTopics`, `classifyCandidateVideos`) share one resolver, so this
is a single-seam change.

## The defect: a server "preference" any client could silently outvote

`resolveProviderAndModel` opened with this, before it looked at a single box:

```ts
if (preferredModel && preferredProvider) {
  return { model: preferredModel, provider: preferredProvider };
}
```

The dashboard persists its last dropdown pick as `provider::model` in
localStorage (`state.settings.llmModel`) and `buildLlmContext()` replays it on
**every** request. So the box that actually ran the work was decided by whatever
each browser had saved. The server's ordered preference list only ever applied
to a first-time tab.

**This is the part worth remembering: flipping the server's preference would
have measured as "fixed" on a clean browser profile and changed nothing in any
real tab.** A caller hint is now honoured only when it names the Jetson;
anything else is ignored and logged at WARN.

Second half of the same bug: `GET /wallgarden/models` advertised every box, so
the settings dropdown offered a choice the backend would now refuse — a UI that
lies about what it can do. It returns only the Jetson.

## The model id stays discovered, not hardcoded

`queryVllmBox` still reads the live id from the box's `/v1/models`.
`EXPECTED_JETSON_MODEL` is an **assertion that warns on drift, not the source of
truth**. Two reasons this matters here:

- This Jetson has been re-provisioned before (it served gemma-4-31B until
  2026-08).
- Prism resolves a request by model **name** and re-homes it to whichever box
  serves that name, ignoring the caller's provider slug. A stale hardcoded
  string would therefore not fail — it would quietly run the job somewhere else.

## What proved it — the GPU's own counter, not our own logs

A service that reports `provider=vllm` is reporting its own intent. The
independent oracle is each box's `vllm:request_success_total` in `/metrics`,
sampled before and after. Sending `provider=vllm-2` and
`model=deepseek-v4-flash-0731` **explicitly** — exactly what a stale tab
replays:

```
brainstorm + rateTopics:                             jetson +2   goldspark +0
taste-profile / judge-topics / classify-candidates:  jetson +3   goldspark +0
```

Gold Spark's counter sat at 113 across every probe. Crucially, it was **online
and idle** in the same log line that shows the hint being refused — so this is a
deliberate refusal, not a fallback firing because the other box happened to be
down. That distinction is the entire test; without it the evidence is worthless:

```
Discovered 3 vLLM boxes: Jetson=online (cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit),
  Gold Spark=online (deepseek-v4-flash-0731), Jetson=online (embeddinggemma)
WARN  Ignoring client model hint vllm-2::deepseek-v4-flash-0731
      — pinned to vllm::cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit
INFO  Brainstorm returned 10 unique topics from 1/1 batches
      via vllm/cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit
```

Note the third discovered box is **also nicknamed "Jetson"** but serves
`embeddinggemma` on :8001. The filter keys on `id === "vllm"`; filtering on the
nickname would have selected the embedding model.

## Tests

`src/services/wallgarden/__tests__/JetsonPin.test.ts` drives the real seam —
discovery, resolution and the outbound prism body — through a `fetch` stub,
because the bug is invisible to a parser test. All four assertions were
confirmed **red** against the previous resolver before being accepted:

| assertion | failure on old code |
| --- | --- |
| sends the Jetson model while Gold Spark is online | got `deepseek-v4-flash-0731` |
| ignores a stale Gold Spark client hint | got `deepseek-v4-flash-0731` |
| fails loudly when the Jetson is down | resolved instead of rejecting |
| only advertises the Jetson | got `[]` |

A green test that never fails on the unfixed code proves nothing; that column is
the point of the table.

## Open items

- **No shim concurrency cap for the Jetson.** `DEFAULT_MAX_CONCURRENT` in
  `src/services/vllm/VllmShimService.ts` caps only `gold-spark` at 4. The Jetson
  is the slower box (~25 tok/s) and `brainstormTopics` fans out parallel
  batches. If batches start thrashing, set
  `VLLM_SHIM_MAX_CONCURRENT_JETSON` — the lever already exists and is read per
  call, so it needs a restart but no rebuild.
- **`VllmModelSyncService.test.ts` has 5 failing tests.** Confirmed
  **pre-existing** by running that file in a detached worktree at pristine
  HEAD — identical 5 failures. Unrelated to this change and left alone; it
  concerns prism settings auto-healing.
- `max_model_len` on the Jetson is **65536**. Several notes across these repos
  still assume 8192 / 16384 / 100k — all stale.

---

# HANDOFF — Postgres is gone, and `/platform/*` could never have worked (2026-08-19)

**Deployed:** no. Committed on `remove-postgres` (`8a813c1`) and pushed; the
merge and deploy are the owner's call, and this service is due to go out in the
trading cutover window (see *Deploy ordering* below).
**Companion changes:** none required. `trading-service` and `trading-client`
carry the rest of the Postgres→Mongo migration on their own branches.

## What this change is

This service's only Postgres surface was the platform dashboard: four read-only
endpoints over `tool_usage_stats`, plus `src/db/postgres.ts`. The conversion to
Mongo had been **written but never committed** — it sat in the primary
checkout's working tree on `main` while this branch carried only the `pg`
dependency removal. It is now on the branch, finished, with the defect that
made it unusable fixed.

## The defect: four endpoints, 500 on every call

`tool_usage_stats` lives in the **trading** database, a different database from
prism's on the same server. The rewrite reached it with:

```ts
const db = MongoWrapper.getDb(TRADING_MONGO_DB);   // "trading_bot"
```

`MongoWrapper.getDb` → `MongoManager.getDatabase(name)`, which looks the name up
in a registry populated only by `createClient()`. `src/index.ts` registered
exactly one:

```ts
await MongoWrapper.createClient(MONGO_DB_NAME, MONGO_URI);   // "prism"
```

`getDatabase` does **not** return an empty database for an unregistered name —
it throws `Database not connected: trading_bot`. So the first line of every one
of the four handlers raised, the generic catch turned it into a 500, and
`/platform/stats`, `/storms`, `/recent` and `/services` were broken in every
environment for as long as the rewrite existed.

This is the failure mode where a wrong answer would have been *better*: an empty
database would have rendered a dashboard with zeroes, which someone would have
questioned. A 500 on a telemetry page reads as "the dashboard is flaky".

### The fix, and why it is at boot

```ts
await MongoWrapper.createClient(MONGO_DB_NAME, MONGO_URI);        // prism, first
if (MONGO_URI) {
  try { await MongoWrapper.createClient(TRADING_MONGO_DB, MONGO_URI); }
  catch (e) { logger.error(...) }                                  // 503, not a dead boot
}
```

Two things are load-bearing:

* **Order.** `MongoManager` takes the FIRST connection as the default for
  name-less `getDb()` calls (`if (!defaultName) defaultName = name`). Register
  the trading database first and every unnamed prism read silently addresses
  the wrong database.
* **The try/catch.** This service is a dashboard over another project's
  collection, not the trading cycle. An unreachable trading database must not
  abort the boot of the box that fronts every LLM request the desk makes.

Per request, `tradingDb(res)` now answers **503 with a reason** rather than a
500 — restoring what the deleted `getPlatformPool()` null-check used to do.
"The data source is not configured here" is this service's honest answer about
someone else's collection; a 500 blames the wrong side.

## `GET /platform/registry` is restored

It reads `tool_schemas.json` off disk and has never touched a database, so it
was removed as collateral in a Postgres rewrite rather than deliberately.
Deleting it turns "which project owns this tool" into a 404 for every caller.

## What was verified, and how

| claim | evidence |
|---|---|
| an unregistered database throws rather than reading empty | `MongoManager.getDatabase` source; asserted in `PlatformRoutesTradingDb.test.ts` |
| the guard is what produces the 503 | **sabotage**: reverting `tradingDb(res)` to a bare `getDb()` turns the 503 assertion into `expected 500 to be 503` |
| boot registers the trading database, after prism's | source-order assertion on `src/index.ts` |
| an unreachable trading database does not kill the boot | the registration is inside try/catch, asserted |
| nothing else regressed | `npm test` 557 passed (was 553), `npm run typecheck` clean |

The boot-order test matters more than the 503 test: **a 503 guard on its own is
a tidy error message on a permanently broken endpoint.** Only the registration
makes the endpoints work.

## Configuration

`TRADING_MONGO_DB` (default `trading_bot`) is documented in `.env.example` and
staged in the compose file. The deploy script's comment notes that
`DATABASE_URL` is no longer one of this service's keys.

`pg` and `@types/pg` were already dropped on this branch (`6bdf69c`).

**The "rebuild `dist/`" worry does not apply here.** The trading migration plan
warns that a stale `dist/` would still import `pg` and run the SQL. The
Dockerfile runs `pnpm run build` over the copied working tree, so the image
compiles `dist` from source at build time, and this checkout has no `dist/` at
all.

## Deploy ordering

Per the trading cutover runbook, this service goes out **in the cutover window,
after both trading containers are up and before the Postgres quiescence
baseline is taken** — its four endpoints must be answering 200 before the soak
starts measuring who is still touching Postgres, or its own reads would be
mistaken for the cycle's.

## Open items

1. **Not deployed.** The branch is committed and pushed, not merged. Nothing in
   production has changed; the four endpoints are still 500 until it ships.
2. **The primary checkout still carries the same edits, uncommitted on `main`**
   (`config.ts`, `src/routes/PlatformRoutes.ts`, deleted `src/db/postgres.ts`).
   They predate this session and are now redundant with `8a813c1`. They were
   left alone rather than discarded; whoever owns them should drop them before
   the merge, or the same change will arrive twice.
3. **No test covers the happy path** — a real `tool_usage_stats` read. The four
   tests here pin the failure modes (unregistered → 503, boot order, non-fatal
   boot); asserting the aggregation's output needs a Mongo fixture this repo
   does not have.
