import { resolveSiblingInstances, selectInstanceForMember, } from "../InstanceResolver.js";
import { getProvider } from "../../../providers/index.js";
import logger from "../../../utils/logger.js";
import { buildToolCallFallbackSummary } from "../SubAgentResultBuilder.js";
import RequestLogger from "../../RequestLogger.js";
import PromptLocaleService from "../../PromptLocaleService.js";
import { getErrorMessage } from "../../../utils/ErrorHelpers.js";
const MAXIMUM_SYNTHESIS_CHARACTERS = 120_000;
const DEFAULT_LAYER_COUNT = 1;
const MAXIMUM_LAYER_COUNT = 3;
function truncateResultOutput(output, maximumCharacters) {
    if (output.length <= maximumCharacters)
        return output;
    const truncatedOutput = output.slice(0, maximumCharacters);
    return `${truncatedOutput}\n\n[... truncated — output exceeded ${maximumCharacters.toLocaleString()} character budget]`;
}
function buildSynthesisPrompt(teamName, memberResults, layerIndex, totalLayers) {
    const characterBudgetPerMember = Math.floor(MAXIMUM_SYNTHESIS_CHARACTERS / Math.max(memberResults.length, 1));
    const resultSections = memberResults.map((result, resultIndex) => {
        if ("error" in result) {
            return `### Sub-Agent #${resultIndex + 1}\n**Status:** Error\n**Error:** ${result.error}`;
        }
        const outputText = result.result
            ? truncateResultOutput(result.result, characterBudgetPerMember)
            : (buildToolCallFallbackSummary(result) || result.summary);
        return [
            `### Sub-Agent #${resultIndex + 1}: ${result.description || "unnamed"}`,
            `**Status:** ${result.status}`,
            `**Output:**\n${outputText}`,
        ].join("\n");
    });
    const layerContext = layerIndex !== undefined && totalLayers !== undefined && totalLayers > 1
        ? `\nThis is synthesis layer ${layerIndex + 1} of ${totalLayers}.\n`
        : "";
    return [
        PromptLocaleService.get("en", "routers.hierarchical.synthesizer", { teamName, layerContext }),
        PromptLocaleService.get("en", "routers.hierarchical.mergeJobDescription", { memberCount: String(memberResults.length) }),
        "",
        "## Sub-Agent Results",
        "",
        resultSections.join("\n\n---\n\n"),
        "",
        "## Instructions",
        "",
        PromptLocaleService.get("en", "routers.hierarchical.mergeInstructions"),
    ].join("\n");
}
function buildLayerContextPrefix(previousLayerSynthesis) {
    return [
        "## Previous Layer Output (Auxiliary Context)",
        "",
        "The following is the synthesized output from a previous layer of agents working on this task.",
        "Use this as additional context to inform and improve your response.",
        "",
        previousLayerSynthesis,
        "",
        "---",
        "",
    ].join("\n");
}
function checkModelDiversity(assignments) {
    if (assignments.length <= 1)
        return;
    const uniqueModelIdentifiers = new Set(assignments.map((assignment) => `${assignment.assignedProvider}:${assignment.assignedModel}`));
    if (uniqueModelIdentifiers.size === 1) {
        logger.warn(`[HierarchicalAggregationRouter] All ${assignments.length} proposers resolved to the same model ` +
            `(${assignments[0].assignedProvider}/${assignments[0].assignedModel}). ` +
            `MoA paper (Wang et al., 2024) shows diverse models significantly outperform single-proposer configurations. ` +
            `Consider assigning different models to team members for better synthesis quality.`);
    }
}
/**
 * Hierarchical Aggregation Router — Mixture-of-Agents Synthesis (MoA)
 *
 * Paper: "Mixture-of-Agents Enhances Large Language Model Capabilities"
 * (arxiv.org/abs/2406.04692)
 *
 * See TopologyRegistry.ts → TOPOLOGY_DEFINITIONS (id: "hierarchical-aggregation")
 * for full paper-alignment metadata and config option documentation.
 */
export class HierarchicalAggregationRouter {
    async execute(teamName, members, orchestratorContext, spawnSubAgent, _continueSubAgent, topologyConfig) {
        const { providerName, resolvedModel } = orchestratorContext;
        const layerCount = Math.min(Math.max(1, Number(topologyConfig?.layerCount) || DEFAULT_LAYER_COUNT), MAXIMUM_LAYER_COUNT);
        logger.info(`[HierarchicalAggregationRouter] Starting MoA for team "${teamName}" ` +
            `(${members.length} proposers, ${layerCount} layer${layerCount > 1 ? "s" : ""})...`);
        let previousLayerSynthesis = null;
        let allLayerResults = [];
        for (let layerIndex = 0; layerIndex < layerCount; layerIndex++) {
            const isFirstLayer = layerIndex === 0;
            const layerLabel = layerCount > 1 ? ` [Layer ${layerIndex + 1}/${layerCount}]` : "";
            // ── Phase 1: Parallel execution (proposer fan-out) ────────────────
            const resolvedSiblings = await resolveSiblingInstances({ providerName, resolvedModel }, "HierarchicalAggregationRouter");
            const assignments = [];
            for (let memberIndex = 0; memberIndex < members.length; memberIndex++) {
                const member = members[memberIndex];
                const { assignedProvider, assignedModel } = selectInstanceForMember(member, resolvedSiblings, { providerName, resolvedModel });
                const memberPrompt = previousLayerSynthesis
                    ? buildLayerContextPrefix(previousLayerSynthesis) + member.prompt
                    : member.prompt;
                assignments.push({
                    description: `${member.description}${layerLabel}`,
                    prompt: memberPrompt,
                    files: member.files,
                    model: member.model,
                    agent: member.agent,
                    assignedProvider,
                    assignedModel,
                    agentIndex: memberIndex,
                    teamSize: members.length,
                    round: layerIndex + 1,
                    totalRounds: layerCount,
                    orchestratorContext,
                });
            }
            if (isFirstLayer) {
                checkModelDiversity(assignments);
            }
            logger.info(`[HierarchicalAggregationRouter]${layerLabel} Spawning ${assignments.length} proposers in parallel...`);
            const spawnPromises = assignments.map((assignment) => spawnSubAgent(assignment));
            const memberResults = await Promise.all(spawnPromises);
            allLayerResults = isFirstLayer ? memberResults : [...allLayerResults, ...memberResults];
            // ── Phase 2: Synthesis pass (aggregator) ──────────────────────────
            const successfulResults = memberResults.filter((result) => !("error" in result) && result.status === "completed");
            if (successfulResults.length === 0) {
                logger.warn(`[HierarchicalAggregationRouter]${layerLabel} All ${memberResults.length} proposers failed — aborting layer`);
                break;
            }
            if (successfulResults.length === 1 && layerCount === 1) {
                logger.info(`[HierarchicalAggregationRouter]${layerLabel} Only 1 proposer succeeded — skipping synthesis`);
                return allLayerResults;
            }
            logger.info(`[HierarchicalAggregationRouter]${layerLabel} Running synthesis over ${successfulResults.length} successful proposer results...`);
            try {
                const synthesisPrompt = buildSynthesisPrompt(teamName, memberResults, layerIndex, layerCount);
                const provider = getProvider(providerName);
                if (!provider) {
                    logger.error(`[HierarchicalAggregationRouter]${layerLabel} Provider "${providerName}" not found for synthesis`);
                    break;
                }
                const synthesisStartTime = Date.now();
                const synthesisRequestStartMs = performance.now();
                const synthesisMessages = [{ role: "user", content: synthesisPrompt }];
                const synthesisResult = await provider.generateText(synthesisMessages, resolvedModel, { maxTokens: 8192 });
                const synthesisDurationMs = Date.now() - synthesisStartTime;
                RequestLogger.logBackgroundLlmCall({
                    requestId: `${orchestratorContext.conversationId || "unknown"}-synthesis-L${layerIndex + 1}-${teamName}`,
                    endpoint: "/agent",
                    operation: "orchestrator:synthesis",
                    project: orchestratorContext.project || null,
                    username: orchestratorContext.username || "system",
                    agent: null,
                    provider: providerName,
                    model: resolvedModel,
                    traceId: orchestratorContext.traceId || null,
                    agentConversationId: orchestratorContext.agentConversationId || null,
                    aiMessages: synthesisMessages,
                    resultText: synthesisResult.text || "",
                    usage: synthesisResult.usage || null,
                    success: true,
                    errorMessage: null,
                    requestStartMs: synthesisRequestStartMs,
                    extraRequestPayload: {
                        teamName,
                        layer: layerIndex + 1,
                        totalLayers: layerCount,
                        memberCount: members.length,
                        successfulCount: successfulResults.length,
                    },
                }).catch((loggingError) => logger.error(`[HierarchicalAggregationRouter]${layerLabel} Failed to log synthesis request: ${getErrorMessage(loggingError)}`));
                const synthesisSubAgentResult = {
                    agent_id: `synthesis-${teamName}-L${layerIndex + 1}-${Date.now()}`,
                    description: `Synthesis pass for team "${teamName}"${layerLabel}`,
                    status: "completed",
                    summary: `Aggregated ${successfulResults.length} sub-agent results into a unified synthesis${layerLabel}`,
                    result: synthesisResult.text,
                    toolUses: 0,
                    iterations: 1,
                    durationMs: synthesisDurationMs,
                    messages: [],
                    diff: { additions: 0, deletions: 0, files: [] },
                };
                const inputTokens = synthesisResult.usage?.inputTokens ?? 0;
                const outputTokens = synthesisResult.usage?.outputTokens ?? 0;
                logger.info(`[HierarchicalAggregationRouter]${layerLabel} Synthesis complete in ${synthesisDurationMs}ms ` +
                    `(${inputTokens} input, ${outputTokens} output tokens)`);
                previousLayerSynthesis = synthesisResult.text || null;
                allLayerResults.push(synthesisSubAgentResult);
            }
            catch (synthesisError) {
                const errorMessage = synthesisError instanceof Error
                    ? synthesisError.message
                    : String(synthesisError);
                logger.error(`[HierarchicalAggregationRouter]${layerLabel} Synthesis failed: ${errorMessage}`);
                break;
            }
        }
        return allLayerResults;
    }
}
//# sourceMappingURL=HierarchicalAggregationRouter.js.map