import { roundMilliseconds } from "@rodrigo-barraza/utilities-library";
import type { ObjectId } from "mongodb";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import logger from "../utils/logger.ts";
import {
  getTotalInputTokens,
  estimateTokens,
  calculateTextCost,
} from "../utils/CostCalculator.ts";
import { computeModalities } from "./conversation/index.ts";
import { COLLECTIONS } from "../constants.ts";
import { TYPES, getPricing } from "../config.ts";
import { calculateTokensPerSec } from "../utils/math.ts";
import WebhookEventBus from "./WebhookEventBus.ts";
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
export interface LogParams {
  requestId?: string;
  endpoint?: string | null;
  operation?: string | null;
  project?: string | null;
  username?: string | null;
  clientIp?: string | null;
  agent?: string | null;
  harness?: string | null;
  provider?: string | null;
  model?: string | null;
  conversationId?: string | null;
  traceId?: string | null;
  agentConversationId?: string | null;
  parentAgentConversationId?: string | null;
  toolsUsed?: boolean;
  toolDisplayNames?: string[];
  toolApiNames?: string[];
  success?: boolean;
  errorMessage?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  estimatedCost?: number | null;
  tokensPerSec?: number | null;
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  topK?: number | null;
  frequencyPenalty?: number | null;
  presencePenalty?: number | null;
  stopSequences?: string[] | null;
  messageCount?: number;
  inputCharacters?: number;
  outputCharacters?: number;
  timeToGeneration?: number | null;
  generationTime?: number | null;
  totalTime?: number | null;
  requestPayload?: Record<string, unknown> | null;
  responsePayload?: Record<string, unknown> | null;
  modalities?: Record<string, unknown> | null;
  rateLimits?: Record<string, unknown> | null;
  contextLength?: number | null;
  evalBatchSize?: number | null;
  physicalBatchSize?: number | null;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  [key: string]: number | undefined;
}

export interface LlmOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];
  tools?: { name?: string; function?: { name: string } }[];
  thinkingEnabled?: boolean;
  reasoningEffort?: string;
  thinkingBudget?: number;
  [key: string]: unknown;
}

import type { ToolCallPayload, MessagePayload } from "./conversation/index.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
export type { ToolCallPayload, MessagePayload };

export interface LogChatGenerationParams extends LogParams {
  usage?: TokenUsage;
  timeToGenerationSec?: number | null;
  generationSec?: number | null;
  totalSec?: number | null;
  options?: LlmOptions;
  messages?: MessagePayload[];
  text?: string | null;
  thinking?: string | null;
  images?: string[];
  toolCalls?: ToolCallPayload[];
  audioRef?: string | null;
  agenticIteration?: number | null;
}

export interface LogBackgroundLlmCallParams extends LogParams {
  provider: string;
  aiMessages: MessagePayload[];
  resultText: string | null;
  usage?: TokenUsage | Record<string, unknown> | null;
  requestStartMs: number;
  extraRequestPayload?: Record<string, unknown>;
  extraResponsePayload?: Record<string, unknown>;
}

export interface InsertPendingRequestParams {
  requestId: string;
  endpoint?: string | null;
  operation?: string | null;
  project?: string | null;
  username?: string | null;
  clientIp?: string | null;
  agent?: string | null;
  harness?: string | null;
  provider?: string | null;
  model?: string | null;
  conversationId?: string | null;
  traceId?: string | null;
  agentConversationId?: string | null;
  parentAgentConversationId?: string | null;
  agenticIteration?: number | null;
}

function sanitizeMessage(message: MessagePayload) {
  const sanitizeString = (s: unknown) =>
    typeof s === "string" && s.startsWith("data:") ? `[base64 data]` : s;
  const sanitizeMedia = (value: unknown) => {
    if (Array.isArray(value)) return value.map(sanitizeString);
    if (typeof value === "string") return sanitizeString(value);
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
// ─── Chat Generation Telemetry ──────────────────────────────────────────────

/** Provider-native tool names map to the display names used in the UI. */
const API_TO_CANONICAL_LOOKUP: Record<string, string> = API_TO_CANONICAL;

interface UsageMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
}

function extractUsageMetrics(usage: TokenUsage | undefined): UsageMetrics {
  return {
    inputTokens: usage ? getTotalInputTokens(usage) : 0,
    outputTokens: usage?.outputTokens || 0,
    cacheReadInputTokens: usage?.cacheReadInputTokens || 0,
    cacheCreationInputTokens: usage?.cacheCreationInputTokens || 0,
    reasoningOutputTokens: usage?.reasoningOutputTokens || 0,
  };
}

/** Modalities of the exchange, computed from the same function conversations use. */
function buildChatModalities(
  messages: MessagePayload[],
  text: string | null,
  thinking: string | null,
  images: string[],
  toolCalls: ToolCallPayload[],
  audioRef: string | null,
) {
  // Build synthetic message array for computeModalities
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
  return computeModalities(
    syntheticMessages as Parameters<typeof computeModalities>[0],
  );
}

function buildToolTelemetry(toolCalls: ToolCallPayload[]) {
  if (!toolCalls || toolCalls.length === 0) {
    return { toolsUsed: false, toolDisplayNames: [], toolApiNames: [] };
  }
  return {
    toolsUsed: true,
    toolDisplayNames: [
      ...new Set(
        toolCalls.map(
          (toolCall) =>
            API_TO_CANONICAL_LOOKUP[toolCall.name] || toolCall.name,
        ),
      ),
    ],
    toolApiNames: [...new Set(toolCalls.map((toolCall) => toolCall.name))],
  };
}

function buildChatRequestPayload(
  messages: MessagePayload[],
  options: LlmOptions,
  agenticIteration: number | null,
) {
  const requestPayload: Record<string, unknown> = {
    messages: messages?.map(sanitizeMessage) ?? [],
  };
  if (options?.tools) {
    requestPayload.tools = options.tools.map(
      (tool) => tool.name || tool.function?.name,
    );
  }
  if (agenticIteration !== null) requestPayload.agenticIteration = agenticIteration;
  return requestPayload;
}

function buildChatResponsePayload(
  text: string | null,
  thinking: string | null,
  images: string[],
  toolCalls: ToolCallPayload[],
  audioRef: string | null,
  usage: TokenUsage | undefined,
) {
  const responsePayload: Record<string, unknown> = {
    text: text || null,
    thinking: thinking || null,
  };
  if (images && images.length > 0) responsePayload.images = images;
  responsePayload.toolCalls =
    toolCalls && toolCalls.length > 0
      ? toolCalls.map((toolCall) => ({
          name:
            API_TO_CANONICAL_LOOKUP[toolCall.name] || toolCall.name,
          id: toolCall.id,
          args: toolCall.args,
        }))
      : null;
  if (audioRef) responsePayload.audioRef = audioRef;
  responsePayload.usage = usage;
  return responsePayload;
}

function countInputCharacters(messages: MessagePayload[]) {
  return (
    messages?.reduce(
      (sum, message) =>
        sum + (typeof message.content === "string" ? message.content.length : 0),
      0,
    ) ?? 0
  );
}



// ─── Defaulted Chat Log Parameters ──────────────────────────────────────────

/** Identity/log fields, defaulted exactly as the public signature documents. */
function normalizeLogIdentity(params: LogChatGenerationParams) {
  const {
    requestId,
    endpoint = "chat",
    operation = null,
    project,
    username,
    clientIp = null,
    agent = null,
    harness = null,
    provider,
    model,
    conversationId = null,
    traceId = null,
    agentConversationId = null,
    parentAgentConversationId = null,
  } = params;
  return {
    requestId,
    endpoint,
    operation,
    project,
    username,
    clientIp,
    agent,
    harness,
    provider,
    model,
    conversationId,
    traceId,
    agentConversationId,
    parentAgentConversationId,
  };
}

function normalizeLogTelemetry(params: LogChatGenerationParams) {
  const {
    success = true,
    errorMessage = null,
    usage,
    estimatedCost = null,
    tokensPerSec = null,
    timeToGenerationSec = null,
    generationSec = null,
    totalSec = null,
  } = params;
  return {
    success,
    errorMessage,
    usage,
    estimatedCost,
    tokensPerSec,
    timeToGenerationSec,
    generationSec,
    totalSec,
  };
}

function normalizeLogInputs(params: LogChatGenerationParams) {
  const { options = {}, messages = [] } = params;
  return { options, messages };
}

function normalizeLogOutputs(params: LogChatGenerationParams) {
  const {
    text = null,
    thinking = null,
    images = [],
    toolCalls = [],
    outputCharacters = 0,
    audioRef = null,
    agenticIteration = null,
    rateLimits = null,
  } = params;
  return {
    text,
    thinking,
    images,
    toolCalls,
    outputCharacters,
    audioRef,
    agenticIteration,
    rateLimits,
  };
}

function buildUsageLogFields(metrics: UsageMetrics) {
  return {
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    ...(metrics.cacheReadInputTokens > 0 && {
      cacheReadInputTokens: metrics.cacheReadInputTokens,
    }),
    ...(metrics.cacheCreationInputTokens > 0 && {
      cacheCreationInputTokens: metrics.cacheCreationInputTokens,
    }),
    ...(metrics.reasoningOutputTokens > 0 && {
      reasoningOutputTokens: metrics.reasoningOutputTokens,
    }),
  };
}

function buildOptionLogFields(options: LlmOptions | undefined) {
  return {
    temperature: options?.temperature ?? null,
    maxTokens: options?.maxTokens ?? null,
    topP: options?.topP ?? null,
    topK: options?.topK ?? null,
    frequencyPenalty: options?.frequencyPenalty ?? null,
    presencePenalty: options?.presencePenalty ?? null,
    stopSequences: options?.stopSequences ?? null,
    contextLength: optionNumber(options, [
      "_loadedContextLength",
      "contextLength",
    ]),
    evalBatchSize: optionNumber(options, [
      "_loadedEvalBatchSize",
      "eval_batch_size",
    ]),
    physicalBatchSize: optionNumber(options, [
      "_loadedPhysicalBatchSize",
      "eval_batch_size",
    ]),
  };
}

function buildTimingFields(
  timeToGenerationSec: number | null,
  generationSec: number | null,
  totalSec: number | null,
) {
  return {
    timeToGeneration:
      timeToGenerationSec !== null ? roundMilliseconds(timeToGenerationSec) : null,
    generationTime:
      generationSec !== null ? roundMilliseconds(generationSec) : null,
    totalTime: totalSec !== null ? roundMilliseconds(totalSec) : null,
  };
}

function buildMessageStats(messages: MessagePayload[]) {
  return {
    messageCount: messages?.length ?? 0,
    inputCharacters: countInputCharacters(messages),
  };
}

/** A caller's harness wins; otherwise the option's harness, then null. */
function resolveHarnessName(
  harness: string | null,
  options: LlmOptions | undefined,
) {
  // LlmOptions values are untyped; harness is a string by contract.
  const optionHarness = options?.harness as string | undefined;
  return harness || optionHarness || null;
}

/** First non-nullish numeric option among `keys`, mirroring `??` chaining. */
function optionNumber(
  options: LlmOptions | undefined,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = options?.[key];
    if (value !== undefined && value !== null) {
      // LlmOptions values are untyped; these fields are numeric by contract.
      const numeric = value as number;
      return numeric;
    }
  }
  return null;
}

/**
 * Identity/log fields. Optional params keep the null defaults the public
 * signature documents; `operation`/`agent`/`harness` use `||` to keep the
 * empty-string → null behaviour.
 */
function buildLogIdentityFields(params: LogParams, now: string) {
  return {
    requestId: params.requestId,
    timestamp: now,
    createdAt: now,
    endpoint: params.endpoint,
    operation: params.operation || null,
    project: params.project,
    username: params.username,
    clientIp: params.clientIp ?? null,
    agent: params.agent || null,
    harness: params.harness || null,
    provider: params.provider,
    model: params.model,
    conversationId: params.conversationId ?? null,
    traceId: params.traceId ?? null,
    ...(params.agentConversationId && {
      agentConversationId: params.agentConversationId,
    }),
    ...(params.parentAgentConversationId && {
      parentAgentConversationId: params.parentAgentConversationId,
    }),
  };
}

function buildLogToolFields(params: LogParams) {
  const toolApiNames = params.toolApiNames ?? [];
  return {
    toolsUsed: params.toolsUsed ?? false,
    toolDisplayNames: params.toolDisplayNames ?? [],
    toolApiNames,
    toolApiNameCount: toolApiNames.length,
  };
}

function buildLogUsageFields(params: LogParams) {
  const cacheReadInputTokens = params.cacheReadInputTokens ?? 0;
  const cacheCreationInputTokens = params.cacheCreationInputTokens ?? 0;
  const reasoningOutputTokens = params.reasoningOutputTokens ?? 0;
  return {
    success: params.success,
    errorMessage: params.errorMessage ?? null,
    inputTokens: params.inputTokens ?? 0,
    outputTokens: params.outputTokens ?? 0,
    ...(cacheReadInputTokens > 0 && { cacheReadInputTokens }),
    ...(cacheCreationInputTokens > 0 && { cacheCreationInputTokens }),
    ...(reasoningOutputTokens > 0 && { reasoningOutputTokens }),
    estimatedCost: params.estimatedCost ?? null,
    tokensPerSec: params.tokensPerSec ?? null,
  };
}

function buildLogOptionFields(params: LogParams) {
  return {
    temperature: params.temperature ?? null,
    maxTokens: params.maxTokens ?? null,
    topP: params.topP ?? null,
    topK: params.topK ?? null,
    frequencyPenalty: params.frequencyPenalty ?? null,
    presencePenalty: params.presencePenalty ?? null,
    stopSequences: params.stopSequences ?? null,
  };
}

function buildLogMessageFields(params: LogParams) {
  return {
    messageCount: params.messageCount ?? 0,
    inputCharacters: params.inputCharacters ?? 0,
    outputCharacters: params.outputCharacters ?? 0,
    // seconds — time to first token (TTFT)
    timeToGeneration: params.timeToGeneration ?? null,
    // seconds — token generation duration
    generationTime: params.generationTime ?? null,
    // seconds — end-to-end request time
    totalTime: params.totalTime ?? null,
  };
}

function buildLogPayloadFields(params: LogParams) {
  return {
    requestPayload: params.requestPayload ?? null,
    responsePayload: params.responsePayload ?? null,
    modalities: params.modalities ?? null,
    rateLimits: params.rateLimits ?? null,
  };
}

/** Model-sizing fields are omitted (not null) when the caller did not pass them. */
function buildLogTailFields(params: LogParams) {
  return {
    ...(params.contextLength != null && {
      contextLength: params.contextLength,
    }),
    ...(params.evalBatchSize != null && { evalBatchSize: params.evalBatchSize }),
    ...(params.physicalBatchSize != null && {
      physicalBatchSize: params.physicalBatchSize,
    }),
    status: "completed",
  };
}

function buildRequestDocument(params: LogParams, now: string) {
  return {
    ...buildLogIdentityFields(params, now),
    ...buildLogToolFields(params),
    ...buildLogUsageFields(params),
    ...buildLogOptionFields(params),
    ...buildLogMessageFields(params),
    ...buildLogPayloadFields(params),
    ...buildLogTailFields(params),
  };
}

/** Prefer real API-reported usage over the ~4 chars/token heuristic. */
function estimateBackgroundUsage(
  aiMessages: MessagePayload[],
  resultText: string | null,
  apiUsage: LogBackgroundLlmCallParams["usage"],
  model: LogBackgroundLlmCallParams["model"],
) {
  const inputText = aiMessages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    )
    .join("\n");

  const inputTokens = apiUsage
    ? getTotalInputTokens(
        apiUsage as Parameters<typeof getTotalInputTokens>[0],
      )
    : estimateTokens(inputText);
  const outputTokens = apiUsage
    ? apiUsage.outputTokens || 0
    : resultText
      ? estimateTokens(resultText)
      : 0;
  const cacheReadInputTokens = apiUsage?.cacheReadInputTokens || 0;
  const cacheCreationInputTokens = apiUsage?.cacheCreationInputTokens || 0;

  const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[model as string];
  let estimatedCost: number | null = null;
  if (pricing) {
    estimatedCost = calculateTextCost(
      (apiUsage || { inputTokens, outputTokens }) as Parameters<
        typeof calculateTextCost
      >[0],
      pricing,
    );
  }
  return {
    inputText,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    estimatedCost,
  };
}

interface PendingDocumentFields {
  requestId: string;
  endpoint: string | null;
  operation: string | null;
  project: string | null;
  username: string | null;
  clientIp: string | null;
  agent: string | null;
  harness: string | null;
  provider: string | null;
  model: string | null;
  conversationId: string | null;
  traceId: string | null;
  agentConversationId: string | null;
  parentAgentConversationId: string | null;
  agenticIteration: number | null;
}

function buildPendingRequestDocument(fields: PendingDocumentFields) {
  // `createdAt` mirrors `timestamp`: prism writes `createdAt`, and every
  // reader of the shared `prism.requests` collection (trading's Monitor
  // and audits, prism-client) filters and sorts on it. Our own admin
  // routes and indexes read `timestamp`, so both are written.
  const pendingNow = new Date().toISOString();
  return {
    requestId: fields.requestId,
    timestamp: pendingNow,
    createdAt: pendingNow,
    endpoint: fields.endpoint || null,
    operation: fields.operation || null,
    project: fields.project || null,
    username: fields.username || null,
    clientIp: fields.clientIp || null,
    agent: fields.agent || null,
    harness: fields.harness || null,
    provider: fields.provider || null,
    model: fields.model || null,
    conversationId: fields.conversationId || null,
    traceId: fields.traceId || null,
    ...(fields.agentConversationId && {
      agentConversationId: fields.agentConversationId,
    }),
    ...(fields.parentAgentConversationId && {
      parentAgentConversationId: fields.parentAgentConversationId,
    }),
    ...(fields.agenticIteration !== null && {
      agenticIteration: fields.agenticIteration,
    }),
    status: "pending",
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: null,
    success: null,
  };
}

const RequestLogger = {
  async log(params: LogParams) {
    try {
      const db = MongoWrapper.getDb(MONGO_DB_NAME);
      if (!db) {
        logger.error("RequestLogger: MongoDB client not available");
        return;
      }
      // `createdAt` mirrors `timestamp` — see insertPending for why both.
      const now = new Date().toISOString();
      const document = buildRequestDocument(params, now);
      await db.collection(COLLECTION).insertOne(document);

      WebhookEventBus.emit("request.created", { ...document });
    } catch (error: unknown) {
      logger.error(
        "RequestLogger: failed to save request",
        getErrorMessage(error),
      );
    }
  },
  /**
   * High-level utility to format and log a chat-like generation.
   * Centralizes the formatting of request payloads, telemetry, and tokens.
   */
  async logChatGeneration(params: LogChatGenerationParams) {
    const {
      requestId,
      endpoint,
      operation,
      project,
      username,
      clientIp,
      agent,
      harness,
      provider,
      model,
      conversationId,
      traceId,
      agentConversationId,
      parentAgentConversationId,
    } = normalizeLogIdentity(params);
    const {
      success,
      errorMessage,
      usage,
      estimatedCost,
      tokensPerSec,
      timeToGenerationSec,
      generationSec,
      totalSec,
    } = normalizeLogTelemetry(params);
    const { options, messages } = normalizeLogInputs(params);
    const {
      text,
      thinking,
      images,
      toolCalls,
      outputCharacters,
      audioRef,
      agenticIteration,
      rateLimits,
    } = normalizeLogOutputs(params);

    const metrics = extractUsageMetrics(usage);
    const modalities = buildChatModalities(
      messages,
      text,
      thinking,
      images,
      toolCalls,
      audioRef,
    );
    const toolTelemetry = buildToolTelemetry(toolCalls);

    return this.log({
      requestId,
      endpoint,
      operation,
      project,
      username,
      clientIp,
      agent,
      harness: resolveHarnessName(harness, options),
      provider,
      model,
      conversationId,
      traceId,
      agentConversationId,
      parentAgentConversationId,
      ...toolTelemetry,
      success,
      errorMessage,
      ...buildUsageLogFields(metrics),
      estimatedCost,
      tokensPerSec,
      ...buildOptionLogFields(options),
      ...buildMessageStats(messages),
      outputCharacters,
      ...buildTimingFields(timeToGenerationSec, generationSec, totalSec),
      requestPayload: buildChatRequestPayload(messages, options, agenticIteration),
      responsePayload: buildChatResponsePayload(
        text,
        thinking,
        images,
        toolCalls,
        audioRef,
        usage,
      ),
      modalities,
      rateLimits,
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
  async logBackgroundLlmCall({
    requestId,
    endpoint,
    operation,
    project,
    username,
    agent,
    provider: providerName,
    model,
    traceId,
    conversationId,
    agentConversationId,
    aiMessages,
    resultText,
    usage: apiUsage = null,
    success,
    errorMessage,
    requestStartMs,
    extraRequestPayload,
    extraResponsePayload,
  }: LogBackgroundLlmCallParams) {
    const totalSec = (performance.now() - requestStartMs) / 1000;
    const {
      inputText,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      estimatedCost,
    } = estimateBackgroundUsage(aiMessages, resultText, apiUsage, model);
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
      inputTokens: inputTokens as number,
      outputTokens: outputTokens as number,
      ...(Number(cacheReadInputTokens) > 0 && {
        cacheReadInputTokens: Number(cacheReadInputTokens),
      }),
      ...(Number(cacheCreationInputTokens) > 0 && {
        cacheCreationInputTokens: Number(cacheCreationInputTokens),
      }),
      tokensPerSec: calculateTokensPerSec(outputTokens as number, totalSec),
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
  async insertPending({
    requestId,
    endpoint = null,
    operation = null,
    project = null,
    username = null,
    clientIp = null,
    agent = null,
    harness = null,
    provider = null,
    model = null,
    conversationId = null,
    traceId = null,
    agentConversationId = null,
    parentAgentConversationId = null,
    agenticIteration = null,
  }: InsertPendingRequestParams): Promise<ObjectId | null> {
    try {
      const db = MongoWrapper.getDb(MONGO_DB_NAME);
      if (!db) {
        logger.error("RequestLogger: MongoDB client not available (insertPending)");
        return null;
      }
      // `createdAt` mirrors `timestamp`: prism writes `createdAt`, and every
      // reader of the shared `prism.requests` collection (trading's Monitor
      // and audits, prism-client) filters and sorts on it. Our own admin
      // routes and indexes read `timestamp`, so both are written.
      const pendingDocument = buildPendingRequestDocument({
        requestId,
        endpoint,
        operation,
        project,
        username,
        clientIp,
        agent,
        harness,
        provider,
        model,
        conversationId,
        traceId,
        agentConversationId,
        parentAgentConversationId,
        agenticIteration,
      });
      const insertResult = await db.collection(COLLECTION).insertOne(pendingDocument);
      return insertResult.insertedId;
    } catch (error: unknown) {
      logger.error(
        "RequestLogger: failed to insert pending request",
        getErrorMessage(error),
      );
      return null;
    }
  },
  // Update a previously inserted pending request document with full
  // telemetry, payload, and timing data. Sets status to "completed".
  //
  // If the pending document is not found (e.g. was cleaned up), falls
  // back to a standard full insert via log().
  async completePending(
    pendingDocumentId: ObjectId,
    fullPayload: LogParams,
  ): Promise<void> {
    try {
      const db = MongoWrapper.getDb(MONGO_DB_NAME);
      if (!db) {
        logger.error("RequestLogger: MongoDB client not available (completePending)");
        return;
      }
      const {
        requestId,
        endpoint,
        operation,
        project,
        username,
        clientIp,
        agent,
        harness,
        provider,
        model,
        conversationId,
        traceId,
        agentConversationId,
        parentAgentConversationId,
        toolsUsed,
        toolDisplayNames,
        toolApiNames,
        success,
        errorMessage,
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
        reasoningOutputTokens,
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
        contextLength,
        evalBatchSize,
        physicalBatchSize,
      } = fullPayload;

      const updateFields: Record<string, unknown> = {
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
        toolApiNameCount: Array.isArray(toolApiNames) ? toolApiNames.length : 0,
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

      if (agentConversationId) updateFields.agentConversationId = agentConversationId;
      if (parentAgentConversationId) updateFields.parentAgentConversationId = parentAgentConversationId;
      if (Number(cacheReadInputTokens) > 0) updateFields.cacheReadInputTokens = Number(cacheReadInputTokens);
      if (Number(cacheCreationInputTokens) > 0) updateFields.cacheCreationInputTokens = Number(cacheCreationInputTokens);
      if (Number(reasoningOutputTokens) > 0) updateFields.reasoningOutputTokens = Number(reasoningOutputTokens);
      if (contextLength != null) updateFields.contextLength = contextLength;
      if (evalBatchSize != null) updateFields.evalBatchSize = evalBatchSize;
      if (physicalBatchSize != null) updateFields.physicalBatchSize = physicalBatchSize;

      const updateResult = await db.collection(COLLECTION).updateOne(
        { _id: pendingDocumentId },
        { $set: updateFields },
      );

      if (updateResult.matchedCount === 0) {
        // Pending document was not found — fall back to standard insert
        logger.warn("RequestLogger: pending document not found, falling back to full insert");
        await this.log(fullPayload);
        return;
      }

      WebhookEventBus.emit("request.completed", { _id: pendingDocumentId, ...updateFields });
    } catch (error: unknown) {
      logger.error(
        "RequestLogger: failed to complete pending request",
        getErrorMessage(error),
      );
      // Best-effort fallback: try to insert the full document
      try {
        await this.log(fullPayload);
      } catch {
        // Already logged the error above
      }
    }
  },
};
export default RequestLogger;
