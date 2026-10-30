import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import type { Db } from "mongodb";
import requireDb from "../middleware/RequireDbMiddleware.ts";
import logger from "../utils/logger.ts";
import { COLLECTIONS } from "../constants.ts";
import { GetMediaQuerySchema } from "../types/index.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

const router = express.Router();
router.use(requireDb);
const CONVERSATIONS_COLLECTION = COLLECTIONS.MODEL_CONVERSATIONS;
const REQUESTS_COLLECTION = COLLECTIONS.REQUESTS;

interface AggregateMediaItem {
  url: string;
  mediaType: "image" | "audio";
  convId: string | null;
  convTitle?: string;
  project: string;
  username: string;
  role: string;
  timestamp: string | Date;
  model?: string;
  provider?: string;
  agent?: string;
}

interface MediaQueryFilters {
  type?: "image" | "audio";
  origin?: "user" | "ai";
  search?: string;
  provider?: string;
  model?: string;
  from?: string;
  to?: string;
}

/** Conversation-level match: caller's project plus the optional updatedAt window. */
function buildMediaPreMatch(
  project: string | undefined,
  from: string | undefined,
  to: string | undefined,
): Record<string, unknown> {
  const preMatch: Record<string, unknown> = { project };
  if (from || to) {
    const updatedAtFilter: Record<string, unknown> = {};
    if (from) updatedAtFilter.$gte = from;
    if (to) updatedAtFilter.$lte = to;
    preMatch.updatedAt = updatedAtFilter;
  }
  return preMatch;
}

/** Aggregation pipeline extracting image, audio and screenshot media from messages. */
function buildMediaPipeline(
  preMatch: Record<string, unknown>,
  filters: MediaQueryFilters,
): Record<string, unknown>[] {
  const { search, type, origin, provider, model } = filters;
  const pipeline: Record<string, unknown>[] = [
    { $match: preMatch },
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
        provider: "$messages.provider",
      },
    },
    // Search across conversation title AND message content
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
              provider: 1,
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
              provider: 1,
            },
          },
        ],
        // Extract browser screenshots from toolCalls[].result.screenshotRef
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
              provider: 1,
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
  if (provider) {
    pipeline.push({ $match: { provider } });
  }
  if (model) {
    pipeline.push({ $match: { model } });
  }

  return pipeline;
}

function fetchConversationMedia(
  db: Db,
  pipeline: Record<string, unknown>[],
): Promise<AggregateMediaItem[]> {
  return db
    .collection(CONVERSATIONS_COLLECTION)
    .aggregate<AggregateMediaItem>(pipeline)
    .toArray();
}

/**
 * Agent-generated images from requests (captures skipConversation callers).
 * These are images generated by the agentic loop's generate_image built-in tool,
 * logged via RequestLogger with operation "agent:image".
 */
async function fetchRequestGeneratedImages(
  db: Db,
  project: string | undefined,
  filters: MediaQueryFilters,
): Promise<AggregateMediaItem[]> {
  const { type, origin, search, provider, model, from, to } = filters;
  if (type && type !== "image") return [];
  // Agent-generated images are always origin=ai
  if (origin === "user") return [];

  const requestMatch: Record<string, unknown> = {
    project,
    operation: { $in: ["agent:image", "agent:iteration"] },
    success: true,
    "responsePayload.images": { $exists: true, $ne: [] },
  };
  if (from || to) {
    const timestampFilter: Record<string, unknown> = {};
    if (from) timestampFilter.$gte = from;
    if (to) timestampFilter.$lte = to;
    requestMatch.timestamp = timestampFilter;
  }
  if (provider) requestMatch.provider = provider;
  if (model) requestMatch.model = model;
  if (search) {
    requestMatch["requestPayload.messages.content"] = {
      $regex: search,
      $options: "i",
    };
  }

  const requestPipeline: Record<string, unknown>[] = [
    { $match: requestMatch },
    { $unwind: "$responsePayload.images" },
    // Only include actual refs (MinIO refs or URLs), skip placeholder "[generated]"
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
        provider: 1,
        agent: 1,
      },
    },
    { $sort: { timestamp: -1 } },
  ];

  return db
    .collection(REQUESTS_COLLECTION)
    .aggregate<AggregateMediaItem>(requestPipeline)
    .toArray();
}

/** Conversation items take priority; request items fill the gaps, then re-sort. */
function mergeMediaItems(
  convItems: AggregateMediaItem[],
  requestGenItems: AggregateMediaItem[],
): AggregateMediaItem[] {
  const seenUrls = new Set<string>(convItems.map((i) => i.url));
  const mergedItems: AggregateMediaItem[] = [...convItems];
  for (const item of requestGenItems) {
    if (!seenUrls.has(item.url)) {
      seenUrls.add(item.url);
      mergedItems.push(item);
    }
  }

  mergedItems.sort((aggregateMediaItem, b) => {
    const timestampA = aggregateMediaItem.timestamp || "";
    const timestampB = b.timestamp || "";
    return timestampA < timestampB ? 1 : timestampA > timestampB ? -1 : 0;
  });
  return mergedItems;
}

/** Paginate the merged set and derive the filter options from the full set. */
function buildMediaResponse(
  mergedItems: AggregateMediaItem[],
  skip: number,
  limit: number,
) {
  const total = mergedItems.length;
  const paginatedItems = mergedItems.slice(skip, skip + limit);

  const allProviders = [
    ...new Set(mergedItems.map((i) => i.provider).filter(Boolean)),
  ].sort() as string[];
  const allModels = [
    ...new Set(mergedItems.map((i) => i.model).filter(Boolean)),
  ].sort() as string[];

  const data = paginatedItems.map((item) => ({
    url: item.url,
    mediaType: item.mediaType,
    origin: item.role === "assistant" ? "ai" : "user",
    convId: item.convId,
    convTitle: item.convTitle || "Untitled",
    project: item.project,
    username: item.username,
    model: item.model,
    provider: item.provider,
    timestamp: item.timestamp,
    ...(item.agent && { agent: item.agent }),
  }));

  return { data, total, providers: allProviders, models: allModels };
}

// ─── GET /media — extract media from the caller's project conversations ─
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parseResult = GetMediaQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        return res.status(400).json({
          error: `Validation failed: ${parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        });
      }

      const { page, limit, type, origin, search, provider, model, from, to } =
        parseResult.data;
      const filters: MediaQueryFilters = {
        type,
        origin,
        search,
        provider,
        model,
        from,
        to,
      };

      const skip = (page - 1) * limit;

      // Always scope to the caller's project
      const preMatch = buildMediaPreMatch(req.project, from, to);
      const pipeline = buildMediaPipeline(preMatch, filters);

      // ── Conversation-based media ──────────────────────────────
      const convItems = await fetchConversationMedia(req.db, pipeline);

      // ── Agent-generated images from requests (captures skipConversation callers) ──
      // These are images generated by the agentic loop's generate_image built-in tool,
      // logged via RequestLogger with operation "agent:image". This covers Lupos and
      // any other caller that sets skipConversation: true.
      const requestGenItems = await fetchRequestGeneratedImages(
        req.db,
        req.project,
        filters,
      );

      // ── Merge and deduplicate ──────────────────────────────────
      // Conversation items take priority; request items fill the gaps
      // (images from skipConversation callers that aren't in any conversation)
      const mergedItems = mergeMediaItems(convItems, requestGenItems);
      const { data, total, providers, models } = buildMediaResponse(
        mergedItems,
        skip,
        limit,
      );

      res.json({
        data,
        total,
        page,
        limit,
        providers,
        models,
      });
    } catch (error: unknown) {
      logger.error(`GET /media error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

export default router;
