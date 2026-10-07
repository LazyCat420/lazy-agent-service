import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { DEFAULT_USERNAME } from "@rodrigo-barraza/utilities-library/taxonomy";
import express from "express";
import requireDb from "../middleware/RequireDbMiddleware.js";
import ConversationService, { buildConversationPatchFields, enrichConversationsWithRequestCosts, enrichSingleConversationCost, } from "../services/ConversationService.js";
import { COLLECTIONS, COST_SUM_EXPR } from "../constants.js";
import logger from "../utils/logger.js";
import ConversationTimerService from "../services/ConversationTimerService.js";
import AgenticLoopService from "../services/AgenticLoopService.js";
import { GetConversationsQuerySchema, PostConversationMessagesBodySchema, PatchConversationBodySchema, } from "../types/index.js";
import { CONVERSATION_LIST_BASE_PROJECTION } from "../utils/QueryBuilders.js";
const router = express.Router();
router.use(requireDb);
const CONVERSATION_LIST_PROJECTION = {
    ...CONVERSATION_LIST_BASE_PROJECTION,
    isGenerating: 1,
    traceId: 1,
    synthetic: 1,
    systemPrompt: 1,
    model: 1,
    modelNames: 1,
    settings: 1,
    parentAgentConversationId: 1,
    subAgents: 1,
};
/**
 * GET /conversations
 * List both direct conversations and agent conversations, merged and sorted by updatedAt.
 */
router.get("/", asyncHandler(async (req, res, next) => {
    try {
        const username = req.username || "any";
        const { db } = req;
        const parsed = GetConversationsQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            return res.status(400).json({ error: parsed.error.format() });
        }
        const { limit, cursor, agent, type = "all", taskId, project: queryProject } = parsed.data;
        const project = queryProject || req.project || "any";
        // Include conversations created under DEFAULT_USERNAME ("anonymous")
        // as a fallback — handles the migration scenario where conversations
        // were created before the x-username header was introduced.
        const usernameFilter = username !== DEFAULT_USERNAME
            ? { $in: [username, DEFAULT_USERNAME] }
            : username;
        const filter = {};
        if (taskId) {
            filter.taskId = taskId;
        }
        else {
            filter.project = project;
            filter.username = usernameFilter;
        }
        if (cursor) {
            filter.updatedAt = { $lt: cursor };
        }
        let modelConversations = [];
        let agentConversations = [];
        const fetchModelConversations = () => db
            .collection(COLLECTIONS.MODEL_CONVERSATIONS)
            .find(filter)
            .project(CONVERSATION_LIST_PROJECTION)
            .sort({ updatedAt: -1 })
            .limit(limit + 1)
            .toArray();
        const fetchAgentConversations = async () => {
            const agentFilter = { ...filter };
            if (agent) {
                agentFilter.agent = agent;
            }
            const directMatches = await db
                .collection(COLLECTIONS.AGENT_CONVERSATIONS)
                .find(agentFilter)
                .project(CONVERSATION_LIST_PROJECTION)
                .sort({ updatedAt: -1 })
                .limit(limit + 1)
                .toArray();
            // When filtering by agent, also discover sub-agent conversations
            // spawned by the matched orchestrator conversations — these may
            // have a different `agent` persona but belong to the same tree.
            if (agent && directMatches.length > 0) {
                const directMatchIds = directMatches
                    .map((document) => document.id)
                    .filter(Boolean);
                // Iteratively walk the parentConversationId chain to find all
                // descendant sub-agent conversations (multi-level nesting).
                const allDiscoveredIds = new Set(directMatchIds);
                let frontier = directMatchIds;
                const maxDepthIterations = 5;
                for (let depth = 0; depth < maxDepthIterations && frontier.length > 0; depth++) {
                    const childConversations = await db
                        .collection(COLLECTIONS.AGENT_CONVERSATIONS)
                        .find({
                        parentConversationId: { $in: frontier },
                        project: filter.project,
                        username: filter.username,
                        ...(cursor ? { updatedAt: filter.updatedAt } : {}),
                    })
                        .project(CONVERSATION_LIST_PROJECTION)
                        .sort({ updatedAt: -1 })
                        .toArray();
                    const newFrontier = [];
                    for (const childConversation of childConversations) {
                        const childRecord = childConversation;
                        const childId = childRecord.id;
                        if (childId && !allDiscoveredIds.has(childId)) {
                            allDiscoveredIds.add(childId);
                            directMatches.push(childConversation);
                            newFrontier.push(childId);
                        }
                    }
                    frontier = newFrontier;
                }
            }
            return directMatches;
        };
        if (type === "all") {
            const [fetchedModelConversations, fetchedAgentConversations] = await Promise.all([
                fetchModelConversations(),
                fetchAgentConversations(),
            ]);
            modelConversations = fetchedModelConversations;
            agentConversations = fetchedAgentConversations;
        }
        else if (type === "direct") {
            modelConversations = await fetchModelConversations();
        }
        else if (type === "agent") {
            agentConversations = await fetchAgentConversations();
        }
        // Enrich conversations with authoritative totalCost from request logs.
        // The document-level totalCost (from message estimatedCost sums) can be
        // stale or incomplete — the requests collection is the source of truth.
        // Background operations (memory extraction, embedding, consolidation)
        // log costs to the requests collection but never update the conversation
        // document, causing the sidebar cost badge to show stale values.
        const queryAndEnrichConversationsWithRequestCosts = async (conversations, isAgentType) => {
            if (conversations.length === 0)
                return;
            const conversationIds = conversations
                .map((conversation) => conversation.id)
                .filter(Boolean);
            if (conversationIds.length === 0)
                return;
            try {
                const matchCondition = isAgentType
                    ? {
                        $or: [
                            { agentConversationId: { $in: conversationIds } },
                            { conversationId: { $in: conversationIds } },
                            { parentAgentConversationId: { $in: conversationIds } },
                        ],
                    }
                    : { conversationId: { $in: conversationIds } };
                const groupId = isAgentType
                    ? {
                        $cond: [
                            {
                                $and: [
                                    { $ne: ["$parentAgentConversationId", null] },
                                    { $in: ["$parentAgentConversationId", conversationIds] },
                                ],
                            },
                            "$parentAgentConversationId",
                            { $ifNull: ["$conversationId", "$agentConversationId"] },
                        ],
                    }
                    : "$conversationId";
                const costAggregation = await db
                    .collection(COLLECTIONS.REQUESTS)
                    .aggregate([
                    {
                        $match: {
                            ...matchCondition,
                            project,
                            username: usernameFilter,
                        },
                    },
                    {
                        $group: {
                            _id: groupId,
                            totalCost: COST_SUM_EXPR,
                            requestErrorCount: {
                                $sum: { $cond: [{ $eq: ["$success", false] }, 1, 0] },
                            },
                        },
                    },
                ])
                    .toArray();
                enrichConversationsWithRequestCosts(conversations, costAggregation);
            }
            catch (costError) {
                logger.warn(`Failed to enrich ${isAgentType ? "agent conversation" : "conversation"} costs: ${errorMessage(costError)}`);
            }
        };
        // Enrich conversations with `hasSubAgents` by cross-referencing
        // child conversations that point back via `parentConversationId`.
        // The stored flag may be missing on conversations created before the flag
        // was introduced or when the write failed silently at spawn time.
        const enrichConversationsWithSubAgentFlag = async (conversations) => {
            if (conversations.length === 0)
                return;
            const conversationIds = conversations
                .map((conversation) => conversation.id)
                .filter(Boolean);
            if (conversationIds.length === 0)
                return;
            try {
                const parentFieldQuery = {
                    parentConversationId: { $in: conversationIds },
                    project,
                    username: usernameFilter,
                };
                const [agentParents, modelParents] = await Promise.all([
                    db
                        .collection(COLLECTIONS.AGENT_CONVERSATIONS)
                        .find(parentFieldQuery)
                        .project({ parentConversationId: 1 })
                        .toArray(),
                    db
                        .collection(COLLECTIONS.MODEL_CONVERSATIONS)
                        .find(parentFieldQuery)
                        .project({ parentConversationId: 1 })
                        .toArray(),
                ]);
                const parentIdSet = new Set();
                for (const childDocument of [...agentParents, ...modelParents]) {
                    const documentRecord = childDocument;
                    const linkId = documentRecord.parentConversationId;
                    if (linkId)
                        parentIdSet.add(linkId);
                }
                if (parentIdSet.size > 0) {
                    for (const conversation of conversations) {
                        const conversationRecord = conversation;
                        if (parentIdSet.has(conversationRecord.id)) {
                            conversationRecord.hasSubAgents = true;
                        }
                    }
                }
            }
            catch (enrichmentError) {
                logger.warn(`Failed to enrich conversations with hasSubAgents flag: ${errorMessage(enrichmentError)}`);
            }
        };
        await Promise.all([
            queryAndEnrichConversationsWithRequestCosts(modelConversations, false),
            queryAndEnrichConversationsWithRequestCosts(agentConversations, true),
            enrichConversationsWithSubAgentFlag(modelConversations),
            enrichConversationsWithSubAgentFlag(agentConversations),
        ]);
        // Derive hasSubAgents from the stored subAgents array (primary source
        // of truth, written by BaseAgenticHarness.finalize) and strip the
        // heavy array from the list response. The cross-reference enrichment
        // above acts as a secondary fallback for conversations that predate the
        // subAgents array or where finalize didn't run.
        const deriveAndStripSubAgentsArray = (conversations) => {
            for (const conversation of conversations) {
                const record = conversation;
                const storedSubAgents = record.subAgents;
                if (storedSubAgents &&
                    Array.isArray(storedSubAgents) &&
                    storedSubAgents.length > 0) {
                    record.hasSubAgents = true;
                }
                delete record.subAgents;
            }
        };
        deriveAndStripSubAgentsArray(modelConversations);
        deriveAndStripSubAgentsArray(agentConversations);
        // Merge and sort in memory by updatedAt descending
        const merged = [
            ...modelConversations.map((conversation) => ({
                ...conversation,
                type: "direct",
            })),
            ...agentConversations.map((conversation) => ({
                ...conversation,
                type: "agent",
            })),
        ];
        merged.sort((firstConversation, secondConversation) => new Date(secondConversation.updatedAt).getTime() -
            new Date(firstConversation.updatedAt).getTime());
        const hasMore = merged.length > limit;
        const items = hasMore ? merged.slice(0, limit) : merged;
        const nextCursor = hasMore
            ? items[items.length - 1].updatedAt
            : null;
        res.json({ items, nextCursor, hasMore });
    }
    catch (error) {
        logger.error(`Error fetching unified conversations: ${errorMessage(error)}`);
        next(error);
    }
}));
/**
 * GET /conversations/:id
 * Get a specific conversation or agent conversation.
 */
router.get("/:id", asyncHandler(async (req, res, next) => {
    try {
        const queryProject = req.query.project;
        const project = queryProject || req.project || "any";
        const username = req.username || "any";
        const { db } = req;
        const conversationId = req.params.id;
        const usernameFilter = username !== DEFAULT_USERNAME
            ? { $in: [username, DEFAULT_USERNAME] }
            : username;
        // Check conversations first
        const chat = await db
            .collection(COLLECTIONS.MODEL_CONVERSATIONS)
            .findOne({ id: conversationId, project, username: usernameFilter });
        if (chat) {
            // Enrich totalCost from the requests collection (source of truth).
            // Background operations (memory extraction, embedding) log their
            // costs to requests but never update the conversation document.
            try {
                const costAggregation = await db
                    .collection(COLLECTIONS.REQUESTS)
                    .aggregate([
                    {
                        $match: { conversationId, project, username: usernameFilter },
                    },
                    {
                        $group: {
                            _id: "$conversationId",
                            totalCost: COST_SUM_EXPR,
                            requestErrorCount: {
                                $sum: { $cond: [{ $eq: ["$success", false] }, 1, 0] },
                            },
                        },
                    },
                ])
                    .toArray();
                enrichSingleConversationCost(chat, costAggregation);
            }
            catch {
                // Non-fatal — fall back to document-level totalCost
            }
            const pendingApproval = AgenticLoopService.getPendingApproval(conversationId);
            const pendingQuestion = AgenticLoopService.getPendingQuestion(conversationId);
            return res.json({
                ...chat,
                type: "direct",
                pendingApproval: pendingApproval.isPending
                    ? pendingApproval
                    : undefined,
                pendingQuestion: pendingQuestion.isPending
                    ? pendingQuestion
                    : undefined,
            });
        }
        // Check agent conversations next
        const agentChat = await db
            .collection(COLLECTIONS.AGENT_CONVERSATIONS)
            .findOne({ id: conversationId, project, username: usernameFilter });
        if (agentChat) {
            const stats = await ConversationService.getConversationStats(conversationId, project, username);
            const pendingApproval = AgenticLoopService.getPendingApproval(conversationId);
            const pendingQuestion = AgenticLoopService.getPendingQuestion(conversationId);
            // Derive hasSubAgents from the stored subAgents array when the
            // persisted boolean flag is missing (conversations created before the
            // flag was introduced or when the OrchestratorService write failed).
            const agentChatRecord = agentChat;
            if (!agentChatRecord.hasSubAgents &&
                Array.isArray(agentChatRecord.subAgents) &&
                agentChatRecord.subAgents.length > 0) {
                agentChatRecord.hasSubAgents = true;
            }
            return res.json({
                ...agentChat,
                stats: stats || undefined,
                type: "agent",
                pendingApproval: pendingApproval.isPending
                    ? pendingApproval
                    : undefined,
                pendingQuestion: pendingQuestion.isPending
                    ? pendingQuestion
                    : undefined,
            });
        }
        res.status(404).json({ error: "Conversation not found" });
    }
    catch (error) {
        logger.error(`Error fetching specific conversation: ${errorMessage(error)}`);
        next(error);
    }
}));
/**
 * GET /conversations/:id/workflows
 * Find workflows that include this conversation ID.
 */
router.get("/:id/workflows", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        const conversationId = req.params.id;
        const workflows = await db
            .collection("workflows")
            .find({ conversationIds: conversationId })
            .project({ workflowName: 1, updatedAt: 1 })
            .toArray();
        res.json(workflows);
    }
    catch (error) {
        logger.error(`Error fetching conversation workflows: ${errorMessage(error)}`);
        next(error);
    }
}));
/**
 * POST /conversations/:id/messages
 * Append messages to an existing conversation or agent conversation.
 */
router.post("/:id/messages", asyncHandler(async (req, res, next) => {
    try {
        const queryProject = req.query.project;
        const project = queryProject || req.project || "any";
        const username = req.username || "any";
        const { db } = req;
        const conversationId = req.params.id;
        const usernameFilter = username !== DEFAULT_USERNAME
            ? { $in: [username, DEFAULT_USERNAME] }
            : username;
        const parsed = PostConversationMessagesBodySchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: parsed.error.format() });
        }
        const { messages, conversationMeta } = parsed.data;
        // Determine which collection has this chat
        let isAgent = false;
        const directExists = await db
            .collection(COLLECTIONS.MODEL_CONVERSATIONS)
            .countDocuments({ id: conversationId, project, username: usernameFilter });
        if (directExists === 0) {
            const agentExists = await db
                .collection(COLLECTIONS.AGENT_CONVERSATIONS)
                .countDocuments({ id: conversationId, project, username: usernameFilter });
            if (agentExists > 0) {
                isAgent = true;
            }
            else {
                return res.status(404).json({ error: "Conversation not found" });
            }
        }
        const conversation = await ConversationService.appendMessages(conversationId, project, username, messages, conversationMeta || null, { collection: isAgent ? COLLECTIONS.AGENT_CONVERSATIONS : undefined });
        res.json({ ...conversation, type: isAgent ? "agent" : "direct" });
    }
    catch (error) {
        logger.error(`Error appending messages to conversation: ${errorMessage(error)}`);
        next(error);
    }
}));
/**
 * PATCH /conversations/:id
 * Update specific fields of a conversation or agent conversation.
 */
router.patch("/:id", asyncHandler(async (req, res, next) => {
    try {
        const queryProject = req.query.project;
        const project = queryProject || req.project || "any";
        const username = req.username || "any";
        const { db } = req;
        const conversationId = req.params.id;
        const usernameFilter = username !== DEFAULT_USERNAME
            ? { $in: [username, DEFAULT_USERNAME] }
            : username;
        const parsed = PatchConversationBodySchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: parsed.error.format() });
        }
        const setFields = buildConversationPatchFields(parsed.data);
        // Try updating conversations first
        let result = await db
            .collection(COLLECTIONS.MODEL_CONVERSATIONS)
            .updateOne({ id: conversationId, project, username: usernameFilter }, {
            $set: setFields,
        });
        if (result.matchedCount > 0) {
            const conversation = await db
                .collection(COLLECTIONS.MODEL_CONVERSATIONS)
                .findOne({ id: conversationId, project, username: usernameFilter });
            return res.json({ ...conversation, type: "direct" });
        }
        // Try updating agent conversations next
        result = await db.collection(COLLECTIONS.AGENT_CONVERSATIONS).updateOne({ id: conversationId, project, username: usernameFilter }, {
            $set: setFields,
        });
        if (result.matchedCount > 0) {
            const agentConversation = await db
                .collection(COLLECTIONS.AGENT_CONVERSATIONS)
                .findOne({ id: conversationId, project, username: usernameFilter });
            return res.json({ ...agentConversation, type: "agent" });
        }
        res.status(404).json({ error: "Conversation not found" });
    }
    catch (error) {
        logger.error(`Error patching conversation: ${errorMessage(error)}`);
        next(error);
    }
}));
/**
 * DELETE /conversations/:id
 * Delete a specific conversation or agent conversation.
 * Cascading: iteratively deletes all descendant sub-agent conversations
 * linked via `parentConversationId` across both collections.
 */
router.delete("/:id", asyncHandler(async (req, res, next) => {
    try {
        const queryProject = req.query.project;
        const project = queryProject || req.project || "any";
        const username = req.username || "any";
        const { db } = req;
        const conversationId = req.params.id;
        const usernameFilter = username !== DEFAULT_USERNAME
            ? { $in: [username, DEFAULT_USERNAME] }
            : username;
        // Try deleting from conversations first
        let result = await db
            .collection(COLLECTIONS.MODEL_CONVERSATIONS)
            .deleteOne({ id: conversationId, project, username: usernameFilter });
        let deletedType = null;
        if (result.deletedCount > 0) {
            deletedType = "direct";
        }
        else {
            // Try deleting from agent conversations next
            result = await db
                .collection(COLLECTIONS.AGENT_CONVERSATIONS)
                .deleteOne({ id: conversationId, project, username: usernameFilter });
            if (result.deletedCount > 0) {
                deletedType = "agent";
            }
        }
        if (!deletedType) {
            return res.status(404).json({ error: "Conversation not found" });
        }
        // Cascading deletion: iteratively discover and delete all descendant
        // conversations linked via parentConversationId (BFS traversal).
        const MAX_CASCADE_DEPTH = 10;
        const ownershipFilter = { project, username: usernameFilter };
        let descendantDeletedCount = 0;
        let frontier = [conversationId];
        for (let depth = 0; depth < MAX_CASCADE_DEPTH && frontier.length > 0; depth++) {
            const parentFilter = {
                parentConversationId: { $in: frontier },
                ...ownershipFilter,
            };
            // Discover child IDs from both collections before deleting
            const [agentChildren, modelChildren] = await Promise.all([
                db
                    .collection(COLLECTIONS.AGENT_CONVERSATIONS)
                    .find(parentFilter)
                    .project({ id: 1 })
                    .toArray(),
                db
                    .collection(COLLECTIONS.MODEL_CONVERSATIONS)
                    .find(parentFilter)
                    .project({ id: 1 })
                    .toArray(),
            ]);
            const childIds = [
                ...agentChildren.map((document) => document.id),
                ...modelChildren.map((document) => document.id),
            ].filter(Boolean);
            if (childIds.length === 0)
                break;
            // Bulk-delete children from both collections
            const [agentDeletion, modelDeletion] = await Promise.all([
                db
                    .collection(COLLECTIONS.AGENT_CONVERSATIONS)
                    .deleteMany({ id: { $in: childIds }, ...ownershipFilter }),
                db
                    .collection(COLLECTIONS.MODEL_CONVERSATIONS)
                    .deleteMany({ id: { $in: childIds }, ...ownershipFilter }),
            ]);
            descendantDeletedCount +=
                (agentDeletion.deletedCount || 0) +
                    (modelDeletion.deletedCount || 0);
            frontier = childIds;
        }
        if (descendantDeletedCount > 0) {
            logger.info(`Cascade-deleted ${descendantDeletedCount} descendant conversation(s) for ${conversationId}`);
        }
        return res.json({
            success: true,
            id: conversationId,
            type: deletedType,
            descendantsDeleted: descendantDeletedCount,
        });
    }
    catch (error) {
        logger.error(`Error deleting conversation: ${errorMessage(error)}`);
        next(error);
    }
}));
/**
 * GET /conversations/:id/timers
 * List all active scheduled timers for this conversation.
 */
router.get("/:id/timers", asyncHandler(async (req, res) => {
    const project = req.project || "any";
    const username = req.username || "any";
    const conversationId = req.params.id;
    const activeTimers = await ConversationTimerService.listActiveTimers(conversationId, project, username);
    res.json(activeTimers);
}));
/**
 * POST /conversations/:id/timers/:timerId/cancel
 * Cancel a specific scheduled timer.
 */
router.post("/:id/timers/:timerId/cancel", asyncHandler(async (req, res) => {
    const project = req.project || "any";
    const username = req.username || "any";
    const timerId = req.params.timerId;
    const wasCancelled = await ConversationTimerService.cancelTimer(timerId, project, username);
    res.json({ success: wasCancelled });
}));
export default router;
//# sourceMappingURL=ConversationsRoutes.js.map