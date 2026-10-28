---
part: Tools and shared services
status: verified
type: spec
updated: 2026-10-28
review-by: 2026-11-28
---
# Trading Tool Schema & Hallucinated Alias Audit (2026-10-28)

## Problem & Evidence

During the 18-agent and 41-tool audit across `trading-service`, `lazy-agent-service`, and `trading-client` (`.agents/AUDIT-agent-by-agent-2026-10-28.md`), two harness-side issues were identified:

1. **Strategy Chat Order Execution Schema (`trading-execution.json`)**:
   - `buy_stock` and `sell_stock` required `quantity` (integer shares) with no `amount_usd` option, preventing `user_chat` from executing dollar-amount order intents (`"buy $2,000 of NVDA"`) via `place_chat_order`.
2. **Hallucinated Tool Name Aliases (`ToolRunner.ts`)**:
   - `v3_quant_analyst` and `research_worker` occasionally emitted legacy/hallucinated tool names (`query_market_screener`, `get_sec_filings`, `query_sec_filing`), causing tool-not-found errors when those aliases were not mapped to canonical registered tools.

## Changes

1. **`tool_schemas/trading/trading-execution.json`**:
   - Added optional `amount_usd` (`number`) and made `quantity` optional on `buy_stock` and `sell_stock` so either share count or USD notional can be supplied.
2. **`src/core/loop/ToolRunner.ts`**:
   - Added `HALLUCINATED_TOOL_ALIASES` mapping (`query_market_screener -> screener_query`, `get_sec_filings -> get_institutional_holdings`, `query_sec_filing -> get_earnings_data`) and `resolveToolName()` before tool lookup and execution.
3. **`src/core/loop/__tests__/ToolRunner.test.ts`**:
   - Added unit test verifying hallucinated tool names resolve to canonical tools when the canonical tool is registered in `ctx.tools`.
