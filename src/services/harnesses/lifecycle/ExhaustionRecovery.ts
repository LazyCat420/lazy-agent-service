import { expandMessagesForFunctionCall } from "../../../utils/FunctionCallingUtilities.ts";
import ConversationGenerationTracker from "../../ConversationGenerationTracker.ts";
import PromptLocaleService from "../../PromptLocaleService.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";

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

  const { tools: _tools, ...exhaustionOptions } = options;

  const enforcedMessages = harness.enforceContextWindow(currentMessages, 0);
  const expandedMessages = expandMessagesForFunctionCall(enforcedMessages, {
    filterDeleted: false,
  });

  const augmentedOptions = {
    ...exhaustionOptions,
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

  harness.logIteration(exhaustionPass, currentMessages);
  harness.emitGenerationProgress();
  ConversationGenerationTracker.complete(exhaustionRequestId);
}
