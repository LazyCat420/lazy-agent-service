import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import requireDb from "../middleware/RequireDbMiddleware.js";
import logger from "../utils/logger.js";
import { COLLECTIONS } from "../constants.js";
import { GetMediaQuerySchema } from "../types/index.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
const router = express.Router();
router.use(requireDb);
const CONVERSATIONS_COLLECTION = COLLECTIONS.MODEL_CONVERSATIONS;
const REQUESTS_COLLECTION = COLLECTIONS.REQUESTS;
// ─── GET /media — extract media from the caller's project conversations ─
router.get("/", asyncHandler(async (req, res, next) => {
    try {
        const db = req.db;
        const parseResult = GetMediaQuerySchema.safeParse(req.query);
        if (!parseResult.success) {
            return res.status(400).json({
                error: `Validation failed: ${parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
            });
        }
        const { page, limit, type, origin, search, provider, model, from, to } = parseResult.data;
        const skip = (page - 1) * limit;
        // Always scope to the caller's project
        const preMatch = { project: req.project };
        if (from || to) {
            const updatedAtFilter = {};
            if (from)
                updatedAtFilter.$gte = from;
            if (to)
                updatedAtFilter.$lte = to;
            preMatch.updatedAt = updatedAtFilter;
        }
        const pipeline = [
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
        }
        else if (origin === "ai") {
            pipeline.push({ $match: { role: "assistant" } });
        }
        if (provider) {
            pipeline.push({ $match: { provider } });
        }
        if (model) {
            pipeline.push({ $match: { model } });
        }
        // ── Conversation-based media ──────────────────────────────
        const convItems = await db
            .collection(CONVERSATIONS_COLLECTION)
            .aggregate(pipeline)
            .toArray();
        // ── Agent-generated images from requests (captures skipConversation callers) ──
        // These are images generated by the agentic loop's generate_image built-in tool,
        // logged via RequestLogger with operation "agent:image". This covers Lupos and
        // any other caller that sets skipConversation: true.
        let requestGenItems = [];
        if (!type || type === "image") {
            // Only fetch if we're not filtering to audio-only
            if (origin !== "user") {
                // Agent-generated images are always origin=ai
                const requestMatch = {
                    project: req.project,
                    operation: { $in: ["agent:image", "agent:iteration"] },
                    success: true,
                    "responsePayload.images": { $exists: true, $ne: [] },
                };
                if (from || to) {
                    const timestampFilter = {};
                    if (from)
                        timestampFilter.$gte = from;
                    if (to)
                        timestampFilter.$lte = to;
                    requestMatch.timestamp = timestampFilter;
                }
                if (provider)
                    requestMatch.provider = provider;
                if (model)
                    requestMatch.model = model;
                if (search) {
                    requestMatch["requestPayload.messages.content"] = {
                        $regex: search,
                        $options: "i",
                    };
                }
                const requestPipeline = [
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
                requestGenItems = await db
                    .collection(REQUESTS_COLLECTION)
                    .aggregate(requestPipeline)
                    .toArray();
            }
        }
        // ── Merge and deduplicate ──────────────────────────────────
        // Conversation items take priority; request items fill the gaps
        // (images from skipConversation callers that aren't in any conversation)
        const seenUrls = new Set(convItems.map((i) => i.url));
        const mergedItems = [...convItems];
        for (const item of requestGenItems) {
            if (!seenUrls.has(item.url)) {
                seenUrls.add(item.url);
                mergedItems.push(item);
            }
        }
        // Re-sort merged results by timestamp descending
        mergedItems.sort((aggregateMediaItem, b) => {
            const timestampA = aggregateMediaItem.timestamp || "";
            const timestampB = b.timestamp || "";
            return timestampA < timestampB ? 1 : timestampA > timestampB ? -1 : 0;
        });
        const total = mergedItems.length;
        // Apply pagination
        const paginatedItems = mergedItems.slice(skip, skip + limit);
        // Derive filter options from the full merged set
        const allProviders = [
            ...new Set(mergedItems.map((i) => i.provider).filter(Boolean)),
        ].sort();
        const allModels = [
            ...new Set(mergedItems.map((i) => i.model).filter(Boolean)),
        ].sort();
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
        res.json({
            data,
            total,
            page,
            limit,
            providers: allProviders,
            models: allModels,
        });
    }
    catch (error) {
        logger.error(`GET /media error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
export default router;
//# sourceMappingURL=MediaRoutes.js.map