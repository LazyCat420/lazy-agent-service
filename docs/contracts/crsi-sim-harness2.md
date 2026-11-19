# CRSI + Self-Improvement Memory (SIM) Contract (`arXiv:2611.18856`)

## Scope

Implements problem-indexed Self-Improvement Memory (`SimStore`), cross-family CRSI synthesis (`CrossModelCrsiService`), per-`(agent_name, modelFamily)` opening tool stacks (`TradingToolStacks`), and `PromotionController`-gated `/vllm-shim` interlocks (`TradingToolProtocol` + `VllmShimService`) across local DeepSeek (`gold-spark` `10.0.0.141:8000`) and local Qwen (`dell1` `10.0.0.131:8888`, `dell2` `10.0.0.37:8888`).

## Hard Invariants

1. **100% Local Inference:** Every model slug is resolved dynamically at call time via `GET /v1/models` (`discoverLiveEndpointTarget`). Zero cloud models enter product or trading inference.
2. **Disjoint Frozen Corpus & Off-Cycle Guard:** `buildFrozenTradingCorpus` splits historical cycles chronologically (`67%` `evolve`, `33%` `holdout` by `cycle_id`), `assertNoHoldoutLeak` rejects holdout token leaks inside `SIM`, and `isTradingPipelineBusy` fails closed when `pipeline_state` is busy or unreadable.
3. **Shadow-Capped Live Safety:** Unpromoted per-family stacks and candidate interlocks never alter live `/vllm-shim` traffic (`allowUnpromotedFamily: false` on live turns; `evaluateHoldoutAndPromote` requires strictly positive blind holdout delta, `holdoutCount >= minHoldoutCases`, and caps automatic promotion at `shadow`).
4. **Canonical Tool Schema Sync (`M10`):** `schedule_research` in `tool_schemas/trading/research-scheduling.json` declares `non_earnings` (`boolean`) in lockstep with `trading-service/app/tools/research_tools.py`.
