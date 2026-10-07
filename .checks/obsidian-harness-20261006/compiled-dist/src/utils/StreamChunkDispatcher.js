// ─────────────────────────────────────────────────────────────
// StreamChunkDispatcher — Shared stream chunk processing
// ─────────────────────────────────────────────────────────────
// Centralises the chunk-type dispatching logic used by
// handleStreamingText (chat.js) and AgenticLoopService.
// ─────────────────────────────────────────────────────────────
import FileService from "../services/FileService.js";
import logger from "./logger.js";
import { SERVER_SENT_EVENT_TYPES, STATUS_MESSAGES, } from "@rodrigo-barraza/utilities-library/taxonomy";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
import { FILE_CATEGORIES } from "../constants.js";
// ── Helpers ──────────────────────────────────────────────────
/**
 * Strip XML tool call markup that some local models (e.g. Gemma 4) leak into
 * text output. Applied server-side so SSE chunk events arrive clean.
 *
 * Handles both completed tags (matched pairs) and incomplete tags at the
 * end of a streaming buffer (closing tag hasn't arrived yet).
 *
 * Also strips Gemma 4 channel/thought tokens (`<|channel>thought ... <channel|>`)
 * that bypass llama.cpp's PEG parser when using LM Studio or raw completions.
 */
export function stripToolCallMarkup(text) {
    return (text
        // ── Gemma 4 channel/thought reasoning blocks ──
        // Complete reasoning blocks: <|channel>thought ... <channel|>
        .replace(/<\|channel>thought[\s\S]*?<channel\|>/gi, "")
        // Empty channel blocks: <|channel> followed by non-thought content up to <channel|>
        .replace(/<\|channel>[\s\S]*?<channel\|>/gi, "")
        // Stray closing channel tags (model emits orphan <channel|>)
        .replace(/<channel\|>/gi, "")
        // ── Tool call / response / result tags ──
        // Completed tag pairs
        .replace(/<\|?tool_call\|?>[\s\S]*?<\/?\|?tool_call\|?>/gi, "")
        .replace(/<\|?tool_response\|?>[\s\S]*?<\/?\|?tool_response\|?>/gi, "")
        .replace(/<\|?result\|?>[\s\S]*?<\/?\|?result\|?>/gi, "")
        .replace(/\[END_TOOL_REQUEST\]/gi, "")
        // ── Incomplete trailing tags (closing tag hasn't arrived yet) ──
        .replace(/<\|channel>thought[\s\S]*$/gi, "")
        .replace(/<\|channel>[\s\S]*$/gi, "")
        .replace(/<\|?tool_call\|?>[\s\S]*$/gi, "")
        .replace(/<\|?tool_response\|?>[\s\S]*$/gi, "")
        .replace(/<\|?result\|?>[\s\S]*$/gi, ""));
}
export async function uploadImageChunk(chunk, project, username, logPrefix = "stream") {
    if (!chunk.data)
        return null;
    try {
        const mimeType = chunk.mimeType || "image/png";
        const dataUrl = `data:${mimeType};base64,${chunk.data}`;
        const { ref } = await FileService.uploadFile(dataUrl, FILE_CATEGORIES.GENERATIONS, project, username);
        return ref;
    }
    catch (error) {
        logger.error(`[${logPrefix}] MinIO upload failed: ${getErrorMessage(error)}`);
        return null;
    }
}
export function imageRefOrInline(minioRef, data, mimeType = "image/png") {
    return minioRef || `data:${mimeType};base64,${data}`;
}
// ── Emit TTFT helper (DRY) ──────────────────────────────────
function emitFirstToken(state, emit) {
    if (!state.firstTokenTime) {
        state.firstTokenTime = performance.now();
        if (state.requestStart) {
            emit({
                type: SERVER_SENT_EVENT_TYPES.STATUS,
                message: STATUS_MESSAGES.GENERATION_STARTED,
                timeToFirstToken: (state.firstTokenTime - state.requestStart) / 1000,
            });
        }
    }
    state.generationEnd = performance.now();
}
/**
 * Dispatch a single typed chunk to an accumulator state object and emit function.
 *
 * This is the single source of truth for the chunk type → handler mapping that was
 * previously duplicated across chat.js (handleStreamingText) and AgenticLoopService.
 */
export async function dispatchChunk(chunk, state, context, options = {}) {
    const { emit, project, username } = context;
    const logPrefix = options.logPrefix || "stream";
    // Non-object chunks are treated as text (raw string from provider)
    if (!chunk || typeof chunk !== "object") {
        emitFirstToken(state, emit);
        const rawString = typeof chunk === "string" ? chunk : "";
        state.text += rawString;
        // Strip tool call XML markup leaked by some local models (Gemma 4)
        const cleanText = stripToolCallMarkup(state.text);
        const chunkString = cleanText.slice(state.outputCharacters);
        state.outputCharacters = cleanText.length;
        if (chunkString)
            emit({
                type: SERVER_SENT_EVENT_TYPES.CHUNK,
                content: chunkString,
                outputCharacters: state.outputCharacters,
            });
        return true;
    }
    switch (chunk.type) {
        case "usage":
            if (options.onUsage && chunk.usage) {
                options.onUsage(chunk.usage);
            }
            else {
                state.usage = chunk.usage || null;
            }
            return true;
        case "rateLimits":
            state.rateLimits = chunk.rateLimits;
            return true;
        case "stopReason":
            state.stopReason =
                chunk.stopReason || undefined;
            return true;
        case "thinking":
            emitFirstToken(state, emit);
            state.thinking += chunk.content || "";
            state.outputCharacters += (chunk.content || "").length;
            emit({
                type: SERVER_SENT_EVENT_TYPES.THINKING,
                content: chunk.content,
                outputCharacters: state.outputCharacters,
            });
            return true;
        case "thinking_signature":
            state.thinkingSignature = chunk.signature || "";
            return true;
        case "image": {
            const minioRef = await uploadImageChunk(chunk, project, username, logPrefix);
            if (chunk.data) {
                state.images.push(imageRefOrInline(minioRef, chunk.data, chunk.mimeType));
            }
            emit({
                type: SERVER_SENT_EVENT_TYPES.IMAGE,
                data: chunk.data,
                mimeType: chunk.mimeType,
                minioRef,
            });
            return true;
        }
        case "executableCode":
            emit({
                type: SERVER_SENT_EVENT_TYPES.EXECUTABLE_CODE,
                code: chunk.code,
                language: chunk.language,
            });
            return true;
        case "codeExecutionResult":
            emit({
                type: SERVER_SENT_EVENT_TYPES.CODE_EXECUTION_RESULT,
                output: chunk.output,
                outcome: chunk.outcome,
            });
            return true;
        case "webSearchResult":
            emit({
                type: SERVER_SENT_EVENT_TYPES.WEB_SEARCH_RESULT,
                results: chunk.results,
            });
            return true;
        case "audio":
            emit({
                type: SERVER_SENT_EVENT_TYPES.AUDIO,
                data: chunk.data,
                mimeType: chunk.mimeType,
            });
            if (chunk.data)
                state.audioChunks.push(chunk.data);
            if (chunk.mimeType) {
                const rateMatch = chunk.mimeType.match(/rate=(\d+)/);
                if (rateMatch)
                    state.audioSampleRate = parseInt(rateMatch[1], 10);
            }
            return true;
        case "toolCall":
            // Tool call chunks indicate model output — track generation timing
            emitFirstToken(state, emit);
            if (chunk.status === "done" || chunk.status === "error") {
                const existing = state.toolCalls.find((toolCall) => (chunk.id && toolCall.id === chunk.id) ||
                    (!chunk.id && toolCall.name === chunk.name && !toolCall.result));
                if (existing) {
                    existing.result = chunk.result || undefined;
                    existing.status = chunk.status;
                    if (chunk.args && Object.keys(chunk.args).length > 0) {
                        existing.args = chunk.args;
                    }
                }
            }
            else {
                state.toolCalls.push({
                    id: chunk.id || null,
                    responsesItemId: chunk.responsesItemId || undefined,
                    name: chunk.name || "",
                    args: chunk.args || {},
                    result: chunk.result || undefined,
                    status: chunk.status || undefined,
                    thoughtSignature: chunk.thoughtSignature || undefined,
                    reasoningItem: chunk.reasoningItem || undefined,
                });
            }
            emit({
                type: SERVER_SENT_EVENT_TYPES.TOOL_CALL,
                id: chunk.id || null,
                responsesItemId: chunk.responsesItemId || undefined,
                name: chunk.name,
                args: chunk.args || {},
                result: chunk.result || undefined,
                status: chunk.status || undefined,
                thoughtSignature: chunk.thoughtSignature || undefined,
            });
            return true;
        case "toolCallDelta":
            // Incremental tool call argument streaming — track generation timing
            // so the throughput badge stays alive, but don't emit to the client.
            emitFirstToken(state, emit);
            state.outputCharacters += Math.ceil((chunk.characters || 0) / 4);
            return true;
        case "status":
            emit({
                type: SERVER_SENT_EVENT_TYPES.STATUS,
                message: chunk.message,
                phase: chunk.phase,
                ...(chunk.progress != null && { progress: chunk.progress }),
            });
            return true;
        default: {
            // Unknown typed chunk — treat as text
            emitFirstToken(state, emit);
            const rawString = typeof chunk === "string" ? chunk : "";
            state.text += rawString;
            // Strip tool call XML markup leaked by some local models (Gemma 4)
            const cleanText = stripToolCallMarkup(state.text);
            const chunkString = cleanText.slice(state.outputCharacters);
            state.outputCharacters = cleanText.length;
            if (chunkString)
                emit({
                    type: SERVER_SENT_EVENT_TYPES.CHUNK,
                    content: chunkString,
                    outputCharacters: state.outputCharacters,
                });
            return true;
        }
    }
}
export function createStreamState() {
    return {
        usage: null,
        firstTokenTime: null,
        generationEnd: null,
        requestStart: null, // Set by caller to enable server-computed TTFT
        outputCharacters: 0,
        text: "",
        thinking: "",
        thinkingSignature: "",
        images: [],
        toolCalls: [],
        audioChunks: [],
        audioSampleRate: 24000,
        rateLimits: null,
        stopReason: undefined,
    };
}
//# sourceMappingURL=StreamChunkDispatcher.js.map