import { buildToolCallFallbackSummary } from "../SubAgentResultBuilder.js";
import { resolveSiblingInstances, selectInstanceForMember, } from "../InstanceResolver.js";
import logger from "../../../utils/logger.js";
import { GitWorktreeHelper } from "../GitWorktreeHelper.js";
const MINIMUM_SUBSTANTIVE_RESPONSE_LENGTH = 80;
const SHARED_BOARD_MARKER = "--- SHARED DISCUSSION BOARD ---";
const YOUR_TASK_MARKER_PATTERN = /--- YOUR TASK \([^)]+\) ---/;
/**
 * Strip echoed shared discussion board content from a sub-agent's response
 * before appending it to the shared thread.
 *
 * Sub-agents frequently echo the entire prompt structure they received —
 * including board markers, prior agent contributions, YOUR TASK sections,
 * and speaker identity instructions — before writing their own new content.
 *
 * Uses a multi-pass approach:
 * 1. Remove echoed board preamble (everything up to the last board marker)
 * 2. Remove orphaned speaker tags (bare `[agent-N]` lines without content)
 * 3. Strip leading speaker self-tag (the router prepends its own)
 * 4. Strip "Task Completion Report" boilerplate
 * 5. Remove echoed prior-agent content with omission notes
 * 6. Clean residual board/task markers and identity instructions
 */
function stripEchoedDiscussionMarkers(responseText) {
    let cleanedText = responseText.trim();
    // ── Pass 1: Remove echoed board preamble ──────────────────────────────
    // If the response contains board markers, the agent is echoing prompt
    // structure. Find the last board marker and take content after it.
    if (cleanedText.includes(SHARED_BOARD_MARKER)) {
        const lastBoardMarkerIndex = cleanedText.lastIndexOf(SHARED_BOARD_MARKER);
        const contentAfterLastMarker = cleanedText
            .slice(lastBoardMarkerIndex + SHARED_BOARD_MARKER.length)
            .trim();
        // Check for a YOUR TASK section after the last board marker — if present,
        // content after it is the echoed member prompt, not the agent's contribution.
        const yourTaskInTail = YOUR_TASK_MARKER_PATTERN.exec(contentAfterLastMarker);
        if (yourTaskInTail && yourTaskInTail.index != null) {
            cleanedText = contentAfterLastMarker.slice(0, yourTaskInTail.index).trim();
        }
        else {
            cleanedText = contentAfterLastMarker;
        }
    }
    // ── Pass 2: Remove orphaned speaker tags ──────────────────────────────
    // Bare lines like `[agent-0]` (without a colon or content) are artifacts
    // from the agent echoing its own tag structure incorrectly.
    cleanedText = cleanedText.replace(/^\[[\w-]+\]\s*$/gm, "").trim();
    // ── Pass 3: Strip leading speaker self-tag ────────────────────────────
    // The router prepends `[speakerName]: ` when appending to the thread,
    // so remove any self-tag the agent added at the start of its response.
    cleanedText = cleanedText.replace(/^\[[\w-]+\]:\s*/, "").trim();
    // ── Pass 4: Strip "Task Completion Report" boilerplate ────────────────
    // Agents often append a meta-section summarizing what they did. This is
    // noise for the shared board — other agents don't need "I have completed…"
    const taskReportPattern = /\n---\n\*\*Task Completion Report[:\s]*\*\*[\s\S]*$/i;
    cleanedText = cleanedText.replace(taskReportPattern, "").trim();
    // ── Pass 5: Strip echoed prior-agent content with omission notes ──────
    // Lines like `[agent-0]: ... (Content omitted for brevity, as per previous turn)`
    cleanedText = cleanedText
        .replace(/^\[[\w-]+\]:.*\.\.\.\s*\(Content omitted.*?\)\s*$/gm, "")
        .trim();
    // ── Pass 6: Clean residual structural markers ─────────────────────────
    cleanedText = cleanedText
        .replace(/---\s*SHARED DISCUSSION BOARD\s*---/g, "")
        .replace(/--- YOUR TASK \([^)]+\) ---/g, "")
        .replace(/^Your speaker identity in this discussion is [\w-]+\..*$/gm, "")
        .replace(/^Tag all your contributions with \[[\w-]+\]\.?\s*$/gm, "")
        .trim();
    return cleanedText;
}
/**
 * Detect stall responses using structural signals rather than brittle
 * keyword matching. A response is considered a stall when it is very
 * short AND the agent performed no tool work — indicating it had
 * nothing actionable to do.
 */
function isStallResponse(responseText, spawnResult) {
    const isShortResponse = responseText.trim().length < MINIMUM_SUBSTANTIVE_RESPONSE_LENGTH;
    const hasNoToolUsage = spawnResult.toolUses === 0;
    return isShortResponse && hasNoToolUsage;
}
/**
 * Peer-to-Peer (Mesh) Router — Multi-Agent Debate (MAD)
 *
 * Paper: "Improving Factuality and Reasoning in Language Models
 * through Multiagent Debate" (arxiv.org/abs/2305.14325)
 *
 * See TopologyRegistry.ts → TOPOLOGY_DEFINITIONS (id: "peer-to-peer")
 * for full paper-alignment metadata and config option documentation.
 */
export class PeerToPeerRouter {
    async execute(teamName, members, orchestratorContext, spawnSubAgent, continueSubAgent, topologyConfig) {
        const { providerName, resolvedModel } = orchestratorContext;
        logger.info(`[PeerToPeerRouter] Starting Peer-to-Peer mesh execution of ${members.length} member(s)...`);
        const invalidMembersCount = members.filter((member) => !member.prompt || member.prompt.trim() === "").length;
        if (invalidMembersCount > 0) {
            const errorMessage = `${invalidMembersCount} member(s) have missing or empty prompts. Cannot execute Peer-to-Peer mesh topology.`;
            logger.error(`[PeerToPeerRouter] ${errorMessage}`);
            return [{ error: errorMessage }];
        }
        // Pre-compute 0-based speaker names for all members.
        // Custom agent names (e.g. "Dev", "QA") are used as-is.
        // Generic "agent-N" names or missing names default to agent-{memberIndex}.
        const speakerNamesByMemberIndex = members.map((member, index) => {
            const rawName = member.agent || `agent-${index}`;
            return /^agent-\d+$/i.test(rawName) ? `agent-${index}` : rawName;
        });
        // Map of memberIndex → agentId for stateful session reuse.
        // Populated on each agent's first turn, then reused for subsequent turns.
        const agentIdsByMemberIndex = new Map();
        // The most recent result per member slot — returned to the orchestrator
        const latestResultByMemberIndex = new Map();
        const sharedDiscussion = [];
        let consecutiveStallCount = 0;
        const maximumConsecutiveStalls = 3;
        // Compute max turns from topologyConfig.maxRounds or default (2 rounds, capped at 10)
        const configuredMaxRounds = Number(topologyConfig?.maxRounds) || 0;
        const maxTurnsCount = configuredMaxRounds > 0
            ? Math.min(configuredMaxRounds * members.length, 20)
            : Math.max(members.length, Math.min(10, members.length * 2));
        const totalRoundsCount = Math.ceil(maxTurnsCount / members.length);
        for (let turnIndex = 0; turnIndex < maxTurnsCount; turnIndex++) {
            const memberIndex = turnIndex % members.length;
            const member = members[memberIndex];
            const speakerName = speakerNamesByMemberIndex[memberIndex];
            const isFirstTurnForMember = !agentIdsByMemberIndex.has(memberIndex);
            const currentRound = Math.floor(turnIndex / members.length) + 1;
            logger.info(`[PeerToPeerRouter] Turn ${turnIndex + 1}/${maxTurnsCount} (Round ${currentRound}): Active Speaker is "${speakerName}" (${member.description})${isFirstTurnForMember ? " [initial spawn]" : " [session continuation]"}`);
            // Compile shared conversation thread history with explicit speaker identity
            const speakerIdentityLine = `Your speaker identity in this discussion is ${speakerName}. Tag all your contributions with [${speakerName}].`;
            const promptHistory = sharedDiscussion.length > 0
                ? `--- SHARED DISCUSSION BOARD ---\n${sharedDiscussion.join("\n\n")}\n\n--- YOUR TASK (${speakerName}) ---\n${speakerIdentityLine}\n\n${member.prompt}`
                : `${speakerIdentityLine}\n\n${member.prompt}`;
            let spawnResult;
            if (isFirstTurnForMember) {
                // ── First turn: Spawn the agent with preserveWorktree so the worktree
                // stays alive for subsequent continuation turns.
                const resolvedSiblings = await resolveSiblingInstances({ providerName, resolvedModel }, "PeerToPeerRouter");
                const { assignedProvider, assignedModel } = selectInstanceForMember(member, resolvedSiblings, { providerName, resolvedModel });
                const assignment = {
                    description: `${member.description} (Turn ${turnIndex + 1})`,
                    prompt: promptHistory,
                    files: member.files,
                    model: member.model,
                    agent: member.agent,
                    assignedProvider,
                    assignedModel,
                    agentIndex: memberIndex,
                    teamSize: members.length,
                    round: currentRound,
                    totalRounds: totalRoundsCount,
                    orchestratorContext,
                    preserveWorktree: true,
                };
                spawnResult = await spawnSubAgent(assignment);
                // Register the agentId so subsequent turns reuse this agent
                if (!("error" in spawnResult)) {
                    agentIdsByMemberIndex.set(memberIndex, spawnResult.agent_id);
                }
            }
            else {
                // ── Subsequent turn: Continue the existing agent session.
                // The agent retains its conversation history, worktree state, and tool context.
                const existingAgentId = agentIdsByMemberIndex.get(memberIndex);
                if (!continueSubAgent) {
                    logger.error(`[PeerToPeerRouter] continueSubAgent callback not provided — cannot reuse session for "${speakerName}"`);
                    spawnResult = {
                        error: "continueSubAgent callback not available for session reuse",
                    };
                }
                else {
                    spawnResult = await continueSubAgent(existingAgentId, promptHistory, orchestratorContext, currentRound);
                }
            }
            latestResultByMemberIndex.set(memberIndex, spawnResult);
            if ("error" in spawnResult) {
                logger.error(`[PeerToPeerRouter] Turn failed for speaker "${speakerName}": ${spawnResult.error}. Aborting mesh.`);
                break;
            }
            if (spawnResult.status === "failed") {
                logger.error(`[PeerToPeerRouter] Turn failed for speaker "${speakerName}". Aborting mesh.`);
                break;
            }
            // Merge modifications back so other worktrees see them (only if the agent actually changed files)
            const hasFileChanges = spawnResult.status === "completed" &&
                spawnResult.agent_id &&
                spawnResult.diff;
            if (hasFileChanges) {
                const subAgentId = spawnResult.agent_id;
                const branchName = `orchestrator/${subAgentId}`;
                const workspaceRoot = GitWorktreeHelper.getDefaultWorkspaceRoot(orchestratorContext.workspaceRoot ?? undefined);
                const repositoryPath = GitWorktreeHelper.resolveRepositoryPath(workspaceRoot, member.files || []);
                logger.info(`[PeerToPeerRouter] Merging branch ${branchName} back into main repo`);
                const mergeResult = await GitWorktreeHelper.mergeWorktree(repositoryPath, branchName, `chore(mesh): merge turn ${turnIndex + 1} from ${speakerName}`);
                if (mergeResult.error) {
                    const errorMessage = `Failed to merge branch for ${subAgentId}: ${mergeResult.error}`;
                    logger.error(`[PeerToPeerRouter] ${errorMessage}`);
                    return [
                        ...latestResultByMemberIndex.values(),
                        { error: errorMessage },
                    ];
                }
            }
            else if (spawnResult.status === "completed") {
                logger.info(`[PeerToPeerRouter] No file changes from speaker "${speakerName}" — skipping merge step`);
            }
            // Append speaker output to shared thread — strip any echoed discussion
            // board markers the sub-agent may have included in its response to keep
            // the shared thread flat and avoid nested board duplication.
            const rawResponseText = spawnResult.result ||
                buildToolCallFallbackSummary(spawnResult) ||
                spawnResult.summary;
            const cleanedResponseText = stripEchoedDiscussionMarkers(rawResponseText);
            sharedDiscussion.push(`[${speakerName}]: ${cleanedResponseText}`);
            // Early exit check: if an agent signs off with [DONE] or all tasks are finished
            if (rawResponseText.toUpperCase().includes("[DONE]")) {
                logger.info(`[PeerToPeerRouter] Speaker "${speakerName}" signaled termination ([DONE]). Stopping.`);
                break;
            }
            // Stall detection — short response with no tool usage indicates the agent
            // had nothing actionable. Consecutive stalls abort the mesh to prevent runaway loops.
            if (isStallResponse(rawResponseText, spawnResult)) {
                consecutiveStallCount++;
                logger.warn(`[PeerToPeerRouter] Stall detected from "${speakerName}" (${consecutiveStallCount}/${maximumConsecutiveStalls} consecutive stalls)`);
                if (consecutiveStallCount >= maximumConsecutiveStalls) {
                    logger.error(`[PeerToPeerRouter] ${maximumConsecutiveStalls} consecutive stall responses detected — aborting mesh to prevent runaway loop`);
                    break;
                }
            }
            else {
                consecutiveStallCount = 0;
            }
        }
        // Return the most recent result per member slot (not per turn).
        // This keeps the result array aligned 1:1 with the original members array,
        // which is what the frontend TeamCreateRenderer expects.
        return [...latestResultByMemberIndex.values()];
    }
}
//# sourceMappingURL=PeerToPeerRouter.js.map