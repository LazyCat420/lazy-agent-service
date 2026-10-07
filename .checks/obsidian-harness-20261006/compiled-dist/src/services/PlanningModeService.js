import logger from "../utils/logger.js";
import PromptLocaleService from "./PromptLocaleService.js";
import SettingsService from "./SettingsService.js";
/**
 * Planning instruction injected as a separate message when planFirst=true.
 * Mirrors Claude Code's plan mode: the model explores and designs first,
 * then calls exit_plan_mode to present its plan for approval.
 *
 * CACHE-STABILITY NOTE: This is injected as a standalone message AFTER the
 * system prompt, not appended to it. This preserves the system prompt's
 * content hash across iterations, enabling prefix caching on Anthropic,
 * Gemini context caching, and OpenAI cached prompts.
 */
/**
 * PlanningModeService — implements the "Plan First" workflow using
 * Claude Code's tool-based state machine pattern.
 *
 * When planFirst=true:
 * 1. Loop starts with planModeActive=true (tools stripped)
 * 2. Planning instruction injected as a separate message (cache-stable)
 * 3. Model outputs plan text, then calls exit_plan_mode
 * 4. exit_plan_mode triggers plan_proposal + approval gate
 * 5. Approved plan echoed as tool result → model continues with full tools
 */
export default class PlanningModeService {
    /**
     * Inject the planning instruction as a separate message after the system prompt.
     *
     * Uses a dedicated message with `_isPlanningInjection: true` marker instead
     * of mutating the system message content. This preserves prefix cache
     * stability across all major providers (Anthropic, Gemini, OpenAI).
     */
    static async injectPlanningInstruction(messages, requestLocale) {
        // Idempotency: don't inject twice
        if (messages.some((message) => message._isPlanningInjection === true)) {
            return;
        }
        let locale = requestLocale;
        if (!locale) {
            const settings = await SettingsService.getSection("agents");
            locale = settings?.locale || PromptLocaleService.getDefaultLocale();
        }
        const planningInstruction = PromptLocaleService.get(locale, "harness.planningMode.planningInstruction");
        // Insert AFTER the system message but BEFORE any user messages
        const systemIndex = messages.findIndex((message) => message.role === "system");
        const insertionIndex = systemIndex >= 0 ? systemIndex + 1 : 0;
        messages.splice(insertionIndex, 0, {
            role: "user",
            content: planningInstruction,
            _isPlanningInjection: true,
        });
        logger.info("[PlanningMode] Injected planning instruction as separate message (cache-stable)");
    }
    /**
     * Strip the planning instruction message from the conversation.
     * Called when exiting plan mode so execution doesn't carry stale constraints.
     */
    static stripPlanningInstruction(messages) {
        const injectionIndex = messages.findIndex((message) => message._isPlanningInjection === true);
        if (injectionIndex >= 0) {
            messages.splice(injectionIndex, 1);
            logger.info("[PlanningMode] Stripped planning instruction message");
        }
    }
    static extractSteps(planText) {
        const stepRegex = /^\d+\.\s+(.+)$/gm;
        const steps = [];
        let match;
        while ((match = stepRegex.exec(planText)) !== null) {
            steps.push(match[1].trim());
        }
        return steps;
    }
}
//# sourceMappingURL=PlanningModeService.js.map