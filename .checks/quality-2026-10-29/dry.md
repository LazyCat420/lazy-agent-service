# Duplication report (2026-10-29T23:31:08.398Z)

jscpd, min-tokens 60

| scan | duplicated % | duplicated lines | total lines | clones |
|---|---|---|---|---|
| logic | 2.612294560638602% | 2834 | 108487 | 191 |
| all | 2.929977752569886% | 3332 | 113721 | 217 |

## Top logic clones

| tokens | lines | first | second |
|---|---|---|---|
| 315 | 64 | providers/openai.ts:803 | providers/openai.ts:1168 |
| 249 | 46 | core/loop/AgentRouteAdapter.ts:461 | core/loop/RunsAdapter.ts:317 |
| 208 | 40 | providers/anthropic.ts:546 | providers/anthropic.ts:775 |
| 201 | 40 | providers/openai.ts:764 | providers/openai.ts:1129 |
| 200 | 42 | providers/openai.ts:826 | providers/openai.ts:1191 |
| 190 | 35 | routes/TextRoutes.ts:54 | routes/admin/AdminContentRoutes.ts:397 |
| 172 | 25 | routes/admin/AdminStatsRoutes.ts:31 | routes/admin/AdminTraceRoutes.ts:34 |
| 161 | 21 | providers/lm-studio.ts:303 | utils/openai-compat.ts:1107 |
| 161 | 37 | services/harnesses/strategies/GraphOfThoughtsStrategy.ts:24 | services/harnesses/strategies/TreeOfThoughtsStrategy.ts:47 |
| 144 | 29 | providers/llama-cpp.ts:397 | providers/lm-studio.ts:1556 |