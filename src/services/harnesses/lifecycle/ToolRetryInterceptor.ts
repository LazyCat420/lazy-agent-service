import logger from "../../../utils/logger.ts";
import PromptLocaleService from "../../PromptLocaleService.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { Span } from "../../../platform/trace/Span.ts";
import { TraceExporter } from "../../../platform/trace/TraceExporter.ts";
import crypto from "node:crypto";

import type AgenticLoopState from "../../AgenticLoopState.ts";
import type {
  ToolCall,
  ToolResult,
  ConversationMessage,
  EmitFunction,
} from "../types.ts";

/**
 * ToolRetryInterceptor — structured retry guidance on tool failure.
 *
 * Based on the Fission-GRPO pattern ("Robust Tool Use via Fission-GRPO:
 * Learning to Recover from Execution Errors", arXiv 2026).
 *
 * When a tool call returns an error, instead of letting the model see
 * only the raw error in the tool result, this interceptor injects a
 * structured system message that:
 *   1. Identifies the failed tool and its original arguments
 *   2. Shows the specific error message
 *   3. Explicitly prompts the model to analyze which argument(s)
 *      caused the failure and retry with modified arguments
 *
 * This transforms the error recovery from "fail and hope the model
 * figures it out" to "fail smart with structured retry guidance."
 *
 * The interceptor does NOT force a retry — it injects guidance into
 * the conversation context. The model's next iteration naturally
 * produces a corrected tool call (or chooses a different approach).
 */

interface ToolResultPayload {
  success?: boolean;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

interface FailedToolCallSummary {
  toolName: string;
  toolCallId: string | null;
  originalArguments: Record<string, unknown>;
  errorMessage: string;
  consecutiveFailureCount: number;
}

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
export function buildToolRetryGuidance(
  toolCalls: ToolCall[],
  results: ToolResult[],
  state: AgenticLoopState,
  maxConsecutiveErrors: number,
  locale?: string,
): ConversationMessage | null {
  const failedToolCalls: FailedToolCallSummary[] = [];

  for (const toolCall of toolCalls) {
    const matchingResult = results.find(
      (result) =>
        result.id === toolCall.id ||
        (!result.id && result.name === toolCall.name),
    );

    if (!matchingResult) continue;

    const resultPayload = matchingResult.result as ToolResultPayload | null;
    const hasError = !!resultPayload?.error;

    if (!hasError) continue;

    const consecutiveFailureCount =
      state.toolErrorCounts.get(toolCall.name) || 0;

    // Skip tools that have already hit the circuit breaker — trackToolErrors
    // already handles those with a "skipping" warning
    if (consecutiveFailureCount >= maxConsecutiveErrors) continue;

    failedToolCalls.push({
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      originalArguments: toolCall.args,
      errorMessage:
        resultPayload?.error || resultPayload?.message || "Unknown error",
      consecutiveFailureCount,
    });
  }

  if (failedToolCalls.length === 0) return null;

  try {
    for (const failed of failedToolCalls) {
      const span = new Span({
        trace_id: crypto.randomUUID().replaceAll("-", "").slice(0, 32),
        run_id: "retry_run",
        name: `workflow_retry:${failed.toolName}`,
        kind: "retry",
        attributes: {
          tool_name: failed.toolName,
          error_message: failed.errorMessage,
          attempt: failed.consecutiveFailureCount,
        },
      });
      span.end("OK");
      TraceExporter.getGlobalInstance().enqueueSpan(span.toJSON());
    }
  } catch {
    // non-blocking
  }

  const activeLocale = locale || PromptLocaleService.getDefaultLocale();

  const retryGuidanceBlocks = failedToolCalls
    .map((failedToolCall) => {
      const argumentSummary = formatArgumentSummary(
        failedToolCall.originalArguments,
      );
      const attemptLabel =
        failedToolCall.consecutiveFailureCount > 1
          ? ` ${PromptLocaleService.get(activeLocale, "harness.retryLabels.attemptLabel", { attemptCount: String(failedToolCall.consecutiveFailureCount) })}`
          : "";

      return (
        `### \`${failedToolCall.toolName}\`${attemptLabel}\n` +
        `${PromptLocaleService.get(activeLocale, "harness.retryLabels.errorLabel", { errorMessage: failedToolCall.errorMessage })}\n` +
        `${PromptLocaleService.get(activeLocale, "harness.retryLabels.originalArguments")}\n${argumentSummary}`
      );
    })
    .join("\n\n");

  const headerText = PromptLocaleService.get(activeLocale, "harness.toolRetryGuidance.header", {
    count: String(failedToolCalls.length),
  });
  const analyzeSteps = PromptLocaleService.get(activeLocale, "harness.toolRetryGuidance.analyzeSteps");

  const retryMessage: ConversationMessage = {
    role: "system",
    content:
      `${headerText}\n\n` +
      `${retryGuidanceBlocks}\n\n` +
      analyzeSteps,
  };

  logger.info(
    `[ToolRetryInterceptor] Injected structured retry guidance for ${failedToolCalls.length} failed tool call(s): ` +
      `[${failedToolCalls.map((failedToolCall) => `${failedToolCall.toolName}(attempt:${failedToolCall.consecutiveFailureCount})`).join(", ")}]`,
  );

  return retryMessage;
}

/**
 * Format tool arguments into a readable summary for the retry prompt.
 * Truncates large values to keep the prompt compact.
 */
function formatArgumentSummary(
  originalArguments: Record<string, unknown>,
): string {
  const argumentEntries = Object.entries(originalArguments);

  if (argumentEntries.length === 0) return "  (no arguments)\n";

  return (
    argumentEntries
      .map(([key, value]) => {
        const stringifiedValue =
          typeof value === "string" ? value : JSON.stringify(value);
        const truncatedValue =
          stringifiedValue.length > 200
            ? `${stringifiedValue.slice(0, 200)}…`
            : stringifiedValue;
        return `  - \`${key}\`: ${truncatedValue}`;
      })
      .join("\n") + "\n"
  );
}
