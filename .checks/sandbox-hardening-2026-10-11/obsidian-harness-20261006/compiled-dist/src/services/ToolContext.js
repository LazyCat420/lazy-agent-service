import crypto from "node:crypto";
import logger from "../utils/logger.js";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../config.js";
import { COLLECTIONS } from "../constants.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
import { Span } from "../platform/trace/Span.js";
import { TraceExporter } from "../platform/trace/TraceExporter.js";
/**
 * ToolContext — per-conversation key-value state store for stateful tool chains.
 *
 * Inspired by the Antigravity SDK's `ToolContext` pattern. Tools can persist
 * state across multiple invocations within the same agent conversation without
 * consuming LLM context window tokens.
 *
 * Architecture:
 *   - In-memory Map for fast synchronous reads during the conversation
 *   - MongoDB persistence for durability across server restarts
 *   - Write-through: every set() writes to both memory and MongoDB
 *   - Read-through: getStore() loads from MongoDB on first access
 *
 * Use cases:
 *   - Pagination cursors (search_web, list_directory)
 *   - Browser tab/conversation state (control_browser)
 *   - Cumulative diff tracking (replace_in_file rollback)
 *   - MCP connection state across invocations
 *
 * Lifecycle:
 *   - Created lazily on first `get`/`set` for a conversation
 *   - Cleaned up when the conversation ends (AgenticLoopService.finally)
 *   - Persisted to MongoDB `tool_context` collection
 *
 * MongoDB Document Shape:
 *   { conversationId: string, state: Record<string, unknown>, updatedAt: string }
 */
/** In-memory conversation state cache */
const conversations = new Map();
/** Tracks which conversations have been loaded from MongoDB */
const loadedConversations = new Set();
function getCollection() {
    return MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.TOOL_CONTEXT);
}
/** Persist the full state map to MongoDB (write-through). */
async function persistToMongo(conversationId, store) {
    try {
        const collection = getCollection();
        if (!collection)
            return;
        const state = Object.fromEntries(store);
        await collection.updateOne({ conversationId }, {
            $set: {
                conversationId,
                state,
                updatedAt: new Date().toISOString(),
            },
        }, { upsert: true });
    }
    catch (error) {
        logger.warn(`[ToolContext] MongoDB persist failed for conversation ${conversationId}: ${getErrorMessage(error)}`);
    }
}
/** Load state from MongoDB into memory (read-through, first access only). */
async function loadFromMongo(conversationId) {
    try {
        const collection = getCollection();
        if (!collection)
            return new Map();
        const doc = (await collection.findOne({ conversationId }));
        if (doc?.state && typeof doc.state === "object") {
            return new Map(Object.entries(doc.state));
        }
    }
    catch (error) {
        logger.warn(`[ToolContext] MongoDB load failed for conversation ${conversationId}: ${getErrorMessage(error)}`);
    }
    return new Map();
}
export default class ToolContext {
    /**
     * Get the full state store for a conversation.
     * Creates the store lazily if it doesn't exist in memory.
     * Note: This returns the in-memory store synchronously.
     * For first access after a restart, call `ensureLoaded()` first.
     */
    static getStore(conversationId) {
        let store = conversations.get(conversationId);
        if (!store) {
            store = new Map();
            conversations.set(conversationId, store);
        }
        return store;
    }
    /**
     * Ensure the conversation's state is loaded from MongoDB.
     * Called once at the start of a conversation to restore state
     * from a previous server lifecycle.
     */
    static async ensureLoaded(conversationId) {
        if (loadedConversations.has(conversationId))
            return;
        loadedConversations.add(conversationId);
        const mongoState = await loadFromMongo(conversationId);
        if (mongoState.size > 0) {
            const store = ToolContext.getStore(conversationId);
            // Merge MongoDB state with any in-memory state (memory wins on conflict)
            for (const [key, value] of mongoState) {
                if (!store.has(key)) {
                    store.set(key, value);
                }
            }
            logger.info(`[ToolContext] Restored ${mongoState.size} state entries from MongoDB for conversation ${conversationId}`);
        }
    }
    /** Get a single value from a conversation's state. */
    static get(conversationId, key) {
        return conversations.get(conversationId)?.get(key);
    }
    /** Set a single value in a conversation's state (write-through to MongoDB). */
    static set(conversationId, key, value) {
        const store = ToolContext.getStore(conversationId);
        store.set(key, value);
        // Async write-through — don't await to keep tool execution fast
        persistToMongo(conversationId, store).catch(() => { });
        try {
            const valStr = typeof value === "string" ? value : JSON.stringify(value ?? {});
            const hash = crypto.createHash("sha256").update(valStr).digest("hex").slice(0, 16);
            const span = new Span({
                trace_id: crypto.randomUUID().replaceAll("-", "").slice(0, 32),
                run_id: conversationId,
                name: `state_mutation:${key}`,
                kind: "checkpoint",
                attributes: {
                    key,
                    value_hash: hash,
                    mutation_type: "set",
                },
            });
            span.end("OK");
            TraceExporter.getGlobalInstance().enqueueSpan(span.toJSON());
        }
        catch {
            // non-blocking
        }
    }
    /** Delete a single key from a conversation's state. */
    static delete(conversationId, key) {
        const store = conversations.get(conversationId);
        if (!store)
            return false;
        const result = store.delete(key);
        if (result) {
            persistToMongo(conversationId, store).catch(() => { });
        }
        return result;
    }
    /** Check if a conversation has a specific key. */
    static has(conversationId, key) {
        return conversations.get(conversationId)?.has(key) ?? false;
    }
    /**
     * Clean up only the in-memory cache for a conversation.
     * Keeps MongoDB state intact so it can be restored on the next turn.
     */
    static cleanupInMemory(conversationId) {
        const store = conversations.get(conversationId);
        if (store) {
            const keyCount = store.size;
            conversations.delete(conversationId);
            loadedConversations.delete(conversationId);
            if (keyCount > 0) {
                logger.info(`[ToolContext] Cleaned up in-memory cache of ${keyCount} state entries for conversation ${conversationId}`);
            }
        }
    }
    /**
     * Clean up all state for a conversation.
     * Removes from both memory and MongoDB.
     * Called when the conversation explicitly ends or is deleted.
     */
    static cleanup(conversationId) {
        const store = conversations.get(conversationId);
        if (store) {
            const keyCount = store.size;
            conversations.delete(conversationId);
            loadedConversations.delete(conversationId);
            // Async cleanup from MongoDB
            const collection = getCollection();
            if (collection) {
                collection.deleteOne({ conversationId }).catch((error) => {
                    logger.warn(`[ToolContext] MongoDB cleanup failed for conversation ${conversationId}: ${getErrorMessage(error)}`);
                });
            }
            if (keyCount > 0) {
                logger.info(`[ToolContext] Cleaned up ${keyCount} state entries and deleted MongoDB document for conversation ${conversationId}`);
            }
        }
    }
    /** Get the number of active conversations with state (for diagnostics). */
    static get activeConversationCount() {
        return conversations.size;
    }
    /**
     * Get a snapshot of all state keys for a conversation (for diagnostics).
     * Returns an empty array if no state exists.
     */
    static keys(conversationId) {
        return Array.from(conversations.get(conversationId)?.keys() ?? []);
    }
}
//# sourceMappingURL=ToolContext.js.map