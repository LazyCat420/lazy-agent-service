import type {
  TeamMember,
  OrchestratorContext,
  OrchestratorSpawnParams,
  SubAgentResult,
} from "../../../types/orchestrator.ts";
import type { TopologyRouter, ContinueSubAgentCallback, TopologyConfig } from "../TopologyRouter.ts";
import { buildToolCallFallbackSummary } from "../SubAgentResultBuilder.ts";
import {
  resolveSiblingInstances,
  selectInstanceForMember,
} from "../InstanceResolver.ts";
import logger from "../../../utils/logger.ts";
import { GitWorktreeHelper } from "../GitWorktreeHelper.ts";

/**
 * Sequential Router — Serial Pipeline (SP)
 *
 * Paper: "Chain-of-Thought Prompting Elicits Reasoning in
 * Large Language Models" (arxiv.org/abs/2201.11903)
 *
 * Inspired by CoT's step-by-step decomposition, but extended
 * from single-prompt reasoning to multi-agent orchestration.
 * Each sub-agent receives accumulated prior outputs as context.
 *
 */
export class SequentialRouter implements TopologyRouter {
  async execute(
    teamName: string,
    members: TeamMember[],
    orchestratorContext: OrchestratorContext,
    spawnSubAgent: (
      assignment: OrchestratorSpawnParams,
    ) => Promise<SubAgentResult | { error: string }>,
    _continueSubAgent?: ContinueSubAgentCallback,
    _topologyConfig?: TopologyConfig,
  ): Promise<(SubAgentResult | { error: string })[]> {
    const { providerName, resolvedModel } = orchestratorContext;
    logger.info(
      `[SequentialRouter] Starting sequential team execution of ${members.length} member(s)...`,
    );

    const results: (SubAgentResult | { error: string })[] = [];
    let accumulatedContext = "";

    for (let index = 0; index < members.length; index++) {
      const member = members[index];
      logger.info(
        `[SequentialRouter] Running step ${index + 1}/${members.length}: ${member.description}`,
      );

      // 1. Re-resolve instances per step (availability changes between sequential steps)
      const resolvedSiblings = await resolveSiblingInstances(
        { providerName, resolvedModel },
        "SequentialRouter",
      );
      const { assignedProvider, assignedModel } = selectInstanceForMember(
        member,
        resolvedSiblings,
        { providerName, resolvedModel },
      );


      // 2. Prepare step prompt by prepending accumulated context from all prior steps
      const basePrompt = member.prompt;
      const stepPrompt = accumulatedContext
        ? `--- PREVIOUS STEPS RESULTS ---\n${accumulatedContext}\n\n--- YOUR TASK ---\n${basePrompt}`
        : basePrompt;

      const assignment: OrchestratorSpawnParams = {
        description: member.description,
        prompt: stepPrompt,
        files: member.files,
        model: member.model,
        agent: member.agent,
        assignedProvider,
        assignedModel,
        agentIndex: index,
        teamSize: members.length,
        orchestratorContext,
      };

      // 3. Spawn and wait for this sub-agent to finish
      const spawnResult = await spawnSubAgent(assignment);
      results.push(spawnResult);

      if ("error" in spawnResult) {
        logger.error(
          `[SequentialRouter] Step ${index + 1} failed: ${spawnResult.error}. Aborting sequence.`,
        );
        break;
      }

      if (spawnResult.status === "failed") {
        logger.error(
          `[SequentialRouter] Step ${index + 1} failed. Aborting sequence.`,
        );
        break;
      }

      // 4. Merge changes back to main branch so subsequent worktrees inherit them (only if files changed)
      const hasFileChanges =
        spawnResult.status === "completed" &&
        spawnResult.agent_id &&
        spawnResult.diff;

      if (hasFileChanges) {
        const subAgentId = spawnResult.agent_id!;
        const branchName = `orchestrator/${subAgentId}`;
        const workspaceRoot = GitWorktreeHelper.getDefaultWorkspaceRoot(
          orchestratorContext.workspaceRoot ?? undefined,
        );
        const repositoryPath = GitWorktreeHelper.resolveRepositoryPath(
          workspaceRoot,
          member.files || [],
        );

        logger.info(
          `[SequentialRouter] Merging branch ${branchName} back into main repo`,
        );
        const mergeResult = await GitWorktreeHelper.mergeWorktree(
          repositoryPath,
          branchName,
          `chore(sequence): merge work from sequential sub-agent ${subAgentId}`,
        );

        if (mergeResult.error) {
          const errorMessage = `Failed to merge branch for ${subAgentId}: ${mergeResult.error}`;
          logger.error(`[SequentialRouter] ${errorMessage}`);
          return [...results, { error: errorMessage }];
        }
      } else if (spawnResult.status === "completed") {
        logger.info(
          `[SequentialRouter] No file changes from step ${index + 1} — skipping merge step`,
        );
      }

      // 5. Accumulate text result for subsequent agents (append, not overwrite)
      const stepOutput = spawnResult.result || buildToolCallFallbackSummary(spawnResult) || spawnResult.summary;
      const stepSummaryBlock = `Step ${index + 1} (${member.description}):\n${stepOutput}`;
      accumulatedContext = accumulatedContext
        ? `${accumulatedContext}\n\n---\n\n${stepSummaryBlock}`
        : stepSummaryBlock;
    }

    return results;
  }
}
