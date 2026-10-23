---
part: Operations
status: shipped
updated: 2026-10-22
review-by: 2026-11-19
---

# Chapter 15 — One tool-schema generator (2026-10-22)

## Resolved tickets

| Ticket | Issue | Root cause | Fix | Commit |
|---|---|---|---|---|
| SCHEMA-TWO-WRITERS | The `tool_schemas.json` shipped by lazy-agent-service, trading-service and trading-client depended on which repo deployed last. Five tools (`calculate_hrp_allocation`, `forecast_volatility_garch`, `get_portfolio_covariance`, `get_strategy_health`, `news_search`) had no `owner_app` in this repo's copy, so trading-client's `owner_app == "trading"` filter (missing means trading) wrongly counted `news_search` as a trading tool. | There were two generators reading the same shards. This repo's `scripts/export_tool_schemas.py` did not stamp `owner_app` and kept glob order. trading-service's `scripts/build_tool_schemas.py` stamped `owner_app`, sorted, and wrote into all three repos, including this one, from their deploy PRE_BUILD steps. Each deploy rewrote the others' output (trading-client ch.47). | `scripts/export_tool_schemas.py` is now the only generator. It stamps `owner_app` from the shard folder, requires `name`/`description`/`parameters`, fails on duplicate names and sorts by `(owner_app, name)`. It takes `--out PATH` so the trading repos write their own copy with it, and `--supports-out` so a caller can refuse an older exporter. trading-service's `build_tool_schemas.py` was deleted. `src/services/__tests__/ToolSchemaExport.test.ts` keeps the committed file in step with the shards. | see git log |

## How it works

The shards in `tool_schemas/<owner_app>/*.json` are the source of truth. Only one
command turns them into the flat file:

```
python3 scripts/export_tool_schemas.py                 # this repo's tool_schemas.json
python3 scripts/export_tool_schemas.py --check         # exit 1 if stale
python3 scripts/export_tool_schemas.py --out PATH      # another repo's copy
python3 scripts/export_tool_schemas.py --supports-out  # exit 0 on this version
```

Unknown arguments are an error. The old exporter ignored them, so a trading
deploy running `--out` against it would have overwritten this repo's file. The
trading PRE_BUILD steps therefore call `--supports-out` first and stop if it
fails.

Every copy is byte-identical. trading-service's `tests/test_multi_repo_audit.py`
compares them, and `ToolSchemaExport.test.ts` checks this repo's copy against
the shards.

## Editing a tool schema

1. Edit the shard under `tool_schemas/<owner_app>/`.
2. Run `python3 scripts/export_tool_schemas.py` and commit both files.
3. Regenerate the trading copies with `--out` (their deploys also do this) and
   commit them in those repos.
