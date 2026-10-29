import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { COLLECTIONS, COST_SUM_EXPR } from "../../constants.ts";
import logger from "../../utils/logger.ts";
import { getErrorMessage } from "../../utils/ErrorHelpers.ts";
import {
  applyDateRangeFilter,
  buildAdminMatch,
  parsePaginationParams,
} from "../../utils/QueryBuilders.ts";
import requireDb from "../../middleware/RequireDbMiddleware.ts";

const router = express.Router();
const { REQUESTS: REQUESTS_COLLECTION } = COLLECTIONS;

router.use(requireDb);

// ─── GET /traces — paginated trace list (derived from requests) ─
// Lightweight summary-only aggregate: no $push of full documents.
// Full request details are fetched lazily via GET /traces/:id.
const AGGREGATE_MAX_TIME_MS = 30_000;

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        project,
        username,
        from,
        to,
        sort = "createdAt",
        provider,
        model,
        agent,
        workspace,
      } = req.query;

      const { skip, limit, page, sortDirection } = parsePaginationParams(
        req.query,
      );

      const match = buildAdminMatch(req.query as Record<string, unknown>, { traceOnly: true });
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

      const groupStage = {
        $group: {
          _id: "$traceId",
          project: { $first: "$project" },
          username: { $first: "$username" },
          createdAt: { $min: "$timestamp" },
          updatedAt: { $max: "$timestamp" },
          requestCount: { $sum: 1 },
          totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
          totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
          totalCost: COST_SUM_EXPR,
          totalLatency: { $sum: { $ifNull: ["$totalTime", 0] } },
          totalMessages: { $sum: { $ifNull: ["$messageCount", 0] } },
          _models: { $addToSet: "$model" },
          _providers: { $addToSet: "$provider" },
          _agents: { $addToSet: "$agent" },
          _toolDisplayNames: { $addToSet: "$toolDisplayNames" },
          _toolApiNames: { $addToSet: "$toolApiNames" },
          _hasAudio: { $max: { $ifNull: ["$modalities.audio", false] } },
          _hasVision: { $max: { $ifNull: ["$modalities.vision", false] } },
          _hasImage: { $max: { $ifNull: ["$modalities.image", false] } },
          _tpsSum: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ["$tokensPerSec", null] },
                    { $gt: ["$tokensPerSec", 0] },
                  ],
                },
                "$tokensPerSec",
                0,
              ],
            },
          },
          _tpsCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ["$tokensPerSec", null] },
                    { $gt: ["$tokensPerSec", 0] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      };

      const projectStage = {
        $addFields: {
          id: "$_id",
          models: { $setDifference: ["$_models", [null]] },
          providers: { $setDifference: ["$_providers", [null]] },
          agents: { $setDifference: ["$_agents", [null]] },
          toolDisplayNames: {
            $setDifference: [
              {
                $reduce: {
                  input: {
                    $filter: {
                      input: "$_toolDisplayNames",
                      as: "array",
                      cond: { $isArray: "$$array" },
                    },
                  },
                  initialValue: [],
                  in: { $setUnion: ["$$value", "$$this"] },
                },
              },
              [null],
            ],
          },
          toolApiNames: {
            $setDifference: [
              {
                $reduce: {
                  input: {
                    $filter: {
                      input: "$_toolApiNames",
                      as: "array",
                      cond: { $isArray: "$$array" },
                    },
                  },
                  initialValue: [],
                  in: { $setUnion: ["$$value", "$$this"] },
                },
              },
              [null],
            ],
          },
          avgTokensPerSec: {
            $cond: [
              { $gt: ["$_tpsCount", 0] },
              { $divide: ["$_tpsSum", "$_tpsCount"] },
              null,
            ],
          },
          startedAt: "$createdAt",
          finishedAt: "$updatedAt",
          modalities: {
            $arrayToObject: {
              $filter: {
                input: [
                  { k: "audio", v: "$_hasAudio" },
                  { k: "vision", v: "$_hasVision" },
                  { k: "image", v: "$_hasImage" },
                ],
                as: "entry",
                cond: { $eq: ["$$entry.v", true] },
              },
            },
          },
        },
      };

      const cleanupStage = {
        $project: {
          _id: 0,
          _models: 0,
          _providers: 0,
          _agents: 0,
          _toolDisplayNames: 0,
          _toolApiNames: 0,
          _tpsSum: 0,
          _tpsCount: 0,
          _hasAudio: 0,
          _hasVision: 0,
          _hasImage: 0,
        },
      };

      const sortStage = { $sort: { [sort as string]: sortDirection } };

      const facetPipeline = [
        { $match: match },
        groupStage,
        projectStage,
        cleanupStage,
        {
          $facet: {
            data: [sortStage, { $skip: skip }, { $limit: limit }],
            metadata: [{ $count: "total" }],
          },
        },
      ];

      const [result] = await req.db
        .collection(REQUESTS_COLLECTION)
        .aggregate(facetPipeline, { maxTimeMS: AGGREGATE_MAX_TIME_MS })
        .toArray();

      const docs = result?.data || [];
      const total = result?.metadata?.[0]?.total || 0;

      res.json({ data: docs, total, page, limit });
    } catch (error: unknown) {
      logger.error(`Admin /traces error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /traces/:id — single trace derived from requests ─
router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requests = await req.db
        .collection(REQUESTS_COLLECTION)
        .find(
          { traceId: req.params.id },
          {
            projection: { requestPayload: 0, responsePayload: 0 },
            maxTimeMS: AGGREGATE_MAX_TIME_MS,
          },
        )
        .toArray();

      if (requests.length === 0) {
        return res.status(404).json({ error: "Trace not found" });
      }

      const trace = {
        id: req.params.id,
        project: requests[0].project,
        username: requests[0].username,
        requestCount: requests.length,
        totalCost: requests.reduce(
          (sum: number, r: Record<string, unknown>) =>
            sum + ((r.estimatedCost as number) || 0),
          0,
        ),
        totalInputTokens: requests.reduce(
          (sum: number, r: Record<string, unknown>) =>
            sum + ((r.inputTokens as number) || 0),
          0,
        ),
        totalOutputTokens: requests.reduce(
          (sum: number, r: Record<string, unknown>) =>
            sum + ((r.outputTokens as number) || 0),
          0,
        ),
        createdAt: (requests as Record<string, unknown>[]).reduce(
          (min: string | null, r) =>
            !min || (r.timestamp as string) < min
              ? (r.timestamp as string)
              : min,
          null as string | null,
        ),
        updatedAt: (requests as Record<string, unknown>[]).reduce(
          (max: string | null, r) =>
            !max || (r.timestamp as string) > max
              ? (r.timestamp as string)
              : max,
          null as string | null,
        ),
        requests,
      };

      res.json(trace);
    } catch (error: unknown) {
      logger.error(`Admin /traces/:id error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

export default router;
