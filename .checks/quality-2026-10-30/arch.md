# Architecture report (2026-10-30T01:26:30.576Z)

Modules: 570 · dependencies: 2541

## error (0)


## warn (137)

- **no-circular**: src/core/loop/SpillBuffer.ts → src/core/loop/types.ts
- **no-circular**: src/providers/anthropic.ts → src/types/ProviderTypes.ts
- **no-circular**: src/providers/anthropic.ts → src/utils/openai-compat.ts
- **no-circular**: src/providers/elevenlabs.ts → src/types/ProviderTypes.ts
- **no-circular**: src/providers/google.ts → src/types/provider.ts
- **no-circular**: src/providers/google.ts → src/types/ProviderTypes.ts
- **no-circular**: src/providers/index.ts → src/providers/instance-registry.ts
- **no-circular**: src/providers/index.ts → src/providers/inworld.ts
- **no-circular**: src/providers/index.ts → src/providers/openai.ts
- **no-circular**: src/providers/index.ts → src/services/EmbeddingGemma2Client.ts
- **no-circular**: src/providers/index.ts → src/types/provider.ts
- **no-circular**: src/providers/instance-registry.ts → src/providers/llama-cpp.ts
- **no-circular**: src/providers/instance-registry.ts → src/providers/lm-studio.ts
- **no-circular**: src/providers/instance-registry.ts → src/providers/ollama.ts
- **no-circular**: src/providers/instance-registry.ts → src/providers/vllm.ts
- **no-circular**: src/providers/instance-registry.ts → src/types/ProviderTypes.ts
- **no-circular**: src/providers/llama-cpp.ts → src/types/provider.ts
- **no-circular**: src/providers/llama-cpp.ts → src/utils/openai-compat.ts
- **no-circular**: src/providers/lm-studio.ts → src/types/provider.ts
- **no-circular**: src/providers/lm-studio.ts → src/utils/openai-compat.ts
- **no-circular**: src/providers/ollama.ts → src/types/provider.ts
- **no-circular**: src/providers/ollama.ts → src/utils/openai-compat.ts
- **no-circular**: src/providers/openai.ts → src/types/ProviderTypes.ts
- **no-circular**: src/providers/openai.ts → src/utils/openai-compat.ts
- **no-circular**: src/providers/vllm.ts → src/types/provider.ts
- **no-circular**: src/providers/vllm.ts → src/utils/openai-compat.ts
- **no-circular**: src/services/AgenticLoopService.ts → src/core/loop/AgentRouteAdapter.ts
- **no-circular**: src/services/AgenticLoopService.ts → src/services/AgenticToolResolver.ts
- **no-circular**: src/services/AgenticLoopService.ts → src/services/harnesses/HarnessRegistry.ts
- **no-circular**: src/services/AgenticLoopService.ts → src/services/harnesses/lifecycle/HookInitializer.ts
- **no-circular**: src/services/AgenticLoopService.ts → src/services/OrchestratorService.ts
- **no-circular**: src/services/AgentPersonaRegistry.ts → src/services/personas/index.ts
- **no-circular**: src/services/compact/CompactionService.ts → src/services/MemoryExtractor.ts
- **no-circular**: src/services/conversation/ConversationService.ts → src/services/harnesses/types.ts
- **no-circular**: src/services/conversation/ConversationService.ts → src/services/RoleAlternation.ts
- **no-circular**: src/services/ConversationEmbeddingService.ts → src/services/AgentPersonaRegistry.ts
- **no-circular**: src/services/DelegateTool.ts → src/services/AgenticLoopService.ts
- **no-circular**: src/services/harnesses/BaseAgenticHarness.ts → src/services/harnesses/lifecycle/Finalizer.ts
- **no-circular**: src/services/harnesses/BaseAgenticHarness.ts → src/services/harnesses/lifecycle/TurnTranscript.ts
- **no-circular**: src/services/harnesses/BaseAgenticHarness.ts → src/services/OrchestratorService.ts
