import {
  ProviderOptions,
  ChatMessage,
  Provider,
  GenerateTextResult,
  StreamChunk,
} from "../types/provider.ts";
import { ProviderError } from "../utils/errors.ts";
import { STREAMING_DISPATCHER, prependIdentitySystemMessage } from "../utils/openai-compat.ts";
import logger from "../utils/logger.ts";

import { TYPES, getDefaultModels } from "../config.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

/**
 * Convert messages with images to Ollama's native format.
 * Ollama expects images as base64 strings (without the data URL prefix).
 */
function prepareOllamaMessages(messages: ChatMessage[]) {
  return messages.map((messageItem: ChatMessage) => {
    const message = {
      role: messageItem.role,
      content: messageItem.content || "",
    };
    if (messageItem.images && messageItem.images.length > 0) {
      // Ollama's native API expects images as raw base64 strings
      (message as Record<string, unknown>).images = messageItem.images.map(
        (dataUrl: string) => {
          if (dataUrl.startsWith("data:")) {
            return dataUrl.split(",")[1]; // strip data:image/...;base64, prefix
          }
          return dataUrl;
        },
      );
    }
    return message;
  });
}

/**
 * Build parameters options for Ollama native API options.
 */
function buildOllamaOptions(options: ProviderOptions) {
  const ollamaOptions: Record<string, unknown> = {};

  if (options.temperature !== undefined)
    ollamaOptions.temperature = options.temperature;
  if (options.topP !== undefined) ollamaOptions.top_p = options.topP;
  if (options.topK !== undefined) ollamaOptions.top_k = options.topK;
  if (options.minP !== undefined) ollamaOptions.min_p = options.minP;
  if (options.maxTokens !== undefined)
    ollamaOptions.num_predict = options.maxTokens;
  if (options.stopSequences !== undefined)
    ollamaOptions.stop = options.stopSequences;
  if (options.seed !== undefined) {
    const seedValue =
      typeof options.seed === "string"
        ? parseInt(options.seed, 10)
        : options.seed;
    if (!isNaN(seedValue)) {
      ollamaOptions.seed = seedValue;
    }
  }
  if (options.frequencyPenalty !== undefined)
    ollamaOptions.frequency_penalty = options.frequencyPenalty;
  if (options.presencePenalty !== undefined)
    ollamaOptions.presence_penalty = options.presencePenalty;
  if (options.repeatPenalty !== undefined)
    ollamaOptions.repeat_penalty = options.repeatPenalty;

  return ollamaOptions;
}

export function createOllamaProvider(
  baseUrl: string,
  instanceId: string = "ollama",
): Provider {
  const getBaseUrl = () => baseUrl;

  return {
    name: instanceId,

    // ── Non-Streaming Text Generation ──────────────────────

    async generateText(
      messages: ChatMessage[],
      model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["ollama"],
      options: ProviderOptions = {},
    ): Promise<GenerateTextResult> {
      const baseUrl = getBaseUrl();
      logger.provider(
        "Ollama",
        `generateText model=${model} baseUrl=${baseUrl}`,
      );
      try {
        const preparedMessages = prepareOllamaMessages(
          prependIdentitySystemMessage(messages, options.systemPrompt),
        );

        const requestBody = {
          model,
          messages: preparedMessages,
          stream: false,
          ...(options.thinkingEnabled ? { think: true } : {}),
          options: buildOllamaOptions(options),
        };

        const response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API error: ${response.status} ${errorText}`);
        }

        const responseData = await response.json();
        const thinking =
          (responseData as Record<string, Record<string, string>>).message
            ?.thinking || undefined;
        const result: GenerateTextResult = {
          text:
            (responseData as Record<string, Record<string, string>>).message
              ?.content || "",
          usage: {
            inputTokens:
              (responseData as Record<string, number>).prompt_eval_count ?? 0,
            outputTokens:
              (responseData as Record<string, number>).eval_count ?? 0,
          },
        };
        if (thinking) {
          result.thinking = thinking;
        }
        return result;
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("ollama", getErrorMessage(error), 500, error);
      }
    },

    // ── Streaming Text Generation ──────────────────────

    async *generateTextStream(
      messages: ChatMessage[],
      model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["ollama"],
      options: ProviderOptions = {},
    ): AsyncGenerator<StreamChunk, void, unknown> {
      const baseUrl = getBaseUrl();
      logger.provider(
        "Ollama",
        `generateTextStream model=${model} baseUrl=${baseUrl}`,
      );
      let partialOutputCharacters = 0;
      let partialThinkingCharacters = 0;
      try {
        // Single-model enforcement: unload any other loaded models
        try {
          const processStatusResponse = await fetch(`${baseUrl}/api/ps`);
          if (processStatusResponse.ok) {
            const processStatusData = await processStatusResponse.json();
            const runningModels =
              (processStatusData as Record<string, unknown[]>).models || [];
            for (const runningModelInstance of runningModels as Record<
              string,
              string
            >[]) {
              const runningName =
                runningModelInstance.model || runningModelInstance.name;
              if (runningName && runningName !== model) {
                yield { type: "status", message: `Unloading ${runningName}…` };
                logger.info(
                  `Ollama: unloading ${runningName} before loading ${model}`,
                );
                await fetch(`${baseUrl}/api/generate`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ model: runningName, keep_alive: 0 }),
                });
              }
            }
          }
        } catch (unloadError: unknown) {
          logger.warn(
            `Ollama: could not check/unload models: ${getErrorMessage(unloadError)}`,
          );
        }

        const preparedMessages = prepareOllamaMessages(
          prependIdentitySystemMessage(messages, options.systemPrompt),
        );

        const requestBody = {
          model,
          messages: preparedMessages,
          stream: true,
          ...(options.thinkingEnabled ? { think: true } : {}),
          options: buildOllamaOptions(options),
        };

        const response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          dispatcher: STREAMING_DISPATCHER,
          ...(options.signal && { signal: options.signal }),
        } as RequestInit & { dispatcher: typeof STREAMING_DISPATCHER });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API error: ${response.status} ${errorText}`);
        }

        // Ollama streams NDJSON (one JSON object per line)
        const reader = (
          response.body as ReadableStream<Uint8Array>
        ).getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let usage = null;

        while (true) {
          if (options.signal?.aborted) {
            reader.cancel();
            break;
          }
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop()!; // keep incomplete line in buffer

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
              const parsedJson = JSON.parse(trimmed);

              // Thinking content comes in message.thinking
              if (parsedJson.message?.thinking) {
                partialThinkingCharacters += (
                  parsedJson.message.thinking as string
                ).length;
                yield {
                  type: "thinking",
                  content: parsedJson.message.thinking,
                };
              }

              // Text content comes in message.content
              if (parsedJson.message?.content) {
                partialOutputCharacters += (
                  parsedJson.message.content as string
                ).length;
                yield parsedJson.message.content;
              }

              // Final chunk has done: true with usage stats
              if (parsedJson.done) {
                const evalDurationSec = parsedJson.eval_duration
                  ? parsedJson.eval_duration / 1_000_000_000
                  : null;
                usage = {
                  inputTokens: parsedJson.prompt_eval_count ?? 0,
                  outputTokens: parsedJson.eval_count ?? 0,
                };
                // Ollama reports precise eval_duration — use it for tok/s
                if (
                  evalDurationSec &&
                  evalDurationSec > 0 &&
                  usage.outputTokens > 0
                ) {
                  (usage as Record<string, unknown>).tokensPerSec = parseFloat(
                    (usage.outputTokens / evalDurationSec).toFixed(1),
                  );
                }
              }
            } catch {
              // skip malformed JSON lines
            }
          }
        }

        if (usage) {
          yield {
            type: "usage",
            usage: {
              inputTokens: usage.inputTokens || 0,
              outputTokens: usage.outputTokens || 0,
            },
          };
        } else {
          yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
        }
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") return; // Client disconnected
        // Yield partial usage before re-throwing so the consumer captures
        // whatever tokens were generated before the stream terminated.
        if (partialOutputCharacters > 0 || partialThinkingCharacters > 0) {
          const estimatedOutputTokens = Math.ceil(partialOutputCharacters / 4);
          const estimatedThinkingTokens = Math.ceil(
            partialThinkingCharacters / 4,
          );
          yield {
            type: "usage",
            usage: {
              inputTokens: 0,
              outputTokens: estimatedOutputTokens + estimatedThinkingTokens,
            },
          };
        }
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("ollama", getErrorMessage(error), 500, error);
      }
    },

    // ── Image Captioning ──────────────────────

    async captionImage(
      images: string[],
      prompt: string = "Describe this image.",
      model: string = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)["ollama"],
      systemPrompt?: string,
    ): Promise<{
      text: string;
      usage: { inputTokens: number; outputTokens: number };
    }> {
      const baseUrl = getBaseUrl();
      logger.provider(
        "Ollama",
        `captionImage model=${model} baseUrl=${baseUrl}`,
      );
      try {
        // Extract raw base64 from data URLs
        const imageBase64List = images.map((image: string) => {
          if (image.startsWith("data:")) {
            return image.split(",")[1];
          }
          return image;
        });

        const messages: ChatMessage[] = [];
        if (systemPrompt) {
          messages.push({ role: "system", content: systemPrompt });
        }
        messages.push({
          role: "user",
          content: prompt,
          images: imageBase64List,
        });

        const response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages,
            stream: false,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API error: ${response.status} ${errorText}`);
        }

        const responseData = await response.json();
        const text =
          (responseData as Record<string, Record<string, string>>).message
            ?.content || "";
        const usage = {
          inputTokens:
            (responseData as Record<string, number>).prompt_eval_count || 0,
          outputTokens:
            (responseData as Record<string, number>).eval_count || 0,
        };
        return { text, usage };
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("ollama", getErrorMessage(error), 500, error);
      }
    },

    // ── Ollama Model Listing ─────────────────────

    /**
     * List all models available in Ollama.
     * GET /api/tags
     */
    async listModels(): Promise<{
      models: Array<{
        key: string;
        display_name: string;
        type: string;
        loaded_instances?: Array<{ id: string }>;
      }>;
    }> {
      const baseUrl = getBaseUrl();
      logger.provider("Ollama", "listModels");
      try {
        const response = await fetch(`${baseUrl}/api/tags`, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API error: ${response.status} ${errorText}`);
        }

        const responseData = await response.json();
        const models = (responseData as Record<string, unknown[]>).models || [];

        let running: Record<string, unknown>[] = [];
        try {
          const processStatusResponse = await fetch(`${baseUrl}/api/ps`);
          if (processStatusResponse.ok) {
            const processStatusData = await processStatusResponse.json();
            running =
              (processStatusData as Record<string, Record<string, unknown>[]>)
                .models || [];
          }
        } catch (error: unknown) {
          logger.warn(
            `Ollama listModels: could not query active models: ${getErrorMessage(error)}`,
          );
        }

        const mappedModelsList = models.map((value: unknown) => {
          const modelItem = value as Record<string, unknown>;
          const tagName = (modelItem.model || modelItem.name || "") as string;
          const matchedRunningModel = running.find((runningModel) => {
            const runningName = (runningModel.model ||
              runningModel.name ||
              "") as string;
            if (runningName === tagName) return true;
            const cleanTagName = tagName.endsWith(":latest")
              ? tagName.slice(0, -7)
              : tagName;
            const cleanRunningName = runningName.endsWith(":latest")
              ? runningName.slice(0, -7)
              : runningName;
            return cleanTagName === cleanRunningName;
          });

          const loadedInstances = matchedRunningModel
            ? [
                {
                  id: String(
                    matchedRunningModel.model || matchedRunningModel.name,
                  ),
                  config: {
                    context_length: null,
                    size_vram: matchedRunningModel.size_vram ?? null,
                    expires_at: matchedRunningModel.expires_at ?? null,
                  },
                },
              ]
            : undefined;

          return {
            key: tagName,
            display_name: tagName,
            type: "llm",
            loaded_instances: loadedInstances,
          };
        });

        return { models: mappedModelsList };
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("ollama", getErrorMessage(error), 500, error);
      }
    },
  };
}
