import type {
  TeamMember,
  OrchestratorContext,
  OrchestratorSpawnParams,
  SubAgentResult,
} from "../../../types/orchestrator.ts";
import type { TopologyRouter, ContinueSubAgentCallback, TopologyConfig } from "../TopologyRouter.ts";
import {
  resolveSiblingInstances,
  selectInstanceForMember,
} from "../InstanceResolver.ts";
import { getProvider } from "../../../providers/index.ts";
import logger from "../../../utils/logger.ts";
import { buildToolCallFallbackSummary } from "../SubAgentResultBuilder.ts";
import RequestLogger from "../../RequestLogger.ts";
import PromptLocaleService from "../../PromptLocaleService.ts";
import { getErrorMessage } from "../../../utils/ErrorHelpers.ts";

const DEFAULT_MAXIMUM_DEPTH = 3;
const DEFAULT_BRANCH_FACTOR = 3;
const MAXIMUM_EVALUATION_CHARACTERS = 100_000;
const DEFAULT_EXPLORATION_WEIGHT = 1.41;

export interface MCTSConfig {
  branchFactor: number;
  maximumDepth: number;
  explorationWeight: number;
  searchIterations: number;
}

function resolveMCTSConfig(
  topologyConfig: TopologyConfig | undefined,
  memberCount: number,
): MCTSConfig {
  const branchFactor = Math.min(
    Math.max(
      1,
      Number(topologyConfig?.branchFactor) || DEFAULT_BRANCH_FACTOR,
    ),
    Math.max(memberCount, 2),
  );
  const maximumDepth = Math.max(
    1,
    Number(topologyConfig?.maxDepth) || DEFAULT_MAXIMUM_DEPTH,
  );
  const explorationWeight = Math.max(
    0,
    Number(topologyConfig?.explorationWeight) || DEFAULT_EXPLORATION_WEIGHT,
  );
  const searchIterations = Math.max(
    1,
    Number(topologyConfig?.searchIterations) || maximumDepth,
  );

  return { branchFactor, maximumDepth, explorationWeight, searchIterations };
}

export interface MCTSTreeNode {
  nodeIndex: number;
  depth: number;
  branchIndex: number;
  result: SubAgentResult;
  score: number;
  visitCount: number;
  parentNodeIndex: number | null;
  childNodeIndices: number[];
  isExpanded: boolean;
  evaluationFeedback: string;
}

function truncateResultOutput(output: string, maximumCharacters: number): string {
  if (output.length <= maximumCharacters) return output;
  const truncatedOutput = output.slice(0, maximumCharacters);
  return `${truncatedOutput}\n\n[... truncated — output exceeded ${maximumCharacters.toLocaleString()} character budget]`;
}

export function buildEvaluationPrompt(
  originalTask: string,
  candidateResults: { branchIndex: number; output: string }[],
  currentDepth: number,
  maximumDepth: number,
): string {
  const characterBudgetPerCandidate = Math.floor(
    MAXIMUM_EVALUATION_CHARACTERS / Math.max(candidateResults.length, 1),
  );

  const candidateSections = candidateResults.map((candidate) => {
    const truncatedOutput = truncateResultOutput(candidate.output, characterBudgetPerCandidate);
    return `### Branch ${candidate.branchIndex + 1}\n${truncatedOutput}`;
  });

  return [
    PromptLocaleService.get("en", "routers.mcts.evaluator"),
    `This is depth ${currentDepth} of ${maximumDepth}.`,
    "",
    "## Original Task",
    "",
    originalTask,
    "",
    "## Candidate Solutions",
    "",
    candidateSections.join("\n\n---\n\n"),
    "",
    "## Instructions",
    "",
    PromptLocaleService.get("en", "routers.mcts.evaluateInstruction"),
    "",
    PromptLocaleService.get("en", "routers.mcts.completeCheck"),
    "",
    PromptLocaleService.get("en", "routers.mcts.responseFormat"),
    "",
    "```json",
    "{",
    `  "scores": [0.85, 0.72, 0.91],`,
    `  "bestBranchIndex": 2,`,
    `  "isComplete": false,`,
    `  "feedback": "Overall assessment of the candidate pool.",`,
    `  "branchFeedback": ["Branch 1 strengths/weaknesses...", "Branch 2 strengths/weaknesses...", "Branch 3 strengths/weaknesses..."]`,
    "}",
    "```",
  ].join("\n");
}

export interface EvaluationResult {
  scores: number[];
  bestBranchIndex: number;
  isComplete: boolean;
  feedback: string;
  branchFeedback: string[];
}

export function parseEvaluationResponse(responseText: string, branchCount: number): EvaluationResult {
  let cleanedResponse = responseText.trim();
  cleanedResponse = cleanedResponse.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");

  const defaultResult: EvaluationResult = {
    scores: new Array(branchCount).fill(0.5),
    bestBranchIndex: 0,
    isComplete: false,
    feedback: "",
    branchFeedback: new Array(branchCount).fill(""),
  };

  function extractFromParsed(parsed: Record<string, unknown>): EvaluationResult {
    const scores = Array.isArray(parsed.scores)
      ? (parsed.scores as unknown[]).map((score: unknown) => Math.max(0, Math.min(1, Number(score) || 0)))
      : new Array(branchCount).fill(0.5);

    const bestBranchIndex = typeof parsed.bestBranchIndex === "number"
      ? Math.max(0, Math.min(branchCount - 1, parsed.bestBranchIndex))
      : scores.indexOf(Math.max(...scores));

    const branchFeedback = Array.isArray(parsed.branchFeedback)
      ? (parsed.branchFeedback as unknown[]).map((feedbackItem: unknown) =>
        typeof feedbackItem === "string" ? feedbackItem : "",
      )
      : new Array(branchCount).fill(typeof parsed.feedback === "string" ? parsed.feedback : "");

    return {
      scores,
      bestBranchIndex,
      isComplete: Boolean(parsed.isComplete),
      feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
      branchFeedback,
    };
  }

  try {
    const parsed = JSON.parse(cleanedResponse) as Record<string, unknown>;
    return extractFromParsed(parsed);
  } catch {
    logger.warn("[MCTSRouter] Failed to parse evaluation JSON — attempting extraction");

    const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const extracted = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        return extractFromParsed(extracted);
      } catch {
        // Fallback exhausted
      }
    }

    return defaultResult;
  }
}

/**
 * Upper Confidence Bound applied to Trees (UCT) — balances exploitation
 * (high-scoring nodes) with exploration (under-visited nodes).
 * Formula: V(s) + w * sqrt(ln(N(parent)) / N(s))
 */
export function computeUpperConfidenceBound(
  nodeScore: number,
  nodeVisitCount: number,
  parentVisitCount: number,
  explorationWeight: number,
): number {
  if (nodeVisitCount === 0) return Infinity;
  return nodeScore + explorationWeight * Math.sqrt(
    Math.log(parentVisitCount) / nodeVisitCount,
  );
}

/**
 * Walks up the parent chain from a leaf node, updating each ancestor's
 * score with a running average: V(s) = (V_old * (N-1) + reward) / N
 */
export function backpropagateScores(
  allTreeNodes: MCTSTreeNode[],
  leafNodeIndex: number,
  reward: number,
): void {
  let currentIndex: number | null = leafNodeIndex;

  while (currentIndex !== null && currentIndex >= 0 && currentIndex < allTreeNodes.length) {
    const currentNode: MCTSTreeNode = allTreeNodes[currentIndex];
    currentNode.visitCount += 1;
    currentNode.score = (currentNode.score * (currentNode.visitCount - 1) + reward) / currentNode.visitCount;
    currentIndex = currentNode.parentNodeIndex;
  }
}

/**
 * UCB1-guided tree traversal from root children to the most promising
 * unexpanded leaf. At each level, selects the child with the highest
 * UCB score and descends. If the selected node is unexpanded and within
 * depth limits, it is returned. If fully expanded, descends into its
 * children. Falls back to siblings when a subtree is exhausted.
 */
export function selectNodeToExpand(
  allTreeNodes: MCTSTreeNode[],
  candidateIndices: number[],
  explorationWeight: number,
  maximumDepth: number,
): number | null {
  if (candidateIndices.length === 0) return null;

  const totalSiblingVisits = candidateIndices.reduce(
    (sum, nodeIndex) => sum + allTreeNodes[nodeIndex].visitCount, 0,
  );

  const rankedCandidates = [...candidateIndices]
    .map((nodeIndex) => ({
      nodeIndex,
      ucbScore: computeUpperConfidenceBound(
        allTreeNodes[nodeIndex].score,
        allTreeNodes[nodeIndex].visitCount,
        Math.max(totalSiblingVisits, 1),
        explorationWeight,
      ),
    }))
    .sort((candidateA, candidateB) => candidateB.ucbScore - candidateA.ucbScore);

  for (const candidate of rankedCandidates) {
    const node = allTreeNodes[candidate.nodeIndex];

    if (!node.isExpanded && node.depth < maximumDepth) {
      return candidate.nodeIndex;
    }

    if (node.isExpanded && node.childNodeIndices.length > 0) {
      const descendantResult = selectNodeToExpand(
        allTreeNodes,
        node.childNodeIndices,
        explorationWeight,
        maximumDepth,
      );
      if (descendantResult !== null) return descendantResult;
    }
  }

  return null;
}

export function buildRefinementPrompt(
  originalTask: string,
  previousBestOutput: string,
  evaluationFeedback: string,
  currentDepth: number,
  maximumDepth: number,
): string {
  return [
    PromptLocaleService.get("en", "routers.mcts.refinementContext"),
    `This is iteration ${currentDepth} of ${maximumDepth}.`,
    "",
    "## Original Task",
    "",
    originalTask,
    "",
    "## Previous Best Attempt",
    "",
    previousBestOutput,
    "",
    "## Evaluator Feedback",
    "",
    evaluationFeedback,
    "",
    "## Instructions",
    "",
    "1. Build on the previous best attempt — don't start from scratch.",
    "2. Address the evaluator's feedback specifically.",
    "3. Improve completeness, fix any identified issues, and strengthen weak areas.",
    "4. Verify your work (run tests, typecheck, etc.).",
    "5. Commit and report what you improved.",
  ].join("\n");
}

export function extractNodeOutput(result: SubAgentResult): string {
  return result.result
    || buildToolCallFallbackSummary(result)
    || result.summary;
}

/**
 * MCTS-Guided Search Router — Monte Carlo Tree Search (LATS)
 *
 * Paper: "Language Agent Tree Search Unifies Reasoning Acting and
 * Planning in Language Models" (arxiv.org/abs/2310.04406)
 *
 * Implements true MCTS with UCB1-guided node selection, parallel branch
 * expansion, LLM evaluation, and backpropagation. Unlike a linear depth
 * chain, this maintains a full tree where UCB1 decides which node to
 * expand — allowing re-visitation of previously unexplored siblings
 * when the current best path plateaus.
 *
 * See TopologyRegistry.ts → TOPOLOGY_DEFINITIONS (id: "mcts")
 * for full paper-alignment metadata and config option documentation.
 */
export class MCTSRouter implements TopologyRouter {
  private selectExpansionTargetForIteration(
    iteration: number,
    searchIterations: number,
    branchFactor: number,
    originalTask: string,
    allTreeNodes: MCTSTreeNode[],
    rootChildIndices: number[],
    explorationWeight: number,
    maximumDepth: number,
  ): {
    nodeToExpand: MCTSTreeNode | null;
    expansionPrompt: string;
    expansionDepth: number;
  } | null {
    if (iteration === 1) {
      logger.info(
        `[MCTSRouter] Iteration ${iteration}/${searchIterations}: Root expansion → ${branchFactor} branches at depth 1`,
      );
      return {
        nodeToExpand: null,
        expansionPrompt: originalTask,
        expansionDepth: 1,
      };
    }

    const selectedIndex = selectNodeToExpand(
      allTreeNodes,
      rootChildIndices,
      explorationWeight,
      maximumDepth,
    );
    if (selectedIndex === null) {
      logger.info(
        `[MCTSRouter] Iteration ${iteration}: No expandable nodes remaining — tree fully explored. Terminating.`,
      );
      return null;
    }

    const nodeToExpand = allTreeNodes[selectedIndex];
    const expansionDepth = nodeToExpand.depth + 1;
    const nodeOutput = extractNodeOutput(nodeToExpand.result);
    const expansionPrompt = buildRefinementPrompt(
      originalTask,
      nodeOutput,
      nodeToExpand.evaluationFeedback,
      nodeToExpand.depth,
      maximumDepth,
    );

    logger.info(
      `[MCTSRouter] Iteration ${iteration}/${searchIterations}: UCB1 selected node ${selectedIndex} ` +
        `(depth ${nodeToExpand.depth}, score: ${nodeToExpand.score.toFixed(2)}) → expanding to depth ${expansionDepth}`,
    );
    return { nodeToExpand, expansionPrompt, expansionDepth };
  }

  private async spawnMCTSBranches(
    referenceMember: TeamMember,
    branchFactor: number,
    iteration: number,
    searchIterations: number,
    expansionDepth: number,
    expansionPrompt: string,
    orchestratorContext: OrchestratorContext,
    spawnSubAgent: (
      assignment: OrchestratorSpawnParams,
    ) => Promise<SubAgentResult | { error: string }>,
  ): Promise<{
    branchResults: (SubAgentResult | { error: string })[];
    successfulBranches: { branchIndex: number; result: SubAgentResult }[];
  }> {
    const { providerName, resolvedModel } = orchestratorContext;
    const resolvedSiblings = await resolveSiblingInstances(
      { providerName, resolvedModel },
      "MCTSRouter",
    );
    const branchAssignments: OrchestratorSpawnParams[] = [];

    for (let branchIndex = 0; branchIndex < branchFactor; branchIndex++) {
      const { assignedProvider, assignedModel } = selectInstanceForMember(
        referenceMember,
        resolvedSiblings,
        { providerName, resolvedModel },
      );

      branchAssignments.push({
        description: `${referenceMember.description} (Iter ${iteration}, Depth ${expansionDepth}, Branch ${branchIndex + 1})`,
        prompt: expansionPrompt,
        files: referenceMember.files,
        model: referenceMember.model,
        agent: referenceMember.agent,
        assignedProvider,
        assignedModel,
        agentIndex: branchIndex,
        teamSize: branchFactor,
        round: iteration,
        totalRounds: searchIterations,
        orchestratorContext,
      });
    }

    const branchResults = await Promise.all(
      branchAssignments.map((assignment) => spawnSubAgent(assignment)),
    );
    const successfulBranches: { branchIndex: number; result: SubAgentResult }[] =
      [];
    for (let branchIndex = 0; branchIndex < branchResults.length; branchIndex++) {
      const branchResult = branchResults[branchIndex];
      if (!("error" in branchResult) && branchResult.status === "completed") {
        successfulBranches.push({ branchIndex, result: branchResult });
      }
    }
    return { branchResults, successfulBranches };
  }

  private async evaluateMCTSBranches(
    provider: NonNullable<ReturnType<typeof getProvider>>,
    teamName: string,
    iteration: number,
    expansionDepth: number,
    maximumDepth: number,
    originalTask: string,
    successfulBranches: { branchIndex: number; result: SubAgentResult }[],
    nodeToExpand: MCTSTreeNode | null,
    orchestratorContext: OrchestratorContext,
  ): Promise<EvaluationResult> {
    const { providerName, resolvedModel } = orchestratorContext;
    const candidateOutputs = successfulBranches.map((branch) => ({
      branchIndex: branch.branchIndex,
      output: extractNodeOutput(branch.result),
    }));

    const evaluationPrompt = buildEvaluationPrompt(
      originalTask,
      candidateOutputs,
      expansionDepth,
      maximumDepth,
    );

    try {
      const evaluationStartMs = performance.now();
      const evaluationMessages: Array<{
        role: "user" | "assistant" | "system";
        content: string;
      }> = [{ role: "user", content: evaluationPrompt }];
      const evaluationResponse = await provider.generateText(
        evaluationMessages,
        resolvedModel,
        { maxTokens: 2048 },
      );

      RequestLogger.logBackgroundLlmCall({
        requestId: `${orchestratorContext.conversationId || "unknown"}-mcts-eval-i${iteration}-${teamName}`,
        endpoint: "/agent",
        operation: "orchestrator:mcts-evaluate",
        project: orchestratorContext.project || null,
        username: orchestratorContext.username || "system",
        agent: null,
        provider: providerName,
        model: resolvedModel,
        traceId: orchestratorContext.traceId || null,
        agentConversationId: orchestratorContext.agentConversationId || null,
        aiMessages: evaluationMessages,
        resultText: evaluationResponse.text || "",
        usage: evaluationResponse.usage || null,
        success: true,
        errorMessage: null,
        requestStartMs: evaluationStartMs,
        extraRequestPayload: {
          teamName,
          iteration,
          depth: expansionDepth,
          branchCount: successfulBranches.length,
          expandedNodeIndex: nodeToExpand?.nodeIndex ?? "root",
        },
      }).catch((loggingError: unknown) =>
        logger.error(
          `[MCTSRouter] Failed to log evaluation request: ${getErrorMessage(loggingError)}`,
        ),
      );

      return parseEvaluationResponse(
        evaluationResponse.text || "",
        successfulBranches.length,
      );
    } catch (evaluationError: unknown) {
      logger.error(
        `[MCTSRouter] Evaluation failed at iteration ${iteration}: ${getErrorMessage(evaluationError)}`,
      );
      return {
        scores: new Array(successfulBranches.length).fill(0.5),
        bestBranchIndex: 0,
        isComplete: false,
        feedback: "",
        branchFeedback: new Array(successfulBranches.length).fill(""),
      };
    }
  }

  private recordAndBackpropagateMCTSNodes(
    allTreeNodes: MCTSTreeNode[],
    rootChildIndices: number[],
    nodeToExpand: MCTSTreeNode | null,
    expansionDepth: number,
    successfulBranches: { branchIndex: number; result: SubAgentResult }[],
    evaluationResult: EvaluationResult,
  ): void {
    const parentIndex = nodeToExpand?.nodeIndex ?? null;
    const newChildIndices: number[] = [];

    for (
      let branchOffset = 0;
      branchOffset < successfulBranches.length;
      branchOffset++
    ) {
      const branch = successfulBranches[branchOffset];
      const nodeIndex = allTreeNodes.length;
      const perBranchFeedback =
        evaluationResult.branchFeedback[branchOffset] ||
        evaluationResult.feedback ||
        "";
      const score = evaluationResult.scores[branchOffset] ?? 0.5;

      allTreeNodes.push({
        nodeIndex,
        depth: expansionDepth,
        branchIndex: branch.branchIndex,
        result: branch.result,
        score,
        visitCount: 0,
        parentNodeIndex: parentIndex,
        childNodeIndices: [],
        isExpanded: false,
        evaluationFeedback: perBranchFeedback,
      });

      newChildIndices.push(nodeIndex);
      backpropagateScores(allTreeNodes, nodeIndex, score);
    }

    if (nodeToExpand) {
      nodeToExpand.isExpanded = true;
      nodeToExpand.childNodeIndices = newChildIndices;
    } else {
      rootChildIndices.push(...newChildIndices);
    }
  }

  private buildMCTSSearchSummaryResult(
    teamName: string,
    allTreeNodes: MCTSTreeNode[],
    allResults: (SubAgentResult | { error: string })[],
  ): SubAgentResult {
    const bestOverallNode = allTreeNodes.reduce((bestNode, currentNode) =>
      currentNode.score > bestNode.score ? currentNode : bestNode,
    );
    const treeDepthReached = Math.max(
      ...allTreeNodes.map((node) => node.depth),
    );
    const expandedNodeCount = allTreeNodes.filter(
      (node) => node.isExpanded,
    ).length;

    return {
      agent_id: `mcts-search-${teamName}-${Date.now()}`,
      description: `MCTS search summary for team "${teamName}"`,
      status: "completed",
      summary:
        `MCTS search explored ${allTreeNodes.length} nodes across ${treeDepthReached} depth levels ` +
        `(${expandedNodeCount} expanded). Best node: depth ${bestOverallNode.depth}, score ${bestOverallNode.score.toFixed(3)}`,
      result: bestOverallNode.result.result,
      toolUses: 0,
      iterations: allTreeNodes.length,
      durationMs: allResults
        .filter((result): result is SubAgentResult => !("error" in result))
        .reduce((total, result) => total + (result.durationMs || 0), 0),
      messages: [],
      diff: bestOverallNode.result.diff,
    };
  }

  async execute(
    teamName: string,
    members: TeamMember[],
    orchestratorContext: OrchestratorContext,
    spawnSubAgent: (
      assignment: OrchestratorSpawnParams,
    ) => Promise<SubAgentResult | { error: string }>,
    _continueSubAgent?: ContinueSubAgentCallback,
    topologyConfig?: TopologyConfig,
  ): Promise<(SubAgentResult | { error: string })[]> {
    const { providerName } = orchestratorContext;
    const originalTask = members[0]?.prompt || "";
    const { branchFactor, maximumDepth, explorationWeight, searchIterations } =
      resolveMCTSConfig(topologyConfig, members.length);

    logger.info(
      `[MCTSRouter] Starting MCTS search for team "${teamName}" ` +
        `(branch factor: ${branchFactor}, max depth: ${maximumDepth}, iterations: ${searchIterations})...`,
    );

    const provider = getProvider(providerName);
    if (!provider) {
      const errorMessage = `Provider "${providerName}" not found`;
      logger.error(`[MCTSRouter] ${errorMessage}`);
      return [{ error: errorMessage }];
    }

    const allTreeNodes: MCTSTreeNode[] = [];
    const allResults: (SubAgentResult | { error: string })[] = [];
    const rootChildIndices: number[] = [];

    for (let iteration = 1; iteration <= searchIterations; iteration++) {
      const target = this.selectExpansionTargetForIteration(
        iteration,
        searchIterations,
        branchFactor,
        originalTask,
        allTreeNodes,
        rootChildIndices,
        explorationWeight,
        maximumDepth,
      );
      if (!target) break;
      const { nodeToExpand, expansionPrompt, expansionDepth } = target;

      const { branchResults, successfulBranches } =
        await this.spawnMCTSBranches(
          members[0],
          branchFactor,
          iteration,
          searchIterations,
          expansionDepth,
          expansionPrompt,
          orchestratorContext,
          spawnSubAgent,
        );
      allResults.push(...branchResults);

      if (successfulBranches.length === 0) {
        logger.warn(
          `[MCTSRouter] All ${branchFactor} branches failed at iteration ${iteration} — ` +
            `${iteration === 1 ? "aborting search" : "marking node as expanded (dead end)"}`,
        );
        if (nodeToExpand) nodeToExpand.isExpanded = true;
        if (iteration === 1) break;
        continue;
      }

      logger.info(
        `[MCTSRouter] Iteration ${iteration}: Evaluating ${successfulBranches.length} successful branch(es)...`,
      );
      const evaluationResult = await this.evaluateMCTSBranches(
        provider,
        teamName,
        iteration,
        expansionDepth,
        maximumDepth,
        originalTask,
        successfulBranches,
        nodeToExpand,
        orchestratorContext,
      );

      this.recordAndBackpropagateMCTSNodes(
        allTreeNodes,
        rootChildIndices,
        nodeToExpand,
        expansionDepth,
        successfulBranches,
        evaluationResult,
      );

      const bestBranch =
        successfulBranches[evaluationResult.bestBranchIndex] ??
        successfulBranches[0];
      const bestScore =
        evaluationResult.scores[evaluationResult.bestBranchIndex] ?? 0.5;
      logger.info(
        `[MCTSRouter] Iteration ${iteration}: Best branch ${bestBranch.branchIndex + 1} ` +
          `(score: ${bestScore.toFixed(2)})` +
          `${evaluationResult.isComplete ? " — COMPLETE" : ""}`,
      );

      if (evaluationResult.isComplete) {
        logger.info(
          `[MCTSRouter] Evaluator marked solution as complete at iteration ${iteration}. Terminating search.`,
        );
        break;
      }
    }

    if (allTreeNodes.length > 0) {
      allResults.push(
        this.buildMCTSSearchSummaryResult(teamName, allTreeNodes, allResults),
      );
    }

    return allResults;
  }
}
