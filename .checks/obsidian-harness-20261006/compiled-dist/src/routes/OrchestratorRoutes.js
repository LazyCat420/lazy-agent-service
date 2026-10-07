import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { Router } from "express";
import OrchestratorService from "../services/OrchestratorService.js";
import logger from "../utils/logger.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
const router = Router();
// ═══════════════════════════════════════════════════════════════
// Chat-Spawned Sub-Agent Endpoints
// ═══════════════════════════════════════════════════════════════
/*
 * GET /orchestrator/sub-agents
 * List all active sub-agents spawned via chat tools.
 * Optional query: ?conversationId=xxx to filter by parent conversation.
 */
router.get("/sub-agents", asyncHandler(async (request, response) => {
    const conversationIdQuery = request.query.conversationId;
    const conversationIdentifier = typeof conversationIdQuery === "string" ? conversationIdQuery : undefined;
    const activeSubAgentsList = conversationIdentifier
        ? OrchestratorService.listAllDescendantSubAgents(conversationIdentifier)
        : OrchestratorService.listSubAgents();
    let persistedSubAgentsList = [];
    if (conversationIdentifier) {
        try {
            const { default: MongoWrapper } = await import("../wrappers/MongoWrapper.js");
            const { MONGO_DB_NAME } = await import("../../config.js");
            const { COLLECTIONS } = await import("../constants.js");
            const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.AGENT_CONVERSATIONS);
            const rootConversationDocument = await collection.findOne({ id: conversationIdentifier }, { projection: { subAgents: 1, agentConversationId: 1 } });
            if (rootConversationDocument && rootConversationDocument.subAgents) {
                if (rootConversationDocument.subAgents.length > 0) {
                    persistedSubAgentsList = rootConversationDocument.subAgents;
                }
            }
            // Recursively discover all descendant sub-agents by traversing the
            // parentAgentConversationId / parentConversationId chain in AGENT_CONVERSATIONS.
            // Each sub-agent conversation may itself have a subAgents array if it
            // spawned its own workers (recursive sub-agent delegation).
            //
            // The root conversation's document `id` differs from the in-memory
            // `agentConversationId` used by the agentic loop. Child conversations
            // store `parentConversationId` → parent's `id`, and
            // `parentAgentConversationId` → parent's `agentConversationId`.
            // Seed the frontier with both IDs and query with $or at every hop.
            const MAX_DESCENDANT_DEPTH = 10;
            let frontier = [conversationIdentifier];
            const visitedConversationIds = new Set([conversationIdentifier]);
            // Include the root's agentConversationId (if different from id)
            const rootAgentConversationId = rootConversationDocument?.agentConversationId;
            if (rootAgentConversationId &&
                rootAgentConversationId !== conversationIdentifier) {
                frontier.push(rootAgentConversationId);
                visitedConversationIds.add(rootAgentConversationId);
            }
            for (let depth = 0; depth < MAX_DESCENDANT_DEPTH && frontier.length > 0; depth++) {
                const childConversationDocuments = await collection
                    .find({
                    $or: [
                        { parentAgentConversationId: { $in: frontier } },
                        { parentConversationId: { $in: frontier } },
                    ],
                }, { projection: { id: 1, agentConversationId: 1, subAgents: 1 } })
                    .toArray();
                if (childConversationDocuments.length === 0)
                    break;
                const nextFrontier = [];
                for (const childDocument of childConversationDocuments) {
                    const childConversationId = childDocument.id;
                    if (visitedConversationIds.has(childConversationId))
                        continue;
                    visitedConversationIds.add(childConversationId);
                    nextFrontier.push(childConversationId);
                    // Also track the agentConversationId (if stored and different from id)
                    // so that grandchildren linked via parentAgentConversationId are found.
                    const childAgentConversationId = childDocument.agentConversationId;
                    if (childAgentConversationId &&
                        childAgentConversationId !== childConversationId &&
                        !visitedConversationIds.has(childAgentConversationId)) {
                        visitedConversationIds.add(childAgentConversationId);
                        nextFrontier.push(childAgentConversationId);
                    }
                    if (Array.isArray(childDocument.subAgents) &&
                        childDocument.subAgents.length > 0) {
                        for (const descendantSubAgent of childDocument.subAgents) {
                            persistedSubAgentsList.push(descendantSubAgent);
                        }
                    }
                }
                frontier = nextFrontier;
            }
        }
        catch (error) {
            logger.warn(`[orchestrator] Failed to load persisted sub-agents: ${getErrorMessage(error)}`);
        }
    }
    const mergedSubAgentsMap = new Map();
    for (const subAgent of persistedSubAgentsList) {
        mergedSubAgentsMap.set(subAgent.agentId, subAgent);
    }
    for (const subAgent of activeSubAgentsList) {
        mergedSubAgentsMap.set(subAgent.agentId, subAgent);
    }
    const finalSubAgentsList = Array.from(mergedSubAgentsMap.values());
    response.json({ subAgents: finalSubAgentsList });
}));
/*
 * POST /orchestrator/sub-agents/stop
 * Abort all running sub-agents for a given parent conversation.
 * Called by the frontend when the user presses stop.
 *
 * Body: { conversationId: string }
 */
router.post("/sub-agents/stop", asyncHandler(async (request, response) => {
    const { conversationId } = request.body;
    if (!conversationId) {
        return response
            .status(400)
            .json({ error: "'conversationId' is required" });
    }
    const result = await OrchestratorService.abortSubAgentsByConversation(conversationId);
    response.json(result);
}));
/*
 * GET /orchestrator/sub-agents/:agentId
 * Get the status of a specific chat-spawned sub-agent.
 */
router.get("/sub-agents/:agentId", (request, response) => {
    const agentId = request.params.agentId;
    if (typeof agentId !== "string" || !agentId) {
        return response.status(400).json({ error: "agentId is required" });
    }
    const status = OrchestratorService.getSubAgentStatus(agentId);
    if (!status) {
        return response.status(404).json({ error: "Sub-agent not found" });
    }
    response.json(status);
});
export default router;
//# sourceMappingURL=OrchestratorRoutes.js.map