import { expandMessagesForFunctionCall } from "../../../utils/FunctionCallingUtilities.ts";
import ConversationGenerationTracker from "../../ConversationGenerationTracker.ts";
import PromptLocaleService from "../../PromptLocaleService.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import logger from "../../../utils/logger.ts";

import type BaseAgenticHarness from "../BaseAgenticHarness.ts";
import type AgenticLoopState from "../../AgenticLoopState.ts";
import type { AgenticContext, ConversationMessage } from "../types.ts";

/**
 * ExhaustionRecovery — handles the iteration-limit summary pass.
 *
 * When the agentic loop hits its maximum iteration count without producing
 * a final text response, this module runs one last LLM call (with no tools)
 * asking the model to summarize progress and state what remains.
 *
 * Extracted from ReActHarness to be reusable by any iterating harness.
 */

/** prism's tag for its iteration-limit notice (SystemMessageTags.ITERATION_LIMIT). */
export const ITERATION_LIMIT_TAG = "iteration-limit";

/**
 * The iteration-limit notice, tagged exactly as prism tags it
 * (`<iteration-limit>\n\n…\n\n</iteration-limit>`). The tag is what the vLLM
 * shim's TradingToolProtocol keys on to direct the forced final turn
 * (FINAL_TURN_DIRECTIVE: reply with the JSON artifact now, no tool, no prose
 * summary), and what trading's audits use to find wall turns. Untagged, our
 * final turn was never directed (boundary probe `forced_final_turn` through
 * the native loop, 2026-10-07), where prism's was.
 */
export function iterationLimitNotice(message: string): string {
  return `<${ITERATION_LIMIT_TAG}>\n\n${message}\n\n</${ITERATION_LIMIT_TAG}>`;
}

/**
 * Run a tool-free exhaustion recovery pass.
 *
 * Appends a system instruction asking for a progress summary, streams the
 * response through the harness's `consumeStream`, and updates state.
 */
export async function runExhaustionRecoveryPass(
  harness: BaseAgenticHarness,
  context: AgenticContext,
  state: AgenticLoopState,
  currentMessages: ConversationMessage[],
): Promise<void> {
  const { emit, signal, options, resolvedModel, modelDefinition, provider } =
    context;

  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.ITERATION_LIMIT_REACHED,
  });

  currentMessages.push({
    role: "system",
    content: iterationLimitNotice(PromptLocaleService.get(
      (options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale(),
      "harness.exhaustionRecovery.message",
    )),
  });

  // Same tool block as every other request of the turn — only calling is
  // off (tool_choice "none", ported from prism-service ExhaustionRecovery).
  // Dropping `tools` here rewrote the front of the prompt, so the summary
  // pass was a full prompt-cache miss.
  const enforcedMessages = harness.enforceContextWindow(
    currentMessages,
    options.tools?.length || 0,
  );
  const expandedMessages = expandMessagesForFunctionCall(enforcedMessages, {
    filterDeleted: false,
  });

  const augmentedOptions: Record<string, unknown> = {
    ...options,
    toolChoice: "none",
    project: context.project,
    agent: context.agent,
    username: context.username,
  };

  const exhaustionRequestId = `${context.requestId || context.agentConversationId}-exhaustion`;
  harness.registerTrackerRequest(exhaustionRequestId);

  const exhaustionStream =
    modelDefinition?.liveAPI && provider.generateTextStreamLive
      ? provider.generateTextStreamLive(expandedMessages, resolvedModel, {
          ...augmentedOptions,
          signal,
        })
      : provider.generateTextStream(expandedMessages, resolvedModel, {
          ...augmentedOptions,
          signal,
        });

  // Create a pass state for chunk routing through the shared processStreamChunk
  const exhaustionPass = harness.createPassState(augmentedOptions);
  exhaustionPass.requestId = exhaustionRequestId;

  // No tools in the exhaustion pass
  const emptyToolNames = new Set<string>();

  // Use the shared consumeStream — all chunk routing goes through processStreamChunk,
  // so new chunk types added to the base dispatcher are automatically handled.
  await harness.consumeStream(exhaustionStream, exhaustionPass, emptyToolNames);

  // ── Empty recovery fallback (ported from prism-service ExhaustionRecovery) ──
  // Self-hosted or low-capability models sometimes produce empty output on
  // the recovery pass. Build a synthetic fallback from the accumulated tool
  // call results so the parent orchestrator always receives actionable
  // context instead of "[No output]".
  const recoveryOutputText = (exhaustionPass.finalStreamedText || "").trim();
  if (!recoveryOutputText && state.streamedToolCalls?.length > 0) {
    logger.warn(
      `[ExhaustionRecovery] Recovery pass produced empty output after ${state.iterations} iterations. ` +
        `Building synthetic fallback from ${state.streamedToolCalls.length} tool call(s).`,
    );
    const syntheticSummary = buildSyntheticFallbackSummary(state, currentMessages);
    state.finalStreamedText = syntheticSummary;
    exhaustionPass.streamedText = syntheticSummary;
    exhaustionPass.finalStreamedText = syntheticSummary;
  }

  harness.logIteration(exhaustionPass, currentMessages);
  harness.emitGenerationProgress();
  ConversationGenerationTracker.complete(exhaustionRequestId);
}

const MAXIMUM_FALLBACK_TOOL_RESULTS = 10;
const MAXIMUM_RESULT_EXCERPT_LENGTH = 500;

/**
 * Build a structured fallback summary from the accumulated tool call history.
 * Ported from prism-service ExhaustionRecovery.buildSyntheticFallbackSummary.
 */
export function buildSyntheticFallbackSummary(
  state: AgenticLoopState,
  currentMessages: ConversationMessage[],
  headline = `[Iteration limit reached after ${state.iterations} iterations — the model did not produce a final summary. ` +
    `Below is a synthetic summary of tool activity.]`,
): string {
  const toolCalls = state.streamedToolCalls;
  const toolNameCounts = new Map<string, number>();
  for (const toolCall of toolCalls) {
    toolNameCounts.set(toolCall.name, (toolNameCounts.get(toolCall.name) || 0) + 1);
  }

  const sections: string[] = [headline];

  const toolUsageSummary = Array.from(toolNameCounts.entries())
    .map(([toolName, count]) => `  - ${toolName}: ${count} call(s)`)
    .join("\n");
  sections.push(`\nTool usage:\n${toolUsageSummary}`);

  const toolResultMessages = currentMessages.filter(
    (message) => message.role === "assistant" &&
      Array.isArray(message.toolCalls) &&
      message.toolCalls.length > 0,
  );

  const recentToolResults = toolResultMessages
    .slice(-MAXIMUM_FALLBACK_TOOL_RESULTS)
    .flatMap((message) =>
      (message.toolCalls || []).map((toolCall) => {
        const resultText =
          typeof toolCall.result === "string"
            ? toolCall.result
            : JSON.stringify(toolCall.result);
        const truncatedResult =
          resultText.length > MAXIMUM_RESULT_EXCERPT_LENGTH
            ? resultText.substring(0, MAXIMUM_RESULT_EXCERPT_LENGTH) + "…"
            : resultText;
        const argsText =
          typeof toolCall.args === "string"
            ? toolCall.args
            : JSON.stringify(toolCall.args);
        return `  - ${toolCall.name}(${String(argsText).substring(0, 200)}): ${truncatedResult}`;
      }),
    );

  if (recentToolResults.length > 0) {
    sections.push(
      `\nRecent tool results (last ${recentToolResults.length}):\n${recentToolResults.join("\n")}`,
    );
  }

  return sections.join("\n");
}
