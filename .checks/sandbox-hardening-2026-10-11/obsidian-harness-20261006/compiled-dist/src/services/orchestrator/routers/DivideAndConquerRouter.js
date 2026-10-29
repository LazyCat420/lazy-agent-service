import { resolveSiblingInstances, selectInstanceForMember, } from "../InstanceResolver.js";
import { getProvider } from "../../../providers/index.js";
import logger from "../../../utils/logger.js";
import { buildToolCallFallbackSummary } from "../SubAgentResultBuilder.js";
import RequestLogger from "../../RequestLogger.js";
import PromptLocaleService from "../../PromptLocaleService.js";
import { getErrorMessage } from "../../../utils/ErrorHelpers.js";
const MAXIMUM_SUBTASKS = 6;
const MAXIMUM_SYNTHESIS_CHARACTERS = 120_000;
const DEFAULT_MAXIMUM_RECURSION_DEPTH = 1;
const MAXIMUM_ALLOWED_RECURSION_DEPTH = 3;
const DEFAULT_RECURSION_COMPLEXITY_THRESHOLD = 300;
function truncateResultOutput(output, maximumCharacters) {
    if (output.length <= maximumCharacters)
        return output;
    const truncatedOutput = output.slice(0, maximumCharacters);
    return `${truncatedOutput}\n\n[... truncated — output exceeded ${maximumCharacters.toLocaleString()} character budget]`;
}
export function buildDecompositionPrompt(originalTask, memberCount, maximumSubtaskCount = MAXIMUM_SUBTASKS) {
    const maximumSubtasks = Math.min(maximumSubtaskCount, Math.max(memberCount, 3));
    return [
        PromptLocaleService.get("en", "routers.divideAndConquer.planner"),
        PromptLocaleService.get("en", "routers.divideAndConquer.planInstruction"),
        "",
        "## Original Task",
        "",
        originalTask,
        "",
        "## Instructions",
        "",
        PromptLocaleService.get("en", "routers.divideAndConquer.plannerInstructions", { maximumSubtasks: String(maximumSubtasks) }),
        "",
        "## Output Format",
        "",
        PromptLocaleService.get("en", "routers.divideAndConquer.planFormat"),
        "",
        "```json",
        "[",
        '  {',
        `    "description": "Define TypeScript interfaces for the feature",`,
        `    "prompt": "Create the type definitions in src/types/..."`,
        '  },',
        '  {',
        `    "description": "Implement the service using the types",`,
        `    "prompt": "Implement the service in src/services/...",`,
        `    "dependsOn": [0]`,
        '  }',
        "]",
        "```",
    ].join("\n");
}
export function parseDecompositionResponse(responseText, maximumSubtaskCount = MAXIMUM_SUBTASKS) {
    // Strip markdown code fences if present
    let cleanedResponse = responseText.trim();
    cleanedResponse = cleanedResponse.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    try {
        const parsed = JSON.parse(cleanedResponse);
        if (!Array.isArray(parsed)) {
            logger.warn("[DivideAndConquerRouter] Decomposition response is not an array");
            return [];
        }
        return parsed
            .filter((subtask) => typeof subtask === "object" &&
            subtask !== null &&
            "description" in subtask &&
            "prompt" in subtask &&
            typeof subtask.description === "string" &&
            typeof subtask.prompt === "string" &&
            subtask.prompt.trim().length > 0)
            .slice(0, maximumSubtaskCount)
            .map((subtask) => ({
            ...subtask,
            dependsOn: Array.isArray(subtask.dependsOn)
                ? subtask.dependsOn.filter((index) => typeof index === "number" && index >= 0)
                : undefined,
        }));
    }
    catch (parseError) {
        logger.error(`[DivideAndConquerRouter] Failed to parse decomposition JSON: ${getErrorMessage(parseError)}`);
        // Attempt to extract JSON from mixed content
        const jsonArrayMatch = cleanedResponse.match(/\[[\s\S]*\]/);
        if (jsonArrayMatch) {
            try {
                const extracted = JSON.parse(jsonArrayMatch[0]);
                if (Array.isArray(extracted)) {
                    return extracted
                        .filter((subtask) => typeof subtask === "object" &&
                        subtask !== null &&
                        "description" in subtask &&
                        "prompt" in subtask &&
                        typeof subtask.description === "string" &&
                        typeof subtask.prompt === "string")
                        .slice(0, maximumSubtaskCount);
                }
            }
            catch {
                // Fallback exhausted
            }
        }
        return [];
    }
}
export function buildSynthesisPrompt(originalTask, subtaskResults, subtaskDescriptions) {
    const characterBudgetPerResult = Math.floor(MAXIMUM_SYNTHESIS_CHARACTERS / Math.max(subtaskResults.length, 1));
    const resultSections = subtaskResults.map((result, resultIndex) => {
        const subtaskDescription = subtaskDescriptions[resultIndex] || `Subtask #${resultIndex + 1}`;
        if ("error" in result) {
            return `### Subtask: ${subtaskDescription}\n**Status:** Error\n**Error:** ${result.error}`;
        }
        const outputText = result.result
            ? truncateResultOutput(result.result, characterBudgetPerResult)
            : (buildToolCallFallbackSummary(result) || result.summary);
        return [
            `### Subtask: ${subtaskDescription}`,
            `**Status:** ${result.status}`,
            `**Output:**\n${outputText}`,
        ].join("\n");
    });
    return [
        PromptLocaleService.get("en", "routers.divideAndConquer.synthesizer"),
        `The original task was decomposed into ${subtaskResults.length} independent subtasks. Each was executed by a separate sub-agent.`,
        "",
        "## Original Task",
        "",
        originalTask,
        "",
        "## Subtask Results",
        "",
        resultSections.join("\n\n---\n\n"),
        "",
        "## Instructions",
        "",
        PromptLocaleService.get("en", "routers.divideAndConquer.synthesizeInstructions"),
    ].join("\n");
}
/**
 * Groups subtasks into execution tiers based on their dependency graph.
 * Tier 0 contains subtasks with no dependencies. Tier 1 contains subtasks
 * whose dependencies are all in Tier 0, and so on.
 * Falls back to a single tier (all parallel) if no dependencies exist.
 */
export function buildExecutionTiers(subtasks) {
    const hasDependencies = subtasks.some((subtask) => subtask.dependsOn && subtask.dependsOn.length > 0);
    if (!hasDependencies) {
        return [subtasks.map((_, subtaskIndex) => subtaskIndex)];
    }
    const assignedTier = new Array(subtasks.length).fill(-1);
    const maximumIterations = subtasks.length;
    for (let iteration = 0; iteration < maximumIterations; iteration++) {
        let madeProgress = false;
        for (let subtaskIndex = 0; subtaskIndex < subtasks.length; subtaskIndex++) {
            if (assignedTier[subtaskIndex] >= 0)
                continue;
            const dependencies = subtasks[subtaskIndex].dependsOn || [];
            const validDependencies = dependencies.filter((dependencyIndex) => dependencyIndex >= 0 && dependencyIndex < subtasks.length && dependencyIndex !== subtaskIndex);
            if (validDependencies.length === 0) {
                assignedTier[subtaskIndex] = 0;
                madeProgress = true;
                continue;
            }
            const allDependenciesResolved = validDependencies.every((dependencyIndex) => assignedTier[dependencyIndex] >= 0);
            if (allDependenciesResolved) {
                const maximumDependencyTier = Math.max(...validDependencies.map((dependencyIndex) => assignedTier[dependencyIndex]));
                assignedTier[subtaskIndex] = maximumDependencyTier + 1;
                madeProgress = true;
            }
        }
        if (!madeProgress)
            break;
    }
    // Assign any unresolved (cyclic) subtasks to the final tier
    const maximumResolvedTier = Math.max(0, ...assignedTier.filter((tier) => tier >= 0));
    for (let subtaskIndex = 0; subtaskIndex < subtasks.length; subtaskIndex++) {
        if (assignedTier[subtaskIndex] < 0) {
            logger.warn(`[DivideAndConquerRouter] Subtask ${subtaskIndex} has cyclic dependencies — assigning to final tier`);
            assignedTier[subtaskIndex] = maximumResolvedTier + 1;
        }
    }
    const tierCount = Math.max(...assignedTier) + 1;
    const tiers = Array.from({ length: tierCount }, () => []);
    for (let subtaskIndex = 0; subtaskIndex < subtasks.length; subtaskIndex++) {
        tiers[assignedTier[subtaskIndex]].push(subtaskIndex);
    }
    return tiers;
}
export function buildDependencyContextPrefix(completedResults, dependencyIndices, subtaskDescriptions) {
    const dependencyOutputs = dependencyIndices
        .filter((dependencyIndex) => completedResults.has(dependencyIndex))
        .map((dependencyIndex) => {
        const dependencyResult = completedResults.get(dependencyIndex);
        const dependencyDescription = subtaskDescriptions[dependencyIndex] || `Subtask #${dependencyIndex + 1}`;
        if ("error" in dependencyResult) {
            return `### ${dependencyDescription}\n**Status:** Error — ${dependencyResult.error}`;
        }
        const outputText = dependencyResult.result || dependencyResult.summary || "(no output)";
        return `### ${dependencyDescription}\n${outputText}`;
    });
    if (dependencyOutputs.length === 0)
        return "";
    return [
        "## Prerequisite Subtask Outputs",
        "",
        "The following subtasks have already been completed. Use their outputs as context for your work.",
        "",
        dependencyOutputs.join("\n\n---\n\n"),
        "",
        "---",
        "",
    ].join("\n");
}
/**
 * Divide & Conquer Router — Recursive Decomposition with Dependencies (RDD)
 *
 * Paper: "Recursive Decomposition with Dependencies for Generic
 * Divide-and-Conquer Reasoning" (arxiv.org/abs/2505.02576)
 *
 * See TopologyRegistry.ts → TOPOLOGY_DEFINITIONS (id: "divide-and-conquer")
 * for full paper-alignment metadata and config option documentation.
 */
export class DivideAndConquerRouter {
    async execute(teamName, members, orchestratorContext, spawnSubAgent, _continueSubAgent, topologyConfig) {
        const { providerName, resolvedModel } = orchestratorContext;
        if (members.length === 0) {
            const errorMessage = "No members provided for Divide & Conquer execution";
            logger.error(`[DivideAndConquerRouter] ${errorMessage}`);
            return [{ error: errorMessage }];
        }
        const originalTask = members.map((member) => member.prompt).join("\n\n");
        const configuredMaxSubtasks = Math.max(1, Number(topologyConfig?.maxSubtasks) || MAXIMUM_SUBTASKS);
        const maximumRecursionDepth = Math.min(MAXIMUM_ALLOWED_RECURSION_DEPTH, Math.max(1, Number(topologyConfig?.maxRecursionDepth) || DEFAULT_MAXIMUM_RECURSION_DEPTH));
        const recursionComplexityThreshold = Math.max(50, Number(topologyConfig?.recursionComplexityThreshold) || DEFAULT_RECURSION_COMPLEXITY_THRESHOLD);
        logger.info(`[DivideAndConquerRouter] Starting divide-and-conquer for team "${teamName}" (${members.length} member(s))...`);
        // ── Phase 1: Task Decomposition ─────────────────────────────────────
        logger.info(`[DivideAndConquerRouter] Phase 1: Decomposing task into subtasks...`);
        const decompositionPrompt = buildDecompositionPrompt(originalTask, members.length, configuredMaxSubtasks);
        const provider = getProvider(providerName);
        if (!provider) {
            const errorMessage = `Provider "${providerName}" not found for decomposition pass`;
            logger.error(`[DivideAndConquerRouter] ${errorMessage}`);
            return [{ error: errorMessage }];
        }
        let subtasks;
        try {
            const decompositionStartMs = performance.now();
            const decompositionMessages = [{ role: "user", content: decompositionPrompt }];
            const decompositionResult = await provider.generateText(decompositionMessages, resolvedModel, { maxTokens: 4096 });
            const decompositionDurationMs = Math.round(performance.now() - decompositionStartMs);
            RequestLogger.logBackgroundLlmCall({
                requestId: `${orchestratorContext.conversationId || "unknown"}-decompose-${teamName}`,
                endpoint: "/agent",
                operation: "orchestrator:decompose",
                project: orchestratorContext.project || null,
                username: orchestratorContext.username || "system",
                agent: null,
                provider: providerName,
                model: resolvedModel,
                traceId: orchestratorContext.traceId || null,
                agentConversationId: orchestratorContext.agentConversationId || null,
                aiMessages: decompositionMessages,
                resultText: decompositionResult.text || "",
                usage: decompositionResult.usage || null,
                success: true,
                errorMessage: null,
                requestStartMs: decompositionStartMs,
                extraRequestPayload: { teamName, phase: "decomposition" },
            }).catch((loggingError) => logger.error(`[DivideAndConquerRouter] Failed to log decomposition request: ${getErrorMessage(loggingError)}`));
            subtasks = parseDecompositionResponse(decompositionResult.text || "", configuredMaxSubtasks);
            logger.info(`[DivideAndConquerRouter] Decomposed into ${subtasks.length} subtask(s) in ${decompositionDurationMs}ms`);
        }
        catch (decompositionError) {
            const errorMessage = `Decomposition failed: ${getErrorMessage(decompositionError)}`;
            logger.error(`[DivideAndConquerRouter] ${errorMessage}`);
            return [{ error: errorMessage }];
        }
        if (subtasks.length === 0) {
            logger.warn(`[DivideAndConquerRouter] Decomposition produced 0 subtasks — falling back to direct execution`);
            // Fall back: execute the original task as-is with one sub-agent
            subtasks = [{ description: members[0].description, prompt: originalTask }];
        }
        // ── Phase 2: Tier-Based Subtask Execution (Dependency-Aware) ─────────
        const executionTiers = buildExecutionTiers(subtasks);
        const tierCount = executionTiers.length;
        const subtaskDescriptions = subtasks.map((subtask) => subtask.description);
        logger.info(`[DivideAndConquerRouter] Phase 2: Executing ${subtasks.length} subtask(s) across ${tierCount} tier(s)...`);
        const resolvedSiblings = await resolveSiblingInstances({ providerName, resolvedModel }, "DivideAndConquerRouter");
        const referenceMember = members[0];
        const subtaskResults = Array.from({ length: subtasks.length }, () => ({ error: "not executed" }));
        const completedResults = new Map();
        for (let tierIndex = 0; tierIndex < tierCount; tierIndex++) {
            const tierSubtaskIndices = executionTiers[tierIndex];
            if (tierCount > 1) {
                logger.info(`[DivideAndConquerRouter] Tier ${tierIndex + 1}/${tierCount}: Executing ${tierSubtaskIndices.length} subtask(s) in parallel...`);
            }
            const tierAssignments = [];
            for (const subtaskIndex of tierSubtaskIndices) {
                const subtask = subtasks[subtaskIndex];
                const { assignedProvider, assignedModel } = selectInstanceForMember(referenceMember, resolvedSiblings, { providerName, resolvedModel });
                const dependencyContext = subtask.dependsOn && subtask.dependsOn.length > 0
                    ? buildDependencyContextPrefix(completedResults, subtask.dependsOn, subtaskDescriptions)
                    : "";
                tierAssignments.push({
                    subtaskIndex,
                    assignment: {
                        description: subtask.description,
                        prompt: dependencyContext + subtask.prompt,
                        files: referenceMember.files,
                        model: referenceMember.model,
                        agent: referenceMember.agent,
                        assignedProvider,
                        assignedModel,
                        agentIndex: subtaskIndex,
                        teamSize: subtasks.length,
                        orchestratorContext,
                    },
                });
            }
            const tierPromises = tierAssignments.map(({ assignment }) => this.executeSubtaskWithRecursion(assignment, spawnSubAgent, provider, orchestratorContext, referenceMember, resolvedSiblings, configuredMaxSubtasks, maximumRecursionDepth, recursionComplexityThreshold, 1));
            const tierResults = await Promise.all(tierPromises);
            for (let resultOffset = 0; resultOffset < tierAssignments.length; resultOffset++) {
                const originalIndex = tierAssignments[resultOffset].subtaskIndex;
                subtaskResults[originalIndex] = tierResults[resultOffset];
                completedResults.set(originalIndex, tierResults[resultOffset]);
            }
        }
        // ── Phase 3: Synthesis ──────────────────────────────────────────────
        const successfulResults = subtaskResults.filter((result) => !("error" in result) && result.status === "completed");
        if (successfulResults.length === 0) {
            logger.warn(`[DivideAndConquerRouter] All ${subtaskResults.length} subtasks failed — skipping synthesis`);
            return subtaskResults;
        }
        if (successfulResults.length === 1 && subtasks.length === 1) {
            logger.info(`[DivideAndConquerRouter] Single subtask executed — skipping synthesis`);
            return subtaskResults;
        }
        logger.info(`[DivideAndConquerRouter] Phase 3: Synthesizing ${successfulResults.length} subtask result(s)...`);
        try {
            const subtaskDescriptions = subtasks.map((subtask) => subtask.description);
            const synthesisPrompt = buildSynthesisPrompt(originalTask, subtaskResults, subtaskDescriptions);
            const synthesisStartMs = performance.now();
            const synthesisMessages = [{ role: "user", content: synthesisPrompt }];
            const synthesisResult = await provider.generateText(synthesisMessages, resolvedModel, { maxTokens: 8192 });
            const synthesisDurationMs = Math.round(performance.now() - synthesisStartMs);
            RequestLogger.logBackgroundLlmCall({
                requestId: `${orchestratorContext.conversationId || "unknown"}-synthesis-${teamName}`,
                endpoint: "/agent",
                operation: "orchestrator:divide-conquer-synthesis",
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
                requestStartMs: synthesisStartMs,
                extraRequestPayload: {
                    teamName,
                    phase: "synthesis",
                    subtaskCount: subtasks.length,
                    successfulCount: successfulResults.length,
                },
            }).catch((loggingError) => logger.error(`[DivideAndConquerRouter] Failed to log synthesis request: ${getErrorMessage(loggingError)}`));
            const synthesisSubAgentResult = {
                agent_id: `divide-conquer-synthesis-${teamName}-${Date.now()}`,
                description: `Divide & Conquer synthesis for team "${teamName}"`,
                status: "completed",
                summary: `Decomposed into ${subtasks.length} subtasks, synthesized ${successfulResults.length} successful results`,
                result: synthesisResult.text,
                toolUses: 0,
                iterations: 1,
                durationMs: synthesisDurationMs,
                messages: [],
                diff: { additions: 0, deletions: 0, files: [] },
            };
            logger.info(`[DivideAndConquerRouter] Synthesis complete in ${synthesisDurationMs}ms`);
            return [...subtaskResults, synthesisSubAgentResult];
        }
        catch (synthesisError) {
            logger.error(`[DivideAndConquerRouter] Synthesis failed: ${getErrorMessage(synthesisError)}`);
            return subtaskResults;
        }
    }
    async executeSubtaskWithRecursion(assignment, spawnSubAgent, provider, orchestratorContext, referenceMember, resolvedSiblings, configuredMaxSubtasks, maximumRecursionDepth, recursionComplexityThreshold, currentDepth) {
        const promptLength = assignment.prompt.length;
        const shouldRecurse = currentDepth < maximumRecursionDepth
            && promptLength > recursionComplexityThreshold;
        if (!shouldRecurse) {
            return spawnSubAgent(assignment);
        }
        logger.info(`[DivideAndConquerRouter] Recursive decomposition at depth ${currentDepth}/${maximumRecursionDepth} for subtask "${assignment.description}" (${promptLength} chars)`);
        if (!provider) {
            logger.warn(`[DivideAndConquerRouter] No provider for recursive decomposition — falling back to direct execution`);
            return spawnSubAgent(assignment);
        }
        try {
            const recursiveDecompositionPrompt = buildDecompositionPrompt(assignment.prompt, 2, Math.min(configuredMaxSubtasks, 4));
            const recursiveDecompositionMessages = [
                { role: "user", content: recursiveDecompositionPrompt },
            ];
            const recursiveDecompositionResult = await provider.generateText(recursiveDecompositionMessages, orchestratorContext.resolvedModel, { maxTokens: 4096 });
            const recursiveSubtasks = parseDecompositionResponse(recursiveDecompositionResult.text || "", Math.min(configuredMaxSubtasks, 4));
            if (recursiveSubtasks.length <= 1) {
                logger.info(`[DivideAndConquerRouter] Recursive decomposition at depth ${currentDepth} yielded ${recursiveSubtasks.length} subtask(s) — executing directly`);
                return spawnSubAgent(assignment);
            }
            logger.info(`[DivideAndConquerRouter] Recursive depth ${currentDepth}: decomposed into ${recursiveSubtasks.length} sub-subtasks`);
            const recursiveTiers = buildExecutionTiers(recursiveSubtasks);
            const recursiveResults = Array.from({ length: recursiveSubtasks.length }, () => ({ error: "not executed" }));
            const recursiveCompletedResults = new Map();
            const recursiveSubtaskDescriptions = recursiveSubtasks.map((subtask) => subtask.description);
            for (const recursiveTierIndices of recursiveTiers) {
                const recursiveTierPromises = recursiveTierIndices.map((subtaskIndex) => {
                    const subtask = recursiveSubtasks[subtaskIndex];
                    const { assignedProvider, assignedModel } = selectInstanceForMember(referenceMember, resolvedSiblings, { providerName: orchestratorContext.providerName, resolvedModel: orchestratorContext.resolvedModel });
                    const dependencyContext = subtask.dependsOn && subtask.dependsOn.length > 0
                        ? buildDependencyContextPrefix(recursiveCompletedResults, subtask.dependsOn, recursiveSubtaskDescriptions)
                        : "";
                    const recursiveAssignment = {
                        description: subtask.description,
                        prompt: dependencyContext + subtask.prompt,
                        files: referenceMember.files,
                        model: referenceMember.model,
                        agent: referenceMember.agent,
                        assignedProvider,
                        assignedModel,
                        agentIndex: subtaskIndex,
                        teamSize: recursiveSubtasks.length,
                        orchestratorContext,
                    };
                    return this.executeSubtaskWithRecursion(recursiveAssignment, spawnSubAgent, provider, orchestratorContext, referenceMember, resolvedSiblings, configuredMaxSubtasks, maximumRecursionDepth, recursionComplexityThreshold, currentDepth + 1);
                });
                const recursiveTierResults = await Promise.all(recursiveTierPromises);
                for (let resultOffset = 0; resultOffset < recursiveTierIndices.length; resultOffset++) {
                    const originalIndex = recursiveTierIndices[resultOffset];
                    recursiveResults[originalIndex] = recursiveTierResults[resultOffset];
                    recursiveCompletedResults.set(originalIndex, recursiveTierResults[resultOffset]);
                }
            }
            const recursiveSuccessfulResults = recursiveResults.filter((result) => !("error" in result) && result.status === "completed");
            if (recursiveSuccessfulResults.length === 0) {
                logger.warn(`[DivideAndConquerRouter] All recursive sub-subtasks failed at depth ${currentDepth} — falling back to direct execution`);
                return spawnSubAgent(assignment);
            }
            if (recursiveSuccessfulResults.length === 1 && recursiveSubtasks.length === 1) {
                return recursiveResults[0];
            }
            const recursiveSynthesisPrompt = buildSynthesisPrompt(assignment.prompt, recursiveResults, recursiveSubtaskDescriptions);
            const recursiveSynthesisStartMs = performance.now();
            const recursiveSynthesisMessages = [
                { role: "user", content: recursiveSynthesisPrompt },
            ];
            const recursiveSynthesisResult = await provider.generateText(recursiveSynthesisMessages, orchestratorContext.resolvedModel, { maxTokens: 8192 });
            const recursiveSynthesisDurationMs = Math.round(performance.now() - recursiveSynthesisStartMs);
            const recursiveSynthesizedResult = {
                agent_id: `recursive-synthesis-depth${currentDepth}-${Date.now()}`,
                description: `Recursive synthesis at depth ${currentDepth} for "${assignment.description}"`,
                status: "completed",
                summary: `Recursively decomposed into ${recursiveSubtasks.length} sub-subtasks at depth ${currentDepth}, synthesized ${recursiveSuccessfulResults.length} results`,
                result: recursiveSynthesisResult.text,
                toolUses: 0,
                iterations: 1,
                durationMs: recursiveSynthesisDurationMs,
                messages: [],
                diff: { additions: 0, deletions: 0, files: [] },
            };
            logger.info(`[DivideAndConquerRouter] Recursive synthesis at depth ${currentDepth} complete in ${recursiveSynthesisDurationMs}ms`);
            return recursiveSynthesizedResult;
        }
        catch (recursionError) {
            logger.warn(`[DivideAndConquerRouter] Recursive decomposition failed at depth ${currentDepth}: ${getErrorMessage(recursionError)} — falling back to direct execution`);
            return spawnSubAgent(assignment);
        }
    }
}
//# sourceMappingURL=DivideAndConquerRouter.js.map