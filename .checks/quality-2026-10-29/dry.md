# Duplication report (2026-10-29T22:00:05.164Z)

jscpd, min-tokens 60

| scan | duplicated % | duplicated lines | total lines | clones |
|---|---|---|---|---|
| logic | 2.9409315879550397% | 3179 | 108095 | 205 |
| all | 3.2446217108165825% | 3677 | 113326 | 231 |

## Top logic clones

| tokens | lines | first | second |
|---|---|---|---|
| 362 | 50 | routes/admin/AdminStatsRoutes.ts:37 | routes/admin/AdminTraceRoutes.ts:47 |
| 315 | 64 | providers/openai.ts:803 | providers/openai.ts:1168 |
| 249 | 46 | core/loop/AgentRouteAdapter.ts:461 | core/loop/RunsAdapter.ts:317 |
| 229 | 40 | services/harnesses/strategies/GraphOfThoughtsStrategy.ts:1054 | services/harnesses/strategies/TreeOfThoughtsStrategy.ts:1196 |
| 218 | 24 | services/harnesses/strategies/GraphOfThoughtsStrategy.ts:983 | services/harnesses/strategies/TreeOfThoughtsStrategy.ts:751 |
| 208 | 40 | providers/anthropic.ts:546 | providers/anthropic.ts:775 |
| 208 | 52 | services/harnesses/strategies/GraphOfThoughtsStrategy.ts:23 | services/harnesses/strategies/TreeOfThoughtsStrategy.ts:43 |
| 201 | 40 | providers/openai.ts:764 | providers/openai.ts:1129 |
| 200 | 42 | providers/openai.ts:826 | providers/openai.ts:1191 |
| 198 | 37 | services/harnesses/strategies/GraphOfThoughtsStrategy.ts:135 | services/harnesses/strategies/TreeOfThoughtsStrategy.ts:160 |