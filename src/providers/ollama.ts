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

async function ollamaGenerateText(
  baseUrl: string,
  messages: ChatMessage[],
  model: string,
  options: ProviderOptions,
): Promise<GenerateTextResult> {
  logger.provider("Ollama", `generateText model=${model} baseUrl=${baseUrl}`);
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

    const responseData = (await response.json()) as Record<string, unknown>;
    const msgObj = (responseData.message || {}) as Record<string, string>;
    const thinking = msgObj.thinking || undefined;
    const result: GenerateTextResult = {
      text: msgObj.content || "",
      usage: {
        inputTokens: (responseData.prompt_eval_count as number) ?? 0,
        outputTokens: (responseData.eval_count as number) ?? 0,
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
}

async function* unloadOtherOllamaModels(
  baseUrl: string,
  targetModel: string,
): AsyncGenerator<StreamChunk, void, unknown> {
  try {
    const processStatusResponse = await fetch(`${baseUrl}/api/ps`);
    if (!processStatusResponse.ok) return;
    const processStatusData = (await processStatusResponse.json()) as Record<
      string,
      unknown[]
    >;
    const runningModels = (processStatusData.models || []) as Record<
      string,
      string
    >[];
    for (const runningModelInstance of runningModels) {
      const runningName =
        runningModelInstance.model || runningModelInstance.name;
      if (runningName && runningName !== targetModel) {
        yield { type: "status", message: `Unloading ${runningName}…` };
        logger.info(
          `Ollama: unloading ${runningName} before loading ${targetModel}`,
        );
        await fetch(`${baseUrl}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: runningName, keep_alive: 0 }),
        });
      }
    }
  } catch (unloadError: unknown) {
    logger.warn(
      `Ollama: could not check/unload models: ${getErrorMessage(unloadError)}`,
    );
  }
}

function buildOllamaFinalUsage(parsedJson: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  tokensPerSec?: number;
} {
  const evalDuration = parsedJson.eval_duration as number | undefined;
  const evalDurationSec = evalDuration ? evalDuration / 1_000_000_000 : null;
  const outputTokens = (parsedJson.eval_count as number) ?? 0;
  const usage: {
    inputTokens: number;
    outputTokens: number;
    tokensPerSec?: number;
  } = {
    inputTokens: (parsedJson.prompt_eval_count as number) ?? 0,
    outputTokens,
  };
  if (evalDurationSec && evalDurationSec > 0 && outputTokens > 0) {
    usage.tokensPerSec = parseFloat(
      (outputTokens / evalDurationSec).toFixed(1),
    );
  }
  return usage;
}

async function* consumeOllamaNdjsonReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  counters: { outputChars: number; thinkingChars: number },
): AsyncGenerator<StreamChunk, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: {
    inputTokens: number;
    outputTokens: number;
    tokensPerSec?: number;
  } | null = null;

  while (true) {
    if (signal?.aborted) {
      reader.cancel().catch(() => {});
      break;
    }
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsedJson = JSON.parse(trimmed);
        if (parsedJson.message?.thinking) {
          counters.thinkingChars += (
            parsedJson.message.thinking as string
          ).length;
          yield {
            type: "thinking",
            content: parsedJson.message.thinking,
          };
        }
        if (parsedJson.message?.content) {
          counters.outputChars += (parsedJson.message.content as string).length;
          yield parsedJson.message.content;
        }
        if (parsedJson.done) {
          usage = buildOllamaFinalUsage(parsedJson);
        }
      } catch {
        // skip malformed JSON lines
      }
    }
  }

  yield {
    type: "usage",
    usage: {
      inputTokens: usage?.inputTokens || 0,
      outputTokens: usage?.outputTokens || 0,
    },
  };
}

async function* ollamaGenerateTextStream(
  baseUrl: string,
  messages: ChatMessage[],
  model: string,
  options: ProviderOptions,
): AsyncGenerator<StreamChunk, void, unknown> {
  logger.provider(
    "Ollama",
    `generateTextStream model=${model} baseUrl=${baseUrl}`,
  );
  const counters = { outputChars: 0, thinkingChars: 0 };
  try {
    yield* unloadOtherOllamaModels(baseUrl, model);

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

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    yield* consumeOllamaNdjsonReader(reader, options.signal, counters);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") return;
    if (counters.outputChars > 0 || counters.thinkingChars > 0) {
      const estimatedOutputTokens = Math.ceil(counters.outputChars / 4);
      const estimatedThinkingTokens = Math.ceil(counters.thinkingChars / 4);
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
}

async function ollamaCaptionImage(
  baseUrl: string,
  images: string[],
  prompt: string,
  model: string,
  systemPrompt?: string,
): Promise<{
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}> {
  logger.provider("Ollama", `captionImage model=${model} baseUrl=${baseUrl}`);
  try {
    const imageBase64List = images.map((image: string) =>
      image.startsWith("data:") ? image.split(",")[1] : image,
    );

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

    const responseData = (await response.json()) as Record<string, unknown>;
    const msgObj = (responseData.message || {}) as Record<string, string>;
    const text = msgObj.content || "";
    const usage = {
      inputTokens: (responseData.prompt_eval_count as number) || 0,
      outputTokens: (responseData.eval_count as number) || 0,
    };
    return { text, usage };
  } catch (error: unknown) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("ollama", getErrorMessage(error), 500, error);
  }
}

function stripLatestSuffix(name: string): string {
  return name.endsWith(":latest") ? name.slice(0, -7) : name;
}

function mapOllamaModelEntry(
  value: unknown,
  running: Record<string, unknown>[],
) {
  const modelItem = value as Record<string, unknown>;
  const tagName = (modelItem.model || modelItem.name || "") as string;
  const matchedRunningModel = running.find((runningModel) => {
    const runningName = (runningModel.model ||
      runningModel.name ||
      "") as string;
    return (
      runningName === tagName ||
      stripLatestSuffix(tagName) === stripLatestSuffix(runningName)
    );
  });

  const loadedInstances = matchedRunningModel
    ? [
        {
          id: String(matchedRunningModel.model || matchedRunningModel.name),
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
}

async function fetchRunningOllamaModels(
  baseUrl: string,
): Promise<Record<string, unknown>[]> {
  try {
    const processStatusResponse = await fetch(`${baseUrl}/api/ps`);
    if (processStatusResponse.ok) {
      const processStatusData = (await processStatusResponse.json()) as Record<
        string,
        Record<string, unknown>[]
      >;
      return processStatusData.models || [];
    }
  } catch (error: unknown) {
    logger.warn(
      `Ollama listModels: could not query active models: ${getErrorMessage(error)}`,
    );
  }
  return [];
}

async function ollamaListModels(baseUrl: string) {
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

    const responseData = (await response.json()) as Record<string, unknown[]>;
    const models = responseData.models || [];
    const running = await fetchRunningOllamaModels(baseUrl);
    const mappedModelsList = models.map((value: unknown) =>
      mapOllamaModelEntry(value, running),
    );
    return { models: mappedModelsList };
  } catch (error: unknown) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("ollama", getErrorMessage(error), 500, error);
  }
}

export function createOllamaProvider(
  baseUrl: string,
  instanceId: string = "ollama",
): Provider {
  return {
    name: instanceId,
    generateText(
      messages: ChatMessage[],
      model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["ollama"],
      options: ProviderOptions = {},
    ): Promise<GenerateTextResult> {
      return ollamaGenerateText(baseUrl, messages, model, options);
    },
    generateTextStream(
      messages: ChatMessage[],
      model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["ollama"],
      options: ProviderOptions = {},
    ): AsyncGenerator<StreamChunk, void, unknown> {
      return ollamaGenerateTextStream(baseUrl, messages, model, options);
    },
    captionImage(
      images: string[],
      prompt: string = "Describe this image.",
      model: string = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)["ollama"],
      systemPrompt?: string,
    ) {
      return ollamaCaptionImage(baseUrl, images, prompt, model, systemPrompt);
    },
    listModels() {
      return ollamaListModels(baseUrl);
    },
  };
}
