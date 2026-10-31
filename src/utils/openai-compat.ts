// ─────────────────────────────────────────────────────────────
// OpenAI-Compatible Provider Utilities
// ─────────────────────────────────────────────────────────────
// Shared helpers for providers that use the OpenAI Chat Completions
// API format: lm-studio, vllm, llama-cpp, and openai itself.

import { ProviderError } from "./errors.ts";
import { Agent } from "undici";
import { getDataUrlMimeType } from "./media.ts";
import { ThinkTagParser, extractThinkTags } from "./ThinkTagParser.ts";
import logger from "./logger.ts";
import type {
  ProviderOptions,
  ChatMessageContent,
} from "../types/ProviderTypes.ts";
import type { TokenUsage, ToolCallEntry } from "../types/admin.ts";

// ─── Streaming fetch dispatcher ─────────────────────────────
// Node.js's built-in fetch (powered by undici) defaults bodyTimeout to
// 300,000ms (5 minutes). This kills ANY streaming response body that
// takes longer than 5 minutes to complete — even when data flows
// continuously. Provide a shared Agent with no body timeout for all
// long-running LLM streaming connections.
export const STREAMING_DISPATCHER = new Agent({
  bodyTimeout: 0,
  headersTimeout: 1_800_000,
  keepAliveTimeout: 30_000,
});

// ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
// ┃  TEMPORARY PATCH — Remove when vLLM fixes Qwen3.6 chat     ┃
// ┃  template system message positioning bug.                   ┃
// ┃                                                             ┃
// ┃  TODO(vllm-qwen3.6): Remove this entire block once vLLM    ┃
// ┃  supports mid-conversation system messages for Qwen3.6.    ┃
// ┃                                                             ┃
// ┃  Bug: vLLM's Qwen3.6 chat template enforces that system    ┃
// ┃  messages must only appear at the very beginning. The       ┃
// ┃  agentic harness injects mid-conversation system messages   ┃
// ┃  (tool doc addendums, validation errors, retry guidance)    ┃
// ┃  which triggers:                                            ┃
// ┃  "System message must be at the beginning."                 ┃
// ┃                                                             ┃
// ┃  Workaround: rewrite non-leading system → user role.        ┃
// ┃  Shared by the vLLM provider (direct :7778 path) and        ┃
// ┃  PrismProxyService (proxied path) — keep in one place.      ┃
// ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

// FIXME(vllm-qwen3.6): Temporary model list — delete with the patch above
const MODELS_REQUIRING_SYSTEM_REWRITE_TEMPORARY_PATCH = ["qwen"];

// FIXME(vllm-qwen3.6): Temporary predicate — delete with the patch above
export function requiresSystemMessageRewriteTemporaryPatch(
  modelName: string,
): boolean {
  const normalizedModelName = modelName.toLowerCase();
  return MODELS_REQUIRING_SYSTEM_REWRITE_TEMPORARY_PATCH.some((pattern) =>
    normalizedModelName.includes(pattern),
  );
}

/**
 * FIXME(vllm-qwen3.6): Temporary rewriter — delete with the patch above.
 *
 * Rewrites every non-leading `role:"system"` message to `role:"user"` for
 * models whose vLLM chat template rejects mid-conversation system messages.
 * Returns the original array untouched when no rewrite is needed.
 */
export function rewriteNonLeadingSystemMessages<T extends { role?: string }>(
  messages: T[],
  modelName: string,
  logContext: string = "vLLM",
): T[] {
  if (!requiresSystemMessageRewriteTemporaryPatch(modelName)) return messages;

  const needsRewrite = messages.some(
    (message, index) => message.role === "system" && index !== 0,
  );
  if (!needsRewrite) return messages;

  return messages.map((message, index) => {
    if (message.role === "system" && index !== 0) {
      logger.warn(
        `[${logContext}] TEMP PATCH: Rewriting non-primary system message to user role for ${modelName} (vllm-qwen3.6 workaround)`,
      );
      return { ...message, role: "user" };
    }
    return message;
  });
}

// ── Types ────────────────────────────────────────────────────

/**
 * Input message shape consumed by openai-compat adapter functions.
 * This is intentionally wider than ProviderTypes.ChatMessage because
 * messages arrive from conversation storage with diverse fields
 * (tool results, media attachments, etc.) that need normalization.
 */
export interface InputMessage {
  role: string;
  content?: string | ChatMessageContent[];
  name?: string;
  // Tool correlation (used by tool result messages)
  tool_call_id?: string;
  id?: string;
  // Assistant tool calls
  toolCalls?: ToolCallEntry[];
  // Media attachments
  images?: string[];
  audio?: string[];
  video?: string[];
  pdf?: string[];
  // Thinking
  thinking?: string;
  thinkingSignature?: string;
  reasoning_content?: string;
}

interface OpenAIToolCall {
  id?: string;
  index?: number;
  type?: string;
  function?: { name?: string; arguments?: string };
  name?: string;
  arguments?: string;
}

interface OpenAIMessage {
  role: string;
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  reasoning_content?: string;
  reasoning?: string;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface OpenAICompletionResponse {
  choices?: Array<{
    message?: OpenAIMessage;
    delta?: OpenAIMessage & { tool_calls?: OpenAIToolCall[] };
    finish_reason?: string;
  }>;
  usage?: OpenAIUsage;
}

interface OpenAIToolFunction {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

export interface PreparedMessage {
  role: string;
  name?: string;
  content: string | ContentPart[] | null;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
}

interface SSEParseOptions {
  signal?: AbortSignal;
  /** Provider name for errors ("vllm" → "The vllm stream ended …"). */
  label?: string;
  thinkingEnabled?: boolean;
  onUsage?: (json: OpenAICompletionResponse, usage: TokenUsage) => void;
  onChunkJson?: (json: OpenAICompletionResponse) => void;
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
  startEmitted: boolean;
}

interface PayloadDefaults {
  temperature?: number;
  maxTokens?: number;
}

interface FetchOptions {
  signal?: AbortSignal;
  /** Extra request headers (e.g. vLLM `X-Vllm-Priority`). */
  headers?: Record<string, string>;
}

/** Union of event types yielded by parseSSEStream. */
export type SSEStreamChunk =
  | string
  | { type: "thinking"; content: string }
  | {
      type: "toolCall";
      id: string | null;
      name: string;
      args: Record<string, unknown>;
      result?: unknown;
      status?: "calling" | "done" | "error";
      native?: boolean;
      argsParseError?: boolean;
      rawArgs?: string;
    }
  | { type: "toolCallStart"; id: string; name: string }
  | { type: "toolCallDelta"; characters: number }
  | { type: "usage"; usage: TokenUsage }
  | { type: "stopReason"; stopReason: string }
  | { type: "status"; message: string; phase?: string; progress?: number };

// ── Tool Conversion ─────────────────────────────────────────

/**
 * Convert generic tool schemas to OpenAI Chat Completions format.
 * Input:  [{ name, description, parameters }]
 * Output: [{ type: "function", function: { name, description, parameters } }]
 */
interface ToolInput {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export function convertToolsToOpenAI(
  tools: ToolInput[] | undefined | null,
): OpenAIToolFunction[] | null {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return null;
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.parameters || {},
    },
  }));
}

// ── Payload Parameter Building ──────────────────────────────

/**
 * Build the common sampling/generation parameters for an
 * OpenAI-compatible Chat Completions payload.
 *
 * Returns a plain object with only the non-undefined fields set.
 */
export function buildPayloadParams(
  options: ProviderOptions,
  { temperature = 0.7, maxTokens = -1 }: PayloadDefaults = {},
) {
  return {
    temperature:
      options.temperature !== undefined ? options.temperature : temperature,
    top_p: options.topP !== undefined ? options.topP : undefined,
    frequency_penalty:
      options.frequencyPenalty !== undefined
        ? options.frequencyPenalty
        : undefined,
    presence_penalty:
      options.presencePenalty !== undefined
        ? options.presencePenalty
        : undefined,
    stop:
      options.stopSequences !== undefined ? options.stopSequences : undefined,
    max_tokens: options.maxTokens || maxTokens,
    // Reproducibility seed — supported by OpenAI-compat servers (vLLM, LM Studio, llama.cpp)
    ...(options.seed !== undefined &&
      options.seed !== "" && { seed: Number(options.seed) }),
  };
}

// ── Tool Call Extraction ────────────────────────────────────

/**
 * Extract tool calls from a non-streaming OpenAI-compatible message object.
 * Handles both nested OpenAI format ({ function: { name, arguments } })
 * and flat llama.cpp format ({ name, arguments }).
 */
export function extractToolCallsFromMessage(
  message: OpenAIMessage | null | undefined,
): ToolCallEntry[] | null {
  if (!message?.tool_calls || message.tool_calls.length === 0) return null;

  return message.tool_calls.map((toolCall) => {
    const functionName = toolCall.function?.name || toolCall.name || "";
    const functionArguments =
      toolCall.function?.arguments || toolCall.arguments || "{}";
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(functionArguments);
    } catch {
      /* ignore */
    }
    return {
      id: toolCall.id || null,
      name: functionName,
      args,
    };
  });
}

// ── Usage Normalization ─────────────────────────────────────

/**
 * Build a normalized usage object from OpenAI-compatible usage data.
 * Extracts extended token details when available:
 *   - prompt_tokens_details.cached_tokens  → cacheReadInputTokens
 *   - completion_tokens_details.reasoning_tokens → reasoningOutputTokens
 *
 * The cache field uses the same key as Anthropic (cacheReadInputTokens) so
 * CostCalculator, RequestLogger, and console logging handle it uniformly.
 */
export function normalizeUsage(
  rawUsage: OpenAIUsage | null | undefined,
): TokenUsage {
  const usage: TokenUsage = {
    inputTokens: rawUsage?.prompt_tokens ?? 0,
    outputTokens: rawUsage?.completion_tokens ?? 0,
  };

  // KV cache hits — reported by LM Studio and OpenAI
  const cachedTokens = rawUsage?.prompt_tokens_details?.cached_tokens;
  if (cachedTokens && cachedTokens > 0) {
    usage.cacheReadInputTokens = cachedTokens;
    // Adjust inputTokens to reflect only the non-cached portion,
    // mirroring Anthropic's convention where inputTokens excludes cache hits
    usage.inputTokens = Math.max(0, (usage.inputTokens ?? 0) - cachedTokens);
  }

  // Reasoning token breakdown
  const reasoningTokens = rawUsage?.completion_tokens_details?.reasoning_tokens;
  if (reasoningTokens && reasoningTokens > 0) {
    usage.reasoningOutputTokens = reasoningTokens;
  }

  return usage;
}

export const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

// ── Message Preparation ─────────────────────────────────────

/**
 * Media handling strategies for prepareOpenAICompatMessages.
 * Controls how non-image media types are handled by different providers.
 */
export const MEDIA_STRATEGIES = {
  /** vLLM: supports video_url and input_audio natively */
  FULL_MULTIMODAL: "full_multimodal",
  /** llama-cpp: falls back to text descriptions for audio/video */
  TEXT_FALLBACK: "text_fallback",
  /** lm-studio: images only, ignore other media types */
  IMAGES_ONLY: "images_only",
};

interface ExpandVideoOptions {
  fps?: number;
  maxFrames?: number;
  quality?: number;
}

/**
 * Pre-process messages to expand video attachments into image frames.
 *
 * For providers that don't support raw video data URLs (e.g. LM Studio),
 * this extracts frames from each video using ffmpeg and adds them to the
 * message's `images` array. The original `video` array is removed so
 * downstream processing never sees it.
 *
 * Call this BEFORE prepareOpenAICompatMessages() for providers that need
 * video-as-frames support.
 */
export async function expandVideoToFrames(
  messages: InputMessage[],
  options: ExpandVideoOptions = {},
): Promise<InputMessage[]> {
  const { extractVideoFrames, getDataUrlMimeType } = await import("./media.js");

  for (const message of messages) {
    // Collect video data URLs from both `video` and `images` arrays.
    // The frontend may place video files in `images` if it doesn't
    // categorize by MIME type (backwards compatibility).
    const videoUrls: string[] = [];
    const keptImages: string[] = [];

    // Check explicit video field
    const messageWithVideo = message as InputMessage & { video?: string[] };
    if (messageWithVideo.video && Array.isArray(messageWithVideo.video)) {
      videoUrls.push(...messageWithVideo.video);
      delete messageWithVideo.video;
    }

    // Check images field for misclassified video data URLs
    if (messageWithVideo.images && Array.isArray(messageWithVideo.images)) {
      for (const dataUrl of messageWithVideo.images) {
        const mime = getDataUrlMimeType(dataUrl);
        if (mime && mime.startsWith("video/")) {
          videoUrls.push(dataUrl);
        } else {
          keptImages.push(dataUrl);
        }
      }
      messageWithVideo.images = keptImages;
    }

    if (videoUrls.length === 0) continue;

    const allFrames: string[] = [];
    for (const videoDataUrl of videoUrls) {
      const frames = (await extractVideoFrames(
        videoDataUrl,
        options,
      )) as string[];
      allFrames.push(...frames);
    }

    if (allFrames.length > 0) {
      // Prepend frames to images array (model card recommends media before text)
      messageWithVideo.images = [
        ...allFrames,
        ...(messageWithVideo.images || []),
      ];
    }
  }

  return messages;
}

/**
 * Prepend the identity system prompt (`options.systemPrompt`) as a `system`
 * message at the start of the array.
 *
 * The harness keeps the identity prompt out of the messages array and hands
 * it to providers as a first-class option (Anthropic → payload.system,
 * Google → systemInstruction). OpenAI-compatible providers take system
 * prompts in-band, so they must re-inject it here or the model never sees it.
 * Until 2026-10-07 none of ours did: every native /agent run on vLLM,
 * LM Studio, Ollama, llama.cpp or OpenAI reached the model with no system
 * prompt — trading's cycle agents (which send theirs only as `systemPrompt`)
 * and every persona's assembled identity alike. Ported from prism's
 * providers/openai-compat.ts (same name, same behaviour).
 *
 * Returns the original array unchanged when no identity prompt is provided.
 */
export function prependIdentitySystemMessage<T extends { role: string; content?: string | unknown }>(
  messages: T[],
  identityPrompt: string | undefined,
): T[] {
  if (!identityPrompt) return messages;
  return [{ role: "system", content: identityPrompt } as T, ...messages];
}

function extractAssistantReasoningContent(message: InputMessage): string {
  if (
    typeof message.reasoning_content === "string" &&
    message.reasoning_content.trim()
  ) {
    return message.reasoning_content.trim();
  }
  if (typeof message.thinking === "string" && message.thinking.trim()) {
    return message.thinking.trim();
  }
  return "";
}

function buildCompatAssistantToolMessage(
  base: { role: string; name?: string },
  message: InputMessage,
): PreparedMessage {
  const reasoningContent = extractAssistantReasoningContent(message);
  const trimmedText =
    typeof message.content === "string" ? message.content.trim() : "";
  const includeReasoning =
    Boolean(reasoningContent) && process.env.ROUND_TRIP_REASONING !== "0";
  const toolCalls = message.toolCalls || [];
  return {
    ...base,
    content: trimmedText || null,
    ...(includeReasoning ? { reasoning_content: reasoningContent } : {}),
    tool_calls: toolCalls.map((toolCall: ToolCallEntry, i: number) => ({
      id: toolCall.id || `call_${i}`,
      type: "function",
      function: {
        name: toolCall.name,
        arguments:
          typeof toolCall.args === "string"
            ? toolCall.args
            : JSON.stringify(toolCall.args || {}),
      },
    })),
  } as PreparedMessage;
}

function decodeCompatBase64TextPart(dataUrl: string, mime: string): ContentPart {
  try {
    const base64 = dataUrl.split(";base64,")[1];
    const decoded = Buffer.from(base64, "base64").toString("utf-8");
    return {
      type: "text",
      text: `[Attached file (${mime})]:\n${decoded}`,
    };
  } catch {
    return {
      type: "text",
      text: `[Attached file (${mime}): unable to decode]`,
    };
  }
}

function convertCompatAudioOrVideoDataUrl(
  dataUrl: string,
  mime: string,
  mediaStrategy: string,
): ContentPart {
  const isFullMultimodal = mediaStrategy === MEDIA_STRATEGIES.FULL_MULTIMODAL;
  if (mime.startsWith("video/")) {
    if (isFullMultimodal) {
      return { type: "video_url", video_url: { url: dataUrl } };
    }
    return {
      type: "text",
      text: "[Attached video file — video input not supported by this model]",
    };
  }
  if (isFullMultimodal) {
    const base64Data = dataUrl.split(";base64,")[1] || "";
    const audioFormat = mime.split("/")[1] || "wav";
    return {
      type: "input_audio",
      input_audio: { data: base64Data, format: audioFormat },
    };
  }
  return {
    type: "text",
    text: "[Attached audio file — audio input not supported by this model]",
  };
}

function convertCompatDataUrlToPart(
  dataUrl: string,
  mediaStrategy: string,
): ContentPart {
  const mime = getDataUrlMimeType(dataUrl);
  if (!mime || mime.startsWith("image/")) {
    return { type: "image_url", image_url: { url: dataUrl } };
  }
  if (mime.startsWith("video/") || mime.startsWith("audio/")) {
    return convertCompatAudioOrVideoDataUrl(dataUrl, mime, mediaStrategy);
  }
  if (mime === "application/pdf") {
    return {
      type: "text",
      text: "[Attached PDF document — PDF input not supported by this model]",
    };
  }
  if (mime.startsWith("text/") || mime === "application/json") {
    return decodeCompatBase64TextPart(dataUrl, mime);
  }
  return { type: "image_url", image_url: { url: dataUrl } };
}

function collectCompatMediaContent(
  message: InputMessage,
  mediaStrategy: string,
): ContentPart[] {
  const content: ContentPart[] = [];
  if (mediaStrategy === MEDIA_STRATEGIES.IMAGES_ONLY) {
    for (const dataUrl of message.images || []) {
      content.push({ type: "image_url", image_url: { url: dataUrl } });
    }
    return content;
  }

  const mediaArrays = [
    message.images,
    message.audio,
    message.video,
    message.pdf,
  ];
  for (const array of mediaArrays) {
    if (!array || array.length === 0) continue;
    for (const dataUrl of array) {
      content.push(convertCompatDataUrlToPart(dataUrl, mediaStrategy));
    }
  }
  return content;
}

/**
 * Convert messages with media to OpenAI-compatible multipart content format.
 * Handles images, tool results, assistant tool calls, and optionally
 * audio/video/PDF based on the media strategy.
 */
export function prepareOpenAICompatMessages(
  messages: InputMessage[],
  {
    mediaStrategy = MEDIA_STRATEGIES.IMAGES_ONLY,
  }: { mediaStrategy?: string } = {},
): PreparedMessage[] {
  return messages.map((message) => {
    const base: { role: string; name?: string } = { role: message.role };
    if (message.name) base.name = message.name;

    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.tool_call_id || message.id || "",
        content:
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content),
      } as PreparedMessage;
    }

    if (
      message.role === "assistant" &&
      message.toolCalls &&
      message.toolCalls.length > 0
    ) {
      return buildCompatAssistantToolMessage(base, message);
    }

    const content = collectCompatMediaContent(message, mediaStrategy);
    const textContent =
      typeof message.content === "string" ? message.content : "";

    if (content.length > 0) {
      if (textContent) {
        content.push({ type: "text", text: textContent });
      }
      return { ...base, content } as PreparedMessage;
    }

    return {
      ...base,
      content: textContent || "",
    } as PreparedMessage;
  });
}

// ── Non-Streaming Response Processing ───────────────────────

/**
 * Result shape for a non-streaming completion, with empty-output diagnostics.
 */
interface CompatCompletionResult {
  text: string;
  thinking: string | null;
  usage: TokenUsage;
  toolCalls: ToolCallEntry[] | null;
  emptyOutputDiagnostic?: { finishReason: string | null; completionTokens: number };
}

/** Response processing when thinking is disabled: raw text, no <think> parsing. */
function _processWithoutThinking(
  data: OpenAICompletionResponse,
  message: NonNullable<OpenAICompletionResponse["choices"]>[number]["message"] | null | undefined,
  finishReason: string | null,
  rawText: string,
): CompatCompletionResult {
  const usage = normalizeUsage(data.usage);
  const toolCalls = extractToolCallsFromMessage(message ?? null);
  const isEmpty =
    rawText.trim() === "" && (!toolCalls || toolCalls.length === 0);
  if (isEmpty) {
    logger.warn(
      `[openai-compat] Zero-output completion (thinkingEnabled=false): finish_reason=${finishReason ?? "null"} completion_tokens=${usage.outputTokens ?? 0}`,
    );
  }
  return {
    text: rawText,
    thinking: null,
    usage,
    toolCalls,
    ...(isEmpty
      ? {
          emptyOutputDiagnostic: {
            finishReason,
            completionTokens: usage.outputTokens ?? 0,
          },
        }
      : {}),
  };
}

/** Response processing with thinking: native reasoning fields, else <think> tags. */
function _processWithThinking(
  data: OpenAICompletionResponse,
  message: NonNullable<OpenAICompletionResponse["choices"]>[number]["message"] | null | undefined,
  finishReason: string | null,
  rawText: string,
): CompatCompletionResult {
  // Check native reasoning fields first, fall back to <think> tag parsing
  const nativeThinking =
    message?.reasoning_content || message?.reasoning || null;
  const { thinking: tagThinking, text } = extractThinkTags(rawText);
  const thinking = nativeThinking || tagThinking;

  const usage = normalizeUsage(data.usage);
  const toolCalls = extractToolCallsFromMessage(message ?? null);
  const isEmpty =
    text.trim() === "" && !thinking && (!toolCalls || toolCalls.length === 0);
  if (isEmpty) {
    logger.warn(
      `[openai-compat] Zero-output completion: finish_reason=${finishReason ?? "null"} completion_tokens=${usage.outputTokens ?? 0}`,
    );
  }

  return {
    text,
    thinking,
    usage,
    toolCalls,
    ...(isEmpty
      ? {
          emptyOutputDiagnostic: {
            finishReason,
            completionTokens: usage.outputTokens ?? 0,
          },
        }
      : {}),
  };
}

/**
 * Process a non-streaming OpenAI-compatible chat completion response.
 * Extracts text, thinking (native + <think> tags), usage, and tool calls.
 *
 * When thinkingEnabled is false, thinking content is folded into the text
 * output and the `thinking` field is null.
 */
export function processNonStreamingResponse(
  data: OpenAICompletionResponse,
  options: { thinkingEnabled?: boolean } = {},
) {
  const choice = data.choices?.[0];
  const message = choice?.message;
  const finishReason = choice?.finish_reason ?? null;
  const rawText = message?.content || "";

  // When thinking is disabled, return raw text without parsing <think> tags
  if (options.thinkingEnabled === false) {
    return _processWithoutThinking(data, message, finishReason, rawText);
  }

  return _processWithThinking(data, message, finishReason, rawText);
}

// ── Text-markup tool call recovery ──────────────────────────

/**
 * Extract complete `<tool_call>…</tool_call>` tool call blocks from streamed text.
 *
 * Some models emit a tool call as plain content when the named tool is not
 * in the request `tools` array (vLLM cannot parse such a call natively), or
 * when a template renders the call as text. The strip regex in
 * StreamChunkDispatcher allows the `<|tool_call|>` variants mirrored here.
 *
 * Body formats:
 *   GLM:  `NAME<arg_key>K</arg_key><arg_value>V<arg_key>K2</arg_key>…`
 *         — values JSON-parsed, string fallback.
 *   JSON: `{"name": "...", "arguments": {...} | "..."}`.
 * Unparseable bodies are skipped (left as text).
 */
export interface MarkupToolCall {
  name: string;
  args: Record<string, unknown>;
  argsParseError?: boolean;
  rawArgs?: string;
}

const MARKUP_TOOL_CALL_BLOCK = /<\|?tool_call\|?>([\s\S]*?)<\/?\|?tool_call\|?>/gi;
const MARKUP_ARG_PAIR = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)(?:<\/arg_value>|(?=<arg_key>)|$)/g;

const parseMarkupValue = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

/** Parse the JSON body form (`{"name": ..., "arguments": ...}`); null when invalid. */
function _markupCallFromJsonBody(body: string): MarkupToolCall | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("name" in parsed) || typeof parsed.name !== "string" || !parsed.name) return null;
  const raw = "arguments" in parsed ? parsed.arguments : undefined;
  if (typeof raw === "string") {
    const value = parseMarkupValue(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) return { name: parsed.name, args: value as Record<string, unknown> };
    return { name: parsed.name, args: {}, argsParseError: true, rawArgs: raw.slice(0, 2000) };
  }
  return { name: parsed.name, args: raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {} };
}

/** Parse the GLM body form (`NAME<arg_key>K</arg_key><arg_value>V…`); null when not a call. */
function _markupCallFromGlmBody(body: string): MarkupToolCall | null {
  const firstKey = body.indexOf("<arg_key>");
  const name = (firstKey < 0 ? body : body.slice(0, firstKey)).trim();
  // A bare name with no args is a valid call; anything with spaces or markup is prose.
  if (!name || /[\s<>]/.test(name)) return null;
  const args: Record<string, unknown> = {};
  if (firstKey >= 0) {
    for (const pair of body.slice(firstKey).matchAll(MARKUP_ARG_PAIR)) {
      const key = pair[1].trim();
      if (key) args[key] = parseMarkupValue(pair[2].trim());
    }
  }
  return { name, args };
}

export function extractMarkupToolCalls(text: string): MarkupToolCall[] {
  const calls: MarkupToolCall[] = [];
  for (const match of text.matchAll(MARKUP_TOOL_CALL_BLOCK)) {
    const body = match[1].trim();
    const call = body.startsWith("{")
      ? _markupCallFromJsonBody(body)
      : _markupCallFromGlmBody(body);
    if (call) calls.push(call);
  }
  return calls;
}

/**
 * Parse an SSE stream from an OpenAI-compatible /v1/chat/completions endpoint.
 * Yields the same event types as the provider generateTextStream methods:
 *   - string (text content)
 *   - { type: "thinking", content } (reasoning content)
 *   - { type: "toolCall", id, name, args }
 *   - { type: "usage", usage }
 *
 * When thinkingEnabled is false, all thinking content (native reasoning_content
 * and <think> tag content) is yielded as plain text strings instead of
 * { type: "thinking" } events.
 */
interface SSEStreamAccumulator {
  usage: TokenUsage | null;
  suppressThinking: boolean;
  thinkParser: ThinkTagParser | null;
  pendingToolCalls: Record<number, PendingToolCall>;
  lastFinishReason: string | null;
  sawTerminalEvent: boolean;
  partialOutputCharacters: number;
  partialReasoningCharacters: number;
  markupContent: string;
  nativeToolCallsYielded: boolean;
}

function updateSSEUsageAndCallbacks(
  json: OpenAICompletionResponse,
  state: SSEStreamAccumulator,
  options: SSEParseOptions,
): void {
  if (json.usage) {
    state.usage = normalizeUsage(json.usage);
    if (options.onUsage) options.onUsage(json, state.usage);
  }
  if (options.onChunkJson) options.onChunkJson(json);
}

function* emitSSEDeltaReasoningAndContent(
  delta: NonNullable<OpenAICompletionResponse["choices"]>[number]["delta"],
  state: SSEStreamAccumulator,
): Generator<SSEStreamChunk> {
  const reasoning = delta?.reasoning_content || delta?.reasoning || "";
  if (reasoning) {
    state.partialReasoningCharacters += reasoning.length;
    if (state.suppressThinking) {
      yield reasoning;
    } else {
      yield { type: "thinking", content: reasoning };
    }
  }

  const content = delta?.content || "";
  if (!content) return;
  state.markupContent += content;
  state.partialOutputCharacters += content.length;
  if (state.suppressThinking) {
    yield content;
    return;
  }
  const parts = state.thinkParser!.feed(content);
  for (const part of parts) {
    if (part.type === "thinking") {
      yield { type: "thinking", content: part.content };
    } else {
      yield part.content;
    }
  }
}

function updateSinglePendingToolCall(
  toolCall: NonNullable<
    NonNullable<
      NonNullable<OpenAICompletionResponse["choices"]>[number]["delta"]
    >["tool_calls"]
  >[number],
  pendingToolCalls: Record<number, PendingToolCall>,
): { entry: PendingToolCall; addedChars: number; emitStart: boolean } {
  const index = toolCall.index ?? 0;
  if (!pendingToolCalls[index]) {
    pendingToolCalls[index] = {
      id: toolCall.id || "",
      name: toolCall.function?.name || toolCall.name || "",
      args: "",
      startEmitted: false,
    };
  }
  const entry = pendingToolCalls[index];
  if (toolCall.id) entry.id = toolCall.id;
  const chunkName = toolCall.function?.name || toolCall.name;
  if (chunkName) entry.name = chunkName;
  const chunkArgs = toolCall.function?.arguments || toolCall.arguments;
  let addedChars = 0;
  if (chunkArgs) {
    entry.args += chunkArgs;
    addedChars = chunkArgs.length;
  }
  const emitStart = Boolean(!entry.startEmitted && entry.name && entry.id);
  if (emitStart) {
    entry.startEmitted = true;
  }
  return { entry, addedChars, emitStart };
}

function* emitSSEDeltaToolCalls(
  toolCalls: NonNullable<
    NonNullable<
      NonNullable<OpenAICompletionResponse["choices"]>[number]["delta"]
    >["tool_calls"]
  >,
  state: SSEStreamAccumulator,
): Generator<SSEStreamChunk> {
  let deltaChars = 0;
  for (const toolCall of toolCalls) {
    const { entry, addedChars, emitStart } = updateSinglePendingToolCall(
      toolCall,
      state.pendingToolCalls,
    );
    deltaChars += addedChars;
    if (emitStart) {
      yield {
        type: "toolCallStart" as const,
        id: entry.id,
        name: entry.name,
      };
    }
  }
  if (deltaChars > 0) {
    yield { type: "toolCallDelta", characters: deltaChars };
  }
}

function* emitFinishedSSEToolCalls(
  state: SSEStreamAccumulator,
): Generator<SSEStreamChunk> {
  for (const toolCall of Object.values(state.pendingToolCalls)) {
    state.nativeToolCallsYielded = true;
    let args: Record<string, unknown> = {};
    let argsParseError = false;
    try {
      args = JSON.parse(toolCall.args || "{}");
    } catch {
      argsParseError = true;
    }
    yield {
      type: "toolCall",
      id: toolCall.id,
      name: toolCall.name,
      args,
      ...(argsParseError && {
        argsParseError: true,
        rawArgs: (toolCall.args || "").slice(0, 2000),
      }),
    };
  }
}

function* processSingleSSEDataJson(
  json: OpenAICompletionResponse,
  state: SSEStreamAccumulator,
  options: SSEParseOptions,
): Generator<SSEStreamChunk> {
  updateSSEUsageAndCallbacks(json, state, options);
  const delta = json.choices?.[0]?.delta;
  if (delta) {
    yield* emitSSEDeltaReasoningAndContent(delta, state);
    if (delta.tool_calls) {
      yield* emitSSEDeltaToolCalls(delta.tool_calls, state);
    }
  }
  const finishReason = json.choices?.[0]?.finish_reason;
  if (finishReason) {
    state.lastFinishReason = finishReason;
    state.sawTerminalEvent = true;
  }
  if (finishReason === "tool_calls" || finishReason === "tool") {
    yield* emitFinishedSSEToolCalls(state);
  }
}

function* processSingleSSELine(
  line: string,
  state: SSEStreamAccumulator,
  options: SSEParseOptions,
): Generator<SSEStreamChunk> {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return;
  if (trimmed === "data: [DONE]") {
    state.sawTerminalEvent = true;
    return;
  }
  if (!trimmed.startsWith("data: ")) return;
  try {
    const json = JSON.parse(trimmed.slice(6)) as OpenAICompletionResponse;
    yield* processSingleSSEDataJson(json, state, options);
  } catch {
    // skip malformed JSON lines
  }
}

function* finalizeSSEStreamOutput(
  state: SSEStreamAccumulator,
  options: SSEParseOptions,
): Generator<SSEStreamChunk> {
  if (!state.sawTerminalEvent && !options.signal?.aborted) {
    const label = options.label ?? "OpenAI-compatible";
    throw new ProviderError(
      label,
      `The ${label} stream ended before the response completed (no finish_reason)`,
      502,
    );
  }

  if (state.thinkParser) {
    for (const part of state.thinkParser.flush()) {
      if (part.type === "thinking") {
        yield { type: "thinking", content: part.content };
      } else {
        yield part.content;
      }
    }
  }

  if (!state.nativeToolCallsYielded) {
    let markupIndex = 0;
    for (const call of extractMarkupToolCalls(state.markupContent)) {
      yield {
        type: "toolCall",
        id: `call_markup_${markupIndex++}`,
        ...call,
      };
    }
  }

  if (state.lastFinishReason === "length") {
    yield { type: "stopReason", stopReason: "length" };
  }

  logZeroTokenSSEDiagnosticIfNeeded(state, options);
}

function logZeroTokenSSEDiagnosticIfNeeded(
  state: SSEStreamAccumulator,
  options: SSEParseOptions,
): void {
  const hasAnyOutput =
    state.partialOutputCharacters > 0 ||
    state.partialReasoningCharacters > 0 ||
    state.nativeToolCallsYielded ||
    Object.keys(state.pendingToolCalls).length > 0;
  if (!state.sawTerminalEvent || hasAnyOutput) return;
  logger.warn(
    `[${options.label ?? "openai-compat"}] Zero-token SSE completion: finish_reason=${state.lastFinishReason ?? "null"} completion_tokens=${state.usage?.outputTokens ?? 0} thinkingEnabled=${String(options.thinkingEnabled)}`,
  );
}

function buildErrorFallbackSSEUsage(
  state: SSEStreamAccumulator,
): SSEStreamChunk | null {
  if (state.usage) {
    return { type: "usage", usage: state.usage };
  }
  if (
    state.partialOutputCharacters > 0 ||
    state.partialReasoningCharacters > 0
  ) {
    const estimatedOutputTokens = Math.ceil(state.partialOutputCharacters / 4);
    const estimatedReasoningTokens = Math.ceil(
      state.partialReasoningCharacters / 4,
    );
    return {
      type: "usage",
      usage: {
        inputTokens: 0,
        outputTokens: estimatedOutputTokens + estimatedReasoningTokens,
        ...(estimatedReasoningTokens > 0 && {
          reasoningOutputTokens: estimatedReasoningTokens,
        }),
      },
    };
  }
  return null;
}

export async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: SSEParseOptions = {},
): AsyncGenerator<SSEStreamChunk> {
  const decoder = new TextDecoder();
  let buffer = "";
  const suppressThinking = options.thinkingEnabled === false;
  const state: SSEStreamAccumulator = {
    usage: null,
    suppressThinking,
    thinkParser: suppressThinking ? null : new ThinkTagParser(),
    pendingToolCalls: {},
    lastFinishReason: null,
    sawTerminalEvent: false,
    partialOutputCharacters: 0,
    partialReasoningCharacters: 0,
    markupContent: "",
    nativeToolCallsYielded: false,
  };
  let usageYielded = false;

  const abortHandler = () => {
    reader.cancel().catch(() => {});
  };
  if (options.signal && !options.signal.aborted) {
    options.signal.addEventListener("abort", abortHandler, { once: true });
  }
  try {
    while (true) {
      if (options.signal?.aborted) {
        reader.cancel().catch(() => {});
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        yield* processSingleSSELine(line, state, options);
      }
    }

    yield* finalizeSSEStreamOutput(state, options);
  } catch (streamError) {
    if (!usageYielded) {
      const fallbackUsage = buildErrorFallbackSSEUsage(state);
      if (fallbackUsage) {
        usageYielded = true;
        yield fallbackUsage;
      }
    }
    throw streamError;
  } finally {
    options.signal?.removeEventListener("abort", abortHandler);
    if (!usageYielded) {
      usageYielded = true;
      yield { type: "usage", usage: state.usage || EMPTY_USAGE };
    }
  }
}

// ── Fetch + Error Handling ──────────────────────────────────

/**
 * Make a fetch request to an OpenAI-compatible endpoint and handle
 * error responses consistently.
 *
 * @throws {Error} With a parsed error message from the API
 */
export async function fetchOpenAICompat(
  url: string,
  payload: Record<string, unknown>,
  options: FetchOptions = {},
): Promise<Response> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: JSON.stringify(payload),
    dispatcher: STREAMING_DISPATCHER,
    ...(options.signal && { signal: options.signal }),
  } as RequestInit & { dispatcher: typeof STREAMING_DISPATCHER });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMessage = `API error: ${response.status} ${errorText}`;
    try {
      const parsed = JSON.parse(errorText);
      if (parsed?.error?.message) errorMessage = parsed.error.message;
      else if (parsed?.message) errorMessage = parsed.message;
    } catch {
      /* raw text fallback */
    }
    // ported from prism-service providers/openai-compat.ts: the headers go
    // along for a Retry-After (computeRetryDelayMilliseconds) and the status
    // for isTransientProviderError — without them a 503 + Retry-After from
    // our own vllm-shim saturation shed is never retried.
    throw Object.assign(new Error(errorMessage), {
      status: response.status,
      headers: response.headers,
    });
  }

  return response;
}
