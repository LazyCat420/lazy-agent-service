import type { Request, Response } from "express";
import AgenticLoopService from "../services/AgenticLoopService.ts";
import logger from "../utils/logger.ts";

/**
 * POST /agent/approve and POST /conversation/approve — one decision for the
 * pending tool/plan call of a conversation. Fails closed: nothing is approved
 * unless the body says so as a strict value.
 * ported from prism-service src/routes/ApprovalDecisionRoute.ts
 *
 * Body:
 *   {
 *     conversationId: string,
 *     toolCallId?: string,            // required when several calls are pending (unless scope is batch/conversation)
 *     decision: "allow" | "deny",
 *     reason?: string,                // a denial's reason, relayed to the model (cut to 500 chars)
    editedArgs?: object,            // allow with these arguments (validated against the tool schema, 400 if invalid)
 *     scope?: "call" | "batch" | "conversation",   // batch/conversation: also approve what follows in this turn
 *   }
 *
 * Legacy `{ approved: boolean }` is read as a strict boolean and
 * `approveAll: true` as scope "batch". A missing or non-boolean value is a
 * 400, never a yes.
 *
 * 404 — nothing pending under this conversation, or a toolCallId not pending.
 * 400 — invalid body, several calls pending and none named, or editedArgs that
 *       accompany a deny / fail the tool's schema.
 * 409 — the call was already decided (or its card is settled).
 * 200 with `delivered: false` — stored, but no live turn took it (restart).
 *
 * Tool approvals are durable (PendingApprovalStore).
 */

type Decision = "allow" | "deny";
type Scope = "call" | "batch" | "conversation";
const SCOPES: readonly Scope[] = ["call", "batch", "conversation"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function handleApprovalDecision(logPrefix: string) {
  return async (request: Request, response: Response) => {
    const body: unknown = request.body;
    if (!isPlainObject(body)) {
      return response.status(400).json({ error: "Body must be a JSON object" });
    }
    const { conversationId, toolCallId, decision, approved, approveAll, reason, editedArgs, scope } = body;

    if (typeof conversationId !== "string" || !conversationId) {
      return response.status(400).json({ error: "Missing conversationId" });
    }

    let resolved: Decision;
    if (decision !== undefined) {
      if (decision !== "allow" && decision !== "deny") {
        return response.status(400).json({ error: 'decision must be "allow" or "deny"' });
      }
      resolved = decision;
      if (approved !== undefined && approved !== (resolved === "allow")) {
        return response.status(400).json({ error: "approved contradicts decision" });
      }
    } else if (approved === true || approved === false) {
      resolved = approved ? "allow" : "deny";
    } else {
      return response.status(400).json({
        error: 'Missing decision: send decision "allow" or "deny" (or a boolean approved)',
      });
    }

    if (toolCallId !== undefined && (typeof toolCallId !== "string" || !toolCallId)) {
      return response.status(400).json({ error: "toolCallId must be a non-empty string" });
    }
    if (reason !== undefined && reason !== null && typeof reason !== "string") {
      return response.status(400).json({ error: "reason must be a string" });
    }
    if (editedArgs !== undefined && !isPlainObject(editedArgs)) {
      return response.status(400).json({ error: "editedArgs must be a JSON object" });
    }
    let resolvedScope: Scope = "call";
    if (scope !== undefined) {
      if (!SCOPES.includes(scope as Scope)) {
        return response.status(400).json({ error: 'scope must be "call", "batch" or "conversation"' });
      }
      resolvedScope = scope as Scope;
    } else if (approveAll === true && resolved === "allow") {
      resolvedScope = "batch";
    }

    const outcome = await AgenticLoopService.decideApproval(conversationId, {
      isApproved: resolved === "allow",
      ...(toolCallId ? { toolCallId: toolCallId as string } : {}),
      batchWide: resolvedScope !== "call",
      ...(typeof reason === "string" ? { reason } : {}),
      ...(editedArgs !== undefined ? { editedArgs: editedArgs as Record<string, unknown> } : {}),
    });

    if (outcome.status === "invalid") {
      return response.status(400).json({ error: outcome.error, conversationId });
    }
    if (outcome.status === "already_decided") {
      return response.status(409).json({
        error: "This approval was already decided",
        conversationId,
        ...(toolCallId ? { toolCallId } : {}),
      });
    }

    if (outcome.status === "not_found") {
      return response.status(404).json({
        error: toolCallId
          ? "No pending approval with this toolCallId"
          : "No pending approval for this conversation",
        conversationId,
        ...(toolCallId ? { toolCallId } : {}),
      });
    }
    if (outcome.status === "ambiguous") {
      return response.status(400).json({
        error: `toolCallId is required: ${outcome.pendingToolCallIds.length} calls are pending`,
        conversationId,
        pendingToolCallIds: outcome.pendingToolCallIds,
      });
    }

    logger.info(
      `${logPrefix} ${resolved} ${outcome.decidedToolCallIds.join(", ")} (scope ${resolvedScope}${editedArgs !== undefined ? ", edited args" : ""}) for conversation ${conversationId}${outcome.delivered ? "" : " — stored, no live turn"}`,
    );
    return response.json({
      ok: true,
      approved: resolved === "allow",
      decision: resolved,
      scope: resolvedScope,
      type: outcome.type,
      decidedToolCallIds: outcome.decidedToolCallIds,
      delivered: outcome.delivered,
    });
  };
}
