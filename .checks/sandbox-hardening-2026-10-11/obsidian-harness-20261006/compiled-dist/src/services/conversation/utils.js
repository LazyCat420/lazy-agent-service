import FileService from "../FileService.js";
import logger from "../../utils/logger.js";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { TOOL_NAMES } from "../ToolTaxonomyConstants.js";
import { FILE_CATEGORIES } from "../../constants.js";
/**
 * Upload any base64 data URLs in message images/audio to external storage.
 * Replaces inline data with minio:// refs when MinIO is available.
 */
export async function extractFiles(messages, project = null, username = null) {
    if (!messages || !FileService.isExternalStorage())
        return messages;
    const processed = [];
    for (const message of messages) {
        const updated = { ...message };
        // Handle images
        if (message.images && message.images.length > 0) {
            const category = message.role === "assistant"
                ? FILE_CATEGORIES.GENERATIONS
                : FILE_CATEGORIES.UPLOADS;
            const newImages = [];
            for (const rawImage of message.images) {
                if (typeof rawImage !== "string") {
                    newImages.push(String(rawImage));
                    continue;
                }
                const image = rawImage;
                if (image.startsWith("minio://") || image.startsWith("http")) {
                    newImages.push(image);
                    continue;
                }
                if (image.startsWith("data:")) {
                    try {
                        const { ref } = await FileService.uploadFile(image, category, project, username);
                        newImages.push(ref);
                    }
                    catch (error) {
                        logger.error(`Failed to upload file: ${errorMessage(error)}`);
                        newImages.push(image);
                    }
                }
                else {
                    newImages.push(image);
                }
            }
            updated.images = newImages;
        }
        // Handle audio data URLs
        if (updated.audio &&
            typeof updated.audio === "string" &&
            updated.audio.startsWith("data:")) {
            const category = updated.role === "assistant"
                ? FILE_CATEGORIES.GENERATIONS
                : FILE_CATEGORIES.UPLOADS;
            try {
                const { ref } = await FileService.uploadFile(updated.audio, category, project, username);
                updated.audio = ref;
            }
            catch (error) {
                logger.error(`Failed to upload audio: ${errorMessage(error)}`);
            }
        }
        processed.push(updated);
    }
    return processed;
}
/**
 * Compute input/output modalities from messages for lightweight querying.
 */
export function computeModalities(messages) {
    const modalities = {
        textIn: false,
        textOut: false,
        imageIn: false,
        imageOut: false,
        audioIn: false,
        audioOut: false,
        videoIn: false,
        docIn: false,
        webSearch: false,
        codeExecution: false,
        functionCalling: false,
        thinking: false,
    };
    const WEB_SEARCH_NAMES = new Set([
        TOOL_NAMES.SEARCH_WEB,
        TOOL_NAMES.SEARCH_WEB_PREVIEW,
    ]);
    const CODE_EXEC_NAMES = new Set([TOOL_NAMES.CODE_EXECUTION]);
    const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".webm"];
    for (const chatMessage of messages || []) {
        if (chatMessage.deleted)
            continue;
        const isUser = chatMessage.role === "user";
        const isAssistant = chatMessage.role === "assistant";
        if (chatMessage.content && (isUser || isAssistant)) {
            if (isUser && !chatMessage.liveTranscription)
                modalities.textIn = true;
            if (isAssistant)
                modalities.textOut = true;
        }
        // Tool calls are structured text output
        if (isAssistant &&
            chatMessage.toolCalls &&
            chatMessage.toolCalls.length > 0) {
            modalities.textOut = true;
        }
        // Classify each image reference as image, video, or document
        if (chatMessage.images && chatMessage.images.length > 0) {
            for (const imageReference of chatMessage.images) {
                if (typeof imageReference !== "string")
                    continue;
                const isDocumentReference = imageReference.startsWith("data:application/") ||
                    imageReference.startsWith("data:text/") ||
                    imageReference.endsWith(".pdf") ||
                    imageReference.endsWith(".txt");
                const isVideoReference = imageReference.startsWith("data:video/") ||
                    VIDEO_EXTENSIONS.some((extension) => imageReference.endsWith(extension));
                if (isDocumentReference) {
                    modalities.docIn = true;
                }
                else if (isVideoReference) {
                    if (isUser)
                        modalities.videoIn = true;
                }
                else {
                    if (isUser)
                        modalities.imageIn = true;
                    if (isAssistant)
                        modalities.imageOut = true;
                }
            }
        }
        // Standalone image field (not from images array)
        if (chatMessage.image &&
            !chatMessage.images?.length) {
            if (isUser)
                modalities.imageIn = true;
            if (isAssistant)
                modalities.imageOut = true;
        }
        if (chatMessage.audio) {
            if (isUser)
                modalities.audioIn = true;
            if (isAssistant)
                modalities.audioOut = true;
        }
        // Documents array (separate from image-based document detection)
        if (chatMessage.documents?.length) {
            modalities.docIn = true;
        }
        // Classify tool calls by type
        if (chatMessage.toolCalls && chatMessage.toolCalls.length > 0) {
            for (const toolCall of chatMessage.toolCalls) {
                const name = (toolCall.name || "").toLowerCase();
                if (WEB_SEARCH_NAMES.has(name)) {
                    modalities.webSearch = true;
                }
                else if (CODE_EXEC_NAMES.has(name)) {
                    modalities.codeExecution = true;
                }
                else {
                    modalities.functionCalling = true;
                }
            }
        }
        // Detect inline web search results (from streaming)
        if (isAssistant &&
            typeof chatMessage.content === "string" &&
            chatMessage.content.includes("> **Sources:**")) {
            modalities.webSearch = true;
        }
        // Detect inline code execution blocks (from streaming)
        if (isAssistant &&
            typeof chatMessage.content === "string" &&
            chatMessage.content.includes("```exec-")) {
            modalities.codeExecution = true;
        }
        // Tool result messages — mark as function calling
        // (provider-native web_search and code_execution results are inlined, not stored as role:"tool")
        if (chatMessage.role === "tool") {
            modalities.functionCalling = true;
        }
        // Detect thinking / reasoning
        if (isAssistant && chatMessage.thinking) {
            modalities.thinking = true;
        }
    }
    return modalities;
}
/**
 * Extract unique providers from messages and settings.
 */
export function extractProviders(messages, settings) {
    const providers = new Set();
    for (const chatMessage of messages || []) {
        if (chatMessage.deleted)
            continue;
        if (chatMessage.provider) {
            providers.add(chatMessage.provider.toLowerCase());
        }
    }
    if (settings?.provider)
        providers.add(settings.provider.toLowerCase());
    return [...providers];
}
/**
 * Compute total estimated cost across all messages.
 */
export function computeTotalCost(messages) {
    let total = 0;
    for (const chatMessage of messages || []) {
        if (chatMessage.deleted)
            continue;
        const cost = chatMessage.estimatedCost;
        if (typeof cost === "number")
            total += cost;
    }
    return total;
}
/**
 * Build the $set fields for a conversation/agent-session PATCH request.
 * Centralises the identical logic shared by conversations.js and agent-sessions.js.
 */
export function buildConversationPatchFields({ title, messages, systemPrompt, settings, }) {
    const setFields = {
        updatedAt: new Date().toISOString(),
    };
    if (title !== undefined)
        setFields.title = title;
    if (messages !== undefined) {
        setFields.messages = messages;
        setFields.modalities = computeModalities(messages);
        setFields.providers = extractProviders(messages, settings || null);
        setFields.totalCost = computeTotalCost(messages);
        const modelNamesSet = new Set();
        for (const message of messages || []) {
            if (message.deleted)
                continue;
            if (message.role === "assistant" && message.model) {
                modelNamesSet.add(message.model);
            }
        }
        if (modelNamesSet.size === 0 && settings?.model) {
            modelNamesSet.add(settings.model);
        }
        setFields.modelNames = Array.from(modelNamesSet);
    }
    if (systemPrompt !== undefined)
        setFields.systemPrompt = systemPrompt;
    if (settings !== undefined) {
        setFields.settings = { ...settings, systemPrompt: systemPrompt || "" };
    }
    return setFields;
}
/**
 * Enrich conversations list with authoritative totalCost from request logs.
 */
export function enrichConversationsWithRequestCosts(conversations, requestLogCosts) {
    if (conversations.length === 0)
        return;
    const costMap = new Map(requestLogCosts.map((costEntry) => [
        costEntry._id,
        {
            totalCost: costEntry.totalCost,
            requestErrorCount: costEntry.requestErrorCount || 0,
        },
    ]));
    for (const conversation of conversations) {
        const conversationId = conversation.id;
        const aggregated = costMap.get(conversationId);
        if (aggregated) {
            if (aggregated.totalCost > 0) {
                conversation.totalCost = Math.max(conversation.totalCost || 0, aggregated.totalCost);
            }
            if (aggregated.requestErrorCount > 0) {
                conversation.requestErrorCount = aggregated.requestErrorCount;
            }
        }
    }
}
/**
 * Enrich a single conversation's totalCost with request logs.
 */
export function enrichSingleConversationCost(conversation, requestLogAggregation) {
    if (requestLogAggregation.length > 0) {
        if (requestLogAggregation[0].totalCost > 0) {
            conversation.totalCost = Math.max(conversation.totalCost || 0, requestLogAggregation[0].totalCost);
        }
        if ((requestLogAggregation[0].requestErrorCount || 0) > 0) {
            conversation.requestErrorCount =
                requestLogAggregation[0].requestErrorCount;
        }
    }
}
//# sourceMappingURL=utils.js.map