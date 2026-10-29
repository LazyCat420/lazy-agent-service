# CRAP report (2026-10-29T22:00:04.617Z)

Functions analysed: **4715** · coverage measured: 4715 · no coverage file entry: 0

Thresholds: cx > 30, CRAP > 60
Over cx: **19** · over CRAP: **374**

| CRAP | cx | cov | stmts | lines | file:line | function |
|---|---|---|---|---|---|---|
| 8372 | 91 | 0 | 0/130 | 372 | src/providers/anthropic.ts:767 | generateTextStream |
| 5112 | 71 | 0 | 0/123 | 301 | src/providers/openai.ts:1118 | _streamResponses |
| 3540 | 59 | 0 | 0/111 | 339 | src/services/MemoryConsolidationService.ts:340 | consolidate |
| 3080 | 55 | 0 | 0/100 | 226 | src/providers/openai.ts:1419 | _streamChatCompletions |
| 2550 | 50 | 0 | 0/61 | 228 | src/routes/AudioRoutes.ts:385 | anonymous |
| 2256 | 47 | 0 | 0/134 | 323 | src/providers/google.ts:688 | generateTextStreamLive |
| 1806 | 42 | 0 | 0/65 | 131 | src/providers/google.ts:549 | generateTextStream |
| 1722 | 41 | 0 | 0/75 | 190 | src/providers/openai.ts:753 | _generateTextResponses |
| 1640 | 40 | 0 | 0/60 | 150 | src/providers/anthropic.ts:538 | generateText |
| 1122 | 33 | 0 | 0/46 | 115 | src/services/ScheduledTaskService.ts:147 | tick |
| 1056 | 32 | 0 | 0/22 | 99 | src/providers/llama-cpp.ts:569 | getServerProps |
| 1056 | 32 | 0 | 0/64 | 149 | src/providers/openai.ts:943 | _generateTextChatCompletions |
| 992 | 31 | 0 | 0/120 | 310 | src/routes/admin/AdminConversationRoutes.ts:37 | anonymous |
| 870 | 29 | 0 | 0/39 | 185 | src/routes/ChatRoutes.ts:955 | handleImageAPIModel |
| 870 | 29 | 0 | 0/64 | 141 | src/services/ToolOrchestratorService.ts:2196 | executeToolStreaming |
| 812 | 28 | 0 | 0/43 | 69 | src/providers/google.ts:249 | buildGenerateConfig |
| 812 | 28 | 0 | 0/81 | 128 | src/routes/LmStudioRoutes.ts:111 | anonymous |
| 812 | 28 | 0 | 0/41 | 149 | src/services/MemoryConsolidationService.ts:184 | processBatch |
| 812 | 28 | 0 | 0/25 | 81 | src/services/orchestrator/SubAgentResultBuilder.ts:64 | buildSubAgentResult |
| 756 | 27 | 0 | 0/46 | 117 | src/providers/google.ts:319 | convertMessages |
| 756 | 27 | 0 | 0/35 | 108 | src/providers/google.ts:440 | generateText |
| 756 | 27 | 0 | 0/78 | 189 | src/services/harnesses/strategies/TreeOfThoughtsStrategy.ts:885 | runTreeOfThoughts |
| 749.7 | 36 | 0.18 | 11/61 | 157 | src/routes/PlatformRoutes.ts:130 | anonymous |
| 702 | 26 | 0 | 0/45 | 94 | src/services/LocalToolRouter.ts:225 | routeStrainTool |
| 702 | 26 | 0 | 0/28 | 95 | src/services/MemoryConsolidationService.ts:83 | applyActions |