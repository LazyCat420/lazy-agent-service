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
