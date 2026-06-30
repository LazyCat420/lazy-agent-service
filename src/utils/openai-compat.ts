// ─────────────────────────────────────────────────────────────
// OpenAI-Compatible Provider Utilities
// ─────────────────────────────────────────────────────────────
// Shared helpers for providers that use the OpenAI Chat Completions
// API format: lm-studio, vllm, llama-cpp, and openai itself.

import { Agent } from "undici";
import { getDataUrlMimeType } from "./media.ts";
import { ThinkTagParser, extractThinkTags } from "./ThinkTagParser.ts";
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
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
}

interface SSEParseOptions {
  signal?: AbortSignal;
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
  return messages.map((message, _i) => {
    const base: { role: string; name?: string } = { role: message.role };
    if (message.name) base.name = message.name;

    // Tool result messages — include tool_call_id for correlation
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

    // Assistant messages with tool calls — include tool_calls in OpenAI format
    if (
      message.role === "assistant" &&
      message.toolCalls &&
      message.toolCalls.length > 0
    ) {
      return {
        ...base,
        // Per OpenAI spec, content must be null when tool_calls are present
        content:
          (typeof message.content === "string" ? message.content.trim() : "") ||
          null,
        tool_calls: message.toolCalls.map(
          (toolCall: ToolCallEntry, i: number) => ({
            id: toolCall.id || `call_${i}`,
            type: "function",
            function: {
              name: toolCall.name,
              arguments:
                typeof toolCall.args === "string"
                  ? toolCall.args
                  : JSON.stringify(toolCall.args || {}),
            },
          }),
        ),
      } as PreparedMessage;
    }

    // Collect media content based on strategy
    const content: ContentPart[] = [];

    if (mediaStrategy === MEDIA_STRATEGIES.IMAGES_ONLY) {
      // Simple image-only handling (lm-studio)
      if (message.images && message.images.length > 0) {
        for (const dataUrl of message.images) {
          content.push({ type: "image_url", image_url: { url: dataUrl } });
        }
      }
    } else {
      // Full media handling (vllm, llama-cpp)
      const mediaFields: Array<{ key: string; values: string[] | undefined }> =
        [
          { key: "images", values: message.images },
          { key: "audio", values: message.audio },
          { key: "video", values: message.video },
          { key: "pdf", values: message.pdf },
        ];
      for (const { values: array } of mediaFields) {
        if (!array || array.length === 0) continue;

        for (const dataUrl of array) {
          const mime = getDataUrlMimeType(dataUrl);

          if (mime && mime.startsWith("image/")) {
            content.push({ type: "image_url", image_url: { url: dataUrl } });
          } else if (mime && mime.startsWith("video/")) {
            if (mediaStrategy === MEDIA_STRATEGIES.FULL_MULTIMODAL) {
              content.push({ type: "video_url", video_url: { url: dataUrl } });
            } else {
              content.push({
                type: "text",
                text: "[Attached video file — video input not supported by this model]",
              });
            }
          } else if (mime && mime.startsWith("audio/")) {
            if (mediaStrategy === MEDIA_STRATEGIES.FULL_MULTIMODAL) {
              const base64Data = dataUrl.split(";base64,")[1] || "";
              const audioFormat = mime.split("/")[1] || "wav";
              content.push({
                type: "input_audio",
                input_audio: { data: base64Data, format: audioFormat },
              });
            } else {
              content.push({
                type: "text",
                text: "[Attached audio file — audio input not supported by this model]",
              });
            }
          } else if (mime === "application/pdf") {
            content.push({
              type: "text",
              text: "[Attached PDF document — PDF input not supported by this model]",
            });
          } else if (
            mime &&
            (mime.startsWith("text/") || mime === "application/json")
          ) {
            try {
              const base64 = dataUrl.split(";base64,")[1];
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
            // Fallback — try image_url passthrough for any types
            content.push({ type: "image_url", image_url: { url: dataUrl } });
          }
        }
      }
    }

    if (content.length > 0) {
      const textContent =
        typeof message.content === "string" ? message.content : "";
      if (textContent) {
        content.push({ type: "text", text: textContent });
      }
      return { ...base, content } as PreparedMessage;
    }

    return {
      ...base,
      content:
        (typeof message.content === "string" ? message.content : "") || "",
    } as PreparedMessage;
  });
}

// ── Non-Streaming Response Processing ───────────────────────

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
  const message = data.choices?.[0]?.message;
  const rawText = message?.content || "";

  // When thinking is disabled, return raw text without parsing <think> tags
  if (options.thinkingEnabled === false) {
    const usage = normalizeUsage(data.usage);
    const toolCalls = extractToolCallsFromMessage(message ?? null);
    return { text: rawText, thinking: null, usage, toolCalls };
  }

  // Check native reasoning fields first, fall back to <think> tag parsing
  const nativeThinking =
    message?.reasoning_content || message?.reasoning || null;
  const { thinking: tagThinking, text } = extractThinkTags(rawText);
  const thinking = nativeThinking || tagThinking;

  const usage = normalizeUsage(data.usage);
  const toolCalls = extractToolCallsFromMessage(message ?? null);

  return { text, thinking, usage, toolCalls };
}

// ── SSE Stream Parsing ──────────────────────────────────────

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
export async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: SSEParseOptions = {},
): AsyncGenerator<SSEStreamChunk> {
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: TokenUsage | null = null;
  const suppressThinking = options.thinkingEnabled === false;
  // Skip ThinkTagParser entirely when thinking is disabled — no overhead
  const thinkParser = suppressThinking ? null : new ThinkTagParser();
  const pendingToolCalls: Record<number, PendingToolCall> = {};
  let lastFinishReason: string | null = null;
  // Track partial output for fallback usage estimation on premature termination
  let partialOutputCharacters = 0;
  let partialReasoningCharacters = 0;
  let usageYielded = false;

  // Reactive abort: when the signal fires, cancel the reader immediately
  // so the pending reader.read() resolves with { done: true } instead of
  // blocking until the next chunk arrives from the upstream server.
  // Without this, llama.cpp keeps generating until the loop-top poll fires.
  const abortHandler = () => reader.cancel();
  if (options.signal && !options.signal.aborted) {
    options.signal.addEventListener("abort", abortHandler, { once: true });
  }
  try {
    while (true) {
      if (options.signal?.aborted) {
        reader.cancel();
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue; // skip empty lines / comments
        if (trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;

        try {
          const json = JSON.parse(trimmed.slice(6)) as OpenAICompletionResponse;

          // Extract usage if present (some servers send it on the last chunk)
          if (json.usage) {
            usage = normalizeUsage(json.usage);
            // Let provider handle extensions (e.g. llama.cpp timings)
            if (options.onUsage) options.onUsage(json, usage);
          }

          // Let provider handle custom fields
          if (options.onChunkJson) options.onChunkJson(json);

          const delta = json.choices?.[0]?.delta;

          // Native reasoning fields (Qwen3.5, DeepSeek, etc.)
          const reasoning = delta?.reasoning_content || delta?.reasoning || "";
          if (reasoning) {
            partialReasoningCharacters += reasoning.length;
            if (suppressThinking) {
              yield reasoning; // Emit as plain text
            } else {
              yield { type: "thinking", content: reasoning };
            }
          }

          const content = delta?.content || "";
          if (content) {
            partialOutputCharacters += content.length;
            if (suppressThinking) {
              // Pass through raw content without <think> tag parsing
              yield content;
            } else {
              // Parse <think> tags from the streamed content
              const parts = thinkParser!.feed(content);
              for (const part of parts) {
                if (part.type === "thinking") {
                  yield { type: "thinking", content: part.content };
                } else {
                  yield part.content;
                }
              }
            }
          }

          // Accumulate tool call deltas and yield progress events so
          // consumers (AgenticLoopService) can track generation throughput
          // during tool call argument streaming.
          if (delta?.tool_calls) {
            let deltaChars = 0;
            for (const toolCall of delta.tool_calls) {
              const index = toolCall.index ?? 0;
              if (!pendingToolCalls[index]) {
                pendingToolCalls[index] = {
                  id: toolCall.id || "",
                  name: toolCall.function?.name || toolCall.name || "",
                  args: "",
                  startEmitted: false,
                };
              }
              if (toolCall.id) pendingToolCalls[index].id = toolCall.id;
              const chunkName = toolCall.function?.name || toolCall.name;
              if (chunkName) pendingToolCalls[index].name = chunkName;
              const chunkArgs =
                toolCall.function?.arguments || toolCall.arguments;
              if (chunkArgs) {
                pendingToolCalls[index].args += chunkArgs;
                deltaChars += chunkArgs.length;
              }
              if (
                !pendingToolCalls[index].startEmitted &&
                pendingToolCalls[index].name &&
                pendingToolCalls[index].id
              ) {
                pendingToolCalls[index].startEmitted = true;
                yield {
                  type: "toolCallStart" as const,
                  id: pendingToolCalls[index].id,
                  name: pendingToolCalls[index].name,
                };
              }
            }
            // Yield a lightweight progress event so the generation tracker
            // sees continuous output during tool call JSON streaming.
            if (deltaChars > 0) {
              yield { type: "toolCallDelta", characters: deltaChars };
            }
          }

          // If finish_reason indicates tool calls, yield accumulated tool calls
          const finishReason = json.choices?.[0]?.finish_reason;
          if (finishReason) lastFinishReason = finishReason;
          if (finishReason === "tool_calls" || finishReason === "tool") {
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
        } catch {
          // skip malformed JSON lines
        }
      }
    }

    // Flush any remaining buffered content from the think parser
    if (thinkParser) {
      const remaining = thinkParser.flush();
      for (const part of remaining) {
        if (part.type === "thinking") {
          yield { type: "thinking", content: part.content };
        } else {
          yield part.content;
        }
      }
    }

    // Surface max_tokens truncation so harnesses can detect and warn the user
    if (lastFinishReason === "length") {
      yield { type: "stopReason", stopReason: "length" };
    }
  } catch (streamError) {
    // Yield partial usage BEFORE re-throwing so the consumer captures
    // whatever tokens were generated before the stream terminated.
    if (!usageYielded) {
      usageYielded = true;
      if (usage) {
        yield { type: "usage", usage };
      } else if (
        partialOutputCharacters > 0 ||
        partialReasoningCharacters > 0
      ) {
        const estimatedOutputTokens = Math.ceil(partialOutputCharacters / 4);
        const estimatedReasoningTokens = Math.ceil(
          partialReasoningCharacters / 4,
        );
        yield {
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
    }
    throw streamError;
  } finally {
    // Clean up the reactive abort listener
    options.signal?.removeEventListener("abort", abortHandler);
    // Happy path: yield final usage if stream completed normally
    if (!usageYielded) {
      usageYielded = true;
      if (usage) {
        yield { type: "usage", usage };
      } else {
        yield { type: "usage", usage: EMPTY_USAGE };
      }
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
    headers: { "Content-Type": "application/json" },
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
    throw new Error(errorMessage);
  }

  return response;
}
