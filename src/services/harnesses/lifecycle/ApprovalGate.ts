import { pendingApprovals } from "../../ApprovalRegistry.ts";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import type { ToolCall, AgenticContext } from "../types.ts";
import type AutoApprovalEngine from "../../AutoApprovalEngine.ts";

/**
 * ApprovalGate — extracted approval gating logic.
 *
 * Handles the promise-based approval pattern: emit approval_required events,
 * register a pending approval resolver, wait for the user's response
 * (or timeout after 2 minutes), and return the decision.
 *
 * Reusable by any harness that executes write/danger-tier tools.
 */

const APPROVAL_TIMEOUT_MS = 120_000;

/**
 * Check a batch of tool calls against the approval engine and, if any
 * require approval, pause until the user responds or timeout occurs.
 */
export async function checkAndWaitForApproval(
  toolCalls: ToolCall[],
  context: AgenticContext,
  approvalEngine: AutoApprovalEngine,
): Promise<{ isApproved: boolean; shouldApproveAll: boolean }> {
  const { conversationId, emit, options } = context;
  // Canonical runs use profile admission in runtimeToolExecutor; local destructive
  // actions still require confirmation in the application executor. There is no
  // legacy approval-response endpoint on /v1/runs.
  if (context.runtimeToolExecutor) return { isApproved: true, shouldApproveAll: false };

  const { needsApproval } = approvalEngine.checkBatch(toolCalls);

  if (needsApproval.length === 0 || options.autoApprove) {
    return { isApproved: true, shouldApproveAll: false };
  }

  // Emit approval_required events for each tool needing approval
  for (const toolCallRequiringApproval of needsApproval) {
    emit({
      type: "approval_required",
      toolCall: {
        name: toolCallRequiringApproval.name,
        args: toolCallRequiringApproval.args,
        id: toolCallRequiringApproval.id,
      },
      tier: toolCallRequiringApproval._approval?.tier,
      tierLabel: toolCallRequiringApproval._approval?.tierLabel,
    });
  }

  // Wait for user approval or timeout
  const approvalResult = await new Promise<
    import("../../ApprovalRegistry.ts").ApprovalResolution
  >((resolve) => {
    const timeoutId = setTimeout(() => {
      pendingApprovals.delete(conversationId);
      resolve({ isApproved: false, reason: "timeout" });
    }, APPROVAL_TIMEOUT_MS);

    const existingApproval = pendingApprovals.get(conversationId);
    if (existingApproval) {
      existingApproval.resolve({ isApproved: false, reason: "superseded" } as never);
      pendingApprovals.delete(conversationId);
    }

    pendingApprovals.set(conversationId, {
      resolve: (
        value: import("../../ApprovalRegistry.ts").ApprovalResolution,
      ) => {
        clearTimeout(timeoutId);
        pendingApprovals.delete(conversationId);
        resolve(value);
      },
      type: "tool",
      tools: needsApproval.map((toolCall) => toolCall.name),
      toolCalls: needsApproval.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args,
        _approval: {
          tier: String(toolCall._approval.tier),
          tierLabel: toolCall._approval.tierLabel,
        },
      })),
    });
  });

  if (!approvalResult?.isApproved) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: `Tool execution rejected: ${needsApproval.map((toolCall) => toolCall.name).join(", ")}`,
    });
    return { isApproved: false, shouldApproveAll: false };
  }

  if (approvalResult.shouldApproveAll) {
    return { isApproved: true, shouldApproveAll: true };
  }

  return { isApproved: true, shouldApproveAll: false };
}
