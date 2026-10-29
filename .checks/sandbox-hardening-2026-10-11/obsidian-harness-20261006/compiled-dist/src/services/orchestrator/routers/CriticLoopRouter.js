import { buildToolCallFallbackSummary } from "../SubAgentResultBuilder.js";
import { resolveSiblingInstances, selectInstanceForMember, } from "../InstanceResolver.js";
import logger from "../../../utils/logger.js";
import PromptLocaleService from "../../PromptLocaleService.js";
const DEFAULT_MAXIMUM_ROUNDS = 3;
const DEFAULT_ACTOR_COUNT = 1;
const PASS_VERDICT_PATTERN = /\bPASS\b/i;
const FAIL_VERDICT_PATTERN = /\bFAIL\b/i;
function buildCriticPrompt(actorOutput, originalTask, roundNumber, maximumRounds, criticRole) {
    const roleContext = criticRole
        ? PromptLocaleService.get("en", "routers.critic.specializedRole", { criticRole })
        : "";
    return [
        PromptLocaleService.get("en", "routers.critic.evaluator"),
        roleContext,
        PromptLocaleService.get("en", "routers.critic.roundContext", { roundNumber: String(roundNumber), maximumRounds: String(maximumRounds) }),
        "",
        PromptLocaleService.get("en", "routers.critic.originalTaskHeader"),
        "",
        originalTask,
        "",
        PromptLocaleService.get("en", "routers.critic.actorOutputHeader"),
        "",
        actorOutput,
        "",
        PromptLocaleService.get("en", "routers.critic.jobHeader"),
        "",
        PromptLocaleService.get("en", "routers.critic.jobInstruction"),
        "",
        PromptLocaleService.get("en", "routers.critic.verdictInstruction"),
        "",
        PromptLocaleService.get("en", "routers.critic.passVerdict"),
        "",
        PromptLocaleService.get("en", "routers.critic.failVerdict"),
        "",
        PromptLocaleService.get("en", "routers.critic.verdictFormat"),
    ].join("\n");
}
function buildJurySelectionPrompt(originalTask, actorOutputs) {
    const actorSections = actorOutputs.map((actor) => `### Actor ${actor.actorIndex + 1}: ${actor.description}\n${actor.output}`);
    return [
        PromptLocaleService.get("en", "routers.jury.judge"),
        "",
        PromptLocaleService.get("en", "routers.critic.originalTaskHeader"),
        "",
        originalTask,
        "",
        "## Competing Solutions",
        "",
        actorSections.join("\n\n---\n\n"),
        "",
        "## Instructions",
        "",
        PromptLocaleService.get("en", "routers.jury.evaluateInstruction", { actorCount: String(actorOutputs.length) }),
        "",
        PromptLocaleService.get("en", "routers.jury.responseFormat"),
        "",
        "```json",
        "{",
        `  "bestActorIndex": 0,`,
        `  "verdict": "FAIL",`,
        `  "feedback": "Actor 1 has the strongest approach but needs error handling for edge cases."`,
        "}",
        "```",
        "",
        PromptLocaleService.get("en", "routers.jury.bestActorDescription"),
    ].join("\n");
}
function parseJurySelectionResponse(responseText, actorCount) {
    let cleanedResponse = responseText.trim();
    cleanedResponse = cleanedResponse.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    try {
        const parsed = JSON.parse(cleanedResponse);
        return {
            bestActorIndex: Math.max(0, Math.min(actorCount - 1, Number(parsed.bestActorIndex) || 0)),
            verdict: PASS_VERDICT_PATTERN.test(String(parsed.verdict)) ? "PASS" : "FAIL",
            feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
        };
    }
    catch {
        // Attempt to extract JSON from mixed content
        const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                const extracted = JSON.parse(jsonMatch[0]);
                return {
                    bestActorIndex: Math.max(0, Math.min(actorCount - 1, Number(extracted.bestActorIndex) || 0)),
                    verdict: PASS_VERDICT_PATTERN.test(String(extracted.verdict)) ? "PASS" : "FAIL",
                    feedback: typeof extracted.feedback === "string" ? extracted.feedback : "",
                };
            }
            catch {
                // Fallback exhausted
            }
        }
        logger.warn("[CriticLoopRouter] Failed to parse jury selection JSON — defaulting to actor 0");
        return { bestActorIndex: 0, verdict: "FAIL", feedback: responseText };
    }
}
function buildActorRevisionPrompt(criticVerdicts, roundNumber) {
    const failedVerdicts = criticVerdicts.filter((verdict) => !verdict.isPassing);
    const passedVerdicts = criticVerdicts.filter((verdict) => verdict.isPassing);
    const feedbackSections = failedVerdicts.map((verdict) => {
        return [
            `### Critic: ${verdict.criticDescription}`,
            verdict.feedback,
        ].join("\n");
    });
    const passedSummary = passedVerdicts.length > 0
        ? `\n\nThe following critics PASSED your work (do not regress on their areas):\n${passedVerdicts.map((verdict) => `- ✅ ${verdict.criticDescription}`).join("\n")}`
        : "";
    return [
        PromptLocaleService.get("en", "routers.critic.revisionHeader", { criticCount: String(criticVerdicts.length), roundNumber: String(roundNumber) }),
        PromptLocaleService.get("en", "routers.critic.failedCount", { failedCount: String(failedVerdicts.length) }),
        passedSummary,
        "",
        "## Critic Feedback (FAIL verdicts)",
        "",
        feedbackSections.join("\n\n---\n\n"),
        "",
        "## Instructions",
        "",
        PromptLocaleService.get("en", "routers.critic.revisionInstructions"),
    ].join("\n");
}
function buildJuryRevisionPrompt(feedback, roundNumber) {
    return [
        PromptLocaleService.get("en", "routers.jury.revisionHeader", { roundNumber: String(roundNumber) }),
        "",
        "## Judge's Feedback",
        "",
        feedback,
        "",
        "## Instructions",
        "",
        PromptLocaleService.get("en", "routers.jury.revisionInstructions"),
    ].join("\n");
}
function extractActorOutputText(spawnResult) {
    return spawnResult.result
        || buildToolCallFallbackSummary(spawnResult)
        || spawnResult.summary;
}
function parseVerdict(criticOutput) {
    const firstLine = criticOutput.trim().split("\n")[0];
    if (PASS_VERDICT_PATTERN.test(firstLine)) {
        return { isPassing: true, feedback: criticOutput };
    }
    if (FAIL_VERDICT_PATTERN.test(firstLine)) {
        return { isPassing: false, feedback: criticOutput };
    }
    // Ambiguous verdict — treat as fail with the full output as feedback
    // so the actor gets a chance to revise
    logger.warn(`[CriticLoopRouter] Critic did not start with PASS or FAIL. Treating as FAIL.`);
    return { isPassing: false, feedback: criticOutput };
}
function detectDegenerationOfThought(previousFeedback, currentFeedback) {
    if (!previousFeedback)
        return false;
    const normalizedPrevious = previousFeedback.trim().toLowerCase().replace(/\s+/g, " ");
    const normalizedCurrent = currentFeedback.trim().toLowerCase().replace(/\s+/g, " ");
    // If >80% of the content is identical, the critic panel is repeating itself
    // indicating Degeneration-of-Thought (DoT)
    const shorterLength = Math.min(normalizedPrevious.length, normalizedCurrent.length);
    if (shorterLength === 0)
        return false;
    let matchingCharacters = 0;
    const comparisonLength = Math.min(shorterLength, 500);
    for (let characterIndex = 0; characterIndex < comparisonLength; characterIndex++) {
        if (normalizedPrevious[characterIndex] === normalizedCurrent[characterIndex]) {
            matchingCharacters++;
        }
    }
    const similarityRatio = matchingCharacters / comparisonLength;
    return similarityRatio > 0.8;
}
/**
 * Critic Loop Router — Actor-Critic Iterative Refinement (MAR)
 *
 * Paper: "Self-Refine: Iterative Refinement with Self-Feedback"
 * (arxiv.org/abs/2303.17651)
 *
 * See TopologyRegistry.ts → TOPOLOGY_DEFINITIONS (id: "critic-loop")
 * for full paper-alignment metadata and config option documentation.
 */
export class CriticLoopRouter {
    async execute(teamName, members, orchestratorContext, spawnSubAgent, continueSubAgent, topologyConfig) {
        const { providerName, resolvedModel } = orchestratorContext;
        const actorCount = Math.max(1, Number(topologyConfig?.actorCount) || DEFAULT_ACTOR_COUNT);
        const maximumRounds = Math.max(1, Number(topologyConfig?.maxRounds) || DEFAULT_MAXIMUM_ROUNDS);
        if (members.length === 0) {
            const errorMessage = "Critic Loop topology requires at least 1 member (the actor).";
            logger.error(`[CriticLoopRouter] ${errorMessage}`);
            return [{ error: errorMessage }];
        }
        if (actorCount > 1) {
            return this.executeJuryMode(teamName, members, orchestratorContext, spawnSubAgent, continueSubAgent, actorCount, maximumRounds);
        }
        return this.executeCouncilMode(teamName, members, orchestratorContext, spawnSubAgent, continueSubAgent, maximumRounds);
    }
    // ── Council of Judges Mode (1 Actor + N Critics) ──────────────────────
    async executeCouncilMode(teamName, members, orchestratorContext, spawnSubAgent, continueSubAgent, maximumRounds = DEFAULT_MAXIMUM_ROUNDS) {
        const { providerName, resolvedModel } = orchestratorContext;
        const actorMember = members[0];
        const criticMembers = members.length > 1
            ? members.slice(1)
            : [{
                    description: `Critic for "${actorMember.description}"`,
                    prompt: PromptLocaleService.get("en", "routers.critic.defaultPrompt"),
                    files: actorMember.files,
                }];
        const criticCount = criticMembers.length;
        const totalTeamSize = 1 + criticCount;
        const allResults = [];
        let previousAggregatedFeedback = null;
        let actorAgentId = null;
        logger.info(`[CriticLoopRouter] Council mode: team "${teamName}" (${criticCount} critic(s), max ${maximumRounds} rounds)...`);
        // ── Round 1: Initial Actor spawn ────────────────────────────────────
        const resolvedSiblings = await resolveSiblingInstances({ providerName, resolvedModel }, "CriticLoopRouter");
        const { assignedProvider: actorProvider, assignedModel: actorModel } = selectInstanceForMember(actorMember, resolvedSiblings, { providerName, resolvedModel });
        const actorAssignment = {
            description: `${actorMember.description} (Actor, Round 1)`,
            prompt: actorMember.prompt,
            files: actorMember.files,
            model: actorMember.model,
            agent: actorMember.agent,
            assignedProvider: actorProvider,
            assignedModel: actorModel,
            agentIndex: 0,
            teamSize: totalTeamSize,
            round: 1,
            totalRounds: maximumRounds,
            orchestratorContext,
            preserveWorktree: true,
        };
        logger.info(`[CriticLoopRouter] Round 1: Spawning Actor "${actorMember.description}"...`);
        let actorResult = await spawnSubAgent(actorAssignment);
        allResults.push(actorResult);
        if ("error" in actorResult) {
            logger.error(`[CriticLoopRouter] Actor failed on initial spawn: ${actorResult.error}`);
            return allResults;
        }
        if (actorResult.status !== "completed") {
            logger.error(`[CriticLoopRouter] Actor did not complete (status: ${actorResult.status}). Aborting loop.`);
            return allResults;
        }
        actorAgentId = actorResult.agent_id;
        // ── Critic evaluation rounds ────────────────────────────────────────
        for (let roundNumber = 1; roundNumber <= maximumRounds; roundNumber++) {
            if ("error" in actorResult) {
                break;
            }
            const actorOutputText = extractActorOutputText(actorResult);
            logger.info(`[CriticLoopRouter] Round ${roundNumber}/${maximumRounds}: Spawning ${criticCount} critic(s) in parallel...`);
            const criticSpawnPromises = criticMembers.map((criticMember, criticMemberIndex) => {
                const { assignedProvider: criticProvider, assignedModel: criticModel } = selectInstanceForMember(criticMember, resolvedSiblings, { providerName, resolvedModel });
                const criticPromptText = buildCriticPrompt(actorOutputText, actorMember.prompt, roundNumber, maximumRounds, criticMember.description);
                const criticAssignment = {
                    description: `${criticMember.description} (Critic ${criticMemberIndex + 1}/${criticCount}, Round ${roundNumber})`,
                    prompt: criticPromptText,
                    files: criticMember.files,
                    model: criticMember.model,
                    agent: criticMember.agent,
                    assignedProvider: criticProvider,
                    assignedModel: criticModel,
                    agentIndex: 1 + criticMemberIndex,
                    teamSize: totalTeamSize,
                    round: roundNumber,
                    totalRounds: maximumRounds,
                    orchestratorContext,
                };
                return spawnSubAgent(criticAssignment);
            });
            const criticResults = await Promise.all(criticSpawnPromises);
            allResults.push(...criticResults);
            const verdicts = [];
            for (let criticResultIndex = 0; criticResultIndex < criticResults.length; criticResultIndex++) {
                const criticResult = criticResults[criticResultIndex];
                const criticMember = criticMembers[criticResultIndex];
                if ("error" in criticResult) {
                    logger.error(`[CriticLoopRouter] Critic "${criticMember.description}" failed in round ${roundNumber}: ${criticResult.error}`);
                    verdicts.push({
                        criticIndex: criticResultIndex,
                        criticDescription: criticMember.description,
                        isPassing: false,
                        feedback: `Critic errored: ${criticResult.error}`,
                    });
                    continue;
                }
                if (criticResult.status !== "completed") {
                    logger.warn(`[CriticLoopRouter] Critic "${criticMember.description}" did not complete in round ${roundNumber}`);
                    verdicts.push({
                        criticIndex: criticResultIndex,
                        criticDescription: criticMember.description,
                        isPassing: false,
                        feedback: `Critic did not complete (status: ${criticResult.status})`,
                    });
                    continue;
                }
                const criticOutputText = extractActorOutputText(criticResult);
                const verdict = parseVerdict(criticOutputText);
                verdicts.push({
                    criticIndex: criticResultIndex,
                    criticDescription: criticMember.description,
                    isPassing: verdict.isPassing,
                    feedback: verdict.feedback,
                });
            }
            const passingVerdicts = verdicts.filter((verdict) => verdict.isPassing);
            const failingVerdicts = verdicts.filter((verdict) => !verdict.isPassing);
            logger.info(`[CriticLoopRouter] Round ${roundNumber}: ${passingVerdicts.length}/${verdicts.length} critics PASSED`);
            if (failingVerdicts.length === 0) {
                logger.info(`[CriticLoopRouter] Round ${roundNumber}: Unanimous PASS from all ${verdicts.length} critic(s). Actor's output accepted.`);
                return allResults;
            }
            logger.info(`[CriticLoopRouter] Round ${roundNumber}: ${failingVerdicts.length} critic(s) FAILED. Aggregating feedback for Actor...`);
            // ── DoT detection on aggregated feedback ──────────────────────────
            const aggregatedFeedback = failingVerdicts
                .map((verdict) => `[${verdict.criticDescription}]: ${verdict.feedback}`)
                .join("\n\n");
            if (detectDegenerationOfThought(previousAggregatedFeedback, aggregatedFeedback)) {
                logger.warn(`[CriticLoopRouter] Degeneration-of-Thought detected — critic panel is repeating the same aggregated feedback. Force-terminating loop.`);
                return allResults;
            }
            previousAggregatedFeedback = aggregatedFeedback;
            // ── Check if we have rounds remaining for revision ────────────────
            if (roundNumber >= maximumRounds) {
                logger.warn(`[CriticLoopRouter] Maximum rounds (${maximumRounds}) reached. Returning last Actor output despite ${failingVerdicts.length} critic failure(s).`);
                return allResults;
            }
            // ── Continue Actor with aggregated critic feedback ────────────────
            if (!continueSubAgent) {
                logger.error(`[CriticLoopRouter] continueSubAgent callback not provided — cannot continue Actor session for revision.`);
                return allResults;
            }
            if (!actorAgentId) {
                logger.error(`[CriticLoopRouter] No Actor agent ID available for continuation.`);
                return allResults;
            }
            const revisionPrompt = buildActorRevisionPrompt(verdicts, roundNumber);
            logger.info(`[CriticLoopRouter] Round ${roundNumber + 1}: Continuing Actor with aggregated feedback from ${failingVerdicts.length} failing critic(s)...`);
            actorResult = await continueSubAgent(actorAgentId, revisionPrompt, orchestratorContext, roundNumber + 1);
            allResults.push(actorResult);
            if ("error" in actorResult) {
                logger.error(`[CriticLoopRouter] Actor failed on revision round ${roundNumber + 1}: ${actorResult.error}`);
                return allResults;
            }
            if (actorResult.status !== "completed") {
                logger.warn(`[CriticLoopRouter] Actor did not complete revision (status: ${actorResult.status}). Returning partial results.`);
                return allResults;
            }
        }
        return allResults;
    }
    // ── Jury Mode (N Actors + Judge → Critic Loop on winner) ─────────────
    async executeJuryMode(teamName, members, orchestratorContext, spawnSubAgent, continueSubAgent, actorCount = 2, maximumRounds = DEFAULT_MAXIMUM_ROUNDS) {
        const { providerName, resolvedModel } = orchestratorContext;
        const allResults = [];
        // Split members: first actorCount are actors, rest are unused in Jury mode
        // (the judge is auto-generated like Tournament)
        const actorMembers = members.slice(0, actorCount);
        const actualActorCount = actorMembers.length;
        logger.info(`[CriticLoopRouter] Jury mode: team "${teamName}" (${actualActorCount} actor(s), max ${maximumRounds} rounds)...`);
        // ── Phase 1: Spawn competing actors in parallel (Tournament phase) ──
        const resolvedSiblings = await resolveSiblingInstances({ providerName, resolvedModel }, "CriticLoopRouter:Jury");
        const actorAssignments = actorMembers.map((actorMember, actorIndex) => {
            const { assignedProvider, assignedModel } = selectInstanceForMember(actorMember, resolvedSiblings, { providerName, resolvedModel });
            return {
                description: `${actorMember.description} (Actor ${actorIndex + 1}/${actualActorCount})`,
                prompt: actorMember.prompt,
                files: actorMember.files,
                model: actorMember.model,
                agent: actorMember.agent,
                assignedProvider,
                assignedModel,
                agentIndex: actorIndex,
                teamSize: actualActorCount,
                round: 1,
                totalRounds: maximumRounds,
                orchestratorContext,
                preserveWorktree: true,
            };
        });
        logger.info(`[CriticLoopRouter] Jury Phase 1: Spawning ${actualActorCount} competing actors in parallel...`);
        const actorResults = await Promise.all(actorAssignments.map((assignment) => spawnSubAgent(assignment)));
        allResults.push(...actorResults);
        const successfulActors = [];
        for (let actorIndex = 0; actorIndex < actorResults.length; actorIndex++) {
            const actorResult = actorResults[actorIndex];
            if (!("error" in actorResult) && actorResult.status === "completed") {
                successfulActors.push({ actorIndex, result: actorResult });
            }
        }
        if (successfulActors.length === 0) {
            logger.error(`[CriticLoopRouter] All ${actualActorCount} actors failed in Jury mode. Aborting.`);
            return allResults;
        }
        // ── Phase 2: Judge selects best + provides feedback ──────────────────
        const { getProvider } = await import("../../../providers/index.js");
        const provider = getProvider(providerName);
        if (!provider) {
            logger.error(`[CriticLoopRouter] Provider "${providerName}" not found for jury selection`);
            return allResults;
        }
        const originalTask = actorMembers[0]?.prompt || "";
        let previousFeedback = null;
        const actorOutputs = successfulActors.map((actor) => ({
            actorIndex: actor.actorIndex,
            description: actorMembers[actor.actorIndex]?.description || `Actor ${actor.actorIndex + 1}`,
            output: extractActorOutputText(actor.result),
        }));
        const juryPrompt = buildJurySelectionPrompt(originalTask, actorOutputs);
        const juryMessages = [{ role: "user", content: juryPrompt }];
        let juryResponse;
        try {
            juryResponse = await provider.generateText(juryMessages, resolvedModel, { maxTokens: 4096 });
        }
        catch (juryError) {
            logger.error(`[CriticLoopRouter] Jury selection failed: ${String(juryError)}`);
            return allResults;
        }
        let selection = parseJurySelectionResponse(juryResponse.text || "", successfulActors.length);
        const winnerActorIndex = successfulActors[selection.bestActorIndex]?.actorIndex ?? 0;
        let winnerResult = successfulActors[selection.bestActorIndex]?.result;
        if (!winnerResult) {
            logger.error(`[CriticLoopRouter] Jury selected invalid actor index. Aborting.`);
            return allResults;
        }
        logger.info(`[CriticLoopRouter] Jury selected Actor ${winnerActorIndex + 1} — verdict: ${selection.verdict}`);
        if (selection.verdict === "PASS") {
            logger.info(`[CriticLoopRouter] Jury PASSED Actor ${winnerActorIndex + 1}. Done.`);
            return allResults;
        }
        // ── Phase 3: Iterative refinement on the winner ─────────────────────
        const winnerAgentId = winnerResult.agent_id;
        if (!continueSubAgent) {
            logger.error(`[CriticLoopRouter] continueSubAgent callback not provided — cannot refine winner in Jury mode.`);
            return allResults;
        }
        for (let roundNumber = 2; roundNumber <= maximumRounds; roundNumber++) {
            if (detectDegenerationOfThought(previousFeedback, selection.feedback)) {
                logger.warn(`[CriticLoopRouter] Degeneration-of-Thought detected in Jury mode. Force-terminating.`);
                return allResults;
            }
            previousFeedback = selection.feedback;
            const revisionPrompt = buildJuryRevisionPrompt(selection.feedback, roundNumber);
            logger.info(`[CriticLoopRouter] Jury Round ${roundNumber}: Continuing winner (Actor ${winnerActorIndex + 1}) with judge feedback...`);
            const revisedResult = await continueSubAgent(winnerAgentId, revisionPrompt, orchestratorContext, roundNumber);
            allResults.push(revisedResult);
            if ("error" in revisedResult) {
                logger.error(`[CriticLoopRouter] Winner revision failed in round ${roundNumber}: ${revisedResult.error}`);
                return allResults;
            }
            if (revisedResult.status !== "completed") {
                logger.warn(`[CriticLoopRouter] Winner did not complete revision in round ${roundNumber}.`);
                return allResults;
            }
            winnerResult = revisedResult;
            const revisedOutput = extractActorOutputText(revisedResult);
            const reevaluationPrompt = buildJurySelectionPrompt(originalTask, [{
                    actorIndex: winnerActorIndex,
                    description: actorMembers[winnerActorIndex]?.description || `Actor ${winnerActorIndex + 1}`,
                    output: revisedOutput,
                }]);
            try {
                const reevaluationResponse = await provider.generateText([{ role: "user", content: reevaluationPrompt }], resolvedModel, { maxTokens: 4096 });
                selection = parseJurySelectionResponse(reevaluationResponse.text || "", 1);
            }
            catch {
                logger.warn(`[CriticLoopRouter] Re-evaluation failed in round ${roundNumber}. Returning current results.`);
                return allResults;
            }
            logger.info(`[CriticLoopRouter] Jury Round ${roundNumber}: Re-evaluation verdict: ${selection.verdict}`);
            if (selection.verdict === "PASS") {
                logger.info(`[CriticLoopRouter] Jury PASSED revised output in round ${roundNumber}. Done.`);
                return allResults;
            }
        }
        logger.warn(`[CriticLoopRouter] Maximum rounds (${maximumRounds}) reached in Jury mode. Returning best effort.`);
        return allResults;
    }
}
//# sourceMappingURL=CriticLoopRouter.js.map