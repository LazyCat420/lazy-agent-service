import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import {
  COLLECTIONS,
  COST_SUM_EXPR,
  TOTAL_TOKENS_EXPR,
  AVG_TOKENS_PER_SEC_EXPR,
} from "../../constants.ts";
import AgentPersonaRegistry from "../../services/AgentPersonaRegistry.ts";
import ToolOrchestratorService from "../../services/ToolOrchestratorService.ts";
import logger from "../../utils/logger.ts";
import { getErrorMessage } from "../../utils/ErrorHelpers.ts";
import {
  applyDateRangeFilter,
  buildAdminMatch,
  parseCsvFilter,
} from "../../utils/QueryBuilders.ts";
import requireDb from "../../middleware/RequireDbMiddleware.ts";
import { hours as hoursToMs } from "@rodrigo-barraza/utilities-library";

const router = express.Router();
const {
  REQUESTS: REQUESTS_COLLECTION,
  MODEL_CONVERSATIONS: CONVERSATIONS_COLLECTION,
  WORKFLOWS: WORKFLOWS_COLLECTION,
} = COLLECTIONS;

router.use(requireDb);

async function buildMatchFilter(
  req: Request,
): Promise<Record<string, unknown>> {
  const { from, to, workspace } = req.query;
  const match = buildAdminMatch(req.query as Record<string, unknown>);

  applyDateRangeFilter(match, from as string, to as string);

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
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const match = await buildMatchFilter(req);
      const { from, to, workspace } = req.query;

      const pipeline: Record<string, unknown>[] = [
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

      const toolCallPipeline: Record<string, unknown>[] = [
        ...(Object.keys(match).length ? [{ $match: match }] : []),
        { $match: { toolApiNames: { $exists: true, $ne: [] } } },
        { $unwind: "$toolApiNames" },
        { $count: "total" },
      ];

      const convMatch = buildAdminMatch(req.query as Record<string, unknown>);
      if (workspace) convMatch.workspaceRoot = workspace;
      applyDateRangeFilter(convMatch, from as string, to as string, "createdAt");

      const traceMatch = { ...match, traceId: { $ne: null } };

      const traceCountPipeline: Record<string, unknown>[] = [
        { $match: traceMatch },
        { $group: { _id: "$traceId" } },
        { $count: "total" },
      ];

      const agentCount = AgentPersonaRegistry.list().length;
      const workspaceCount = ToolOrchestratorService.getWorkspaceRoots().length;

      const [resultDocs, toolCallResult, traceResult, conversationCount] =
        await Promise.all([
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
      const result = (resultDocs[0] || {}) as Record<string, unknown>;
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
    } catch (error: unknown) {
      logger.error(`Admin /stats error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /stats/projects — per-project breakdown ──────
router.get(
  "/projects",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const match = await buildMatchFilter(req);
      const { from, to, project, provider, model, workspace } = req.query;

      const pipeline: Record<string, unknown>[] = [
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

      const workflowPipeline: Record<string, unknown>[] = [
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

      const convMatch: Record<string, unknown> = {};
      if (project) convMatch.project = project;
      if (workspace) convMatch.workspaceRoot = workspace;
      const providerFilter = parseCsvFilter(provider);
      if (providerFilter !== undefined) convMatch.providers = providerFilter;

      const modelFilter = parseCsvFilter(model);
      if (modelFilter !== undefined) convMatch["messages.model"] = modelFilter;
      applyDateRangeFilter(
        convMatch,
        from as string,
        to as string,
        "updatedAt",
      );

      const convPipeline: Record<string, unknown>[] = [
        ...(Object.keys(convMatch).length ? [{ $match: convMatch }] : []),
        { $group: { _id: "$project", conversationCount: { $sum: 1 } } },
      ];

      const traceMatch = { ...match, traceId: { $ne: null } };
      const tracePipeline: Record<string, unknown>[] = [
        { $match: traceMatch },
        { $group: { _id: { project: "$project", traceId: "$traceId" } } },
        { $group: { _id: "$_id.project", traceCount: { $sum: 1 } } },
      ];

      const [results, workflowCounts, convCounts, traceCounts] =
        await Promise.all([
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

      const wfMap: Record<string, number> = {};
      for (const wc of workflowCounts) {
        wfMap[wc._id || "any"] = wc.workflowCount;
      }

      const convMap: Record<string, number> = {};
      for (const cc of convCounts) {
        convMap[cc._id || "any"] = cc.conversationCount;
      }

      const traceMap: Record<string, number> = {};
      for (const toolCall of traceCounts) {
        traceMap[toolCall._id || "any"] = toolCall.traceCount;
      }

      res.json(
        results.map((r: Record<string, unknown>) => ({
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
          models: ((r._models || []) as string[]).filter(Boolean),
          providers: ((r._providers || []) as string[]).filter(Boolean),
          workflowCount: wfMap[(r._id as string) || "any"] || 0,
          conversationCount: convMap[(r._id as string) || "any"] || 0,
          traceCount: traceMap[(r._id as string) || "any"] || 0,
        })),
      );
    } catch (error: unknown) {
      logger.error(`Admin /stats/projects error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /stats/users — per-user breakdown ────────────
router.get(
  "/users",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const match = await buildMatchFilter(req);
      const pipeline: Record<string, unknown>[] = [
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

      res.json(
        results.map((r: Record<string, unknown>) => ({
          username: r._id || "any",
          totalRequests: r.totalRequests,
          totalTokens: r.totalTokens,
          totalCost: r.totalCost,
          avgLatency: r.avgLatency,
          lastRequest: r.lastRequest,
        })),
      );
    } catch (error: unknown) {
      logger.error(`Admin /stats/users error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /stats/models — per-model breakdown ──────────
router.get(
  "/models",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const match = await buildMatchFilter(req);

      const pipeline: Record<string, unknown>[] = [
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
      const convCountPipeline: Record<string, unknown>[] = [
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
      const traceCountPipeline: Record<string, unknown>[] = [
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
      const convCountMap: Record<string, number> = {};
      for (const entry of convCounts) {
        const key = `${(entry._id as { model: string }).model}|${(entry._id as { provider: string }).provider}`;
        convCountMap[key] = (
          entry as { conversationCount: number }
        ).conversationCount;
      }

      const traceCountMap: Record<string, number> = {};
      for (const entry of traceCounts) {
        const key = `${(entry._id as { model: string }).model}|${(entry._id as { provider: string }).provider}`;
        traceCountMap[key] = (entry as { traceCount: number }).traceCount;
      }

      res.json(
        results.map((r: Record<string, unknown>) => {
          const modelKey = `${(r._id as { model: string }).model}|${(r._id as { provider: string }).provider}`;
          return {
            model: (r._id as { model: string }).model,
            provider: (r._id as { provider: string }).provider,
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
        }),
      );
    } catch (error: unknown) {
      logger.error(`Admin /stats/models error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /stats/tools — per-tool lifetime usage breakdown ─
router.get(
  "/tools",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const match = await buildMatchFilter(req);
      match.toolApiNames = { $exists: true, $ne: [] };
      const { tool } = req.query;

      const pipeline: Record<string, unknown>[] = [
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

      res.json(
        results.map((r: Record<string, unknown>) => {
          const modelCounts: Record<string, number> = {};
          for (const model of (r._models as string[]) || []) {
            if (model) modelCounts[model] = (modelCounts[model] || 0) + 1;
          }
          const topModels = Object.entries(modelCounts)
            .sort((firstItem, b) => b[1] - firstItem[1])
            .slice(0, 5)
            .map(([model, count]) => ({ model, count }));

          const agentCounts: Record<string, number> = {};
          for (const agent of (r._agents as string[]) || []) {
            if (agent) agentCounts[agent] = (agentCounts[agent] || 0) + 1;
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
            providers: (r._providers as string[])?.filter(Boolean) || [],
            topModels,
            topAgents,
            successCount: r.successCount,
            failureCount: r.failureCount,
          };
        }),
      );
    } catch (error: unknown) {
      logger.error(`Admin /stats/tools error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /stats/endpoints — per-endpoint breakdown ────
router.get(
  "/endpoints",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const match = await buildMatchFilter(req);

      const pipeline: Record<string, unknown>[] = [
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

      res.json(
        results.map((r: Record<string, unknown>) => ({
          endpoint: r._id || "any",
          totalRequests: r.totalRequests,
          totalTokens: r.totalTokens,
          totalCost: r.totalCost,
          avgLatency: r.avgLatency,
          successRate: r.successRate,
        })),
      );
    } catch (error: unknown) {
      logger.error(`Admin /stats/endpoints error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /stats/costs — comprehensive cost breakdown ──
router.get(
  "/costs",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
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

      const {
        totals,
        byProject,
        byProvider,
        byModel,
        byEndpoint,
        byProjectProvider,
        byProjectEndpoint,
        byProjectModel,
      } = result;

      const providersByProject: Record<string, Record<string, unknown>[]> = {};
      for (const row of byProjectProvider) {
        const proj = row._id.project || "any";
        if (!providersByProject[proj]) providersByProject[proj] = [];
        providersByProject[proj].push({
          provider: row._id.provider || "any",
          totalCost: row.totalCost,
          totalInputTokens: row.totalInputTokens,
          totalOutputTokens: row.totalOutputTokens,
          totalRequests: row.totalRequests,
          avgTokensPerSec: row.avgTokensPerSec,
        });
      }

      const endpointsByProject: Record<string, Record<string, unknown>[]> = {};
      for (const row of byProjectEndpoint) {
        const proj = row._id.project || "any";
        if (!endpointsByProject[proj]) endpointsByProject[proj] = [];
        endpointsByProject[proj].push({
          endpoint: row._id.endpoint || "any",
          totalCost: row.totalCost,
          totalInputTokens: row.totalInputTokens,
          totalOutputTokens: row.totalOutputTokens,
          totalRequests: row.totalRequests,
          avgTokensPerSec: row.avgTokensPerSec,
        });
      }

      const modelsByProject: Record<string, Record<string, unknown>[]> = {};
      for (const row of byProjectModel) {
        const proj = row._id.project || "any";
        if (!modelsByProject[proj]) modelsByProject[proj] = [];
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
        byProject: byProject.map((r: Record<string, unknown>) => ({
          project: r._id || "any",
          totalCost: r.totalCost,
          totalInputTokens: r.totalInputTokens,
          totalOutputTokens: r.totalOutputTokens,
          totalRequests: r.totalRequests,
          avgTokensPerSec: r.avgTokensPerSec,
          byProvider: providersByProject[(r._id as string) || "any"] || [],
          byEndpoint: endpointsByProject[(r._id as string) || "any"] || [],
          byModel: modelsByProject[(r._id as string) || "any"] || [],
        })),
        byProvider: byProvider.map((r: Record<string, unknown>) => ({
          provider: r._id || "any",
          totalCost: r.totalCost,
          totalInputTokens: r.totalInputTokens,
          totalOutputTokens: r.totalOutputTokens,
          totalRequests: r.totalRequests,
        })),
        byModel: byModel.map((r: Record<string, unknown>) => ({
          model: (r._id as Record<string, string>)?.model || "any",
          provider: (r._id as Record<string, string>)?.provider || "any",
          totalCost: r.totalCost,
          totalInputTokens: r.totalInputTokens,
          totalOutputTokens: r.totalOutputTokens,
          totalRequests: r.totalRequests,
          avgTokensPerSec: r.avgTokensPerSec,
        })),
        byEndpoint: byEndpoint.map((r: Record<string, unknown>) => ({
          endpoint: r._id || "any",
          totalCost: r.totalCost,
          totalInputTokens: r.totalInputTokens,
          totalOutputTokens: r.totalOutputTokens,
          totalRequests: r.totalRequests,
          avgTokensPerSec: r.avgTokensPerSec,
        })),
      });
    } catch (error: unknown) {
      logger.error(`Admin /stats/costs error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── Timeline granularity tiers (ordered finest → coarsest) ────────────────
const TIMELINE_TIER_KEYS = [
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

const TIMELINE_MINUTES_MS = 60_000;
const TIMELINE_HOURS_MS = 3_600_000;
const TIMELINE_DAYS_MS = 86_400_000;

const TIMELINE_SPAN_RULES = [
  {
    maxSpanMs: 2 * TIMELINE_MINUTES_MS,
    defaultGranularity: "1s",
    minGranularity: "1s",
    maxGranularity: "15s",
  },
  {
    maxSpanMs: 10 * TIMELINE_MINUTES_MS,
    defaultGranularity: "5s",
    minGranularity: "1s",
    maxGranularity: "1min",
  },
  {
    maxSpanMs: 30 * TIMELINE_MINUTES_MS,
    defaultGranularity: "15s",
    minGranularity: "5s",
    maxGranularity: "5min",
  },
  {
    maxSpanMs: 1 * TIMELINE_HOURS_MS,
    defaultGranularity: "30s",
    minGranularity: "15s",
    maxGranularity: "5min",
  },
  {
    maxSpanMs: 6 * TIMELINE_HOURS_MS,
    defaultGranularity: "1min",
    minGranularity: "15s",
    maxGranularity: "15min",
  },
  {
    maxSpanMs: 1 * TIMELINE_DAYS_MS,
    defaultGranularity: "5min",
    minGranularity: "1min",
    maxGranularity: "1hr",
  },
  {
    maxSpanMs: 3 * TIMELINE_DAYS_MS,
    defaultGranularity: "15min",
    minGranularity: "5min",
    maxGranularity: "1day",
  },
  {
    maxSpanMs: 7 * TIMELINE_DAYS_MS,
    defaultGranularity: "1day",
    minGranularity: "1hr",
    maxGranularity: "1day",
  },
  {
    maxSpanMs: 14 * TIMELINE_DAYS_MS,
    defaultGranularity: "1day",
    minGranularity: "4hr",
    maxGranularity: "1day",
  },
  {
    maxSpanMs: 30 * TIMELINE_DAYS_MS,
    defaultGranularity: "1day",
    minGranularity: "4hr",
    maxGranularity: "1week",
  },
  {
    maxSpanMs: 90 * TIMELINE_DAYS_MS,
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

interface TimelineWindow {
  sinceDate: Date;
  untilDate: Date | undefined;
  spanMs: number;
}

function resolveTimelineWindow(query: Request["query"]): TimelineWindow {
  const { hours = 24, from, to } = query;

  // One clock reading for both ends: reading Date.now() twice made a
  // `hours=24` span a few milliseconds longer than a day, which pushed it
  // into the 3-day granularity tier (15min instead of 5min).
  const nowMs = Date.now();
  let sinceDate: Date;
  let untilDate: Date | undefined;
  if (typeof from === "string") {
    sinceDate = new Date(from);
  } else {
    sinceDate = new Date(nowMs - hoursToMs(parseInt(hours as string, 10)));
  }
  if (typeof to === "string") {
    untilDate = new Date(to);
  }

  const spanMs = (untilDate ? untilDate.getTime() : nowMs) - sinceDate.getTime();
  return { sinceDate, untilDate, spanMs };
}

interface TimelineTiers {
  validGranularities: string[];
  defaultGranularity: string;
}

function resolveTimelineTiers(spanMs: number): TimelineTiers {
  const tierIndex: Record<string, number> = {};
  TIMELINE_TIER_KEYS.forEach((key, index) => {
    tierIndex[key] = index;
  });

  const matchingRule =
    TIMELINE_SPAN_RULES.find((rule) => spanMs <= rule.maxSpanMs) ||
    TIMELINE_SPAN_RULES[TIMELINE_SPAN_RULES.length - 1];
  const minimumIndex = tierIndex[matchingRule.minGranularity] ?? 0;
  const maximumIndex =
    tierIndex[matchingRule.maxGranularity] ?? TIMELINE_TIER_KEYS.length - 1;
  return {
    validGranularities: TIMELINE_TIER_KEYS.slice(minimumIndex, maximumIndex + 1),
    defaultGranularity: matchingRule.defaultGranularity,
  };
}

type TimelineGranularityResolution =
  | { granularity: string }
  | { error: string };

function resolveTimelineGranularity(
  requestedGranularity: unknown,
  validGranularities: string[],
  defaultGranularity: string,
): TimelineGranularityResolution {
  if (
    typeof requestedGranularity === "string" &&
    validGranularities.includes(requestedGranularity)
  ) {
    return { granularity: requestedGranularity };
  }
  if (
    typeof requestedGranularity === "string" &&
    !validGranularities.includes(requestedGranularity)
  ) {
    return {
      error: `Invalid granularity "${requestedGranularity}" for this time span. Valid options: ${validGranularities.join(", ")}`,
    };
  }
  return { granularity: defaultGranularity };
}

interface TimelineFloorExprs {
  floorSecondsExpr: (interval: number) => Record<string, unknown>;
  floorMinutesExpr: (interval: number) => Record<string, unknown>;
  floorHoursExpr: (interval: number) => Record<string, unknown>;
  weekStartExpr: Record<string, unknown>;
}

/** MongoDB $group _id expression per granularity. */
function buildTimelineGroupId(
  granularity: string,
  exprs: TimelineFloorExprs,
): Record<string, unknown> {
  let groupId: Record<string, unknown>;
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
      groupId = exprs.floorSecondsExpr(5);
      break;
    case "15s":
      groupId = exprs.floorSecondsExpr(15);
      break;
    case "30s":
      groupId = exprs.floorSecondsExpr(30);
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
      groupId = exprs.floorMinutesExpr(5);
      break;
    case "15min":
      groupId = exprs.floorMinutesExpr(15);
      break;
    case "1hr":
      groupId = { $substr: ["$timestamp", 0, 13] };
      break;
    case "4hr":
      groupId = exprs.floorHoursExpr(4);
      break;
    case "1day":
      groupId = { $substr: ["$timestamp", 0, 10] };
      break;
    case "1week":
      groupId = exprs.weekStartExpr;
      break;
    default:
      groupId = { $substr: ["$timestamp", 0, 10] };
  }
  return groupId;
}

function mapTimelineRow(r: Record<string, unknown>) {
  return {
    hour: r._id,
    requests: r.requests,
    tokens: r.tokens,
    cost: r.cost,
    avgLatency: r.avgLatency ? Math.round(r.avgLatency as number) : 0,
    successRate:
      (r.requests as number) > 0
        ? Math.round(
            ((r.successes as number) / (r.requests as number)) * 100,
          )
        : 100,
  };
}

// ─── GET /stats/timeline — requests grouped by adaptive granularity ─
// Supports an optional `granularity` query param for user-selected resolution.
// Returns `validGranularities` and `defaultGranularity` so the frontend can
// render a resolution picker constrained to sane bounds per time span.
router.get(
  "/timeline",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { granularity: requestedGranularity } = req.query;
      const { sinceDate, untilDate, spanMs } = resolveTimelineWindow(req.query);

      const { validGranularities, defaultGranularity } =
        resolveTimelineTiers(spanMs);
      const resolvedGranularity = resolveTimelineGranularity(
        requestedGranularity,
        validGranularities,
        defaultGranularity,
      );
      if ("error" in resolvedGranularity) {
        res.status(400).json({ error: resolvedGranularity.error });
        return;
      }
      const granularity = resolvedGranularity.granularity;

      // ── MongoDB $group _id expressions per granularity ──

      const floorSecondsExpr = (interval: number) => ({
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

      const floorMinutesExpr = (interval: number) => ({
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

      const floorHoursExpr = (interval: number) => ({
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

      const groupId = buildTimelineGroupId(granularity, {
        floorSecondsExpr,
        floorMinutesExpr,
        floorHoursExpr,
        weekStartExpr,
      });

      const timeMatch: Record<string, string> = {
        $gte: sinceDate.toISOString(),
      };
      if (untilDate) timeMatch.$lte = untilDate!.toISOString();

      const matchFilter = await buildMatchFilter(req);
      matchFilter.timestamp = timeMatch;

      const pipeline: Record<string, unknown>[] = [
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
        data: results.map((r: Record<string, unknown>) => mapTimelineRow(r)),
      });
    } catch (error: unknown) {
      logger.error(`Admin /stats/timeline error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /stats/agents — per-agent breakdown ──────────
router.get(
  "/agents",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const match = await buildMatchFilter(req);
      match.agent = { $exists: true, $ne: null };

      const pipeline: Record<string, unknown>[] = [
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

      res.json(
        results.map((r: Record<string, unknown>) => {
          const agentId = (r._id as string) || "";
          const persona = AgentPersonaRegistry.get(agentId);
          const models = ((r._models || []) as string[]).filter(Boolean);
          const providers = ((r._providers || []) as string[]).filter(Boolean);
          const conversationIds = ((r._convIds || []) as string[]).filter(
            Boolean,
          );
          const traceIds = ((r._traceIds || []) as string[]).filter(Boolean);

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
        }),
      );
    } catch (error: unknown) {
      logger.error(`Admin /stats/agents error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

export default router;
