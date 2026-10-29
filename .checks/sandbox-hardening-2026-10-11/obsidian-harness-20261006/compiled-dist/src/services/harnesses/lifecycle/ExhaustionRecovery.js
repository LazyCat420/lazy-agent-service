import { expandMessagesForFunctionCall } from "../../../utils/FunctionCallingUtilities.js";
import ConversationGenerationTracker from "../../ConversationGenerationTracker.js";
import PromptLocaleService from "../../PromptLocaleService.js";
import { SERVER_SENT_EVENT_TYPES, STATUS_MESSAGES, } from "@rodrigo-barraza/utilities-library/taxonomy";
/**
 * ExhaustionRecovery — handles the iteration-limit summary pass.
 *
 * When the agentic loop hits its maximum iteration count without producing
 * a final text response, this module runs one last LLM call (with no tools)
 * asking the model to summarize progress and state what remains.
 *
 * Extracted from ReActHarness to be reusable by any iterating harness.
 */
/**
 * Run a tool-free exhaustion recovery pass.
 *
 * Appends a system instruction asking for a progress summary, streams the
 * response through the harness's `consumeStream`, and updates state.
 */
export async function runExhaustionRecoveryPass(harness, context, state, currentMessages) {
    const { emit, signal, options, resolvedModel, modelDefinition, provider } = context;
    emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.ITERATION_LIMIT_REACHED,
    });
    currentMessages.push({
        role: "system",
        content: PromptLocaleService.get(options?.locale || PromptLocaleService.getDefaultLocale(), "harness.exhaustionRecovery.message"),
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
    const exhaustionStream = modelDefinition?.liveAPI && provider.generateTextStreamLive
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
    const emptyToolNames = new Set();
    // Use the shared consumeStream — all chunk routing goes through processStreamChunk,
    // so new chunk types added to the base dispatcher are automatically handled.
    await harness.consumeStream(exhaustionStream, exhaustionPass, emptyToolNames);
    harness.logIteration(exhaustionPass, currentMessages);
    harness.emitGenerationProgress();
    ConversationGenerationTracker.complete(exhaustionRequestId);
}
//# sourceMappingURL=ExhaustionRecovery.js.map