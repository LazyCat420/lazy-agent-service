import { resolveSiblingInstances, selectInstanceForMember, } from "../InstanceResolver.js";
import logger from "../../../utils/logger.js";
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
 * See TopologyRegistry.ts → TOPOLOGY_DEFINITIONS (id: "hierarchical")
 * for full paper-alignment metadata and config option documentation.
 */
export class HierarchicalRouter {
    async execute(teamName, members, orchestratorContext, spawnSubAgent, _continueSubAgent, _topologyConfig) {
        const { providerName, resolvedModel } = orchestratorContext;
        logger.info(`[HierarchicalRouter] createTeam: batch assignment of ${members.length} sub-agent(s)...`);
        const resolvedSiblings = await resolveSiblingInstances({ providerName, resolvedModel }, "HierarchicalRouter");
        const assignments = [];
        for (let memberIndex = 0; memberIndex < members.length; memberIndex++) {
            const member = members[memberIndex];
            const { assignedProvider, assignedModel } = selectInstanceForMember(member, resolvedSiblings, { providerName, resolvedModel });
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
        const spawnPromises = assignments.map((assignment) => spawnSubAgent(assignment));
        return Promise.all(spawnPromises);
    }
}
//# sourceMappingURL=HierarchicalRouter.js.map