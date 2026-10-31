# CRAP report (2026-10-31T05:25:56.960Z)

Functions analysed: **5189** · coverage measured: 5189 · no coverage file entry: 0

Thresholds: cx > 30 (max 0 functions), CRAP > 60 (max 3 functions)
Over cx: **0** · over CRAP: **0**

| CRAP | cx | cov | stmts | lines | file:line | function |
|---|---|---|---|---|---|---|
| 57.5 | 10 | 0.22 | 9/41 | 140 | src/services/harnesses/BaseAgenticHarness.ts:176 | checkAndApplyToolSetChanges |
| 57.3 | 8 | 0.083 | 1/12 | 17 | src/utils/SseUtilities.ts:265 | anonymous |
| 56 | 7 | 0 | 0/14 | 64 | src/core/chat/ChatGeneration.ts:1356 | executeAuthorizedChatToolCall |
| 56 | 7 | 0 | 0/22 | 30 | src/core/loop/RunawayStreamWatch.ts:152 | checkUniqueWindowRatio |
| 56 | 7 | 0 | 0/18 | 52 | src/providers/anthropic.ts:138 | convertDataUrlToAnthropicBlock |
| 56 | 7 | 0 | 0/9 | 16 | src/providers/anthropic.ts:191 | buildAnthropicMediaMessage |
| 56 | 7 | 0 | 0/6 | 17 | src/providers/anthropic.ts:234 | buildAssistantThinkingOnlyMessage |
| 56 | 7 | 0 | 0/18 | 63 | src/providers/lm-studio.ts:1545 | lmStudioCaptionImage |
| 56 | 7 | 0 | 0/7 | 36 | src/providers/ollama.ts:365 | mapOllamaModelEntry |
| 56 | 7 | 0 | 0/16 | 48 | src/providers/vllm.ts:256 | vllmCaptionImage |
| 56 | 7 | 0 | 0/10 | 21 | src/routes/AgentMemoriesRoutes.ts:65 | anonymous |
| 56 | 7 | 0 | 0/13 | 26 | src/routes/SettingsRoutes.ts:35 | anonymous |
| 56 | 7 | 0 | 0/13 | 30 | src/routes/admin/AdminConversationRoutes.ts:676 | anonymous |
| 56 | 7 | 0 | 0/13 | 23 | src/services/GlobalCapabilityExecutor.ts:623 | executeGroup |
| 56 | 7 | 0 | 0/10 | 25 | src/services/ScheduledTaskService.ts:627 | listTasks |
| 56 | 7 | 0 | 0/3 | 10 | src/services/harnesses/BaseAgenticHarness.ts:221 | anonymous |
| 56 | 7 | 0 | 0/2 | 37 | src/services/harnesses/lifecycle/Finalizer.ts:806 | buildFinalAssistantPayload |
| 56 | 7 | 0 | 0/13 | 61 | src/services/local-provider/index.ts:479 | anonymous |
| 56 | 7 | 0 | 0/9 | 18 | src/services/orchestrator/SubAgentFallback.ts:3 | getSubAgentFallback |
| 56 | 7 | 0 | 0/12 | 20 | src/services/personas/utils.ts:46 | extractDomainKeywords |
| 56 | 7 | 0 | 0/39 | 125 | src/utils/media.ts:167 | compressGifWithFfmpeg |
| 56 | 7 | 0 | 0/25 | 67 | src/utils/media.ts:297 | compressWithSharp |
| 55.9 | 9 | 0.167 | 3/18 | 29 | src/providers/anthropic.ts:100 | enforceImageSizeLimits |
| 54.7 | 12 | 0.333 | 7/21 | 37 | src/providers/anthropic.ts:617 | applyAnthropicThinking |
| 48.3 | 12 | 0.368 | 7/19 | 39 | src/services/harnesses/lifecycle/Finalizer.ts:186 | calculateFinalizerCostAndSpeed |