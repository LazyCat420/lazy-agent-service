import {
  DEFAULT_TOPOLOGY,
  DEFAULT_USERNAME,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { handleConversation } from "../routes/ChatRoutes.ts";
import { handleVoice } from "../routes/AudioRoutes.ts";
import {
  GoogleGenAI,
  Modality,
  StartSensitivity,
  EndSensitivity,
  Session,
} from "@google/genai";
import { GOOGLE_CLOUD_GEMINI_API_KEY, LIVE_AUDIO_MODEL } from "../../config.ts";
import crypto from "crypto";
import logger from "../utils/logger.ts";
import RequestLogger from "../services/RequestLogger.ts";
import ConversationService from "../services/ConversationService.ts";
import { calculateLiveCost } from "../utils/CostCalculator.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import { FILE_CATEGORIES } from "../constants.ts";
import { getModelByName, MODELS } from "../config.ts";
import { calculateTokensPerSec } from "../utils/math.ts";
import PromptLocaleService from "../services/PromptLocaleService.ts";
import AgentPersonaRegistry from "../services/AgentPersonaRegistry.ts";
import { decideToolCall, deniedToolResult } from "../services/ToolAuthorization.ts";
import type { WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { WebSocketServer } from "ws";
import type { GoogleToolConfigEntry } from "../providers/google.ts";

// ── Types ────────────────────────────────────────────────────

interface LiveClientConfig {
  conversationId?: string;
  enabledTools?: string[];
  responseModalities?: string[];
  systemInstruction?: string;
  temperature?: number;
  thinkingConfig?: Record<string, unknown>;
  voiceName?: string;
  [key: string]: unknown;
}

interface LiveMessagePart {
  thought?: boolean;
  text?: string;
  inlineData?: {
    data: string;
    mimeType: string;
  };
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
  };
}

interface LiveServerMessage {
  serverContent?: {
    modelTurn?: {
      parts: LiveMessagePart[];
    };
    inputTranscription?: { text: string };
    outputTranscription?: { text: string };
    turnComplete?: boolean;
    interrupted?: boolean;
  };
  toolCall?: {
    functionCalls: Array<{
      id?: string;
      name: string;
      args?: Record<string, unknown>;
    }>;
  };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

interface FunctionCallRef {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface ToolResult {
  id: string;
  name: string;
  result: Record<string, unknown>;
}

/**
 * Set up WebSocket handlers on the HTTP server.
 * Routes:
 *   /ws/chat   — Streaming chat (text, images, code, thinking, etc.)
 *   /ws/text-to-audio  — Streaming TTS (binary audio frames)
 *   /ws/live   — Persistent Live API session (audio/text bidirectional)
 */
export function setupWebSocket(wss: WebSocketServer) {
  wss.on("connection", (websocket: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    const project =
      (req.headers["x-project"] as string) ||
      url.searchParams.get("project") ||
      "any";
    const xfwd = req.headers["x-forwarded-for"];
    const rawIp =
      (Array.isArray(xfwd) ? xfwd[0] : xfwd)?.split(",")[0]?.trim() ||
      req.socket.remoteAddress;
    // Normalize IPv4-mapped IPv6 (::ffff:127.0.0.1 → 127.0.0.1)
    const clientIp = rawIp?.replace(/^::ffff:/, "") || rawIp;
    const username =
      (req.headers["x-username"] as string) ||
      url.searchParams.get("username") ||
      DEFAULT_USERNAME;
    const agent = (req.headers["x-agent"] as string) || null;
    logger.info(
      `WebSocket connection on ${pathname} (project: ${project}, user: ${username})`,
    );

    if (pathname === "/ws/chat") {
      handleWebsocketChat(
        websocket,
        project,
        username,
        clientIp || "unknown",
        agent,
      );
    } else if (pathname === "/ws/text-to-audio") {
      handleWebsocketVoice(
        websocket,
        project,
        username,
        clientIp || "unknown",
        agent,
      );
    } else if (pathname === "/ws/live") {
      handleWebsocketLive(
        websocket,
        project,
        username,
        clientIp || "unknown",
        agent,
      );
    } else {
      websocket.send(
        JSON.stringify({
          type: "error",
          message: `Unknown WebSocket path: ${pathname}`,
        }),
      );
      websocket.close();
    }
  });
}
function handleWebsocketChat(
  websocket: WebSocket,
  project: string,
  username: string,
  clientIp: string,
  agent: string | null,
) {
  websocket.on("message", async (rawData: Buffer | string) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(rawData.toString());
    } catch {
      websocket.send(
        JSON.stringify({ type: "error", message: "Invalid JSON" }),
      );
      return;
    }

    await handleConversation(
      { ...data, project, username, clientIp, agent },
      (event: Record<string, unknown>) => {
        if (websocket.readyState === websocket.OPEN) {
          websocket.send(JSON.stringify(event));
        }
      },
    );
  });
}

/**
 * WebSocket voice handler — delegates to shared handleVoice() from voice.js.
 * Sends binary audio frames for audio data, JSON for control events.
 */
function handleWebsocketVoice(
  websocket: WebSocket,
  project: string,
  username: string,
  clientIp: string,
  _agent: string | null,
) {
  websocket.on("message", async (rawData: Buffer | string) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(rawData.toString());
    } catch {
      websocket.send(
        JSON.stringify({ type: "error", message: "Invalid JSON" }),
      );
      return;
    }

    try {
      await handleVoice(
        { ...data, project, username, clientIp } as Parameters<
          typeof handleVoice
        >[0],
        (chunk: Buffer | Uint8Array) => {
          if (websocket.readyState === websocket.OPEN) {
            websocket.send(chunk); // Binary audio frame
          }
        },
        (event: Record<string, unknown>) => {
          if (websocket.readyState === websocket.OPEN) {
            websocket.send(JSON.stringify(event));
          }
        },
      );
    } catch {
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
interface LiveSessionState {
  websocket: WebSocket;
  project: string;
  username: string;
  clientIp: string;
  agent: string | null;
  liveSession: Session | null;
  turnAudioChunks: string[];
  audioSampleRate: number;
  userInputAudioChunks: string[];
  userInputSampleRate: number;
  userAudioUploading: boolean;
  turnUsage: { inputTokens: number; outputTokens: number };
  activeModel: string;
  activeConversationId: string | null;
  activeConversationTitle: string | undefined;
  activeConfig: Record<string, unknown>;
  turnStart: number;
  passFirstTokenTime: number | null;
  turnText: string;
  turnThinking: string;
  turnToolCalls: FunctionCallRef[];
  turnInputText: string;
  turnUserAudioRef: string | null;
  liveOfferedToolNames: Set<string>;
  livePolicies: unknown[];
}

function emitLiveEvent(websocket: WebSocket, event: Record<string, unknown>): void {
  if (websocket.readyState === websocket.OPEN) {
    websocket.send(JSON.stringify(event));
  }
}

async function buildAndUploadLiveAudio(
  project: string,
  username: string,
  chunks: string[],
  sampleRate: number,
): Promise<string | null> {
  if (chunks.length === 0) return null;
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
    const { ref } = await FileService.uploadFile(
      dataUrl,
      FILE_CATEGORIES.GENERATIONS,
      project,
      username,
    );
    return ref;
  } catch (error: unknown) {
    logger.error(`[Live API] Failed to build/upload WAV: ${getErrorMessage(error)}`);
    return null;
  }
}

async function resolveLiveTools(
  clientConfig: LiveClientConfig,
  liveOfferedToolNames: Set<string>,
): Promise<GoogleToolConfigEntry[]> {
  const tools: GoogleToolConfigEntry[] = [];
  if (!Array.isArray(clientConfig.enabledTools)) return tools;

  const enabledSet = new Set(clientConfig.enabledTools);
  if (enabledSet.has("Web Search") || enabledSet.has("Google Search")) {
    tools.push({ googleSearch: {} });
  }

  try {
    const ToolOrchestratorService = (await import("../services/ToolOrchestratorService.js"))
      .default;
    const { convertToolsToGoogle } = await import("../providers/google.js");
    await import("../wrappers/MongoWrapper.js");
    await import("../../config.js");

    const SettingsService = (await import("../services/SettingsService.js")).default;
    const settings = await SettingsService.getSection("agents");
    const defaultTopology =
      (clientConfig.topology as string) || settings?.topology || DEFAULT_TOPOLOGY;
    const dynamicTools = [...ToolOrchestratorService.getToolSchemas(defaultTopology)];

    const filtered = dynamicTools.filter((dynamicTool) => enabledSet.has(dynamicTool.name));
    for (const offered of filtered) liveOfferedToolNames.add(offered.name);
    const googleFormats = convertToolsToGoogle(
      filtered as {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
      }[],
    );
    if (googleFormats) {
      tools.push(...googleFormats);
    }
  } catch (error: unknown) {
    logger.error(`[Live API] Error loading tools: ${getErrorMessage(error)}`);
  }
  return tools;
}

function buildLiveApiSessionConfig(
  clientConfig: LiveClientConfig,
  tools: GoogleToolConfigEntry[],
): Record<string, unknown> {
  const languageHint = PromptLocaleService.get("en", "system-prompt.liveApiLanguageHint");
  return {
    responseModalities: clientConfig.responseModalities || [Modality.AUDIO],
    systemInstruction: clientConfig.systemInstruction
      ? `${clientConfig.systemInstruction}\n\n${languageHint}`
      : languageHint,
    ...(clientConfig.temperature !== undefined && {
      temperature: clientConfig.temperature,
    }),
    ...(clientConfig.thinkingConfig && {
      thinkingConfig: clientConfig.thinkingConfig,
    }),
    ...(tools.length > 0 && { tools }),
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
        prefixPaddingMs: 500,
        silenceDurationMs: 1500,
      },
    },
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: clientConfig.voiceName || "Puck",
        },
      },
    },
    outputAudioTranscription: {},
    inputAudioTranscription: {},
  };
}

function processLiveModelTurnPart(
  state: LiveSessionState,
  part: NonNullable<NonNullable<LiveServerMessage["serverContent"]>["modelTurn"]>["parts"][number],
): void {
  if (part.thought && part.text) {
    emitLiveEvent(state.websocket, { type: "thinking", content: part.text });
    state.turnThinking += part.text;
    return;
  }
  if (part.text) {
    emitLiveEvent(state.websocket, { type: "text", text: part.text });
    state.turnText += part.text;
    return;
  }
  if (part.inlineData) {
    emitLiveEvent(state.websocket, {
      type: "audio",
      data: part.inlineData.data,
      mimeType: part.inlineData.mimeType,
    });
    if (part.inlineData.data) {
      state.turnAudioChunks.push(part.inlineData.data);
    }
    const rateMatch = part.inlineData.mimeType?.match(/rate=(\d+)/);
    if (rateMatch) {
      state.audioSampleRate = parseInt(rateMatch[1], 10);
    }
    return;
  }
  if (part.functionCall) {
    emitLiveEvent(state.websocket, {
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

function handleLiveModelTurnParts(
  state: LiveSessionState,
  parts: NonNullable<NonNullable<LiveServerMessage["serverContent"]>["modelTurn"]>["parts"],
): void {
  if (!state.passFirstTokenTime) {
    state.passFirstTokenTime = performance.now();
    if (state.activeConversationId) {
      ConversationService.setGenerating(
        state.activeConversationId,
        state.project,
        state.username,
        true,
        { title: state.activeConversationTitle },
      ).catch(() => {});
    }
  }

  if (!state.userAudioUploading && state.userInputAudioChunks.length > 0) {
    state.userAudioUploading = true;
    buildAndUploadLiveAudio(
      state.project,
      state.username,
      state.userInputAudioChunks,
      state.userInputSampleRate,
    ).then((userAudioRef) => {
      if (userAudioRef) {
        state.turnUserAudioRef = userAudioRef;
        emitLiveEvent(state.websocket, { type: "userAudioReady", userAudioRef });
      }
    });
  }

  for (const part of parts) {
    processLiveModelTurnPart(state, part);
  }
}

async function executeLiveToolCalls(
  state: LiveSessionState,
  functionCalls: FunctionCallRef[],
): Promise<void> {
  try {
    const ToolOrchestratorService = (await import("../services/ToolOrchestratorService.js"))
      .default;
    const { truncateToolResult } = await import("../utils/FunctionCallingUtilities.js");

    const results: ToolResult[] = await Promise.all(
      functionCalls.map(async (toolCall) => {
        const authorization = decideToolCall({
          name: toolCall.name,
          args: toolCall.args,
          isAllowListed: state.liveOfferedToolNames.has(toolCall.name),
          policies: state.livePolicies as any,
          autoApprove: true,
          unattended: false,
        });
        if (authorization.verdict === "deny") {
          return {
            id: toolCall.id,
            name: toolCall.name,
            result: { ...deniedToolResult(toolCall.name, authorization) },
          };
        }
        const result = (await ToolOrchestratorService.executeTool(toolCall.name, toolCall.args, {
          project: state.project,
          username: state.username,
          agent: state.agent || null,
          conversationId: state.activeConversationId || null,
          clientIp: state.clientIp || null,
          _providerName: "google",
          _resolvedModel: state.activeModel,
        })) as Record<string, unknown>;
        return { id: toolCall.id, name: toolCall.name, result };
      }),
    );

    for (const toolResult of results) {
      emitLiveEvent(state.websocket, {
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
      response: truncateToolResult(toolResult.result) as Record<string, unknown>,
    }));

    if (state.liveSession) {
      state.liveSession.sendToolResponse({ functionResponses });
    } else {
      logger.warn(
        "[Live API] Cannot send tool response — session closed before response was ready",
      );
    }
  } catch (error: unknown) {
    logger.error(`[Live API] Error executing tools: ${getErrorMessage(error)}`);
  }
}

function handleLiveTopLevelToolCalls(
  state: LiveSessionState,
  rawFunctionCalls: Record<string, unknown>[],
): void {
  const functionCalls: FunctionCallRef[] = rawFunctionCalls.map((functionCall) => ({
    id: (functionCall.id as string) || `live-toolCall-${crypto.randomUUID()}`,
    name: functionCall.name as string,
    args: (functionCall.args as Record<string, unknown>) || {},
  }));
  state.turnToolCalls.push(...functionCalls);

  for (const functionCall of functionCalls) {
    emitLiveEvent(state.websocket, {
      type: "tool_execution",
      tool: {
        name: functionCall.name,
        args: functionCall.args,
        id: functionCall.id,
      },
      status: "calling",
    });
  }

  void executeLiveToolCalls(state, functionCalls);
}

function resetLiveTurnState(state: LiveSessionState, eventType: string): void {
  state.turnAudioChunks = [];
  state.userInputAudioChunks.length = 0;
  state.userAudioUploading = false;
  state.turnUsage = { inputTokens: 0, outputTokens: 0 };
  state.turnStart = performance.now();
  state.passFirstTokenTime = null;
  state.turnText = "";
  state.turnThinking = "";
  state.turnToolCalls = [];
  state.turnInputText = "";
  state.turnUserAudioRef = null;

  if (state.activeConversationId) {
    ConversationService.setGenerating(
      state.activeConversationId,
      state.project,
      state.username,
      false,
    ).catch((error: unknown) =>
      logger.error(
        `[Live API] Failed to clear isGenerating on ${eventType}: ${getErrorMessage(error)}`,
      ),
    );
  }
}

function logAndEmitCompletedLiveTurn(
  state: LiveSessionState,
  model: string,
  eventType: string,
  audioRef: string | null,
): void {
  const modelDefinition = getModelByName(model);
  const estimatedCost = calculateLiveCost(
    state.turnUsage,
    ((modelDefinition as Record<string, unknown>)?.pricing as Record<string, number>) ?? null,
  );

  const totalSec = (performance.now() - state.turnStart) / 1000;
  const timeToGenerationSec = state.passFirstTokenTime
    ? (state.passFirstTokenTime - state.turnStart) / 1000
    : null;
  const generationSec =
    timeToGenerationSec !== null ? totalSec - timeToGenerationSec : null;

  const userMsg: {
    role: string;
    content: string;
    audio?: string[];
    liveTranscription?: boolean;
  } = {
    role: "user",
    content: state.turnInputText.trim() || "[Voice Input]",
  };
  if (state.turnUserAudioRef) {
    userMsg.audio = [state.turnUserAudioRef];
    userMsg.liveTranscription = true;
  }

  RequestLogger.logChatGeneration({
    requestId: `live-${crypto.randomUUID()}`,
    endpoint: "/live",
    operation: "live",
    project: state.project,
    username: state.username,
    clientIp: state.clientIp,
    agent: state.agent,
    provider: "google",
    model: state.activeModel,
    conversationId: state.activeConversationId || null,
    success: true,
    usage: { ...state.turnUsage },
    estimatedCost,
    tokensPerSec: calculateTokensPerSec(state.turnUsage.outputTokens, generationSec),
    timeToGenerationSec,
    generationSec,
    totalSec,
    options: state.activeConfig,
    messages: [userMsg],
    text: state.turnText,
    thinking: state.turnThinking,
    toolCalls: state.turnToolCalls,
    outputCharacters: state.turnText.length,
    ...(audioRef ? { audioRef } : {}),
  }).catch((error: unknown) =>
    logger.error(
      `[Live API] Failed to log ${eventType} request: ${getErrorMessage(error)}`,
    ),
  );

  emitLiveEvent(state.websocket, {
    type: eventType,
    ...(audioRef ? { audioRef } : {}),
    usage: { ...state.turnUsage },
    ...(estimatedCost !== null ? { estimatedCost } : {}),
  });
  resetLiveTurnState(state, eventType);
}

function finalizeLiveTurn(state: LiveSessionState, model: string, eventType: string): void {
  if (state.turnUsage.outputTokens === 0 && state.turnAudioChunks.length > 0) {
    const totalPcmBytes = state.turnAudioChunks.reduce(
      (sum, b64) => sum + Buffer.from(b64, "base64").length,
      0,
    );
    const durationSeconds = totalPcmBytes / (state.audioSampleRate * 2);
    state.turnUsage.outputTokens = Math.ceil(durationSeconds * 32);
  }

  buildAndUploadLiveAudio(
    state.project,
    state.username,
    state.turnAudioChunks,
    state.audioSampleRate,
  ).then((audioRef) => {
    logAndEmitCompletedLiveTurn(state, model, eventType, audioRef);
  });
}

function handleLiveServerMessage(
  state: LiveSessionState,
  model: string,
  messageRaw: unknown,
): void {
  const serverMessage = messageRaw as LiveServerMessage;
  if (serverMessage.serverContent?.modelTurn?.parts) {
    handleLiveModelTurnParts(state, serverMessage.serverContent.modelTurn.parts);
  }

  if (serverMessage.toolCall?.functionCalls) {
    handleLiveTopLevelToolCalls(state, serverMessage.toolCall.functionCalls);
  }

  const inText = serverMessage.serverContent?.inputTranscription?.text;
  if (inText) {
    state.turnInputText += inText + "\n";
    emitLiveEvent(state.websocket, { type: "inputTranscription", text: inText });
  }
  const outText = serverMessage.serverContent?.outputTranscription?.text;
  if (outText) {
    state.turnText += outText;
    emitLiveEvent(state.websocket, { type: "outputTranscription", text: outText });
  }

  if (serverMessage.usageMetadata) {
    state.turnUsage.inputTokens += serverMessage.usageMetadata.promptTokenCount ?? 0;
    state.turnUsage.outputTokens += serverMessage.usageMetadata.candidatesTokenCount ?? 0;
  }

  if (serverMessage.serverContent?.turnComplete) {
    finalizeLiveTurn(state, model, "turnComplete");
    return;
  }
  if (serverMessage.serverContent?.interrupted) {
    finalizeLiveTurn(state, model, "interrupted");
  }
}

function createLiveSessionCallbacks(state: LiveSessionState, model: string) {
  return {
    onopen: () => {
      logger.info(
        `[Live API] Session opened for ${model} (project: ${state.project}, user: ${state.username})`,
      );
      if (state.activeConversationId) {
        ConversationService.setGenerating(
          state.activeConversationId,
          state.project,
          state.username,
          true,
          { title: state.activeConversationTitle },
        ).catch((error: unknown) =>
          logger.error(`[Live API] Failed to set isGenerating: ${getErrorMessage(error)}`),
        );
      }
      emitLiveEvent(state.websocket, { type: "setupComplete" });
    },
    onmessage: (messageRaw: unknown) => {
      handleLiveServerMessage(state, model, messageRaw);
    },
    onerror: (e: Event & { error?: { message?: string }; message?: string }) => {
      const errorMessage = e?.error?.message || e?.message || "Live API error";
      logger.error(`[Live API] Error (${state.project}/${state.username}): ${errorMessage}`);
      if (state.activeConversationId) {
        ConversationService.setGenerating(
          state.activeConversationId,
          state.project,
          state.username,
          false,
        ).catch(() => {});
      }
      emitLiveEvent(state.websocket, { type: "error", message: errorMessage });
    },
    onclose: () => {
      logger.info(
        `[Live API] Session closed (project: ${state.project}, user: ${state.username})`,
      );
      state.liveSession = null;
      if (state.activeConversationId) {
        ConversationService.setGenerating(
          state.activeConversationId,
          state.project,
          state.username,
          false,
        ).catch((error: unknown) =>
          logger.error(
            `[Live API] Failed to clear isGenerating on close: ${getErrorMessage(error)}`,
          ),
        );
      }
      emitLiveEvent(state.websocket, { type: "sessionClosed" });
    },
  };
}

function extractLiveSetupTitle(
  data: Record<string, unknown>,
  clientConfig: LiveClientConfig,
): string | undefined {
  if (typeof data.title === "string" && data.title) return data.title;
  const meta =
    (data.conversationMeta as Record<string, unknown> | undefined) ||
    (clientConfig.conversationMeta as Record<string, unknown> | undefined);
  return (meta?.title as string) || undefined;
}

async function handleLiveSetupMessage(
  state: LiveSessionState,
  data: Record<string, unknown>,
): Promise<void> {
  if (state.liveSession) {
    try {
      state.liveSession.close();
    } catch {
      /* ignore */
    }
    state.liveSession = null;
  }

  const model =
    (data.model as string) || LIVE_AUDIO_MODEL || MODELS.GEMINI_31_FLASH_LIVE.name;
  const clientConfig = (data.config || {}) as LiveClientConfig;

  state.activeModel = model;
  state.activeConversationId =
    (data.conversationId as string) || clientConfig.conversationId || null;
  state.activeConversationTitle = extractLiveSetupTitle(data, clientConfig);

  state.liveOfferedToolNames = new Set<string>();
  const personaPolicies = state.agent ? AgentPersonaRegistry.get(state.agent)?.policies : undefined;
  state.livePolicies = personaPolicies || [];
  const tools = await resolveLiveTools(clientConfig, state.liveOfferedToolNames);
  const liveConfig = buildLiveApiSessionConfig(clientConfig, tools);
  state.activeConfig = liveConfig;

  try {
    const client = new GoogleGenAI({ apiKey: GOOGLE_CLOUD_GEMINI_API_KEY });
    state.liveSession = await client.live.connect({
      model,
      config: liveConfig,
      callbacks: createLiveSessionCallbacks(state, model),
    });
  } catch (error: unknown) {
    logger.error(`[Live API] Failed to connect: ${getErrorMessage(error)}`);
    emitLiveEvent(state.websocket, {
      type: "error",
      message: `Failed to connect: ${getErrorMessage(error)}`,
    });
  }
}

async function handleLiveClientMessage(
  state: LiveSessionState,
  rawData: Buffer | string,
): Promise<void> {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(rawData.toString());
  } catch {
    emitLiveEvent(state.websocket, { type: "error", message: "Invalid JSON" });
    return;
  }

  const { type } = data;
  if (type === "setup") {
    await handleLiveSetupMessage(state, data);
    return;
  }

  if (!state.liveSession) {
    emitLiveEvent(state.websocket, {
      type: "error",
      message: "No active session. Send a 'setup' message first.",
    });
    return;
  }

  if (type === "audio") {
    if (data.data) {
      state.userInputAudioChunks.push(data.data as string);
    }
    state.liveSession.sendRealtimeInput({
      audio: {
        data: data.data as string,
        mimeType: (data.mimeType as string) || "audio/pcm;rate=16000",
      },
    });
    return;
  }

  if (type === "audioStreamEnd") {
    state.liveSession.sendRealtimeInput({ audioStreamEnd: true });
    return;
  }

  if (type === "text") {
    state.turnInputText += (data.text as string) + "\n";
    try {
      state.liveSession.sendRealtimeInput({ activityStart: {} });
      state.liveSession.sendRealtimeInput({ text: data.text as string });
      state.liveSession.sendRealtimeInput({ activityEnd: {} });
    } catch (error: unknown) {
      logger.error(`[Live API] Failed to send text: ${getErrorMessage(error)}`);
      emitLiveEvent(state.websocket, {
        type: "error",
        message: `Failed to send text: ${getErrorMessage(error)}`,
      });
    }
    return;
  }

  if (type === "toolResponse") {
    state.liveSession.sendToolResponse({
      functionResponses: data.responses as Record<string, unknown>[],
    });
    return;
  }

  if (type === "close") {
    try {
      state.liveSession.close();
    } catch {
      /* ignore */
    }
    state.liveSession = null;
  }
}

function handleLiveClientDisconnect(state: LiveSessionState): void {
  if (state.liveSession) {
    try {
      state.liveSession.close();
    } catch {
      /* ignore */
    }
    state.liveSession = null;
  }
  if (state.activeConversationId) {
    ConversationService.setGenerating(
      state.activeConversationId,
      state.project,
      state.username,
      false,
    ).catch((error: unknown) =>
      logger.error(
        `[Live API] Failed to clear isGenerating on disconnect: ${getErrorMessage(error)}`,
      ),
    );
  }
  logger.info(
    `[Live API] Client disconnected (project: ${state.project}, user: ${state.username})`,
  );
}

function handleWebsocketLive(
  websocket: WebSocket,
  project: string,
  username: string,
  _clientIp: string,
  agent: string | null,
) {
  const state: LiveSessionState = {
    websocket,
    project,
    username,
    clientIp: _clientIp,
    agent,
    liveSession: null,
    turnAudioChunks: [],
    audioSampleRate: 24000,
    userInputAudioChunks: [],
    userInputSampleRate: 16000,
    userAudioUploading: false,
    turnUsage: { inputTokens: 0, outputTokens: 0 },
    activeModel: LIVE_AUDIO_MODEL,
    activeConversationId: null,
    activeConversationTitle: undefined,
    activeConfig: {},
    turnStart: performance.now(),
    passFirstTokenTime: null,
    turnText: "",
    turnThinking: "",
    turnToolCalls: [],
    turnInputText: "",
    turnUserAudioRef: null,
    liveOfferedToolNames: new Set<string>(),
    livePolicies: [],
  };

  websocket.on("message", async (rawData: Buffer | string) => {
    await handleLiveClientMessage(state, rawData);
  });

  websocket.on("close", () => {
    handleLiveClientDisconnect(state);
  });
}
