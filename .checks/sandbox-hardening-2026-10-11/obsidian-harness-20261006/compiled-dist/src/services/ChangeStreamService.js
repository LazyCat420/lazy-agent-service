import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../config.js";
import logger from "../utils/logger.js";
import { COLLECTIONS, CHANGE_STREAM_RECONNECT_MS, CHANGE_STREAM_RETRY_MS, } from "../constants.js";
import { registerCleanup } from "../utils/CleanupRegistry.js";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
// ── State ───────────────────────────────────────────────────
const listeners = new Set();
const streams = new Map();
let available = false;
let staleGeneratingInterval = null;
// Collections to watch
const WATCHED_COLLECTIONS = [
    COLLECTIONS.MODEL_CONVERSATIONS,
    COLLECTIONS.AGENT_CONVERSATIONS,
    COLLECTIONS.REQUESTS,
];
/**
 * Attempt to open a Change Stream on a single collection.
 * Returns the stream if successful, null otherwise.
 */
function openStream(db, collectionName) {
    try {
        const collection = db.collection(collectionName);
        const stream = collection.watch([], { fullDocument: "updateLookup" });
        stream.on("change", (event) => {
            const documentKey = "documentKey" in event
                ? event.documentKey
                : undefined;
            const fullDocument = "fullDocument" in event
                ? event.fullDocument
                : null;
            const updateDescription = "updateDescription" in event
                ? event.updateDescription
                : null;
            const payload = {
                collection: collectionName,
                operationType: event.operationType,
                documentId: documentKey?._id?.toString() || null,
                // For inserts/updates, include the document ID field if available
                id: fullDocument?.id || null,
                updatedFields: updateDescription?.updatedFields
                    ? Object.keys(updateDescription.updatedFields)
                    : null,
                timestamp: new Date().toISOString(),
            };
            // Enrich with isGenerating state for conversations
            if (collectionName === COLLECTIONS.MODEL_CONVERSATIONS ||
                collectionName === COLLECTIONS.AGENT_CONVERSATIONS) {
                if (updateDescription?.updatedFields?.isGenerating !== undefined) {
                    payload.isGenerating = updateDescription.updatedFields
                        .isGenerating;
                }
                else if (fullDocument?.isGenerating !== undefined) {
                    payload.isGenerating = fullDocument.isGenerating;
                }
            }
            if (collectionName === COLLECTIONS.REQUESTS &&
                fullDocument?.conversationId) {
                payload.conversationId = fullDocument.conversationId;
            }
            // Enrich requests with parentAgentConversationId so the client can
            // match sub-agent request events by walking up the agent hierarchy.
            if (collectionName === COLLECTIONS.REQUESTS &&
                fullDocument?.parentAgentConversationId) {
                payload.parentAgentConversationId = fullDocument.parentAgentConversationId;
            }
            // Broadcast to all registered listeners
            for (const listener of listeners) {
                try {
                    listener(payload);
                }
                catch (error) {
                    logger.error(`ChangeStream listener error: ${errorMessage(error)}`);
                }
            }
        });
        stream.on("error", (error) => {
            logger.error(`ChangeStream error on ${collectionName}: ${error.message}`);
            // Attempt to re-open after a delay
            streams.delete(collectionName);
            setTimeout(() => {
                const db = MongoWrapper.getDb(MONGO_DB_NAME);
                if (db) {
                    const reopened = openStream(db, collectionName);
                    if (reopened) {
                        streams.set(collectionName, reopened);
                        logger.info(`ChangeStream re-opened on ${collectionName}`);
                    }
                }
            }, CHANGE_STREAM_RETRY_MS);
        });
        return stream;
    }
    catch {
        return null;
    }
}
const ChangeStreamService = {
    get available() {
        return available;
    },
    /**
     * Initialize Change Streams on all watched collections.
     * Call this after MongoDB is connected.
     */
    async init() {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db) {
            logger.warn("ChangeStreamService: No MongoDB client available");
            return;
        }
        // Test if Change Streams are supported by opening a brief watch
        try {
            const testStream = db.collection(WATCHED_COLLECTIONS[0]).watch();
            // If watch() succeeds without throwing, Change Streams are supported.
            // We need to close this test stream and open real ones.
            await testStream.close();
        }
        catch (error) {
            logger.warn(`Change Streams not available (${errorMessage(error)}). ` +
                "Admin dashboard will fall back to polling. " +
                "To enable Change Streams, configure MongoDB as a replica set.");
            available = false;
            return;
        }
        // Open streams on all watched collections
        for (const collectionName of WATCHED_COLLECTIONS) {
            const stream = openStream(db, collectionName);
            if (stream) {
                streams.set(collectionName, stream);
                logger.info(`ChangeStream active: ${collectionName}`);
            }
        }
        available = true;
        logger.success(`Change Streams active on ${streams.size} collection(s): ${[...streams.keys()].join(", ")}`);
        // Periodic stale isGenerating cleanup (every 60s)
        // Catches flags left behind by crashed requests or dropped connections
        staleGeneratingInterval = setInterval(async () => {
            try {
                const fiveMinAgo = new Date(Date.now() - CHANGE_STREAM_RECONNECT_MS).toISOString();
                const { modifiedCount } = await db
                    .collection(COLLECTIONS.MODEL_CONVERSATIONS)
                    .updateMany({ isGenerating: true, updatedAt: { $lt: fiveMinAgo } }, { $set: { isGenerating: false } });
                const { modifiedCount: agentCleared } = await db
                    .collection(COLLECTIONS.AGENT_CONVERSATIONS)
                    .updateMany({ isGenerating: true, updatedAt: { $lt: fiveMinAgo } }, { $set: { isGenerating: false } });
                if (modifiedCount > 0 || agentCleared > 0) {
                    logger.info("Auto-cleared " +
                        (modifiedCount + agentCleared) +
                        " stale isGenerating flag(s)");
                }
            }
            catch {
                // ignore
            }
        }, CHANGE_STREAM_RECONNECT_MS);
    },
    subscribe(callback) {
        listeners.add(callback);
    },
    unsubscribe(callback) {
        listeners.delete(callback);
    },
    async close() {
        for (const [name, stream] of streams) {
            try {
                await stream.close();
                logger.info(`ChangeStream closed: ${name}`);
            }
            catch {
                // ignore
            }
        }
        streams.clear();
        listeners.clear();
        if (staleGeneratingInterval) {
            clearInterval(staleGeneratingInterval);
            staleGeneratingInterval = null;
        }
        available = false;
    },
};
registerCleanup(async () => {
    await ChangeStreamService.close();
});
export default ChangeStreamService;
//# sourceMappingURL=ChangeStreamService.js.map