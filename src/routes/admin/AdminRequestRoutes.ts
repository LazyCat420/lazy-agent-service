import { ObjectId } from "mongodb";
import { DEFAULT_WORKFLOW_TITLE } from "@rodrigo-barraza/utilities-library/taxonomy";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { COLLECTIONS } from "../../constants.ts";
import logger from "../../utils/logger.ts";
import { getErrorMessage } from "../../utils/ErrorHelpers.ts";
import {
  applyDateRangeFilter,
  parseCsvFilter,
  parsePaginationParams,
} from "../../utils/QueryBuilders.ts";
import requireDb from "../../middleware/RequireDbMiddleware.ts";

const router = express.Router();
const {
  REQUESTS: REQUESTS_COLLECTION,
  MODEL_CONVERSATIONS: CONVERSATIONS_COLLECTION,
  WORKFLOWS: WORKFLOWS_COLLECTION,
} = COLLECTIONS;

router.use(requireDb);

// ─── GET /requests — paginated, filtered request logs ─
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        project,
        username,
        provider,
        model,
        endpoint,
        operation,
        success,
        agent,
        from,
        to,
        sort = "timestamp",
        workspace,
      } = req.query;

      const { skip, limit, page, sortDirection } = parsePaginationParams(
        req.query,
      );

      const filter: Record<string, unknown> = {};
      if (project) filter.project = project;
      if (username) filter.username = username;
      if (model) filter.model = model;

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

      const providerFilter = parseCsvFilter(provider);
      if (providerFilter !== undefined) filter.provider = providerFilter;

      const endpointFilter = parseCsvFilter(endpoint);
      if (endpointFilter !== undefined) filter.endpoint = endpointFilter;

      const operationFilter = parseCsvFilter(operation);
      if (operationFilter !== undefined) filter.operation = operationFilter;

      const agentFilter = parseCsvFilter(agent);
      if (agentFilter !== undefined) filter.agent = agentFilter;

      const successFilter = parseCsvFilter(success);
      if (typeof successFilter === "string") {
        filter.success = successFilter === "true";
      } else if (successFilter !== undefined) {
        filter.success = {
          $in: successFilter.$in.map((value) => value === "true"),
        };
      }

      applyDateRangeFilter(filter, from as string, to as string);

      const [docs, total] = await Promise.all([
        req.db
          .collection(REQUESTS_COLLECTION)
          .find(filter, {
            projection: { requestPayload: 0, responsePayload: 0 },
          })
          .sort({ [sort as string]: sortDirection })
          .skip(skip)
          .limit(limit)
          .toArray(),
        req.db.collection(REQUESTS_COLLECTION).countDocuments(filter),
      ]);

      res.json({ data: docs, total, page, limit });
    } catch (error: unknown) {
      logger.error(`Admin /requests error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /requests/:id — single request detail ────────
router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requestIdentifier = req.params.id as string;
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
    } catch (error: unknown) {
      logger.error(`Admin /requests/:id error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /requests/:id/associations — conversations, workflows & traces ─
router.get(
  "/:id/associations",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requestIdentifier = req.params.id as string;
      let request = await req.db
        .collection(REQUESTS_COLLECTION)
        .findOne({ requestId: requestIdentifier });
      if (!request && ObjectId.isValid(requestIdentifier)) {
        request = await req.db
          .collection(REQUESTS_COLLECTION)
          .findOne({ _id: new ObjectId(requestIdentifier) });
      }
      if (!request) return res.status(404).json({ error: "Request not found" });

      let conversations: Record<string, unknown>[] = [];
      let workflows: Record<string, unknown>[] = [];
      let traces: Record<string, unknown>[] = [];

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

        workflows = workflows.map((record: Record<string, unknown>) => ({
          id: (record._id as { toString: () => string }).toString(),
          name: record.name || DEFAULT_WORKFLOW_TITLE,
          nodeCount: record.nodeCount || 0,
          edgeCount: record.edgeCount || 0,
          source: record.source || "prism-client",
        }));

        const traceIds = new Set();
        for (const conversation of conversations) {
          if (conversation.traceId) traceIds.add(conversation.traceId);
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
          traces = traceAgg.map((s: Record<string, unknown>) => ({
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
    } catch (error: unknown) {
      logger.error(
        `Admin /requests/:id/associations error: ${getErrorMessage(error)}`,
      );
      next(error);
    }
  }),
);

export default router;
