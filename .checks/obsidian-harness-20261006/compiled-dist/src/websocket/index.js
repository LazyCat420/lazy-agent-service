import { DEFAULT_TOPOLOGY, DEFAULT_USERNAME, } from "@rodrigo-barraza/utilities-library/taxonomy";
import { handleConversation } from "../routes/ChatRoutes.js";
import { handleVoice } from "../routes/AudioRoutes.js";
import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity, } from "@google/genai";
import { GOOGLE_CLOUD_GEMINI_API_KEY, LIVE_AUDIO_MODEL } from "../../config.js";
import crypto from "crypto";
import logger from "../utils/logger.js";
import RequestLogger from "../services/RequestLogger.js";
import ConversationService from "../services/ConversationService.js";
import { calculateLiveCost } from "../utils/CostCalculator.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
import { FILE_CATEGORIES } from "../constants.js";
import { getModelByName, MODELS } from "../config.js";
import { calculateTokensPerSec } from "../utils/math.js";
import PromptLocaleService from "../services/PromptLocaleService.js";
/**
 * Set up WebSocket handlers on the HTTP server.
 * Routes:
 *   /ws/chat   — Streaming chat (text, images, code, thinking, etc.)
 *   /ws/text-to-audio  — Streaming TTS (binary audio frames)
 *   /ws/live   — Persistent Live API session (audio/text bidirectional)
 */
export function setupWebSocket(wss) {
    wss.on("connection", (websocket, req) => {
        const url = new URL(req.url || "/", `http://${req.headers.host}`);
        const pathname = url.pathname;
        const project = req.headers["x-project"] ||
            url.searchParams.get("project") ||
            "any";
        const xfwd = req.headers["x-forwarded-for"];
        const rawIp = (Array.isArray(xfwd) ? xfwd[0] : xfwd)?.split(",")[0]?.trim() ||
            req.socket.remoteAddress;
        // Normalize IPv4-mapped IPv6 (::ffff:127.0.0.1 → 127.0.0.1)
        const clientIp = rawIp?.replace(/^::ffff:/, "") || rawIp;
        const username = req.headers["x-username"] ||
            url.searchParams.get("username") ||
            DEFAULT_USERNAME;
        const agent = req.headers["x-agent"] || null;
        logger.info(`WebSocket connection on ${pathname} (project: ${project}, user: ${username})`);
        if (pathname === "/ws/chat") {
            handleWebsocketChat(websocket, project, username, clientIp || "unknown", agent);
        }
        else if (pathname === "/ws/text-to-audio") {
            handleWebsocketVoice(websocket, project, username, clientIp || "unknown", agent);
        }
        else if (pathname === "/ws/live") {
            handleWebsocketLive(websocket, project, username, clientIp || "unknown", agent);
        }
        else {
            websocket.send(JSON.stringify({
                type: "error",
                message: `Unknown WebSocket path: ${pathname}`,
            }));
            websocket.close();
        }
    });
}
function handleWebsocketChat(websocket, project, username, clientIp, agent) {
    websocket.on("message", async (rawData) => {
        let data;
        try {
            data = JSON.parse(rawData.toString());
        }
        catch {
            websocket.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
            return;
        }
        await handleConversation({ ...data, project, username, clientIp, agent }, (event) => {
            if (websocket.readyState === websocket.OPEN) {
                websocket.send(JSON.stringify(event));
            }
        });
    });
}
/**
 * WebSocket voice handler — delegates to shared handleVoice() from voice.js.
 * Sends binary audio frames for audio data, JSON for control events.
 */
function handleWebsocketVoice(websocket, project, username, clientIp, _agent) {
    websocket.on("message", async (rawData) => {
        let data;
        try {
            data = JSON.parse(rawData.toString());
        }
        catch {
            websocket.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
            return;
        }
        try {
            await handleVoice({ ...data, project, username, clientIp }, (chunk) => {
                if (websocket.readyState === websocket.OPEN) {
                    websocket.send(chunk); // Binary audio frame
                }
            }, (event) => {
                if (websocket.readyState === websocket.OPEN) {
                    websocket.send(JSON.stringify(event));
                }
            });
        }
        catch {
            // Error already emitted via emitJSON in handleVoice
        }
    });
}
// ─── persistent bidirectional session proxy ─────────────────
/**
 * Manages a persistent Live API WebSocket session.
 *
 * Protocol (client → Prism):
 *   { type: "setup", model, config }       — Initialize the Live API session
 *   { type: "audio", data }                — Base64-encoded PCM audio chunk
 *   { type: "text", text }                 — Text input
 *   { type: "toolResponse", responses }    — Function call responses
 *   { type: "close" }                      — Close the session
 *
 * Protocol (Prism → client):
 *   { type: "setupComplete" }              — Session is ready
 *   { type: "audio", data, mimeType }      — Audio chunk from model
 *   { type: "text", text }                 — Text chunk from model
 *   { type: "thinking", content }          — Thinking content
 *   { type: "toolCall", functionCalls }    — Tool call request
 *   { type: "inputTranscription", text }   — Transcription of user audio
 *   { type: "outputTranscription", text }  — Transcription of model audio
 *   { type: "turnComplete" }               — Model finished responding
 *   { type: "interrupted" }                — Model was interrupted
 *   { type: "error", message }             — Error
 */
function handleWebsocketLive(websocket, project, username, _clientIp, agent) {
    let liveSession = null;
    /** Accumulated base64 PCM audio chunks for current turn (model output, 24kHz) */
    let turnAudioChunks = [];
    let audioSampleRate = 24000;
    /** Accumulated base64 PCM audio chunks for current turn (user input, 16kHz) */
    const userInputAudioChunks = [];
    const userInputSampleRate = 16000;
    /** Whether user audio upload has been triggered for this turn */
    let userAudioUploading = false;
    /** Accumulated usage across the current turn */
    let turnUsage = { inputTokens: 0, outputTokens: 0 };
    // Variables for Request Logging
    let activeModel = LIVE_AUDIO_MODEL;
    let activeConversationId = null;
    let activeConversationTitle = undefined;
    let activeConfig = {};
    let turnStart = performance.now();
    let passFirstTokenTime = null;
    let turnText = "";
    let turnThinking = "";
    let turnToolCalls = [];
    let turnInputText = "";
    let turnUserAudioRef = null;
    function emit(event) {
        if (websocket.readyState === websocket.OPEN) {
            websocket.send(JSON.stringify(event));
        }
    }
    async function buildAndUploadAudio(chunks = turnAudioChunks, sampleRate = audioSampleRate) {
        if (chunks.length === 0)
            return null;
        try {
            const pcmBuffers = chunks.map((b64) => Buffer.from(b64, "base64"));
            const pcmData = Buffer.concat(pcmBuffers);
            const numberChannels = 1;
            const bitsPerSample = 16;
            const byteRate = sampleRate * numberChannels * (bitsPerSample / 8);
            const blockAlign = numberChannels * (bitsPerSample / 8);
            const wavHeader = Buffer.alloc(44);
            wavHeader.write("RIFF", 0);
            wavHeader.writeUInt32LE(36 + pcmData.length, 4);
            wavHeader.write("WAVE", 8);
            wavHeader.write("fmt ", 12);
            wavHeader.writeUInt32LE(16, 16);
            wavHeader.writeUInt16LE(1, 20);
            wavHeader.writeUInt16LE(numberChannels, 22);
            wavHeader.writeUInt32LE(sampleRate, 24);
            wavHeader.writeUInt32LE(byteRate, 28);
            wavHeader.writeUInt16LE(blockAlign, 32);
            wavHeader.writeUInt16LE(bitsPerSample, 34);
            wavHeader.write("data", 36);
            wavHeader.writeUInt32LE(pcmData.length, 40);
            const wavBuffer = Buffer.concat([wavHeader, pcmData]);
            const dataUrl = `data:audio/wav;base64,${wavBuffer.toString("base64")}`;
            const FileService = (await import("../services/FileService.js")).default;
            const { ref } = await FileService.uploadFile(dataUrl, FILE_CATEGORIES.GENERATIONS, project, username);
            return ref;
        }
        catch (error) {
            logger.error(`[Live API] Failed to build/upload WAV: ${getErrorMessage(error)}`);
            return null;
        }
    }
    websocket.on("message", async (rawData) => {
        let data;
        try {
            data = JSON.parse(rawData.toString());
        }
        catch {
            emit({ type: "error", message: "Invalid JSON" });
            return;
        }
        const { type } = data;
        // ── Setup: create a new Live API session ────────────────────
        if (type === "setup") {
            if (liveSession) {
                try {
                    liveSession.close();
                }
                catch {
                    /* ignore */
                }
                liveSession = null;
            }
            const model = data.model ||
                LIVE_AUDIO_MODEL ||
                MODELS.GEMINI_31_FLASH_LIVE.name;
            const clientConfig = (data.config || {});
            activeModel = model;
            activeConversationId =
                data.conversationId || clientConfig.conversationId || null;
            const conversationMeta = data.conversationMeta ||
                clientConfig.conversationMeta;
            activeConversationTitle =
                data.title ||
                    conversationMeta?.title ||
                    undefined;
            // Tools setup
            const tools = [];
            if (clientConfig.enabledTools &&
                Array.isArray(clientConfig.enabledTools)) {
                const enabledSet = new Set(clientConfig.enabledTools);
                if (enabledSet.has("Web Search") || enabledSet.has("Google Search")) {
                    tools.push({ googleSearch: {} });
                }
                try {
                    const ToolOrchestratorService = (await import("../services/ToolOrchestratorService.js")).default;
                    const { convertToolsToGoogle } = await import("../providers/google.js");
                    const MongoWrapper = (await import("../wrappers/MongoWrapper.js"))
                        .default;
                    const { MONGO_DB_NAME } = await import("../../config.js");
                    const SettingsService = (await import("../services/SettingsService.js")).default;
                    const settings = await SettingsService.getSection("agents");
                    const defaultTopology = clientConfig.topology ||
                        settings?.topology ||
                        DEFAULT_TOPOLOGY;
                    const dynamicTools = [
                        ...ToolOrchestratorService.getToolSchemas(defaultTopology),
                    ];
                    const filtered = dynamicTools.filter((dynamicTool) => enabledSet.has(dynamicTool.name));
                    const googleFormats = convertToolsToGoogle(filtered);
                    if (googleFormats) {
                        tools.push(...googleFormats);
                    }
                }
                catch (error) {
                    logger.error(`[Live API] Error loading tools: ${getErrorMessage(error)}`);
                }
            }
            // Build Live API config
            const liveConfig = {
                responseModalities: clientConfig.responseModalities || [Modality.AUDIO],
                // Always include a base system instruction with language hint to anchor
                // the input transcription model (which has no languageCode field)
                systemInstruction: clientConfig.systemInstruction
                    ? `${clientConfig.systemInstruction}\n\n${PromptLocaleService.get("en", "system-prompt.liveApiLanguageHint")}`
                    : PromptLocaleService.get("en", "system-prompt.liveApiLanguageHint"),
                ...(clientConfig.temperature !== undefined && {
                    temperature: clientConfig.temperature,
                }),
                ...(clientConfig.thinkingConfig && {
                    thinkingConfig: clientConfig.thinkingConfig,
                }),
                ...(tools.length > 0 && { tools }),
                // Voice Activity Detection — tuned for reliable speech capture
                realtimeInputConfig: {
                    automaticActivityDetection: {
                        disabled: false,
                        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
                        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
                        prefixPaddingMs: 500,
                        silenceDurationMs: 1500,
                    },
                },
                // Voice config — explicit voice selection
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: clientConfig.voiceName || "Puck",
                        },
                    },
                },
                // Enable transcription for audio responses
                outputAudioTranscription: {},
                inputAudioTranscription: {},
            };
            activeConfig = liveConfig;
            try {
                const client = new GoogleGenAI({ apiKey: GOOGLE_CLOUD_GEMINI_API_KEY });
                liveSession = await client.live.connect({
                    model,
                    config: liveConfig,
                    callbacks: {
                        onopen: () => {
                            logger.info(`[Live API] Session opened for ${model} (project: ${project}, user: ${username})`);
                            // Mark conversation as generating when the Live session opens
                            if (activeConversationId) {
                                ConversationService.setGenerating(activeConversationId, project, username, true, { title: activeConversationTitle }).catch((error) => logger.error(`[Live API] Failed to set isGenerating: ${getErrorMessage(error)}`));
                            }
                            emit({ type: "setupComplete" });
                        },
                        onmessage: (messageRaw) => {
                            const serverMessage = messageRaw;
                            // Model turn parts (audio data, text, function calls)
                            if (serverMessage.serverContent?.modelTurn?.parts) {
                                if (!passFirstTokenTime) {
                                    passFirstTokenTime = performance.now();
                                    // Re-set isGenerating at the start of each new turn
                                    if (activeConversationId) {
                                        ConversationService.setGenerating(activeConversationId, project, username, true, { title: activeConversationTitle }).catch(() => { });
                                    }
                                }
                                // First model turn message = user is done speaking.
                                // Eagerly upload user audio and emit userAudioReady now,
                                // so the audio card shows up before the model finishes.
                                if (!userAudioUploading && userInputAudioChunks.length > 0) {
                                    userAudioUploading = true;
                                    buildAndUploadAudio(userInputAudioChunks, userInputSampleRate).then((userAudioRef) => {
                                        if (userAudioRef) {
                                            turnUserAudioRef = userAudioRef;
                                            emit({ type: "userAudioReady", userAudioRef });
                                        }
                                    });
                                }
                                for (const part of serverMessage.serverContent.modelTurn
                                    .parts) {
                                    if (part.thought && part.text) {
                                        emit({ type: "thinking", content: part.text });
                                        turnThinking += part.text;
                                    }
                                    else if (part.text) {
                                        emit({ type: "text", text: part.text });
                                        turnText += part.text;
                                    }
                                    else if (part.inlineData) {
                                        emit({
                                            type: "audio",
                                            data: part.inlineData.data,
                                            mimeType: part.inlineData.mimeType,
                                        });
                                        // Accumulate for WAV building
                                        if (part.inlineData.data) {
                                            turnAudioChunks.push(part.inlineData.data);
                                        }
                                        if (part.inlineData.mimeType) {
                                            const rateMatch = part.inlineData.mimeType.match(/rate=(\d+)/);
                                            if (rateMatch)
                                                audioSampleRate = parseInt(rateMatch[1], 10);
                                        }
                                    }
                                    else if (part.functionCall) {
                                        emit({
                                            type: "toolCall",
                                            functionCalls: [
                                                {
                                                    id: `live-toolCall-${crypto.randomUUID()}`,
                                                    name: part.functionCall.name,
                                                    args: part.functionCall.args || {},
                                                },
                                            ],
                                        });
                                    }
                                }
                            }
                            // Top-level tool calls
                            if (serverMessage.toolCall?.functionCalls) {
                                const functionCalls = serverMessage.toolCall.functionCalls.map((functionCall) => ({
                                    id: functionCall.id ||
                                        `live-toolCall-${crypto.randomUUID()}`,
                                    name: functionCall.name,
                                    args: functionCall.args || {},
                                }));
                                turnToolCalls.push(...functionCalls);
                                // Emit calling status to the client
                                for (const functionCall of functionCalls) {
                                    emit({
                                        type: "tool_execution",
                                        tool: {
                                            name: functionCall.name,
                                            args: functionCall.args,
                                            id: functionCall.id,
                                        },
                                        status: "calling",
                                    });
                                }
                                // Execute tools natively in Prism and return response to Gemini
                                (async () => {
                                    try {
                                        const ToolOrchestratorService = (await import("../services/ToolOrchestratorService.js")).default;
                                        const { truncateToolResult } = await import("../utils/FunctionCallingUtilities.js");
                                        const results = await Promise.all(functionCalls.map(async (toolCall) => {
                                            const result = (await ToolOrchestratorService.executeTool(toolCall.name, toolCall.args, {
                                                project,
                                                username,
                                                agent: agent || null,
                                                conversationId: activeConversationId || null,
                                                clientIp: _clientIp || null,
                                                _providerName: "google",
                                                _resolvedModel: activeModel,
                                            }));
                                            return { id: toolCall.id, name: toolCall.name, result };
                                        }));
                                        for (const toolResult of results) {
                                            emit({
                                                type: "tool_execution",
                                                tool: {
                                                    name: toolResult.name,
                                                    id: toolResult.id,
                                                    result: toolResult.result,
                                                },
                                                status: toolResult.result?.error ? "error" : "done",
                                            });
                                        }
                                        const functionResponses = results.map((toolResult) => ({
                                            id: toolResult.id,
                                            name: toolResult.name,
                                            response: truncateToolResult(toolResult.result),
                                        }));
                                        if (liveSession) {
                                            liveSession.sendToolResponse({ functionResponses });
                                        }
                                        else {
                                            logger.warn("[Live API] Cannot send tool response — session closed before response was ready");
                                        }
                                    }
                                    catch (error) {
                                        logger.error(`[Live API] Error executing tools: ${getErrorMessage(error)}`);
                                    }
                                })();
                            }
                            // Transcriptions
                            if (serverMessage.serverContent?.inputTranscription?.text) {
                                turnInputText +=
                                    serverMessage.serverContent.inputTranscription.text + "\n";
                                emit({
                                    type: "inputTranscription",
                                    text: serverMessage.serverContent.inputTranscription.text,
                                });
                            }
                            if (serverMessage.serverContent?.outputTranscription?.text) {
                                const outText = serverMessage.serverContent.outputTranscription.text;
                                turnText += outText;
                                emit({
                                    type: "outputTranscription",
                                    text: outText,
                                });
                            }
                            // Usage metadata — accumulate per turn (must run BEFORE
                            // turnComplete / interrupted checks because the final
                            // usageMetadata arrives in the same message as those events)
                            if (serverMessage.usageMetadata) {
                                turnUsage.inputTokens +=
                                    serverMessage.usageMetadata.promptTokenCount ?? 0;
                                turnUsage.outputTokens +=
                                    serverMessage.usageMetadata.candidatesTokenCount ?? 0;
                            }
                            // Finalize usage: the Live API does not report
                            // candidatesTokenCount for audio output, so we estimate
                            // output tokens from accumulated PCM data.
                            // Google tokenises audio at 32 tokens/second.
                            function finalizeUsage() {
                                if (turnUsage.outputTokens === 0 &&
                                    turnAudioChunks.length > 0) {
                                    const totalPcmBytes = turnAudioChunks.reduce((sum, b64) => sum + Buffer.from(b64, "base64").length, 0);
                                    // 16-bit mono → 2 bytes per sample
                                    const durationSeconds = totalPcmBytes / (audioSampleRate * 2);
                                    turnUsage.outputTokens = Math.ceil(durationSeconds * 32);
                                }
                            }
                            // Shared helper — handles logging, emitting, resetting, and
                            // clearing isGenerating for both turnComplete and interrupted.
                            function finalizeTurn(eventType) {
                                finalizeUsage();
                                buildAndUploadAudio().then((audioRef) => {
                                    const modelDefinition = getModelByName(model);
                                    const estimatedCost = calculateLiveCost(turnUsage, modelDefinition
                                        ?.pricing ?? null);
                                    const totalSec = (performance.now() - turnStart) / 1000;
                                    const timeToGenerationSec = passFirstTokenTime
                                        ? (passFirstTokenTime - turnStart) / 1000
                                        : null;
                                    const generationSec = passFirstTokenTime && timeToGenerationSec !== null
                                        ? totalSec - timeToGenerationSec
                                        : null;
                                    RequestLogger.logChatGeneration({
                                        requestId: `live-${crypto.randomUUID()}`,
                                        endpoint: "/live",
                                        operation: "live",
                                        project,
                                        username,
                                        clientIp: _clientIp,
                                        agent,
                                        provider: "google",
                                        model: activeModel,
                                        conversationId: activeConversationId || null,
                                        success: true,
                                        usage: { ...turnUsage },
                                        estimatedCost,
                                        tokensPerSec: calculateTokensPerSec(turnUsage.outputTokens, generationSec),
                                        timeToGenerationSec,
                                        generationSec,
                                        totalSec,
                                        options: activeConfig,
                                        messages: [
                                            {
                                                role: "user",
                                                content: turnInputText.trim() || "[Voice Input]",
                                                ...(turnUserAudioRef
                                                    ? {
                                                        audio: [turnUserAudioRef],
                                                        liveTranscription: true,
                                                    }
                                                    : {}),
                                            },
                                        ],
                                        text: turnText,
                                        thinking: turnThinking,
                                        toolCalls: turnToolCalls,
                                        outputCharacters: turnText.length,
                                        ...(audioRef ? { audioRef } : {}),
                                    }).catch((error) => logger.error(`[Live API] Failed to log ${eventType} request: ${getErrorMessage(error)}`));
                                    emit({
                                        type: eventType,
                                        ...(audioRef ? { audioRef } : {}),
                                        usage: { ...turnUsage },
                                        ...(estimatedCost !== null ? { estimatedCost } : {}),
                                    });
                                    // Reset per-turn accumulators
                                    turnAudioChunks = [];
                                    userInputAudioChunks.length = 0;
                                    userAudioUploading = false;
                                    turnUsage = { inputTokens: 0, outputTokens: 0 };
                                    turnStart = performance.now();
                                    passFirstTokenTime = null;
                                    turnText = "";
                                    turnThinking = "";
                                    turnToolCalls = [];
                                    turnInputText = "";
                                    turnUserAudioRef = null;
                                    // Clear isGenerating flag
                                    if (activeConversationId) {
                                        ConversationService.setGenerating(activeConversationId, project, username, false).catch((error) => logger.error(`[Live API] Failed to clear isGenerating on ${eventType}: ${getErrorMessage(error)}`));
                                    }
                                });
                            }
                            // Turn complete — build WAV + upload, then emit with audioRef and usage
                            if (serverMessage.serverContent?.turnComplete) {
                                finalizeTurn("turnComplete");
                                return;
                            }
                            // Interrupted (model was cut off by user speech)
                            if (serverMessage.serverContent?.interrupted) {
                                finalizeTurn("interrupted");
                                return;
                            }
                        },
                        onerror: (e) => {
                            const errorMessage = e?.error?.message || e?.message || "Live API error";
                            logger.error(`[Live API] Error (${project}/${username}): ${errorMessage}`);
                            // Clear isGenerating flag on error
                            if (activeConversationId) {
                                ConversationService.setGenerating(activeConversationId, project, username, false).catch(() => { });
                            }
                            emit({ type: "error", message: errorMessage });
                        },
                        onclose: () => {
                            logger.info(`[Live API] Session closed (project: ${project}, user: ${username})`);
                            liveSession = null;
                            // Clear isGenerating flag when the Live API session closes
                            if (activeConversationId) {
                                ConversationService.setGenerating(activeConversationId, project, username, false).catch((error) => logger.error(`[Live API] Failed to clear isGenerating on close: ${getErrorMessage(error)}`));
                            }
                            emit({ type: "sessionClosed" });
                        },
                    },
                });
            }
            catch (error) {
                logger.error(`[Live API] Failed to connect: ${getErrorMessage(error)}`);
                emit({
                    type: "error",
                    message: `Failed to connect: ${getErrorMessage(error)}`,
                });
            }
            return;
        }
        // ── All other messages require an active session ─────────────
        if (!liveSession) {
            emit({
                type: "error",
                message: "No active session. Send a 'setup' message first.",
            });
            return;
        }
        // ── Audio input ─────────────────────────────────────────────
        if (type === "audio") {
            // Accumulate user's mic audio for WAV upload at turn end
            if (data.data) {
                userInputAudioChunks.push(data.data);
            }
            liveSession.sendRealtimeInput({
                audio: {
                    data: data.data,
                    mimeType: data.mimeType || "audio/pcm;rate=16000",
                },
            });
            return;
        }
        // ── Audio stream end (mic stopped — flush server-side cache) ──
        if (type === "audioStreamEnd") {
            liveSession.sendRealtimeInput({ audioStreamEnd: true });
            return;
        }
        // ── Text input ──────────────────────────────────────────────
        // The Live API uses server-managed VAD (Voice Activity Detection).
        // For text input we must bracket the message with activityStart /
        // activityEnd signals so the API recognises the turn boundary and
        // triggers a model response — without these the session closes.
        if (type === "text") {
            turnInputText += data.text + "\n";
            try {
                liveSession.sendRealtimeInput({ activityStart: {} });
                liveSession.sendRealtimeInput({ text: data.text });
                liveSession.sendRealtimeInput({ activityEnd: {} });
            }
            catch (error) {
                logger.error(`[Live API] Failed to send text: ${getErrorMessage(error)}`);
                emit({
                    type: "error",
                    message: `Failed to send text: ${getErrorMessage(error)}`,
                });
            }
            return;
        }
        // ── Tool response ───────────────────────────────────────────
        if (type === "toolResponse") {
            liveSession.sendToolResponse({
                functionResponses: data.responses,
            });
            return;
        }
        // ── Close session ───────────────────────────────────────────
        if (type === "close") {
            try {
                liveSession.close();
            }
            catch {
                /* ignore */
            }
            liveSession = null;
            return;
        }
    });
    // Clean up on client disconnect
    websocket.on("close", () => {
        if (liveSession) {
            try {
                liveSession.close();
            }
            catch {
                /* ignore */
            }
            liveSession = null;
        }
        // Clear isGenerating flag on client disconnect
        if (activeConversationId) {
            ConversationService.setGenerating(activeConversationId, project, username, false).catch((error) => logger.error(`[Live API] Failed to clear isGenerating on disconnect: ${getErrorMessage(error)}`));
        }
        logger.info(`[Live API] Client disconnected (project: ${project}, user: ${username})`);
    });
}
//# sourceMappingURL=index.js.map