/**
 * Shared plumbing for the branching thought structures (Tree of Thoughts,
 * Graph of Thoughts).
 *
 * Both strategies generate N parallel reasoning branches, score them on the
 * same 4-criteria rubric, prune on a value threshold, and reuse the same
 * sandbox/validation/reflexion machinery. Everything here is behaviour the
 * two strategies already shared verbatim; the strategy files keep only what
 * differs (BFS frontier fallback and DFS siblings for ToT, synthesis for GoT).
 */
import type BaseAgenticHarness from "../BaseAgenticHarness.ts";
import type AgentHooks from "../../AgentHooks.ts";
import type AgenticLoopState from "../../AgenticLoopState.ts";
import type {
  AgenticOptions,
  BeforePromptHookContext,
  ConversationMessage,
  EmitFunction,
  PassState,
  ToolCall,
  ToolResult,
  ToolSchema,
  ValidationFeedback,
} from "../types.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  MAX_TOOL_ITERATIONS,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import logger from "../../../utils/logger.ts";
import PromptLocaleService from "../../PromptLocaleService.ts";
import { getErrorMessage } from "../../../utils/ErrorHelpers.ts";
import RequestLogger from "../../RequestLogger.ts";
import { restoreSandboxCheckpoint } from "../lifecycle/SandboxExecutor.ts";

export interface IterationPassOptions extends AgenticOptions {
  project: string;
  agent?: string | null;
  username: string;
}

export interface CriteriaScores {
  correctness: number;
  risk: number;
  efficiency: number;
  completeness: number;
}

export interface ScoredBranch {
  branchIndex: number;
  text: string;
  thinking: string;
  thinkingSignature: string;
  score: number;
  criteriaScores: CriteriaScores;
  pass: PassState;
}

export type SearchStrategy = "bfs" | "dfs";

export const MAX_CONSECUTIVE_TOOL_ERRORS = 3;
export const DEFAULT_BRANCH_COUNT = 3;
export const DEFAULT_VALUE_THRESHOLD = 5.0;
export const MAX_PROACTIVE_BACKTRACKS = 3;
export const DEFAULT_BFS_BEAM_WIDTH = 2;

export const BRANCH_STRATEGY_DESCRIPTORS = [
  "",
  "Focus on a MINIMAL approach — use the fewest tools and smallest changes possible. " +
    "Prefer precision over coverage. Choose the simplest solution that could work.",
  "Focus on a THOROUGH approach — maximize correctness and safety. " +
    "Add validation, error handling, and defensive checks even if it means more steps.",
  "Focus on an ALTERNATIVE ARCHITECTURE — if branch 1 would modify code in place, " +
    "consider creating new files. If branch 1 would iterate, consider a batch approach. " +
    "Deliberately diverge from the obvious first solution.",
  "Focus on RISK MINIMIZATION — what approach has the lowest chance of breaking " +
    "existing functionality? Prefer reversible, incremental changes over large rewrites.",
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Config resolution
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function resolveMaxIterations(clientMaxIterations: number | undefined): number {
  if (clientMaxIterations === 0) return Infinity;
  if (clientMaxIterations) return Math.min(100, Math.max(1, clientMaxIterations));
  return MAX_TOOL_ITERATIONS;
}

export function resolveBranchConfig(
  options: AgenticOptions,
): { initialBranchCount: number; valueThreshold: number } {
  const initialBranchCount = Math.min(Math.max(1, options.branchCount || DEFAULT_BRANCH_COUNT), 5);
  const valueThreshold = options.valueThreshold ?? DEFAULT_VALUE_THRESHOLD;
  return { initialBranchCount, valueThreshold };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Before-prompt hook phase (shared by both strategies)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function runBeforePromptPhase(
  harness: BaseAgenticHarness,
  currentMessages: ConversationMessage[],
  hooks: AgentHooks,
  resolvedAgentConversationId: string,
): Promise<void> {
  const context = harness["context"];
  const tools = harness["tools"];
  const { options, conversationId, traceId, project, username, agent, workspaceRoot, emit } = context;

  if (options.planFirst) {
    emit({ type: SERVER_SENT_EVENT_TYPES.STATUS, message: STATUS_MESSAGES.PLAN_MODE_ENTERED });
  }

  const hookContext: BeforePromptHookContext = {
    messages: currentMessages,
    project,
    username,
    agent,
    traceId,
    conversationId,
    agentConversationId: resolvedAgentConversationId,
    parentAgentConversationId: context.parentAgentConversationId,
    agentContext: options.agentContext,
    enabledTools: tools.resolvedEnabledTools,
    resolvedToolNames: tools.finalTools.map((tool: ToolSchema) => tool.name),
    workspaceRoot: workspaceRoot || undefined,
    workspaceEnabled: options.workspaceEnabled as boolean | undefined,
    locale: options.locale as string | undefined,
  };
  await hooks.run("beforePrompt", hookContext);

  if (hookContext._assembledSystemPrompt) {
    const assembledPrompt = hookContext._assembledSystemPrompt as string;
    context.conversationMeta = {
      ...(context.conversationMeta || {}),
      systemPrompt: assembledPrompt,
    };
    if (!options.systemPrompt) {
      options.systemPrompt = assembledPrompt;
    }
  }
  if (Array.isArray(hookContext._injectedSkills) && hookContext._injectedSkills.length > 0) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.SKILLS_INJECTED,
      skills: hookContext._injectedSkills,
    });
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Branch generation with structured diversity
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function generateBranch(
  harness: BaseAgenticHarness,
  branchIndex: number,
  totalBranches: number,
  currentMessages: ConversationMessage[],
  passOptions: IterationPassOptions,
  allowedToolNames: Set<string>,
  failedApproaches: string[] = [],
): Promise<ScoredBranch> {
  const state: AgenticLoopState = harness["state"];
  const context = harness["context"];

  const branchMessages = [...currentMessages];

  if (branchIndex > 0 || failedApproaches.length > 0) {
    const strategyDescriptor =
      BRANCH_STRATEGY_DESCRIPTORS[branchIndex % BRANCH_STRATEGY_DESCRIPTORS.length] ||
      BRANCH_STRATEGY_DESCRIPTORS[1];

    let diversityInstruction = `[BRANCH ${branchIndex + 1}/${totalBranches}] ` + strategyDescriptor;

    if (failedApproaches.length > 0) {
      const failedSummaries = failedApproaches
        .map((approach, index) => `  ${index + 1}. ${approach}`)
        .join("\n");
      diversityInstruction +=
        `\n\nThe following approach(es) have already been tried and FAILED:\n` +
        `${failedSummaries}\n` +
        `You MUST use a fundamentally different strategy.`;
    }

    branchMessages.push({
      role: "user",
      content: diversityInstruction,
    });
  }

  const pass = harness.createPassState(passOptions);
  const { agentConversationId } = context;
  const resolvedAgentConversationId = agentConversationId || "";
  const requestIdBase = context.requestId || resolvedAgentConversationId || crypto.randomUUID();
  const passRequestId = `${requestIdBase}-iter-${state.iterations}-branch-${branchIndex}`;
  pass.requestId = passRequestId;
  harness.registerTrackerRequest(passRequestId);

  const stream = await harness.createProviderStream(branchMessages, passOptions);
  await harness.consumeStream(stream, pass, allowedToolNames);

  return {
    branchIndex,
    text: pass.streamedText,
    thinking: pass.streamedThinking,
    thinkingSignature: pass.thinkingSignature,
    score: 0,
    criteriaScores: {
      correctness: 0,
      risk: 0,
      efficiency: 0,
      completeness: 0,
    },
    pass,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Branch exploration wrappers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** BFS (Algorithm 1): generate every branch in parallel, then score and rank them. */
export async function exploreBfsBranches(
  harness: BaseAgenticHarness,
  adaptiveBranchCount: number,
  currentMessages: ConversationMessage[],
  passOptions: IterationPassOptions,
  allowedToolNames: Set<string>,
  failedApproaches: string[] | undefined,
  emitSearchStrategy: SearchStrategy | undefined,
  logPrefix: string,
): Promise<{ scoredBranches: ScoredBranch[]; selectedBranch: ScoredBranch; aborted: boolean }> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const { emit, signal } = context;

  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.BRANCHING_STARTED,
    branchCount: adaptiveBranchCount,
    iteration: state.iterations,
    ...(emitSearchStrategy && { searchStrategy: emitSearchStrategy }),
  });

  const branchResults = await Promise.all(
    Array.from({ length: adaptiveBranchCount }, (_, branchIndex) =>
      generateBranch(
        harness,
        branchIndex,
        adaptiveBranchCount,
        currentMessages,
        passOptions,
        allowedToolNames,
        failedApproaches,
      ),
    ),
  );

  if (signal?.aborted) {
    return { scoredBranches: [], selectedBranch: branchResults[0], aborted: true };
  }

  state.branchesExplored += adaptiveBranchCount;
  const scoredBranches = await scoreBranchesMultiCriteria(harness, branchResults, logPrefix);
  scoredBranches.sort((branchA, branchB) => branchB.score - branchA.score);
  return { scoredBranches, selectedBranch: scoredBranches[0], aborted: false };
}

/** DFS (Algorithm 2): generate one sibling at a time, accept the first one above the threshold. */
export async function exploreDfsBranches(
  harness: BaseAgenticHarness,
  adaptiveBranchCount: number,
  valueThreshold: number,
  currentMessages: ConversationMessage[],
  passOptions: IterationPassOptions,
  allowedToolNames: Set<string>,
  failedApproachDescriptions: string[],
  logPrefix: string,
): Promise<{ scoredBranches: ScoredBranch[]; selectedBranch: ScoredBranch }> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const { emit, signal } = context;

  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.BRANCHING_STARTED,
    branchCount: adaptiveBranchCount,
    iteration: state.iterations,
    searchStrategy: "dfs",
  });

  let acceptedBranch: ScoredBranch | null = null;
  const exploredSiblings: ScoredBranch[] = [];

  for (let siblingAttempt = 0; siblingAttempt < adaptiveBranchCount; siblingAttempt++) {
    if (signal?.aborted) break;
    const branch = await generateBranch(
      harness,
      siblingAttempt,
      adaptiveBranchCount,
      currentMessages,
      passOptions,
      allowedToolNames,
      failedApproachDescriptions,
    );
    state.branchesExplored++;

    const [scoredSibling] = await scoreBranchesMultiCriteria(harness, [branch], logPrefix);
    exploredSiblings.push(scoredSibling);

    if (scoredSibling.score >= valueThreshold) {
      acceptedBranch = scoredSibling;
      logger.info(
        `${logPrefix}/DFS Sibling ${siblingAttempt + 1}/${adaptiveBranchCount} accepted (score: ${scoredSibling.score.toFixed(1)} >= threshold: ${valueThreshold})`,
      );
      break;
    }

    state.branchesBacktracked++;
    failedApproachDescriptions.push((scoredSibling.text || scoredSibling.thinking || "").slice(0, 300));
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
      branchIndex: scoredSibling.branchIndex,
      reason: "dfs_sibling_pruned",
      score: scoredSibling.score,
      threshold: valueThreshold,
      siblingAttempt: siblingAttempt + 1,
      maxSiblings: adaptiveBranchCount,
    });
    logger.info(
      `${logPrefix}/DFS Sibling ${siblingAttempt + 1}/${adaptiveBranchCount} pruned (score: ${scoredSibling.score.toFixed(1)} < threshold: ${valueThreshold})`,
    );
  }

  exploredSiblings.sort((branchA, branchB) => branchB.score - branchA.score);
  if (!acceptedBranch) {
    acceptedBranch = exploredSiblings[0];
    logger.info(
      `${logPrefix}/DFS No sibling above threshold — accepting best available (score: ${acceptedBranch.score.toFixed(1)})`,
    );
  }
  return { scoredBranches: exploredSiblings, selectedBranch: acceptedBranch };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Proactive backtracking (value-threshold pruning before execution)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function applyProactiveBacktrack(params: {
  state: AgenticLoopState;
  emit: EmitFunction;
  currentMessages: ConversationMessage[];
  options: AgenticOptions;
  localeKey: string;
  branchIndex: number;
  bestScore: number;
  threshold: number;
  extraLocaleVars?: Record<string, string>;
  logPrefix: string;
}): void {
  const {
    state,
    emit,
    currentMessages,
    options,
    localeKey,
    branchIndex,
    bestScore,
    threshold,
    extraLocaleVars,
    logPrefix,
  } = params;

  state.proactiveBacktracks++;
  state.branchesBacktracked++;

  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
    branchIndex,
    reason: "proactive_value_threshold",
    bestScore,
    threshold,
    proactiveBacktracks: state.proactiveBacktracks,
    maxProactiveBacktracks: MAX_PROACTIVE_BACKTRACKS,
  });

  logger.info(
    `${logPrefix} Proactive backtrack — best score ${bestScore.toFixed(1)} < threshold ${threshold}. Re-branching (${state.proactiveBacktracks}/${MAX_PROACTIVE_BACKTRACKS}).`,
  );

  currentMessages.push({
    role: "system",
    content: PromptLocaleService.get(
      (options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale(),
      localeKey,
      {
        ...extraLocaleVars,
        bestScore: bestScore.toFixed(1),
        threshold: String(threshold),
      },
    ),
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Validation-failure / synthesis handling
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function formatValidationErrorBlock(validationFeedback: ValidationFeedback[]): string {
  return validationFeedback
    .map((feedback) => `### ${feedback.filePath} (${feedback.validatorType})\n${feedback.rawOutput}`)
    .join("\n\n");
}

/** Roll the workspace back to the pre-execution checkpoint when one exists. */
export function restoreCheckpointIfPresent(
  workspaceRoot: string | null | undefined,
  checkpointReference: string | null,
  emit: EmitFunction,
): void {
  if (checkpointReference) {
    restoreSandboxCheckpoint(workspaceRoot, checkpointReference, emit);
  }
}

/** Assistant message echoing the executed tool calls with their results. */
export function buildToolCallAssistantMessage(
  pass: PassState,
  results: ToolResult[],
): ConversationMessage {
  return {
    role: "assistant",
    content: pass.streamedText || "",
    ...(pass.streamedThinking.trim() && {
      thinking: pass.streamedThinking.trim(),
    }),
    ...(pass.thinkingSignature && {
      thinkingSignature: pass.thinkingSignature,
    }),
    toolCalls: pass.pendingToolCalls.map((toolCall: ToolCall) => {
      const matchingResult = results.find((result) => result.id === toolCall.id);
      return {
        id: toolCall.id || null,
        responsesItemId: toolCall.responsesItemId || undefined,
        name: toolCall.name,
        args: toolCall.args,
        thoughtSignature: toolCall.thoughtSignature || undefined,
        reasoningItem: toolCall.reasoningItem || undefined,
        result: matchingResult ? matchingResult.result : null,
        durationMs: matchingResult?.durationMs,
      };
    }),
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Multi-criteria scoring (§2.1.2)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function formatCandidateSummaries(branches: ScoredBranch[]): string {
  return branches
    .map((branch, index) => {
      const textPreview = (branch.text || branch.thinking || "(no output)").slice(0, 500).trim();
      const toolCallCount = branch.pass.pendingToolCalls.length;
      const toolCallNames = branch.pass.pendingToolCalls.map((toolCall) => toolCall.name).join(", ");
      return (
        `[Candidate ${index + 1}] ` +
        `${toolCallCount} tool call(s)${toolCallNames ? ` (${toolCallNames})` : ""}.\n` +
        `Output: ${textPreview}`
      );
    })
    .join("\n\n");
}

export function buildScoringPrompt(branches: ScoredBranch[]): string {
  return [
    "Rate each candidate approach on 4 criteria (1-10 each):",
    "- CORRECTNESS: Will this produce the right result?",
    "- RISK: How safe is this? (10=very safe, 1=destructive)",
    "- EFFICIENCY: Does it minimize unnecessary steps?",
    "- COMPLETENESS: Does it address all parts of the task?",
    "",
    "Respond ONLY in this exact format (one line per candidate):",
    "1: correctness=8, risk=7, efficiency=6, completeness=9",
    "2: correctness=5, risk=9, efficiency=8, completeness=4",
    "",
    formatCandidateSummaries(branches),
  ].join("\n");
}

export function parseMultiCriteriaScores(scoreResponseText: string, branches: ScoredBranch[]): void {
  const linePattern =
    /(\d+)\s*:\s*correctness\s*=\s*(\d+(?:\.\d+)?)\s*,\s*risk\s*=\s*(\d+(?:\.\d+)?)\s*,\s*efficiency\s*=\s*(\d+(?:\.\d+)?)\s*,\s*completeness\s*=\s*(\d+(?:\.\d+)?)/gi;
  let lineMatch: RegExpExecArray | null;
  while ((lineMatch = linePattern.exec(scoreResponseText)) !== null) {
    const candidateIndex = parseInt(lineMatch[1], 10) - 1;
    if (candidateIndex >= 0 && candidateIndex < branches.length) {
      const criteria: CriteriaScores = {
        correctness: Math.min(10, Math.max(0, parseFloat(lineMatch[2]))),
        risk: Math.min(10, Math.max(0, parseFloat(lineMatch[3]))),
        efficiency: Math.min(10, Math.max(0, parseFloat(lineMatch[4]))),
        completeness: Math.min(10, Math.max(0, parseFloat(lineMatch[5]))),
      };
      branches[candidateIndex].criteriaScores = criteria;
      branches[candidateIndex].score =
        criteria.correctness * 0.4 +
        criteria.risk * 0.25 +
        criteria.efficiency * 0.15 +
        criteria.completeness * 0.2;
    }
  }
}

/** Single-score fallback when the judge ignored the 4-criteria format; 5 for unparsed branches. */
export function applyScoreFallbacks(scoreResponseText: string, branches: ScoredBranch[]): void {
  const hasMultiCriteriaScores = branches.some((branch) => branch.criteriaScores.correctness > 0);
  if (!hasMultiCriteriaScores) {
    const simpleScorePattern = /(\d+)\s*:\s*(\d+(?:\.\d+)?)/g;
    let simpleMatch: RegExpExecArray | null;
    while ((simpleMatch = simpleScorePattern.exec(scoreResponseText)) !== null) {
      const candidateIndex = parseInt(simpleMatch[1], 10) - 1;
      const candidateScore = parseFloat(simpleMatch[2]);
      if (
        candidateIndex >= 0 &&
        candidateIndex < branches.length &&
        candidateScore >= 0 &&
        candidateScore <= 10
      ) {
        branches[candidateIndex].score = candidateScore;
        branches[candidateIndex].criteriaScores = {
          correctness: candidateScore,
          risk: candidateScore,
          efficiency: candidateScore,
          completeness: candidateScore,
        };
      }
    }
  }
  for (const branch of branches) {
    if (branch.score === 0) {
      applyDefaultBranchScore(branch, 5);
    }
  }
}

export function applyDefaultBranchScore(branch: ScoredBranch, defaultValue: number): void {
  branch.score = defaultValue;
  branch.criteriaScores = {
    correctness: defaultValue,
    risk: defaultValue,
    efficiency: defaultValue,
    completeness: defaultValue,
  };
}

export async function scoreBranchesMultiCriteria(
  harness: BaseAgenticHarness,
  branches: ScoredBranch[],
  logPrefix: string,
): Promise<ScoredBranch[]> {
  if (branches.length <= 1) {
    if (branches[0]) {
      applyDefaultBranchScore(branches[0], 10);
    }
    return branches;
  }

  const context = harness["context"];

  try {
    const scoringMessages = [{ role: "user" as const, content: buildScoringPrompt(branches) }];
    const scoringOptions = {
      maxTokens: 200,
      temperature: 0,
      signal: AbortSignal.timeout(15_000),
    };

    let scoreResponseText = "";
    const scoringRequestStartMs = performance.now();
    const scoringStream = context.provider.generateTextStream(
      scoringMessages,
      context.resolvedModel,
      scoringOptions,
    );

    for await (const chunk of scoringStream) {
      if (typeof chunk === "string") {
        scoreResponseText += chunk;
      }
    }

    RequestLogger.logBackgroundLlmCall({
      requestId: `${context.requestId || context.agentConversationId || "unknown"}-scoring-iter-${harness["state"].iterations}`,
      endpoint: "/agent",
      operation: "agent:scoring",
      project: context.project,
      username: context.username,
      agent: context.agent || null,
      provider: context.providerName,
      model: context.resolvedModel,
      traceId: context.traceId || null,
      agentConversationId: context.agentConversationId || null,
      aiMessages: scoringMessages as Parameters<typeof RequestLogger.logBackgroundLlmCall>[0]["aiMessages"],
      resultText: scoreResponseText,
      success: true,
      errorMessage: null,
      requestStartMs: scoringRequestStartMs,
    }).catch((scoringLogError: unknown) =>
      logger.error(`${logPrefix} Failed to log scoring request: ${getErrorMessage(scoringLogError)}`),
    );

    parseMultiCriteriaScores(scoreResponseText, branches);
    applyScoreFallbacks(scoreResponseText, branches);

    logger.info(
      `${logPrefix} Branch scores: ${branches.map((branch, index) => `${index + 1}:${branch.score.toFixed(1)}`).join(", ")}`,
    );
  } catch (scoringError: unknown) {
    logger.warn(`${logPrefix} Scoring failed: ${getErrorMessage(scoringError)}. Using equal scores.`);
    for (const branch of branches) {
      applyDefaultBranchScore(branch, 5);
    }
  }

  return branches;
}
