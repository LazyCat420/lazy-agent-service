import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { formatCostTag, roundMilliseconds, errorMessage, } from "@rodrigo-barraza/utilities-library";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
import express from "express";
import crypto from "crypto";
import { getProvider } from "../providers/index.js";
import { ProviderError } from "../utils/errors.js";
import { TYPES, getPricing, getModelByName } from "../config.js";
import { calculateAudioCost } from "../utils/CostCalculator.js";
import ConversationService from "../services/ConversationService.js";
import FileService from "../services/FileService.js";
import logger from "../utils/logger.js";
import RequestLogger from "../services/RequestLogger.js";
import { FILE_CATEGORIES } from "../constants.js";
const router = express.Router();
// ─── used by both REST and WebSocket ────────────────────────
export async function handleVoice(params, emitBinary, emitJSON) {
    const requestId = crypto.randomUUID();
    const requestStart = performance.now();
    const { provider: providerName, text, voice, instructions, model, options: extraOptions, conversationId: incomingConversationId, conversationMeta: incomingConversationMeta, traceId: incomingTraceId, skipConversation, project = "any", username = "any", clientIp = null, } = params;
    // ── Auto-conversation: every AI request gets tracked ────────────
    let conversationId = skipConversation ? null : incomingConversationId;
    let conversationMeta = skipConversation
        ? null
        : incomingConversationMeta || null;
    if (!skipConversation && !conversationId) {
        conversationId = crypto.randomUUID();
        const titleSnippet = (text || "").slice(0, 100).trim() || "TTS Request";
        conversationMeta = conversationMeta || { title: titleSnippet };
    }
    // ── Trace: passthrough ────────────────────────────────────
    // TraceId is generated client-side and passed on every request.
    const traceId = incomingTraceId || null;
    // Inject traceId into conversationMeta for storage
    if (traceId && conversationMeta) {
        conversationMeta.traceId = traceId;
    }
    else if (traceId) {
        conversationMeta = { traceId };
    }
    try {
        if (!providerName) {
            throw new ProviderError("server", "Missing required field: provider", 400);
        }
        if (!text) {
            throw new ProviderError("server", "Missing required field: text", 400);
        }
        const provider = getProvider(providerName);
        if (!provider.generateSpeech) {
            throw new ProviderError(providerName, `Provider "${providerName}" does not support text-to-speech`, 400);
        }
        // Mark conversation as generating (creates a stub doc via upsert)
        if (conversationId) {
            ConversationService.setGenerating(conversationId, project, username, true, {
                title: typeof conversationMeta?.title === "string"
                    ? conversationMeta.title
                    : undefined,
            }).catch((error) => logger.error(`Failed to set isGenerating: ${getErrorMessage(error)}`));
        }
        const options = { instructions, model, ...extraOptions };
        const result = await provider.generateSpeech(text, voice, options);
        const totalSec = (performance.now() - requestStart) / 1000;
        const contentType = result.contentType || "audio/mpeg";
        // Collect audio chunks for MinIO upload when conversationId is provided
        const audioChunks = conversationId ? [] : null;
        if (!result.stream) {
            throw new Error("Speech generation returned no stream");
        }
        const stream = result.stream;
        if ("pipe" in stream && typeof stream.pipe === "function") {
            // Node.js readable stream
            const nodeStream = stream;
            if (audioChunks) {
                nodeStream.on("data", (chunk) => audioChunks.push(chunk));
            }
            for await (const chunk of nodeStream) {
                emitBinary(chunk);
            }
        }
        else {
            // Web ReadableStream (from fetch)
            const webStream = stream;
            const reader = webStream.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (audioChunks && value)
                    audioChunks.push(Buffer.from(value));
                emitBinary(value);
            }
        }
        logger.request(project, username, clientIp, `[audio] ${providerName} model=${model || "default"} — ` +
            `total: ${totalSec.toFixed(2)}s`);
        RequestLogger.log({
            requestId,
            endpoint: "text-to-audio",
            project,
            username,
            clientIp,
            provider: providerName,
            model: model || null,
            conversationId: conversationId || null,
            traceId: traceId || null,
            success: true,
            inputCharacters: text.length,
            totalTime: roundMilliseconds(totalSec),
        });
        emitJSON({ type: "done" });
        // Auto-append to conversation
        if (conversationId && audioChunks) {
            let audioRef = null;
            try {
                const audioBuffer = Buffer.concat(audioChunks);
                const dataUrl = `data:${contentType};base64,${audioBuffer.toString("base64")}`;
                const { ref } = await FileService.uploadFile(dataUrl, FILE_CATEGORIES.GENERATIONS, project, username);
                audioRef = ref;
            }
            catch (error) {
                logger.error(`Failed to upload TTS audio: ${errorMessage(error)}`);
            }
            const messagesToAppend = [];
            // Derive user message from text
            messagesToAppend.push({
                role: "user",
                content: text,
                timestamp: new Date().toISOString(),
            });
            messagesToAppend.push({
                role: "assistant",
                content: "",
                ...(audioRef && { audio: audioRef }),
                model: model || undefined,
                provider: providerName,
                voice: voice || undefined,
                timestamp: new Date().toISOString(),
                totalTime: roundMilliseconds(totalSec),
            });
            const meta = conversationMeta
                ? { ...conversationMeta, settings: { provider: providerName, model } }
                : undefined;
            ConversationService.appendMessages(conversationId, project, username, messagesToAppend, meta)
                .then(() => ConversationService.setGenerating(conversationId, project, username, false))
                .catch((error) => logger.error(`Failed to append messages to conversation ${conversationId}: ${getErrorMessage(error)}`));
        }
        return contentType;
    }
    catch (error) {
        // Clear isGenerating flag on error
        if (conversationId) {
            ConversationService.setGenerating(conversationId, project, username, false).catch((error) => logger.error(`Failed to clear isGenerating on error: ${getErrorMessage(error)}`));
        }
        const totalSec = (performance.now() - requestStart) / 1000;
        RequestLogger.log({
            requestId,
            endpoint: "text-to-audio",
            project,
            username,
            clientIp,
            provider: providerName,
            model: model || null,
            traceId: traceId || null,
            success: false,
            errorMessage: errorMessage(error),
            totalTime: totalSec,
        });
        emitJSON({ type: "error", message: errorMessage(error) });
        throw error;
    }
}
// ─── chunked binary audio ───────────────────────────────────
/**
 * POST /text-to-audio
 * Body: { provider, text, voice?, instructions?, model?, options?, conversationId?, conversationMeta? }
 *
 * Default:          Binary audio stream with content-type header
 * ?format=dataUrl:  JSON response { audioDataUrl, contentType }
 */
router.post("/", asyncHandler(async (req, res, next) => {
    // Skip TTS handler when mounted at /audio-to-text
    if (req.baseUrl.includes("audio-to-text"))
        return next();
    try {
        // ── Data URL format: collect chunks → base64-encode → return JSON ──
        if (req.query.format === "dataUrl") {
            const audioChunks = [];
            const resultContentType = await handleVoice({
                ...req.body,
                project: req.project,
                username: req.username,
                clientIp: req.clientIp,
            }, (chunk) => audioChunks.push(Buffer.from(chunk)), (_event) => {
                /* JSON events not needed for dataUrl format */
            });
            const audioContentType = resultContentType || "audio/mpeg";
            const audioDataUrl = `data:${audioContentType};base64,${Buffer.concat(audioChunks).toString("base64")}`;
            return res.json({ audioDataUrl, contentType: audioContentType });
        }
        // ── Default: stream binary audio chunks ──
        let contentType = "audio/mpeg";
        const resultContentType = await handleVoice({
            ...req.body,
            project: req.project,
            username: req.username,
            clientIp: req.clientIp,
        }, (chunk) => {
            // Set headers on first chunk
            if (!res.headersSent) {
                res.setHeader("Content-Type", contentType);
                res.setHeader("Transfer-Encoding", "chunked");
            }
            res.write(chunk);
        }, (_event) => {
            /* REST doesn't send JSON events to client */
        });
        if (resultContentType) {
            contentType = resultContentType;
        }
        res.end();
    }
    catch (error) {
        if (!res.headersSent) {
            next(error);
        }
    }
}));
// ─── audio transcription (speech-to-text) ───────────────────
/**
 * POST /audio-to-text
 * Body: { provider, audio (base64 string or data URL), model?, language?, prompt? }
 * Response: { text, usage? }
 */
router.post("/", asyncHandler(async (req, res, next) => {
    const requestId = crypto.randomUUID();
    const requestStart = performance.now();
    const { provider: providerName, audio, model, language, prompt: transcriptionPrompt, conversationId: incomingConversationId, conversationMeta: incomingConversationMeta, traceId: incomingTraceId, skipConversation, } = req.body;
    // Auto-generate conversationId when caller omits it (mirrors chat route)
    let conversationId = skipConversation
        ? null
        : incomingConversationId || null;
    let conversationMeta = skipConversation
        ? null
        : incomingConversationMeta || null;
    if (!skipConversation && !conversationId) {
        conversationId = crypto.randomUUID();
        conversationMeta = conversationMeta || { title: "Audio Transcription" };
    }
    // ── Trace: passthrough ────────────────────────────────────
    // TraceId is generated client-side and passed on every request.
    const traceId = incomingTraceId || null;
    // Inject traceId into conversationMeta for storage
    if (traceId && conversationMeta) {
        conversationMeta.traceId = traceId;
    }
    else if (traceId) {
        conversationMeta = { traceId };
    }
    try {
        if (!providerName) {
            throw new ProviderError("server", "Missing required field: provider", 400);
        }
        if (!audio) {
            throw new ProviderError("server", "Missing required field: audio", 400);
        }
        // Mark conversation as generating (creates a stub doc via upsert)
        // so the frontend can fetch the conversation by ID immediately.
        if (conversationId) {
            ConversationService.setGenerating(conversationId, req.project || "any", req.username || "any", true, {
                title: typeof conversationMeta?.title === "string"
                    ? conversationMeta.title
                    : undefined,
            }).catch((error) => logger.error(`Failed to set isGenerating: ${getErrorMessage(error)}`));
        }
        const provider = getProvider(providerName);
        if (!provider.transcribeAudio) {
            throw new ProviderError(providerName, `Provider "${providerName}" does not support audio transcription`, 400);
        }
        // Parse audio — accept either data URL or raw base64
        let audioBuffer;
        let mimeType = "audio/mpeg";
        const dataUrlMatch = audio.match(/^data:([^;]+);base64,(.+)$/);
        if (dataUrlMatch) {
            mimeType = dataUrlMatch[1];
            audioBuffer = Buffer.from(dataUrlMatch[2], "base64");
        }
        else {
            audioBuffer = Buffer.from(audio, "base64");
        }
        const transcribeOptions = {};
        if (language)
            transcribeOptions.language = language;
        if (transcriptionPrompt)
            transcribeOptions.prompt = transcriptionPrompt;
        const result = await provider.transcribeAudio(audioBuffer, mimeType, model, transcribeOptions);
        const totalSec = (performance.now() - requestStart) / 1000;
        // ── Cost estimation ─────────────────────────────────────────
        const modelDefinition = getModelByName(model);
        const pricing = modelDefinition?.pricing ||
            getPricing(TYPES.AUDIO, TYPES.TEXT)[model] ||
            null;
        const estimatedCost = calculateAudioCost(result.usage, pricing);
        // ── Logging ────────────────────────────────────────────────
        const costString = formatCostTag(estimatedCost);
        logger.request(req.project || "any", req.username || "any", req.clientIp || null, `[audio/transcribe] ${providerName} model=${model || "default"} — ` +
            `total: ${totalSec.toFixed(2)}s${costString}`);
        RequestLogger.log({
            requestId,
            endpoint: "audio-to-text",
            project: req.project,
            username: req.username,
            clientIp: req.clientIp,
            provider: providerName,
            model: model || null,
            conversationId,
            traceId: traceId || null,
            success: true,
            inputTokens: result.usage?.inputTokens || 0,
            outputTokens: result.usage?.outputTokens || 0,
            estimatedCost,
            totalTime: roundMilliseconds(totalSec),
        });
        // ── Conversation persistence ────────────────────────────────
        if (conversationId) {
            // Upload audio to MinIO for storage
            let audioRef = audio;
            try {
                const { ref } = await FileService.uploadFile(audio, FILE_CATEGORIES.UPLOADS, req.project, req.username);
                audioRef = ref;
            }
            catch (error) {
                logger.error(`Failed to upload STT audio: ${errorMessage(error)}`);
            }
            const messagesToAppend = [
                {
                    role: "user",
                    content: transcriptionPrompt || "Transcribe this audio",
                    images: [audioRef],
                    timestamp: new Date().toISOString(),
                },
                {
                    role: "assistant",
                    content: result.text || "",
                    model: model || undefined,
                    provider: providerName,
                    timestamp: new Date().toISOString(),
                    totalTime: roundMilliseconds(totalSec),
                    estimatedCost: estimatedCost ?? undefined,
                    usage: result.usage || undefined,
                },
            ];
            const meta = conversationMeta
                ? {
                    ...conversationMeta,
                    settings: { provider: providerName, model },
                }
                : undefined;
            ConversationService.appendMessages(conversationId, req.project || "any", req.username || "any", messagesToAppend, meta)
                .then(() => ConversationService.setGenerating(conversationId, req.project || "any", req.username || "any", false))
                .catch((error) => logger.error(`Failed to append messages to conversation ${conversationId}: ${getErrorMessage(error)}`));
        }
        res.json({
            text: result.text,
            usage: result.usage || {},
            estimatedCost,
            totalTime: roundMilliseconds(totalSec),
            ...(traceId && { traceId }),
        });
    }
    catch (error) {
        // Clear isGenerating flag on error
        if (conversationId) {
            ConversationService.setGenerating(conversationId, req.project || "any", req.username || "any", false).catch((error) => logger.error(`Failed to clear isGenerating on error: ${getErrorMessage(error)}`));
        }
        const totalSec = (performance.now() - requestStart) / 1000;
        RequestLogger.log({
            requestId,
            endpoint: "audio-to-text",
            project: req.project,
            username: req.username,
            clientIp: req.clientIp,
            provider: providerName,
            model: model || null,
            conversationId,
            traceId: traceId || null,
            success: false,
            errorMessage: errorMessage(error),
            totalTime: totalSec,
        });
        next(error);
    }
}));
export default router;
//# sourceMappingURL=AudioRoutes.js.map