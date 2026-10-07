import { GoogleGenAI, Modality, } from "@google/genai";
import crypto from "crypto";
import { Readable } from "stream";
import { ProviderError } from "../utils/errors.js";
import logger from "../utils/logger.js";
import { GOOGLE_CLOUD_GEMINI_API_KEY, GOOGLE_TTS_MODEL, GOOGLE_EMBEDDING_MODEL, } from "../../config.js";
import { TYPES, MODELS, DEFAULT_VOICES, getDefaultModels } from "../config.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
/** Safely extract HTTP status from Google GenAI error objects. */
function getErrorStatus(error) {
    if (error instanceof Error && "status" in error) {
        return error.status;
    }
    return 500;
}
let client = null;
function getClient() {
    if (!client) {
        if (!GOOGLE_CLOUD_GEMINI_API_KEY) {
            throw new ProviderError("google", "GOOGLE_CLOUD_GEMINI_API_KEY is not set", 401);
        }
        client = new GoogleGenAI({ apiKey: GOOGLE_CLOUD_GEMINI_API_KEY });
    }
    return client;
}
/**
 * Detect content safety block errors from the Google GenAI SDK.
 * These occur when Gemini refuses to generate content due to content policy.
 * Returns true for errors that should be handled gracefully (empty result)
 * rather than propagated as 500 server errors.
 */
function isSafetyBlockError(error) {
    const message = getErrorMessage(error).toLowerCase();
    return (message.includes("prohibited_content") ||
        message.includes("image_safety") ||
        message.includes("safety") ||
        message.includes("blocked") ||
        message.includes("content filter") ||
        message.includes("response was blocked"));
}
function addWavHeader(buffer, sampleRate = 24000, channelCount = 1) {
    const headerLength = 44;
    const dataLength = buffer.length;
    const fileSize = dataLength + headerLength - 8;
    const header = Buffer.alloc(headerLength);
    header.write("RIFF", 0);
    header.writeUInt32LE(fileSize, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channelCount, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channelCount * 2, 28);
    header.writeUInt16LE(channelCount * 2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataLength, 40);
    return Buffer.concat([header, buffer]);
}
/**
 * Recursively sanitize a JSON Schema object for Google's restricted format.
 * Gemini's functionDeclarations only support a subset of JSON Schema —
 * unsupported keywords like `const`, `$schema`, `$id`, `$ref`, `examples`,
 * `default`, `additionalProperties` etc. cause 400 INVALID_ARGUMENT errors.
 *
 * Strategy:
 *   - `const: "value"` → `enum: ["value"]` (semantically equivalent)
 *   - Other unsupported keys → stripped entirely
 */
const GOOGLE_UNSUPPORTED_KEYS = new Set([
    "$schema",
    "$id",
    "$ref",
    "examples",
    "default",
    "additionalProperties",
    "patternProperties",
    "if",
    "then",
    "else",
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "title",
]);
function sanitizeSchemaForGoogle(schema, isPropertyMap = false) {
    if (!schema || typeof schema !== "object")
        return schema;
    if (Array.isArray(schema))
        return schema.map((item) => sanitizeSchemaForGoogle(item, false));
    const source = schema;
    const cleaned = {};
    for (const [key, value] of Object.entries(source)) {
        // Convert `const` → single-value `enum`
        if (key === "const" && !isPropertyMap) {
            cleaned.enum = [value];
            continue;
        }
        // Strip unsupported schema keywords — but NOT when we're iterating
        // over a `properties` map, where keys are user-defined field names
        // (e.g. properties.title is a field called "title", not the JSON Schema title keyword)
        if (!isPropertyMap && GOOGLE_UNSUPPORTED_KEYS.has(key))
            continue;
        // When we hit a "properties" key, its children are a map of field names → schemas
        cleaned[key] = sanitizeSchemaForGoogle(value, key === "properties");
    }
    return cleaned;
}
/**
 * Convert generic tool schemas to Google's functionDeclarations format.
 * Input:  [{ name, description, parameters: { type, properties, required } }]
 * Output: [{ functionDeclarations: [...] }]
 */
export function convertToolsToGoogle(tools) {
    if (!tools || !Array.isArray(tools) || tools.length === 0)
        return null;
    return [
        {
            functionDeclarations: tools.map((tool) => ({
                name: tool.name,
                description: tool.description || "",
                parameters: sanitizeSchemaForGoogle(tool.parameters || {}),
            })),
        },
    ];
}
/**
 * Build a GoogleGenerateConfig from ProviderOptions.
 * Centralizes the repeated config-building pattern across generateText,
 * generateTextStream, and generateTextStreamLive.
 */
function buildGenerateConfig(options, modelDefinition) {
    const config = {};
    if (options.temperature !== undefined)
        config.temperature = options.temperature;
    if (options.topP !== undefined)
        config.topP = options.topP;
    if (options.topK !== undefined)
        config.topK = options.topK;
    if (options.presencePenalty !== undefined)
        config.presencePenalty = options.presencePenalty;
    if (options.frequencyPenalty !== undefined)
        config.frequencyPenalty = options.frequencyPenalty;
    if (options.stopSequences !== undefined)
        config.stopSequences = options.stopSequences;
    if (options.maxTokens !== undefined &&
        options.maxTokens !== null &&
        options.maxTokens > 0) {
        config.maxOutputTokens = options.maxTokens;
    }
    if (options.seed !== undefined)
        config.seed = parseInt(String(options.seed));
    if (options.responseMimeType)
        config.responseMimeType = options.responseMimeType;
    else if (options.responseFormat === "json_object")
        config.responseMimeType = "application/json";
    if (options.candidateCount !== undefined && options.candidateCount > 1)
        config.candidateCount = options.candidateCount;
    if (options.mediaResolution)
        config.mediaResolution = options.mediaResolution;
    if (options.responseLogprobs === true)
        config.responseLogprobs = true;
    if (options.logprobs && options.logprobs > 0)
        config.logprobs = options.logprobs;
    if (options.serviceTier && options.serviceTier !== "auto") {
        config.serviceTier = options.serviceTier;
    }
    // Thinking config
    const supportsThinking = modelDefinition?.thinking === true;
    if (supportsThinking) {
        if (options.thinkingEnabled === false) {
            // Explicitly disable thinking — omitting thinkingConfig would let the
            // model default to thinking, silently consuming the output token budget.
            config.thinkingConfig = { thinkingBudget: 0 };
        }
        else {
            config.thinkingConfig = { includeThoughts: true };
            if (options.thinkingBudget !== undefined &&
                options.thinkingBudget !== "") {
                config.thinkingConfig.thinkingBudget = parseInt(String(options.thinkingBudget));
            }
            else if (options.thinkingLevel && modelDefinition?.thinkingLevels) {
                config.thinkingConfig.thinkingLevel =
                    options.thinkingLevel;
            }
        }
    }
    // System prompt
    if (options.systemPrompt) {
        config.systemInstruction = options.systemPrompt;
    }
    return config;
}
async function convertMessages(messages) {
    const result = [];
    for (let i = 0; i < messages.length; i++) {
        const item = messages[i];
        const parts = [];
        // ── Consecutive tool result messages → single user turn ──
        // Gemini requires ALL functionResponse parts for a model turn
        // to be grouped in one user message.
        if (item.role === "tool") {
            const responseParts = [];
            let j = i;
            while (j < messages.length && messages[j].role === "tool") {
                const toolMessage = messages[j];
                responseParts.push({
                    functionResponse: {
                        name: toolMessage.name || "any",
                        response: {
                            result: typeof toolMessage.content === "string"
                                ? toolMessage.content
                                : JSON.stringify(toolMessage.content),
                        },
                    },
                });
                j++;
            }
            result.push({ role: "user", parts: responseParts });
            i = j - 1; // skip merged messages (loop will i++)
            continue;
        }
        // Only include media for user messages — model-generated media
        // require a thought_signature when sent back, so we skip them.
        if (item.role !== "assistant") {
            // All media fields are arrays of data URLs or HTTP URLs
            for (const field of ["images", "audio", "video", "pdf"]) {
                const array = item[field];
                if (array && Array.isArray(array)) {
                    for (const mediaRef of array) {
                        const match = mediaRef.match(/^data:([\w-]+\/[\w.+-]+);base64,(.+)$/);
                        if (match) {
                            parts.push({
                                inlineData: { mimeType: match[1], data: match[2] },
                            });
                        }
                        else if (mediaRef.startsWith("http://") ||
                            mediaRef.startsWith("https://")) {
                            // HTTP URLs — fetch and convert to inline base64
                            try {
                                const response = await fetch(mediaRef);
                                if (response.ok) {
                                    const arrayBuffer = await response.arrayBuffer();
                                    const base64Data = Buffer.from(arrayBuffer).toString("base64");
                                    const mimeType = response.headers.get("content-type") || "image/jpeg";
                                    parts.push({
                                        inlineData: { mimeType, data: base64Data },
                                    });
                                }
                            }
                            catch (fetchError) {
                                logger.warn(`[Google] Failed to fetch media URL for inline data: ${getErrorMessage(fetchError)}`);
                            }
                        }
                    }
                }
            }
        }
        // Assistant messages with tool calls — include functionCall parts
        if (item.role === "assistant" && item.toolCalls) {
            for (const toolCall of item.toolCalls) {
                const functionCallPart = {
                    functionCall: { name: toolCall.name, args: toolCall.args || {} },
                };
                // Preserve thoughtSignature (sibling of functionCall, required by Gemini)
                if (toolCall.thoughtSignature) {
                    functionCallPart.thoughtSignature = toolCall.thoughtSignature;
                }
                parts.push(functionCallPart);
            }
        }
        // Mid-conversation system messages (e.g. dynamic tool updates from the
        // harness) — Gemini does not support role: "system" mid-conversation,
        // so convert to "user" role. The harness already wraps these in
        // <tool-update> XML tags for semantic clarity.
        if (item.role === "system") {
            if (item.content) {
                result.push({
                    role: "user",
                    parts: [{ text: item.content }],
                });
            }
            continue;
        }
        if (item.content) {
            parts.push({ text: item.content });
        }
        result.push({
            role: item.role === "assistant" ? "model" : "user",
            parts,
        });
    }
    return result;
}
const googleProvider = {
    name: "google",
    async generateText(messages, model = getDefaultModels(TYPES.TEXT, TYPES.TEXT).google, options = {}) {
        logger.provider("Google", `generateText model=${model}`);
        try {
            const contents = await convertMessages(messages);
            const modelDefinition = Object.values(MODELS).find((modelDefinitionItem) => modelDefinitionItem.name === model);
            const config = buildGenerateConfig(options, modelDefinition);
            // Web search
            if (options.webSearch) {
                config.tools = [{ googleSearch: {} }];
            }
            // Custom function calling tools
            const customTools = convertToolsToGoogle(options.tools);
            if (customTools) {
                config.tools = [...(config.tools || []), ...customTools];
            }
            // For models that output images, set responseModalities explicitly.
            // These models REQUIRE ["TEXT", "IMAGE"] — ["TEXT"] alone returns 0 tokens.
            if (modelDefinition?.outputTypes &&
                modelDefinition.outputTypes.includes(TYPES.IMAGE)) {
                config.responseModalities = options.forceImageGeneration
                    ? ["IMAGE"]
                    : ["TEXT", "IMAGE"];
            }
            const response = await getClient().models.generateContent({
                model,
                contents,
                config,
            });
            const toolCalls = [];
            const textParts = [];
            const images = [];
            const maxImages = options.imageCount || 1;
            for (const part of response.candidates?.[0]?.content?.parts || []) {
                if (part.functionCall) {
                    toolCalls.push({
                        id: `google-toolCall-${crypto.randomUUID()}`,
                        name: part.functionCall.name || "any",
                        args: (part.functionCall.args || {}),
                        thoughtSignature: part
                            .thoughtSignature,
                    });
                }
                else if (part.text) {
                    textParts.push(part.text);
                }
                else if (part.inlineData && images.length < maxImages) {
                    images.push({
                        data: part.inlineData.data || "",
                        mimeType: part.inlineData.mimeType || "image/png",
                    });
                }
            }
            const result = {
                text: textParts.join("") || response.text || "",
                usage: {
                    inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
                    outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
                    ...(response.usageMetadata?.cachedContentTokenCount
                        ? {
                            cacheReadInputTokens: response.usageMetadata.cachedContentTokenCount,
                        }
                        : {}),
                },
            };
            if (toolCalls.length > 0)
                result.toolCalls = toolCalls;
            if (images.length > 0)
                result.images = images;
            return result;
        }
        catch (error) {
            // Content safety blocks (PROHIBITED_CONTENT, SAFETY, IMAGE_SAFETY)
            // should return an empty result, not a 500. This lets consumers
            // handle "no image generated" gracefully and preserves the conversation.
            if (isSafetyBlockError(error)) {
                logger.error(`[Google] Content safety block: ${getErrorMessage(error)}`);
                return {
                    text: "",
                    usage: { inputTokens: 0, outputTokens: 0 },
                    safetyBlock: true,
                };
            }
            throw new ProviderError("google", getErrorMessage(error), 500, error);
        }
    },
    async *generateTextStream(messages, model = getDefaultModels(TYPES.TEXT, TYPES.TEXT).google, options = {}) {
        logger.provider("Google", `generateTextStream model=${model}`);
        try {
            const contents = await convertMessages(messages);
            const modelDefinition = Object.values(MODELS).find((modelDefinitionItem) => modelDefinitionItem.name === model);
            const config = buildGenerateConfig(options, modelDefinition);
            // Build tools array based on enabled options
            const tools = [];
            if (options.webSearch)
                tools.push({ googleSearch: {} });
            if (options.codeExecution)
                tools.push({ codeExecution: {} });
            if (options.urlContext)
                tools.push({ urlContext: {} });
            // Custom function calling tools
            const customTools = convertToolsToGoogle(options.tools);
            if (customTools)
                tools.push(...customTools);
            if (tools.length > 0)
                config.tools = tools;
            // For models that output images, set responseModalities explicitly.
            if (modelDefinition?.outputTypes &&
                modelDefinition.outputTypes.includes(TYPES.IMAGE)) {
                config.responseModalities = options.forceImageGeneration
                    ? ["IMAGE"]
                    : ["TEXT", "IMAGE"];
            }
            const streamConfig = { ...config };
            if (options.signal) {
                streamConfig.httpOptions = { timeout: 0 };
            }
            const responseStream = await getClient().models.generateContentStream({
                model,
                contents,
                config: streamConfig,
            });
            let usage = null;
            const maxImages = options.imageCount || 1;
            let imageCount = 0;
            let lastFinishReason = null;
            for await (const chunk of responseStream) {
                if (options.signal?.aborted)
                    break;
                // Track finishReason for truncation detection
                const candidateFinishReason = chunk.candidates?.[0]?.finishReason;
                if (candidateFinishReason)
                    lastFinishReason = candidateFinishReason;
                // Process all parts in the chunk
                if (chunk.candidates?.[0]?.content?.parts) {
                    for (const part of chunk.candidates[0].content.parts) {
                        if (part.functionCall) {
                            yield {
                                type: "toolCall",
                                id: `google-toolCall-${crypto.randomUUID()}`,
                                name: part.functionCall.name || "any",
                                args: (part.functionCall.args || {}),
                                thoughtSignature: part
                                    .thoughtSignature,
                            };
                        }
                        else if (part.thought && part.text) {
                            yield { type: "thinking", content: part.text };
                        }
                        else if (part.text) {
                            yield part.text;
                        }
                        else if (part.inlineData && imageCount < maxImages) {
                            imageCount++;
                            yield {
                                type: "image",
                                data: part.inlineData.data || "",
                                mimeType: part.inlineData.mimeType || "image/png",
                            };
                        }
                        else if (part.executableCode?.code) {
                            yield {
                                type: "executableCode",
                                code: part.executableCode.code,
                                language: part.executableCode.language || "python",
                            };
                        }
                        else if (part.codeExecutionResult) {
                            yield {
                                type: "codeExecutionResult",
                                output: part.codeExecutionResult.output || "",
                                outcome: part.codeExecutionResult.outcome || "OK",
                            };
                        }
                    }
                }
                else if (chunk.text) {
                    yield chunk.text;
                }
                if (chunk.usageMetadata) {
                    usage = {
                        inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
                        outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
                        ...(chunk.usageMetadata.cachedContentTokenCount
                            ? {
                                cacheReadInputTokens: chunk.usageMetadata.cachedContentTokenCount,
                            }
                            : {}),
                    };
                }
            }
            // Surface max_tokens truncation so harnesses can detect and warn the user
            if (lastFinishReason === "MAX_TOKENS") {
                yield { type: "stopReason", stopReason: "max_tokens" };
            }
            if (usage) {
                yield { type: "usage", usage };
            }
            else {
                yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
            }
        }
        catch (error) {
            if (error instanceof Error && error.name === "AbortError")
                return;
            if (isSafetyBlockError(error)) {
                logger.error(`[Google] Content safety block (stream): ${getErrorMessage(error)}`);
                yield {
                    type: "usage",
                    usage: { inputTokens: 0, outputTokens: 0 },
                    safetyBlock: true,
                };
                return;
            }
            throw new ProviderError("google", getErrorMessage(error), 500, error);
        }
    },
    /**
     * Live API streaming — for models that only support the bidirectional
     * WebSocket-based BidiGenerateContent method (e.g. gemini-3.1-flash-live-preview).
     *
     * Bridges the event-driven Live API into an async generator matching
     * the same interface as generateTextStream().
     */
    async *generateTextStreamLive(messages, model, options = {}) {
        logger.provider("Google", `generateTextStreamLive (Live API) model=${model}`);
        const modelDefinition = Object.values(MODELS).find((modelDefinitionItem) => modelDefinitionItem.name === model);
        let session = null;
        try {
            // ── Build Live API config ────────────────────────────────────
            // This model ONLY supports AUDIO output modality.
            // Text responses come via outputTranscription, not responseModalities.
            const liveConfig = {
                responseModalities: [Modality.AUDIO],
                outputAudioTranscription: {},
            };
            if (options.temperature !== undefined)
                liveConfig.temperature = options.temperature;
            if (options.topP !== undefined)
                liveConfig.topP = options.topP;
            if (options.topK !== undefined)
                liveConfig.topK = options.topK;
            if (options.maxTokens !== undefined &&
                options.maxTokens !== null &&
                options.maxTokens > 0) {
                liveConfig.maxOutputTokens = options.maxTokens;
            }
            const supportsThinking = modelDefinition?.thinking === true;
            if (supportsThinking && options.thinkingEnabled !== false) {
                const thinkingConfig = {
                    includeThoughts: true,
                };
                if (options.thinkingBudget !== undefined &&
                    options.thinkingBudget !== "") {
                    thinkingConfig.thinkingBudget = parseInt(String(options.thinkingBudget));
                }
                else if (options.thinkingLevel && modelDefinition?.thinkingLevels) {
                    thinkingConfig.thinkingLevel = options.thinkingLevel;
                }
                liveConfig.thinkingConfig = thinkingConfig;
            }
            // Tools
            const tools = [];
            if (options.webSearch)
                tools.push({ googleSearch: {} });
            const customTools = convertToolsToGoogle(options.tools);
            if (customTools)
                tools.push(...customTools);
            if (tools.length > 0)
                liveConfig.tools = tools;
            // System instruction from messages[0] if role === "system"
            const systemMessage = messages.find((message) => message.role === "system");
            if (systemMessage?.content) {
                liveConfig.systemInstruction = systemMessage.content;
            }
            const queue = [];
            let resolver = null;
            let done = false;
            let setupComplete = false;
            function enqueue(item) {
                if (resolver) {
                    const r = resolver;
                    resolver = null;
                    r(item);
                }
                else {
                    queue.push(item);
                }
            }
            function dequeue() {
                if (queue.length > 0) {
                    return Promise.resolve(queue.shift());
                }
                return new Promise((resolve) => {
                    resolver = resolve;
                });
            }
            // ── Connect to Live API ───────────────────────────────────────
            session = await getClient().live.connect({
                model,
                config: liveConfig,
                callbacks: {
                    onopen: () => {
                        logger.provider("Google", `Live API session opened for ${model}`);
                    },
                    onmessage: (message) => {
                        // Setup complete — signal we can send messages
                        if (message.setupComplete !== undefined) {
                            setupComplete = true;
                            enqueue({ type: "setupComplete" });
                            return;
                        }
                        // Audio data from model turn (inlineData)
                        if (message.serverContent?.modelTurn?.parts) {
                            for (const part of message.serverContent.modelTurn.parts) {
                                if (part.thought && part.text) {
                                    enqueue({ type: "thinking", content: part.text });
                                }
                                else if (part.inlineData) {
                                    // Audio chunks from the model — forward for playback
                                    enqueue({
                                        type: "audio",
                                        data: part.inlineData.data,
                                        mimeType: part.inlineData.mimeType,
                                    });
                                }
                                else if (part.text) {
                                    enqueue({ type: "text", content: part.text });
                                }
                                else if (part.functionCall) {
                                    enqueue({
                                        type: "toolCall",
                                        id: `google-toolCall-${crypto.randomUUID()}`,
                                        name: part.functionCall.name,
                                        args: part.functionCall.args || {},
                                        thoughtSignature: part.thoughtSignature || undefined,
                                    });
                                }
                            }
                        }
                        // Output transcription — TEXT transcript of the audio output.
                        // This is the primary text content for the SSE chat flow.
                        if (message.serverContent?.outputTranscription?.text) {
                            enqueue({
                                type: "text",
                                content: message.serverContent.outputTranscription.text,
                            });
                        }
                        // Tool calls from the server
                        if (message.toolCall?.functionCalls) {
                            for (const functionCall of message.toolCall.functionCalls) {
                                enqueue({
                                    type: "toolCall",
                                    id: `google-toolCall-${crypto.randomUUID()}`,
                                    name: functionCall.name || "any",
                                    args: (functionCall.args || {}),
                                });
                            }
                        }
                        // Usage metadata
                        if (message.usageMetadata) {
                            const user = message.usageMetadata;
                            if (user.promptTokenCount || user.responseTokenCount) {
                                enqueue({
                                    type: "usage",
                                    usage: {
                                        inputTokens: user.promptTokenCount ?? 0,
                                        outputTokens: user.responseTokenCount ?? 0,
                                        ...(user
                                            .cachedContentTokenCount
                                            ? {
                                                cacheReadInputTokens: user.cachedContentTokenCount,
                                            }
                                            : {}),
                                    },
                                });
                            }
                        }
                        // Turn complete — signal we're done
                        if (message.serverContent?.turnComplete) {
                            done = true;
                            enqueue({ type: "done" });
                        }
                    },
                    onerror: (e) => {
                        const errorObject = e;
                        const innerError = (errorObject?.error ?? null);
                        const errorMessage = innerError?.message ||
                            errorObject?.message ||
                            "unknown error";
                        logger.error(`[Google Live API] Error: ${errorMessage}`);
                        done = true;
                        enqueue({
                            type: "error",
                            message: errorMessage,
                        });
                    },
                    onclose: () => {
                        logger.provider("Google", "Live API session closed");
                        done = true;
                        enqueue({ type: "done" });
                    },
                },
            });
            // ── Wait for setupComplete before sending ─────────────────────
            while (!setupComplete) {
                const item = await dequeue();
                if (item?.type === "setupComplete")
                    break;
                if (item?.type === "error")
                    throw new ProviderError("google", item.message || "Unknown error", 500);
                if (item?.type === "done")
                    return;
            }
            // ── Seed conversation history & send user message ─────────────
            // sendClientContent works for seeding prior turns (turnComplete: false)
            // but causes "invalid argument" when used as the final turn.
            // So we seed history with sendClientContent, then send the last
            // user message via sendRealtimeInput.
            const nonSystemMessages = messages.filter((message) => message.role !== "system");
            const lastUserMessage = nonSystemMessages[nonSystemMessages.length - 1];
            const priorMessages = nonSystemMessages.slice(0, -1);
            // Build Content objects for prior history turns
            if (priorMessages.length > 0) {
                const historyTurns = [];
                for (const message of priorMessages) {
                    const parts = [];
                    if (message.content) {
                        parts.push({ text: message.content });
                    }
                    if (parts.length > 0) {
                        historyTurns.push({
                            role: message.role === "assistant" ? "model" : "user",
                            parts,
                        });
                    }
                }
                if (historyTurns.length > 0) {
                    session.sendClientContent({
                        turns: historyTurns,
                        turnComplete: false,
                    });
                }
            }
            // Send the final user message via sendRealtimeInput
            if (lastUserMessage?.content) {
                session.sendRealtimeInput({ text: lastUserMessage.content });
            }
            // ── Yield chunks from the queue ───────────────────────────────
            while (!done || queue.length > 0) {
                if (options.signal?.aborted)
                    break;
                const item = await dequeue();
                if (!item || item.type === "done")
                    break;
                if (item.type === "error") {
                    throw new ProviderError("google", item.message || "Unknown error", 500);
                }
                if (item.type === "text") {
                    yield item.content;
                }
                else if (item.type === "thinking") {
                    yield { type: "thinking", content: item.content };
                }
                else if (item.type === "toolCall") {
                    yield {
                        type: "toolCall",
                        id: item.id,
                        name: item.name,
                        args: item.args,
                        thoughtSignature: item.thoughtSignature,
                    };
                }
                else if (item.type === "usage") {
                    yield { type: "usage", usage: item.usage };
                }
                else if (item.type === "audio") {
                    yield { type: "audio", data: item.data, mimeType: item.mimeType };
                }
            }
        }
        catch (error) {
            if (error instanceof Error && error.name === "AbortError")
                return;
            if (error instanceof ProviderError)
                throw error;
            throw new ProviderError("google", getErrorMessage(error), 500, error);
        }
        finally {
            if (session) {
                try {
                    session.close();
                }
                catch {
                    /* already closed */
                }
            }
        }
    },
    async captionImage(images, prompt = "Describe this image.", model = getDefaultModels(TYPES.IMAGE, TYPES.TEXT).google, systemPrompt) {
        logger.provider("Google", `captionImage model=${model}`);
        try {
            // Process each image into inline data parts
            const imageParts = [];
            for (const imageUrlOrBase64 of images) {
                let imageData = imageUrlOrBase64;
                let mimeType = "image/jpeg";
                if (imageUrlOrBase64.startsWith("http")) {
                    const response = await fetch(imageUrlOrBase64);
                    if (!response.ok) {
                        throw new Error(`Failed to fetch image from URL: ${imageUrlOrBase64}`);
                    }
                    const arrayBuffer = await response.arrayBuffer();
                    imageData = Buffer.from(arrayBuffer).toString("base64");
                    mimeType = response.headers.get("content-type") || "image/jpeg";
                }
                else if (imageUrlOrBase64.includes(";base64,")) {
                    const parts = imageUrlOrBase64.split(";base64,");
                    mimeType = parts[0].split(":")[1];
                    imageData = parts[1];
                }
                imageParts.push({ inlineData: { data: imageData, mimeType } });
            }
            const contents = [
                {
                    role: "user",
                    parts: [...imageParts, { text: prompt }],
                },
            ];
            const config = {};
            if (systemPrompt) {
                config.systemInstruction = systemPrompt;
            }
            const response = await getClient().models.generateContent({
                model,
                contents,
                config: Object.keys(config).length > 0 ? config : undefined,
            });
            const usage = {
                inputTokens: response.usageMetadata?.promptTokenCount || 0,
                outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
                ...(response.usageMetadata?.cachedContentTokenCount
                    ? {
                        cacheReadInputTokens: response.usageMetadata.cachedContentTokenCount,
                    }
                    : {}),
            };
            return { text: response.text, usage };
        }
        catch (error) {
            throw new ProviderError("google", getErrorMessage(error), 500, error);
        }
    },
    async generateImage(prompt, images = [], model = MODELS.GEMINI_3_PRO_IMAGE.name, systemPrompt) {
        logger.provider("Google", `generateImage model=${model}`);
        try {
            const config = {
                responseModalities: ["IMAGE"],
                imageConfig: { imageSize: "1K" },
            };
            if (systemPrompt) {
                config.systemInstruction = systemPrompt;
            }
            const parts = [{ text: prompt }];
            if (images.length) {
                for (const image of images) {
                    // Support both data URL strings and { imageData, mimeType } objects
                    if (typeof image === "string") {
                        const match = image.match(/^data:([\w-]+\/[\w.+-]+);base64,(.+)$/);
                        if (match) {
                            parts.push({
                                inlineData: { mimeType: match[1], data: match[2] },
                            });
                        }
                    }
                    else {
                        parts.push({
                            inlineData: {
                                data: image.imageData,
                                mimeType: image.mimeType || "image/jpeg",
                            },
                        });
                    }
                }
            }
            const contents = [{ role: "user", parts }];
            const response = await getClient().models.generateContentStream({
                model,
                config,
                contents,
            });
            let combinedText = "";
            for await (const chunk of response) {
                if (!chunk.candidates?.[0]?.content?.parts)
                    continue;
                if (chunk.candidates?.[0]?.finishReason === "PROHIBITED_CONTENT") {
                    throw new Error("Content was flagged as prohibited by Google AI");
                }
                const part = chunk.candidates[0].content.parts[0];
                if (part.inlineData) {
                    return {
                        imageData: part.inlineData.data,
                        mimeType: part.inlineData.mimeType || "image/png",
                        text: combinedText,
                    };
                }
                else if (chunk.text) {
                    combinedText += chunk.text;
                }
            }
            throw new Error("No image data received from Google AI");
        }
        catch (error) {
            if (error instanceof ProviderError)
                throw error;
            throw new ProviderError("google", getErrorMessage(error), 500, error);
        }
    },
    async generateSpeech(text, voice = DEFAULT_VOICES.google, options = {}) {
        logger.provider("Google", `generateSpeech voice=${voice}`);
        try {
            const config = {
                temperature: 1,
                responseModalities: ["audio"],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: voice,
                        },
                    },
                },
            };
            const speechModel = options.model ||
                getDefaultModels(TYPES.TEXT, TYPES.AUDIO).google;
            const speechText = options.prompt ? `${options.prompt}\n\n${text}` : text;
            const response = await getClient().models.generateContent({
                model: speechModel,
                contents: [
                    {
                        role: "user",
                        parts: [{ text: speechText }],
                    },
                ],
                config,
            });
            const candidates = response.candidates;
            if (candidates?.[0]?.content?.parts?.[0]?.inlineData) {
                const inlineData = candidates[0].content.parts[0].inlineData;
                const audioBuffer = Buffer.from(inlineData.data || "", "base64");
                if (inlineData.mimeType === "audio/mpeg" ||
                    inlineData.mimeType === "audio/mp3") {
                    return {
                        stream: Readable.from(audioBuffer),
                        contentType: "audio/mpeg",
                    };
                }
                else {
                    const wavBuffer = addWavHeader(audioBuffer);
                    return { stream: Readable.from(wavBuffer), contentType: "audio/wav" };
                }
            }
            else {
                throw new Error("No audio content received from Google GenAI");
            }
        }
        catch (error) {
            if (error instanceof ProviderError)
                throw error;
            throw new ProviderError("google", getErrorMessage(error), 500, error);
        }
    },
    async transcribeAudio(audioBuffer, mimeType, model = GOOGLE_TTS_MODEL || MODELS.GEMINI_35_FLASH.name, options = {}) {
        logger.provider("Google", `transcribeAudio model=${model}`);
        try {
            const audioBase64 = audioBuffer.toString("base64");
            const prompt = options.prompt ||
                "Transcribe the following audio accurately. Return only the transcription text, nothing else.";
            const contents = [
                {
                    role: "user",
                    parts: [
                        { inlineData: { mimeType, data: audioBase64 } },
                        { text: prompt },
                    ],
                },
            ];
            const config = {};
            if (options.language) {
                config.systemInstruction = `Transcribe in ${options.language}.`;
            }
            const response = await getClient().models.generateContent({
                model,
                contents,
                config,
            });
            return {
                text: response.text || "",
                usage: {
                    inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
                    outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
                    ...(response.usageMetadata?.cachedContentTokenCount
                        ? {
                            cacheReadInputTokens: response.usageMetadata.cachedContentTokenCount,
                        }
                        : {}),
                },
            };
        }
        catch (error) {
            throw new ProviderError("google", getErrorMessage(error), 500, error);
        }
    },
    async generateEmbedding(content, model, options = {}) {
        const resolvedModel = model ||
            getDefaultModels(TYPES.TEXT, TYPES.EMBEDDING)?.google ||
            GOOGLE_EMBEDDING_MODEL ||
            MODELS.GEMINI_EMBEDDING_2.name;
        logger.provider("Google", `generateEmbedding model=${resolvedModel}`);
        try {
            const config = {};
            let contents;
            // Build the contents for the embedding request
            if (typeof content === "string") {
                // Simple text-only input
                contents = content;
            }
            else if (Array.isArray(content)) {
                // Multimodal: wrap all parts in a single Content object.
                contents = { role: "user", parts: content };
            }
            else {
                contents = content;
            }
            if (typeof options.taskType === "string") {
                config.taskType = options.taskType;
            }
            if (typeof options.dimensions === "number") {
                config.outputDimensionality = options.dimensions;
            }
            const params = {
                model: resolvedModel,
                contents,
            };
            if (Object.keys(config).length > 0) {
                params.config = config;
            }
            const response = await getClient().models.embedContent(params);
            // embedContent returns { embeddings: [{ values: [...] }] } for batch/multimodal,
            // or { embedding: { values: [...] } } for single text
            let values;
            if (response.embeddings?.[0]?.values) {
                values = response.embeddings[0].values;
            }
            else {
                throw new Error("No embedding data in response");
            }
            return {
                embedding: values,
                dimensions: values.length,
            };
        }
        catch (error) {
            throw new ProviderError("google", getErrorMessage(error), getErrorStatus(error), error);
        }
    },
};
export default googleProvider;
//# sourceMappingURL=google.js.map