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
import logger from "../../../utils/logger.ts";

/**
 * Hierarchical Router — Hierarchical Parallel (HP)
 *
 * Paper: "Tree of Thoughts: Deliberate Problem Solving
 * with Large Language Models" (arxiv.org/abs/2305.10601)
 *
 * Captures ToT's parallel branching concept (multiple agents
 * explore simultaneously), but without evaluation, scoring,
 * backtracking, or structured search. A single-depth fan-out.
 *
 */
export class HierarchicalRouter implements TopologyRouter {
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
      `[HierarchicalRouter] createTeam: batch assignment of ${members.length} sub-agent(s)...`,
    );

    const resolvedSiblings = await resolveSiblingInstances(
      { providerName, resolvedModel },
      "HierarchicalRouter",
    );

    const assignments: OrchestratorSpawnParams[] = [];

    for (let memberIndex = 0; memberIndex < members.length; memberIndex++) {
      const member = members[memberIndex];
      const { assignedProvider, assignedModel } = selectInstanceForMember(
        member,
        resolvedSiblings,
        { providerName, resolvedModel },
      );

      assignments.push({
        description: member.description,
        prompt: member.prompt,
        files: member.files,
        model: member.model,
        agent: member.agent,
        assignedProvider,
        assignedModel,
        agentIndex: memberIndex,
        teamSize: members.length,
        orchestratorContext,
      });
    }

    const spawnPromises = assignments.map((assignment) =>
      spawnSubAgent(assignment),
    );
    return Promise.all(spawnPromises);
  }
}
