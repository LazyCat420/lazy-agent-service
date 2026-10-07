import logger from "../../../utils/logger.js";
import { APPROVAL_TIERS } from "../../AutoApprovalEngine.js";
import PromptLocaleService from "../../PromptLocaleService.js";
import RequestLogger from "../../RequestLogger.js";
import { getErrorMessage } from "../../../utils/ErrorHelpers.js";
/**
 * CriticGate — lightweight multi-model review of high-risk tool calls.
 *
 * A "second opinion" gate that uses a fast model to review Tier 3 (DANGER)
 * tool calls before they execute. Operates as a `decide` category hook in
 * AgentHooks, so it short-circuits on deny.
 *
 * 2026 SOTA harnesses (Devin, Factory, SWE-agent) use this pattern to catch
 * catastrophic commands (rm -rf, DROP TABLE, etc.) that the primary model
 * might hallucinate. The critic model doesn't need to be powerful — it just
 * needs to spot obvious danger patterns.
 */
const CRITIC_MAX_TOKENS = 200;
const CRITIC_TIMEOUT_MS = 10_000;
export default class CriticGate {
    criticModel;
    constructor(options = {}) {
        this.criticModel = options.model || undefined;
    }
    /**
     * Review a tool call for safety.
     *
     * Only activates for DANGER tier tools (execute_shell, execute_python,
     * execute_javascript, execute_command). All other tools pass through.
     */
    async review(toolCall, context) {
        const approvalInfo = toolCall._approval;
        const tier = approvalInfo?.tier ?? APPROVAL_TIERS.WRITE;
        const activeCriticModel = this.criticModel || context.resolvedModel;
        // Only review DANGER tier tools
        if (tier !== APPROVAL_TIERS.DANGER) {
            return {
                isApproved: true,
                reason: "below_danger_tier",
                criticModel: activeCriticModel,
            };
        }
        // Skip if critic is explicitly disabled for this context
        if (context.options.skipCritic === true) {
            return {
                isApproved: true,
                reason: "critic_skipped",
                criticModel: activeCriticModel,
            };
        }
        try {
            const reviewPrompt = this.buildReviewPrompt(toolCall);
            // Use the same provider from the context to avoid a separate provider dependency.
            // The critic call is intentionally lightweight and fast.
            const criticResponse = await this.callCriticModel(reviewPrompt, context, activeCriticModel);
            return this.parseReviewResponse(criticResponse, activeCriticModel);
        }
        catch (criticError) {
            // On critic failure, default to allowing (fail-open for usability).
            // A fail-closed approach would block all DANGER tools on critic downtime.
            logger.warn(`[CriticGate] Review failed for "${toolCall.name}": ${getErrorMessage(criticError)}. Defaulting to approve.`);
            return {
                isApproved: true,
                reason: "critic_error_fallback",
                criticModel: activeCriticModel,
            };
        }
    }
    /**
     * Build a compact review prompt for the critic model.
     */
    buildReviewPrompt(toolCall) {
        const argsPreview = JSON.stringify(toolCall.args || {}, null, 0).slice(0, 1000);
        return [
            PromptLocaleService.get("en", "harness.criticGate.safetyReviewer"),
            PromptLocaleService.get("en", "harness.criticGate.reviewCriteria"),
            "",
            `Tool: ${toolCall.name}`,
            `Arguments: ${argsPreview}`,
            "",
            PromptLocaleService.get("en", "harness.criticGate.responseFormat"),
        ].join("\n");
    }
    /**
     * Call the critic model for a safety review.
     * Uses the same provider from the harness context.
     */
    async callCriticModel(prompt, context, activeModel) {
        const { provider } = context;
        const criticMessages = [{ role: "user", content: prompt }];
        const criticOptions = {
            maxTokens: CRITIC_MAX_TOKENS,
            temperature: 0,
            signal: AbortSignal.timeout(CRITIC_TIMEOUT_MS),
        };
        let responseText = "";
        const requestStartMs = performance.now();
        const stream = provider.generateTextStream(criticMessages, activeModel, criticOptions);
        for await (const chunk of stream) {
            if (typeof chunk === "string") {
                responseText += chunk;
            }
        }
        RequestLogger.logBackgroundLlmCall({
            requestId: `${context.requestId || context.agentConversationId || "unknown"}-critic`,
            endpoint: "/agent",
            operation: "agent:critic-review",
            project: context.project,
            username: context.username,
            agent: context.agent || null,
            provider: context.providerName,
            model: activeModel,
            traceId: context.traceId || null,
            conversationId: context.conversationId || null,
            agentConversationId: context.agentConversationId || null,
            aiMessages: criticMessages,
            resultText: responseText,
            success: true,
            errorMessage: null,
            requestStartMs,
            extraRequestPayload: {
                reviewedTool: prompt.includes("Tool:") ? prompt.split("Tool: ")[1]?.split("\n")[0] : null,
            },
        }).catch((loggingError) => logger.error(`[CriticGate] Failed to log critic review request: ${getErrorMessage(loggingError)}`));
        return responseText.trim();
    }
    /**
     * Parse the critic model's response into a structured result.
     */
    parseReviewResponse(response, activeModel) {
        const firstLine = response.split("\n")[0].trim().toUpperCase();
        if (firstLine.startsWith("APPROVE")) {
            return {
                isApproved: true,
                reason: "critic_approved",
                criticModel: activeModel,
            };
        }
        if (firstLine.startsWith("DENY")) {
            const denialReason = response.split("\n").slice(1).join(" ").trim() || "critic_denied";
            logger.info(`[CriticGate] DENIED: ${denialReason}`);
            return {
                isApproved: false,
                reason: denialReason,
                criticModel: activeModel,
            };
        }
        // Ambiguous response — default to approve
        logger.warn(`[CriticGate] Ambiguous critic response: "${response.slice(0, 100)}". Defaulting to approve.`);
        return {
            isApproved: true,
            reason: "critic_parse_fallback",
            criticModel: activeModel,
        };
    }
    /**
     * Create a hook handler for registration with AgentHooks.
     * Returns a `decide` category hook for `beforeToolCall`.
     */
    createHook() {
        return async (toolCall, context) => {
            return this.review(toolCall, context);
        };
    }
}
//# sourceMappingURL=CriticGate.js.map