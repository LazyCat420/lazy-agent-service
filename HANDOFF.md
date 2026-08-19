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
