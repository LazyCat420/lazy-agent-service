import { roundMilliseconds } from "@rodrigo-barraza/utilities-library";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../config.js";
import logger from "../utils/logger.js";
import { getTotalInputTokens, estimateTokens, calculateTextCost, } from "../utils/CostCalculator.js";
import { computeModalities } from "./conversation/index.js";
import { COLLECTIONS } from "../constants.js";
import { TYPES, getPricing } from "../config.js";
import { calculateTokensPerSec } from "../utils/math.js";
import WebhookEventBus from "./WebhookEventBus.js";
const COLLECTION = COLLECTIONS.REQUESTS;
// Maps provider-native API tool/feature names to human-readable display names.
// These are NOT our custom tool names — they are keys from Anthropic/OpenAI/Google APIs.
const API_TO_CANONICAL = {
    googleSearch: "Google Search",
    googleSearchRetrieval: "Google Search",
    web_search: "Web Search",
    webSearch: "Web Search",
    webFetch: "Web Fetch",
    codeExecution: "Code Execution",
    code_execution: "Code Execution",
    computerUse: "Computer Use",
    computer_use: "Computer Use",
    fileSearch: "File Search",
    file_search: "File Search",
    urlContext: "URL Context",
    url_context: "URL Context",
    thinking: "Thinking",
    imageGeneration: "Image Generation",
    image_generation: "Image Generation",
};
import { getErrorMessage } from "../utils/ErrorHelpers.js";
function sanitizeMessage(message) {
    const sanitizeString = (s) => typeof s === "string" && s.startsWith("data:") ? `[base64 data]` : s;
    const sanitizeMedia = (value) => {
        if (Array.isArray(value))
            return value.map(sanitizeString);
        if (typeof value === "string")
            return sanitizeString(value);
        return value;
    };
    return {
        role: message.role,
        content: message.content,
        ...(message.images?.length
            ? { images: sanitizeMedia(message.images) }
            : {}),
        ...(message.audio?.length ? { audio: sanitizeMedia(message.audio) } : {}),
        ...(message.video?.length ? { video: sanitizeMedia(message.video) } : {}),
        ...(message.pdf?.length ? { pdf: sanitizeMedia(message.pdf) } : {}),
        ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
        ...(message.name ? { name: message.name } : {}),
    };
}
const RequestLogger = {
    async log({ requestId, endpoint, operation = null, project, username, clientIp = null, agent = null, harness = null, provider, model, conversationId = null, traceId = null, agentConversationId = null, parentAgentConversationId = null, toolsUsed = false, toolDisplayNames = [], toolApiNames = [], success, errorMessage = null, inputTokens = 0, outputTokens = 0, cacheReadInputTokens = 0, cacheCreationInputTokens = 0, reasoningOutputTokens = 0, estimatedCost = null, tokensPerSec = null, temperature = null, maxTokens = null, topP = null, topK = null, frequencyPenalty = null, presencePenalty = null, stopSequences = null, messageCount = 0, inputCharacters = 0, outputCharacters = 0, timeToGeneration = null, // seconds — time to first token (TTFT)
    generationTime = null, // seconds — token generation duration
    totalTime = null, // seconds — end-to-end request time
    requestPayload = null, responsePayload = null, modalities = null, rateLimits = null, contextLength = null, evalBatchSize = null, physicalBatchSize = null, }) {
        try {
            const db = MongoWrapper.getDb(MONGO_DB_NAME);
            if (!db) {
                logger.error("RequestLogger: MongoDB client not available");
                return;
            }
            const document = {
                requestId,
                timestamp: new Date().toISOString(),
                endpoint,
                operation: operation || null,
                project,
                username,
                clientIp,
                agent: agent || null,
                harness: harness || null,
                provider,
                model,
                conversationId,
                traceId,
                ...(agentConversationId && { agentConversationId }),
                ...(parentAgentConversationId && { parentAgentConversationId }),
                toolsUsed,
                toolDisplayNames,
                toolApiNames,
                success,
                errorMessage,
                inputTokens,
                outputTokens,
                ...(cacheReadInputTokens > 0 && { cacheReadInputTokens }),
                ...(cacheCreationInputTokens > 0 && { cacheCreationInputTokens }),
                ...(reasoningOutputTokens > 0 && { reasoningOutputTokens }),
                estimatedCost,
                tokensPerSec,
                temperature,
                maxTokens,
                topP,
                topK,
                frequencyPenalty,
                presencePenalty,
                stopSequences,
                messageCount,
                inputCharacters,
                outputCharacters,
                timeToGeneration,
                generationTime,
                totalTime,
                requestPayload,
                responsePayload,
                modalities,
                rateLimits,
                ...(contextLength != null && { contextLength }),
                ...(evalBatchSize != null && { evalBatchSize }),
                ...(physicalBatchSize != null && { physicalBatchSize }),
                status: "completed",
            };
            await db.collection(COLLECTION).insertOne(document);
            WebhookEventBus.emit("request.created", { ...document });
        }
        catch (error) {
            logger.error("RequestLogger: failed to save request", getErrorMessage(error));
        }
    },
    /**
     * High-level utility to format and log a chat-like generation.
     * Centralizes the formatting of request payloads, telemetry, and tokens.
     */
    async logChatGeneration({ requestId, endpoint = "chat", operation = null, project, username, clientIp = null, agent = null, harness = null, provider, model, conversationId = null, traceId = null, agentConversationId = null, parentAgentConversationId = null, success = true, errorMessage = null, 
    // Telemetry
    usage, estimatedCost = null, tokensPerSec = null, timeToGenerationSec = null, generationSec = null, totalSec = null, 
    // Inputs
    options = {}, messages = [], 
    // Outputs
    text = null, thinking = null, images = [], toolCalls = [], outputCharacters = 0, audioRef = null, 
    // Optional
    agenticIteration = null, rateLimits = null, }) {
        const inputTokens = usage
            ? getTotalInputTokens(usage)
            : 0;
        const outputTokens = usage ? usage.outputTokens || 0 : 0;
        const cacheReadInputTokens = usage?.cacheReadInputTokens || 0;
        const cacheCreationInputTokens = usage?.cacheCreationInputTokens || 0;
        const reasoningOutputTokens = usage?.reasoningOutputTokens || 0;
        // Build synthetic message array for computeModalities (same function used by conversations)
        const syntheticMessages = [
            ...messages,
            {
                role: "assistant",
                content: text || null,
                ...(images && images.length > 0 ? { images } : {}),
                ...(audioRef ? { audio: audioRef } : {}),
                ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
                ...(thinking ? { thinking } : {}),
            },
        ];
        const modalities = computeModalities(syntheticMessages);
        return this.log({
            requestId,
            endpoint,
            operation,
            project,
            username,
            clientIp,
            agent,
            harness: harness || options?.harness || null,
            provider,
            model,
            conversationId,
            traceId,
            agentConversationId,
            parentAgentConversationId,
            toolsUsed: toolCalls && toolCalls.length > 0,
            toolDisplayNames: toolCalls && toolCalls.length > 0
                ? [
                    ...new Set(toolCalls.map((toolCall) => API_TO_CANONICAL[toolCall.name] || toolCall.name)),
                ]
                : [],
            toolApiNames: toolCalls && toolCalls.length > 0
                ? [...new Set(toolCalls.map((toolCall) => toolCall.name))]
                : [],
            success,
            errorMessage,
            inputTokens: inputTokens,
            outputTokens: outputTokens,
            ...(Number(cacheReadInputTokens) > 0 && {
                cacheReadInputTokens: Number(cacheReadInputTokens),
            }),
            ...(Number(cacheCreationInputTokens) > 0 && {
                cacheCreationInputTokens: Number(cacheCreationInputTokens),
            }),
            ...(Number(reasoningOutputTokens) > 0 && {
                reasoningOutputTokens: Number(reasoningOutputTokens),
            }),
            estimatedCost,
            tokensPerSec,
            temperature: options?.temperature ?? null,
            maxTokens: options?.maxTokens ?? null,
            topP: options?.topP ?? null,
            topK: options?.topK ?? null,
            frequencyPenalty: options?.frequencyPenalty ?? null,
            presencePenalty: options?.presencePenalty ?? null,
            stopSequences: options?.stopSequences ?? null,
            messageCount: messages?.length ?? 0,
            inputCharacters: messages?.reduce((sum, message) => sum +
                (typeof message.content === "string" ? message.content.length : 0), 0) ?? 0,
            outputCharacters,
            timeToGeneration: timeToGenerationSec !== null
                ? roundMilliseconds(timeToGenerationSec)
                : null,
            generationTime: generationSec !== null ? roundMilliseconds(generationSec) : null,
            totalTime: totalSec !== null ? roundMilliseconds(totalSec) : null,
            requestPayload: {
                messages: messages?.map(sanitizeMessage) ?? [],
                ...(options?.tools
                    ? {
                        tools: options.tools.map((tool) => tool.name || tool.function?.name),
                    }
                    : {}),
                ...(agenticIteration !== null ? { agenticIteration } : {}),
            },
            responsePayload: {
                text: text || null,
                thinking: thinking || null,
                ...(images && images.length > 0 ? { images } : {}),
                toolCalls: toolCalls && toolCalls.length > 0
                    ? toolCalls.map((toolCall) => ({
                        name: API_TO_CANONICAL[toolCall.name] ||
                            toolCall.name,
                        id: toolCall.id,
                        args: toolCall.args,
                    }))
                    : null,
                ...(audioRef ? { audioRef } : {}),
                usage,
            },
            modalities,
            rateLimits,
            contextLength: options?._loadedContextLength ??
                options?.contextLength ??
                null,
            evalBatchSize: options?._loadedEvalBatchSize ??
                options?.eval_batch_size ??
                null,
            physicalBatchSize: options?._loadedPhysicalBatchSize ??
                options?.eval_batch_size ??
                null,
        });
    },
    /**
     * Log a background (non-streaming) LLM call with automatic cost estimation.
     * Centralises the identical pattern used by MemoryService, MemoryExtractor,
     * MemoryConsolidationService, and OrchestratorService for fire-and-forget
     * AI calls (extraction, consolidation, decomposition).
     *
     * Handles: estimateTokens, getPricing, calculateTextCost, calculateTokensPerSec,
     * roundMilliseconds, and calls this.log().
     */
    async logBackgroundLlmCall({ requestId, endpoint, operation, project, username, agent, provider: providerName, model, traceId, conversationId, agentConversationId, aiMessages, resultText, usage: apiUsage = null, success, errorMessage, requestStartMs, extraRequestPayload, extraResponsePayload, }) {
        const totalSec = (performance.now() - requestStartMs) / 1000;
        const inputText = aiMessages
            .map((message) => typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content))
            .join("\n");
        // Prefer real API-reported usage over the ~4 chars/token heuristic.
        // The heuristic remains as fallback for callers that don't pass usage.
        const inputTokens = apiUsage
            ? getTotalInputTokens(apiUsage)
            : estimateTokens(inputText);
        const outputTokens = apiUsage
            ? apiUsage.outputTokens || 0
            : resultText
                ? estimateTokens(resultText)
                : 0;
        const cacheReadInputTokens = apiUsage?.cacheReadInputTokens || 0;
        const cacheCreationInputTokens = apiUsage?.cacheCreationInputTokens || 0;
        const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[model];
        let estimatedCost = null;
        if (pricing) {
            estimatedCost = calculateTextCost((apiUsage || { inputTokens, outputTokens }), pricing);
        }
        return this.log({
            requestId,
            endpoint: endpoint || null,
            operation,
            project,
            username: username || "system",
            clientIp: null,
            agent: agent || null,
            traceId: traceId || null,
            conversationId: conversationId || null,
            agentConversationId: agentConversationId || null,
            provider: providerName,
            model,
            success,
            errorMessage,
            estimatedCost,
            inputTokens: inputTokens,
            outputTokens: outputTokens,
            ...(Number(cacheReadInputTokens) > 0 && {
                cacheReadInputTokens: Number(cacheReadInputTokens),
            }),
            ...(Number(cacheCreationInputTokens) > 0 && {
                cacheCreationInputTokens: Number(cacheCreationInputTokens),
            }),
            tokensPerSec: calculateTokensPerSec(outputTokens, totalSec),
            inputCharacters: inputText.length,
            totalTime: roundMilliseconds(totalSec),
            modalities: { textIn: true, textOut: true },
            requestPayload: {
                operation,
                messages: aiMessages?.map(sanitizeMessage) ?? [],
                ...extraRequestPayload,
            },
            responsePayload: success
                ? {
                    textPreview: (resultText || "").slice(0, 200),
                    ...extraResponsePayload,
                }
                : { error: errorMessage },
        });
    },
    // Insert a minimal "pending" request skeleton into MongoDB immediately
    // when an agentic iteration starts. This triggers a Change Stream insert
    // event so the graph view can spawn the node before the LLM responds.
    //
    // Returns the inserted MongoDB `_id` for later completion via completePending().
    async insertPending({ requestId, endpoint = null, operation = null, project = null, username = null, clientIp = null, agent = null, harness = null, provider = null, model = null, conversationId = null, traceId = null, agentConversationId = null, parentAgentConversationId = null, agenticIteration = null, }) {
        try {
            const db = MongoWrapper.getDb(MONGO_DB_NAME);
            if (!db) {
                logger.error("RequestLogger: MongoDB client not available (insertPending)");
                return null;
            }
            const pendingDocument = {
                requestId,
                timestamp: new Date().toISOString(),
                endpoint: endpoint || null,
                operation: operation || null,
                project: project || null,
                username: username || null,
                clientIp: clientIp || null,
                agent: agent || null,
                harness: harness || null,
                provider: provider || null,
                model: model || null,
                conversationId: conversationId || null,
                traceId: traceId || null,
                ...(agentConversationId && { agentConversationId }),
                ...(parentAgentConversationId && { parentAgentConversationId }),
                ...(agenticIteration !== null && { agenticIteration }),
                status: "pending",
                inputTokens: 0,
                outputTokens: 0,
                estimatedCost: null,
                success: null,
            };
            const insertResult = await db.collection(COLLECTION).insertOne(pendingDocument);
            return insertResult.insertedId;
        }
        catch (error) {
            logger.error("RequestLogger: failed to insert pending request", getErrorMessage(error));
            return null;
        }
    },
    // Update a previously inserted pending request document with full
    // telemetry, payload, and timing data. Sets status to "completed".
    //
    // If the pending document is not found (e.g. was cleaned up), falls
    // back to a standard full insert via log().
    async completePending(pendingDocumentId, fullPayload) {
        try {
            const db = MongoWrapper.getDb(MONGO_DB_NAME);
            if (!db) {
                logger.error("RequestLogger: MongoDB client not available (completePending)");
                return;
            }
            const { requestId, endpoint, operation, project, username, clientIp, agent, harness, provider, model, conversationId, traceId, agentConversationId, parentAgentConversationId, toolsUsed, toolDisplayNames, toolApiNames, success, errorMessage, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, reasoningOutputTokens, estimatedCost, tokensPerSec, temperature, maxTokens, topP, topK, frequencyPenalty, presencePenalty, stopSequences, messageCount, inputCharacters, outputCharacters, timeToGeneration, generationTime, totalTime, requestPayload, responsePayload, modalities, rateLimits, contextLength, evalBatchSize, physicalBatchSize, } = fullPayload;
            const updateFields = {
                status: "completed",
                requestId,
                endpoint,
                operation: operation || null,
                project,
                username,
                clientIp,
                agent: agent || null,
                harness: harness || null,
                provider,
                model,
                conversationId,
                traceId,
                toolsUsed,
                toolDisplayNames,
                toolApiNames,
                success,
                errorMessage,
                inputTokens,
                outputTokens,
                estimatedCost,
                tokensPerSec,
                temperature,
                maxTokens,
                topP,
                topK,
                frequencyPenalty,
                presencePenalty,
                stopSequences,
                messageCount,
                inputCharacters,
                outputCharacters,
                timeToGeneration,
                generationTime,
                totalTime,
                requestPayload,
                responsePayload,
                modalities,
                rateLimits,
            };
            if (agentConversationId)
                updateFields.agentConversationId = agentConversationId;
            if (parentAgentConversationId)
                updateFields.parentAgentConversationId = parentAgentConversationId;
            if (Number(cacheReadInputTokens) > 0)
                updateFields.cacheReadInputTokens = Number(cacheReadInputTokens);
            if (Number(cacheCreationInputTokens) > 0)
                updateFields.cacheCreationInputTokens = Number(cacheCreationInputTokens);
            if (Number(reasoningOutputTokens) > 0)
                updateFields.reasoningOutputTokens = Number(reasoningOutputTokens);
            if (contextLength != null)
                updateFields.contextLength = contextLength;
            if (evalBatchSize != null)
                updateFields.evalBatchSize = evalBatchSize;
            if (physicalBatchSize != null)
                updateFields.physicalBatchSize = physicalBatchSize;
            const updateResult = await db.collection(COLLECTION).updateOne({ _id: pendingDocumentId }, { $set: updateFields });
            if (updateResult.matchedCount === 0) {
                // Pending document was not found — fall back to standard insert
                logger.warn("RequestLogger: pending document not found, falling back to full insert");
                await this.log(fullPayload);
                return;
            }
            WebhookEventBus.emit("request.completed", { _id: pendingDocumentId, ...updateFields });
        }
        catch (error) {
            logger.error("RequestLogger: failed to complete pending request", getErrorMessage(error));
            // Best-effort fallback: try to insert the full document
            try {
                await this.log(fullPayload);
            }
            catch {
                // Already logged the error above
            }
        }
    },
};
export default RequestLogger;
//# sourceMappingURL=RequestLogger.js.map