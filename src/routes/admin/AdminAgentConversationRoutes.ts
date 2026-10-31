import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { COLLECTIONS } from "../../constants.ts";
import logger from "../../utils/logger.ts";
import { getErrorMessage } from "../../utils/ErrorHelpers.ts";
import {
  applyDateRangeFilter,
  parsePaginationParams,
} from "../../utils/QueryBuilders.ts";
import { discoverDescendantConversationIds } from "../../utils/ConversationDiscovery.ts";
import requireDb from "../../middleware/RequireDbMiddleware.ts";

const conversationStatsRouter = express.Router();
const agentConversationRouter = express.Router();
const { REQUESTS: REQUESTS_COLLECTION } = COLLECTIONS;

conversationStatsRouter.use(requireDb);
agentConversationRouter.use(requireDb);

interface ConversationRequestRow {
  estimatedCost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  provider?: string;
  model?: string;
  operation?: string;
  timestamp?: string;
  modalities?: Record<string, boolean>;
  toolApiNames?: string[];
  agentConversationId?: string;
}

function accumulateRequestStats(rows: ConversationRequestRow[]) {
  const providers = new Set<string>();
  const models = new Set<string>();
  const operations = new Set<string>();
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadInputTokens = 0;
  let totalCacheCreationInputTokens = 0;
  let totalReasoningOutputTokens = 0;
  const mergedModalities: Record<string, boolean> = {};
  const toolCounts: Record<string, number> = {};

  for (const row of rows) {
    totalCost += row.estimatedCost || 0;
    totalInputTokens += row.inputTokens || 0;
    totalOutputTokens += row.outputTokens || 0;
    totalCacheReadInputTokens += row.cacheReadInputTokens || 0;
    totalCacheCreationInputTokens += row.cacheCreationInputTokens || 0;
    totalReasoningOutputTokens += row.reasoningOutputTokens || 0;
    if (row.provider) providers.add(row.provider);
    if (row.model) models.add(row.model);
    if (row.operation) operations.add(row.operation);
    if (row.modalities) {
      for (const [key, value] of Object.entries(row.modalities)) {
        if (value) mergedModalities[key] = true;
      }
    }
    if (row.toolApiNames?.length > 0) {
      for (const name of row.toolApiNames) {
        toolCounts[name] = (toolCounts[name] || 0) + 1;
      }
    }
  }

  return {
    providers,
    models,
    operations,
    totalCost,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadInputTokens,
    totalCacheCreationInputTokens,
    totalReasoningOutputTokens,
    mergedModalities,
    toolCounts,
  };
}

function computeConversationElapsed(rows: ConversationRequestRow[]) {
  const createdAt = rows.reduce(
    (min: string | null, row) =>
      !min || (row.timestamp as string) < min
        ? (row.timestamp as string)
        : min,
    null as string | null,
  );
  const updatedAt = rows.reduce(
    (max: string | null, row) =>
      !max || (row.timestamp as string) > max
        ? (row.timestamp as string)
        : max,
    null as string | null,
  );
  const totalElapsedTime =
    createdAt && updatedAt
      ? Math.max(
          0,
          (new Date(updatedAt as string).getTime() -
            new Date(createdAt as string).getTime()) /
            1000,
        )
      : 0;
  return { createdAt, updatedAt, totalElapsedTime };
}

// ─── GET /agent-conversations/:id/stats — aggregate stats for an agent conversation ─
conversationStatsRouter.get(
  "/:id/stats",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const conversationId = req.params.id as string;
      const allConversationIds = await discoverDescendantConversationIds(
        req.db,
        conversationId,
      );

      const requests = await req.db
        .collection(REQUESTS_COLLECTION)
        .find({
          agentConversationId: { $in: [...allConversationIds] }
        })
        .project({
          estimatedCost: 1,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 1,
          cacheCreationInputTokens: 1,
          reasoningOutputTokens: 1,
          provider: 1,
          model: 1,
          operation: 1,
          timestamp: 1,
          modalities: 1,
          toolApiNames: 1,
          success: 1,
          agentConversationId: 1,
          parentAgentConversationId: 1,
        })
        .toArray();

      if (requests.length === 0) {
        return res
          .status(404)
          .json({ error: "No requests found for this conversation" });
      }

      const {
        providers,
        models,
        operations,
        totalCost,
        totalInputTokens,
        totalOutputTokens,
        totalCacheReadInputTokens,
        totalCacheCreationInputTokens,
        totalReasoningOutputTokens,
        mergedModalities,
        toolCounts,
      } = accumulateRequestStats(requests);

      const subAgentRequestCount = requests.filter(
        (requestItem) => requestItem.agentConversationId !== conversationId,
      ).length;

      const { createdAt, updatedAt, totalElapsedTime } =
        computeConversationElapsed(requests);

      res.json({
        agentConversationId: conversationId,
        requestCount: requests.length,
        subAgentRequestCount,
        totalCost,
        totalInputTokens,
        totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        totalCacheReadInputTokens,
        totalCacheCreationInputTokens,
        totalReasoningOutputTokens,
        providers: [...providers],
        models: [...models],
        operations: [...operations],
        modalities: mergedModalities,
        toolCounts,
        totalElapsedTime,
        createdAt,
        updatedAt,
      });
    } catch (error: unknown) {
      logger.error(
        `Admin /sessions/:id/stats error: ${getErrorMessage(error)}`,
      );
      next(error);
    }
  }),
);

// ─── GET /agent-conversations/:id/requests — all requests for a conversation (recursive) ─
conversationStatsRouter.get(
  "/:id/requests",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rootConversationId = req.params.id as string;
      const allConversationIds = await discoverDescendantConversationIds(
        req.db,
        rootConversationId,
      );

      const requests = await req.db
        .collection(REQUESTS_COLLECTION)
        .find({
          agentConversationId: { $in: [...allConversationIds] }
        })
        .project({
          requestId: 1,
          timestamp: 1,
          provider: 1,
          model: 1,
          operation: 1,
          endpoint: 1,
          success: 1,
          errorMessage: 1,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 1,
          cacheCreationInputTokens: 1,
          reasoningOutputTokens: 1,
          estimatedCost: 1,
          tokensPerSec: 1,
          totalTime: 1,
          toolsUsed: 1,
          toolDisplayNames: 1,
          toolApiNames: 1,
          modalities: 1,
          agentConversationId: 1,
          parentAgentConversationId: 1,
          traceId: 1,
          agent: 1,
          username: 1,
        })
        .sort({ timestamp: 1 })
        .toArray();

      res.json({
        rootConversationId,
        conversationIds: [...allConversationIds],
        total: requests.length,
        requests,
      });
    } catch (error: unknown) {
      logger.error(
        `Admin /sessions/:id/requests error: ${getErrorMessage(error)}`,
      );
      next(error);
    }
  }),
);

// ─── GET /agent-conversations — list all agent conversations (cross-user) ─
agentConversationRouter.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        project,
        agent,
        search,
        from,
        to,
        sort = "updatedAt",
      } = req.query;

      const { skip, limit, page, sortDirection } = parsePaginationParams(
        req.query,
      );

      const queryFilter: Record<string, unknown> = {};
      if (project) queryFilter.project = project;
      if (agent) queryFilter.agent = agent;
      if (search) {
        const regex = { $regex: search, $options: "i" };
        queryFilter.$or = [
          { title: regex },
          { project: regex },
          { agent: regex },
        ];
      }
      applyDateRangeFilter(
        queryFilter,
        from as string,
        to as string,
        "updatedAt",
      );

      const [conversationDocuments, totalConversationsCount] = await Promise.all([
        req.db
          .collection(COLLECTIONS.AGENT_CONVERSATIONS)
          .find(queryFilter, {
            projection: { messages: 0 },
          })
          .sort({ [sort as string]: sortDirection })
          .skip(skip)
          .limit(limit)
          .toArray(),
        req.db
          .collection(COLLECTIONS.AGENT_CONVERSATIONS)
          .countDocuments(queryFilter),
      ]);

      if (conversationDocuments.length > 0) {
        const conversationIds = conversationDocuments
          .map((conversation) => (conversation as Record<string, unknown>).id as string)
          .filter(Boolean);

        if (conversationIds.length > 0) {
          try {
            const costAggregation = await req.db
              .collection(COLLECTIONS.REQUESTS)
              .aggregate<{ _id: string; totalCost: number }>([
                {
                  $match: {
                    $or: [
                      { agentConversationId: { $in: conversationIds } },
                      { conversationId: { $in: conversationIds } },
                      { parentAgentConversationId: { $in: conversationIds } },
                    ],
                  },
                },
                {
                  $group: {
                    _id: {
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
                    },
                    totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
                  },
                },
              ])
              .toArray();

            if (costAggregation.length > 0) {
              const costMap = new Map(
                costAggregation.map((costEntry) => [
                  costEntry._id,
                  costEntry.totalCost,
                ]),
              );
              for (const conversation of conversationDocuments) {
                const conversationId = (conversation as Record<string, unknown>)
                  .id as string;
                const requestLogCost = costMap.get(conversationId);
                if (requestLogCost !== undefined && requestLogCost > 0) {
                  (conversation as Record<string, unknown>).totalCost = Math.max(
                    (conversation.totalCost as number) || 0,
                    requestLogCost,
                  );
                }
              }
            }
          } catch (costError: unknown) {
            logger.warn(
              `Failed to enrich admin agent conversation costs: ${
                costError instanceof Error
                  ? costError.message
                  : String(costError)
              }`,
            );
          }
        }
      }

      res.json({
        data: conversationDocuments,
        total: totalConversationsCount,
        page,
        limit,
      });
    } catch (error: unknown) {
      logger.error(`Admin /agent-conversations error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /agent-conversations/:id — single agent conversation (with messages) ─
agentConversationRouter.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const document = await req.db
        .collection(COLLECTIONS.AGENT_CONVERSATIONS)
        .findOne({ id: req.params.id });

      if (!document)
        return res.status(404).json({ error: "Agent conversation not found" });

      res.json(document);
    } catch (error: unknown) {
      logger.error(
        `Admin /agent-conversations/:id error: ${getErrorMessage(error)}`,
      );
      next(error);
    }
  }),
);

export { conversationStatsRouter, agentConversationRouter };
