import AgentHooks from "../../AgentHooks.js";
import AutoApprovalEngine from "../../AutoApprovalEngine.js";
import SystemPromptAssembler from "../../system-prompt/index.js";
import MemoryExtractor from "../../MemoryExtractor.js";
import ConversationEmbeddingService from "../../ConversationEmbeddingService.js";
import WorkflowMemoryService from "../../WorkflowMemoryService.js";
import CriticGate from "./CriticGate.js";
/** Create a fully wired AgentHooks instance with standard lifecycle hooks. */
export function createStandardHooks({ workspaceRoot, autoApprove = false, policies, enableCriticGate = false, criticModel, } = {}) {
    const hooks = new AgentHooks();
    // CriticGate: registered first as a 'decide' hook so it short-circuits
    // before AutoApprovalEngine if the critic denies a dangerous tool call.
    if (enableCriticGate) {
        const criticGate = new CriticGate({ model: criticModel });
        hooks.register("beforeToolCall", criticGate.createHook(), "CriticGate", "decide");
    }
    const approvalEngine = new AutoApprovalEngine({
        fullAuto: autoApprove === true,
        policies: policies || [],
    });
    hooks.register("beforeToolCall", approvalEngine.createHook(), "AutoApprovalEngine", "decide");
    const assembler = new SystemPromptAssembler({
        workspaceRoot: workspaceRoot || undefined,
    });
    hooks.register("beforePrompt", assembler.createHook(), "SystemPromptAssembler", "transform");
    hooks.register("afterResponse", MemoryExtractor.createHook(), "MemoryExtractor", "inspect");
    hooks.register("afterResponse", ConversationEmbeddingService.createHook(), "ConversationEmbedding", "inspect");
    hooks.register("afterResponse", WorkflowMemoryService.createHook(), "WorkflowMemory", "inspect");
    return { hooks, approvalEngine, assembler };
}
//# sourceMappingURL=HookInitializer.js.map