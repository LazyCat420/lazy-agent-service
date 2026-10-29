import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import os from "os";
import MongoWrapper from "../../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../../config.js";
import { COLLECTIONS, SSE_KEEPALIVE_INTERVAL_MS } from "../../constants.js";
import ChangeStreamService from "../../services/ChangeStreamService.js";
import logger from "../../utils/logger.js";
import { getErrorMessage } from "../../utils/ErrorHelpers.js";
import requireDb from "../../middleware/RequireDbMiddleware.js";
import { MILLISECONDS_PER_MINUTE } from "@rodrigo-barraza/utilities-library";
const router = express.Router();
const { REQUESTS: REQUESTS_COLLECTION, MODEL_CONVERSATIONS: CONVERSATIONS_COLLECTION, } = COLLECTIONS;
// ─── GET /health — system health ──────────────────────
router.get("/health", asyncHandler(async (_req, res) => {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    const mongoStatus = db ? "connected" : "disconnected";
    let dbStats = null;
    if (db) {
        try {
            const [requestCount, conversationCount] = await Promise.all([
                db.collection(REQUESTS_COLLECTION).estimatedDocumentCount(),
                db.collection(CONVERSATIONS_COLLECTION).estimatedDocumentCount(),
            ]);
            dbStats = { requestCount, conversationCount };
        }
        catch {
            // ignore
        }
    }
    res.json({
        status: mongoStatus === "connected" ? "healthy" : "degraded",
        mongo: mongoStatus,
        dbStats,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        system: {
            platform: os.platform(),
            arch: os.arch(),
            cpus: os.cpus().length,
            totalMemory: os.totalmem(),
            freeMemory: os.freemem(),
        },
    });
}));
// ─── GET /changes/stream — SSE for real-time collection changes ─
router.get("/changes/stream", asyncHandler(async (req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    });
    res.write(`data: ${JSON.stringify({ type: "status", changeStreams: ChangeStreamService.available })}\n\n`);
    if (ChangeStreamService.available) {
        const onEvent = (event) => {
            try {
                res.write(`data: ${JSON.stringify({ type: "change", ...event })}\n\n`);
            }
            catch {
                // Client disconnected
            }
        };
        ChangeStreamService.subscribe(onEvent);
        const keepAlive = setInterval(() => {
            try {
                res.write(": ping\n\n");
            }
            catch {
                // ignore
            }
        }, SSE_KEEPALIVE_INTERVAL_MS);
        req.on("close", () => {
            ChangeStreamService.unsubscribe(onEvent);
            clearInterval(keepAlive);
        });
    }
    else {
        const keepAlive = setInterval(() => {
            try {
                res.write(": ping\n\n");
            }
            catch {
                // ignore
            }
        }, SSE_KEEPALIVE_INTERVAL_MS);
        req.on("close", () => {
            clearInterval(keepAlive);
        });
    }
}));
// ─── GET /live — conversations updated in last N minutes ─
router.get("/live", requireDb, asyncHandler(async (req, res, next) => {
    try {
        const { minutes: minParam = 5 } = req.query;
        const since = new Date(Date.now() - parseInt(minParam, 10) * MILLISECONDS_PER_MINUTE).toISOString();
        const [rawConversations, recentRequests] = await Promise.all([
            req.db
                .collection(CONVERSATIONS_COLLECTION)
                .find({ updatedAt: { $gte: since } })
                .project({
                id: 1,
                project: 1,
                username: 1,
                title: 1,
                updatedAt: 1,
                messages: 1,
                modalities: 1,
                providers: 1,
                isGenerating: 1,
            })
                .sort({ updatedAt: -1 })
                .toArray(),
            req.db
                .collection(REQUESTS_COLLECTION)
                .find({ timestamp: { $gte: since } })
                .sort({ timestamp: -1 })
                .limit(20)
                .toArray(),
        ]);
        const conversations = rawConversations.map((record) => {
            const msgs = (record.messages || []);
            const lastMessage = msgs.length > 0 ? msgs[msgs.length - 1] : null;
            let lastMessageText = null;
            if (lastMessage) {
                const content = lastMessage.content;
                if (typeof content === "string") {
                    lastMessageText = content;
                }
                else if (Array.isArray(content)) {
                    const textPart = content.find((record) => record.type === "text");
                    lastMessageText = textPart?.text || null;
                }
            }
            const totalCost = record.totalCost ||
                msgs.reduce((sum, record) => sum + (record.estimatedCost || 0), 0);
            return {
                id: record.id,
                project: record.project,
                username: record.username,
                title: record.title,
                lastActivity: record.updatedAt,
                messageCount: msgs.length,
                lastMessage: lastMessageText,
                lastMessageRole: lastMessage?.role || null,
                isGenerating: record.isGenerating || false,
                modalities: record.modalities || null,
                providers: record.providers || [],
                totalCost,
            };
        });
        const totalRecent = await req.db
            .collection(REQUESTS_COLLECTION)
            .countDocuments({ timestamp: { $gte: since } });
        const requestsPerMinute = totalRecent / parseInt(minParam, 10);
        res.json({
            conversations,
            recentRequests,
            requestsPerMinute: Math.round(requestsPerMinute * 100) / 100,
            activeCount: conversations.length,
        });
    }
    catch (error) {
        logger.error(`Admin /live error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
export default router;
//# sourceMappingURL=AdminSystemRoutes.js.map