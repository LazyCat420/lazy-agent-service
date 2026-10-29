import { ProviderOptions } from "../types/ProviderTypes.ts";
import OpenAI, { toFile } from "openai";
import type { Stream } from "openai/streaming";
import type { Reasoning, ReasoningEffort } from "openai/resources/shared";
import { ProviderError } from "../utils/errors.ts";
import logger from "../utils/logger.ts";
import { extractOpenAIRateLimits } from "../utils/rateLimits.ts";
import { OPENAI_API_KEY, OPENAI_TRANSCRIPTION_MODEL } from "../../config.ts";
import {
  TYPES,
  MODELS,
  DEFAULT_VOICES,
  getDefaultModels,
  getModelByName,
} from "../config.ts";
import {
  convertToolsToOpenAI,
  normalizeUsage,
  prependIdentitySystemMessage,
} from "../utils/openai-compat.ts";
import type { TokenUsage } from "../types/admin.ts";
import {
  getDataUrlMimeType,
  getUrlType,
  inferMimeFromUrl,
} from "../utils/media.ts";

import type { ToolSchema } from "../services/harnesses/types.ts";

/**
 * Rate-limit snapshot returned by extractOpenAIRateLimits() — mirrors the
 * header-derived shape (provider tag plus per-window request/token quotas).
 */
type OpenAIRateLimits = {
  provider: string;
  requests: {
    limit: number | null;
    remaining: number | null;
    reset: string | null;
  };
  tokens: {
    limit: number | null;
    remaining: number | null;
    reset: string | null;
  };
};

/**
 * OpenAI Chat Completions API enforces a hard maximum of 128 tools.
 * When the Omni agent sends all tools (currently 276+), this limit
 * is exceeded. We truncate to 128, prioritizing tool-discovery tools
 * so the agent can still dynamically enable any tool it needs.
 */
const OPENAI_CHAT_COMPLETIONS_MAX_TOOLS = 128;

const PRIORITY_TOOL_NAMES = new Set([
  "discover_and_enable_tools",
  "search_tools",
  "enable_tools",
]);

function useResponsesAPI(model: string): boolean {
  const modelDefinition = getModelByName(model);
  return (
    modelDefinition !== null &&
    "responsesAPI" in modelDefinition &&
    (modelDefinition as { responsesAPI?: boolean }).responsesAPI === true
  );
}

/**
 * Catalog-first reasoning policy for the Chat Completions path.
 *
 * A known model takes the reasoning path when its catalog entry says
 * `thinking: true`. An unknown model id takes the reasoning path too: sending
 * temperature/top_p to a reasoning model is a 400, while omitting them on a
 * normal model is harmless. Never sniff the model name for "o1"/"o3" — the
 * harness must work with whatever model an operator has loaded.
 */
function isReasoningModel(model: string): boolean {
  const definition = getModelByName(model);
  if (!definition) return true;
  return "thinking" in definition && definition.thinking === true;
}

/**
 * Truncate a tool array to the Chat Completions API maximum (128).
 * Tool-discovery tools (discover_and_enable_tools, search_tools, enable_tools)
 * are prioritized to the front so the agent can always dynamically discover
 * and enable additional tools even when the full catalog exceeds the limit.
 */
function truncateToolsForChatCompletions<
  T extends { type: string; function?: { name: string } },
>(tools: T[]): T[] {
  if (tools.length <= OPENAI_CHAT_COMPLETIONS_MAX_TOOLS) return tools;

  const priorityTools: T[] = [];
  const remainingTools: T[] = [];

  for (const tool of tools) {
    const toolName = tool.function?.name ?? "";
    if (PRIORITY_TOOL_NAMES.has(toolName)) {
      priorityTools.push(tool);
    } else {
      remainingTools.push(tool);
    }
  }

  const slotsForRemaining =
    OPENAI_CHAT_COMPLETIONS_MAX_TOOLS - priorityTools.length;
  const truncated = [
    ...priorityTools,
    ...remainingTools.slice(0, slotsForRemaining),
  ];

  logger.warn(
    `[OpenAI] Truncated tool count from ${tools.length} to ${truncated.length} ` +
      `(Chat Completions API max: ${OPENAI_CHAT_COMPLETIONS_MAX_TOOLS}). ` +
      `Priority tools preserved: ${priorityTools.map((tool) => tool.function?.name).join(", ") || "none"}`,
  );

  return truncated;
}

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    if (!OPENAI_API_KEY) {
      throw new ProviderError("openai", "OPENAI_API_KEY is not set", 401);
    }
    client = new OpenAI({ apiKey: OPENAI_API_KEY });
  }
  return client;
}

/** OpenAI conversation message (same shape as Google's ConversationMsg) */
export interface OpenAIMessage {
  role: string;
  content?: string;
  name?: string;
  images?: string[];
  toolCalls?: Array<{
    id?: string;
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
    responsesItemId?: string;
    reasoningItem?: {
      id: string;
      summary: Array<{ type: string; text: string }>;
    };
  }>;
  tool_call_id?: string;
  id?: string;
  thinking?: string;
  thinkingSignature?: string;
}

/**
 * OpenAI strict-mode supported JSON Schema keywords (allowlist).
 * Only these keywords survive sanitization — everything else is stripped.
 * This is safer than a denylist: unknown/future keywords are auto-rejected.
 *
 * @see https://platform.openai.com/docs/guides/structured-outputs
 */
const OPENAI_ALLOWED_SCHEMA_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "description",
  "anyOf",
  "$defs",
  "$ref",
]);

/**
 * Recursively sanitize a JSON Schema for OpenAI strict mode (Responses API).
 *
 * OpenAI strict mode requires:
 * - Every type:"object" must have `properties`, `required` (all keys), and `additionalProperties: false`
 * - Nullable types must use `anyOf: [{type:"T"}, {type:"null"}]`, NOT `type: ["T", "null"]`
 * - Forbidden keywords (pattern, minimum, maximum, default, etc.) must be stripped
 * - `anyOf` branches must each be independently valid
 */
function convertArrayTypeSchemaToAnyOf(
  types: string[],
  restProperties: Record<string, unknown>,
  ensureNullable: boolean,
): Record<string, unknown> {
  if (ensureNullable && !types.includes("null")) {
    return {
      anyOf: [
        ...types.map((typeValue: string) => ({
          type: typeValue,
          ...restProperties,
        })),
        { type: "null" },
      ],
    };
  }
  return {
    anyOf: types.map((typeValue: string) => ({
      type: typeValue,
      ...(typeValue !== "null" ? restProperties : {}),
    })),
  };
}

function makePropertySchemaNullable(propertySchema: unknown): unknown {
  if (
    !propertySchema ||
    typeof propertySchema !== "object" ||
    Array.isArray(propertySchema)
  ) {
    return propertySchema;
  }
  const typedPropertySchema = propertySchema as Record<string, unknown>;
  if (typedPropertySchema.anyOf) {
    return propertySchema;
  }
  if (typeof typedPropertySchema.type === "string") {
    const { type: originalType, ...restProperties } = typedPropertySchema;
    return {
      anyOf: [
        { type: originalType, ...restProperties },
        { type: "null" },
      ],
    };
  }
  if (Array.isArray(typedPropertySchema.type)) {
    const types = typedPropertySchema.type as string[];
    const { type: _discardedType, ...restProperties } = typedPropertySchema;
    return convertArrayTypeSchemaToAnyOf(types, restProperties, true);
  }
  return propertySchema;
}

function enforceStrictObjectProperties(cleaned: Record<string, unknown>): void {
  cleaned.additionalProperties = false;
  if (!cleaned.properties || typeof cleaned.properties !== "object") {
    cleaned.properties = {};
    cleaned.required = [];
    return;
  }
  const propertiesMap = cleaned.properties as Record<string, unknown>;
  const propertyKeys = Object.keys(propertiesMap);
  const originalRequired = Array.isArray(cleaned.required)
    ? (cleaned.required as string[])
    : [];
  const newRequired = [...originalRequired];

  for (const propertyKey of propertyKeys) {
    if (!newRequired.includes(propertyKey)) {
      newRequired.push(propertyKey);
      propertiesMap[propertyKey] = makePropertySchemaNullable(
        propertiesMap[propertyKey],
      );
    }
  }

  if (newRequired.length > 0) {
    cleaned.required = newRequired;
  }
}

function isPropertiesSchemaMap(
  isInsidePropertiesMap: boolean,
  key: string,
  value: unknown,
): boolean {
  if (isInsidePropertiesMap || key !== "properties") return false;
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sanitizeSchemaForOpenAI(
  schema: unknown,
  isInsidePropertiesMap = false,
): unknown {
  if (!schema || typeof schema !== "object") return schema;

  if (Array.isArray(schema)) {
    return schema.map((item: unknown) => sanitizeSchemaForOpenAI(item));
  }

  const source = schema as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (!isInsidePropertiesMap && !OPENAI_ALLOWED_SCHEMA_KEYWORDS.has(key))
      continue;

    const recurseAsProperties = isPropertiesSchemaMap(
      isInsidePropertiesMap,
      key,
      value,
    );
    cleaned[key] = sanitizeSchemaForOpenAI(value, recurseAsProperties);
  }

  if (Array.isArray(cleaned.anyOf)) {
    cleaned.anyOf = (cleaned.anyOf as unknown[]).map((branch: unknown) =>
      sanitizeSchemaForOpenAI(branch),
    );
  }

  const isObjectSchema =
    !isInsidePropertiesMap &&
    (cleaned.type === "object" || cleaned.properties !== undefined);
  if (isObjectSchema) {
    enforceStrictObjectProperties(cleaned);
  }

  if (Array.isArray(cleaned.type) && !cleaned.anyOf) {
    const types = cleaned.type as string[];
    const { type: _discardedType, ...restProperties } = cleaned;
    return convertArrayTypeSchemaToAnyOf(types, restProperties, false);
  }

  return cleaned;
}

/**
 * Convert generic tool schemas to OpenAI Responses API format.
 * Input:  [{ name, description, parameters }]
 * Output: [{ type: "function", name, description, parameters }]
 */
function convertToolsToResponsesAPI(
  tools?: ToolSchema[] | null,
): OpenAI.Responses.Tool[] | null {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return null;
  return tools.map(
    (tool: ToolSchema): OpenAI.Responses.Tool => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description || "",
      parameters: sanitizeSchemaForOpenAI(tool.parameters || {}) as Record<
        string,
        unknown
      >,
      strict: true,
    }),
  );
}

/** Narrow any errors into ProviderError for all catch blocks. */
function toProviderError(error: unknown): never {
  let message = String(error);
  let status = 500;
  if (error && typeof error === "object") {
    if (
      "message" in error &&
      typeof (error as { message: unknown }).message === "string"
    ) {
      message = (error as { message: string }).message;
    }
    if (
      "status" in error &&
      typeof (error as { status: unknown }).status === "number"
    ) {
      status = (error as { status: number }).status;
    }
  }
  throw new ProviderError("openai", message, status, error);
}

interface ErrorRecord {
  message?: string;
  status?: number;
  [key: string]: unknown;
}

/** Narrow any catch to a typed error record for retry logic. */
function asErrorRecord(error: unknown): ErrorRecord {
  return error as ErrorRecord;
}
export function normalizeResponsesUsage(
  rawUsage:
    | {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
        output_tokens_details?: { reasoning_tokens?: number };
      }
    | null
    | undefined,
): TokenUsage {
  const usage: TokenUsage = {
    inputTokens: rawUsage?.input_tokens ?? 0,
    outputTokens: rawUsage?.output_tokens ?? 0,
  };

  const cachedTokens = rawUsage?.input_tokens_details?.cached_tokens;
  if (cachedTokens && cachedTokens > 0) {
    usage.cacheReadInputTokens = cachedTokens;
    usage.inputTokens = Math.max(0, (usage.inputTokens ?? 0) - cachedTokens);
  }

  const reasoningTokens = rawUsage?.output_tokens_details?.reasoning_tokens;
  if (reasoningTokens && reasoningTokens > 0) {
    usage.reasoningOutputTokens = reasoningTokens;
  }

  return usage;
}
function decodeBase64AttachmentText(mediaRef: string, mime: string): string {
  try {
    const base64 = mediaRef.split(";base64,")[1];
    const decoded = Buffer.from(base64, "base64").toString("utf-8");
    return `[Attached file (${mime})]:\n${decoded}`;
  } catch {
    return `[Attached file (${mime}): unable to decode]`;
  }
}

function isTextOrJsonMime(mime: string | null | undefined): mime is string {
  if (!mime) return false;
  return mime.startsWith("text/") || mime === "application/json";
}

function convertChatCompletionDataUrlPart(
  mediaRef: string,
): OpenAI.Chat.ChatCompletionContentPart {
  const mime = getDataUrlMimeType(mediaRef);
  if (mime && mime.startsWith("image/")) {
    return { type: "image_url", image_url: { url: mediaRef } };
  }
  if (mime === "application/pdf") {
    return {
      type: "file",
      file: { file_data: mediaRef, filename: "document.pdf" },
    } as OpenAI.Chat.ChatCompletionContentPart;
  }
  if (isTextOrJsonMime(mime)) {
    return {
      type: "text",
      text: decodeBase64AttachmentText(mediaRef, mime),
    };
  }
  return {
    type: "file",
    file: { file_data: mediaRef, filename: "attachment" },
  } as OpenAI.Chat.ChatCompletionContentPart;
}

function convertChatCompletionMediaRef(
  mediaRef: string,
): OpenAI.Chat.ChatCompletionContentPart | null {
  const urlType = getUrlType(mediaRef);
  if (urlType === "data") {
    return convertChatCompletionDataUrlPart(mediaRef);
  }
  if (urlType === "http") {
    const inferredType = inferMimeFromUrl(mediaRef);
    if (inferredType === "image") {
      return { type: "image_url", image_url: { url: mediaRef } };
    }
    return {
      type: "file",
      file: { file_data: mediaRef, filename: "attachment" },
    } as OpenAI.Chat.ChatCompletionContentPart;
  }
  logger.warn(
    `[openai] Skipping unresolved media ref in Chat Completions input: ${mediaRef.substring(0, 60)}...`,
  );
  return null;
}

function buildOpenAIAssistantMessage(
  message: OpenAIMessage,
): OpenAI.Chat.ChatCompletionMessageParam {
  const nameField = message.name ? { name: message.name } : {};
  if (message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      ...nameField,
      content: message.content?.trim() || null,
      tool_calls: message.toolCalls.map((toolCall, i) => ({
        id: toolCall.id || `call_${i}`,
        type: "function" as const,
        function: {
          name: toolCall.name,
          arguments:
            typeof toolCall.args === "string"
              ? toolCall.args
              : JSON.stringify(toolCall.args || {}),
        },
      })),
    };
  }
  return {
    role: "assistant",
    ...nameField,
    content: message.content ?? "",
  };
}

function buildOpenAIUserMessage(
  message: OpenAIMessage,
  nameField: { name?: string },
): OpenAI.Chat.ChatCompletionMessageParam {
  if (message.images && message.images.length > 0) {
    const content: OpenAI.Chat.ChatCompletionContentPart[] = [];
    for (const mediaRef of message.images) {
      const part = convertChatCompletionMediaRef(mediaRef);
      if (part) content.push(part);
    }
    if (message.content) {
      content.push({ type: "text", text: message.content });
    }
    return { role: "user", ...nameField, content };
  }

  return {
    role: "user",
    ...nameField,
    content: message.content ?? "",
  };
}

function prepareSingleOpenAIMessage(
  message: OpenAIMessage,
): OpenAI.Chat.ChatCompletionMessageParam {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.tool_call_id || message.id || "",
      content:
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content ?? ""),
    };
  }

  if (message.role === "assistant") {
    return buildOpenAIAssistantMessage(message);
  }

  const nameField = message.name ? { name: message.name } : {};
  if (message.role === "system" || message.role === "developer") {
    return {
      role: message.role,
      ...nameField,
      content: message.content ?? "",
    };
  }

  return buildOpenAIUserMessage(message, nameField);
}

function prepareOpenAIMessages(
  messages: OpenAIMessage[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map(prepareSingleOpenAIMessage);
}

function resolveResponsesFunctionCallId(
  toolCall: NonNullable<OpenAIMessage["toolCalls"]>[number],
): string {
  if (toolCall.responsesItemId?.startsWith("fc")) {
    return toolCall.responsesItemId;
  }
  if (toolCall.id?.startsWith("fc")) {
    return toolCall.id;
  }
  if (toolCall.id?.startsWith("call_")) {
    return toolCall.id.replace(/^call_/, "fc_");
  }
  const secureRandomString = Math.random().toString(36).substring(2, 10);
  return `fc_${toolCall.id || secureRandomString}`;
}

function appendResponsesAssistantToolCallItems(
  message: OpenAIMessage,
  result: OpenAI.Responses.ResponseInputItem[],
): void {
  if (message.content?.trim()) {
    result.push({
      role: "assistant",
      content: message.content,
    } as OpenAI.Responses.ResponseInputItem);
  }
  const toolCalls = message.toolCalls || [];
  for (const toolCall of toolCalls) {
    if (toolCall.reasoningItem) {
      result.push({
        type: "reasoning",
        id: toolCall.reasoningItem.id,
        summary: toolCall.reasoningItem.summary,
      } as unknown as OpenAI.Responses.ResponseInputItem);
    }
    const functionCallId = resolveResponsesFunctionCallId(toolCall);
    result.push({
      type: "function_call",
      id: functionCallId,
      call_id: toolCall.id || functionCallId,
      name: toolCall.name,
      arguments:
        typeof toolCall.args === "string"
          ? toolCall.args
          : JSON.stringify(toolCall.args || {}),
    } as OpenAI.Responses.ResponseFunctionToolCall as unknown as OpenAI.Responses.ResponseInputItem);
  }
  for (const toolCall of toolCalls) {
    if (toolCall.result === undefined) continue;
    const fallbackFcId = toolCall.responsesItemId?.startsWith("fc")
      ? toolCall.responsesItemId
      : `fc_${toolCall.responsesItemId || ""}`;
    const outputCallId = toolCall.id || fallbackFcId;
    const resultString =
      typeof toolCall.result === "string"
        ? toolCall.result
        : JSON.stringify(toolCall.result);
    result.push({
      type: "function_call_output",
      call_id: outputCallId,
      output: resultString,
    } as unknown as OpenAI.Responses.ResponseInputItem);
  }
}

function convertResponsesDataUrlContent(
  mediaRef: string,
): OpenAI.Responses.ResponseInputContent {
  const mime = getDataUrlMimeType(mediaRef);
  if (mime && mime.startsWith("image/")) {
    return {
      type: "input_image",
      image_url: mediaRef,
      detail: "auto",
    };
  }
  const isDocxOrPdf =
    mime === "application/pdf" ||
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (isDocxOrPdf) {
    return {
      type: "input_file",
      file_data: mediaRef,
      filename: "document.pdf",
    };
  }
  if (isTextOrJsonMime(mime)) {
    return {
      type: "input_text",
      text: decodeBase64AttachmentText(mediaRef, mime),
    };
  }
  return {
    type: "input_file",
    file_data: mediaRef,
    filename: "attachment",
  };
}

function convertResponsesMediaRef(
  mediaRef: string,
): OpenAI.Responses.ResponseInputContent | null {
  const urlType = getUrlType(mediaRef);
  if (urlType === "data") {
    return convertResponsesDataUrlContent(mediaRef);
  }
  if (urlType === "http") {
    const inferredType = inferMimeFromUrl(mediaRef);
    if (inferredType === "image") {
      return {
        type: "input_image",
        image_url: mediaRef,
        detail: "auto",
      };
    }
    return { type: "input_file", file_url: mediaRef };
  }
  logger.warn(
    `[openai] Skipping unresolved media ref in Responses API input: ${mediaRef.substring(0, 60)}...`,
  );
  return null;
}

/**
 * Convert messages to Responses API input format.
 * System messages become developer messages; images use input_image, PDFs use input_file.
 */
export function prepareResponsesInput(
  messages: OpenAIMessage[],
): OpenAI.Responses.ResponseInputItem[] {
  const result: OpenAI.Responses.ResponseInputItem[] = [];
  for (const message of messages) {
    if (
      message.role === "assistant" &&
      message.toolCalls &&
      message.toolCalls.length > 0
    ) {
      appendResponsesAssistantToolCallItems(message, result);
      continue;
    }

    if (message.role === "tool") {
      result.push({
        type: "function_call_output",
        call_id: message.tool_call_id || message.id,
        output:
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content || ""),
      } as unknown as OpenAI.Responses.ResponseInputItem);
      continue;
    }

    const role =
      message.role === "system"
        ? ("developer" as const)
        : (message.role as "developer" | "user" | "assistant");
    const nameObject = message.name ? { name: message.name } : {};

    if (message.images && message.images.length > 0) {
      const content: OpenAI.Responses.ResponseInputContent[] = [];
      for (const mediaRef of message.images) {
        const part = convertResponsesMediaRef(mediaRef);
        if (part) content.push(part);
      }
      if (message.content) {
        content.push({ type: "input_text", text: message.content });
      }
      result.push({
        role,
        ...nameObject,
        content,
      } as OpenAI.Responses.ResponseInputItem);
      continue;
    }

    result.push({
      role,
      ...nameObject,
      content: message.content ?? "",
    } as OpenAI.Responses.ResponseInputItem);
  }
  return result;
}

// ── Request payload builders ──────────────────────────────────

/** Responses API payload shared by the streaming and non-streaming paths. */
function buildResponsesPayload(
  messages: OpenAIMessage[],
  model: string,
  options: ProviderOptions,
  stream: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model,
    input: prepareResponsesInput(messages),
  };
  if (stream) payload.stream = true;

  applyResponsesReasoning(payload, options);
  applyResponsesTextConfig(payload, options);
  if (options.maxTokens) payload.max_output_tokens = options.maxTokens;
  // Seed for reproducibility
  if (options.seed !== undefined) {
    payload.seed =
      typeof options.seed === "number"
        ? options.seed
        : parseInt(String(options.seed), 10);
  }
  // Service tier: auto / default / priority
  if (options.serviceTier) payload.service_tier = options.serviceTier;
  applyResponsesSampling(payload, options);
  applyResponsesTools(payload, options);
  return payload;
}

function applyResponsesReasoning(
  payload: Record<string, unknown>,
  options: ProviderOptions,
) {
  const reasoning: Reasoning = {};
  if (options.reasoningEffort) {
    reasoning.effort = options.reasoningEffort as ReasoningEffort;
  }
  if (options.reasoningSummary) {
    reasoning.summary = options.reasoningSummary as
      | "auto"
      | "concise"
      | "detailed";
  } else if (reasoning.effort) {
    reasoning.summary = "auto";
  }
  if (Object.keys(reasoning).length > 0) payload.reasoning = reasoning;
}

function applyResponsesTextConfig(
  payload: Record<string, unknown>,
  options: ProviderOptions,
) {
  const text: OpenAI.Responses.ResponseTextConfig = {};
  if (options.verbosity) {
    text.format = { type: "text" };
    text.verbosity = options.verbosity as "low" | "medium" | "high";
  }
  if (options.responseFormat === "json_object") {
    text.format = { type: "json_object" };
  } else if (
    options.responseFormat === "json_schema" &&
    options.responseSchema
  ) {
    text.format = {
      type: "json_schema",
      json_schema: options.responseSchema,
    } as unknown as OpenAI.Responses.ResponseFormatTextJSONSchemaConfig;
  }
  if (Object.keys(text).length > 0) payload.text = text;
}

/** Temperature/topP only work with reasoning.effort=none. */
function applyResponsesSampling(
  payload: Record<string, unknown>,
  options: ProviderOptions,
) {
  if (options.reasoningEffort !== "none") return;
  if (options.temperature !== undefined)
    payload.temperature = options.temperature;
  if (options.topP !== undefined) payload.top_p = options.topP;
  if (options.frequencyPenalty !== undefined)
    payload.frequency_penalty = options.frequencyPenalty;
  if (options.presencePenalty !== undefined)
    payload.presence_penalty = options.presencePenalty;
  if (options.stopSequences !== undefined)
    payload.stop = options.stopSequences;
}

function applyResponsesTools(
  payload: Record<string, unknown>,
  options: ProviderOptions,
) {
  if (options.webSearch) {
    payload.tools = [{ type: "web_search" }];
  }
  const customTools = convertToolsToResponsesAPI(
    options.tools as ToolSchema[] | null | undefined,
  );
  if (customTools) {
    // Built above as the Responses tool array.
    const existingTools = (payload.tools ?? []) as OpenAI.Responses.Tool[];
    payload.tools = [...existingTools, ...customTools];
  }
  // Parallel tool calls — defaults to true; set false for sequential FC
  if (options.parallelToolCalls === false) {
    payload.parallel_tool_calls = false;
  }
  // Response persistence — defaults to true; set false for privacy
  if (options.store === false) payload.store = false;
  // Log probabilities — top N candidate tokens per step
  if (options.topLogprobs && options.topLogprobs > 0) {
    payload.top_logprobs = options.topLogprobs;
  }
}

/** Chat Completions payload shared by the streaming and non-streaming paths. */
function buildChatCompletionsPayload(
  messages: OpenAIMessage[],
  model: string,
  options: ProviderOptions,
  stream: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model,
    messages: prepareOpenAIMessages(messages),
  };
  if (stream) {
    payload.stream = true;
    payload.stream_options = { include_usage: true };
  }

  applyChatSampling(payload, options, isReasoningModel(model));
  // Seed for reproducibility
  if (options.seed !== undefined) {
    payload.seed =
      typeof options.seed === "number"
        ? options.seed
        : parseInt(String(options.seed), 10);
  }
  // Service tier: auto / default / priority
  if (options.serviceTier) payload.service_tier = options.serviceTier;
  // Response format (JSON mode)
  if (options.responseFormat === "json_object") {
    payload.response_format = { type: "json_object" };
  }
  applyChatTools(payload, options);
  return payload;
}

function applyChatSampling(
  payload: Record<string, unknown>,
  options: ProviderOptions,
  isReasoning: boolean,
) {
  if (isReasoning) {
    if (options.maxTokens) payload.max_completion_tokens = options.maxTokens;
    if (options.reasoningEffort) {
      payload.reasoning_effort = options.reasoningEffort;
    }
    return;
  }
  if (options.temperature !== undefined)
    payload.temperature = options.temperature;
  if (options.topP !== undefined) payload.top_p = options.topP;
  if (options.frequencyPenalty !== undefined)
    payload.frequency_penalty = options.frequencyPenalty;
  if (options.presencePenalty !== undefined)
    payload.presence_penalty = options.presencePenalty;
  if (options.stopSequences !== undefined)
    payload.stop = options.stopSequences;
  if (options.maxTokens) payload.max_completion_tokens = options.maxTokens;
}

function applyChatTools(
  payload: Record<string, unknown>,
  options: ProviderOptions,
) {
  if (options.webSearch) {
    payload.tools = [{ type: "web_search" }];
  }
  // Custom function calling tools — truncate to 128 max for Chat Completions API
  const customTools = convertToolsToOpenAI(
    options.tools as ToolSchema[] | null | undefined,
  ) as OpenAI.Chat.ChatCompletionTool[] | null;
  if (customTools) {
    // Built above as the Chat Completions tool array.
    const existingTools = (payload.tools ?? []) as OpenAI.Chat.ChatCompletionTool[];
    payload.tools = truncateToolsForChatCompletions([
      ...existingTools,
      ...customTools,
    ]);
  }
}

/**
 * Retry once after stripping parameters the model rejects (e.g. gpt-5-nano
 * refuses temperature). Returns whether anything was stripped.
 */
function stripUnsupportedChatParams(
  payload: Record<string, unknown>,
  errorObject: ErrorRecord,
  model: string,
  retryLabel: string,
): boolean {
  if (
    errorObject.status !== 400 ||
    !errorObject.message?.includes("Unsupported")
  ) {
    return false;
  }
  const unsupportedParams = [
    "temperature",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
    "max_completion_tokens",
  ];
  let stripped = false;
  for (const param of unsupportedParams) {
    if (
      errorObject.message?.includes(`'${param}'`) &&
      payload[param] !== undefined
    ) {
      logger.provider(
        "OpenAI",
        `Stripping unsupported param '${param}' for ${model} and retrying${retryLabel}`,
      );
      delete payload[param];
      stripped = true;
    }
  }
  return stripped;
}

/** Images and function calls from a completed Responses API response. */
interface ResponsesExtractedOutput {
  images: Array<{ type: string; data: string; mimeType: string }>;
  toolCalls: Array<{
    id: string;
    responsesItemId?: string;
    name: string;
    args: Record<string, unknown>;
    reasoningItem?: {
      id: string;
      summary: Array<{ type: string; text: string }>;
    };
  }>;
}

function extractResponsesOutput(
  output: OpenAI.Responses.ResponseOutputItem[] | undefined,
): ResponsesExtractedOutput {
  const images: ResponsesExtractedOutput["images"] = [];
  const toolCalls: ResponsesExtractedOutput["toolCalls"] = [];
  if (!output) return { images, toolCalls };

  // Track pending reasoning items to pair with subsequent function calls
  const pendingReasoningItems: Array<{
    id: string;
    summary: Array<{ type: string; text: string }>;
  }> = [];
  for (const item of output) {
    if (item.type === "image_generation_call" && item.result) {
      images.push({
        type: "image",
        data: item.result,
        mimeType: "image/png",
      });
    } else if (item.type === "reasoning") {
      if (item.id) {
        pendingReasoningItems.push({
          id: item.id,
          summary: item.summary || [],
        });
      }
    } else if (item.type === "function_call") {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(item.arguments || "{}");
      } catch {
        /* ignore */
      }
      const pairedReasoningItem = pendingReasoningItems.shift();
      toolCalls.push({
        id: item.call_id,
        responsesItemId: item.id,
        name: item.name,
        args,
        ...(pairedReasoningItem ? { reasoningItem: pairedReasoningItem } : {}),
      });
    }
  }
  return { images, toolCalls };
}

// ── Responses stream reducers ─────────────────────────────────

type ResponsesStreamYield = Record<string, unknown> | string;

interface ResponsesStreamState {
  usage: TokenUsage | null;
  // Track function names from output_item.added events; the arguments.done
  // event may not include the name property (known OpenAI SDK issue).
  pendingFunctions: Record<
    string,
    { name: string; callId: string; args: string }
  >;
  pendingReasoningItems: Array<{
    id: string;
    summary: Array<{ type: string; text: string }>;
  }>;
  reasoningSummaryAccumulator: Record<string, string>;
}

function createResponsesStreamState(): ResponsesStreamState {
  return {
    usage: null,
    pendingFunctions: {},
    pendingReasoningItems: [],
    reasoningSummaryAccumulator: {},
  };
}

function reduceResponsesStreamEvent(
  state: ResponsesStreamState,
  event: OpenAI.Responses.ResponseStreamEvent,
): ResponsesStreamYield[] {
  switch (event.type) {
    case "response.output_text.delta":
      return [event.delta || ""];
    case "response.reasoning_summary_text.delta":
      return reduceResponsesReasoningDelta(state, event);
    case "response.image_generation_call.completed": {
      // SDK type omits the generated image payload; it is present on the wire.
      const imageEvent = event as OpenAI.Responses.ResponseImageGenCallCompletedEvent & {
        result?: string;
      };
      return imageEvent.result
        ? [{ type: "image", data: imageEvent.result, mimeType: "image/png" }]
        : [];
    }
    case "response.output_item.added":
      return reduceResponsesItemAdded(state, event);
    case "response.function_call_arguments.delta":
      return reduceResponsesArgumentsDelta(state, event);
    case "response.function_call_arguments.done":
      return reduceResponsesArgumentsDone(state, event);
    case "response.completed":
      return reduceResponsesCompleted(state, event);
    default:
      return [];
  }
}

/** Reasoning summaries are accumulated so the item can be reconstructed. */
function reduceResponsesReasoningDelta(
  state: ResponsesStreamState,
  event: OpenAI.Responses.ResponseReasoningSummaryTextDeltaEvent,
): ResponsesStreamYield[] {
  const itemId = event.item_id;
  if (itemId) {
    state.reasoningSummaryAccumulator[itemId] =
      (state.reasoningSummaryAccumulator[itemId] || "") +
      (event.delta || "");
  }
  return [{ type: "thinking", content: event.delta || "" }];
}

/** Track reasoning and function-call metadata from output_item.added. */
function reduceResponsesItemAdded(
  state: ResponsesStreamState,
  event: OpenAI.Responses.ResponseOutputItemAddedEvent,
): ResponsesStreamYield[] {
  const item = event.item;
  if (item?.type === "reasoning") {
    if (item.id) {
      state.pendingReasoningItems.push({
        id: item.id,
        summary: item.summary || [],
      });
    }
    return [];
  }
  if (item?.type === "function_call") {
    if (!item.id) return [];
    state.pendingFunctions[item.id] = {
      name: item.name,
      callId: item.call_id,
      args: "",
    };
    return item.name && item.call_id
      ? [{ type: "toolCallStart", id: item.call_id, name: item.name }]
      : [];
  }
  return [];
}

/** Accumulate argument deltas (keyed by item_id). */
function reduceResponsesArgumentsDelta(
  state: ResponsesStreamState,
  event: OpenAI.Responses.ResponseFunctionCallArgumentsDeltaEvent,
): ResponsesStreamYield[] {
  const entry = state.pendingFunctions[event.item_id];
  const partial = event.delta || "";
  if (entry) entry.args += partial;
  // Progress event keeps generation throughput tracking alive during FC
  // argument streaming.
  return partial.length > 0
    ? [{ type: "toolCallDelta", characters: partial.length }]
    : [];
}

/** Pop the most recent pending reasoning item and finalize its summary. */
function takePendingReasoningItem(state: ResponsesStreamState):
  | { id: string; summary: Array<{ type: string; text: string }> }
  | undefined {
  if (state.pendingReasoningItems.length === 0) return undefined;
  const pairedReasoningItem = state.pendingReasoningItems.shift();
  if (!pairedReasoningItem) return undefined;
  const accumulatedText =
    state.reasoningSummaryAccumulator[pairedReasoningItem.id];
  if (accumulatedText) {
    pairedReasoningItem.summary = [
      { type: "summary_text", text: accumulatedText },
    ];
    delete state.reasoningSummaryAccumulator[pairedReasoningItem.id];
  }
  return pairedReasoningItem;
}

function reduceResponsesArgumentsDone(
  state: ResponsesStreamState,
  event: OpenAI.Responses.ResponseFunctionCallArgumentsDoneEvent,
): ResponsesStreamYield[] {
  // SDK type omits call_id on this event; it is present on the wire.
  const doneEvent = event as OpenAI.Responses.ResponseFunctionCallArgumentsDoneEvent & {
    call_id?: string;
  };
  const tracked = state.pendingFunctions[doneEvent.item_id];
  const name = tracked?.name || doneEvent.name || "unknown";
  const callId = tracked?.callId || doneEvent.call_id || doneEvent.item_id;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(doneEvent.arguments || tracked?.args || "{}");
  } catch {
    /* ignore */
  }
  const pairedReasoningItem = takePendingReasoningItem(state);
  const toolCall: Record<string, unknown> = {
    type: "toolCall",
    id: callId,
    // Responses API internal item ID (starts with "fc_")
    responsesItemId: doneEvent.item_id,
    name,
    args,
  };
  if (pairedReasoningItem) toolCall.reasoningItem = pairedReasoningItem;
  delete state.pendingFunctions[doneEvent.item_id];
  return [toolCall];
}

/** Completed response — extract usage and detect max_output_tokens truncation. */
function reduceResponsesCompleted(
  state: ResponsesStreamState,
  event: OpenAI.Responses.ResponseCompletedEvent,
): ResponsesStreamYield[] {
  if (event.response?.usage) {
    state.usage = normalizeResponsesUsage(event.response.usage);
  }
  const status = event.response?.status;
  const incompleteDetails = event.response?.incomplete_details;
  if (
    status === "incomplete" ||
    incompleteDetails?.reason === "max_output_tokens"
  ) {
    return [{ type: "stopReason", stopReason: "length" }];
  }
  return [];
}

// ── Chat Completions stream reducers ──────────────────────────

interface ChatCompletionsStreamState {
  usage: TokenUsage | null;
  lastFinishReason: string | null;
  pendingToolCalls: Record<
    number,
    { id: string; name: string; args: string; startEmitted: boolean }
  >;
}

function createChatCompletionsStreamState(): ChatCompletionsStreamState {
  return { usage: null, lastFinishReason: null, pendingToolCalls: {} };
}

function reduceChatCompletionChunk(
  state: ChatCompletionsStreamState,
  chunk: OpenAI.Chat.ChatCompletionChunk,
): ResponsesStreamYield[] {
  const events: ResponsesStreamYield[] = [];
  if (chunk.usage) state.usage = normalizeUsage(chunk.usage);

  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  if (delta?.content) events.push(delta.content);

  // Track the last finish_reason for truncation detection
  if (choice?.finish_reason) state.lastFinishReason = choice.finish_reason;

  if (delta?.tool_calls) {
    const { starts, deltaChars } = accumulateChatToolCalls(
      state,
      delta.tool_calls,
    );
    events.push(...starts);
    // Progress event keeps generation throughput tracking alive during FC
    // argument streaming.
    if (deltaChars > 0) {
      events.push({ type: "toolCallDelta", characters: deltaChars });
    }
  }

  // If finish_reason is "tool_calls", yield accumulated tool calls
  if (choice?.finish_reason === "tool_calls") {
    events.push(...finalizeChatToolCalls(state));
  }
  return events;
}

/** Merge streamed tool-call fragments; emit the disclosure once id+name land. */
function accumulateChatToolCalls(
  state: ChatCompletionsStreamState,
  toolCalls: OpenAI.Chat.ChatCompletionChunk.Choice.Delta.ToolCall[],
): { starts: ResponsesStreamYield[]; deltaChars: number } {
  const starts: ResponsesStreamYield[] = [];
  let deltaChars = 0;
  for (const toolCall of toolCalls) {
    const index = toolCall.index;
    if (!state.pendingToolCalls[index]) {
      state.pendingToolCalls[index] = {
        id: toolCall.id || "",
        name: toolCall.function?.name || "",
        args: "",
        startEmitted: false,
      };
    }
    const pending = state.pendingToolCalls[index];
    if (toolCall.id) pending.id = toolCall.id;
    if (toolCall.function?.name) pending.name = toolCall.function.name;
    if (toolCall.function?.arguments) {
      pending.args += toolCall.function.arguments;
      deltaChars += toolCall.function.arguments.length;
    }
    if (!pending.startEmitted && pending.name && pending.id) {
      pending.startEmitted = true;
      starts.push({ type: "toolCallStart", id: pending.id, name: pending.name });
    }
  }
  return { starts, deltaChars };
}

function finalizeChatToolCalls(
  state: ChatCompletionsStreamState,
): ResponsesStreamYield[] {
  const events: ResponsesStreamYield[] = [];
  for (const toolCall of Object.values(state.pendingToolCalls)) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(toolCall.args || "{}");
    } catch {
      /* ignore */
    }
    events.push({
      type: "toolCall",
      id: toolCall.id,
      name: toolCall.name,
      args,
    });
  }
  return events;
}

const openaiProvider = {
  name: "openai",

  async generateText(
    messages: OpenAIMessage[],
    model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT).openai,
    options: ProviderOptions = {},
  ) {
    logger.provider("OpenAI", `generateText model=${model}`);
    // OpenAI takes the identity prompt in-band: put it first (see
    // prependIdentitySystemMessage).
    const effectiveMessages = prependIdentitySystemMessage(messages, options.systemPrompt);
    try {
      if (useResponsesAPI(model)) {
        return await this._generateTextResponses(effectiveMessages, model, options);
      }
      return await this._generateTextChatCompletions(effectiveMessages, model, options);
    } catch (error: unknown) {
      toProviderError(error);
    }
  },
  async _generateTextResponses(
    messages: OpenAIMessage[],
    model: string,
    options: ProviderOptions,
  ) {
    const payload = buildResponsesPayload(messages, model, options, false);
    // Built above as a Responses API payload.
    const request = payload as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming & {
      seed?: number;
      frequency_penalty?: number;
      presence_penalty?: number;
      stop?: string[];
    };

    logger.info(
      `[OpenAI/Responses] Sending non-stream payload: ${JSON.stringify(request)}`,
    );

    const { data: response, response: rawResponse } = await getClient()
      .responses.create(request)
      .withResponse();

    // Extract rate-limit headers
    const rateLimits = extractOpenAIRateLimits(rawResponse, model);
    const { images, toolCalls } = extractResponsesOutput(response.output);

    const result: Record<string, unknown> = {
      text: response.output_text || "",
      images,
      usage: normalizeResponsesUsage(response.usage),
    };
    if (toolCalls.length > 0) result.toolCalls = toolCalls;
    if (rateLimits) result.rateLimits = rateLimits;
    return result;
  },
  async _generateTextChatCompletions(
    messages: OpenAIMessage[],
    model: string,
    options: ProviderOptions,
  ) {
    const payload = buildChatCompletionsPayload(messages, model, options, false);
    // Built above as Chat Completions params.
    const request = payload as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

    try {
      const { data: response, response: rawResponse } = await getClient()
        .chat.completions.create(request)
        .withResponse();
      const rateLimits = extractOpenAIRateLimits(rawResponse, model);
      const message = response.choices[0].message;
      const result: Record<string, unknown> = {
        text: message.content || "",
        usage: normalizeUsage(response.usage),
      };
      if (message.tool_calls && message.tool_calls.length > 0) {
        result.toolCalls = message.tool_calls.map((toolCall) => {
          if (toolCall.type === "function") {
            const toolFunction = toolCall.function;
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(toolFunction.arguments || "{}");
            } catch {
              /* ignore */
            }
            return {
              id: toolCall.id,
              name: toolFunction.name || "",
              args,
            };
          }
          return {
            id: toolCall.id,
            name: "",
            args: {},
          };
        });
      }
      if (rateLimits) result.rateLimits = rateLimits;
      return result;
    } catch (error: unknown) {
      const errorObject = asErrorRecord(error);
      // Retry once after stripping unsupported parameters (e.g. gpt-5-nano rejects temperature)
      if (stripUnsupportedChatParams(payload, errorObject, model, "")) {
        const response = await getClient().chat.completions.create(request);
        return {
          text: response.choices[0].message.content,
          usage: normalizeUsage(response.usage),
        };
      }
      throw error;
    }
  },
  async *generateTextStream(
    messages: OpenAIMessage[],
    model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT).openai,
    options: ProviderOptions = {},
  ) {
    logger.provider("OpenAI", `generateTextStream model=${model}`);
    const effectiveMessages = prependIdentitySystemMessage(messages, options.systemPrompt);
    try {
      if (useResponsesAPI(model)) {
        yield* this._streamResponses(effectiveMessages, model, options);
      } else {
        yield* this._streamChatCompletions(effectiveMessages, model, options);
      }
    } catch (error: unknown) {
      if (
        error &&
        typeof error === "object" &&
        "name" in error &&
        error instanceof Error &&
        error.name === "AbortError"
      )
        return;
      toProviderError(error);
    }
  },
  async *_streamResponses(
    messages: OpenAIMessage[],
    model: string,
    options: ProviderOptions,
  ) {
    const payload = buildResponsesPayload(messages, model, options, true);
    // Built above as a streaming Responses API payload.
    const request = payload as unknown as OpenAI.Responses.ResponseCreateParamsStreaming & {
      seed?: number;
      frequency_penalty?: number;
      presence_penalty?: number;
      stop?: string[];
    };

    logger.info(
      `[OpenAI/Responses] Sending stream payload: ${JSON.stringify(request)}`,
    );

    const { data: streamData, response: rawStreamResponse } = await getClient()
      .responses.create(request, {
        ...(options.signal && { signal: options.signal }),
      })
      .withResponse();
    const rateLimits = extractOpenAIRateLimits(rawStreamResponse, model);

    const state = createResponsesStreamState();
    for await (const event of streamData) {
      if (options.signal?.aborted) break;
      yield* reduceResponsesStreamEvent(state, event);
    }
    yield {
      type: "usage",
      usage: state.usage ?? { inputTokens: 0, outputTokens: 0 },
    };
    if (rateLimits) {
      yield { type: "rateLimits", rateLimits };
    }
  },
  async *_streamChatCompletions(
    messages: OpenAIMessage[],
    model: string,
    options: ProviderOptions,
  ) {
    const payload = buildChatCompletionsPayload(messages, model, options, true);
    // Built above as streaming Chat Completions params.
    const request = payload as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming;

    let stream: Stream<OpenAI.Chat.ChatCompletionChunk>;
    let rateLimits: OpenAIRateLimits | null = null;
    try {
      const { data: streamData, response: rawStreamResponse } = await getClient()
        .chat.completions.create(request, {
          ...(options.signal && { signal: options.signal }),
        })
        .withResponse();
      stream = streamData;
      rateLimits = extractOpenAIRateLimits(rawStreamResponse, model);
    } catch (error: unknown) {
      const errorObject = asErrorRecord(error);
      // Retry once after stripping unsupported parameters (e.g. gpt-5-nano rejects temperature)
      if (!stripUnsupportedChatParams(payload, errorObject, model, " (stream)")) {
        throw error;
      }
      const retryResult = await getClient()
        .chat.completions.create(request, {
          ...(options.signal && { signal: options.signal }),
        })
        .withResponse();
      stream = retryResult.data;
      rateLimits = extractOpenAIRateLimits(retryResult.response, model);
    }

    const state = createChatCompletionsStreamState();
    for await (const chunk of stream) {
      if (options.signal?.aborted) break;
      yield* reduceChatCompletionChunk(state, chunk);
    }

    // Surface max_tokens truncation so harnesses can detect and warn the user
    if (state.lastFinishReason === "length") {
      yield { type: "stopReason", stopReason: "length" };
    }
    yield {
      type: "usage",
      usage: state.usage ?? { inputTokens: 0, outputTokens: 0 },
    };
    if (rateLimits) {
      yield { type: "rateLimits", rateLimits };
    }
  },
  async generateSpeech(
    text: string,
    voice: string = DEFAULT_VOICES.openai,
    options: ProviderOptions = {},
  ) {
    logger.provider("OpenAI", `generateSpeech voice=${voice}`);
    try {
      const payload: OpenAI.Audio.SpeechCreateParams & {
        instructions?: string;
      } = {
        model:
          options.model || getDefaultModels(TYPES.TEXT, TYPES.AUDIO).openai,
        voice: voice as OpenAI.Audio.SpeechCreateParams["voice"],
        input: text,
        response_format:
          (options.format as "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm") ||
          "mp3",
      };
      if (options.instructions) {
        payload.instructions = options.instructions;
      }
      const response = await getClient().audio.speech.create(payload);
      return { stream: response.body, contentType: "audio/mpeg" };
    } catch (error: unknown) {
      toProviderError(error);
    }
  },

  async generateImage(
    prompt: string,
    images: Array<string | { imageData: string; mimeType?: string }> = [],
    model: string = MODELS.GPT_IMAGE_15.name,
  ) {
    logger.provider(
      "OpenAI",
      `generateImage model=${model} images=${images.length}`,
    );
    try {
      let response: OpenAI.Images.ImagesResponse;

      if (images.length > 0) {
        // Use the edit endpoint when input images are provided
        // Take the last image in conversation as the one to edit
        const lastImage = images[images.length - 1];
        let imageBuffer: Buffer, mimeType: string;

        if (typeof lastImage === "string") {
          // Data URL format: data:image/png;base64,...
          const base64Match = lastImage.match(/^data:([^;]+);base64,(.+)$/);
          if (!base64Match) {
            throw new Error("Invalid image data format");
          }
          imageBuffer = Buffer.from(base64Match[2], "base64");
          mimeType = base64Match[1];
        } else if (
          lastImage &&
          typeof lastImage === "object" &&
          "imageData" in lastImage
        ) {
          // Object format: { imageData: base64, mimeType }
          imageBuffer = Buffer.from(lastImage.imageData, "base64");
          mimeType = lastImage.mimeType || "image/png";
        } else {
          throw new Error("Invalid image data format");
        }
        const ext = mimeType.split("/")[1] || "png";
        const imageFile = await toFile(imageBuffer, `input.${ext}`, {
          type: mimeType,
        });

        response = await getClient().images.edit({
          model,
          prompt,
          image: imageFile,
          size: "1024x1024",
        });
      } else {
        // Generate new image
        response = await getClient().images.generate({
          model,
          prompt,
          output_format: "png",
          size: "1024x1024",
          quality: "high",
        });
      }

      const firstImage = response.data?.[0];
      const imageData =
        firstImage?.b64_json ||
        (firstImage as unknown as Record<string, unknown>)?.b64 ||
        (response as unknown as Record<string, unknown>)?.b64;
      if (!imageData) {
        throw new Error("No image data received from OpenAI");
      }
      return {
        imageData,
        mimeType: "image/png",
        text: response.data?.[0]?.revised_prompt || "",
      };
    } catch (error: unknown) {
      toProviderError(error);
    }
  },

  async captionImage(
    images: string[],
    prompt: string = "What's in this image?",
    model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT).openai,
    systemPrompt?: string,
  ) {
    logger.provider("OpenAI", `captionImage model=${model}`);
    try {
      const content: OpenAI.Chat.ChatCompletionContentPart[] = [
        { type: "text" as const, text: prompt },
        ...images.map(
          (image: string): OpenAI.Chat.ChatCompletionContentPartImage => ({
            type: "image_url" as const,
            image_url: { url: image },
          }),
        ),
      ];
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
      if (systemPrompt) {
        messages.push({ role: "system" as const, content: systemPrompt });
      }
      messages.push({ role: "user" as const, content });
      const response = await getClient().chat.completions.create({
        model,
        messages,
        max_completion_tokens: 1000,
      });
      const usage = normalizeUsage(response.usage);
      return { text: response.choices[0].message.content, usage };
    } catch (error: unknown) {
      toProviderError(error);
    }
  },

  async generateEmbedding(
    text: string,
    model: string = getDefaultModels(TYPES.TEXT, TYPES.EMBEDDING).openai,
  ) {
    logger.provider("OpenAI", `generateEmbedding model=${model}`);
    try {
      const response = await getClient().embeddings.create({
        model,
        input: text,
      });
      return { embedding: response.data[0].embedding };
    } catch (error: unknown) {
      toProviderError(error);
    }
  },

  async transcribeAudio(
    audioBuffer: Buffer,
    mimeType: string,
    model: string = (OPENAI_TRANSCRIPTION_MODEL as string) || "whisper-1",
    options: ProviderOptions = {},
  ) {
    logger.provider("OpenAI", `transcribeAudio model=${model}`);
    try {
      const subType = mimeType.split("/")[1] || "wav";
      const ext = ["wav", "mp3", "opus", "aac", "flac", "pcm"].includes(subType)
        ? (subType as "wav" | "mp3" | "opus" | "aac" | "flac" | "pcm")
        : "wav";
      const file = await toFile(audioBuffer, `audio.${ext}`, {
        type: mimeType,
      });
      const payload: OpenAI.Audio.Transcriptions.TranscriptionCreateParamsNonStreaming =
        {
          file,
          model,
        };
      if (options.language) payload.language = options.language;
      if (options.prompt) payload.prompt = options.prompt as string;

      const response = await getClient().audio.transcriptions.create(payload);
      const usage: Record<string, number> = {};
      const responseUsage = response.usage;
      if (responseUsage) {
        if (responseUsage.type === "tokens") {
          usage.inputTokens = responseUsage.input_tokens ?? 0;
          usage.outputTokens = responseUsage.output_tokens ?? 0;
        } else if (responseUsage.type === "duration") {
          usage.durationSeconds = responseUsage.seconds ?? 0;
        }
      }
      return {
        text: response.text,
        usage,
      };
    } catch (error: unknown) {
      toProviderError(error);
    }
  },
};

export default openaiProvider;
