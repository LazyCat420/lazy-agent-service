import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import { COLLECTIONS, SSE_KEEPALIVE_INTERVAL_MS } from "../../constants.js";
import ChangeStreamService from "../../services/ChangeStreamService.js";
import BenchmarkService from "../../services/BenchmarkService.js";
import ActiveGenerationTracker from "../../services/ActiveGenerationTracker.js";
import AgentPersonaRegistry from "../../services/AgentPersonaRegistry.js";
import ToolOrchestratorService from "../../services/ToolOrchestratorService.js";
import logger from "../../utils/logger.js";
import { getErrorMessage } from "../../utils/ErrorHelpers.js";
import { applyDateRangeFilter, parsePaginationParams, CONVERSATION_LIST_BASE_PROJECTION, } from "../../utils/QueryBuilders.js";
import requireDb from "../../middleware/RequireDbMiddleware.js";
import { MILLISECONDS_PER_MINUTE, MILLISECONDS_PER_HOUR, minutes, } from "@rodrigo-barraza/utilities-library";
const router = express.Router();
const { REQUESTS: REQUESTS_COLLECTION, MODEL_CONVERSATIONS: CONVERSATIONS_COLLECTION, } = COLLECTIONS;
router.use(requireDb);
// ─── GET /conversations — cross-project conversation list ─
router.get("/", asyncHandler(async (req, res, next) => {
    try {
        const { project, username, search, provider, model, trace, from, to, sort = "updatedAt", order = "desc", agent, type, workspace, } = req.query;
        const { skip, limit, sortDirection } = parsePaginationParams(req.query);
        const filter = {};
        if (trace)
            filter.traceId = trace;
        if (project)
            filter.project = project;
        if (username)
            filter.username = username;
        if (workspace)
            filter.workspaceRoot = workspace;
        if (search) {
            const regex = { $regex: search, $options: "i" };
            const orClauses = [
                { title: regex },
                { project: regex },
                { username: regex },
            ];
            const searchString = typeof search === "string" ? search.trim() : "";
            if (/^[\d.:a-f]+$/i.test(searchString)) {
                const matchingConversationIds = await req.db
                    .collection(REQUESTS_COLLECTION)
                    .distinct("conversationId", { clientIp: regex });
                if (matchingConversationIds.length > 0) {
                    orClauses.push({ id: { $in: matchingConversationIds } });
                }
            }
            filter.$or = orClauses;
        }
        if (provider)
            filter.providers = provider;
        if (model)
            filter["messages.model"] = model;
        const fromString = typeof from === "string" ? from : undefined;
        const toString = typeof to === "string" ? to : undefined;
        applyDateRangeFilter(filter, fromString, toString, "updatedAt");
        const sortDirectionValue = sortDirection;
        const isDirectOnly = type === "direct" || agent === AGENT_IDS.NONE;
        const isAgentOnly = agent && agent !== AGENT_IDS.NONE && agent !== AGENT_IDS.ALL;
        const shouldFetchDirectConversations = !isAgentOnly;
        const shouldFetchAgentConversations = !isDirectOnly;
        const agentFilter = { ...filter };
        if (isAgentOnly) {
            agentFilter.agent = agent;
        }
        let directConversations = [];
        let agentConversations = [];
        const queryPromises = [];
        const sortKey = typeof sort === "string" ? sort : "updatedAt";
        if (shouldFetchDirectConversations) {
            queryPromises.push(req.db
                .collection(CONVERSATIONS_COLLECTION)
                .find(filter)
                .project({
                ...CONVERSATION_LIST_BASE_PROJECTION,
                messageCount: { $size: { $ifNull: ["$messages", []] } },
                totalCost: { $ifNull: ["$totalCost", 0] },
            })
                .sort({ [sortKey]: sortDirectionValue })
                .limit(skip + limit)
                .toArray()
                .then((result) => {
                directConversations = result;
            }));
        }
        if (shouldFetchAgentConversations) {
            queryPromises.push(req.db
                .collection(COLLECTIONS.AGENT_CONVERSATIONS)
                .find(agentFilter)
                .project({
                ...CONVERSATION_LIST_BASE_PROJECTION,
                messageCount: { $size: { $ifNull: ["$messages", []] } },
                totalCost: { $ifNull: ["$totalCost", 0] },
            })
                .sort({ [sortKey]: sortDirectionValue })
                .limit(skip + limit)
                .toArray()
                .then((result) => {
                agentConversations = result;
            }));
        }
        await Promise.all(queryPromises);
        let totalDirectConversations = 0;
        let totalAgentConversations = 0;
        const countPromises = [];
        if (shouldFetchDirectConversations) {
            countPromises.push(req.db
                .collection(CONVERSATIONS_COLLECTION)
                .countDocuments(filter)
                .then((result) => {
                totalDirectConversations = result;
            }));
        }
        if (shouldFetchAgentConversations) {
            countPromises.push(req.db
                .collection(COLLECTIONS.AGENT_CONVERSATIONS)
                .countDocuments(agentFilter)
                .then((result) => {
                totalAgentConversations = result;
            }));
        }
        await Promise.all(countPromises);
        const getSortValue = (item) => {
            const value = item[sortKey];
            return value !== undefined ? String(value) : "";
        };
        const merged = [
            ...directConversations.map((item) => ({ ...item, type: "direct" })),
            ...agentConversations.map((session) => ({ ...session, type: "agent" })),
        ].sort((firstItem, secondItem) => {
            const valueA = getSortValue(firstItem);
            const valueB = getSortValue(secondItem);
            if (valueA < valueB)
                return -sortDirectionValue;
            if (valueA > valueB)
                return sortDirectionValue;
            return 0;
        });
        const paginatedDocuments = merged.slice(skip, skip + limit);
        const paginatedDocumentIds = paginatedDocuments.map((document) => document.id);
        const agentConversationIds = paginatedDocuments
            .filter((document) => document.type === "agent")
            .map((document) => {
            const id = document.id;
            return typeof id === "string" ? id : "";
        })
            .filter(Boolean);
        const requests = await req.db
            .collection(REQUESTS_COLLECTION)
            .find({
            $or: [
                { conversationId: { $in: paginatedDocumentIds } },
                { agentConversationId: { $in: agentConversationIds } },
                { parentAgentConversationId: { $in: agentConversationIds } },
            ],
        })
            .project({
            conversationId: 1,
            agentConversationId: 1,
            parentAgentConversationId: 1,
            inputTokens: 1,
            outputTokens: 1,
            model: 1,
            tokensPerSec: 1,
            totalTime: 1,
            toolDisplayNames: 1,
            toolApiNames: 1,
            estimatedCost: 1,
        })
            .toArray();
        const requestLogMap = new Map();
        for (const requestItem of requests) {
            let targetId = "";
            if (requestItem.parentAgentConversationId &&
                agentConversationIds.includes(requestItem.parentAgentConversationId)) {
                targetId = requestItem.parentAgentConversationId;
            }
            else if (requestItem.agentConversationId &&
                agentConversationIds.includes(requestItem.agentConversationId)) {
                targetId = requestItem.agentConversationId;
            }
            else if (requestItem.conversationId) {
                targetId = requestItem.conversationId;
            }
            if (targetId) {
                if (!requestLogMap.has(targetId)) {
                    requestLogMap.set(targetId, []);
                }
                requestLogMap.get(targetId).push(requestItem);
            }
        }
        const enrichedDocuments = paginatedDocuments.map((document) => {
            const documentId = typeof document.id === "string" ? document.id : "";
            const associatedRequests = requestLogMap.get(documentId) || [];
            const models = Array.from(new Set(associatedRequests
                .map((requestItem) => requestItem.model)
                .filter(Boolean)));
            const toolDisplayNames = Array.from(new Set(associatedRequests
                .flatMap((requestItem) => (Array.isArray(requestItem.toolDisplayNames)
                ? requestItem.toolDisplayNames
                : []) || [])
                .filter(Boolean)));
            const toolApiNames = Array.from(new Set(associatedRequests
                .flatMap((requestItem) => (Array.isArray(requestItem.toolApiNames)
                ? requestItem.toolApiNames
                : []) || [])
                .filter(Boolean)));
            let inputTokens = 0;
            let outputTokens = 0;
            let totalLatency = 0;
            let tokensPerSecondSum = 0;
            let tokensPerSecondCount = 0;
            let aggregatedCost = 0;
            for (const requestItem of associatedRequests) {
                inputTokens += requestItem.inputTokens || 0;
                outputTokens += requestItem.outputTokens || 0;
                totalLatency += requestItem.totalTime || 0;
                aggregatedCost += requestItem.estimatedCost || 0;
                if (requestItem.tokensPerSec && requestItem.tokensPerSec > 0) {
                    tokensPerSecondSum += requestItem.tokensPerSec;
                    tokensPerSecondCount++;
                }
            }
            // Apply cost overlay for agent conversations
            const originalCost = document.totalCost || 0;
            const totalCost = document.type === "agent" && aggregatedCost > 0
                ? Math.max(originalCost, aggregatedCost)
                : originalCost;
            return {
                ...document,
                totalCost,
                requestCount: associatedRequests.length,
                inputTokens,
                outputTokens,
                models,
                toolDisplayNames,
                toolApiNames,
                avgTokensPerSec: tokensPerSecondCount > 0
                    ? tokensPerSecondSum / tokensPerSecondCount
                    : null,
                totalLatency,
            };
        });
        res.json({
            data: enrichedDocuments,
            total: totalDirectConversations + totalAgentConversations,
            page: parsePaginationParams(req.query).page,
            limit,
        });
    }
    catch (error) {
        logger.error("Admin /conversations error: " + getErrorMessage(error));
        next(error);
    }
}));
// ─── GET /conversations/filters — distinct filter values for admin dropdowns ─
router.get("/filters", asyncHandler(async (req, res, next) => {
    try {
        const [conversationProjects, requestProjects, usernames, models, providers] = await Promise.all([
            req.db.collection(CONVERSATIONS_COLLECTION).distinct("project"),
            req.db.collection(REQUESTS_COLLECTION).distinct("project"),
            req.db.collection(CONVERSATIONS_COLLECTION).distinct("username"),
            req.db.collection(REQUESTS_COLLECTION).distinct("model"),
            req.db.collection(REQUESTS_COLLECTION).distinct("provider"),
        ]);
        const projects = [...new Set([...conversationProjects, ...requestProjects])];
        const workspaceRoots = ToolOrchestratorService.getWorkspaceRoots();
        const agentPersonas = AgentPersonaRegistry.list().map((persona) => ({
            id: persona.id,
            name: persona.name,
        }));
        res.json({
            projects: projects.filter(Boolean).sort(),
            usernames: usernames.filter(Boolean).sort(),
            models: models.filter(Boolean).sort(),
            providers: providers.filter(Boolean).sort(),
            workspaces: workspaceRoots.filter(Boolean).sort(),
            agents: agentPersonas,
        });
    }
    catch (error) {
        logger.error(`Admin /conversations/filters error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
// ─── GET /conversations/stats — quick stats snapshot ──
router.get("/stats", asyncHandler(async (req, res, next) => {
    try {
        const project = req.query.project || null;
        const filter = project ? { project } : {};
        const oneHourAgo = new Date(Date.now() - MILLISECONDS_PER_HOUR).toISOString();
        const fiveMinAgo = new Date(Date.now() - minutes(5)).toISOString();
        const [generatingCount, recentCount] = await Promise.all([
            req.db.collection(CONVERSATIONS_COLLECTION).countDocuments({
                ...filter,
                isGenerating: true,
                updatedAt: { $gte: fiveMinAgo },
            }),
            project
                ? req.db
                    .collection(CONVERSATIONS_COLLECTION)
                    .countDocuments({ ...filter, updatedAt: { $gte: oneHourAgo } })
                : req.db
                    .collection(CONVERSATIONS_COLLECTION)
                    .estimatedDocumentCount(),
        ]);
        res.json({
            generatingCount: generatingCount +
                BenchmarkService.activeGenerationCount +
                ActiveGenerationTracker.count,
            recentCount,
        });
    }
    catch (error) {
        logger.error(`Admin /conversations/stats error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
// ─── GET /conversations/stream — SSE for real-time stats ─
router.get("/stream", asyncHandler(async (req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    });
    res.write("\n");
    const project = req.query.project || null;
    let lastPayload = "";
    const sendStats = async () => {
        try {
            const filter = project ? { project } : {};
            const oneHourAgo = new Date(Date.now() - MILLISECONDS_PER_HOUR).toISOString();
            const fiveMinAgo = new Date(Date.now() - minutes(5)).toISOString();
            const [generatingCount, recentCount] = await Promise.all([
                req.db.collection(CONVERSATIONS_COLLECTION).countDocuments({
                    ...filter,
                    isGenerating: true,
                    updatedAt: { $gte: fiveMinAgo },
                }),
                project
                    ? req.db
                        .collection(CONVERSATIONS_COLLECTION)
                        .countDocuments({ ...filter, updatedAt: { $gte: oneHourAgo } })
                    : req.db
                        .collection(CONVERSATIONS_COLLECTION)
                        .estimatedDocumentCount(),
            ]);
            const payload = JSON.stringify({
                generatingCount: generatingCount +
                    BenchmarkService.activeGenerationCount +
                    ActiveGenerationTracker.count,
                recentCount,
            });
            if (payload !== lastPayload) {
                lastPayload = payload;
                res.write(`data: ${payload}\n\n`);
            }
        }
        catch (error) {
            logger.error(`SSE conversations/stream error: ${getErrorMessage(error)}`);
        }
    };
    await sendStats();
    const staleCleanupInterval = setInterval(() => {
        const fiveMinAgo = new Date(Date.now() - minutes(5)).toISOString();
        req.db
            .collection(CONVERSATIONS_COLLECTION)
            .updateMany({ isGenerating: true, updatedAt: { $lt: fiveMinAgo } }, { $set: { isGenerating: false } })
            .then(({ modifiedCount }) => {
            if (modifiedCount > 0)
                logger.info(`Auto-cleared ${modifiedCount} stale isGenerating flag(s)`);
        })
            .catch(() => { });
    }, MILLISECONDS_PER_MINUTE);
    if (ChangeStreamService.available) {
        const onEvent = (event) => {
            if (event.collection === CONVERSATIONS_COLLECTION ||
                event.collection === COLLECTIONS.AGENT_CONVERSATIONS) {
                sendStats();
            }
        };
        ChangeStreamService.subscribe(onEvent);
        let previousNonConversationCount = 0;
        const generationPoll = setInterval(() => {
            const count = BenchmarkService.activeGenerationCount +
                ActiveGenerationTracker.count;
            if (count > 0 || previousNonConversationCount > 0)
                sendStats();
            previousNonConversationCount = count;
        }, 1000);
        const keepAlive = setInterval(() => {
            try {
                res.write(": ping\n\n");
            }
            catch {
                /* ignore */
            }
        }, SSE_KEEPALIVE_INTERVAL_MS);
        req.on("close", () => {
            ChangeStreamService.unsubscribe(onEvent);
            clearInterval(generationPoll);
            clearInterval(keepAlive);
            clearInterval(staleCleanupInterval);
        });
    }
    else {
        const interval = setInterval(sendStats, 2000);
        const keepAlive = setInterval(() => {
            res.write(": ping\n\n");
        }, SSE_KEEPALIVE_INTERVAL_MS);
        req.on("close", () => {
            clearInterval(interval);
            clearInterval(keepAlive);
            clearInterval(staleCleanupInterval);
        });
    }
}));
// ─── GET /conversations/:id — single conversation, full msgs ─
router.get("/:id", asyncHandler(async (req, res, next) => {
    try {
        let conversationDocument = await req.db
            .collection(CONVERSATIONS_COLLECTION)
            .findOne({ id: req.params.id });
        if (conversationDocument) {
            return res.json({ ...conversationDocument, type: "direct" });
        }
        conversationDocument = await req.db
            .collection(COLLECTIONS.AGENT_CONVERSATIONS)
            .findOne({ id: req.params.id });
        if (conversationDocument) {
            const agentRecord = conversationDocument;
            if (!agentRecord.hasSubAgents &&
                Array.isArray(agentRecord.subAgents) &&
                agentRecord.subAgents.length > 0) {
                agentRecord.hasSubAgents = true;
            }
            return res.json({ ...conversationDocument, type: "agent" });
        }
        res.status(404).json({ error: "Conversation not found" });
    }
    catch (error) {
        logger.error(`Admin /conversations/:id error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
export default router;
//# sourceMappingURL=AdminConversationRoutes.js.map