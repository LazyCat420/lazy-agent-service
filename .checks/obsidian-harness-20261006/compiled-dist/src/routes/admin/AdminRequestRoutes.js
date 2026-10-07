import { ObjectId } from "mongodb";
import { DEFAULT_WORKFLOW_TITLE } from "@rodrigo-barraza/utilities-library/taxonomy";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import { COLLECTIONS } from "../../constants.js";
import logger from "../../utils/logger.js";
import { getErrorMessage } from "../../utils/ErrorHelpers.js";
import { applyDateRangeFilter, parsePaginationParams, } from "../../utils/QueryBuilders.js";
import requireDb from "../../middleware/RequireDbMiddleware.js";
const router = express.Router();
const { REQUESTS: REQUESTS_COLLECTION, MODEL_CONVERSATIONS: CONVERSATIONS_COLLECTION, WORKFLOWS: WORKFLOWS_COLLECTION, } = COLLECTIONS;
router.use(requireDb);
// ─── GET /requests — paginated, filtered request logs ─
router.get("/", asyncHandler(async (req, res, next) => {
    try {
        const { project, username, provider, model, endpoint, operation, success, agent, from, to, sort = "timestamp", workspace, } = req.query;
        const { skip, limit, page, sortDirection } = parsePaginationParams(req.query);
        const filter = {};
        if (project)
            filter.project = project;
        if (username)
            filter.username = username;
        if (model)
            filter.model = model;
        if (workspace) {
            const [convDocs, agentConvDocs] = await Promise.all([
                req.db
                    .collection(COLLECTIONS.MODEL_CONVERSATIONS)
                    .find({ workspaceRoot: workspace })
                    .project({ id: 1 })
                    .toArray(),
                req.db
                    .collection(COLLECTIONS.AGENT_CONVERSATIONS)
                    .find({ workspaceRoot: workspace })
                    .project({ id: 1 })
                    .toArray(),
            ]);
            const convIds = convDocs.map((document) => document.id);
            const agentConversationIds = agentConvDocs.map((document) => document.id);
            filter.$or = [
                { conversationId: { $in: convIds } },
                { agentConversationId: { $in: agentConversationIds } },
                { parentAgentConversationId: { $in: agentConversationIds } },
            ];
        }
        const applyCommaSeparatedFilter = (key, value) => {
            if (!value)
                return;
            const values = String(value).split(",").filter(Boolean);
            if (values.length === 1)
                filter[key] = values[0];
            else if (values.length > 1)
                filter[key] = { $in: values };
        };
        applyCommaSeparatedFilter("provider", provider);
        applyCommaSeparatedFilter("endpoint", endpoint);
        applyCommaSeparatedFilter("operation", operation);
        applyCommaSeparatedFilter("agent", agent);
        if (success !== undefined) {
            const successValues = String(success).split(",").filter(Boolean);
            if (successValues.length === 1)
                filter.success = successValues[0] === "true";
            else if (successValues.length > 1)
                filter.success = {
                    $in: successValues.map((value) => value === "true"),
                };
        }
        applyDateRangeFilter(filter, from, to);
        const [docs, total] = await Promise.all([
            req.db
                .collection(REQUESTS_COLLECTION)
                .find(filter, {
                projection: { requestPayload: 0, responsePayload: 0 },
            })
                .sort({ [sort]: sortDirection })
                .skip(skip)
                .limit(limit)
                .toArray(),
            req.db.collection(REQUESTS_COLLECTION).countDocuments(filter),
        ]);
        res.json({ data: docs, total, page, limit });
    }
    catch (error) {
        logger.error(`Admin /requests error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
// ─── GET /requests/:id — single request detail ────────
router.get("/:id", asyncHandler(async (req, res, next) => {
    try {
        const requestIdentifier = req.params.id;
        // Try by requestId field first, then fall back to MongoDB _id
        let document = await req.db
            .collection(REQUESTS_COLLECTION)
            .findOne({ requestId: requestIdentifier });
        if (!document && ObjectId.isValid(requestIdentifier)) {
            document = await req.db
                .collection(REQUESTS_COLLECTION)
                .findOne({ _id: new ObjectId(requestIdentifier) });
        }
        if (!document)
            return res.status(404).json({ error: "Request not found" });
        res.json(document);
    }
    catch (error) {
        logger.error(`Admin /requests/:id error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
// ─── GET /requests/:id/associations — conversations, workflows & traces ─
router.get("/:id/associations", asyncHandler(async (req, res, next) => {
    try {
        const requestIdentifier = req.params.id;
        let request = await req.db
            .collection(REQUESTS_COLLECTION)
            .findOne({ requestId: requestIdentifier });
        if (!request && ObjectId.isValid(requestIdentifier)) {
            request = await req.db
                .collection(REQUESTS_COLLECTION)
                .findOne({ _id: new ObjectId(requestIdentifier) });
        }
        if (!request)
            return res.status(404).json({ error: "Request not found" });
        let conversations = [];
        let workflows = [];
        let traces = [];
        if (request.conversationId) {
            conversations = await req.db
                .collection(CONVERSATIONS_COLLECTION)
                .find({ id: request.conversationId })
                .project({
                id: 1,
                title: 1,
                project: 1,
                traceId: 1,
                model: 1,
                totalCost: 1,
                modalities: 1,
                providers: 1,
                updatedAt: 1,
                createdAt: 1,
                username: 1,
            })
                .toArray();
            workflows = await req.db
                .collection(WORKFLOWS_COLLECTION)
                .find({ conversationIds: request.conversationId })
                .project({ _id: 1, name: 1, nodeCount: 1, edgeCount: 1, source: 1 })
                .toArray();
            workflows = workflows.map((record) => ({
                id: record._id.toString(),
                name: record.name || DEFAULT_WORKFLOW_TITLE,
                nodeCount: record.nodeCount || 0,
                edgeCount: record.edgeCount || 0,
                source: record.source || "prism-client",
            }));
            const traceIds = new Set();
            for (const conversation of conversations) {
                if (conversation.traceId)
                    traceIds.add(conversation.traceId);
            }
            if (traceIds.size > 0) {
                const traceAgg = await req.db
                    .collection(REQUESTS_COLLECTION)
                    .aggregate([
                    { $match: { traceId: { $in: [...traceIds] } } },
                    {
                        $group: {
                            _id: "$traceId",
                            requestCount: { $sum: 1 },
                            project: { $first: "$project" },
                            username: { $first: "$username" },
                            createdAt: { $min: "$timestamp" },
                            updatedAt: { $max: "$timestamp" },
                        },
                    },
                ])
                    .toArray();
                traces = traceAgg.map((s) => ({
                    id: s._id,
                    project: s.project,
                    username: s.username,
                    requestCount: s.requestCount,
                    createdAt: s.createdAt,
                    updatedAt: s.updatedAt,
                }));
            }
        }
        res.json({ conversations, workflows, traces });
    }
    catch (error) {
        logger.error(`Admin /requests/:id/associations error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
export default router;
//# sourceMappingURL=AdminRequestRoutes.js.map