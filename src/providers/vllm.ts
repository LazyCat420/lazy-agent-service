import {
  ProviderOptions,
  ChatMessage,
  Provider,
  GenerateTextResult,
  StreamChunk,
} from "../types/provider.ts";
import { ProviderError } from "../utils/errors.ts";
import logger from "../utils/logger.ts";
import type { TokenUsage } from "../types/admin.ts";

import { TYPES, getDefaultModels } from "../config.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import { discoverContextWindow } from "../platform/models/discoverContextWindow.ts";
import {
  convertToolsToOpenAI,
  buildPayloadParams,
  prepareOpenAICompatMessages,
  processNonStreamingResponse,
  parseSSEStream,
  fetchOpenAICompat,
  rewriteNonLeadingSystemMessages,
  MEDIA_STRATEGIES,
  type OpenAICompletionResponse,
  prependIdentitySystemMessage,
  normalizeUsage,
} from "../utils/openai-compat.ts";
import type { InputMessage } from "../utils/openai-compat.ts";
import { currentRequestPriority } from "../services/RequestPriority.ts";

/**
 * ported from prism-service providers/local-request-features.ts: on an
 * instance started with --scheduling-policy priority, a background utility
 * call (memory extraction) carries `X-Vllm-Priority: 10` so interactive
 * turns are served first. Never sent otherwise — a non-zero priority is an
 * error on a server without priority scheduling.
 */
export const BACKGROUND_PRIORITY = 10;

export function vllmRequestHeaders(): Record<string, string> {
  if (
    process.env.PROVIDER_VLLM_PRIORITY_SCHEDULING === "true" &&
    currentRequestPriority() === "background"
  ) {
    return { "X-Vllm-Priority": String(BACKGROUND_PRIORITY) };
  }
  return {};
}

// NOTE(vllm-qwen3.6): The temporary non-leading system message rewrite
// (Qwen chat template workaround) now lives in utils/openai-compat.ts as
// `rewriteNonLeadingSystemMessages`, shared with PrismProxyService so the
// direct :7778 path and the proxied path apply identical transformations.

// ── Types ────────────────────────────────────────────────────

interface VllmEmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

interface VllmModel {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
}

interface VllmModelsResponse {
  object: string;
  data: VllmModel[];
}

function buildVllmSamplingExtensions(
  options: ProviderOptions,
): Record<string, unknown> {
  const ext: Record<string, unknown> = {};
  if (options.topK !== undefined && options.topK > 0) {
    ext.top_k = options.topK;
  }
  if (options.minP !== undefined) {
    ext.min_p = options.minP;
  }
  if (options.repeatPenalty !== undefined && options.repeatPenalty !== 1) {
    ext.repetition_penalty = options.repeatPenalty;
  }
  return ext;
}

function applyVllmToolsAndThinking(
  payload: Record<string, unknown>,
  options: ProviderOptions,
): void {
  if (payload.max_tokens !== undefined && Number(payload.max_tokens) < 1) {
    delete payload.max_tokens;
  }
  const tools = convertToolsToOpenAI(options.tools);
  if (tools) {
    payload.tools = tools;
    payload.tool_choice = options.toolChoice === "none" ? "none" : "auto";
  }
  if (options.thinkingEnabled !== undefined) {
    payload.enable_thinking = options.thinkingEnabled;
    payload.chat_template_kwargs = {
      enable_thinking: options.thinkingEnabled,
    };
  }
}

function buildVllmChatPayload(
  messages: ChatMessage[],
  model: string,
  options: ProviderOptions,
  stream: boolean,
): Record<string, unknown> {
  const rewrittenMessages = rewriteNonLeadingSystemMessages(
    prependIdentitySystemMessage(
      messages as InputMessage[],
      options.systemPrompt,
    ),
    model,
  );
  const prepared = prepareOpenAICompatMessages(rewrittenMessages, {
    mediaStrategy: MEDIA_STRATEGIES.FULL_MULTIMODAL,
  });

  const payload: Record<string, unknown> = {
    messages: prepared,
    model,
    ...buildPayloadParams(options),
    ...buildVllmSamplingExtensions(options),
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
  applyVllmToolsAndThinking(payload, options);
  return payload;
}

function formatVllmToolCall(toolCall: {
  id?: string;
  name: string;
  args?: unknown;
  thoughtSignature?: string | null;
}) {
  const validArgs =
    typeof toolCall.args === "object" && toolCall.args !== null
      ? (toolCall.args as Record<string, unknown>)
      : {};
  return {
    id: toolCall.id || "",
    name: toolCall.name,
    args: validArgs,
    thoughtSignature: toolCall.thoughtSignature || undefined,
  };
}

function normalizeVllmStreamChunk(chunk: unknown): StreamChunk {
  if (typeof chunk !== "object" || chunk === null) {
    return chunk as StreamChunk;
  }
  const typed = chunk as StreamChunk & {
    type?: string;
    id?: string;
    usage?: TokenUsage;
  };
  if (typed.type === "usage" && typed.usage) {
    return {
      type: "usage",
      usage: {
        ...typed.usage,
        inputTokens: typed.usage.inputTokens || 0,
        outputTokens: typed.usage.outputTokens || 0,
      },
    };
  }
  if (typed.type === "toolCall") {
    return {
      ...(typed as unknown as Record<string, unknown>),
      id: typed.id || "",
    } as StreamChunk;
  }
  return typed;
}

async function vllmGenerateText(
  baseUrl: string,
  messages: ChatMessage[],
  model: string,
  options: ProviderOptions,
): Promise<GenerateTextResult> {
  logger.provider("vLLM", `generateText model=${model} baseUrl=${baseUrl}`);
  try {
    const payload = buildVllmChatPayload(messages, model, options, false);
    const response = await fetchOpenAICompat(
      `${baseUrl}/v1/chat/completions`,
      payload,
      { headers: vllmRequestHeaders() },
    );
    const data = (await response.json()) as OpenAICompletionResponse;
    const { text, thinking, usage, toolCalls } = processNonStreamingResponse(
      data,
      { thinkingEnabled: options.thinkingEnabled },
    );

    const result: GenerateTextResult = {
      text,
      usage: {
        ...usage,
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
      },
    };
    if (thinking) result.thinking = thinking;
    if (toolCalls) {
      result.toolCalls = toolCalls.map(formatVllmToolCall);
    }
    return result;
  } catch (error: unknown) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("vllm", getErrorMessage(error), 500, error);
  }
}

async function* vllmGenerateTextStream(
  baseUrl: string,
  messages: ChatMessage[],
  model: string,
  options: ProviderOptions,
): AsyncGenerator<StreamChunk, void, unknown> {
  logger.provider(
    "vLLM",
    `generateTextStream model=${model} baseUrl=${baseUrl}`,
  );
  try {
    const payload = buildVllmChatPayload(messages, model, options, true);
    const response = await fetchOpenAICompat(
      `${baseUrl}/v1/chat/completions`,
      payload,
      { signal: options.signal, headers: vllmRequestHeaders() },
    );

    const reader = response.body!.getReader();
    for await (const chunk of parseSSEStream(reader, {
      label: "vllm",
      signal: options.signal,
      thinkingEnabled: options.thinkingEnabled,
    })) {
      yield normalizeVllmStreamChunk(chunk);
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") return;
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("vllm", getErrorMessage(error), 500, error);
  }
}

async function vllmCaptionImage(
  baseUrl: string,
  images: string[],
  prompt: string,
  model: string,
  systemPrompt?: string,
): Promise<{
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}> {
  logger.provider("vLLM", `captionImage model=${model} baseUrl=${baseUrl}`);
  try {
    const content = [
      { type: "text", text: prompt },
      ...images.map((image: string) => ({
        type: "image_url",
        image_url: { url: image },
      })),
    ];
    const messages: ChatMessage[] = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content });

    const response = await fetchOpenAICompat(`${baseUrl}/v1/chat/completions`, {
      messages,
      model,
      temperature: 0.7,
      stream: false,
    });

    const data = (await response.json()) as OpenAICompletionResponse;
    const text = data.choices?.[0]?.message?.content || "";
    const usage: TokenUsage = normalizeUsage(data.usage);
    return {
      text,
      usage: {
        ...usage,
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
      },
    };
  } catch (error: unknown) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("vllm", getErrorMessage(error), 500, error);
  }
}

async function vllmGenerateEmbedding(
  baseUrl: string,
  content: string | string[],
  model: string,
  options: ProviderOptions,
) {
  logger.provider(
    "vLLM",
    `generateEmbedding model=${model} baseUrl=${baseUrl}`,
  );
  try {
    const payload: Record<string, unknown> = {
      model,
      input: content,
    };
    if (options.dimensions) payload.dimensions = options.dimensions;

    const response = await fetchOpenAICompat(
      `${baseUrl}/v1/embeddings`,
      payload,
    );
    const data = (await response.json()) as VllmEmbeddingResponse;

    const embedding = data.data?.[0]?.embedding;
    if (!embedding) {
      throw new Error("No embedding data in vLLM response");
    }

    return {
      embedding,
      dimensions: embedding.length,
    };
  } catch (error: unknown) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("vllm", getErrorMessage(error), 500, error);
  }
}

async function vllmCheckHealth(baseUrl: string) {
  logger.provider("vLLM", "checkHealth");
  try {
    const response = await fetch(`${baseUrl}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });
    return {
      ok: response.ok,
      status: response.ok ? "ok" : "error",
    };
  } catch (error: unknown) {
    return {
      ok: false,
      status: "unreachable",
      error: getErrorMessage(error),
    };
  }
}

async function vllmListModels(baseUrl: string) {
  logger.provider("vLLM", "listModels");
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error: ${response.status} ${errorText}`);
    }
    const data = (await response.json()) as VllmModelsResponse;
    const models = (data.data || []).map((modelItem: VllmModel) => ({
      key: modelItem.id,
      display_name: modelItem.id,
      type: "llm",
      loaded_instances: [{ id: modelItem.id }],
    }));
    return { models };
  } catch (error: unknown) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("vllm", getErrorMessage(error), 500, error);
  }
}

async function vllmDiscoverContextWindow(
  baseUrl: string,
  model: string,
  options: ProviderOptions,
): Promise<void> {
  if (options._loadedContextLength) return;
  const discovered = await discoverContextWindow(baseUrl, model);
  if (discovered) {
    options._loadedContextLength = discovered;
    logger.info(
      `[ContextDiscovery] vllm model=${model} → contextLength=${discovered}`,
    );
  }
}

// ── Provider ─────────────────────────────────────────────────
export function createVllmProvider(
  baseUrl: string,
  instanceId: string = "vllm",
): Provider {
  return {
    name: instanceId,
    generateText(
      messages: ChatMessage[],
      model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["vllm"],
      options: ProviderOptions = {},
    ): Promise<GenerateTextResult> {
      return vllmGenerateText(baseUrl, messages, model, options);
    },
    generateTextStream(
      messages: ChatMessage[],
      model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["vllm"],
      options: ProviderOptions = {},
    ): AsyncGenerator<StreamChunk, void, unknown> {
      return vllmGenerateTextStream(baseUrl, messages, model, options);
    },
    captionImage(
      images: string[],
      prompt: string = "Describe this image.",
      model: string = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)["vllm"],
      systemPrompt?: string,
    ) {
      return vllmCaptionImage(baseUrl, images, prompt, model, systemPrompt);
    },
    generateEmbedding(
      content: string | string[],
      model: string,
      options: ProviderOptions = {},
    ) {
      return vllmGenerateEmbedding(baseUrl, content, model, options);
    },
    checkHealth() {
      return vllmCheckHealth(baseUrl);
    },
    listModels() {
      return vllmListModels(baseUrl);
    },
    discoverContextWindow(model: string, options: ProviderOptions) {
      return vllmDiscoverContextWindow(baseUrl, model, options);
    },
  };
}
