import logger from "../../../utils/logger.js";
import { SERVER_SENT_EVENT_TYPES, STATUS_MESSAGES, } from "@rodrigo-barraza/utilities-library/taxonomy";
import { extractReminderViaLLM } from "./SystemReminderExtractor.js";
import PromptLocaleService from "../../PromptLocaleService.js";
/**
 * SystemReminderInjector — counteracts instruction fade-out in long sessions.
 *
 * Based on OPENDEV (arXiv 2603.05344) "Event-Driven System Reminders":
 * as agentic sessions grow beyond ~10 iterations, the model's adherence
 * to system-level constraints degrades because the system prompt recedes
 * into the context window's distant prefix. This is the "instruction
 * fade-out" effect documented across all major LLM providers.
 *
 * This module uses the SystemReminderExtractor (LLM-based distillation)
 * to produce a condensed (~300 token) behavioral summary on the first
 * reminder trigger. Subsequent injections reuse the cached summary.
 *
 * Feature gating: if `options.reminderModel` is not set, the entire
 * feature is disabled — no extraction, no injection.
 */
const DEFAULT_REMINDER_INTERVAL = 8;
const MINIMUM_ITERATIONS_BEFORE_FIRST_REMINDER = 5;
const cachedReminderContent = new Map();
/**
 * Check whether a system reminder should be injected on this iteration.
 * If so, extract (or re-use cached) constraints and inject them.
 *
 * Feature is disabled when `options.reminderModel` is not configured.
 *
 * Call this at the start of each iteration, after incrementing
 * `state.iterations` but before building the provider stream.
 */
export async function maybeInjectSystemReminder(currentMessages, state, context) {
    const { options, emit, provider, signal } = context;
    const agentConversationId = context.agentConversationId || "";
    // Feature gate: disabled when no reminder model is configured
    const reminderModel = options.reminderModel;
    if (!reminderModel)
        return;
    const resolvedInterval = options.reminderInterval || DEFAULT_REMINDER_INTERVAL;
    const currentIteration = state.iterations;
    if (currentIteration < MINIMUM_ITERATIONS_BEFORE_FIRST_REMINDER)
        return;
    if (currentIteration % resolvedInterval !== 0)
        return;
    let reminderContent = cachedReminderContent.get(agentConversationId);
    if (!reminderContent) {
        const systemMessage = currentMessages.find((message) => message.role === "system" &&
            typeof message.content === "string" &&
            message.content.length > 200);
        if (!systemMessage || typeof systemMessage.content !== "string")
            return;
        reminderContent = await extractReminderViaLLM(systemMessage.content, provider, reminderModel, signal || undefined, {
            project: context.project,
            username: context.username,
            agent: context.agent || null,
            providerName: context.providerName,
            traceId: context.traceId || null,
            conversationId: context.conversationId || null,
            agentConversationId: context.agentConversationId || null,
            requestId: context.requestId,
        }) || undefined;
        if (!reminderContent)
            return;
        cachedReminderContent.set(agentConversationId, reminderContent);
    }
    const activeLocale = context.options?.locale || PromptLocaleService.getDefaultLocale();
    currentMessages.push({
        role: "system",
        content: PromptLocaleService.get(activeLocale, "harness.systemReminder.header", { currentIteration: String(currentIteration) }) + `\n` +
            PromptLocaleService.get(activeLocale, "harness.systemReminder.preamble") + `\n\n` +
            `${reminderContent}\n\n` +
            PromptLocaleService.get(activeLocale, "harness.systemReminder.footer"),
    });
    emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.SYSTEM_REMINDER_INJECTED,
        iteration: currentIteration,
        interval: resolvedInterval,
    });
    logger.info(`[SystemReminderInjector] Injected system reminder on iteration ${currentIteration} ` +
        `(interval: ${resolvedInterval}, model: ${reminderModel}, ${reminderContent.length} chars)`);
}
/**
 * Clean up cached reminder content for a session.
 * Call during session teardown to prevent memory leaks.
 */
export function cleanupReminderCache(agentConversationId) {
    cachedReminderContent.delete(agentConversationId);
}
//# sourceMappingURL=SystemReminderInjector.js.map