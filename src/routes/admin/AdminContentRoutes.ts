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
import requireDb from "../../middleware/RequireDbMiddleware.ts";

const router = express.Router();
const {
  REQUESTS: REQUESTS_COLLECTION,
  MODEL_CONVERSATIONS: CONVERSATIONS_COLLECTION,
  WORKFLOWS: WORKFLOWS_COLLECTION,
} = COLLECTIONS;

router.use(requireDb);

// ─── GET /workflows — paginated workflow list ─────────
router.get(
  "/workflows",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        project,
        provider,
        model,
        guildId,
        userId,
        userName,
        from,
        to,
        sort = "createdAt",
      } = req.query;

      const { skip, limit, page, sortDirection } = parsePaginationParams(
        req.query,
      );

      const filter: Record<string, unknown> = {};
      if (guildId) filter.guildId = guildId;
      if (userId) filter.userId = userId;
      if (userName) filter.userName = { $regex: userName, $options: "i" };
      applyDateRangeFilter(filter, from as string, to as string, "createdAt");

      if (project || provider || model) {
        const convFilter: Record<string, unknown> = {};
        if (project) convFilter.project = project;
        if (provider) convFilter.providers = provider;
        if (model) convFilter["messages.model"] = model;
        const convIds = await req.db
          .collection(CONVERSATIONS_COLLECTION)
          .distinct("id", convFilter);
        filter.conversationIds = { $elemMatch: { $in: convIds } };
      }

      const [docs, total] = await Promise.all([
        req.db
          .collection(WORKFLOWS_COLLECTION)
          .find(filter)
          .project({
            _id: 1,
            name: 1,
            messageId: 1,
            guildId: 1,
            guildName: 1,
            channelId: 1,
            channelName: 1,
            userId: 1,
            userName: 1,
            userContent: 1,
            stepCount: 1,
            totalDuration: 1,
            totalCost: 1,
            modalities: 1,
            providers: 1,
            source: 1,
            createdAt: 1,
            updatedAt: 1,
          })
          .sort({ [sort as string]: sortDirection })
          .skip(skip)
          .limit(limit)
          .toArray(),
        req.db.collection(WORKFLOWS_COLLECTION).countDocuments(filter),
      ]);

      res.json({ data: docs, total, page, limit });
    } catch (error: unknown) {
      logger.error(`Admin GET /workflows error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /workflows/:id — single workflow detail ──────
router.get(
  "/workflows/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ObjectId } = await import("mongodb");
      let objectId: InstanceType<typeof ObjectId>;
      try {
        objectId = new ObjectId(req.params.id as string);
      } catch {
        return res.status(400).json({ error: "Invalid workflow ID" });
      }

      const document = await req.db
        .collection(WORKFLOWS_COLLECTION)
        .findOne({ _id: objectId });
      if (!document)
        return res.status(404).json({ error: "Workflow not found" });

      res.json(document);
    } catch (error: unknown) {
      logger.error(`Admin GET /workflows/:id error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /media — extract media from all conversations ─
router.get(
  "/media",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { type, origin, search, project, username, from, to } = req.query;

      const { skip, limit, page } = parsePaginationParams(req.query);

      const [convProjects, convUsernames, requestProjects, requestUsernames] =
        await Promise.all([
          req.db.collection(CONVERSATIONS_COLLECTION).distinct("project"),
          req.db.collection(CONVERSATIONS_COLLECTION).distinct("username"),
          req.db.collection(REQUESTS_COLLECTION).distinct("project", {
            operation: { $in: ["agent:image", "agent:iteration"] },
            success: true,
            "responsePayload.images": { $exists: true, $ne: [] },
          }),
          req.db.collection(REQUESTS_COLLECTION).distinct("username", {
            operation: { $in: ["agent:image", "agent:iteration"] },
            success: true,
            "responsePayload.images": { $exists: true, $ne: [] },
          }),
        ]);
      const allProjects = [...new Set([...convProjects, ...requestProjects])]
        .filter(Boolean)
        .sort();
      const allUsernames = [...new Set([...convUsernames, ...requestUsernames])]
        .filter(Boolean)
        .sort();

      const preMatch: Record<string, unknown> = {};
      if (project) preMatch.project = project;
      if (username) preMatch.username = username;
      applyDateRangeFilter(preMatch, from as string, to as string, "updatedAt");

      const pipeline: Record<string, unknown>[] = [
        ...(Object.keys(preMatch).length ? [{ $match: preMatch }] : []),
        { $unwind: "$messages" },
        {
          $project: {
            convId: "$id",
            convTitle: "$title",
            project: 1,
            username: 1,
            role: "$messages.role",
            content: "$messages.content",
            images: { $ifNull: ["$messages.images", []] },
            audio: "$messages.audio",
            toolCalls: { $ifNull: ["$messages.toolCalls", []] },
            timestamp: { $ifNull: ["$messages.timestamp", "$updatedAt"] },
            model: "$messages.model",
          },
        },
        ...(search
          ? [
              {
                $match: {
                  $or: [
                    { convTitle: { $regex: search, $options: "i" } },
                    { content: { $regex: search, $options: "i" } },
                  ],
                },
              },
            ]
          : []),
        {
          $facet: {
            imageItems: [
              { $unwind: "$images" },
              {
                $project: {
                  url: "$images",
                  mediaType: "image",
                  convId: 1,
                  convTitle: 1,
                  project: 1,
                  username: 1,
                  role: 1,
                  timestamp: 1,
                  model: 1,
                },
              },
            ],
            audioItems: [
              { $match: { audio: { $ne: null, $exists: true } } },
              {
                $project: {
                  url: "$audio",
                  mediaType: "audio",
                  convId: 1,
                  convTitle: 1,
                  project: 1,
                  username: 1,
                  role: 1,
                  timestamp: 1,
                  model: 1,
                },
              },
            ],
            screenshotItems: [
              { $unwind: "$toolCalls" },
              {
                $match: {
                  "toolCalls.result.screenshotRef": {
                    $exists: true,
                    $ne: null,
                  },
                },
              },
              {
                $project: {
                  url: "$toolCalls.result.screenshotRef",
                  mediaType: "image",
                  convId: 1,
                  convTitle: 1,
                  project: 1,
                  username: 1,
                  role: 1,
                  timestamp: 1,
                  model: 1,
                },
              },
            ],
          },
        },
        {
          $project: {
            allMedia: {
              $concatArrays: ["$imageItems", "$audioItems", "$screenshotItems"],
            },
          },
        },
        { $unwind: "$allMedia" },
        { $replaceRoot: { newRoot: "$allMedia" } },
        { $sort: { timestamp: -1 } },
      ];

      if (type) {
        pipeline.push({ $match: { mediaType: type } });
      }
      if (origin === "user") {
        pipeline.push({ $match: { role: "user" } });
      } else if (origin === "ai") {
        pipeline.push({ $match: { role: "assistant" } });
      }

      const convItems = await req.db
        .collection(CONVERSATIONS_COLLECTION)
        .aggregate(pipeline)
        .toArray();

      let requestGenItems: Record<string, unknown>[] = [];
      if (!type || type === "image") {
        if (origin !== "user") {
          const requestMatch: Record<string, unknown> = {
            operation: { $in: ["agent:image", "agent:iteration"] },
            success: true,
            "responsePayload.images": { $exists: true, $ne: [] },
          };
          if (project) requestMatch.project = project;
          if (username) requestMatch.username = username;
          applyDateRangeFilter(requestMatch, from as string, to as string);
          if (search) {
            requestMatch["requestPayload.messages.content"] = {
              $regex: search,
              $options: "i",
            };
          }

          const requestPipeline: Record<string, unknown>[] = [
            { $match: requestMatch },
            { $unwind: "$responsePayload.images" },
            {
              $match: {
                "responsePayload.images": {
                  $regex: "^(minio://|https?://|data:)",
                },
              },
            },
            {
              $project: {
                url: "$responsePayload.images",
                mediaType: "image",
                convId: { $ifNull: ["$conversationId", null] },
                convTitle: "Agent Generation",
                project: 1,
                username: 1,
                role: "assistant",
                timestamp: 1,
                model: 1,
                agent: 1,
              },
            },
            { $sort: { timestamp: -1 } },
          ];

          requestGenItems = await req.db
            .collection(REQUESTS_COLLECTION)
            .aggregate(requestPipeline)
            .toArray();
        }
      }

      const seenUrls = new Set(
        convItems.map((i: Record<string, unknown>) => i.url),
      );
      const mergedItems = [...convItems];
      for (const item of requestGenItems) {
        if (!seenUrls.has(item.url)) {
          seenUrls.add(item.url);
          mergedItems.push(item);
        }
      }

      mergedItems.sort(
        (
          firstItem: Record<string, unknown>,
          secondItem: Record<string, unknown>,
        ) => {
          const timestampA = firstItem.timestamp || "";
          const timestampB = secondItem.timestamp || "";
          return timestampA < timestampB ? 1 : timestampA > timestampB ? -1 : 0;
        },
      );

      const total = mergedItems.length;
      const paginatedItems = mergedItems.slice(skip, skip + limit);

      const data = paginatedItems.map((item: Record<string, unknown>) => ({
        url: item.url,
        mediaType: item.mediaType,
        origin: item.role === "assistant" ? "ai" : "user",
        convId: item.convId,
        convTitle: item.convTitle || "Untitled",
        project: item.project,
        username: item.username,
        model: item.model,
        timestamp: item.timestamp,
        ...(item.agent ? { agent: item.agent } : {}),
      }));

      res.json({
        data,
        total,
        page,
        limit,
        projects: allProjects,
        usernames: allUsernames,
      });
    } catch (error: unknown) {
      logger.error(`Admin /media error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /text — extract text content from conversations ─
router.get(
  "/text",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { origin, search, project, from, to } = req.query;

      const { skip, limit, page } = parsePaginationParams(req.query);

      const preMatch: Record<string, unknown> = {};
      if (project) preMatch.project = project;
      applyDateRangeFilter(preMatch, from as string, to as string, "updatedAt");

      const pipeline: Record<string, unknown>[] = [
        ...(Object.keys(preMatch).length ? [{ $match: preMatch }] : []),
        { $unwind: "$messages" },
        {
          $match: {
            "messages.content": { $exists: true, $nin: [null, ""] },
          },
        },
        {
          $project: {
            convId: "$id",
            convTitle: "$title",
            project: 1,
            username: 1,
            role: "$messages.role",
            content: "$messages.content",
            timestamp: { $ifNull: ["$messages.timestamp", "$updatedAt"] },
            model: "$messages.model",
            estimatedCost: "$messages.estimatedCost",
            images: { $size: { $ifNull: ["$messages.images", []] } },
          },
        },
        { $sort: { timestamp: -1 } },
      ];

      if (origin === "user") {
        pipeline.push({ $match: { role: "user" } });
      } else if (origin === "ai") {
        pipeline.push({ $match: { role: "assistant" } });
      }
      if (search) {
        pipeline.push({
          $match: { content: { $regex: search, $options: "i" } },
        });
      }

      const countPipeline: Record<string, unknown>[] = [
        ...pipeline,
        { $count: "total" },
      ];
      const [countResult] = await req.db
        .collection(CONVERSATIONS_COLLECTION)
        .aggregate(countPipeline)
        .toArray();
      const total = countResult?.total || 0;

      pipeline.push({ $skip: skip }, { $limit: limit });

      const items = await req.db
        .collection(CONVERSATIONS_COLLECTION)
        .aggregate(pipeline)
        .toArray();

      const data = items.map((item: Record<string, unknown>) => ({
        content: item.content,
        origin: item.role === "assistant" ? "ai" : "user",
        role: item.role,
        convId: item.convId,
        convTitle: item.convTitle || "Untitled",
        project: item.project,
        username: item.username,
        model: item.model,
        estimatedCost: item.estimatedCost,
        hasImages: (item.images as number) > 0,
        timestamp: item.timestamp,
      }));

      res.json({ data, total, page, limit });
    } catch (error: unknown) {
      logger.error(`Admin /text error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

export default router;
