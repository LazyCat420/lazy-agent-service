// ────────────────────────────────────────────────────────────
// OrchestratorPrompt — System Prompt Addendum for Orchestrator Mode
// ────────────────────────────────────────────────────────────
// Injected into the CODING persona's system prompt when orchestrator
// tools (team_create, send_message, stop_agent) are available.
//
// Adapted from Claude Code's getCoordinatorSystemPrompt() with
// modifications for our git-worktree-isolated architecture.
// ────────────────────────────────────────────────────────────
import { CORE_ORCHESTRATOR_TOOLS, DEFAULT_TOPOLOGY, TOPOLOGIES, } from "@rodrigo-barraza/utilities-library/taxonomy";
import PromptLocaleService from "./PromptLocaleService.js";
export function getOrchestratorPromptAddendum({ subAgentTools = [], defaultTopology = DEFAULT_TOPOLOGY, locale = PromptLocaleService.getDefaultLocale(), } = {}) {
    const subAgentToolList = subAgentTools.length > 0
        ? [...subAgentTools].sort().join(", ")
        : PromptLocaleService.get(locale, "orchestrator.defaultSubAgentToolList");
    const defHierarchical = defaultTopology === TOPOLOGIES.HIERARCHICAL ? " (default)" : "";
    const defAggregation = defaultTopology === TOPOLOGIES.HIERARCHICAL_AGGREGATION ? " (default)" : "";
    const defSequential = defaultTopology === TOPOLOGIES.SEQUENTIAL ? " (default)" : "";
    const defPeerToPeer = defaultTopology === TOPOLOGIES.PEER_TO_PEER
        ? " (default)"
        : "";
    const defTournament = defaultTopology === TOPOLOGIES.TOURNAMENT ? " (default)" : "";
    const defCriticLoop = defaultTopology === TOPOLOGIES.CRITIC_LOOP ? " (default)" : "";
    const defDivideAndConquer = defaultTopology === TOPOLOGIES.DIVIDE_AND_CONQUER ? " (default)" : "";
    const defMcts = defaultTopology === TOPOLOGIES.MCTS ? " (default)" : "";
    const templateVariables = {
        subAgentToolList,
        defHierarchical,
        defAggregation,
        defSequential,
        defPeerToPeer,
        defTournament,
        defCriticLoop,
        defDivideAndConquer,
        defMcts,
    };
    const sectionKeys = [
        "orchestrator.header",
        "orchestrator.yourRole",
        "orchestrator.yourTools",
        "orchestrator.createTeamGuidance",
        "orchestrator.subAgentResults",
        "orchestrator.subAgentCapabilities",
        "orchestrator.taskWorkflow",
        "orchestrator.concurrency",
        "orchestrator.verification",
        "orchestrator.handlingFailures",
        "orchestrator.stoppingAgents",
        "orchestrator.synthesize",
        "orchestrator.purposeStatement",
        "orchestrator.goodExamples",
        "orchestrator.badExamples",
        "orchestrator.continueVsSpawn",
        "orchestrator.promptTips",
    ];
    return sectionKeys
        .map((key) => PromptLocaleService.get(locale, key, templateVariables))
        .join("\n\n");
}
/*
 * Orchestrator-only tool names derived from the canonical taxonomy constant.
 * Sub-agents cannot spawn sub-sub-agents (prevents recursion).
 */
export const ORCHESTRATOR_ONLY_TOOLS = [...CORE_ORCHESTRATOR_TOOLS];
//# sourceMappingURL=OrchestratorPrompt.js.map