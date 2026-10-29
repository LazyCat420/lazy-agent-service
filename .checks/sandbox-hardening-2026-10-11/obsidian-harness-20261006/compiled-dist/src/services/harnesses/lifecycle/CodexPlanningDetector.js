import logger from "../../../utils/logger.js";
import PromptLocaleService from "../../PromptLocaleService.js";
/**
 * Check if a text-only pass from a Codex model should trigger a
 * continuation prompt instead of breaking the loop.
 *
 * Returns `{ shouldContinueLoop: true }` when a continuation prompt
 * was injected; the harness should `continue` instead of `break`.
 * Returns `{ shouldContinueLoop: false }` when no intervention is needed.
 */
export function handleCodexPlanningResponse(pass, currentMessages, context, state, availableTools, harnessLabel) {
    const isCodexModel = context.resolvedModel
        ?.toLowerCase()
        .includes("codex");
    const hasToolsAvailable = availableTools && availableTools.length > 0;
    if (!isCodexModel || !hasToolsAvailable) {
        return { shouldContinueLoop: false };
    }
    const lastMessage = currentMessages[currentMessages.length - 1];
    const isAlreadyPrompted = lastMessage &&
        lastMessage.role === "system" &&
        typeof lastMessage.content === "string" &&
        lastMessage.content.includes("If you have fully completed");
    if (isAlreadyPrompted) {
        return { shouldContinueLoop: false };
    }
    logger.info(`[${harnessLabel}] Codex model planning/update detected in iteration ${state.iterations}. Continuing to action phase.`);
    currentMessages.push({
        role: "assistant",
        content: pass.streamedText,
        ...(pass.streamedThinking.trim() && {
            thinking: pass.streamedThinking.trim(),
        }),
    });
    currentMessages.push({
        role: "system",
        content: PromptLocaleService.get(context.options?.locale || PromptLocaleService.getDefaultLocale(), "harness.codexPlanningDetector.continuePrompt"),
    });
    return { shouldContinueLoop: true };
}
//# sourceMappingURL=CodexPlanningDetector.js.map