import PlanningModeService from "../../PlanningModeService.ts";
import { randomUUID } from "node:crypto";
import { pendingApprovals } from "../../ApprovalRegistry.ts";
import { pendingApprovalStore } from "../../PendingApprovalStore.ts";
import PromptLocaleService from "../../PromptLocaleService.ts";
import logger from "../../../utils/logger.ts";
import {
  decideToolCall,
  isDeniedToolResult,
  type AuthorizationInput,
} from "../../ToolAuthorization.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  TOOL_NAMES,
} from "@rodrigo-barraza/utilities-library/taxonomy";

import { finalizePassTracker } from "./TrackerFinalizer.ts";

import type AgenticLoopState from "../../AgenticLoopState.ts";
import type BaseAgenticHarness from "../BaseAgenticHarness.ts";
import type {
  ToolCall,
  ToolResult,
  ToolSchema,
  PassState,
  ConversationMessage,
  AgenticContext,
  AgenticOptions,
  EmitFunction,
} from "../types.ts";

/**
 * PlanModeController — manages plan mode state transitions during the agentic loop.
 *
 * Handles:
 *   - Blocking unauthorized tool calls during planning mode
 *   - Processing exit_plan_mode (proposal emission + user approval gate)
 *   - Entering/exiting plan mode based on tool calls
 *
 * Extracted from ReActHarness to allow future plan-aware harnesses
 * to reuse the same plan lifecycle without duplicating the logic.
 */

const PLAN_APPROVAL_TIMEOUT_MS = 120_000;

/**
 * Filter out unauthorized tool calls during plan mode.
 * Only exit_plan_mode is allowed; all others are blocked and logged.
 */
export function blockUnauthorizedToolCalls(
  pendingToolCalls: ToolCall[],
  currentMessages: ConversationMessage[],
  pass: PassState,
  _state: AgenticLoopState,
  locale?: string,
): { allBlocked: boolean } {
  const blockedToolCalls = pendingToolCalls.filter(
    (toolCall) => toolCall.name !== TOOL_NAMES.EXIT_PLAN_MODE,
  );

  if (blockedToolCalls.length === 0) {
    return { allBlocked: false };
  }

  const blockedToolNames = blockedToolCalls
    .map((toolCall) => toolCall.name)
    .join(", ");

  logger.warn(
    `[PlanningMode] Blocked ${blockedToolCalls.length} unauthorized tool call(s): ${blockedToolNames}`,
  );

  // Remove blocked calls from the pending array
  for (const blockedCall of blockedToolCalls) {
    const index = pendingToolCalls.indexOf(blockedCall);
    if (index >= 0) pendingToolCalls.splice(index, 1);
  }

  if (pendingToolCalls.length === 0) {
    // All tool calls were blocked — add system feedback and continue loop
    if (pass.streamedText) {
      currentMessages.push({
        role: "assistant",
        content: pass.streamedText,
        ...(pass.streamedThinking && {
          thinking: pass.streamedThinking,
        }),
        ...(pass.thinkingSignature && {
          thinkingSignature: pass.thinkingSignature,
        }),
      });
    }

    currentMessages.push({
      role: "system",
      content: PromptLocaleService.get(locale || PromptLocaleService.getDefaultLocale(), "harness.planningMode.blocked", { blockedNames: blockedToolNames }),
    });

    return { allBlocked: true };
  }

  return { allBlocked: false };
}

/** Build the authorization input for the exit_plan_mode approval request. */
function buildExitPlanAuthorizationInput(
  exitPlanToolCall: ToolCall,
  planText: string,
  planSteps: string[],
  options: AgenticOptions,
): AuthorizationInput {
  return {
    name: TOOL_NAMES.EXIT_PLAN_MODE,
    args: { plan: planText, steps: planSteps },
    isAllowListed: exitPlanToolCall.isUnauthorized !== true,
    policies: options.policies ?? [],
    autoApprove: options.autoApprove === true,
    unattended: options.unattended === true,
    isApprovalRequest: true,
  };
}

/** Ask the user for plan approval, honouring an answer stored before a restart. */
async function resolvePlanApprovalByAsking(
  conversationId: string,
  planText: string,
  planSteps: string[],
): Promise<boolean> {
  // A decision the user posted for this very plan while no turn ran (a
  // restart killed the turn that proposed it) is taken instead of asking again.
  const storedPlan = (await pendingApprovalStore.listUndelivered(conversationId, "plan")).find(
    (record) => record.args.plan === planText,
  );
  const takenStored = storedPlan ? await pendingApprovalStore.markDelivered(storedPlan.id) : false;
  if (!takenStored) {
    // Record the plan durably before waiting on its card (restart-safe, exactly-once).
    await pendingApprovalStore.cancelPending(conversationId, "superseded", ["plan"]);
    const batchId = randomUUID();
    await pendingApprovalStore.create([
      {
        kind: "plan",
        conversationId,
        batchId,
        itemId: `plan-${batchId}`,
        position: 0,
        name: TOOL_NAMES.EXIT_PLAN_MODE,
        args: { plan: planText, steps: planSteps },
        argsSchema: null,
      },
    ]);
  }
  return takenStored
    ? storedPlan?.decision?.decision === "allow"
    : await new Promise<boolean>((resolve) => {
      const timeoutId = setTimeout(() => {
        pendingApprovals.delete(conversationId);
        void pendingApprovalStore.cancelPending(conversationId, "timeout", ["plan"]);
        resolve(false);
      }, PLAN_APPROVAL_TIMEOUT_MS);

      const existingApproval = pendingApprovals.get(conversationId);
      if (existingApproval) {
        existingApproval.resolve(false as never);
        pendingApprovals.delete(conversationId);
      }

      pendingApprovals.set(conversationId, {
        resolve: (value: boolean) => {
          clearTimeout(timeoutId);
          pendingApprovals.delete(conversationId);
          resolve(value);
        },
        type: "plan",
      });
    });
}

/** Emit the rejection status and the done event for a refused plan. */
function emitPlanRejection(
  context: AgenticContext,
  state: AgenticLoopState,
  emit: EmitFunction,
  options: AgenticOptions,
): void {
  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: PromptLocaleService.get((options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale(), "harness.planningMode.rejectionStatus"),
  });
  emit({
    type: SERVER_SENT_EVENT_TYPES.DONE,
    usage: state.overallUsage,
    totalTime:
      (performance.now() - (context.requestStart ?? performance.now())) /
      1000,
  });
}

/** Inject the approved plan text into the exit_plan_mode tool result. */
function injectApprovedPlanResult(
  exitResult: ToolResult,
  planText: string,
  options: AgenticOptions,
): void {
  exitResult.result = {
    isApproved: true,
    message: `${PromptLocaleService.get((options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale(), "harness.planningMode.approvalResult")}\n\n${planText}`,
  };
}

/** Reset plan-mode state and emit the exited status. */
function exitPlanModeState(
  state: AgenticLoopState,
  currentMessages: ConversationMessage[],
  emit: EmitFunction,
): void {
  state.planModeActive = false;
  state.planModeText = "";
  PlanningModeService.stripPlanningInstruction(currentMessages);
  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.PLAN_MODE_EXITED,
  });
}

/**
 * Handle the exit_plan_mode tool call: emit the plan proposal,
 * wait for user approval, and transition out of plan mode.
 */
export async function handleExitPlanMode(
  exitPlanToolCall: ToolCall,
  pass: PassState,
  toolResults: ToolResult[],
  currentMessages: ConversationMessage[],
  context: AgenticContext,
  state: AgenticLoopState,
): Promise<{ shouldContinueLoop: boolean }> {
  const { options, emit, signal, conversationId } = context;

  const planText = state.planModeText.trim() || pass.streamedText.trim();
  const planSteps = PlanningModeService.extractSteps(planText);

  // The plan is an approval request: it follows the same precedence as any
  // tool call. A gate denial of this exit_plan_mode call, a DENY policy, or
  // being off the allow-list rejects the plan; autoApprove only answers the
  // ask; an unattended run without autoApprove rejects it instead of waiting.
  const exitResult = toolResults.find(
    (result) =>
      result.id === exitPlanToolCall.id ||
      result.name === TOOL_NAMES.EXIT_PLAN_MODE,
  );
  const authorizationInput = buildExitPlanAuthorizationInput(
    exitPlanToolCall,
    planText,
    planSteps,
    options,
  );
  const gateDenial = isDeniedToolResult(exitResult?.result) ? exitResult.result : null;
  const decision = decideToolCall(authorizationInput);

  logger.info(
    `[PlanningMode] exit_plan_mode called — planText=${planText.length} chars, steps=${planSteps.length}, verdict=${gateDenial ? `deny (${gateDenial.error})` : `${decision.verdict} (${decision.reason})`}`,
  );

  emit({
    type: "plan_proposal",
    plan: planText,
    steps: planSteps,
    autoApproved: !gateDenial && decision.verdict === "allow",
  });

  let planApproved: boolean;
  if (gateDenial || decision.verdict !== "ask") {
    planApproved = !gateDenial && decision.verdict === "allow";
    logger.info(
      `[PlanningMode] Plan ${planApproved ? "approved" : "rejected"} without asking: ${gateDenial?.message ?? decision.reason}`,
    );
  } else {
    const answeredYes = await resolvePlanApprovalByAsking(
      conversationId,
      planText,
      planSteps,
    );
    planApproved =
      decideToolCall({
        ...authorizationInput,
        answer: { decision: answeredYes ? "allow" : "deny" },
      }).verdict === "allow";
  }

  if (!planApproved || signal?.aborted) {
    emitPlanRejection(context, state, emit, options);
    return { shouldContinueLoop: false };
  }

  // Inject approved plan text into the exit_plan_mode result
  if (exitResult) {
    injectApprovedPlanResult(exitResult, planText, options);
  }

  exitPlanModeState(state, currentMessages, emit);

  return { shouldContinueLoop: true };
}

/** Check if any tool calls enter plan mode and apply the transition. */
export async function checkForPlanModeEntry(
  executedToolCalls: ToolCall[],
  currentMessages: ConversationMessage[],
  state: AgenticLoopState,
  emit: EmitFunction,
  locale?: string,
): Promise<void> {
  const hasEnterPlanMode = executedToolCalls.some(
    (toolCall) => toolCall.name === TOOL_NAMES.ENTER_PLAN_MODE,
  );

  if (hasEnterPlanMode) {
    state.planModeActive = true;
    state.planModeText = "";
    await PlanningModeService.injectPlanningInstruction(currentMessages, locale);
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.PLAN_MODE_ENTERED,
    });
  }
}

const MAX_PLANNING_ITERATIONS = 10;

/** Push an assistant message carrying the pass's text/thinking. */
function pushPlanningAssistantTurn(
  currentMessages: ConversationMessage[],
  pass: PassState,
): void {
  currentMessages.push({
    role: "assistant",
    content: pass.streamedText,
    ...(pass.streamedThinking.trim() && {
      thinking: pass.streamedThinking.trim(),
    }),
    ...(pass.thinkingSignature && {
      thinkingSignature: pass.thinkingSignature,
    }),
  });
}

/** Run one planning-phase model pass and record its tracker/finalization. */
async function runPlanningModelPass(
  harness: BaseAgenticHarness,
  currentMessages: ConversationMessage[],
  planPassOptions: AgenticOptions,
  allowedPlanToolNames: Set<string>,
  planningIteration: number,
  context: AgenticContext,
): Promise<PassState> {
  const pass = harness.createPassState(planPassOptions);
  const requestIdBase =
    context.requestId || context.agentConversationId || randomUUID();
  const passRequestId = `${requestIdBase}-plan-${planningIteration}`;
  pass.requestId = passRequestId;
  harness.registerTrackerRequest(passRequestId);

  const stream = await harness.createProviderStream(currentMessages, planPassOptions);
  await harness.consumeStream(stream, pass, allowedPlanToolNames);

  finalizePassTracker(pass, passRequestId);
  harness.logIteration(pass, currentMessages);
  harness.emitGenerationProgress();
  harness.emitUsageUpdate();
  return pass;
}

interface PlanningExitParams {
  harness: BaseAgenticHarness;
  pass: PassState;
  exitPlanToolCall: ToolCall;
  currentMessages: ConversationMessage[];
  context: AgenticContext;
  state: AgenticLoopState;
  label: string;
}

/** Handle an exit_plan_mode call during the planning phase. */
async function approvePlanningExit(
  params: PlanningExitParams,
): Promise<boolean> {
  const { harness, pass, exitPlanToolCall, currentMessages, context, state, label } = params;
  const results: ToolResult[] = [
    {
      name: exitPlanToolCall.name,
      id: exitPlanToolCall.id || "",
      result: {},
    },
  ];

  const { shouldContinueLoop } = await handleExitPlanMode(
    exitPlanToolCall,
    pass,
    results,
    currentMessages,
    context,
    state,
  );

  if (!shouldContinueLoop) return false;

  currentMessages.push({
    role: "assistant",
    content: pass.streamedText || "",
    ...(pass.streamedThinking.trim() && {
      thinking: pass.streamedThinking.trim(),
    }),
    ...(pass.thinkingSignature && {
      thinkingSignature: pass.thinkingSignature,
    }),
    toolCalls: [
      {
        id: exitPlanToolCall.id || null,
        name: exitPlanToolCall.name,
        args: exitPlanToolCall.args,
        result: results[0].result,
      },
    ],
  });

  logger.info(
    `[${label}] Plan approved — entering the branching loop with ${harness["tools"].finalTools.length} tool(s).`,
  );
  return true;
}

/** Block and report unauthorized tool calls during the planning phase. */
function blockPlanningToolCalls(
  currentMessages: ConversationMessage[],
  pass: PassState,
  options: AgenticOptions,
  unauthorizedCalls: ToolCall[],
  label: string,
): void {
  const blockedNames = unauthorizedCalls
    .map((toolCall) => toolCall.name)
    .join(", ");
  logger.warn(
    `[${label}] Planning phase: blocked ${unauthorizedCalls.length} unauthorized tool call(s): [${blockedNames}]`,
  );
  if (pass.streamedText) {
    pushPlanningAssistantTurn(currentMessages, pass);
  }
  currentMessages.push({
    role: "system",
    content: PromptLocaleService.get((options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale(), "harness.planningMode.blocked", { blockedNames }),
  });
}

/**
 * Pre-loop planning phase shared by the branching strategies (Tree of
 * Thoughts, Graph of Thoughts): the model may only call exit_plan_mode until
 * its plan is approved through `handleExitPlanMode`.
 */
export async function runPlanningPhase(
  harness: BaseAgenticHarness,
  currentMessages: ConversationMessage[],
  label: string,
): Promise<{ planApproved: boolean }> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const tools = harness["tools"];
  const { options, project, agent, username, signal } = context;

  await PlanningModeService.injectPlanningInstruction(currentMessages);

  const planModeTools = tools.finalTools.filter(
    (tool: ToolSchema) => tool.name === TOOL_NAMES.EXIT_PLAN_MODE,
  );
  const allowedPlanToolNames = new Set(
    planModeTools.map((tool: ToolSchema) => tool.name),
  );
  const planPassOptions: AgenticOptions = {
    ...options,
    project,
    agent,
    username,
    tools: planModeTools,
  };

  logger.info(`[${label}] Planning phase started — model will plan before branching.`);

  let planningIteration = 0;
  while (planningIteration < MAX_PLANNING_ITERATIONS) {
    planningIteration++;

    if (signal?.aborted) return { planApproved: false };

    const pass = await runPlanningModelPass(
      harness,
      currentMessages,
      planPassOptions,
      allowedPlanToolNames,
      planningIteration,
      context,
    );

    if (signal?.aborted) return { planApproved: false };

    const exitPlanToolCall = pass.pendingToolCalls.find(
      (toolCall) => toolCall.name === TOOL_NAMES.EXIT_PLAN_MODE,
    );

    if (exitPlanToolCall) {
      const planApproved = await approvePlanningExit({
        harness,
        pass,
        exitPlanToolCall,
        currentMessages,
        context,
        state,
        label,
      });
      return { planApproved };
    }

    const unauthorizedCalls = pass.pendingToolCalls.filter(
      (toolCall) => toolCall.name !== TOOL_NAMES.EXIT_PLAN_MODE,
    );
    if (unauthorizedCalls.length > 0) {
      blockPlanningToolCalls(currentMessages, pass, options, unauthorizedCalls, label);
      continue;
    }

    if (pass.streamedText || pass.streamedThinking.trim()) {
      pushPlanningAssistantTurn(currentMessages, pass);
      continue;
    }

    logger.warn(
      `[${label}] Planning phase iteration ${planningIteration}: empty output. Aborting planning phase.`,
    );
    return { planApproved: false };
  }

  logger.warn(
    `[${label}] Planning phase exhausted ${MAX_PLANNING_ITERATIONS} iterations without exit_plan_mode call.`,
  );
  return { planApproved: false };
}
