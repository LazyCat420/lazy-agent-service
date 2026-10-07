import { DEFAULT_CONVERSATION_TITLE } from "@rodrigo-barraza/utilities-library/taxonomy";
import MongoWrapper from "../../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../../config.js";
import { COLLECTIONS } from "../../constants.js";
import { discoverDescendantConversationIds } from "../../utils/ConversationDiscovery.js";
import { extractFiles, computeModalities, extractProviders, computeTotalCost, } from "./utils.js";
const DEFAULT_COLLECTION = COLLECTIONS.MODEL_CONVERSATIONS;
/**
 * ConversationService — shared logic for managing conversations in MongoDB.
 * Used by both the conversations REST API and generation routes.
 */
const ConversationService = {
    /**
     * Append messages to a conversation, auto-creating it if it doesn't exist.
     * Handles file extraction (MinIO upload) and recomputes derived fields.
     * Optionally applies conversation metadata (title, systemPrompt, settings).
     */
    async appendMessages(conversationId, project, username, newMessages, conversationMeta = null, { collection = DEFAULT_COLLECTION } = {}) {
        const traceId = conversationMeta?.traceId || null;
        const dbCollection = MongoWrapper.getCollection(MONGO_DB_NAME, collection);
        // Extract files (upload base64 data to MinIO)
        const processedMessages = await extractFiles(newMessages, project, username);
        const now = new Date().toISOString();
        // Build $set fields for metadata
        const setFields = { updatedAt: now };
        if (traceId)
            setFields.traceId = traceId;
        if (conversationMeta) {
            if (conversationMeta.title !== undefined) {
                setFields.title = conversationMeta.title;
            }
            if (conversationMeta.systemPrompt !== undefined) {
                setFields.systemPrompt = conversationMeta.systemPrompt;
            }
            if (conversationMeta.settings !== undefined) {
                setFields.settings = {
                    ...conversationMeta.settings,
                    systemPrompt: conversationMeta.systemPrompt || "",
                };
            }
            if (conversationMeta.parentAgentConversationId) {
                setFields.parentAgentConversationId = conversationMeta.parentAgentConversationId;
            }
            if (conversationMeta.parentConversationId) {
                setFields.parentConversationId = conversationMeta.parentConversationId;
            }
            if (conversationMeta.workspaceRoot) {
                setFields.workspaceRoot = conversationMeta.workspaceRoot;
            }
        }
        // Build $setOnInsert for auto-creation of new conversations
        const metaSettings = conversationMeta?.settings || {};
        const metaSysPrompt = conversationMeta?.systemPrompt || "";
        const parentId = conversationMeta?.parentAgentConversationId || null;
        const parentConversationId = conversationMeta?.parentConversationId || null;
        const setOnInsertBase = {
            title: conversationMeta?.title || DEFAULT_CONVERSATION_TITLE,
            systemPrompt: metaSysPrompt,
            settings: {
                ...metaSettings,
                systemPrompt: metaSysPrompt,
            },
            modalities: computeModalities([]),
            providers: extractProviders([], metaSettings),
            totalCost: 0,
            isGenerating: true,
            ...(conversationMeta?.synthetic && { synthetic: true }),
            ...(traceId && { traceId }),
            ...(parentId && { parentAgentConversationId: parentId }),
            ...(parentConversationId && { parentConversationId }),
            ...(conversationMeta?.workspaceRoot && {
                workspaceRoot: conversationMeta.workspaceRoot,
            }),
            ...(conversationMeta?.agent && {
                agent: conversationMeta.agent,
            }),
            createdAt: now,
        };
        // MongoDB forbids the same field path in both $set and $setOnInsert —
        // strip any keys already present in $set to prevent MongoServerError:
        // "Updating the path 'X' would create a conflict at 'X'"
        const setOnInsert = { ...setOnInsertBase };
        for (const key of Object.keys(setFields)) {
            delete setOnInsert[key];
        }
        // 1. Atomic upsert: push messages + set metadata in a single operation
        await dbCollection.updateOne({ id: conversationId, project, username }, {
            $push: { messages: { $each: processedMessages } },
            $set: setFields,
            $setOnInsert: setOnInsert,
        }, { upsert: true });
        // 2. Single re-read to compute derived fields
        const conversation = await dbCollection.findOne({
            id: conversationId,
            project,
            username,
        });
        if (!conversation) {
            throw new Error(`Conversation not found: ${conversationId}`);
        }
        // 3. Recompute derived fields and persist
        const modelNamesSet = new Set();
        for (const model of conversation.messages || []) {
            if (model.deleted)
                continue;
            if (model.role === "assistant" && model.model) {
                modelNamesSet.add(model.model);
            }
        }
        if (modelNamesSet.size === 0 && conversation.settings?.model) {
            modelNamesSet.add(conversation.settings.model);
        }
        const derived = {
            modalities: computeModalities(conversation.messages),
            providers: extractProviders(conversation.messages, conversation.settings),
            totalCost: computeTotalCost(conversation.messages),
            modelNames: Array.from(modelNamesSet),
        };
        // Auto-derive a descriptive title from the first user message if the current title is missing or is 'New Conversation'
        if (!conversation.title ||
            conversation.title === DEFAULT_CONVERSATION_TITLE) {
            const firstUserMessage = conversation.messages?.find((chatMessage) => chatMessage.role === "user");
            if (firstUserMessage?.content) {
                const titleSnippet = firstUserMessage.content.slice(0, 100).trim();
                if (titleSnippet) {
                    derived.title = titleSnippet;
                    conversation.title = titleSnippet; // Update local memory representation
                }
            }
        }
        await dbCollection.updateOne({ id: conversationId, project, username }, { $set: derived });
        // Return the doc with derived fields merged (avoids a third read)
        return { ...conversation, ...derived };
    },
    /**
     * Set or clear the isGenerating flag on a conversation.
     * Lightweight update — only touches isGenerating + updatedAt.
     */
    async setGenerating(conversationId, project, username, generating, { collection = DEFAULT_COLLECTION, agent, title, agentConversationId, } = {}) {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return;
        const now = new Date().toISOString();
        if (generating) {
            // Upsert — create a stub if it doesn't exist yet
            await db.collection(collection).updateOne({ id: conversationId, project, username }, {
                $set: {
                    isGenerating: true,
                    updatedAt: now,
                    ...(agentConversationId && { agentConversationId }),
                },
                $setOnInsert: {
                    title: title || DEFAULT_CONVERSATION_TITLE,
                    messages: [],
                    systemPrompt: "",
                    settings: {},
                    modalities: computeModalities([]),
                    providers: [],
                    totalCost: 0,
                    ...(agent && { agent }),
                    createdAt: now,
                },
            }, { upsert: true });
        }
        else {
            await db
                .collection(collection)
                .updateOne({ id: conversationId, project, username }, { $set: { isGenerating: false, updatedAt: now } });
        }
    },
    async getConversationStats(conversationId, project, username) {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return null;
        // Recursively discover all descendant conversation IDs (multi-level sub-agents)
        const allConversationIds = await discoverDescendantConversationIds(db, conversationId, {
            project,
            username,
        });
        const requests = await db
            .collection(COLLECTIONS.REQUESTS)
            .find({
            agentConversationId: { $in: [...allConversationIds] },
            project,
            username,
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
            return null;
        }
        // Aggregate
        const providers = new Set();
        const models = new Set();
        const operations = new Set();
        let totalCost = 0;
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCacheReadInputTokens = 0;
        let totalCacheCreationInputTokens = 0;
        let totalReasoningOutputTokens = 0;
        const mergedModalities = {};
        const toolCounts = {};
        let requestErrorCount = 0;
        for (const request of requests) {
            totalCost += request.estimatedCost || 0;
            totalInputTokens += request.inputTokens || 0;
            totalOutputTokens += request.outputTokens || 0;
            totalCacheReadInputTokens += request.cacheReadInputTokens || 0;
            totalCacheCreationInputTokens += request.cacheCreationInputTokens || 0;
            totalReasoningOutputTokens += request.reasoningOutputTokens || 0;
            if (request.provider)
                providers.add(request.provider);
            if (request.model)
                models.add(request.model);
            if (request.operation)
                operations.add(request.operation);
            // Merge modalities
            if (request.modalities) {
                for (const [k, value] of Object.entries(request.modalities)) {
                    if (value)
                        mergedModalities[k] = true;
                }
            }
            // Count tool usage
            if (request.toolApiNames && request.toolApiNames.length > 0) {
                for (const name of request.toolApiNames) {
                    toolCounts[name] = (toolCounts[name] || 0) + 1;
                }
            }
            if (request.success === false) {
                requestErrorCount++;
            }
        }
        const subAgentRequestCount = requests.filter((reservation) => reservation.agentConversationId !== conversationId).length;
        const createdAt = requests.reduce((min, r) => !min || r.timestamp < min ? r.timestamp : min, null);
        const updatedAt = requests.reduce((max, r) => !max || r.timestamp > max ? r.timestamp : max, null);
        // Wall-clock elapsed time: from first request to last request (includes sub-agents)
        const totalElapsedTime = createdAt && updatedAt
            ? Math.max(0, (new Date(updatedAt).getTime() -
                new Date(createdAt).getTime()) /
                1000)
            : 0;
        return {
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
            requestErrorCount,
            totalElapsedTime,
            createdAt,
            updatedAt,
        };
    },
};
export default ConversationService;
//# sourceMappingURL=ConversationService.js.map