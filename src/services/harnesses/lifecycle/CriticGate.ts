import logger from "../../../utils/logger.ts";
import { APPROVAL_TIERS, toolTier } from "../../ToolAuthorization.ts";
import PromptLocaleService from "../../PromptLocaleService.ts";
import { resolveIndependentCriticModel } from "./IndependentJudge.ts";
import RequestLogger from "../../RequestLogger.ts";

import type { ToolCall, AgenticContext } from "../types.ts";
import { getErrorMessage } from "../../../utils/ErrorHelpers.ts";

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

interface CriticGateOptions {
  model?: string;
}

interface CriticReviewResult {
  isApproved: boolean;
  reason: string;
  criticModel: string;
  /** False when the critic fell back to the author model (no independent signal). */
  judgeIndependent: boolean;
}

export default class CriticGate {
  private criticModel: string | undefined;

  constructor(options: CriticGateOptions = {}) {
    this.criticModel = options.model || undefined;
  }

  /**
   * Resolve the critic: an explicit model is used as configured; otherwise a
   * different model of the same provider, so the judge never reviews its own
   * author's output with identical weights.
   */
  private selectJudge(authorModel: string): { model: string; independent: boolean } {
    if (this.criticModel) {
      return { model: this.criticModel, independent: this.criticModel !== authorModel };
    }
    const selection = resolveIndependentCriticModel(authorModel);
    return { model: selection.model, independent: selection.independent };
  }

  /**
   * Review a tool call for safety.
   *
   * Only activates for DANGER tier tools (execute_shell, execute_python,
   * execute_javascript, execute_command). All other tools pass through.
   */
  async review(
    toolCall: ToolCall,
    context: AgenticContext,
  ): Promise<CriticReviewResult> {
    const tier = toolTier(toolCall.name);

    const judge = this.selectJudge(context.resolvedModel);
    const activeCriticModel = judge.model;

    // Only review DANGER tier tools
    if (tier !== APPROVAL_TIERS.DANGER) {
      return {
        isApproved: true,
        reason: "below_danger_tier",
        criticModel: activeCriticModel,
        judgeIndependent: judge.independent,
      };
    }

    // Skip if critic is explicitly disabled for this context
    if ((context.options as Record<string, unknown>).skipCritic === true) {
      return {
        isApproved: true,
        reason: "critic_skipped",
        criticModel: activeCriticModel,
        judgeIndependent: judge.independent,
      };
    }

    try {
      const reviewPrompt = this.buildReviewPrompt(toolCall);

      // Use the same provider from the context to avoid a separate provider dependency.
      // The critic call is intentionally lightweight and fast.
      const criticResponse = await this.callCriticModel(
        reviewPrompt,
        context,
        activeCriticModel,
      );
      return {
        ...this.parseReviewResponse(criticResponse, activeCriticModel),
        judgeIndependent: judge.independent,
      };
    } catch (criticError: unknown) {
      // On critic failure, default to allowing (fail-open for usability).
      // A fail-closed approach would block all DANGER tools on critic downtime.
      logger.warn(
        `[CriticGate] Review failed for "${toolCall.name}": ${getErrorMessage(criticError)}. Defaulting to approve.`,
      );
      return {
        isApproved: true,
        reason: "critic_error_fallback",
        criticModel: activeCriticModel,
        judgeIndependent: judge.independent,
      };
    }
  }

  /**
   * Build a compact review prompt for the critic model.
   */
  private buildReviewPrompt(toolCall: ToolCall): string {
    const argsPreview = JSON.stringify(toolCall.args || {}, null, 0).slice(
      0,
      1000,
    );

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
  private async callCriticModel(
    prompt: string,
    context: AgenticContext,
    activeModel: string,
  ): Promise<string> {
    const { provider } = context;

    const criticMessages = [{ role: "user", content: prompt }];

    const criticOptions = {
      maxTokens: CRITIC_MAX_TOKENS,
      temperature: 0,
      signal: AbortSignal.timeout(CRITIC_TIMEOUT_MS),
    };

    let responseText = "";
    const requestStartMs = performance.now();

    const stream = provider.generateTextStream(
      criticMessages,
      activeModel,
      criticOptions,
    );

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
      conversationId: (context.conversationId as string) || null,
      agentConversationId: context.agentConversationId || null,
      aiMessages: criticMessages as Parameters<typeof RequestLogger.logBackgroundLlmCall>[0]["aiMessages"],
      resultText: responseText,
      success: true,
      errorMessage: null,
      requestStartMs,
      extraRequestPayload: {
        reviewedTool: prompt.includes("Tool:") ? prompt.split("Tool: ")[1]?.split("\n")[0] : null,
      },
    }).catch((loggingError: unknown) =>
      logger.error(
        `[CriticGate] Failed to log critic review request: ${getErrorMessage(loggingError)}`,
      ),
    );

    return responseText.trim();
  }

  /**
   * Parse the critic model's response into a structured result.
   */
  private parseReviewResponse(
    response: string,
    activeModel: string,
  ): Omit<CriticReviewResult, "judgeIndependent"> {
    const firstLine = response.split("\n")[0].trim().toUpperCase();

    if (firstLine.startsWith("APPROVE")) {
      return {
        isApproved: true,
        reason: "critic_approved",
        criticModel: activeModel,
      };
    }

    if (firstLine.startsWith("DENY")) {
      const denialReason =
        response.split("\n").slice(1).join(" ").trim() || "critic_denied";
      logger.info(`[CriticGate] DENIED: ${denialReason}`);
      return {
        isApproved: false,
        reason: denialReason,
        criticModel: activeModel,
      };
    }

    // Ambiguous response — default to approve
    logger.warn(
      `[CriticGate] Ambiguous critic response: "${response.slice(0, 100)}". Defaulting to approve.`,
    );
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
    return async (toolCall: ToolCall, context: AgenticContext) => {
      return this.review(toolCall, context);
    };
  }
}
