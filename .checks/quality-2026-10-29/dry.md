# Duplication report (2026-10-29T23:53:12.905Z)

jscpd, min-tokens 60

| scan | duplicated % | duplicated lines | total lines | clones |
|---|---|---|---|---|
| logic | 2.3175438435657907% | 2528 | 109081 | 180 |
| all | 2.647071687879981% | 3026 | 114315 | 206 |

## Top logic clones

| tokens | lines | first | second |
|---|---|---|---|
| 249 | 46 | core/loop/AgentRouteAdapter.ts:461 | core/loop/RunsAdapter.ts:317 |
| 190 | 35 | routes/TextRoutes.ts:54 | routes/admin/AdminContentRoutes.ts:397 |
| 172 | 25 | routes/admin/AdminStatsRoutes.ts:31 | routes/admin/AdminTraceRoutes.ts:34 |
| 161 | 21 | providers/lm-studio.ts:303 | utils/openai-compat.ts:1107 |
| 161 | 37 | services/harnesses/strategies/GraphOfThoughtsStrategy.ts:24 | services/harnesses/strategies/TreeOfThoughtsStrategy.ts:47 |
| 144 | 29 | providers/llama-cpp.ts:397 | providers/lm-studio.ts:1556 |
| 140 | 27 | routes/WorkspacesRoutes.ts:387 | routes/WorkspacesRoutes.ts:463 |
| 140 | 20 | routes/admin/AdminConversationRoutes.ts:393 | routes/admin/AdminConversationRoutes.ts:447 |
| 138 | 18 | services/harnesses/ReActHarness.ts:370 | services/harnesses/VisionLanguageHarness.ts:200 |
| 135 | 26 | routes/WorkflowsRoutes.ts:89 | routes/WorkflowsRoutes.ts:170 |