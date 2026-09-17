import crypto from "node:crypto";
import logger from "../utils/logger.ts";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import { COLLECTIONS } from "../constants.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import { Span } from "../platform/trace/Span.ts";
import { TraceExporter } from "../platform/trace/TraceExporter.ts";

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
const conversations = new Map<string, Map<string, unknown>>();

/** Tracks which conversations have been loaded from MongoDB */
const loadedConversations = new Set<string>();

function getCollection() {
  return MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.TOOL_CONTEXT);
}

/** Persist the full state map to MongoDB (write-through). */
async function persistToMongo(
  conversationId: string,
  store: Map<string, unknown>,
): Promise<void> {
  try {
    const collection = getCollection();
    if (!collection) return;

    const state = Object.fromEntries(store);
    await collection.updateOne(
      { conversationId },
      {
        $set: {
          conversationId,
          state,
          updatedAt: new Date().toISOString(),
        },
      },
      { upsert: true },
    );
  } catch (error) {
    logger.warn(
      `[ToolContext] MongoDB persist failed for conversation ${conversationId}: ${getErrorMessage(error)}`,
    );
  }
}

/** Load state from MongoDB into memory (read-through, first access only). */
async function loadFromMongo(conversationId: string): Promise<Map<string, unknown>> {
  try {
    const collection = getCollection();
    if (!collection) return new Map();

    const doc = (await collection.findOne({ conversationId })) as {
      state?: Record<string, unknown>;
    } | null;
    if (doc?.state && typeof doc.state === "object") {
      return new Map(Object.entries(doc.state));
    }
  } catch (error) {
    logger.warn(
      `[ToolContext] MongoDB load failed for conversation ${conversationId}: ${getErrorMessage(error)}`,
    );
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
  static getStore(conversationId: string): Map<string, unknown> {
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
  static async ensureLoaded(conversationId: string): Promise<void> {
    if (loadedConversations.has(conversationId)) return;
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
      logger.info(
        `[ToolContext] Restored ${mongoState.size} state entries from MongoDB for conversation ${conversationId}`,
      );
    }
  }

  /** Get a single value from a conversation's state. */
  static get<T = unknown>(conversationId: string, key: string): T | undefined {
    return conversations.get(conversationId)?.get(key) as T | undefined;
  }

  /** Set a single value in a conversation's state (write-through to MongoDB). */
  static set(conversationId: string, key: string, value: unknown): void {
    const store = ToolContext.getStore(conversationId);
    store.set(key, value);
    // Async write-through — don't await to keep tool execution fast
    persistToMongo(conversationId, store).catch(() => {});

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
    } catch {
      // non-blocking
    }
  }

  /** Delete a single key from a conversation's state. */
  static delete(conversationId: string, key: string): boolean {
    const store = conversations.get(conversationId);
    if (!store) return false;
    const result = store.delete(key);
    if (result) {
      persistToMongo(conversationId, store).catch(() => {});
    }
    return result;
  }

  /** Check if a conversation has a specific key. */
  static has(conversationId: string, key: string): boolean {
    return conversations.get(conversationId)?.has(key) ?? false;
  }

  /**
   * Clean up only the in-memory cache for a conversation.
   * Keeps MongoDB state intact so it can be restored on the next turn.
   */
  static cleanupInMemory(conversationId: string): void {
    const store = conversations.get(conversationId);
    if (store) {
      const keyCount = store.size;
      conversations.delete(conversationId);
      loadedConversations.delete(conversationId);
      if (keyCount > 0) {
        logger.info(
          `[ToolContext] Cleaned up in-memory cache of ${keyCount} state entries for conversation ${conversationId}`,
        );
      }
    }
  }

  /**
   * Clean up all state for a conversation.
   * Removes from both memory and MongoDB.
   * Called when the conversation explicitly ends or is deleted.
   */
  static cleanup(conversationId: string): void {
    const store = conversations.get(conversationId);
    if (store) {
      const keyCount = store.size;
      conversations.delete(conversationId);
      loadedConversations.delete(conversationId);

      // Async cleanup from MongoDB
      const collection = getCollection();
      if (collection) {
        collection.deleteOne({ conversationId }).catch((error: unknown) => {
          logger.warn(
            `[ToolContext] MongoDB cleanup failed for conversation ${conversationId}: ${getErrorMessage(error)}`,
          );
        });
      }

      if (keyCount > 0) {
        logger.info(
          `[ToolContext] Cleaned up ${keyCount} state entries and deleted MongoDB document for conversation ${conversationId}`,
        );
      }
    }
  }

  /** Get the number of active conversations with state (for diagnostics). */
  static get activeConversationCount(): number {
    return conversations.size;
  }



  /**
   * Get a snapshot of all state keys for a conversation (for diagnostics).
   * Returns an empty array if no state exists.
   */
  static keys(conversationId: string): string[] {
    return Array.from(conversations.get(conversationId)?.keys() ?? []);
  }
}
