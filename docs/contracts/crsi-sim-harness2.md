# Self-Improvement Memory (SIM) & Harness2 Interlock Contract

## Scope

Implements problem-indexed Self-Improvement Memory (`SimStore`), per-`(agent_name, modelFamily)` opening tool stacks (`TradingToolStacks`), and `PromotionController`-gated `/vllm-shim` interlocks (`TradingToolProtocol` + `VllmShimService`) across local DeepSeek endpoints (`gold-spark` `10.0.0.141:8000`, `dell2` `10.0.0.37:8888`, `dell1` `10.0.0.131:8888`).

(`CrossModelCrsiService` and `POST /harness2/crsi/selftest` were retired in favor of the linear trading harness in `linear-trading-desk-v1.md`.)

## Hard Invariants

1. **100% Local Inference:** Every model slug is resolved dynamically at call time via `GET /v1/models` (`discoverLiveEndpointTarget`). Zero cloud models enter product or trading inference.
2. **Shadow-Capped Live Safety:** Unpromoted per-family stacks and candidate interlocks never alter live `/vllm-shim` traffic (`allowUnpromotedFamily: false` on live turns; promotion remains shadow-capped).
3. **Canonical Tool Schema Sync (`M10`):** `schedule_research` in `tool_schemas/trading/research-scheduling.json` declares `non_earnings` (`boolean`) in lockstep with `trading-service/app/tools/research_tools.py`.
