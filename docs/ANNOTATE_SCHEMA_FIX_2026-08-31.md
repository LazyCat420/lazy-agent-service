# whiteboard_annotate declared integer ids for a string-id store (fixed 2026-08-31)

`tool_schemas/trading/general.json` declared `whiteboard_annotate.entry_id` as
`"type": "integer"`. Trading-service's whiteboard has issued **string** ids
(`wb_<10 hex>`) since its Mongo port (trading-service `5fbfac8`, 2026-08-18),
and `annotate()` looks up `{'id': entry_id}` — so a schema-compliant model
could never produce an id that matched any entry. The tool-side annotation
channel (the load-bearing cross-agent consumption signal per trading-client
ch.25/26) was structurally dead.

## Why the catalog is the half that matters

The SDK registry's `_put_schema` gives the compiled catalog precedence: **a
catalog entry overwrites a decorator entry; a decorator entry never overwrites
a catalog entry** (lazycat-sdk `tool_registry.py:255`). Fixing only
trading-service's `@registry.register(parameters=...)` would have changed
nothing at runtime — verified red by
trading-service `tests/unit/test_whiteboard_annotate_schema.py`, which read
"integer" from the loaded catalog after the decorator fix alone.

## The fix

- `d17fc22` here: `entry_id` → `"type": "string"` with a wb_-example
  description, in the split source of truth
  (`tool_schemas/<owner_app>/<domain>.json`).
- Flat copies rebuilt with trading-service `scripts/build_tool_schemas.py`
  (91 tools → lazy-agent-service, trading-service, trading-client), restoring
  the byte-identical invariant `test_multi_repo_audit.py` asserts.
- Decorator half + defensive `str()` coercion + tests: trading-service
  `2eec45d` (branch p1-memory-whiteboard-fixes at time of writing).

## Open follow-up

Annotation SUCCESS RATE since 2026-08-18 is unmeasured — the fix proves the
schema matches the store, not how much annotation traffic the mismatch cost.
One Mongo count of `whiteboard_annotations` by day, split at the port date and
at this fix's deploy, closes it (planned in the trading audit plan's whiteboard
phase).
