# HANDOFF — bundled lazycat copy synced to SDK v0.3.0 (2026-07-20)

**Commit:** `b60d842`
**Deployed:** NO — see "Not deployed" below.
**Companion commits:** lazycat-sdk v0.3.0, trading-service `fa70560`, HTML-Notes `11dbb40`

## Why this repo needed touching

This repo is unusual: it **bundles its own copy of the SDK** at
`python/lazycat/`, and its `python/app/` tree is otherwise byte-identical to
`trading-service/app/` (verified — only `pipeline_service.py`,
`watch_desk.py`, `v3/orchestrator.py` and `v3/quality_scorer.py` differ).

So when the SDK changes, this copy silently goes stale. It was byte-identical
to the SDK before this sync; it is byte-identical again now.

## What was synced

- `python/lazycat/` — the whole SDK at v0.3.0. New: `llm_json.py`,
  `resilience.py`, `cache.py`, `ratelimit.py`, `sse.py`. Modified:
  `llm/streaming/research/agent` (SSE parsing consolidated),
  `html_auditor` (no longer silently vouches for HTML it never inspected),
  `__init__` (exports + version).
- Five app-side shims matching trading-service:
  `app/utils/text_utils.py`, `app/utils/resilience.py`, `app/cache.py`,
  `app/scraper/core/rate_limiter.py`, `app/services/api_rate_limiter.py`.

See `lazycat-sdk/HANDOFF.md` for the full description of what v0.3.0 contains
and `trading-service/HANDOFF.md` for the shim rationale.

## Not deployed — read before you deploy

This working tree had **~21 files in flight from a parallel session** when the
sync was made (base_agent, tool_whitelists, eval_engine, cognition/evolution/*,
db/migrations, scraper engines, cycle_scheduler, pipeline_service,
finance_tools, v3/agent_runner, collector_stats, self_healing_watchdog,
tool_schemas.json, plus three new untracked files).

The sync commit is **path-scoped** — it touches only `python/lazycat/` and the
five shim files, none of which were in that dirty set. Nothing of the parallel
session's work was staged or committed.

**Deploying was deliberately left to the session that owns those changes.**
The sync rides out on their next deploy. If you are that session: the shims
keep every existing import working, and trading-service ran 892 unit + 157
integration/regression tests green against the identical change.

## DO NOT sync `app/utils/resilience.py` on its own

trading-service `811cb69` fixed its dead retry telemetry: it added a real
class-level `PipelineService.emit()` and registered an emitter with the SDK's
`set_failure_emitter()` hook.

**That fix was deliberately NOT synced here**, because it takes two files that
must move together:

- `app/services/pipeline_service.py` — one of the four files that genuinely
  differ between these twins, **and dirty from the parallel session**.
  This copy's `PipelineService` still has no `emit` method.
- `app/utils/resilience.py` — clean here, so it looks safe to sync.

Copying `resilience.py` alone would register an emitter that calls
`PipelineService.emit(...)` on a class that doesn't have it — recreating the
exact silent `AttributeError`-into-`except: pass` bug that fix removed. The SDK
swallows emitter exceptions, so it would fail silently again, which is how it
went unnoticed for so long in the first place.

When you do sync it: take **both** files, and check
`tests/unit/test_pipeline_emit.py` from trading-service comes along — it exists
specifically to stop this rotting again.

## Gotcha to remember

`python/lazycat/` is a *copy*, not a mount. Any future SDK change needs:

    cp lazycat-sdk/lazycat/*.py lazy-agent-service/python/lazycat/

Nothing enforces this — the twins just drift, and the failure mode is
this service quietly running older SDK behaviour than trading-service and
HTML-Notes, which both mount the live checkout.
