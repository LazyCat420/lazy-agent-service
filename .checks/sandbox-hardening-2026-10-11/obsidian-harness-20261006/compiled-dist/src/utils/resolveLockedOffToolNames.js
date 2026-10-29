import SettingsService from "../services/SettingsService.js";
import ToolOrchestratorService from "../services/ToolOrchestratorService.js";
import { TOOL_NAMES, DOMAINS, } from "@rodrigo-barraza/utilities-library/taxonomy";
/**
 * Resolves tool names that should be excluded from the system prompt
 * and tool count because their prerequisites are not met.
 *
 * This is the server-side equivalent of the client's `lockedOffTools` useMemo
 * in ChatSessionComponent, ensuring both the system prompt "Enabled Tools (N)"
 * count and the sidebar tool count agree.
 *
 * Checks:
 *   - Memory models (extraction, consolidation, embedding)
 *   - Image/vision models
 *   - TTS/STT models
 *   - Workspace agent connectivity (mirrors client isAgentServed check)
 */
export async function resolveLockedOffToolNames() {
    const lockedOff = new Set();
    const memorySettings = await SettingsService.getSection("memory");
    const creativeSettings = await SettingsService.getSection("creative");
    const hasExtraction = Boolean(memorySettings?.extractionProvider && memorySettings?.extractionModel);
    const hasConsolidation = Boolean(memorySettings?.consolidationProvider && memorySettings?.consolidationModel);
    const hasEmbedding = Boolean(memorySettings?.embeddingProvider && memorySettings?.embeddingModel);
    const hasAllMemoryModels = hasExtraction && hasConsolidation && hasEmbedding;
    if (!hasAllMemoryModels)
        lockedOff.add(TOOL_NAMES.SAVE_MEMORY);
    if (!hasExtraction)
        lockedOff.add(TOOL_NAMES.EXTRACT_MEMORIES);
    if (!hasConsolidation)
        lockedOff.add(TOOL_NAMES.CONSOLIDATE_MEMORIES);
    if (!hasEmbedding)
        lockedOff.add(TOOL_NAMES.SEARCH_MEMORIES);
    const hasImageModel = Boolean(creativeSettings?.imageProvider && creativeSettings?.imageModel);
    const hasVisionModel = Boolean(creativeSettings?.visionProvider && (creativeSettings?.visionModel || creativeSettings?.visionProvider.startsWith("vllm")));
    const hasTextToSpeech = Boolean(creativeSettings?.textToSpeechProvider &&
        creativeSettings?.textToSpeechModel);
    const hasSpeechToText = Boolean(creativeSettings?.speechToTextProvider &&
        creativeSettings?.speechToTextModel);
    if (!hasImageModel)
        lockedOff.add(TOOL_NAMES.GENERATE_IMAGE);
    if (!hasVisionModel)
        lockedOff.add(TOOL_NAMES.DESCRIBE_IMAGE);
    if (!hasTextToSpeech)
        lockedOff.add(TOOL_NAMES.SYNTHESIZE_SPEECH);
    if (!hasSpeechToText)
        lockedOff.add(TOOL_NAMES.TRANSCRIBE_AUDIO);
    // Workspace agent connectivity — mirrors the client's isAgentServed check.
    // If no workspace agent is connected, lock off all workspace-domain tools
    // (the same set the client locks off when currentWorkspace.isAgentServed is false).
    const isWorkspaceAgentConnected = await ToolOrchestratorService.isWorkspaceAgentConnected();
    if (!isWorkspaceAgentConnected) {
        const allSchemas = ToolOrchestratorService.getClientToolSchemas();
        for (const tool of allSchemas) {
            const isWorkspaceTool = tool.domain === DOMAINS.CORE_WORKSPACE.displayName ||
                tool.domainKey === DOMAINS.CORE_WORKSPACE.key ||
                tool.name === TOOL_NAMES.ENTER_WORKTREE ||
                tool.name === TOOL_NAMES.EXIT_WORKTREE;
            if (isWorkspaceTool) {
                lockedOff.add(tool.name);
            }
        }
    }
    return lockedOff;
}
//# sourceMappingURL=resolveLockedOffToolNames.js.map