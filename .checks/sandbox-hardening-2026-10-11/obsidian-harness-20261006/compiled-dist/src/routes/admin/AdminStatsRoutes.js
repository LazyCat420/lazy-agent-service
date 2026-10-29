import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import { COLLECTIONS, COST_SUM_EXPR, TOTAL_TOKENS_EXPR, AVG_TOKENS_PER_SEC_EXPR, } from "../../constants.js";
import AgentPersonaRegistry from "../../services/AgentPersonaRegistry.js";
import ToolOrchestratorService from "../../services/ToolOrchestratorService.js";
import logger from "../../utils/logger.js";
import { getErrorMessage } from "../../utils/ErrorHelpers.js";
import { applyDateRangeFilter, } from "../../utils/QueryBuilders.js";
import requireDb from "../../middleware/RequireDbMiddleware.js";
import { hours as hoursToMs } from "@rodrigo-barraza/utilities-library";
const router = express.Router();
const { REQUESTS: REQUESTS_COLLECTION, MODEL_CONVERSATIONS: CONVERSATIONS_COLLECTION, WORKFLOWS: WORKFLOWS_COLLECTION, } = COLLECTIONS;
router.use(requireDb);
async function buildMatchFilter(req) {
    const { from, to, project, agent, provider, model, workspace } = req.query;
    const match = {};
    if (project) {
        match.project = project;
    }
    if (agent) {
        const agentIds = String(agent).split(",").filter(Boolean);
        if (agentIds.length === 1) {
            match.agent = agentIds[0];
        }
        else if (agentIds.length > 1) {
            match.agent = { $in: agentIds };
        }
    }
    if (provider) {
        const providerNames = String(provider).split(",").filter(Boolean);
        if (providerNames.length === 1) {
            match.provider = providerNames[0];
        }
        else if (providerNames.length > 1) {
            match.provider = { $in: providerNames };
        }
    }
    if (model) {
        const modelNames = String(model).split(",").filter(Boolean);
        if (modelNames.length === 1) {
            match.model = modelNames[0];
        }
        else if (modelNames.length > 1) {
            match.model = { $in: modelNames };
        }
    }
    applyDateRangeFilter(match, from, to);
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
        match.$or = [
            { conversationId: { $in: convIds } },
            { agentConversationId: { $in: agentConversationIds } },
            { parentAgentConversationId: { $in: agentConversationIds } },
        ];
    }
    return match;
}
// ─── GET /stats — aggregate stats ─────────────────────
router.get("/", asyncHandler(async (req, res, next) => {
    try {
        const match = await buildMatchFilter(req);
        const { from, to, project, provider, model, workspace } = req.query;
        const pipeline = [
            ...(Object.keys(match).length ? [{ $match: match }] : []),
            {
                $group: {
                    _id: null,
                    totalRequests: { $sum: 1 },
                    totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
                    totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
                    totalCost: COST_SUM_EXPR,
                    avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
                    avgTokensPerSec: AVG_TOKENS_PER_SEC_EXPR,
                    totalDuration: { $sum: { $ifNull: ["$totalTime", 0] } },
                    successCount: {
                        $sum: { $cond: [{ $eq: ["$success", true] }, 1, 0] },
                    },
                    errorCount: {
                        $sum: { $cond: [{ $eq: ["$success", false] }, 1, 0] },
                    },
                },
            },
        ];
        const toolCallPipeline = [
            ...(Object.keys(match).length ? [{ $match: match }] : []),
            { $match: { toolApiNames: { $exists: true, $ne: [] } } },
            { $unwind: "$toolApiNames" },
            { $count: "total" },
        ];
        const convMatch = {};
        if (project)
            convMatch.project = project;
        if (workspace)
            convMatch.workspaceRoot = workspace;
        if (provider) {
            const providerNames = String(provider).split(",").filter(Boolean);
            if (providerNames.length === 1)
                convMatch.providers = providerNames[0];
            else if (providerNames.length > 1)
                convMatch.providers = { $in: providerNames };
        }
        if (model) {
            const modelNames = String(model).split(",").filter(Boolean);
            if (modelNames.length === 1)
                convMatch["messages.model"] = modelNames[0];
            else if (modelNames.length > 1)
                convMatch["messages.model"] = { $in: modelNames };
        }
        applyDateRangeFilter(convMatch, from, to, "createdAt");
        const traceMatch = { ...match, traceId: { $ne: null } };
        const traceCountPipeline = [
            { $match: traceMatch },
            { $group: { _id: "$traceId" } },
            { $count: "total" },
        ];
        const agentCount = AgentPersonaRegistry.list().length;
        const workspaceCount = ToolOrchestratorService.getWorkspaceRoots().length;
        const [resultDocs, toolCallResult, traceResult, conversationCount] = await Promise.all([
            req.db.collection(REQUESTS_COLLECTION).aggregate(pipeline).toArray(),
            req.db
                .collection(REQUESTS_COLLECTION)
                .aggregate(toolCallPipeline)
                .toArray(),
            req.db
                .collection(REQUESTS_COLLECTION)
                .aggregate(traceCountPipeline)
                .toArray(),
            req.db.collection(CONVERSATIONS_COLLECTION).countDocuments(convMatch),
        ]);
        const result = (resultDocs[0] || {});
        const traceCount = traceResult[0]?.total || 0;
        const totalToolCalls = toolCallResult[0]?.total || 0;
        res.json({
            totalRequests: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCost: 0,
            avgLatency: 0,
            avgTokensPerSec: 0,
            totalDuration: 0,
            successCount: 0,
            errorCount: 0,
            ...result,
            traceCount,
            conversationCount,
            totalToolCalls,
            agentCount,
            workspaceCount,
        });
    }
    catch (error) {
        logger.error(`Admin /stats error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
// ─── GET /stats/projects — per-project breakdown ──────
router.get("/projects", asyncHandler(async (req, res, next) => {
    try {
        const match = await buildMatchFilter(req);
        const { from, to, project, provider, model, workspace } = req.query;
        const pipeline = [
            ...(Object.keys(match).length ? [{ $match: match }] : []),
            {
                $group: {
                    _id: "$project",
                    totalRequests: { $sum: 1 },
                    totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
                    totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
                    totalTokens: TOTAL_TOKENS_EXPR,
                    totalCost: COST_SUM_EXPR,
                    avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
                    avgTokensPerSec: AVG_TOKENS_PER_SEC_EXPR,
                    lastRequest: { $max: "$timestamp" },
                    _models: { $addToSet: "$model" },
                    _providers: { $addToSet: "$provider" },
                },
            },
            {
                $addFields: {
                    modelCount: { $size: "$_models" },
                    providerCount: { $size: "$_providers" },
                },
            },
            { $sort: { totalRequests: -1 } },
        ];
        const workflowPipeline = [
            { $match: { conversationIds: { $exists: true, $ne: [] } } },
            {
                $lookup: {
                    from: CONVERSATIONS_COLLECTION,
                    localField: "conversationIds",
                    foreignField: "id",
                    as: "_convs",
                    pipeline: [{ $project: { project: 1 } }],
                },
            },
            { $unwind: "$_convs" },
            {
                $group: {
                    _id: "$_convs.project",
                    workflowIds: { $addToSet: "$_id" },
                },
            },
            { $project: { _id: 1, workflowCount: { $size: "$workflowIds" } } },
        ];
        const convMatch = {};
        if (project)
            convMatch.project = project;
        if (workspace)
            convMatch.workspaceRoot = workspace;
        if (provider) {
            const providerNames = String(provider).split(",").filter(Boolean);
            if (providerNames.length === 1)
                convMatch.providers = providerNames[0];
            else if (providerNames.length > 1)
                convMatch.providers = { $in: providerNames };
        }
        if (model) {
            const modelNames = String(model).split(",").filter(Boolean);
            if (modelNames.length === 1)
                convMatch["messages.model"] = modelNames[0];
            else if (modelNames.length > 1)
                convMatch["messages.model"] = { $in: modelNames };
        }
        applyDateRangeFilter(convMatch, from, to, "updatedAt");
        const convPipeline = [
            ...(Object.keys(convMatch).length ? [{ $match: convMatch }] : []),
            { $group: { _id: "$project", conversationCount: { $sum: 1 } } },
        ];
        const traceMatch = { ...match, traceId: { $ne: null } };
        const tracePipeline = [
            { $match: traceMatch },
            { $group: { _id: { project: "$project", traceId: "$traceId" } } },
            { $group: { _id: "$_id.project", traceCount: { $sum: 1 } } },
        ];
        const [results, workflowCounts, convCounts, traceCounts] = await Promise.all([
            req.db.collection(REQUESTS_COLLECTION).aggregate(pipeline).toArray(),
            req.db
                .collection(WORKFLOWS_COLLECTION)
                .aggregate(workflowPipeline)
                .toArray(),
            req.db
                .collection(CONVERSATIONS_COLLECTION)
                .aggregate(convPipeline)
                .toArray(),
            req.db
                .collection(REQUESTS_COLLECTION)
                .aggregate(tracePipeline)
                .toArray(),
        ]);
        const wfMap = {};
        for (const wc of workflowCounts) {
            wfMap[wc._id || "any"] = wc.workflowCount;
        }
        const convMap = {};
        for (const cc of convCounts) {
            convMap[cc._id || "any"] = cc.conversationCount;
        }
        const traceMap = {};
        for (const toolCall of traceCounts) {
            traceMap[toolCall._id || "any"] = toolCall.traceCount;
        }
        res.json(results.map((r) => ({
            project: r._id || "any",
            totalRequests: r.totalRequests,
            totalInputTokens: r.totalInputTokens,
            totalOutputTokens: r.totalOutputTokens,
            totalTokens: r.totalTokens,
            totalCost: r.totalCost,
            avgLatency: r.avgLatency,
            avgTokensPerSec: r.avgTokensPerSec,
            lastRequest: r.lastRequest,
            modelCount: r.modelCount,
            providerCount: r.providerCount,
            models: (r._models || []).filter(Boolean),
            providers: (r._providers || []).filter(Boolean),
            workflowCount: wfMap[r._id || "any"] || 0,
            conversationCount: convMap[r._id || "any"] || 0,
            traceCount: traceMap[r._id || "any"] || 0,
        })));
    }
    catch (error) {
        logger.error(`Admin /stats/projects error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
// ─── GET /stats/users — per-user breakdown ────────────
router.get("/users", asyncHandler(async (req, res, next) => {
    try {
        const match = await buildMatchFilter(req);
        const pipeline = [
            ...(Object.keys(match).length ? [{ $match: match }] : []),
            {
                $group: {
                    _id: "$username",
                    totalRequests: { $sum: 1 },
                    totalTokens: TOTAL_TOKENS_EXPR,
                    totalCost: COST_SUM_EXPR,
                    avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
                    lastRequest: { $max: "$timestamp" },
                },
            },
            { $sort: { totalRequests: -1 } },
        ];
        const results = await req.db
            .collection(REQUESTS_COLLECTION)
            .aggregate(pipeline)
            .toArray();
        res.json(results.map((r) => ({
            username: r._id || "any",
            totalRequests: r.totalRequests,
            totalTokens: r.totalTokens,
            totalCost: r.totalCost,
            avgLatency: r.avgLatency,
            lastRequest: r.lastRequest,
        })));
    }
    catch (error) {
        logger.error(`Admin /stats/users error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
// ─── GET /stats/models — per-model breakdown ──────────
router.get("/models", asyncHandler(async (req, res, next) => {
    try {
        const match = await buildMatchFilter(req);
        const pipeline = [
            ...(Object.keys(match).length ? [{ $match: match }] : []),
            {
                $group: {
                    _id: { model: "$model", provider: "$provider" },
                    totalRequests: { $sum: 1 },
                    totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
                    totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
                    totalTokens: TOTAL_TOKENS_EXPR,
                    totalCost: COST_SUM_EXPR,
                    avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
                    avgTokensPerSec: AVG_TOKENS_PER_SEC_EXPR,
                    toolsUsed: {
                        $max: { $cond: [{ $eq: ["$toolsUsed", true] }, true, false] },
                    },
                },
            },
            { $sort: { totalRequests: -1 } },
        ];
        // Separate lightweight pipeline: count unique conversations per model
        const convCountPipeline = [
            ...(Object.keys(match).length ? [{ $match: match }] : []),
            { $match: { conversationId: { $ne: null } } },
            {
                $group: {
                    _id: {
                        model: "$model",
                        provider: "$provider",
                        conversationId: "$conversationId",
                    },
                },
            },
            {
                $group: {
                    _id: { model: "$_id.model", provider: "$_id.provider" },
                    conversationCount: { $sum: 1 },
                },
            },
        ];
        // Separate lightweight pipeline: count unique traces per model
        const traceCountPipeline = [
            ...(Object.keys(match).length ? [{ $match: match }] : []),
            { $match: { traceId: { $ne: null } } },
            {
                $group: {
                    _id: {
                        model: "$model",
                        provider: "$provider",
                        traceId: "$traceId",
                    },
                },
            },
            {
                $group: {
                    _id: { model: "$_id.model", provider: "$_id.provider" },
                    traceCount: { $sum: 1 },
                },
            },
        ];
        const [results, convCounts, traceCounts] = await Promise.all([
            req.db.collection(REQUESTS_COLLECTION).aggregate(pipeline).toArray(),
            req.db
                .collection(REQUESTS_COLLECTION)
                .aggregate(convCountPipeline)
                .toArray(),
            req.db
                .collection(REQUESTS_COLLECTION)
                .aggregate(traceCountPipeline)
                .toArray(),
        ]);
        // Build lookup maps keyed by "model|provider"
        const convCountMap = {};
        for (const entry of convCounts) {
            const key = `${entry._id.model}|${entry._id.provider}`;
            convCountMap[key] = entry.conversationCount;
        }
        const traceCountMap = {};
        for (const entry of traceCounts) {
            const key = `${entry._id.model}|${entry._id.provider}`;
            traceCountMap[key] = entry.traceCount;
        }
        res.json(results.map((r) => {
            const modelKey = `${r._id.model}|${r._id.provider}`;
            return {
                model: r._id.model,
                provider: r._id.provider,
                totalRequests: r.totalRequests,
                totalInputTokens: r.totalInputTokens,
                totalOutputTokens: r.totalOutputTokens,
                totalTokens: r.totalTokens,
                totalCost: r.totalCost,
                avgLatency: r.avgLatency,
                avgTokensPerSec: r.avgTokensPerSec,
                toolsUsed: r.toolsUsed || false,
                conversationCount: convCountMap[modelKey] || 0,
                workflowCount: 0,
                traceCount: traceCountMap[modelKey] || 0,
            };
        }));
    }
    catch (error) {
        logger.error(`Admin /stats/models error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
// ─── GET /stats/tools — per-tool lifetime usage breakdown ─
router.get("/tools", asyncHandler(async (req, res, next) => {
    try {
        const match = await buildMatchFilter(req);
        match.toolApiNames = { $exists: true, $ne: [] };
        const { tool } = req.query;
        const pipeline = [
            { $match: match },
            {
                $addFields: {
                    toolCount: { $size: { $ifNull: ["$toolApiNames", []] } },
                },
            },
            { $unwind: "$toolApiNames" },
            ...(tool ? [{ $match: { toolApiNames: tool } }] : []),
            {
                $group: {
                    _id: "$toolApiNames",
                    totalCalls: { $sum: 1 },
                    totalRequests: { $addToSet: "$requestId" },
                    totalCost: {
                        $sum: {
                            $cond: [
                                { $gt: ["$toolCount", 0] },
                                {
                                    $divide: [{ $ifNull: ["$estimatedCost", 0] }, "$toolCount"],
                                },
                                0,
                            ],
                        },
                    },
                    totalInputTokens: {
                        $sum: {
                            $cond: [
                                { $gt: ["$toolCount", 0] },
                                { $divide: [{ $ifNull: ["$inputTokens", 0] }, "$toolCount"] },
                                0,
                            ],
                        },
                    },
                    totalOutputTokens: {
                        $sum: {
                            $cond: [
                                { $gt: ["$toolCount", 0] },
                                {
                                    $divide: [{ $ifNull: ["$outputTokens", 0] }, "$toolCount"],
                                },
                                0,
                            ],
                        },
                    },
                    avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
                    firstUsed: { $min: "$timestamp" },
                    lastUsed: { $max: "$timestamp" },
                    _models: { $push: "$model" },
                    _agents: { $push: "$agent" },
                    _providers: { $addToSet: "$provider" },
                    successCount: {
                        $sum: { $cond: [{ $eq: ["$success", true] }, 1, 0] },
                    },
                    failureCount: {
                        $sum: { $cond: [{ $eq: ["$success", false] }, 1, 0] },
                    },
                },
            },
            {
                $addFields: {
                    totalRequests: { $size: "$totalRequests" },
                },
            },
            { $sort: { totalCalls: -1 } },
        ];
        const results = await req.db
            .collection(REQUESTS_COLLECTION)
            .aggregate(pipeline)
            .toArray();
        res.json(results.map((r) => {
            const modelCounts = {};
            for (const model of r._models || []) {
                if (model)
                    modelCounts[model] = (modelCounts[model] || 0) + 1;
            }
            const topModels = Object.entries(modelCounts)
                .sort((firstItem, b) => b[1] - firstItem[1])
                .slice(0, 5)
                .map(([model, count]) => ({ model, count }));
            const agentCounts = {};
            for (const agent of r._agents || []) {
                if (agent)
                    agentCounts[agent] = (agentCounts[agent] || 0) + 1;
            }
            const topAgents = Object.entries(agentCounts)
                .sort((firstItem, b) => b[1] - firstItem[1])
                .slice(0, 5)
                .map(([agent, count]) => ({ agent, count }));
            return {
                tool: r._id,
                totalCalls: r.totalCalls,
                totalRequests: r.totalRequests,
                totalCost: r.totalCost,
                totalInputTokens: r.totalInputTokens,
                totalOutputTokens: r.totalOutputTokens,
                avgLatency: r.avgLatency,
                firstUsed: r.firstUsed,
                lastUsed: r.lastUsed,
                providers: r._providers?.filter(Boolean) || [],
                topModels,
                topAgents,
                successCount: r.successCount,
                failureCount: r.failureCount,
            };
        }));
    }
    catch (error) {
        logger.error(`Admin /stats/tools error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
// ─── GET /stats/endpoints — per-endpoint breakdown ────
router.get("/endpoints", asyncHandler(async (req, res, next) => {
    try {
        const match = await buildMatchFilter(req);
        const pipeline = [
            ...(Object.keys(match).length ? [{ $match: match }] : []),
            {
                $group: {
                    _id: "$endpoint",
                    totalRequests: { $sum: 1 },
                    totalTokens: TOTAL_TOKENS_EXPR,
                    totalCost: COST_SUM_EXPR,
                    avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
                    successRate: {
                        $avg: { $cond: [{ $eq: ["$success", true] }, 1, 0] },
                    },
                },
            },
            { $sort: { totalRequests: -1 } },
        ];
        const results = await req.db
            .collection(REQUESTS_COLLECTION)
            .aggregate(pipeline)
            .toArray();
        res.json(results.map((r) => ({
            endpoint: r._id || "any",
            totalRequests: r.totalRequests,
            totalTokens: r.totalTokens,
            totalCost: r.totalCost,
            avgLatency: r.avgLatency,
            successRate: r.successRate,
        })));
    }
    catch (error) {
        logger.error(`Admin /stats/endpoints error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
// ─── GET /stats/costs — comprehensive cost breakdown ──
router.get("/costs", asyncHandler(async (req, res, next) => {
    try {
        const match = await buildMatchFilter(req);
        const matchStage = Object.keys(match).length ? [{ $match: match }] : [];
        const groupFields = {
            totalCost: COST_SUM_EXPR,
            totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
            totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
            totalRequests: { $sum: 1 },
            avgTokensPerSec: AVG_TOKENS_PER_SEC_EXPR,
        };
        const [result] = await req.db
            .collection(REQUESTS_COLLECTION)
            .aggregate([
            ...matchStage,
            {
                $facet: {
                    totals: [{ $group: { _id: null, ...groupFields } }],
                    byProject: [
                        { $group: { _id: "$project", ...groupFields } },
                        { $sort: { totalCost: -1 } },
                    ],
                    byProvider: [
                        { $group: { _id: "$provider", ...groupFields } },
                        { $sort: { totalCost: -1 } },
                    ],
                    byModel: [
                        {
                            $group: {
                                _id: { model: "$model", provider: "$provider" },
                                ...groupFields,
                            },
                        },
                        { $sort: { totalCost: -1 } },
                    ],
                    byEndpoint: [
                        { $group: { _id: "$endpoint", ...groupFields } },
                        { $sort: { totalCost: -1 } },
                    ],
                    byProjectProvider: [
                        {
                            $group: {
                                _id: { project: "$project", provider: "$provider" },
                                ...groupFields,
                            },
                        },
                        { $sort: { totalCost: -1 } },
                    ],
                    byProjectEndpoint: [
                        {
                            $group: {
                                _id: { project: "$project", endpoint: "$endpoint" },
                                ...groupFields,
                            },
                        },
                        { $sort: { totalCost: -1 } },
                    ],
                    byProjectModel: [
                        {
                            $group: {
                                _id: {
                                    project: "$project",
                                    model: "$model",
                                    provider: "$provider",
                                },
                                ...groupFields,
                            },
                        },
                        { $sort: { totalCost: -1 } },
                    ],
                },
            },
        ])
            .toArray();
        const { totals, byProject, byProvider, byModel, byEndpoint, byProjectProvider, byProjectEndpoint, byProjectModel, } = result;
        const providersByProject = {};
        for (const row of byProjectProvider) {
            const proj = row._id.project || "any";
            if (!providersByProject[proj])
                providersByProject[proj] = [];
            providersByProject[proj].push({
                provider: row._id.provider || "any",
                totalCost: row.totalCost,
                totalInputTokens: row.totalInputTokens,
                totalOutputTokens: row.totalOutputTokens,
                totalRequests: row.totalRequests,
                avgTokensPerSec: row.avgTokensPerSec,
            });
        }
        const endpointsByProject = {};
        for (const row of byProjectEndpoint) {
            const proj = row._id.project || "any";
            if (!endpointsByProject[proj])
                endpointsByProject[proj] = [];
            endpointsByProject[proj].push({
                endpoint: row._id.endpoint || "any",
                totalCost: row.totalCost,
                totalInputTokens: row.totalInputTokens,
                totalOutputTokens: row.totalOutputTokens,
                totalRequests: row.totalRequests,
                avgTokensPerSec: row.avgTokensPerSec,
            });
        }
        const modelsByProject = {};
        for (const row of byProjectModel) {
            const proj = row._id.project || "any";
            if (!modelsByProject[proj])
                modelsByProject[proj] = [];
            modelsByProject[proj].push({
                model: row._id.model || "any",
                provider: row._id.provider || "any",
                totalCost: row.totalCost,
                totalInputTokens: row.totalInputTokens,
                totalOutputTokens: row.totalOutputTokens,
                totalRequests: row.totalRequests,
                avgTokensPerSec: row.avgTokensPerSec,
            });
        }
        const tool = totals[0] || {
            totalCost: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalRequests: 0,
        };
        res.json({
            totals: {
                totalCost: tool.totalCost,
                totalInputTokens: tool.totalInputTokens,
                totalOutputTokens: tool.totalOutputTokens,
                totalRequests: tool.totalRequests,
                avgTokensPerSec: tool.avgTokensPerSec,
            },
            byProject: byProject.map((r) => ({
                project: r._id || "any",
                totalCost: r.totalCost,
                totalInputTokens: r.totalInputTokens,
                totalOutputTokens: r.totalOutputTokens,
                totalRequests: r.totalRequests,
                avgTokensPerSec: r.avgTokensPerSec,
                byProvider: providersByProject[r._id || "any"] || [],
                byEndpoint: endpointsByProject[r._id || "any"] || [],
                byModel: modelsByProject[r._id || "any"] || [],
            })),
            byProvider: byProvider.map((r) => ({
                provider: r._id || "any",
                totalCost: r.totalCost,
                totalInputTokens: r.totalInputTokens,
                totalOutputTokens: r.totalOutputTokens,
                totalRequests: r.totalRequests,
            })),
            byModel: byModel.map((r) => ({
                model: r._id?.model || "any",
                provider: r._id?.provider || "any",
                totalCost: r.totalCost,
                totalInputTokens: r.totalInputTokens,
                totalOutputTokens: r.totalOutputTokens,
                totalRequests: r.totalRequests,
                avgTokensPerSec: r.avgTokensPerSec,
            })),
            byEndpoint: byEndpoint.map((r) => ({
                endpoint: r._id || "any",
                totalCost: r.totalCost,
                totalInputTokens: r.totalInputTokens,
                totalOutputTokens: r.totalOutputTokens,
                totalRequests: r.totalRequests,
                avgTokensPerSec: r.avgTokensPerSec,
            })),
        });
    }
    catch (error) {
        logger.error(`Admin /stats/costs error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
// ─── GET /stats/timeline — requests grouped by adaptive granularity ─
// Supports an optional `granularity` query param for user-selected resolution.
// Returns `validGranularities` and `defaultGranularity` so the frontend can
// render a resolution picker constrained to sane bounds per time span.
router.get("/timeline", asyncHandler(async (req, res, next) => {
    try {
        const { hours = 24, from, to, project, agent, granularity: requestedGranularity, } = req.query;
        let sinceDate;
        let untilDate;
        if (typeof from === "string") {
            sinceDate = new Date(from);
        }
        else {
            sinceDate = new Date(Date.now() - hoursToMs(parseInt(hours, 10)));
        }
        if (typeof to === "string") {
            untilDate = new Date(to);
        }
        const spanMs = (untilDate ? untilDate.getTime() : Date.now()) - sinceDate.getTime();
        // ── Granularity tier definitions (ordered finest → coarsest) ──
        const TIER_KEYS = [
            "1s",
            "5s",
            "15s",
            "30s",
            "1min",
            "5min",
            "15min",
            "1hr",
            "4hr",
            "1day",
            "1week",
        ];
        const TIER_INDEX = {};
        TIER_KEYS.forEach((key, index) => {
            TIER_INDEX[key] = index;
        });
        const MINUTES_MS = 60_000;
        const HOURS_MS = 3_600_000;
        const DAYS_MS = 86_400_000;
        const SPAN_RULES = [
            {
                maxSpanMs: 2 * MINUTES_MS,
                defaultGranularity: "1s",
                minGranularity: "1s",
                maxGranularity: "15s",
            },
            {
                maxSpanMs: 10 * MINUTES_MS,
                defaultGranularity: "5s",
                minGranularity: "1s",
                maxGranularity: "1min",
            },
            {
                maxSpanMs: 30 * MINUTES_MS,
                defaultGranularity: "15s",
                minGranularity: "5s",
                maxGranularity: "5min",
            },
            {
                maxSpanMs: 1 * HOURS_MS,
                defaultGranularity: "30s",
                minGranularity: "15s",
                maxGranularity: "5min",
            },
            {
                maxSpanMs: 6 * HOURS_MS,
                defaultGranularity: "1min",
                minGranularity: "15s",
                maxGranularity: "15min",
            },
            {
                maxSpanMs: 1 * DAYS_MS,
                defaultGranularity: "5min",
                minGranularity: "1min",
                maxGranularity: "1hr",
            },
            {
                maxSpanMs: 3 * DAYS_MS,
                defaultGranularity: "15min",
                minGranularity: "5min",
                maxGranularity: "1day",
            },
            {
                maxSpanMs: 7 * DAYS_MS,
                defaultGranularity: "1day",
                minGranularity: "1hr",
                maxGranularity: "1day",
            },
            {
                maxSpanMs: 14 * DAYS_MS,
                defaultGranularity: "1day",
                minGranularity: "4hr",
                maxGranularity: "1day",
            },
            {
                maxSpanMs: 30 * DAYS_MS,
                defaultGranularity: "1day",
                minGranularity: "4hr",
                maxGranularity: "1week",
            },
            {
                maxSpanMs: 90 * DAYS_MS,
                defaultGranularity: "1day",
                minGranularity: "1day",
                maxGranularity: "1week",
            },
            {
                maxSpanMs: Infinity,
                defaultGranularity: "1week",
                minGranularity: "1day",
                maxGranularity: "1week",
            },
        ];
        const matchingRule = SPAN_RULES.find((rule) => spanMs <= rule.maxSpanMs) ||
            SPAN_RULES[SPAN_RULES.length - 1];
        const minimumIndex = TIER_INDEX[matchingRule.minGranularity] ?? 0;
        const maximumIndex = TIER_INDEX[matchingRule.maxGranularity] ?? TIER_KEYS.length - 1;
        const validGranularities = TIER_KEYS.slice(minimumIndex, maximumIndex + 1);
        const defaultGranularity = matchingRule.defaultGranularity;
        let granularity;
        if (typeof requestedGranularity === "string" &&
            validGranularities.includes(requestedGranularity)) {
            granularity = requestedGranularity;
        }
        else if (typeof requestedGranularity === "string" &&
            !validGranularities.includes(requestedGranularity)) {
            res.status(400).json({
                error: `Invalid granularity "${requestedGranularity}" for this time span. Valid options: ${validGranularities.join(", ")}`,
            });
            return;
        }
        else {
            granularity = defaultGranularity;
        }
        // ── MongoDB $group _id expressions per granularity ──
        const floorSecondsExpr = (interval) => ({
            $concat: [
                {
                    $dateToString: {
                        format: "%Y-%m-%dT%H:%M:",
                        date: { $toDate: "$timestamp" },
                        timezone: "UTC",
                    },
                },
                {
                    $cond: [
                        {
                            $lt: [
                                {
                                    $multiply: [
                                        {
                                            $floor: {
                                                $divide: [
                                                    { $second: { $toDate: "$timestamp" } },
                                                    interval,
                                                ],
                                            },
                                        },
                                        interval,
                                    ],
                                },
                                10,
                            ],
                        },
                        {
                            $concat: [
                                "0",
                                {
                                    $toString: {
                                        $multiply: [
                                            {
                                                $floor: {
                                                    $divide: [
                                                        { $second: { $toDate: "$timestamp" } },
                                                        interval,
                                                    ],
                                                },
                                            },
                                            interval,
                                        ],
                                    },
                                },
                            ],
                        },
                        {
                            $toString: {
                                $multiply: [
                                    {
                                        $floor: {
                                            $divide: [
                                                { $second: { $toDate: "$timestamp" } },
                                                interval,
                                            ],
                                        },
                                    },
                                    interval,
                                ],
                            },
                        },
                    ],
                },
            ],
        });
        const floorMinutesExpr = (interval) => ({
            $concat: [
                {
                    $dateToString: {
                        format: "%Y-%m-%dT%H:",
                        date: { $toDate: "$timestamp" },
                        timezone: "UTC",
                    },
                },
                {
                    $cond: [
                        {
                            $lt: [
                                {
                                    $multiply: [
                                        {
                                            $floor: {
                                                $divide: [
                                                    { $minute: { $toDate: "$timestamp" } },
                                                    interval,
                                                ],
                                            },
                                        },
                                        interval,
                                    ],
                                },
                                10,
                            ],
                        },
                        {
                            $concat: [
                                "0",
                                {
                                    $toString: {
                                        $multiply: [
                                            {
                                                $floor: {
                                                    $divide: [
                                                        { $minute: { $toDate: "$timestamp" } },
                                                        interval,
                                                    ],
                                                },
                                            },
                                            interval,
                                        ],
                                    },
                                },
                            ],
                        },
                        {
                            $toString: {
                                $multiply: [
                                    {
                                        $floor: {
                                            $divide: [
                                                { $minute: { $toDate: "$timestamp" } },
                                                interval,
                                            ],
                                        },
                                    },
                                    interval,
                                ],
                            },
                        },
                    ],
                },
            ],
        });
        const floorHoursExpr = (interval) => ({
            $concat: [
                {
                    $dateToString: {
                        format: "%Y-%m-%dT",
                        date: { $toDate: "$timestamp" },
                        timezone: "UTC",
                    },
                },
                {
                    $cond: [
                        {
                            $lt: [
                                {
                                    $multiply: [
                                        {
                                            $floor: {
                                                $divide: [
                                                    { $hour: { $toDate: "$timestamp" } },
                                                    interval,
                                                ],
                                            },
                                        },
                                        interval,
                                    ],
                                },
                                10,
                            ],
                        },
                        {
                            $concat: [
                                "0",
                                {
                                    $toString: {
                                        $multiply: [
                                            {
                                                $floor: {
                                                    $divide: [
                                                        { $hour: { $toDate: "$timestamp" } },
                                                        interval,
                                                    ],
                                                },
                                            },
                                            interval,
                                        ],
                                    },
                                },
                            ],
                        },
                        {
                            $toString: {
                                $multiply: [
                                    {
                                        $floor: {
                                            $divide: [
                                                { $hour: { $toDate: "$timestamp" } },
                                                interval,
                                            ],
                                        },
                                    },
                                    interval,
                                ],
                            },
                        },
                    ],
                },
            ],
        });
        // ISO week start (Monday) expression
        const weekStartExpr = {
            $dateToString: {
                format: "%Y-%m-%d",
                date: {
                    $dateSubtract: {
                        startDate: { $toDate: "$timestamp" },
                        unit: "day",
                        amount: {
                            $mod: [
                                {
                                    $add: [
                                        {
                                            $subtract: [
                                                { $dayOfWeek: { $toDate: "$timestamp" } },
                                                2,
                                            ],
                                        },
                                        7,
                                    ],
                                },
                                7,
                            ],
                        },
                    },
                },
                timezone: "UTC",
            },
        };
        let groupId;
        switch (granularity) {
            case "1s":
                groupId = {
                    $dateToString: {
                        format: "%Y-%m-%dT%H:%M:%S",
                        date: { $toDate: "$timestamp" },
                        timezone: "UTC",
                    },
                };
                break;
            case "5s":
                groupId = floorSecondsExpr(5);
                break;
            case "15s":
                groupId = floorSecondsExpr(15);
                break;
            case "30s":
                groupId = floorSecondsExpr(30);
                break;
            case "1min":
                groupId = {
                    $dateToString: {
                        format: "%Y-%m-%dT%H:%M",
                        date: { $toDate: "$timestamp" },
                        timezone: "UTC",
                    },
                };
                break;
            case "5min":
                groupId = floorMinutesExpr(5);
                break;
            case "15min":
                groupId = floorMinutesExpr(15);
                break;
            case "1hr":
                groupId = { $substr: ["$timestamp", 0, 13] };
                break;
            case "4hr":
                groupId = floorHoursExpr(4);
                break;
            case "1day":
                groupId = { $substr: ["$timestamp", 0, 10] };
                break;
            case "1week":
                groupId = weekStartExpr;
                break;
            default:
                groupId = { $substr: ["$timestamp", 0, 10] };
        }
        const timeMatch = {
            $gte: sinceDate.toISOString(),
        };
        if (untilDate)
            timeMatch.$lte = untilDate.toISOString();
        const matchFilter = await buildMatchFilter(req);
        matchFilter.timestamp = timeMatch;
        const pipeline = [
            { $match: matchFilter },
            {
                $group: {
                    _id: groupId,
                    requests: { $sum: 1 },
                    tokens: {
                        $sum: {
                            $add: [
                                { $ifNull: ["$inputTokens", 0] },
                                { $ifNull: ["$outputTokens", 0] },
                            ],
                        },
                    },
                    cost: COST_SUM_EXPR,
                    avgLatency: { $avg: { $ifNull: ["$totalTime", null] } },
                    successes: {
                        $sum: { $cond: [{ $eq: ["$success", true] }, 1, 0] },
                    },
                },
            },
            { $sort: { _id: 1 } },
        ];
        const results = await req.db
            .collection(REQUESTS_COLLECTION)
            .aggregate(pipeline)
            .toArray();
        res.json({
            granularity,
            defaultGranularity,
            validGranularities,
            data: results.map((r) => ({
                hour: r._id,
                requests: r.requests,
                tokens: r.tokens,
                cost: r.cost,
                avgLatency: r.avgLatency ? Math.round(r.avgLatency) : 0,
                successRate: r.requests > 0
                    ? Math.round((r.successes / r.requests) * 100)
                    : 100,
            })),
        });
    }
    catch (error) {
        logger.error(`Admin /stats/timeline error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
// ─── GET /stats/agents — per-agent breakdown ──────────
router.get("/agents", asyncHandler(async (req, res, next) => {
    try {
        const match = await buildMatchFilter(req);
        match.agent = { $exists: true, $ne: null };
        const pipeline = [
            { $match: match },
            {
                $group: {
                    _id: "$agent",
                    totalRequests: { $sum: 1 },
                    totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
                    totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
                    totalTokens: TOTAL_TOKENS_EXPR,
                    totalCost: COST_SUM_EXPR,
                    avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
                    avgTokensPerSec: AVG_TOKENS_PER_SEC_EXPR,
                    _models: { $addToSet: "$model" },
                    _providers: { $addToSet: "$provider" },
                    _convIds: { $addToSet: "$conversationId" },
                    _traceIds: { $addToSet: "$traceId" },
                    lastRequest: { $max: "$timestamp" },
                    successCount: {
                        $sum: { $cond: [{ $eq: ["$success", true] }, 1, 0] },
                    },
                    errorCount: {
                        $sum: { $cond: [{ $eq: ["$success", false] }, 1, 0] },
                    },
                },
            },
            { $sort: { totalRequests: -1 } },
        ];
        const results = await req.db
            .collection(REQUESTS_COLLECTION)
            .aggregate(pipeline)
            .toArray();
        res.json(results.map((r) => {
            const agentId = r._id || "";
            const persona = AgentPersonaRegistry.get(agentId);
            const models = (r._models || []).filter(Boolean);
            const providers = (r._providers || []).filter(Boolean);
            const conversationIds = (r._convIds || []).filter(Boolean);
            const traceIds = (r._traceIds || []).filter(Boolean);
            return {
                agent: agentId,
                name: persona?.name || agentId,
                type: persona?.type || "",
                custom: persona?.custom || false,
                totalRequests: r.totalRequests,
                totalInputTokens: r.totalInputTokens,
                totalOutputTokens: r.totalOutputTokens,
                totalTokens: r.totalTokens,
                totalCost: r.totalCost,
                avgLatency: r.avgLatency,
                avgTokensPerSec: r.avgTokensPerSec,
                modelCount: models.length,
                models,
                providerCount: providers.length,
                providers,
                conversationCount: conversationIds.length,
                sessionCount: traceIds.length,
                lastRequest: r.lastRequest,
                successCount: r.successCount,
                errorCount: r.errorCount,
            };
        }));
    }
    catch (error) {
        logger.error(`Admin /stats/agents error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
export default router;
//# sourceMappingURL=AdminStatsRoutes.js.map