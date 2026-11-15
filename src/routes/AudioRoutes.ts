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

const router = express.Router();

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
