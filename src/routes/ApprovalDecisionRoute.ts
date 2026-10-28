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

interface ValidatedApprovalBody {
  conversationId: string;
  toolCallId?: string;
  resolved: Decision;
  resolvedScope: Scope;
  reason?: string;
  editedArgs?: Record<string, unknown>;
}

function parseDecisionField(
  decision: unknown,
  approved: unknown,
): { resolved: Decision } | { error: string } {
  if (decision !== undefined) {
    if (decision !== "allow" && decision !== "deny") {
      return { error: 'decision must be "allow" or "deny"' };
    }
    const resolved: Decision = decision;
    if (approved !== undefined && approved !== (resolved === "allow")) {
      return { error: "approved contradicts decision" };
    }
    return { resolved };
  }
  if (approved === true || approved === false) {
    return { resolved: approved ? "allow" : "deny" };
  }
  return {
    error: 'Missing decision: send decision "allow" or "deny" (or a boolean approved)',
  };
}

function validateApprovalRequestBody(
  body: unknown,
): { valid: ValidatedApprovalBody } | { error: string } {
  if (!isPlainObject(body)) {
    return { error: "Body must be a JSON object" };
  }
  const {
    conversationId,
    toolCallId,
    decision,
    approved,
    approveAll,
    reason,
    editedArgs,
    scope,
  } = body;

  if (typeof conversationId !== "string" || !conversationId) {
    return { error: "Missing conversationId" };
  }

  const decisionResult = parseDecisionField(decision, approved);
  if ("error" in decisionResult) {
    return decisionResult;
  }
  const resolved = decisionResult.resolved;

  if (
    toolCallId !== undefined &&
    (typeof toolCallId !== "string" || !toolCallId)
  ) {
    return { error: "toolCallId must be a non-empty string" };
  }
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    return { error: "reason must be a string" };
  }
  if (editedArgs !== undefined && !isPlainObject(editedArgs)) {
    return { error: "editedArgs must be a JSON object" };
  }

  let resolvedScope: Scope = "call";
  if (scope !== undefined) {
    if (!SCOPES.includes(scope as Scope)) {
      return { error: 'scope must be "call", "batch" or "conversation"' };
    }
    resolvedScope = scope as Scope;
  } else if (approveAll === true && resolved === "allow") {
    resolvedScope = "batch";
  }

  return {
    valid: {
      conversationId,
      toolCallId: toolCallId as string | undefined,
      resolved,
      resolvedScope,
      reason: typeof reason === "string" ? reason : undefined,
      editedArgs: editedArgs as Record<string, unknown> | undefined,
    },
  };
}

function sendApprovalErrorResponse(
  response: Response,
  outcome: Awaited<ReturnType<typeof AgenticLoopService.decideApproval>>,
  conversationId: string,
  toolCallId?: string,
): Response | null {
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
  return null;
}

export function handleApprovalDecision(logPrefix: string) {
  return async (request: Request, response: Response) => {
    const validation = validateApprovalRequestBody(request.body);
    if ("error" in validation) {
      return response.status(400).json({ error: validation.error });
    }
    const {
      conversationId,
      toolCallId,
      resolved,
      resolvedScope,
      reason,
      editedArgs,
    } = validation.valid;

    const outcome = await AgenticLoopService.decideApproval(conversationId, {
      isApproved: resolved === "allow",
      ...(toolCallId ? { toolCallId } : {}),
      batchWide: resolvedScope !== "call",
      ...(reason !== undefined ? { reason } : {}),
      ...(editedArgs !== undefined ? { editedArgs } : {}),
    });

    const errResp = sendApprovalErrorResponse(
      response,
      outcome,
      conversationId,
      toolCallId,
    );
    if (errResp) return errResp;
    if (outcome.status !== "decided") return response.status(500).end();

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
