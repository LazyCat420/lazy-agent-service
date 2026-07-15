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
} from "../utils/openai-compat.ts";
import type { InputMessage } from "../utils/openai-compat.ts";

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

// ── Provider ─────────────────────────────────────────────────
export function createVllmProvider(
  baseUrl: string,
  instanceId: string = "vllm",
): Provider {
  const getBaseUrl = () => baseUrl;

  return {
    name: instanceId,

    async generateText(
      messages: ChatMessage[],
      model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["vllm"],
      options: ProviderOptions = {},
    ): Promise<GenerateTextResult> {
      const baseUrl = getBaseUrl();
      logger.provider("vLLM", `generateText model=${model} baseUrl=${baseUrl}`);
      try {
        const rewrittenMessages = rewriteNonLeadingSystemMessages(
          messages as InputMessage[],
          model,
        );
        const prepared = prepareOpenAICompatMessages(rewrittenMessages, {
          mediaStrategy: MEDIA_STRATEGIES.FULL_MULTIMODAL,
        });

        const payload: Record<string, unknown> = {
          messages: prepared,
          model,
          ...buildPayloadParams(options),
          // vLLM extensions: top_k, min_p, repetition_penalty
          ...(options.topK !== undefined &&
            options.topK > 0 && { top_k: options.topK }),
          ...(options.minP !== undefined && { min_p: options.minP }),
          ...(options.repeatPenalty !== undefined &&
            options.repeatPenalty !== 1 && {
              repetition_penalty: options.repeatPenalty,
            }),
          stream: false,
        };

        // Function calling tools
        const tools = convertToolsToOpenAI(options.tools);
        if (tools) {
          payload.tools = tools;
          payload.tool_choice = "auto";
        }

        // Thinking hard switch — vLLM extension for Qwen3/reasoning models
        // Uses chat_template_kwargs to control <think> token generation
        if (options.thinkingEnabled !== undefined) {
          payload.chat_template_kwargs = {
            enable_thinking: options.thinkingEnabled,
          };
        }

        const response = await fetchOpenAICompat(
          `${baseUrl}/v1/chat/completions`,
          payload,
        );
        const data = (await response.json()) as OpenAICompletionResponse;
        const { text, thinking, usage, toolCalls } =
          processNonStreamingResponse(data, {
            thinkingEnabled: options.thinkingEnabled,
          });

        const result: GenerateTextResult = {
          text,
          usage: {
            inputTokens: usage.inputTokens || 0,
            outputTokens: usage.outputTokens || 0,
          },
        };
        if (thinking) result.thinking = thinking;
        if (toolCalls) {
          result.toolCalls = toolCalls.map((toolCall) => ({
            id: toolCall.id || "",
            name: toolCall.name,
            args:
              typeof toolCall.args === "object" && toolCall.args !== null
                ? (toolCall.args as Record<string, unknown>)
                : {},
            thoughtSignature: toolCall.thoughtSignature || undefined,
          }));
        }
        return result;
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("vllm", getErrorMessage(error), 500, error);
      }
    },

    // ── Streaming Text Generation (SSE) ──────────────────────

    async *generateTextStream(
      messages: ChatMessage[],
      model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["vllm"],
      options: ProviderOptions = {},
    ): AsyncGenerator<StreamChunk, void, unknown> {
      const baseUrl = getBaseUrl();
      logger.provider(
        "vLLM",
        `generateTextStream model=${model} baseUrl=${baseUrl}`,
      );
      try {
        const rewrittenMessages = rewriteNonLeadingSystemMessages(
          messages as InputMessage[],
          model,
        );
        const prepared = prepareOpenAICompatMessages(rewrittenMessages, {
          mediaStrategy: MEDIA_STRATEGIES.FULL_MULTIMODAL,
        });

        const payload: Record<string, unknown> = {
          messages: prepared,
          model,
          ...buildPayloadParams(options),
          // vLLM extensions: top_k, min_p, repetition_penalty
          ...(options.topK !== undefined &&
            options.topK > 0 && { top_k: options.topK }),
          ...(options.minP !== undefined && { min_p: options.minP }),
          ...(options.repeatPenalty !== undefined &&
            options.repeatPenalty !== 1 && {
              repetition_penalty: options.repeatPenalty,
            }),
          stream: true,
          stream_options: { include_usage: true },
        };

        // Function calling tools
        const tools = convertToolsToOpenAI(options.tools);
        if (tools) {
          payload.tools = tools;
          payload.tool_choice = "auto";
        }

        // Thinking hard switch — vLLM extension for Qwen3/reasoning models
        if (options.thinkingEnabled !== undefined) {
          payload.chat_template_kwargs = {
            enable_thinking: options.thinkingEnabled,
          };
        }

        const response = await fetchOpenAICompat(
          `${baseUrl}/v1/chat/completions`,
          payload,
          { signal: options.signal },
        );

        const reader = response.body!.getReader();
        for await (const chunk of parseSSEStream(reader, {
          signal: options.signal,
          thinkingEnabled: options.thinkingEnabled,
        })) {
          if (typeof chunk === "object") {
            if (chunk.type === "usage") {
              yield {
                type: "usage",
                usage: {
                  inputTokens: chunk.usage.inputTokens || 0,
                  outputTokens: chunk.usage.outputTokens || 0,
                },
              };
            } else if (chunk.type === "toolCall") {
              yield {
                ...chunk,
                id: chunk.id || "",
              };
            } else {
              yield chunk as StreamChunk;
            }
          } else {
            yield chunk;
          }
        }
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") return; // Client disconnected
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("vllm", getErrorMessage(error), 500, error);
      }
    },

    async captionImage(
      images: string[],
      prompt: string = "Describe this image.",
      model: string = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)["vllm"],
      systemPrompt?: string,
    ): Promise<{
      text: string;
      usage: { inputTokens: number; outputTokens: number };
    }> {
      const baseUrl = getBaseUrl();
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

        const response = await fetchOpenAICompat(
          `${baseUrl}/v1/chat/completions`,
          {
            messages,
            model,
            temperature: 0.7,
            max_tokens: -1,
            stream: false,
          },
        );

        const data = (await response.json()) as OpenAICompletionResponse;
        const text = data.choices?.[0]?.message?.content || "";
        const usage: TokenUsage = {
          inputTokens: data.usage?.prompt_tokens || 0,
          outputTokens: data.usage?.completion_tokens || 0,
        };
        return {
          text,
          usage: {
            inputTokens: usage.inputTokens || 0,
            outputTokens: usage.outputTokens || 0,
          },
        };
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("vllm", getErrorMessage(error), 500, error);
      }
    },

    // ── Embedding Generation ─────────────────────────────────

    /**
     * Generate an embedding via the OpenAI-compatible /v1/embeddings endpoint.
     * vLLM also exposes /v2/embed, but /v1/embeddings keeps the response
     * contract identical to the OpenAI provider.
     */
    async generateEmbedding(
      content: string | string[],
      model: string,
      options: ProviderOptions = {},
    ) {
      const baseUrl = getBaseUrl();
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
    },

    // ── Health Check ─────────────────────────────────────────
    // GET /health — lightweight readiness probe

    async checkHealth() {
      const baseUrl = getBaseUrl();
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
    },

    // ── Model Listing ────────────────────────────────────────

    async listModels() {
      const baseUrl = getBaseUrl();
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
    },
  };
}
