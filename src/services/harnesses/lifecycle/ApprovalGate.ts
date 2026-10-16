import { randomUUID } from "node:crypto";
import { pendingApprovals } from "../../ApprovalRegistry.ts";
import { pendingApprovalStore } from "../../PendingApprovalStore.ts";
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

export interface ApprovalOutcome {
  isApproved: boolean;
  shouldApproveAll: boolean;
  /** The user's reason for a denial, bounded; absent for timeouts and silent denials. */
  reason?: string;
}

/**
 * The tool result a rejected call ends with. A user's denial reason is
 * relayed so the model can adapt; without one the message is generic.
 */
export function rejectionResult(reason?: string): { success: false; error: "USER_REJECTED"; message: string } {
  return {
    success: false,
    error: "USER_REJECTED",
    message: reason
      ? `Tool execution was manually rejected by the user. Reason: ${reason}`
      : "Tool execution was manually rejected by the user.",
  };
}

/**
 * Check a batch of tool calls against the approval engine and, if any
 * require approval, pause until the user responds or timeout occurs.
 */
export async function checkAndWaitForApproval(
  toolCalls: ToolCall[],
  context: AgenticContext,
  approvalEngine: AutoApprovalEngine,
): Promise<ApprovalOutcome> {
  const { conversationId, emit, options } = context;
  // Canonical runs use profile admission in runtimeToolExecutor; local destructive
  // actions still require confirmation in the application executor. There is no
  // legacy approval-response endpoint on /v1/runs.
  if (context.runtimeToolExecutor) return { isApproved: true, shouldApproveAll: false };

  const { needsApproval } = approvalEngine.checkBatch(toolCalls);

  if (needsApproval.length === 0 || options.autoApprove) {
    return { isApproved: true, shouldApproveAll: false };
  }

  // Unattended runs (no person at the keyboard — trading cycles, scheduled
  // tasks): an unanswerable approval ask must never hang the loop. Deny
  // immediately; the model reads the rejection and adapts (prism's
  // `unattended` semantics, 2026-09-27 audit §1).
  if (options.unattended === true) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: `Unattended run: approval for ${needsApproval.map((toolCall) => toolCall.name).join(", ")} denied automatically`,
    });
    return { isApproved: false, shouldApproveAll: false };
  }

  // Record the batch durably BEFORE the card goes out: a decision is a
  // conditional write on these records (restart-safe, exactly-once).
  const batchId = randomUUID();
  const itemIds = needsApproval.map((toolCall, position) => toolCall.id ?? `call-${position}`);
  const schemaByName = new Map(
    (context.runtimeTools?.finalTools ?? []).map((tool) => [tool.name, tool.parameters ?? null]),
  );
  await pendingApprovalStore.cancelPending(conversationId, "superseded");
  await pendingApprovalStore.create(
    needsApproval.map((toolCall, position) => ({
      conversationId,
      batchId,
      itemId: itemIds[position],
      position,
      name: toolCall.name,
      args: toolCall.args,
      tier: String(toolCall._approval.tier),
      tierLabel: toolCall._approval.tierLabel,
      argsSchema: (schemaByName.get(toolCall.name) as Record<string, unknown> | null) ?? null,
    })),
  );

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
      void pendingApprovalStore.cancelPending(conversationId, "timeout");
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
      itemIds,
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
    return {
      isApproved: false,
      shouldApproveAll: false,
      ...(approvalResult?.denialReason ? { reason: approvalResult.denialReason } : {}),
    };
  }

  // Run the approved call with the arguments the user edited it to (already
  // validated against the tool schema by the approval route). The gate holds
  // copies of the calls, so the originals are matched by position.
  if (approvalResult.editedArgs) {
    let cursor = 0;
    for (const toolCall of toolCalls) {
      const pending = needsApproval[cursor];
      if (!pending || pending.id !== toolCall.id || pending.name !== toolCall.name) continue;
      const edited = approvalResult.editedArgs[itemIds[cursor]];
      if (edited) toolCall.args = edited;
      cursor++;
    }
  }

  if (approvalResult.shouldApproveAll) {
    return { isApproved: true, shouldApproveAll: true };
  }

  return { isApproved: true, shouldApproveAll: false };
}
