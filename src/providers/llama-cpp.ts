import {
  ProviderOptions,
  ChatMessage,
  Provider,
  GenerateTextResult,
  StreamChunk,
} from "../types/provider.ts";
// ─────────────────────────────────────────────────────────────
// llama.cpp Provider (llama-server)
// ─────────────────────────────────────────────────────────────
// Uses the OpenAI-compatible API exposed by llama-server:
//   POST /v1/chat/completions  — chat completions (stream & non-stream)
//   GET  /v1/models            — list loaded models
//   GET  /health               — server health / readiness check
//
// Docs: https://github.com/ggml-org/llama.cpp/tree/master/tools/server
//
// The /v1/chat/completions endpoint accepts standard OpenAI fields:
//   model, messages, stream, temperature, top_p, frequency_penalty,
//   presence_penalty, max_tokens, stop, tools, stream_options
//
// llama.cpp-specific extensions (passed via top-level body):
//   top_k, min_p, repeat_penalty, grammar, json_schema
//
// Streaming uses standard SSE with "data: " prefix lines.
// The final event is "data: [DONE]".
//
// /v1/models returns:
//   { object: "list", data: [{ id, object: "model", owned_by, created }] }
//
// /health returns:
//   200 { status: "ok", slots_idle: N, slots_processing: M }
//   503 { status: "loading model" }
//   500 { status: "error" }
// ─────────────────────────────────────────────────────────────

import { ProviderError } from "../utils/errors.ts";
import logger from "../utils/logger.ts";

import { TYPES, getDefaultModels } from "../config.ts";
import {
  convertToolsToOpenAI,
  buildPayloadParams,
  prepareOpenAICompatMessages,
  expandVideoToFrames,
  processNonStreamingResponse,
  parseSSEStream,
  fetchOpenAICompat,
  MEDIA_STRATEGIES,
  type OpenAICompletionResponse,
  prependIdentitySystemMessage,
} from "../utils/openai-compat.ts";
import type { TokenUsage } from "../types/admin.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

// ── Types ────────────────────────────────────────────────────

interface LlamaCppTimings {
  predicted_per_second?: number;
}

interface LlamaCppCompletionResponse extends OpenAICompletionResponse {
  timings?: LlamaCppTimings;
}

interface LlamaCppModel {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
}

interface LlamaCppModelsResponse {
  object: string;
  data: LlamaCppModel[];
}

interface LlamaCppEmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

interface HealthResponse {
  status: string;
  slots_idle?: number;
  slots_processing?: number;
  error?: { message: string };
}

// ── Server Props Types ───────────────────────────────────────

interface LlamaCppPropsResponse {
  default_generation_settings?: {
    n_ctx?: number;
    params?: {
      temperature?: number;
      top_k?: number;
      top_p?: number;
      min_p?: number;
      repeat_penalty?: number;
      presence_penalty?: number;
      frequency_penalty?: number;
      seed?: number;
      n_predict?: number;
      samplers?: string[];
    };
    cache_type_k?: string;
    cache_type_v?: string;
  };
  total_slots?: number;
  model_path?: string;
  model_alias?: string;
  chat_template?: string;
  modalities?: {
    vision?: boolean;
    audio?: boolean;
  };
  endpoint_slots?: boolean;
  endpoint_metrics?: boolean;
  endpoint_props?: boolean;
  webui?: boolean;
}

interface LlamaCppSlotEntry {
  id: number;
  state?: number;
  model?: string;
  n_ctx?: number;
  n_past?: number;
  n_predict?: number;
  prompt_tokens?: number;
  tokens_predicted?: number;
  cache_tokens?: number;
  is_processing?: boolean;
  task_id?: number;
}

export interface LlamaCppServerProps {
  totalSlots: number;
  modelPath: string | null;
  modelAlias: string | null;
  chatTemplate: string | null;
  modalities: { vision: boolean; audio: boolean } | null;
  endpointSlots: boolean;
  endpointMetrics: boolean;
  defaultGenerationSettings: {
    contextLength: number;
    temperature: number;
    topK: number;
    topP: number;
    minP: number;
    repeatPenalty: number;
    presencePenalty: number;
    frequencyPenalty: number;
    seed: number;
    maxTokens: number;
    samplers: string[];
    cacheTypeK: string | null;
    cacheTypeV: string | null;
  } | null;
  slots: Array<{
    id: number;
    state: string;
    model: string | null;
    contextLength: number;
    tokensUsed: number;
    tokensPredicted: number;
    cacheTokens: number;
    isProcessing: boolean;
  }>;
  health: {
    status: string;
    slotsIdle: number | null;
    slotsProcessing: number | null;
  } | null;
}

// ── Provider ─────────────────────────────────────────────────
export function createLlamaCppProvider(
  baseUrl: string,
  instanceId: string = "llama-cpp",
): Provider & { getServerProps: () => Promise<LlamaCppServerProps> } {
  const getBaseUrl = () => baseUrl;

  return {
    name: instanceId,

    // ── Non-Streaming Text Generation ──────────────────────────
    // POST /v1/chat/completions with stream: false

    async generateText(
      messages: ChatMessage[],
      model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["llama-cpp"],
      options: ProviderOptions = {},
    ): Promise<GenerateTextResult> {
      const baseUrl = getBaseUrl();
      logger.provider(
        "llama.cpp",
        `generateText model=${model} baseUrl=${baseUrl}`,
      );
      try {
        // Expand video attachments to image frames (ffmpeg) before message prep
        await expandVideoToFrames(messages);

        const prepared = prepareOpenAICompatMessages(prependIdentitySystemMessage(messages, options.systemPrompt), {
          mediaStrategy: MEDIA_STRATEGIES.TEXT_FALLBACK,
        });

        const payload: Record<string, unknown> = {
          messages: prepared,
          model,
          ...buildPayloadParams(options),
          // llama.cpp extension: top_k
          ...(options.topK !== undefined &&
            options.topK > 0 && { top_k: options.topK }),
          // llama.cpp extension: min_p sampling
          ...(options.minP !== undefined && { min_p: options.minP }),
          // llama.cpp extension: repeat_penalty
          ...(options.repeatPenalty !== undefined &&
            options.repeatPenalty !== 1 && {
              repeat_penalty: options.repeatPenalty,
            }),
          stream: false,
        };

        // Function calling tools — standard OpenAI tool schema
        const tools = convertToolsToOpenAI(options.tools);
        if (tools) {
          payload.tools = tools;
          payload.tool_choice = "auto";
        }

        const response = await fetchOpenAICompat(
          `${baseUrl}/v1/chat/completions`,
          payload,
        );
        const data = (await response.json()) as LlamaCppCompletionResponse;
        const { text, thinking, usage, toolCalls } =
          processNonStreamingResponse(data, {
            thinkingEnabled: options.thinkingEnabled,
          });

        // Extract timings for tok/s reporting (llama.cpp extension)
        if (data.timings?.predicted_per_second) {
          usage.tokensPerSec = parseFloat(
            data.timings.predicted_per_second.toFixed(1),
          );
        }

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
        throw new ProviderError(
          "llama-cpp",
          getErrorMessage(error),
          500,
          error,
        );
      }
    },

    // ── Streaming Text Generation (SSE) ──────────────────────

    async *generateTextStream(
      messages: ChatMessage[],
      model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["llama-cpp"],
      options: ProviderOptions = {},
    ): AsyncGenerator<StreamChunk, void, unknown> {
      const baseUrl = getBaseUrl();
      logger.provider(
        "llama.cpp",
        `generateTextStream model=${model} baseUrl=${baseUrl}`,
      );
      try {
        // Expand video attachments to image frames (ffmpeg) before message prep
        await expandVideoToFrames(messages);

        const prepared = prepareOpenAICompatMessages(prependIdentitySystemMessage(messages, options.systemPrompt), {
          mediaStrategy: MEDIA_STRATEGIES.TEXT_FALLBACK,
        });

        const payload: Record<string, unknown> = {
          messages: prepared,
          model,
          ...buildPayloadParams(options),
          // llama.cpp extension: top_k
          ...(options.topK !== undefined &&
            options.topK > 0 && { top_k: options.topK }),
          // llama.cpp extension: min_p sampling
          ...(options.minP !== undefined && { min_p: options.minP }),
          // llama.cpp extension: repeat_penalty
          ...(options.repeatPenalty !== undefined &&
            options.repeatPenalty !== 1 && {
              repeat_penalty: options.repeatPenalty,
            }),
          stream: true,
          // Per OpenAI spec: request usage stats in the final SSE chunk
          stream_options: { include_usage: true },
        };

        // Function calling tools
        const tools = convertToolsToOpenAI(options.tools);
        if (tools) {
          payload.tools = tools;
          payload.tool_choice = "auto";
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
          // llama.cpp extension: extract timings for tok/s
          onUsage: (json: OpenAICompletionResponse, usage: TokenUsage) => {
            const timings = (json as LlamaCppCompletionResponse).timings;
            if (timings?.predicted_per_second) {
              usage.tokensPerSec = parseFloat(
                timings.predicted_per_second.toFixed(1),
              );
            }
          },
        })) {
          if (typeof chunk === "object") {
            if (chunk.type === "usage") {
              yield {
                type: "usage",
                usage: {
                  inputTokens: chunk.usage.inputTokens || 0,
                  outputTokens: chunk.usage.outputTokens || 0,
                  ...(chunk.usage.tokensPerSec != null && {
                    tokensPerSec: chunk.usage.tokensPerSec,
                  }),
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
        throw new ProviderError(
          "llama-cpp",
          getErrorMessage(error),
          500,
          error,
        );
      }
    },

    // ── Image Captioning ──────────────────────────────────────
    // Uses POST /v1/chat/completions with image_url content parts.
    // Requires a vision-capable model (LLaVA, Qwen-VL, etc.)

    async captionImage(
      images: string[],
      prompt: string = "Describe this image.",
      model: string = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)["llama-cpp"],
      systemPrompt?: string,
    ): Promise<{
      text: string;
      usage: { inputTokens: number; outputTokens: number };
    }> {
      const baseUrl = getBaseUrl();
      logger.provider(
        "llama.cpp",
        `captionImage model=${model} baseUrl=${baseUrl}`,
      );
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
        throw new ProviderError(
          "llama-cpp",
          getErrorMessage(error),
          500,
          error,
        );
      }
    },

    // ── Embedding Generation ─────────────────────────────────
    // POST /v1/embeddings — requires llama-server started with --embedding

    async generateEmbedding(
      content: string | string[],
      model: string,
      options: ProviderOptions = {},
    ) {
      const baseUrl = getBaseUrl();
      logger.provider(
        "llama.cpp",
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
        const data = (await response.json()) as LlamaCppEmbeddingResponse;

        const embedding = data.data?.[0]?.embedding;
        if (!embedding) {
          throw new Error("No embedding data in llama.cpp response");
        }

        return {
          embedding,
          dimensions: embedding.length,
        };
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          "llama-cpp",
          getErrorMessage(error),
          500,
          error,
        );
      }
    },

    // ── Model Listing ────────────────────────────────────────
    // GET /v1/models

    async listModels(): Promise<{
      models: Array<{
        key: string;
        display_name: string;
        type: string;
        loaded_instances?: Array<{ id: string }>;
      }>;
    }> {
      const baseUrl = getBaseUrl();
      logger.provider("llama.cpp", "listModels");
      try {
        const response = await fetch(`${baseUrl}/v1/models`, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        });
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API error: ${response.status} ${errorText}`);
        }
        const data = (await response.json()) as LlamaCppModelsResponse;
        // Normalize to our standard { models: [...] } format
        const models = (data.data || []).map((model: LlamaCppModel) => ({
          key: model.id,
          display_name: model.id,
          type: "llm",
          loaded_instances: [{ id: model.id }], // llama.cpp models are always loaded
        }));
        return { models };
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          "llama-cpp",
          getErrorMessage(error),
          500,
          error,
        );
      }
    },

    // ── Health Check ─────────────────────────────────────────
    // GET /health

    async checkHealth() {
      const baseUrl = getBaseUrl();
      logger.provider("llama.cpp", "checkHealth");
      try {
        const response = await fetch(`${baseUrl}/health`, {
          method: "GET",
          signal: AbortSignal.timeout(3000),
        });
        const data = (await response.json()) as HealthResponse;
        return {
          ok: response.ok,
          status: response.ok
            ? data.status || "ok"
            : data.status || data.error?.message || "error",
          slotsIdle: data.slots_idle ?? null,
          slotsProcessing: data.slots_processing ?? null,
        };
      } catch (error: unknown) {
        return {
          ok: false,
          status: "unreachable",
          error: getErrorMessage(error),
        };
      }
    },

    // ── Server Props ─────────────────────────────────────────
    // GET /props + GET /slots — rich runtime metadata

    async getServerProps(): Promise<LlamaCppServerProps> {
      const baseUrl = getBaseUrl();
      logger.provider("llama.cpp", "getServerProps");

      // Fetch /props and /slots in parallel with independent timeouts
      const [propsResult, slotsResult, healthResult] = await Promise.allSettled([
        fetch(`${baseUrl}/props`, {
          method: "GET",
          signal: AbortSignal.timeout(3000),
        }).then((response) => {
          if (!response.ok) return null;
          return response.json() as Promise<LlamaCppPropsResponse>;
        }),
        fetch(`${baseUrl}/slots`, {
          method: "GET",
          signal: AbortSignal.timeout(3000),
        }).then((response) => {
          if (!response.ok) return null;
          return response.json() as Promise<LlamaCppSlotEntry[]>;
        }),
        fetch(`${baseUrl}/health`, {
          method: "GET",
          signal: AbortSignal.timeout(3000),
        }).then((response) => {
          if (!response.ok) return null;
          return response.json() as Promise<HealthResponse>;
        }),
      ]);

      const propsData =
        propsResult.status === "fulfilled" ? propsResult.value : null;
      const slotsData =
        slotsResult.status === "fulfilled" ? slotsResult.value : null;
      const healthData =
        healthResult.status === "fulfilled" ? healthResult.value : null;

      // Normalize /props response
      const generationSettings = propsData?.default_generation_settings;
      const generationParameters = generationSettings?.params;

      const normalizedSettings = generationSettings
        ? {
            contextLength: generationSettings.n_ctx || 0,
            temperature: generationParameters?.temperature ?? 0.8,
            topK: generationParameters?.top_k ?? 40,
            topP: generationParameters?.top_p ?? 0.95,
            minP: generationParameters?.min_p ?? 0.05,
            repeatPenalty: generationParameters?.repeat_penalty ?? 1.0,
            presencePenalty: generationParameters?.presence_penalty ?? 0.0,
            frequencyPenalty: generationParameters?.frequency_penalty ?? 0.0,
            seed: generationParameters?.seed ?? -1,
            maxTokens: generationParameters?.n_predict ?? -1,
            samplers: generationParameters?.samplers || [],
            cacheTypeK: generationSettings.cache_type_k || null,
            cacheTypeV: generationSettings.cache_type_v || null,
          }
        : null;

      // Normalize /slots response
      const normalizedSlots = Array.isArray(slotsData)
        ? slotsData.map((slot: LlamaCppSlotEntry) => ({
            id: slot.id,
            state: slot.is_processing ? "processing" : "idle",
            model: slot.model || null,
            contextLength: slot.n_ctx || 0,
            tokensUsed: slot.n_past || 0,
            tokensPredicted: slot.tokens_predicted || 0,
            cacheTokens: slot.cache_tokens || 0,
            isProcessing: slot.is_processing || false,
          }))
        : [];

      // Normalize /health response
      const normalizedHealth = healthData
        ? {
            status: healthData.status || "unknown",
            slotsIdle: healthData.slots_idle ?? null,
            slotsProcessing: healthData.slots_processing ?? null,
          }
        : null;

      return {
        totalSlots: propsData?.total_slots ?? normalizedSlots.length,
        modelPath: propsData?.model_path || null,
        modelAlias: propsData?.model_alias || null,
        chatTemplate: propsData?.chat_template || null,
        modalities: propsData?.modalities
          ? {
              vision: propsData.modalities.vision ?? false,
              audio: propsData.modalities.audio ?? false,
            }
          : null,
        endpointSlots: propsData?.endpoint_slots ?? false,
        endpointMetrics: propsData?.endpoint_metrics ?? false,
        defaultGenerationSettings: normalizedSettings,
        slots: normalizedSlots,
        health: normalizedHealth,
      };
    },
  };
}
