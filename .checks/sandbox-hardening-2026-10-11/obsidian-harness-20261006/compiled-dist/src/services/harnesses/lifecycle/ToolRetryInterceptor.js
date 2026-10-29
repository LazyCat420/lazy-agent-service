import logger from "../../../utils/logger.js";
import PromptLocaleService from "../../PromptLocaleService.js";
import { Span } from "../../../platform/trace/Span.js";
import { TraceExporter } from "../../../platform/trace/TraceExporter.js";
import { TraceContext } from "../../../platform/trace/TraceContext.js";
import crypto from "node:crypto";
/**
 * Inspect tool results for failures and build structured retry
 * guidance for the model. Returns the system message to inject,
 * or null if no retry guidance is needed.
 *
 * Retry guidance is injected when:
 *   - At least one tool call returned an error
 *   - The tool has NOT yet hit the circuit breaker limit
 *     (once a tool hits MAX_CONSECUTIVE_TOOL_ERRORS, the existing
 *      trackToolErrors handler already emits a skip warning)
 */
export function buildToolRetryGuidance(toolCalls, results, state, maxConsecutiveErrors, locale) {
    const failedToolCalls = [];
    for (const toolCall of toolCalls) {
        const matchingResult = results.find((result) => result.id === toolCall.id ||
            (!result.id && result.name === toolCall.name));
        if (!matchingResult)
            continue;
        const resultPayload = matchingResult.result;
        const hasError = !!resultPayload?.error;
        if (!hasError)
            continue;
        const consecutiveFailureCount = state.toolErrorCounts.get(toolCall.name) || 0;
        // Skip tools that have already hit the circuit breaker — trackToolErrors
        // already handles those with a "skipping" warning
        if (consecutiveFailureCount >= maxConsecutiveErrors)
            continue;
        failedToolCalls.push({
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            originalArguments: toolCall.args,
            errorMessage: resultPayload?.error || resultPayload?.message || "Unknown error",
            consecutiveFailureCount,
        });
    }
    if (failedToolCalls.length === 0)
        return null;
    try {
        const activeCtx = TraceContext.get();
        for (const failed of failedToolCalls) {
            const span = new Span({
                trace_id: activeCtx?.trace_id || crypto.randomUUID().replaceAll("-", "").slice(0, 32),
                parent_span_id: activeCtx?.current_span_id || activeCtx?.currentSpan?.span_id || null,
                run_id: activeCtx?.run_id || "retry_run",
                name: `workflow_retry:${failed.toolName}`,
                kind: "retry",
                attributes: {
                    tool_name: failed.toolName,
                    error_message: failed.errorMessage,
                    attempt: failed.consecutiveFailureCount,
                    failed_attempt: failed.consecutiveFailureCount,
                    failed_tool_call_id: failed.toolCallId,
                    failure_span_id: activeCtx?.current_span_id || activeCtx?.currentSpan?.span_id || null,
                },
            });
            span.end("OK");
            TraceExporter.getGlobalInstance().enqueueSpan(span.toJSON());
        }
    }
    catch {
        // non-blocking
    }
    const activeLocale = locale || PromptLocaleService.getDefaultLocale();
    const retryGuidanceBlocks = failedToolCalls
        .map((failedToolCall) => {
        const argumentSummary = formatArgumentSummary(failedToolCall.originalArguments);
        const attemptLabel = failedToolCall.consecutiveFailureCount > 1
            ? ` ${PromptLocaleService.get(activeLocale, "harness.retryLabels.attemptLabel", { attemptCount: String(failedToolCall.consecutiveFailureCount) })}`
            : "";
        return (`### \`${failedToolCall.toolName}\`${attemptLabel}\n` +
            `${PromptLocaleService.get(activeLocale, "harness.retryLabels.errorLabel", { errorMessage: failedToolCall.errorMessage })}\n` +
            `${PromptLocaleService.get(activeLocale, "harness.retryLabels.originalArguments")}\n${argumentSummary}`);
    })
        .join("\n\n");
    const headerText = PromptLocaleService.get(activeLocale, "harness.toolRetryGuidance.header", {
        count: String(failedToolCalls.length),
    });
    const analyzeSteps = PromptLocaleService.get(activeLocale, "harness.toolRetryGuidance.analyzeSteps");
    const retryMessage = {
        role: "system",
        content: `${headerText}\n\n` +
            `${retryGuidanceBlocks}\n\n` +
            analyzeSteps,
    };
    logger.info(`[ToolRetryInterceptor] Injected structured retry guidance for ${failedToolCalls.length} failed tool call(s): ` +
        `[${failedToolCalls.map((failedToolCall) => `${failedToolCall.toolName}(attempt:${failedToolCall.consecutiveFailureCount})`).join(", ")}]`);
    return retryMessage;
}
/**
 * Format tool arguments into a readable summary for the retry prompt.
 * Truncates large values to keep the prompt compact.
 */
function formatArgumentSummary(originalArguments) {
    const argumentEntries = Object.entries(originalArguments);
    if (argumentEntries.length === 0)
        return "  (no arguments)\n";
    return (argumentEntries
        .map(([key, value]) => {
        const stringifiedValue = typeof value === "string" ? value : JSON.stringify(value);
        const truncatedValue = stringifiedValue.length > 200
            ? `${stringifiedValue.slice(0, 200)}…`
            : stringifiedValue;
        return `  - \`${key}\`: ${truncatedValue}`;
    })
        .join("\n") + "\n");
}
//# sourceMappingURL=ToolRetryInterceptor.js.map