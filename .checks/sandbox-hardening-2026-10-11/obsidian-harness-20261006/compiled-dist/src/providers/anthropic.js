import Anthropic from "@anthropic-ai/sdk";
import { ProviderError } from "../utils/errors.js";
import logger from "../utils/logger.js";
import { extractAnthropicRateLimits } from "../utils/rateLimits.js";
import { compressImageForSizeLimit } from "../utils/media.js";
import { EMPTY_USAGE } from "../utils/openai-compat.js";
import { ANTHROPIC_API_KEY } from "../../config.js";
import { TYPES, getDefaultModels, getModelByName } from "../config.js";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../constants/TokenBudgetDefaults.js";
import { sleep } from "@rodrigo-barraza/utilities-library";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
// Default budget tokens mapped from effort level (for non-adaptive models)
const EFFORT_BUDGET_MAP = {
    low: 1024,
    medium: 4096,
    high: 50000,
    xhigh: 100000,
    max: 128000,
};
// Retry config for transient Anthropic errors (overloaded, rate limit)
const RETRY_DELAY_MS = 10_000;
const MAX_RETRIES = 3;
function isRetryableError(error) {
    const errorObject = error;
    const errorType = errorObject?.error?.type || errorObject?.type;
    if (errorType === "overloaded_error")
        return true;
    if (errorObject.status === 529)
        return true;
    return false;
}
let client = null;
function getClient() {
    if (!client) {
        if (!ANTHROPIC_API_KEY) {
            throw new ProviderError("anthropic", "ANTHROPIC_API_KEY is not set", 401);
        }
        client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    }
    return client;
}
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/**
 * Walk all Anthropic-format message content blocks and compress any
 * base64 image that exceeds 5 MB. Mutates the messages array in-place.
 */
async function enforceImageSizeLimits(messages) {
    for (const message of messages) {
        if (!Array.isArray(message.content))
            continue;
        for (const block of message.content) {
            if (block.type !== "image" || block.source?.type !== "base64")
                continue;
            const data = block.source.data;
            if (!data)
                continue;
            // Enforce byte-size limit
            const size = data.length; // Anthropic checks base64 STRING length
            if (size <= MAX_IMAGE_BYTES)
                continue;
            logger.warn(`[anthropic] SAFETY NET: image still ${(size / 1024 / 1024).toFixed(2)} MB after prepareMessages. Compressing now...`);
            const result = await compressImageForSizeLimit(data, block.source.media_type || "image/png");
            block.source.data = result.data;
            block.source.media_type = result.mediaType;
            const newSize = result.data.length;
            logger.info(`[anthropic] SAFETY NET compressed: ${(size / 1024 / 1024).toFixed(2)} → ${(newSize / 1024 / 1024).toFixed(2)} MB`);
        }
    }
}
/**
 * Anthropic requires alternating user/assistant roles and handles system messages separately.
 * This helper extracts the system message and merges consecutive same-role messages.
 */
async function prepareMessages(messages) {
    let systemMessage;
    // Extract system message
    const conversation = messages.map((chatMessage) => ({
        ...chatMessage,
    }));
    if (conversation.length > 0 && conversation[0].role === "system") {
        systemMessage = conversation.shift()?.content;
    }
    // Build clean messages with ONLY the fields Anthropic's API accepts.
    // Whitelist approach: explicitly construct each output object instead of
    // destructuring + ...rest, which leaks any new internal fields (e.g.
    // _ttftSamples, _liveGenProgress, _workerTokens) into the API payload.
    //
    // Mid-conversation system messages (e.g. dynamic tool updates) are
    // converted to user role with XML scaffolding. Anthropic Opus 4.8+
    // natively supports role: "system" mid-conversation, but converting
    // to user ensures compatibility across all Claude model versions.
    const cleaned = await Promise.all(conversation
        .filter((chatMessage) => chatMessage.role === "user" ||
        chatMessage.role === "assistant" ||
        chatMessage.role === "tool" ||
        chatMessage.role === "system")
        .map(async (message) => {
        // Convert tool role messages to tool_result user messages for Anthropic
        if (message.role === "tool") {
            return {
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: message.tool_call_id ||
                            message.id ||
                            message.name ||
                            "unknown",
                        content: typeof message.content === "string"
                            ? message.content
                            : JSON.stringify(message.content),
                    },
                ],
            };
        }
        // Mid-conversation system messages (e.g. dynamic tool updates from
        // the harness) — convert to user role for Anthropic API compatibility.
        // The harness wraps these in <tool-update> XML tags, so the model
        // can distinguish them from actual user messages.
        if (message.role === "system") {
            return {
                role: "user",
                content: typeof message.content === "string"
                    ? message.content
                    : JSON.stringify(message.content),
            };
        }
        // Convert assistant messages with toolCalls to multi-part content
        if (message.role === "assistant" &&
            message.toolCalls &&
            message.toolCalls.length > 0) {
            const contentBlocks = [];
            // Preserve thinking blocks for multi-step reasoning continuity.
            // The signature field is REQUIRED by Anthropic's API for multi-turn
            // conversations — without it the API returns a 400.
            // Only include thinking when we have the signature; conversations
            // missing it must omit the block to avoid API 400 errors.
            if (message.thinking && message.thinkingSignature) {
                contentBlocks.push({
                    type: "thinking",
                    thinking: message.thinking,
                    signature: message.thinkingSignature,
                });
            }
            if (typeof message.content === "string" && message.content.trim()) {
                contentBlocks.push({ type: "text", text: message.content });
            }
            for (const toolCall of message.toolCalls) {
                contentBlocks.push({
                    type: "tool_use",
                    id: toolCall.id || toolCall.name || `toolCall-${Date.now()}`,
                    name: toolCall.name,
                    input: toolCall.args || {},
                });
            }
            return {
                role: "assistant",
                content: contentBlocks,
            };
        }
        // Convert messages with media to Anthropic content block format
        const images = message.images;
        if (images && images.length > 0) {
            const contentBlocks = [];
            for (const dataUrl of images) {
                const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
                if (!match)
                    continue;
                const mimeType = match[1];
                let data = match[2];
                if (mimeType.startsWith("image/")) {
                    // Image content block
                    let mediaType = mimeType;
                    if (data.startsWith("/9j/"))
                        mediaType = "image/jpeg";
                    else if (data.startsWith("iVBOR"))
                        mediaType = "image/png";
                    else if (data.startsWith("R0lG"))
                        mediaType = "image/gif";
                    else if (data.startsWith("UklG"))
                        mediaType = "image/webp";
                    // Enforce Anthropic's 5 MB per-image limit
                    logger.info(`[anthropic] Image block: ${mediaType}, b64_len=${data.length} (${(data.length / 1024 / 1024).toFixed(2)} MB), decoded=${(Buffer.byteLength(data, "base64") / 1024 / 1024).toFixed(2)} MB`);
                    const compressed = await compressImageForSizeLimit(data, mediaType);
                    data = compressed.data;
                    mediaType = compressed.mediaType;
                    contentBlocks.push({
                        type: "image",
                        source: {
                            type: "base64",
                            media_type: mediaType,
                            data,
                        },
                    });
                }
                else if (mimeType === "application/pdf") {
                    // PDF document content block
                    contentBlocks.push({
                        type: "document",
                        source: {
                            type: "base64",
                            media_type: "application/pdf",
                            data,
                        },
                    });
                }
                else if (mimeType.startsWith("text/") ||
                    mimeType === "application/json") {
                    // Text-based files — decode and inline as text
                    try {
                        const decoded = Buffer.from(data, "base64").toString("utf-8");
                        contentBlocks.push({
                            type: "text",
                            text: `[Attached file (${mimeType})]:\n${decoded}`,
                        });
                    }
                    catch {
                        // Skip if decoding fails
                    }
                }
                // Other MIME types (audio, video) are not supported by Anthropic — skip
            }
            const textContent = typeof message.content === "string" ? message.content : "";
            if (textContent) {
                contentBlocks.push({ type: "text", text: textContent });
            }
            return {
                role: message.role,
                content: contentBlocks.length > 0 ? contentBlocks : message.content,
            };
        }
        // Handle assistant messages that have thinking but no toolCalls.
        // Anthropic requires thinking blocks as structured content blocks,
        // not top-level fields — convert them into the proper format.
        // Only include thinking when we have the signature; conversations
        // without it must omit the block to avoid API 400 errors.
        if (message.role === "assistant" &&
            message.thinking &&
            !message.toolCalls?.length) {
            const contentBlocks = [];
            if (message.thinkingSignature) {
                contentBlocks.push({
                    type: "thinking",
                    thinking: message.thinking,
                    signature: message.thinkingSignature,
                });
            }
            if (typeof message.content === "string" && message.content.trim()) {
                contentBlocks.push({ type: "text", text: message.content });
            }
            else {
                contentBlocks.push({ type: "text", text: " " });
            }
            return {
                role: "assistant",
                content: contentBlocks.length > 1
                    ? contentBlocks
                    : (typeof message.content === "string"
                        ? message.content.trim()
                        : "") || " ",
            };
        }
        // Ensure assistant messages never have empty content
        if (message.role === "assistant" &&
            (!message.content ||
                (typeof message.content === "string" && !message.content.trim()))) {
            return { role: "assistant", content: " " };
        }
        // Default: user or assistant with plain text — whitelist only role + content
        return { role: message.role, content: message.content || " " };
    }));
    // Merge consecutive same-role messages
    const merged = cleaned.reduce((acc, current) => {
        if (acc.length && acc[acc.length - 1].role === current.role) {
            const previous = acc[acc.length - 1];
            // Handle merging when content might be string or array
            if (typeof previous.content === "string" &&
                typeof current.content === "string") {
                previous.content += `\n\n${current.content}`;
            }
            else {
                // Convert both to arrays and concat
                const previousBlocks = typeof previous.content === "string"
                    ? [{ type: "text", text: previous.content }]
                    : previous.content || [];
                const currentBlocks = typeof current.content === "string"
                    ? [{ type: "text", text: current.content }]
                    : current.content || [];
                previous.content = [...previousBlocks, ...currentBlocks];
            }
        }
        else {
            acc.push({ ...current });
        }
        return acc;
    }, []);
    // Deduplicate tool_result blocks within merged user messages.
    // Anthropic requires exactly one tool_result per tool_use_id.
    // The frontend may send both inline results (from assistant.toolCalls
    // expansion) and standalone tool-role messages with the same ID,
    // which after merging creates duplicate tool_result blocks.
    for (const message of merged) {
        if (message.role !== "user" || !Array.isArray(message.content))
            continue;
        const seenToolResultIds = new Set();
        message.content = message.content.filter((block) => {
            if (block.type !== "tool_result")
                return true;
            if (seenToolResultIds.has(block.tool_use_id))
                return false;
            seenToolResultIds.add(block.tool_use_id);
            return true;
        });
    }
    // Ensure conversation starts with a user message
    if (merged.length > 0 && merged[0].role === "assistant") {
        merged.shift();
    }
    // Strip orphaned tool_use blocks: if an assistant message has tool_use
    // content blocks but the next message is NOT a tool_result, remove them.
    // This handles stale conversation history loaded from the database.
    for (let i = 0; i < merged.length; i++) {
        const message = merged[i];
        if (message.role !== "assistant" || !Array.isArray(message.content))
            continue;
        const hasToolUse = message.content.some((b) => b.type === "tool_use");
        if (!hasToolUse)
            continue;
        const next = merged[i + 1];
        const nextHasToolResult = next?.role === "user" &&
            Array.isArray(next.content) &&
            next.content.some((b) => b.type === "tool_result");
        if (!nextHasToolResult) {
            // Strip tool_use blocks, keep only text
            message.content = message.content.filter((b) => b.type !== "tool_use");
            if (message.content.length === 0) {
                message.content = " ";
            }
        }
    }
    // Anthropic rejects requests where the final assistant message content ends
    // with trailing whitespace (400: "final assistant content cannot end with
    // trailing whitespace"). Sanitize all assistant text blocks to be safe.
    for (const message of merged) {
        if (message.role !== "assistant")
            continue;
        if (typeof message.content === "string") {
            message.content = message.content.trimEnd() || " ";
        }
        else if (Array.isArray(message.content)) {
            for (const block of message.content) {
                if (block.type === "text" && typeof block.text === "string") {
                    block.text = block.text.trimEnd() || " ";
                }
            }
        }
    }
    return { systemMessage, messages: merged };
}
function buildTools(options) {
    const tools = [];
    if (options.webSearch) {
        tools.push({
            type: "web_search_20260209",
            name: "web_search",
            max_uses: 5,
        });
    }
    if (options.webFetch) {
        tools.push({
            type: "web_fetch_20250910",
            name: "web_fetch",
            max_uses: 10,
        });
    }
    if (options.codeExecution) {
        tools.push({
            type: "code_execution_20250825",
            name: "code_execution",
        });
    }
    // Custom function calling tools
    if (options.tools && Array.isArray(options.tools)) {
        for (const tool of options.tools) {
            tools.push({
                name: tool.name,
                description: tool.description || "",
                input_schema: tool.parameters || { type: "object", properties: {} },
            });
        }
    }
    return tools.length > 0 ? tools : undefined;
}
function extractResponseContent(contentBlocks) {
    let text = "";
    let thinking = null;
    let thinkingSignature = null;
    const citations = [];
    const toolCalls = [];
    for (const block of contentBlocks || []) {
        if (block.type === "text") {
            text += block.text || "";
            // Collect inline citations from this text block
            if (block.citations) {
                for (const cite of block.citations) {
                    if (cite.type === "web_search_result_location") {
                        citations.push({
                            url: cite.url,
                            title: cite.title,
                            citedText: cite.cited_text,
                        });
                    }
                }
            }
        }
        else if (block.type === "thinking") {
            thinking = block.thinking;
            if (block.signature)
                thinkingSignature = block.signature;
        }
        else if (block.type === "tool_use") {
            toolCalls.push({
                id: block.id,
                name: block.name,
                args: block.input || {},
            });
        }
        // server_tool_use and *_tool_result blocks are informational — skip
    }
    return { text, thinking, thinkingSignature, citations, toolCalls };
}
function buildUsage(responseUsage) {
    return {
        inputTokens: responseUsage?.input_tokens ?? 0,
        outputTokens: responseUsage?.output_tokens ?? 0,
        cacheReadInputTokens: responseUsage?.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: responseUsage?.cache_creation_input_tokens ?? 0,
    };
}
const anthropicProvider = {
    name: "anthropic",
    async generateText(messages, model = getDefaultModels(TYPES.TEXT, TYPES.TEXT).anthropic, options = {}) {
        logger.provider("Anthropic", `generateText model=${model}`);
        const prepared = await prepareMessages(messages);
        const payload = {
            cache_control: { type: "ephemeral" },
            system: prepared.systemMessage,
            model,
            messages: prepared.messages,
            max_tokens: options.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS,
            temperature: options.temperature !== undefined
                ? Math.min(options.temperature, 1)
                : undefined,
            top_p: options.temperature === undefined && options.topP !== undefined
                ? options.topP
                : undefined,
            top_k: options.topK !== undefined ? options.topK : undefined,
            stop_sequences: options.stopSequences !== undefined ? options.stopSequences : undefined,
            ...(options.serviceTier && {
                service_tier: options.serviceTier === "standard"
                    ? "standard_only"
                    : options.serviceTier,
            }),
            ...(options.responseFormat === "json_object" && {
                output_config: {
                    format: {
                        type: "json_schema",
                        schema: { type: "object", additionalProperties: false },
                    },
                },
            }),
        };
        // Opus 4.7+ lock sampling parameters — API rejects non-default values
        const modelDefinition = getModelByName(model);
        const hasLockedSampling = modelDefinition?.lockedSampling ===
            true;
        if (hasLockedSampling) {
            delete payload.temperature;
            delete payload.top_p;
            delete payload.top_k;
        }
        const isAdaptiveThinking = modelDefinition?.adaptiveThinking ===
            true;
        if (isAdaptiveThinking) {
            delete payload.top_k;
        }
        // Server tools
        const tools = buildTools(options);
        if (tools)
            payload.tools = tools;
        // Adaptive thinking models (Fable 5, Mythos 5, Opus 4.7+): thinking is
        // inherent to the model — enable by default unless explicitly disabled.
        if (options.thinkingEnabled !== false && isAdaptiveThinking) {
            payload.thinking = { type: "adaptive" };
            if (options.reasoningEffort) {
                payload.output_config = {
                    ...(payload.output_config || {}),
                    effort: options.reasoningEffort,
                };
            }
            payload.temperature = 1;
            delete payload.top_p;
            delete payload.top_k;
        }
        else if (options.thinkingEnabled !== false &&
            (options.thinkingEnabled === true ||
                options.thinkingBudget ||
                options.reasoningEffort)) {
            // Legacy models (Opus 4.x, Sonnet 4.x): manual extended thinking with budget_tokens
            const budget = options.thinkingBudget
                ? parseInt(String(options.thinkingBudget))
                : (options.reasoningEffort
                    ? EFFORT_BUDGET_MAP[options.reasoningEffort]
                    : undefined) || EFFORT_BUDGET_MAP.high;
            payload.thinking = { type: "enabled", budget_tokens: budget };
            if (payload.max_tokens <= budget) {
                payload.max_tokens = budget + 1024;
            }
            // Anthropic requires temperature=1 and top_p/top_k unset when thinking is enabled
            payload.temperature = 1;
            delete payload.top_p;
            delete payload.top_k;
        }
        let lastError;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const { data: response, response: rawResponse } = await getClient()
                    .messages.create(payload)
                    .withResponse();
                const rateLimits = extractAnthropicRateLimits(rawResponse, model);
                const message = response;
                const { text, thinking, thinkingSignature, citations, toolCalls } = extractResponseContent(message.content);
                const result = {
                    text,
                    usage: buildUsage(message.usage),
                };
                if (thinking)
                    result.thinking = thinking;
                if (thinkingSignature)
                    result.thinkingSignature = thinkingSignature;
                if (citations.length > 0)
                    result.citations = citations;
                if (toolCalls.length > 0)
                    result.toolCalls = toolCalls;
                if (rateLimits)
                    result.rateLimits = rateLimits;
                // Forward structured stop details for observability (SDK 0.82+)
                if (message.stop_reason)
                    result.stopReason = message.stop_reason;
                if ("stop_details" in message && message.stop_details)
                    result.stopDetails = { ...message.stop_details };
                return result;
            }
            catch (error) {
                lastError = error;
                if (isRetryableError(error) && attempt < MAX_RETRIES) {
                    logger.warn(`[anthropic] Overloaded on attempt ${attempt}/${MAX_RETRIES} for generateText model=${model}. Retrying in ${RETRY_DELAY_MS / 1000}s...`);
                    await sleep(RETRY_DELAY_MS);
                    continue;
                }
                throw new ProviderError("anthropic", getErrorMessage(error), error?.status || 500, error);
            }
        }
        // Should never reach here, but safety net
        throw new ProviderError("anthropic", lastError instanceof Error ? lastError.message : "Max retries exceeded", lastError?.status || 500, lastError);
    },
    async captionImage(images, prompt = "Describe this image.", model = getDefaultModels(TYPES.TEXT, TYPES.TEXT).anthropic, systemPrompt) {
        logger.provider("Anthropic", `captionImage model=${model}`);
        try {
            const contentBlocks = [];
            for (const imageUrlOrBase64 of images) {
                const match = imageUrlOrBase64.match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                    let mediaType = match[1];
                    let data = match[2];
                    // Auto-detect media type from data prefix
                    if (data.startsWith("/9j/"))
                        mediaType = "image/jpeg";
                    else if (data.startsWith("iVBOR"))
                        mediaType = "image/png";
                    else if (data.startsWith("R0lG"))
                        mediaType = "image/gif";
                    else if (data.startsWith("UklG"))
                        mediaType = "image/webp";
                    // Enforce Anthropic's 5 MB per-image limit
                    const compressed = await compressImageForSizeLimit(data, mediaType);
                    data = compressed.data;
                    mediaType = compressed.mediaType;
                    contentBlocks.push({
                        type: "image",
                        source: {
                            type: "base64",
                            media_type: mediaType,
                            data,
                        },
                    });
                }
                else if (imageUrlOrBase64.startsWith("http")) {
                    // URL-based image
                    contentBlocks.push({
                        type: "image",
                        source: {
                            type: "url",
                            url: imageUrlOrBase64,
                        },
                    });
                }
            }
            contentBlocks.push({ type: "text", text: prompt });
            const payload = {
                model,
                messages: [{ role: "user", content: contentBlocks }],
                max_tokens: 1000,
            };
            if (systemPrompt) {
                payload.system = systemPrompt;
            }
            const response = (await getClient().messages.create(payload));
            const { text } = extractResponseContent(response.content);
            return {
                text,
                usage: buildUsage(response.usage),
            };
        }
        catch (error) {
            throw new ProviderError("anthropic", getErrorMessage(error), error?.status || 500, error);
        }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *generateTextStream(messages, model = getDefaultModels(TYPES.TEXT, TYPES.TEXT).anthropic, options = {}) {
        logger.provider("Anthropic", `generateTextStream model=${model}`);
        try {
            const prepared = await prepareMessages(messages);
            const streamPayload = {
                cache_control: { type: "ephemeral" },
                system: prepared.systemMessage,
                model,
                messages: prepared.messages,
                max_tokens: options.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS,
                temperature: options.temperature !== undefined
                    ? Math.min(options.temperature, 1)
                    : undefined,
                top_p: options.temperature === undefined && options.topP !== undefined
                    ? options.topP
                    : undefined,
                top_k: options.topK !== undefined ? options.topK : undefined,
                stop_sequences: options.stopSequences !== undefined
                    ? options.stopSequences
                    : undefined,
                ...(options.serviceTier && {
                    service_tier: options.serviceTier === "standard"
                        ? "standard_only"
                        : options.serviceTier,
                }),
                ...(options.responseFormat === "json_object" && {
                    output_config: {
                        format: {
                            type: "json_schema",
                            schema: { type: "object", additionalProperties: false },
                        },
                    },
                }),
            };
            // Opus 4.7+ lock sampling parameters — API rejects non-default values
            const modelDefinition = getModelByName(model);
            const hasLockedSampling = modelDefinition?.lockedSampling ===
                true;
            if (hasLockedSampling) {
                delete streamPayload.temperature;
                delete streamPayload.top_p;
                delete streamPayload.top_k;
            }
            const isAdaptiveThinking = modelDefinition
                ?.adaptiveThinking === true;
            if (isAdaptiveThinking) {
                delete streamPayload.top_k;
            }
            // Server tools
            const tools = buildTools(options);
            if (tools)
                streamPayload.tools = tools;
            // Adaptive thinking models (Fable 5, Mythos 5, Opus 4.7+): thinking is
            // inherent to the model — enable by default unless explicitly disabled.
            if (options.thinkingEnabled !== false && isAdaptiveThinking) {
                streamPayload.thinking = { type: "adaptive" };
                if (options.reasoningEffort) {
                    streamPayload.output_config = {
                        ...(streamPayload.output_config || {}),
                        effort: options.reasoningEffort,
                    };
                }
                streamPayload.temperature = 1;
                delete streamPayload.top_p;
                delete streamPayload.top_k;
            }
            else if (options.thinkingEnabled !== false &&
                (options.thinkingEnabled === true ||
                    options.thinkingBudget ||
                    options.reasoningEffort)) {
                // Legacy models (Opus 4.x, Sonnet 4.x): manual extended thinking with budget_tokens
                const budget = options.thinkingBudget
                    ? parseInt(String(options.thinkingBudget))
                    : (options.reasoningEffort
                        ? EFFORT_BUDGET_MAP[options.reasoningEffort]
                        : undefined) || EFFORT_BUDGET_MAP.high;
                streamPayload.thinking = { type: "enabled", budget_tokens: budget };
                if (streamPayload.max_tokens <= budget) {
                    streamPayload.max_tokens = budget + 1024;
                }
                // Anthropic requires temperature=1 and top_p/top_k unset when thinking is enabled
                streamPayload.temperature = 1;
                delete streamPayload.top_p;
                delete streamPayload.top_k;
            }
            await enforceImageSizeLimits(streamPayload.messages);
            const stream = getClient().messages.stream(streamPayload, {
                ...(options.signal && { signal: options.signal }),
            });
            // Track current content block type for server tool response processing
            let currentBlockType = null;
            let currentBlockName = null;
            let currentToolUseId = null;
            let codeInput = "";
            let usage = null;
            let messageStartUsage = null;
            let rateLimits = null;
            for await (const chunk of stream) {
                if (options.signal?.aborted) {
                    stream.abort();
                    break;
                }
                // Capture input token counts from message_start (sent once at stream start).
                // Anthropic sends input_tokens, cache_read_input_tokens, and
                // cache_creation_input_tokens here — message_delta only has output_tokens.
                if (chunk.type === "message_start" && chunk.message?.usage) {
                    messageStartUsage = chunk.message.usage;
                    // Capture rate-limit headers from the stream's initial response
                    if (!rateLimits && stream.response) {
                        rateLimits = extractAnthropicRateLimits(stream.response, model);
                    }
                    continue;
                }
                // Content block start — track what kind of block we're in
                if (chunk.type === "content_block_start") {
                    const block = chunk.content_block;
                    currentBlockType = block?.type || null;
                    currentBlockName = ("name" in block ? block.name : null);
                    currentToolUseId = ("id" in block ? block.id : null);
                    codeInput = "";
                    // Server tool use start — yield the tool name being invoked
                    if (block?.type === "server_tool_use" &&
                        "name" in block &&
                        block.name === "code_execution") {
                        // Code execution starting — we'll accumulate the input
                    }
                    // Custom tool_use start — emit early disclosure before argument streaming
                    if (block?.type === "tool_use" &&
                        currentBlockName &&
                        currentToolUseId) {
                        yield {
                            type: "toolCallStart",
                            id: currentToolUseId,
                            name: currentBlockName,
                        };
                    }
                    // Code execution tool result
                    if (block?.type === "code_execution_tool_result") {
                        const result = block.content;
                        if (result) {
                            yield {
                                type: "codeExecutionResult",
                                output: result.stdout || result.stderr || "",
                                outcome: result.return_code === 0 ? "OK" : "ERROR",
                            };
                        }
                    }
                    // Web search / web fetch tool result — extract citations
                    if (block?.type === "web_search_tool_result" ||
                        block?.type === "web_fetch_tool_result") {
                        const content = block.content;
                        if (Array.isArray(content)) {
                            const results = content
                                .filter((r) => r.type === "web_search_result" ||
                                r.type === "web_fetch_result")
                                .map((r) => ({
                                url: r.url,
                                title: r.title,
                                pageAge: r.page_age,
                            }));
                            if (results.length > 0) {
                                yield { type: "webSearchResult", results };
                            }
                        }
                    }
                    continue;
                }
                // Content block stop
                if (chunk.type === "content_block_stop") {
                    // Server code execution — yield code
                    if (currentBlockType === "server_tool_use" &&
                        currentBlockName === "code_execution" &&
                        codeInput) {
                        try {
                            const parsed = JSON.parse(codeInput);
                            if (parsed.code) {
                                yield {
                                    type: "executableCode",
                                    code: parsed.code,
                                    language: parsed.language || "bash",
                                };
                            }
                        }
                        catch {
                            // Not valid JSON, skip
                        }
                    }
                    // Custom tool_use block ended — emit toolCall
                    if (currentBlockType === "tool_use") {
                        let args = {};
                        if (codeInput) {
                            try {
                                args = JSON.parse(codeInput);
                            }
                            catch {
                                // Not valid JSON, use empty
                            }
                        }
                        yield {
                            type: "toolCall",
                            id: currentToolUseId,
                            name: currentBlockName,
                            args,
                        };
                    }
                    currentBlockType = null;
                    currentBlockName = null;
                    currentToolUseId = null;
                    codeInput = "";
                    continue;
                }
                // Content block deltas
                if (chunk.type === "content_block_delta") {
                    // Thinking delta
                    if (chunk.delta.type === "thinking_delta") {
                        yield { type: "thinking", content: chunk.delta.thinking };
                        continue;
                    }
                    // Signature delta — Anthropic sends the thinking block's cryptographic
                    // signature as a separate delta event. This MUST be captured and passed
                    // back verbatim in multi-turn conversations, otherwise the API rejects
                    // the request with a 400.
                    if (chunk.delta.type === "signature_delta") {
                        yield {
                            type: "thinking_signature",
                            signature: chunk.delta.signature,
                        };
                        continue;
                    }
                    // Text delta
                    if (chunk.delta.type === "text_delta") {
                        yield chunk.delta.text;
                        continue;
                    }
                    // Input JSON delta for server tool use or custom tool_use (accumulate)
                    if (chunk.delta.type === "input_json_delta" &&
                        (currentBlockType === "server_tool_use" ||
                            currentBlockType === "tool_use")) {
                        const partial = chunk.delta.partial_json || "";
                        codeInput += partial;
                        // Yield progress event for tool_use blocks so generation
                        // throughput tracking stays alive during FC argument streaming.
                        if (currentBlockType === "tool_use" && partial.length > 0) {
                            yield { type: "toolCallDelta", characters: partial.length };
                        }
                        continue;
                    }
                }
                // Message delta (final usage + stop details) — carries output_tokens only
                if (chunk.type === "message_delta") {
                    if (chunk.usage) {
                        usage = {
                            inputTokens: messageStartUsage?.input_tokens ?? 0,
                            outputTokens: chunk.usage.output_tokens ?? 0,
                            cacheReadInputTokens: messageStartUsage?.cache_read_input_tokens ?? 0,
                            cacheCreationInputTokens: messageStartUsage?.cache_creation_input_tokens ?? 0,
                        };
                    }
                    // Forward structured stop details for observability (SDK 0.82+)
                    if (chunk.delta?.stop_reason) {
                        yield { type: "stopReason", stopReason: chunk.delta.stop_reason };
                    }
                    if (chunk.delta && "stop_details" in chunk.delta) {
                        yield {
                            type: "stopDetails",
                            stopDetails: chunk.delta.stop_details,
                        };
                    }
                }
            }
            // Get full usage from the finalized message
            try {
                const finalMessage = await stream.finalMessage();
                if (finalMessage?.usage) {
                    usage = buildUsage(finalMessage.usage);
                }
            }
            catch {
                // finalMessage() can throw for tool_use stop reasons — use message_delta usage
            }
            if (usage) {
                yield { type: "usage", usage };
            }
            else {
                yield { type: "usage", usage: EMPTY_USAGE };
            }
            if (rateLimits) {
                yield { type: "rateLimits", rateLimits };
            }
        }
        catch (error) {
            if (error instanceof Error && error.name === "AbortError")
                return;
            // For streaming, retry overloaded errors with the same delay/attempts policy
            if (isRetryableError(error)) {
                // Recursive retry with attempt tracking via options._retryAttempt
                const attempt = options._retryAttempt ?? 1;
                if (attempt < MAX_RETRIES) {
                    logger.warn(`[anthropic] Overloaded on attempt ${attempt}/${MAX_RETRIES} for generateTextStream model=${model}. Retrying in ${RETRY_DELAY_MS / 1000}s...`);
                    await sleep(RETRY_DELAY_MS);
                    yield* this.generateTextStream(messages, model, {
                        ...options,
                        _retryAttempt: attempt + 1,
                    });
                    return;
                }
            }
            throw new ProviderError("anthropic", getErrorMessage(error), error?.status || 500, error);
        }
    },
};
export default anthropicProvider;
//# sourceMappingURL=anthropic.js.map