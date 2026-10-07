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
    // Inside a `properties` map, keys are user-defined field names (e.g. "count", "name"),
    // NOT JSON Schema keywords — so we skip the allowlist filter and recurse into each
    // property schema. At all other levels, strip unrecognized keywords.
    if (!isInsidePropertiesMap && !OPENAI_ALLOWED_SCHEMA_KEYWORDS.has(key))
      continue;

    // When we encounter the schema keyword "properties" at the SCHEMA level (not inside
    // a properties map), its value is a map of field-name → schema. We recurse with
    // isInsidePropertiesMap = true so field names aren't filtered by the allowlist.
    // If we're ALREADY inside a properties map and a field is named "properties",
    // it's just a regular field name whose value is a schema — recurse normally.
    if (
      !isInsidePropertiesMap &&
      key === "properties" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      cleaned[key] = sanitizeSchemaForOpenAI(value, true);
    } else {
      cleaned[key] = sanitizeSchemaForOpenAI(value);
    }
  }

  // Sanitize anyOf branches (each must be a valid strict-mode schema)
  if (Array.isArray(cleaned.anyOf)) {
    cleaned.anyOf = (cleaned.anyOf as unknown[]).map((branch: unknown) =>
      sanitizeSchemaForOpenAI(branch),
    );
  }

  // Handle type:"object" — enforce strict mode properties/required/additionalProperties.
  // Only apply at the schema level, NOT when processing a properties map (where keys are
  // field names). A field named "properties" would trigger `cleaned.properties !== undefined`
  // and corrupt the map with injected additionalProperties/required keys.
  if (
    !isInsidePropertiesMap &&
    (cleaned.type === "object" || cleaned.properties !== undefined)
  ) {
    cleaned.additionalProperties = false;

    if (!cleaned.properties || typeof cleaned.properties !== "object") {
      cleaned.properties = {};
      cleaned.required = [];
    } else {
      const propertiesMap = cleaned.properties as Record<string, unknown>;
      const propertyKeys = Object.keys(propertiesMap);
      const originalRequired = Array.isArray(cleaned.required)
        ? (cleaned.required as string[])
        : [];
      const newRequired = [...originalRequired];

      for (const propertyKey of propertyKeys) {
        if (!newRequired.includes(propertyKey)) {
          newRequired.push(propertyKey);

          // Make newly-required properties nullable via anyOf (not array type)
          const propertySchema = propertiesMap[propertyKey];
          if (
            propertySchema &&
            typeof propertySchema === "object" &&
            !Array.isArray(propertySchema)
          ) {
            const typedPropertySchema = propertySchema as Record<
              string,
              unknown
            >;

            // Skip if it already has anyOf (it's already a union type)
            if (!typedPropertySchema.anyOf) {
              if (typeof typedPropertySchema.type === "string") {
                const { type: originalType, ...restProperties } =
                  typedPropertySchema;
                propertiesMap[propertyKey] = {
                  anyOf: [
                    { type: originalType, ...restProperties },
                    { type: "null" },
                  ],
                };
              }
              // If type is already an array (from source schema), convert to anyOf
              else if (Array.isArray(typedPropertySchema.type)) {
                const types = typedPropertySchema.type as string[];
                const { type: _discardedType, ...restProperties } =
                  typedPropertySchema;
                if (!types.includes("null")) {
                  propertiesMap[propertyKey] = {
                    anyOf: [
                      ...types.map((typeValue: string) => ({
                        type: typeValue,
                        ...restProperties,
                      })),
                      { type: "null" },
                    ],
                  };
                } else {
                  propertiesMap[propertyKey] = {
                    anyOf: types.map((typeValue: string) => ({
                      type: typeValue,
                      ...(typeValue !== "null" ? restProperties : {}),
                    })),
                  };
                }
              }
            }
          }
        }
      }

      if (newRequired.length > 0) {
        cleaned.required = newRequired;
      }
    }
  }

  // Fix array type values anywhere else (not just in properties)
  if (Array.isArray(cleaned.type) && !cleaned.anyOf) {
    const types = cleaned.type as string[];
    const { type: _discardedType, ...restProperties } = cleaned;
    return {
      anyOf: types.map((typeValue: string) => ({
        type: typeValue,
        ...(typeValue !== "null" ? restProperties : {}),
      })),
    };
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
function prepareOpenAIMessages(
  messages: OpenAIMessage[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map(
    (message: OpenAIMessage): OpenAI.Chat.ChatCompletionMessageParam => {
      // Tool result messages — include tool_call_id for correlation
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

      // Assistant messages with tool calls — include tool_calls in OpenAI format
      if (message.role === "assistant") {
        if (message.toolCalls && message.toolCalls.length > 0) {
          return {
            role: "assistant",
            ...(message.name ? { name: message.name } : {}),
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
          ...(message.name ? { name: message.name } : {}),
          content: message.content ?? "",
        };
      }

      if (message.role === "system") {
        return {
          role: "system",
          ...(message.name ? { name: message.name } : {}),
          content: message.content ?? "",
        };
      }

      if (message.role === "developer") {
        return {
          role: "developer",
          ...(message.name ? { name: message.name } : {}),
          content: message.content ?? "",
        };
      }

      // User messages (can be multimodal)
      if (message.images && message.images.length > 0) {
        const content: OpenAI.Chat.ChatCompletionContentPart[] = [];
        for (const mediaRef of message.images) {
          const urlType = getUrlType(mediaRef);

          if (urlType === "data") {
            // Base64 data URL — use MIME type to route
            const mime = getDataUrlMimeType(mediaRef);
            if (mime && mime.startsWith("image/")) {
              content.push({ type: "image_url", image_url: { url: mediaRef } });
            } else if (mime === "application/pdf") {
              content.push({
                type: "file",
                file: { file_data: mediaRef, filename: "document.pdf" },
              } as OpenAI.Chat.ChatCompletionContentPart);
            } else if (
              mime &&
              (mime.startsWith("text/") || mime === "application/json")
            ) {
              // Decode text files and inline as text
              try {
                const base64 = mediaRef.split(";base64,")[1];
                const decoded = Buffer.from(base64, "base64").toString("utf-8");
                content.push({
                  type: "text",
                  text: `[Attached file (${mime})]:\n${decoded}`,
                });
              } catch {
                content.push({
                  type: "text",
                  text: `[Attached file (${mime}): unable to decode]`,
                });
              }
            } else {
              // Other data URL file types
              content.push({
                type: "file",
                file: { file_data: mediaRef, filename: "attachment" },
              } as OpenAI.Chat.ChatCompletionContentPart);
            }
          } else if (urlType === "http") {
            // HTTP(S) URL — the Chat Completions API accepts URLs in image_url
            const inferredType = inferMimeFromUrl(mediaRef);
            if (inferredType === "image") {
              content.push({ type: "image_url", image_url: { url: mediaRef } });
            } else {
              // Chat Completions file type via URL — use file_data with the URL
              content.push({
                type: "file",
                file: { file_data: mediaRef, filename: "attachment" },
              } as OpenAI.Chat.ChatCompletionContentPart);
            }
          } else {
            // Unknown ref type (e.g. minio://) — skip with warning
            logger.warn(
              `[openai] Skipping unresolved media ref in Chat Completions input: ${mediaRef.substring(0, 60)}...`,
            );
          }
        }
        if (message.content) {
          content.push({ type: "text", text: message.content });
        }
        return {
          role: "user",
          ...(message.name ? { name: message.name } : {}),
          content,
        };
      }

      return {
        role: "user",
        ...(message.name ? { name: message.name } : {}),
        content: message.content ?? "",
      };
    },
  );
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
    // Assistant message with tool calls → expand into function_call items
    if (
      message.role === "assistant" &&
      message.toolCalls &&
      message.toolCalls.length > 0
    ) {
      // If the assistant also produced text, include it first
      if (message.content?.trim()) {
        result.push({
          role: "assistant",
          content: message.content,
        } as OpenAI.Responses.ResponseInputItem);
      }
      // Each tool call becomes a function_call output item, preceded by its
      // paired reasoning item when present (required by the Responses API for
      // reasoning models — omitting it triggers a 400 referential integrity error).
      for (const toolCall of message.toolCalls) {
        if (toolCall.reasoningItem) {
          result.push({
            type: "reasoning",
            id: toolCall.reasoningItem.id,
            summary: toolCall.reasoningItem.summary,
          } as unknown as OpenAI.Responses.ResponseInputItem);
        }
        let functionCallId = toolCall.responsesItemId;
        if (!functionCallId || !functionCallId.startsWith("fc")) {
          if (toolCall.id && toolCall.id.startsWith("fc")) {
            functionCallId = toolCall.id;
          } else if (toolCall.id && toolCall.id.startsWith("call_")) {
            functionCallId = toolCall.id.replace(/^call_/, "fc_");
          } else {
            const secureRandomString = Math.random()
              .toString(36)
              .substring(2, 10);
            functionCallId = `fc_${toolCall.id || secureRandomString}`;
          }
        }
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
      // Generate function_call_output items for compact-format messages where
      // tool results are embedded inside toolCalls[].result (not pre-expanded
      // into separate role="tool" messages by expandMessagesForFC). This path
      // is hit by the non-streaming generateText route which bypasses expansion.
      for (const toolCall of message.toolCalls) {
        if (toolCall.result !== undefined) {
          const outputCallId =
            toolCall.id ||
            (toolCall.responsesItemId?.startsWith("fc")
              ? toolCall.responsesItemId
              : `fc_${toolCall.responsesItemId || ""}`);
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
      continue;
    }

    // Tool result message → function_call_output item
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

    // Standard message (system, user, assistant without tools)
    const role =
      message.role === "system"
        ? ("developer" as const)
        : (message.role as "developer" | "user" | "assistant");
    const nameObject = message.name ? { name: message.name } : {};

    if (message.images && message.images.length > 0) {
      const content: OpenAI.Responses.ResponseInputContent[] = [];
      for (const mediaRef of message.images) {
        const urlType = getUrlType(mediaRef);

        if (urlType === "data") {
          // Base64 data URL — use MIME type to route
          const mime = getDataUrlMimeType(mediaRef);
          if (mime && mime.startsWith("image/")) {
            content.push({
              type: "input_image",
              image_url: mediaRef,
              detail: "auto",
            });
          } else if (
            mime === "application/pdf" ||
            mime ===
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          ) {
            content.push({
              type: "input_file",
              file_data: mediaRef,
              filename: "document.pdf",
            });
          } else if (
            mime &&
            (mime.startsWith("text/") || mime === "application/json")
          ) {
            // Decode text files and inline as text
            try {
              const base64 = mediaRef.split(";base64,")[1];
              const decoded = Buffer.from(base64, "base64").toString("utf-8");
              content.push({
                type: "input_text",
                text: `[Attached file (${mime})]:\n${decoded}`,
              });
            } catch {
              content.push({
                type: "input_text",
                text: `[Attached file (${mime}): unable to decode]`,
              });
            }
          } else {
            // Other data URL file types
            content.push({
              type: "input_file",
              file_data: mediaRef,
              filename: "attachment",
            });
          }
        } else if (urlType === "http") {
          // HTTP(S) URL — infer type from extension, use URL-based fields
          const inferredType = inferMimeFromUrl(mediaRef);
          if (inferredType === "image") {
            content.push({
              type: "input_image",
              image_url: mediaRef,
              detail: "auto",
            });
          } else {
            content.push({ type: "input_file", file_url: mediaRef });
          }
        } else {
          // Unknown ref type (e.g. minio://) — skip with warning
          logger.warn(
            `[openai] Skipping unresolved media ref in Responses API input: ${mediaRef.substring(0, 60)}...`,
          );
        }
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
    // Responses API requires content to be a string or array, never null
    result.push({
      role,
      ...nameObject,
      content: message.content ?? "",
    } as OpenAI.Responses.ResponseInputItem);
  }
  return result;
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
    const input = prepareResponsesInput(messages);
    const payload: OpenAI.Responses.ResponseCreateParamsNonStreaming & {
      seed?: number;
      frequency_penalty?: number;
      presence_penalty?: number;
      stop?: string[];
    } = { model, input };

    // Reasoning
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
    if (Object.keys(reasoning).length > 0) {
      payload.reasoning = reasoning;
    }

    // Text / verbosity
    const text: OpenAI.Responses.ResponseTextConfig = {};
    if (options.verbosity) {
      text.format = { type: "text" };
      text.verbosity = options.verbosity as "low" | "medium" | "high";
    }

    if (options.maxTokens) payload.max_output_tokens = options.maxTokens;

    // Seed for reproducibility
    if (options.seed !== undefined) {
      payload.seed =
        typeof options.seed === "number"
          ? options.seed
          : parseInt(String(options.seed), 10);
    }

    // Service tier: auto / default / priority
    if (options.serviceTier) {
      payload.service_tier =
        options.serviceTier as OpenAI.Responses.ResponseCreateParamsNonStreaming["service_tier"];
    }

    // Response format (JSON mode) — maps to text.format for Responses API
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
    if (Object.keys(text).length > 0) {
      payload.text = text;
    }

    // Temperature/topP only work with reasoning.effort=none
    if (options.reasoningEffort === "none") {
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

    // Web search tool
    if (options.webSearch) {
      payload.tools = [{ type: "web_search" } as OpenAI.Responses.Tool];
    }

    // Custom function calling tools
    const customTools = convertToolsToResponsesAPI(
      options.tools as ToolSchema[] | null | undefined,
    );
    if (customTools) {
      payload.tools = [
        ...((payload.tools as OpenAI.Responses.Tool[]) || []),
        ...customTools,
      ];
    }

    // Parallel tool calls — defaults to true; set false for sequential FC
    if (options.parallelToolCalls === false) {
      payload.parallel_tool_calls = false;
    }

    // Response persistence — defaults to true; set false for privacy
    if (options.store === false) {
      payload.store = false;
    }

    // Log probabilities — top N candidate tokens per step
    if (options.topLogprobs && options.topLogprobs > 0) {
      payload.top_logprobs = options.topLogprobs;
    }

    logger.info(
      `[OpenAI/Responses] Sending non-stream payload: ${JSON.stringify(payload)}`,
    );

    const { data: response, response: rawResponse } = await getClient()
      .responses.create(payload)
      .withResponse();

    // Extract rate-limit headers
    const rateLimits = extractOpenAIRateLimits(rawResponse, model);

    // Collect tool calls and images from output items
    const images: Array<{ type: string; data: string; mimeType: string }> = [];
    const toolCalls: Array<{
      id: string;
      responsesItemId?: string;
      name: string;
      args: Record<string, unknown>;
      reasoningItem?: {
        id: string;
        summary: Array<{ type: string; text: string }>;
      };
    }> = [];
    if (response.output) {
      // Track pending reasoning items to pair with subsequent function calls
      const pendingReasoningItems: Array<{
        id: string;
        summary: Array<{ type: string; text: string }>;
      }> = [];
      for (const item of response.output) {
        if (item.type === "image_generation_call" && item.result) {
          images.push({
            type: "image",
            data: item.result,
            mimeType: "image/png",
          });
        } else if (item.type === "reasoning") {
          const reasoningOutputItem = item as unknown as {
            id: string;
            summary?: Array<{ type: string; text: string }>;
          };
          if (reasoningOutputItem.id) {
            pendingReasoningItems.push({
              id: reasoningOutputItem.id,
              summary: reasoningOutputItem.summary || [],
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
            ...(pairedReasoningItem
              ? { reasoningItem: pairedReasoningItem }
              : {}),
          });
        }
      }
    }

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
    const modelDefinition = getModelByName(model);
    const isReasoning =
      (modelDefinition &&
        "thinking" in modelDefinition &&
        (modelDefinition as { thinking?: boolean }).thinking === true) ||
      model.includes("o1") ||
      model.includes("o3");
    const prepared = prepareOpenAIMessages(messages);
    const payload: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model,
      messages: prepared,
    };
    if (isReasoning) {
      if (options.maxTokens) payload.max_completion_tokens = options.maxTokens;
      if (options.reasoningEffort) {
        payload.reasoning_effort =
          options.reasoningEffort as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming["reasoning_effort"];
      }
    } else {
      if (options.temperature !== undefined)
        payload.temperature = options.temperature;
      if (options.topP !== undefined) payload.top_p = options.topP;
      if (options.frequencyPenalty !== undefined)
        payload.frequency_penalty = options.frequencyPenalty;
      if (options.presencePenalty !== undefined)
        payload.presence_penalty = options.presencePenalty;
      if (options.stopSequences !== undefined)
        payload.stop =
          options.stopSequences as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming["stop"];
      if (options.maxTokens) payload.max_completion_tokens = options.maxTokens;
    }

    // Seed for reproducibility
    if (options.seed !== undefined) {
      payload.seed =
        typeof options.seed === "number"
          ? options.seed
          : parseInt(String(options.seed), 10);
    }

    // Service tier: auto / default / priority
    if (options.serviceTier) {
      payload.service_tier =
        options.serviceTier as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming["service_tier"];
    }

    // Response format (JSON mode)
    if (options.responseFormat === "json_object") {
      payload.response_format = { type: "json_object" };
    }

    if (options.webSearch) {
      payload.tools = [
        { type: "web_search" } as unknown as OpenAI.Chat.ChatCompletionTool,
      ];
    }

    // Custom function calling tools — truncate to 128 max for Chat Completions API
    const customTools = convertToolsToOpenAI(
      options.tools as ToolSchema[] | null | undefined,
    ) as OpenAI.Chat.ChatCompletionTool[] | null;
    if (customTools) {
      const allTools = [
        ...((payload.tools as OpenAI.Chat.ChatCompletionTool[]) || []),
        ...customTools,
      ];
      payload.tools = truncateToolsForChatCompletions(allTools);
    }

    try {
      const { data: response, response: rawResponse } = await getClient()
        .chat.completions.create(payload)
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
      if (
        errorObject.status === 400 &&
        errorObject.message?.includes("Unsupported")
      ) {
        const unsupportedParams = [
          "temperature",
          "top_p",
          "frequency_penalty",
          "presence_penalty",
          "max_completion_tokens",
        ];
        let stripped = false;
        const payloadRecord = payload as unknown as Record<string, unknown>;
        for (const param of unsupportedParams) {
          if (
            errorObject.message?.includes(`'${param}'`) &&
            payloadRecord[param] !== undefined
          ) {
            logger.provider(
              "OpenAI",
              `Stripping unsupported param '${param}' for ${model} and retrying`,
            );
            delete payloadRecord[param];
            stripped = true;
          }
        }
        if (stripped) {
          const response = await getClient().chat.completions.create(payload);
          return {
            text: response.choices[0].message.content,
            usage: normalizeUsage(response.usage),
          };
        }
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
    const input = prepareResponsesInput(messages);
    const payload: OpenAI.Responses.ResponseCreateParamsStreaming & {
      seed?: number;
      frequency_penalty?: number;
      presence_penalty?: number;
      stop?: string[];
    } = { model, input, stream: true };

    // Reasoning
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
    if (Object.keys(reasoning).length > 0) {
      payload.reasoning = reasoning;
    }

    // Text / verbosity
    const text: OpenAI.Responses.ResponseTextConfig = {};
    if (options.verbosity) {
      text.format = { type: "text" };
      text.verbosity = options.verbosity as "low" | "medium" | "high";
    }

    if (options.maxTokens) payload.max_output_tokens = options.maxTokens;

    // Seed for reproducibility
    if (options.seed !== undefined) {
      payload.seed =
        typeof options.seed === "number"
          ? options.seed
          : parseInt(String(options.seed), 10);
    }

    // Service tier: auto / default / priority
    if (options.serviceTier) {
      payload.service_tier =
        options.serviceTier as OpenAI.Responses.ResponseCreateParamsStreaming["service_tier"];
    }

    // Response format (JSON mode) — maps to text.format for Responses API
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
    if (Object.keys(text).length > 0) {
      payload.text = text;
    }

    // Temperature/topP only work with reasoning.effort=none
    if (options.reasoningEffort === "none") {
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

    // Web search tool
    if (options.webSearch) {
      payload.tools = [{ type: "web_search" } as OpenAI.Responses.Tool];
    }

    // Custom function calling tools
    const customTools = convertToolsToResponsesAPI(
      options.tools as ToolSchema[] | null | undefined,
    );
    if (customTools) {
      payload.tools = [
        ...((payload.tools as OpenAI.Responses.Tool[]) || []),
        ...customTools,
      ];
    }

    // Parallel tool calls — defaults to true; set false for sequential FC
    if (options.parallelToolCalls === false) {
      payload.parallel_tool_calls = false;
    }

    // Response persistence — defaults to true; set false for privacy
    if (options.store === false) {
      payload.store = false;
    }

    // Log probabilities — top N candidate tokens per step
    if (options.topLogprobs && options.topLogprobs > 0) {
      payload.top_logprobs = options.topLogprobs;
    }

    logger.info(
      `[OpenAI/Responses] Sending stream payload: ${JSON.stringify(payload)}`,
    );

    const { data: streamData, response: rawStreamResponse } = await getClient()
      .responses.create(payload, {
        ...(options.signal && { signal: options.signal }),
      })
      .withResponse();
    const rateLimits = extractOpenAIRateLimits(rawStreamResponse, model);
    let usage = null;
    // Track function names from output_item.added events; the arguments.done
    // event may not include the name property (known OpenAI SDK issue).
    const pendingFunctions: Record<
      string,
      { name: string; callId: string; args: string }
    > = {};
    // Track reasoning output items so we can pair them with subsequent function calls.
    // The Responses API emits reasoning items before their paired function_call items.
    const pendingReasoningItems: Array<{
      id: string;
      summary: Array<{ type: string; text: string }>;
    }> = [];
    const reasoningSummaryAccumulator: Record<string, string> = {};
    for await (const event of streamData) {
      if (options.signal?.aborted) break;
      // Text delta from output_text
      if (event.type === "response.output_text.delta") {
        const typedEvent = event as OpenAI.Responses.ResponseTextDeltaEvent;
        yield typedEvent.delta || "";
      }
      // Reasoning / thinking summary delta — also accumulate for reasoning item reconstruction
      if (event.type === "response.reasoning_summary_text.delta") {
        const typedEvent =
          event as OpenAI.Responses.ResponseReasoningSummaryTextDeltaEvent;
        const itemId = (typedEvent as unknown as { item_id?: string }).item_id;
        if (itemId) {
          reasoningSummaryAccumulator[itemId] =
            (reasoningSummaryAccumulator[itemId] || "") +
            (typedEvent.delta || "");
        }
        yield { type: "thinking", content: typedEvent.delta || "" };
      }
      // Image generation completed
      if (event.type === "response.image_generation_call.completed") {
        const typedEvent =
          event as OpenAI.Responses.ResponseImageGenCallCompletedEvent & {
            result?: string;
          };
        if (typedEvent.result) {
          yield {
            type: "image",
            data: typedEvent.result,
            mimeType: "image/png",
          };
        }
      }
      // Track reasoning and function call metadata from output_item.added
      if (event.type === "response.output_item.added") {
        const typedEvent =
          event as OpenAI.Responses.ResponseOutputItemAddedEvent;
        if (typedEvent.item?.type === "reasoning") {
          const reasoningItem = typedEvent.item as unknown as {
            id: string;
            summary?: Array<{ type: string; text: string }>;
          };
          if (reasoningItem.id) {
            pendingReasoningItems.push({
              id: reasoningItem.id,
              summary: reasoningItem.summary || [],
            });
          }
        } else if (typedEvent.item?.type === "function_call") {
          const item =
            typedEvent.item as OpenAI.Responses.ResponseFunctionToolCall;
          if (item.id) {
            pendingFunctions[item.id] = {
              name: item.name,
              callId: item.call_id,
              args: "",
            };
            if (item.name && item.call_id) {
              yield {
                type: "toolCallStart",
                id: item.call_id,
                name: item.name,
              };
            }
          }
        }
      }
      // Accumulate argument deltas (keyed by item_id)
      if (event.type === "response.function_call_arguments.delta") {
        const typedEvent =
          event as OpenAI.Responses.ResponseFunctionCallArgumentsDeltaEvent;
        const entry = pendingFunctions[typedEvent.item_id];
        const partial = typedEvent.delta || "";
        if (entry) {
          entry.args += partial;
        }
        // Yield progress event so generation throughput tracking stays
        // alive during FC argument streaming.
        if (partial.length > 0) {
          yield { type: "toolCallDelta", characters: partial.length };
        }
      }
      // Function call completed (Responses API)
      if (event.type === "response.function_call_arguments.done") {
        const typedEvent =
          event as OpenAI.Responses.ResponseFunctionCallArgumentsDoneEvent & {
            call_id?: string;
          };
        const tracked = pendingFunctions[typedEvent.item_id];
        const name = tracked?.name || typedEvent.name || "unknown";
        const callId =
          tracked?.callId || typedEvent.call_id || typedEvent.item_id;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(typedEvent.arguments || tracked?.args || "{}");
        } catch {
          /* ignore */
        }
        // Pop the most recent pending reasoning item and finalize its summary
        // text from the accumulated deltas. This pairs the reasoning item with
        // this function call for referential integrity on subsequent turns.
        let pairedReasoningItem:
          | { id: string; summary: Array<{ type: string; text: string }> }
          | undefined;
        if (pendingReasoningItems.length > 0) {
          pairedReasoningItem = pendingReasoningItems.shift();
          if (pairedReasoningItem) {
            const accumulatedText =
              reasoningSummaryAccumulator[pairedReasoningItem.id];
            if (accumulatedText) {
              pairedReasoningItem.summary = [
                { type: "summary_text", text: accumulatedText },
              ];
              delete reasoningSummaryAccumulator[pairedReasoningItem.id];
            }
          }
        }
        yield {
          type: "toolCall",
          id: callId,
          // Responses API internal item ID (starts with "fc_")
          responsesItemId: typedEvent.item_id,
          name,
          args,
          ...(pairedReasoningItem
            ? { reasoningItem: pairedReasoningItem }
            : {}),
        };
        // Clean up
        delete pendingFunctions[typedEvent.item_id];
      }
      // Completed response — extract usage and detect truncation
      if (event.type === "response.completed") {
        const typedEvent = event as OpenAI.Responses.ResponseCompletedEvent;
        if (typedEvent.response?.usage) {
          usage = normalizeResponsesUsage(typedEvent.response.usage);
        }
        // Detect max_tokens truncation (Responses API uses "incomplete" status)
        const responseRecord = typedEvent.response as unknown as Record<
          string,
          unknown
        >;
        const responseStatus = responseRecord?.status;
        const incompleteReason = responseRecord?.incomplete_details;
        if (
          responseStatus === "incomplete" ||
          (incompleteReason &&
            typeof incompleteReason === "object" &&
            (incompleteReason as Record<string, unknown>).reason ===
              "max_output_tokens")
        ) {
          yield { type: "stopReason", stopReason: "length" };
        }
      }
    }
    if (usage) {
      yield { type: "usage", usage };
    } else {
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
    }
    if (rateLimits) {
      yield { type: "rateLimits", rateLimits };
    }
  },
  async *_streamChatCompletions(
    messages: OpenAIMessage[],
    model: string,
    options: ProviderOptions,
  ) {
    const modelDefinition = getModelByName(model);
    const isReasoning =
      (modelDefinition &&
        "thinking" in modelDefinition &&
        (modelDefinition as { thinking?: boolean }).thinking === true) ||
      model.includes("o1") ||
      model.includes("o3");
    const prepared = prepareOpenAIMessages(messages);
    const payload: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model,
      messages: prepared,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (isReasoning) {
      if (options.maxTokens) payload.max_completion_tokens = options.maxTokens;
      if (options.reasoningEffort) {
        payload.reasoning_effort =
          options.reasoningEffort as OpenAI.Chat.ChatCompletionCreateParamsStreaming["reasoning_effort"];
      }
    } else {
      if (options.temperature !== undefined)
        payload.temperature = options.temperature;
      if (options.topP !== undefined) payload.top_p = options.topP;
      if (options.frequencyPenalty !== undefined)
        payload.frequency_penalty = options.frequencyPenalty;
      if (options.presencePenalty !== undefined)
        payload.presence_penalty = options.presencePenalty;
      if (options.stopSequences !== undefined)
        payload.stop =
          options.stopSequences as OpenAI.Chat.ChatCompletionCreateParamsStreaming["stop"];
      if (options.maxTokens) payload.max_completion_tokens = options.maxTokens;
    }

    // Seed for reproducibility
    if (options.seed !== undefined) {
      payload.seed =
        typeof options.seed === "number"
          ? options.seed
          : parseInt(String(options.seed), 10);
    }

    // Service tier: auto / default / priority
    if (options.serviceTier) {
      payload.service_tier =
        options.serviceTier as OpenAI.Chat.ChatCompletionCreateParamsStreaming["service_tier"];
    }

    // Response format (JSON mode)
    if (options.responseFormat === "json_object") {
      payload.response_format = { type: "json_object" };
    }

    if (options.webSearch) {
      payload.tools = [
        { type: "web_search" } as unknown as OpenAI.Chat.ChatCompletionTool,
      ];
    }

    // Custom function calling tools — truncate to 128 max for Chat Completions API
    const customTools = convertToolsToOpenAI(
      options.tools as ToolSchema[] | null | undefined,
    ) as OpenAI.Chat.ChatCompletionTool[] | null;
    if (customTools) {
      const allTools = [
        ...((payload.tools as OpenAI.Chat.ChatCompletionTool[]) || []),
        ...customTools,
      ];
      payload.tools = truncateToolsForChatCompletions(allTools);
    }

    let stream: Stream<OpenAI.Chat.ChatCompletionChunk>;
    let rateLimits = null;
    try {
      const { data: streamData, response: rawStreamResponse } =
        await getClient()
          .chat.completions.create(payload, {
            ...(options.signal && { signal: options.signal }),
          })
          .withResponse();
      stream = streamData;
      rateLimits = extractOpenAIRateLimits(rawStreamResponse, model);
    } catch (error: unknown) {
      const errorObject = asErrorRecord(error);
      // Retry once after stripping unsupported parameters (e.g. gpt-5-nano rejects temperature)
      if (
        errorObject.status === 400 &&
        errorObject.message?.includes("Unsupported")
      ) {
        const unsupportedParams = [
          "temperature",
          "top_p",
          "frequency_penalty",
          "presence_penalty",
          "max_completion_tokens",
        ];
        let stripped = false;
        const payloadRecord = payload as unknown as Record<string, unknown>;
        for (const param of unsupportedParams) {
          if (
            errorObject.message?.includes(`'${param}'`) &&
            payloadRecord[param] !== undefined
          ) {
            logger.provider(
              "OpenAI",
              `Stripping unsupported param '${param}' for ${model} and retrying (stream)`,
            );
            delete payloadRecord[param];
            stripped = true;
          }
        }
        if (stripped) {
          const retryResult = await getClient()
            .chat.completions.create(payload, {
              ...(options.signal && { signal: options.signal }),
            })
            .withResponse();
          stream = retryResult.data;
          rateLimits = extractOpenAIRateLimits(retryResult.response, model);
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }

    let usage = null;
    let lastFinishReason: string | null = null;
    // Accumulate tool calls across chunks
    const pendingToolCalls: Record<
      number,
      { id: string; name: string; args: string; startEmitted: boolean }
    > = {};

    for await (const chunk of stream) {
      if (options.signal?.aborted) break;
      if (chunk.usage) {
        usage = normalizeUsage(chunk.usage);
      }
      const delta = chunk.choices?.[0]?.delta;
      const content = delta?.content || "";
      if (content) {
        yield content;
      }

      // Track the last finish_reason for truncation detection
      const finishReason = chunk.choices?.[0]?.finish_reason;
      if (finishReason) lastFinishReason = finishReason;

      // Accumulate tool call deltas
      if (delta?.tool_calls) {
        let deltaChars = 0;
        for (const toolCall of delta.tool_calls) {
          const index = toolCall.index;
          if (!pendingToolCalls[index]) {
            pendingToolCalls[index] = {
              id: toolCall.id || "",
              name: toolCall.function?.name || "",
              args: "",
              startEmitted: false,
            };
          }
          if (toolCall.id) pendingToolCalls[index].id = toolCall.id;
          if (toolCall.function?.name)
            pendingToolCalls[index].name = toolCall.function.name;
          if (toolCall.function?.arguments) {
            pendingToolCalls[index].args += toolCall.function.arguments;
            deltaChars += toolCall.function.arguments.length;
          }
          if (
            !pendingToolCalls[index].startEmitted &&
            pendingToolCalls[index].name &&
            pendingToolCalls[index].id
          ) {
            pendingToolCalls[index].startEmitted = true;
            yield {
              type: "toolCallStart",
              id: pendingToolCalls[index].id,
              name: pendingToolCalls[index].name,
            };
          }
        }
        // Yield progress event so generation throughput tracking stays
        // alive during FC argument streaming.
        if (deltaChars > 0) {
          yield { type: "toolCallDelta", characters: deltaChars };
        }
      }

      // If finish_reason is "tool_calls", yield accumulated tool calls
      if (finishReason === "tool_calls") {
        for (const toolCall of Object.values(pendingToolCalls)) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(toolCall.args || "{}");
          } catch {
            /* ignore */
          }
          yield {
            type: "toolCall",
            id: toolCall.id,
            name: toolCall.name,
            args,
          };
        }
      }
    }
    // Surface max_tokens truncation so harnesses can detect and warn the user
    if (lastFinishReason === "length") {
      yield { type: "stopReason", stopReason: "length" };
    }
    if (usage) {
      yield { type: "usage", usage };
    } else {
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
    }
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
