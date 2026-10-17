import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { pendingApprovals, type ApprovalResolution } from "../../ApprovalRegistry.ts";
import { pendingApprovalStore, type PendingApprovalRecord } from "../../PendingApprovalStore.ts";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import {
  decideToolCall,
  deniedToolResult,
  type ApprovalAnswer,
  type AuthorizationInput,
  type DeniedToolResult,
  type ToolAuthorization,
} from "../../ToolAuthorization.ts";
import type AgentHooks from "../../AgentHooks.ts";
import type { ToolCall, AgenticContext } from "../types.ts";

/**
 * ApprovalGate — authorizes a batch of tool calls through `decideToolCall`
 * and, for the calls that decision leaves at "ask", obtains the answer: a
 * durable decision posted while no turn was running, or a live one over the
 * approval route (2-minute timeout). Every call gets its own verdict; a deny
 * never becomes a run, whatever autoApprove, approve-all or the person says.
 *
 * ported from prism-service src/services/harnesses/lifecycle/ApprovalGate.ts
 * (per-call verdicts; denied calls never user-approvable).
 */

const APPROVAL_TIMEOUT_MS = 120_000;

type Denial = Extract<ToolAuthorization, { verdict: "deny" }>;
type Ask = Extract<ToolAuthorization, { verdict: "ask" }>;

export interface AuthorizationVerdict {
  /** Calls cleared to run. */
  executable: Set<ToolCall>;
  /** Denied calls and the one tool result each reports to the model. */
  denied: Map<ToolCall, DeniedToolResult>;
}

/**
 * A decision the user posted while no turn was running (a restart killed the
 * turn that asked): the next turn that reaches the same calls consumes it
 * instead of asking again. Every asked call must have a stored decision
 * (same tool, same arguments) or none is taken.
 */
async function consumeStoredDecisions(
  conversationId: string,
  asked: ToolCall[],
): Promise<PendingApprovalRecord[] | null> {
  const stored = await pendingApprovalStore.listUndelivered(conversationId, "tool");
  const matched: PendingApprovalRecord[] = [];
  for (const toolCall of asked) {
    const record = stored.find(
      (candidate) =>
        !matched.includes(candidate) &&
        candidate.name === toolCall.name &&
        isDeepStrictEqual(candidate.args, toolCall.args),
    );
    if (!record) return null;
    matched.push(record);
  }
  for (const record of matched) {
    if (!(await pendingApprovalStore.markDelivered(record.id))) return null;
  }
  return matched;
}

/** Record the asks durably, emit the approval cards and wait for the answer. */
async function waitForLiveAnswer(
  asks: Array<{ toolCall: ToolCall; decision: Ask }>,
  context: AgenticContext,
): Promise<{ resolution: ApprovalResolution; itemIds: string[] }> {
  const { conversationId, emit } = context;
  // Record the batch durably BEFORE the card goes out: a decision is a
  // conditional write on these records (restart-safe, exactly-once).
  const batchId = randomUUID();
  const itemIds = asks.map(({ toolCall }, position) => toolCall.id ?? `call-${position}`);
  const schemaByName = new Map(
    (context.runtimeTools?.finalTools ?? []).map((tool) => [tool.name, tool.parameters ?? null]),
  );
  await pendingApprovalStore.cancelPending(conversationId, "superseded", ["tool"]);
  await pendingApprovalStore.create(
    asks.map(({ toolCall, decision }, position) => ({
      kind: "tool" as const,
      conversationId,
      batchId,
      itemId: itemIds[position],
      position,
      name: toolCall.name,
      args: toolCall.args,
      tier: String(decision.tier),
      tierLabel: decision.tierLabel,
      argsSchema: (schemaByName.get(toolCall.name) as Record<string, unknown> | null) ?? null,
    })),
  );

  for (const { toolCall, decision } of asks) {
    emit({
      type: "approval_required",
      toolCall: { name: toolCall.name, args: toolCall.args, id: toolCall.id },
      tier: decision.tier,
      tierLabel: decision.tierLabel,
    });
  }

  const resolution = await new Promise<ApprovalResolution>((resolve) => {
    const timeoutId = setTimeout(() => {
      pendingApprovals.delete(conversationId);
      void pendingApprovalStore.cancelPending(conversationId, "timeout", ["tool"]);
      resolve({ isApproved: false, reason: "timeout" });
    }, APPROVAL_TIMEOUT_MS);

    const existingApproval = pendingApprovals.get(conversationId);
    if (existingApproval) {
      existingApproval.resolve({ isApproved: false, reason: "superseded" } as never);
      pendingApprovals.delete(conversationId);
    }

    pendingApprovals.set(conversationId, {
      resolve: (value: ApprovalResolution) => {
        clearTimeout(timeoutId);
        pendingApprovals.delete(conversationId);
        resolve(value);
      },
      type: "tool",
      itemIds,
      tools: asks.map(({ toolCall }) => toolCall.name),
      toolCalls: asks.map(({ toolCall, decision }) => ({
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args,
        _approval: { tier: String(decision.tier), tierLabel: decision.tierLabel },
      })),
    });
  });
  return { resolution, itemIds };
}

/**
 * Decide every call of the batch. Calls whose arguments did not parse are
 * left out of both sets: the executor answers them as malformed.
 */
export async function authorizeToolCalls(
  toolCalls: ToolCall[],
  context: AgenticContext,
  hooks?: AgentHooks,
): Promise<AuthorizationVerdict> {
  const { conversationId, emit, options } = context;
  const decided = await Promise.all(
    toolCalls
      .filter((toolCall) => !toolCall._argsParseError)
      .map(async (toolCall) => {
        const input: AuthorizationInput = {
          name: toolCall.name,
          args: toolCall.args ?? {},
          isAllowListed: toolCall.isUnauthorized !== true,
          policies: options.policies ?? [],
          autoApprove: options.autoApprove === true,
          unattended: options.unattended === true,
          asksResolvedByProfile: !!context.runtimeToolExecutor,
        };
        // Decide hooks (CriticGate, …) only see calls no earlier rail denied.
        if (hooks && decideToolCall(input).verdict !== "deny") {
          const hookVerdict = await hooks.run("beforeToolCall", structuredClone(toolCall), context);
          if (hookVerdict && hookVerdict.isApproved === false) {
            input.hookDenial =
              typeof hookVerdict.reason === "string" && hookVerdict.reason
                ? hookVerdict.reason
                : "denied by a beforeToolCall hook";
          }
        }
        return { toolCall, input, decision: decideToolCall(input) };
      }),
  );

  const asks = decided.filter(
    (entry): entry is typeof entry & { decision: Ask } => entry.decision.verdict === "ask",
  );
  const answers = new Map<ToolCall, ApprovalAnswer>();

  if (asks.length > 0) {
    const askedCalls = asks.map(({ toolCall }) => toolCall);
    const stored = await consumeStoredDecisions(conversationId, askedCalls);
    if (stored) {
      emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: `Applied the decision you gave before the restart: ${askedCalls.map((toolCall) => toolCall.name).join(", ")}`,
      });
      stored.forEach((record, position) => {
        const toolCall = askedCalls[position];
        const decision = record.decision;
        if (decision?.decision === "allow") {
          if (decision.editedArgs) toolCall.args = decision.editedArgs;
          if (decision.scope !== "call") options.autoApprove = true;
          answers.set(toolCall, { decision: "allow" });
        } else {
          answers.set(toolCall, { decision: "deny", ...(decision?.reason ? { reason: decision.reason } : {}) });
        }
      });
    } else {
      const { resolution, itemIds } = await waitForLiveAnswer(asks, context);
      askedCalls.forEach((toolCall, position) => {
        if (resolution?.isApproved) {
          const edited = resolution.editedArgs?.[itemIds[position]];
          if (edited) toolCall.args = edited;
          answers.set(toolCall, { decision: "allow" });
        } else {
          answers.set(toolCall, {
            decision: "deny",
            ...(resolution?.denialReason ? { reason: resolution.denialReason } : {}),
          });
        }
      });
      // Approve-all answers this conversation's later asks; it can never
      // reach a deny, which decideToolCall settles before any ask.
      if (resolution?.isApproved && resolution.shouldApproveAll) options.autoApprove = true;
    }
  }

  const verdict: AuthorizationVerdict = { executable: new Set(), denied: new Map() };
  const deniedBy = new Map<Denial["deniedBy"], string[]>();
  for (const entry of decided) {
    const answer = answers.get(entry.toolCall);
    // An approval may carry edited arguments: the policies judge what will
    // actually run, so a DENY matching the edited arguments still binds.
    const decision = answer
      ? decideToolCall({ ...entry.input, args: entry.toolCall.args ?? {}, answer })
      : entry.decision;
    if (decision.verdict === "allow") {
      verdict.executable.add(entry.toolCall);
    } else if (decision.verdict === "deny") {
      verdict.denied.set(entry.toolCall, deniedToolResult(entry.toolCall.name, decision));
      deniedBy.set(decision.deniedBy, [...(deniedBy.get(decision.deniedBy) ?? []), entry.toolCall.name]);
    } else {
      throw new Error(`Tool call "${entry.toolCall.name}" left unanswered by the approval gate`);
    }
  }

  for (const [rail, names] of deniedBy) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message:
        rail === "user"
          ? `Tool execution rejected: ${names.join(", ")}`
          : rail === "unattended"
            ? `Unattended run: approval for ${names.join(", ")} denied automatically`
            : `Tool call denied (${rail}): ${names.join(", ")}`,
    });
  }
  return verdict;
}
