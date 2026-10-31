import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import {
  formatCostTag,
  roundMilliseconds,
  errorMessage,
} from "@rodrigo-barraza/utilities-library";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import express, { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { getProvider } from "../providers/index.ts";
import { ProviderError } from "../utils/errors.ts";
import { TYPES, getPricing, getModelByName } from "../config.ts";
import { calculateAudioCost } from "../utils/CostCalculator.ts";
import ConversationService from "../services/ConversationService.ts";
import FileService from "../services/FileService.ts";
import logger from "../utils/logger.ts";
import RequestLogger from "../services/RequestLogger.ts";
import type { LogParams } from "../services/RequestLogger.ts";
import { FILE_CATEGORIES } from "../constants.ts";

import type { ChatMessage } from "../types/admin.ts";
import type { TranscriptionResult } from "../types/provider.ts";

// ── Types ────────────────────────────────────────────────────

interface ConversationMeta {
  title?: string;
  traceId?: string;
  settings?: Record<string, unknown>;
  [key: string]: unknown;
}

interface VoiceParams {
  provider: string;
  text: string;
  voice?: string;
  instructions?: string;
  model?: string;
  options?: Record<string, unknown>;
  conversationId?: string;
  conversationMeta?: ConversationMeta;
  traceId?: string;
  skipConversation?: boolean;
  project?: string;
  username?: string;
  clientIp?: string | null;
}

const router = express.Router();
function resolveVoiceConversationContext(params: VoiceParams): {
  conversationId: string | null | undefined;
  conversationMeta: ConversationMeta | null;
  traceId: string | null;
} {
  const {
    text,
    conversationId: incomingConversationId,
    conversationMeta: incomingConversationMeta,
    traceId: incomingTraceId,
    skipConversation,
  } = params;
  let conversationId = skipConversation ? null : incomingConversationId;
  let conversationMeta: ConversationMeta | null = skipConversation
    ? null
    : incomingConversationMeta || null;
  if (!skipConversation && !conversationId) {
    conversationId = crypto.randomUUID();
    const titleSnippet = (text || "").slice(0, 100).trim() || "TTS Request";
    conversationMeta = conversationMeta || { title: titleSnippet };
  }
  const traceId = incomingTraceId || null;
  if (traceId && conversationMeta) {
    conversationMeta.traceId = traceId;
  } else if (traceId) {
    conversationMeta = { traceId };
  }
  return { conversationId, conversationMeta, traceId };
}

async function consumeSpeechStreamToBinary(
  stream: unknown,
  audioChunks: Buffer[] | null,
  emitBinary: (chunk: Buffer | Uint8Array) => void,
): Promise<void> {
  if (!stream) {
    throw new Error("Speech generation returned no stream");
  }
  if (
    typeof stream === "object" &&
    "pipe" in stream &&
    typeof (stream as import("stream").Readable).pipe === "function"
  ) {
    const nodeStream = stream as import("stream").Readable;
    if (audioChunks) {
      nodeStream.on("data", (chunk: Buffer) => audioChunks.push(chunk));
    }
    for await (const chunk of nodeStream) {
      emitBinary(chunk as Buffer);
    }
    return;
  }

  const webStream = stream as ReadableStream<Uint8Array>;
  const reader = webStream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (audioChunks && value) audioChunks.push(Buffer.from(value));
    emitBinary(value);
  }
}

async function persistVoiceConversationMessages(
  conversationId: string,
  audioChunks: Buffer[],
  contentType: string,
  text: string,
  providerName: string,
  model: string | undefined,
  voice: string | undefined,
  totalSec: number,
  project: string,
  username: string,
  conversationMeta: ConversationMeta | null,
): Promise<void> {
  let audioRef: string | null = null;
  try {
    const audioBuffer = Buffer.concat(audioChunks);
    const dataUrl = `data:${contentType};base64,${audioBuffer.toString("base64")}`;
    const { ref } = await FileService.uploadFile(
      dataUrl,
      FILE_CATEGORIES.GENERATIONS,
      project,
      username,
    );
    audioRef = ref;
  } catch (error: unknown) {
    logger.error(`Failed to upload TTS audio: ${errorMessage(error)}`);
  }
  const messagesToAppend: ChatMessage[] = [
    {
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    },
    {
      role: "assistant",
      content: "",
      ...(audioRef && { audio: audioRef }),
      model: model || undefined,
      provider: providerName,
      voice: voice || undefined,
      timestamp: new Date().toISOString(),
      totalTime: roundMilliseconds(totalSec),
    },
  ];
  const meta = conversationMeta
    ? { ...conversationMeta, settings: { provider: providerName, model } }
    : undefined;
  ConversationService.appendMessages(
    conversationId,
    project,
    username,
    messagesToAppend,
    meta,
  )
    .then(() =>
      ConversationService.setGenerating(
        conversationId,
        project,
        username,
        false,
      ),
    )
    .catch((error: unknown) =>
      logger.error(
        `Failed to append messages to conversation ${conversationId}: ${getErrorMessage(error)}`,
      ),
    );
}

/** Validate the request and return the TTS provider, throwing in the same order as before. */
function resolveVoiceProvider(providerName: string, text: string) {
  if (!providerName) {
    throw new ProviderError(
      "server",
      "Missing required field: provider",
      400,
    );
  }
  if (!text) {
    throw new ProviderError("server", "Missing required field: text", 400);
  }
  const provider = getProvider(providerName);
  if (!provider.generateSpeech) {
    throw new ProviderError(
      providerName,
      `Provider "${providerName}" does not support text-to-speech`,
      400,
    );
  }
  return provider;
}

function markVoiceGenerating(
  conversationId: string,
  project: string,
  username: string,
  conversationMeta: ConversationMeta | null,
): void {
  ConversationService.setGenerating(
    conversationId,
    project,
    username,
    true,
    {
      title:
        typeof conversationMeta?.title === "string"
          ? conversationMeta.title
          : undefined,
    },
  ).catch((error: unknown) =>
    logger.error(`Failed to set isGenerating: ${getErrorMessage(error)}`),
  );
}

function clearVoiceGenerating(
  conversationId: string,
  project: string,
  username: string,
): void {
  ConversationService.setGenerating(
    conversationId,
    project,
    username,
    false,
  ).catch((error: unknown) =>
    logger.error(`Failed to clear isGenerating on error: ${getErrorMessage(error)}`),
  );
}

interface VoiceLogContext {
  requestId: string;
  project: string;
  username: string;
  clientIp: string | null;
  providerName: string;
  model: string | undefined;
  conversationId: string | null | undefined;
  traceId: string | null;
}

function buildVoiceSuccessLog(
  context: VoiceLogContext,
  text: string,
  totalSec: number,
): LogParams {
  return {
    requestId: context.requestId,
    endpoint: "text-to-audio",
    project: context.project,
    username: context.username,
    clientIp: context.clientIp,
    provider: context.providerName,
    model: context.model || null,
    conversationId: context.conversationId || null,
    traceId: context.traceId || null,
    success: true,
    inputCharacters: text.length,
    totalTime: roundMilliseconds(totalSec),
  };
}

function buildVoiceErrorLog(
  context: VoiceLogContext,
  error: unknown,
  totalSec: number,
): LogParams {
  return {
    requestId: context.requestId,
    endpoint: "text-to-audio",
    project: context.project,
    username: context.username,
    clientIp: context.clientIp,
    provider: context.providerName,
    model: context.model || null,
    traceId: context.traceId || null,
    success: false,
    errorMessage: errorMessage(error),
    totalTime: totalSec,
  };
}

// ─── used by both REST and WebSocket ────────────────────────
export async function handleVoice(
  params: VoiceParams,
  emitBinary: (chunk: Buffer | Uint8Array) => void,
  emitJSON: (event: Record<string, unknown>) => void,
) {
  const requestId = crypto.randomUUID();
  const requestStart = performance.now();
  const {
    provider: providerName,
    text,
    voice,
    instructions,
    model,
    options: extraOptions,
    project = "any",
    username = "any",
    clientIp = null,
  } = params;
  const { conversationId, conversationMeta, traceId } =
    resolveVoiceConversationContext(params);
  const logContext: VoiceLogContext = {
    requestId,
    project,
    username,
    clientIp,
    providerName,
    model,
    conversationId,
    traceId,
  };

  try {
    const provider = resolveVoiceProvider(providerName, text);
    if (conversationId) {
      markVoiceGenerating(conversationId, project, username, conversationMeta);
    }
    const options = { instructions, model, ...extraOptions };
    const result = await provider.generateSpeech(text, voice, options);
    const totalSec = (performance.now() - requestStart) / 1000;
    const contentType = result.contentType || "audio/mpeg";
    const audioChunks: Buffer[] | null = conversationId ? [] : null;

    await consumeSpeechStreamToBinary(result.stream, audioChunks, emitBinary);

    logger.request(
      project,
      username,
      clientIp,
      `[audio] ${providerName} model=${model || "default"} — ` +
        `total: ${totalSec.toFixed(2)}s`,
    );
    RequestLogger.log(buildVoiceSuccessLog(logContext, text, totalSec));
    emitJSON({ type: "done" });
    if (conversationId && audioChunks) {
      await persistVoiceConversationMessages(
        conversationId,
        audioChunks,
        contentType,
        text,
        providerName,
        model,
        voice,
        totalSec,
        project,
        username,
        conversationMeta,
      );
    }
    return contentType;
  } catch (error: unknown) {
    if (conversationId) {
      clearVoiceGenerating(conversationId, project, username);
    }
    const totalSec = (performance.now() - requestStart) / 1000;
    RequestLogger.log(buildVoiceErrorLog(logContext, error, totalSec));
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
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    // Skip TTS handler when mounted at /audio-to-text
    if (req.baseUrl.includes("audio-to-text")) return next();
    try {
      // ── Data URL format: collect chunks → base64-encode → return JSON ──
      if (req.query.format === "dataUrl") {
        const audioChunks: Buffer[] = [];
        const resultContentType = await handleVoice(
          {
            ...req.body,
            project: req.project,
            username: req.username,
            clientIp: req.clientIp,
          },
          (chunk) => audioChunks.push(Buffer.from(chunk)),
          (_event) => {
            /* JSON events not needed for dataUrl format */
          },
        );
        const audioContentType = resultContentType || "audio/mpeg";
        const audioDataUrl = `data:${audioContentType};base64,${Buffer.concat(audioChunks).toString("base64")}`;
        return res.json({ audioDataUrl, contentType: audioContentType });
      }
      // ── Default: stream binary audio chunks ──
      let contentType = "audio/mpeg";
      const resultContentType = await handleVoice(
        {
          ...req.body,
          project: req.project,
          username: req.username,
          clientIp: req.clientIp,
        },
        (chunk) => {
          // Set headers on first chunk
          if (!res.headersSent) {
            res.setHeader("Content-Type", contentType);
            res.setHeader("Transfer-Encoding", "chunked");
          }
          res.write(chunk);
        },
        (_event) => {
          /* REST doesn't send JSON events to client */
        },
      );
      if (resultContentType) {
        contentType = resultContentType;
      }
      res.end();
    } catch (error: unknown) {
      if (!res.headersSent) {
        next(error);
      }
    }
  }),
);
// ─── audio transcription (speech-to-text) ───────────────────
interface TranscriptionBody {
  provider?: string;
  audio?: string;
  model?: string;
  language?: string;
  prompt?: string;
  conversationId?: string;
  conversationMeta?: ConversationMeta;
  traceId?: string;
  skipConversation?: boolean;
}

interface TranscriptionContext {
  conversationId: string | null;
  conversationMeta: ConversationMeta | null;
  traceId: string | null;
}

/**
 * Auto-generate conversationId when caller omits it (mirrors chat route).
 * TraceId is generated client-side and passed on every request; it is
 * injected into conversationMeta for storage.
 */
function resolveTranscriptionContext(
  body: TranscriptionBody,
): TranscriptionContext {
  const { skipConversation } = body;
  let conversationId = skipConversation
    ? null
    : body.conversationId || null;
  let conversationMeta: ConversationMeta | null = skipConversation
    ? null
    : body.conversationMeta || null;
  if (!skipConversation && !conversationId) {
    conversationId = crypto.randomUUID();
    conversationMeta = conversationMeta || { title: "Audio Transcription" };
  }
  const traceId = body.traceId || null;
  if (traceId && conversationMeta) {
    conversationMeta.traceId = traceId;
  } else if (traceId) {
    conversationMeta = { traceId };
  }
  return { conversationId, conversationMeta, traceId };
}

/** Mark conversation as generating (creates a stub doc via upsert). */
function markTranscriptionGenerating(
  conversationId: string,
  project: string,
  username: string,
  conversationMeta: ConversationMeta | null,
): void {
  ConversationService.setGenerating(
    conversationId,
    project,
    username,
    true,
    {
      title:
        typeof conversationMeta?.title === "string"
          ? conversationMeta.title
          : undefined,
    },
  ).catch((error: unknown) =>
    logger.error(`Failed to set isGenerating: ${getErrorMessage(error)}`),
  );
}

function clearTranscriptionGenerating(
  conversationId: string,
  project: string,
  username: string,
): void {
  ConversationService.setGenerating(
    conversationId,
    project,
    username,
    false,
  ).catch((error: unknown) =>
    logger.error(
      `Failed to clear isGenerating on error: ${getErrorMessage(error)}`,
    ),
  );
}

/** Accept either a data URL or raw base64 audio. */
function parseAudioPayload(audio: string): {
  audioBuffer: Buffer;
  mimeType: string;
} {
  let mimeType = "audio/mpeg";
  const dataUrlMatch = audio.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUrlMatch) {
    mimeType = dataUrlMatch[1];
    return { audioBuffer: Buffer.from(dataUrlMatch[2], "base64"), mimeType };
  }
  return { audioBuffer: Buffer.from(audio, "base64"), mimeType };
}

function buildTranscribeOptions(
  language: string | undefined,
  prompt: string | undefined,
): Record<string, string> {
  const transcribeOptions: Record<string, string> = {};
  if (language) transcribeOptions.language = language;
  if (prompt) transcribeOptions.prompt = prompt;
  return transcribeOptions;
}

/** Model-specific pricing when known, else the audio→text pricing table. */
function estimateTranscriptionCost(
  model: string | undefined,
  usage: TranscriptionResult["usage"],
): number | null {
  const modelDefinition = (model
    ? getModelByName(model)
    : null) as Record<string, unknown> | null;
  const pricing =
    modelDefinition?.pricing ||
    (model ? getPricing(TYPES.AUDIO, TYPES.TEXT)[model] : undefined) ||
    null;
  return calculateAudioCost(usage, pricing as Record<string, number> | null);
}

/** Upload the source audio and append the transcription turn to the conversation. */
async function persistTranscriptionConversation({
  conversationId,
  audio,
  project,
  username,
  providerName,
  model,
  transcriptionPrompt,
  result,
  estimatedCost,
  totalSec,
  conversationMeta,
}: {
  conversationId: string;
  audio: string;
  project: string | undefined;
  username: string | undefined;
  providerName: string;
  model: string | undefined;
  transcriptionPrompt: string | undefined;
  result: TranscriptionResult;
  estimatedCost: number | null;
  totalSec: number;
  conversationMeta: ConversationMeta | null;
}): Promise<void> {
  // Upload audio to MinIO for storage
  let audioRef = audio;
  try {
    const { ref } = await FileService.uploadFile(
      audio,
      FILE_CATEGORIES.UPLOADS,
      project,
      username,
    );
    audioRef = ref;
  } catch (error: unknown) {
    logger.error(`Failed to upload STT audio: ${errorMessage(error)}`);
  }
  const messagesToAppend: ChatMessage[] = [
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
  ConversationService.appendMessages(
    conversationId,
    project || "any",
    username || "any",
    messagesToAppend,
    meta,
  )
    .then(() =>
      ConversationService.setGenerating(
        conversationId,
        project || "any",
        username || "any",
        false,
      ),
    )
    .catch((error: unknown) =>
      logger.error(
        `Failed to append messages to conversation ${conversationId}: ${getErrorMessage(error)}`,
      ),
    );
}

interface TranscriptionLogContext {
  requestId: string;
  project: string | undefined;
  username: string | undefined;
  clientIp: string | null | undefined;
  providerName: string | undefined;
  model: string | undefined;
  conversationId: string | null;
  traceId: string | null;
}

function buildTranscriptionSuccessLog(
  context: TranscriptionLogContext,
  result: TranscriptionResult,
  estimatedCost: number | null,
  totalSec: number,
): LogParams {
  return {
    requestId: context.requestId,
    endpoint: "audio-to-text",
    project: context.project,
    username: context.username,
    clientIp: context.clientIp,
    provider: context.providerName,
    model: context.model || null,
    conversationId: context.conversationId,
    traceId: context.traceId || null,
    success: true,
    inputTokens: result.usage?.inputTokens || 0,
    outputTokens: result.usage?.outputTokens || 0,
    estimatedCost,
    totalTime: roundMilliseconds(totalSec),
  };
}

function buildTranscriptionErrorLog(
  context: TranscriptionLogContext,
  error: unknown,
  totalSec: number,
): LogParams {
  return {
    requestId: context.requestId,
    endpoint: "audio-to-text",
    project: context.project,
    username: context.username,
    clientIp: context.clientIp,
    provider: context.providerName,
    model: context.model || null,
    conversationId: context.conversationId,
    traceId: context.traceId || null,
    success: false,
    errorMessage: errorMessage(error),
    totalTime: totalSec,
  };
}

/**
 * POST /audio-to-text
 * Body: { provider, audio (base64 string or data URL), model?, language?, prompt? }
 * Response: { text, usage? }
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const requestId = crypto.randomUUID();
    const requestStart = performance.now();
    const body = req.body as TranscriptionBody;
    const {
      provider: providerName,
      audio,
      model,
      language,
      prompt: transcriptionPrompt,
    } = body;
    const { conversationId, conversationMeta, traceId } =
      resolveTranscriptionContext(body);
    const projectAny = req.project || "any";
    const usernameAny = req.username || "any";
    const logContext: TranscriptionLogContext = {
      requestId,
      project: req.project,
      username: req.username,
      clientIp: req.clientIp,
      providerName,
      model,
      conversationId,
      traceId,
    };

    try {
      if (!providerName) {
        throw new ProviderError(
          "server",
          "Missing required field: provider",
          400,
        );
      }
      if (!audio) {
        throw new ProviderError("server", "Missing required field: audio", 400);
      }
      // Mark conversation as generating (creates a stub doc via upsert)
      // so the frontend can fetch the conversation by ID immediately.
      if (conversationId) {
        markTranscriptionGenerating(
          conversationId,
          projectAny,
          usernameAny,
          conversationMeta,
        );
      }
      const provider = getProvider(providerName);
      if (!provider.transcribeAudio) {
        throw new ProviderError(
          providerName,
          `Provider "${providerName}" does not support audio transcription`,
          400,
        );
      }
      // Parse audio — accept either data URL or raw base64
      const { audioBuffer, mimeType } = parseAudioPayload(audio);
      const transcribeOptions = buildTranscribeOptions(
        language,
        transcriptionPrompt,
      );
      const result = await provider.transcribeAudio(
        audioBuffer,
        mimeType,
        model,
        transcribeOptions,
      );
      const totalSec = (performance.now() - requestStart) / 1000;
      // ── Cost estimation ─────────────────────────────────────────
      const estimatedCost = estimateTranscriptionCost(model, result.usage);
      // ── Logging ────────────────────────────────────────────────
      const costString = formatCostTag(estimatedCost);
      logger.request(
        projectAny,
        usernameAny,
        req.clientIp || null,
        `[audio/transcribe] ${providerName} model=${model || "default"} — ` +
          `total: ${totalSec.toFixed(2)}s${costString}`,
      );
      RequestLogger.log(
        buildTranscriptionSuccessLog(
          logContext,
          result,
          estimatedCost,
          totalSec,
        ),
      );
      // ── Conversation persistence ────────────────────────────────
      if (conversationId) {
        await persistTranscriptionConversation({
          conversationId,
          audio,
          project: req.project,
          username: req.username,
          providerName,
          model,
          transcriptionPrompt,
          result,
          estimatedCost,
          totalSec,
          conversationMeta,
        });
      }
      res.json({
        text: result.text,
        usage: result.usage || {},
        estimatedCost,
        totalTime: roundMilliseconds(totalSec),
        ...(traceId && { traceId }),
      });
    } catch (error: unknown) {
      // Clear isGenerating flag on error
      if (conversationId) {
        clearTranscriptionGenerating(conversationId, projectAny, usernameAny);
      }
      const totalSec = (performance.now() - requestStart) / 1000;
      RequestLogger.log(
        buildTranscriptionErrorLog(logContext, error, totalSec),
      );
      next(error);
    }
  }),
);
export default router;
