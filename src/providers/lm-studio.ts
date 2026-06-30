import {
  ProviderOptions,
  ChatMessage,
  Provider,
  GenerateTextResult,
  StreamChunk,
  ListModelsResult,
  EnsureModelLoadedResult,
  LmStudioModelEntry,
  LmStudioLoadConfig,
} from "../types/provider.ts";
import { sleep } from "@rodrigo-barraza/utilities-library";
// ─────────────────────────────────────────────────────────────
// LM Studio provider — Fully native /api/v1/chat
// Uses the native REST API for all streaming, with:
//   - `reasoning` parameter for thinking toggle
//   - `integrations[]` for MCP-based function calling via tools-api
// Non-streaming + captionImage still use OpenAI-compat.
// ─────────────────────────────────────────────────────────────
import { ProviderError } from "../utils/errors.ts";
import logger from "../utils/logger.ts";
import { resolveArchParams } from "../utils/gguf-arch.ts";
import {
  TOOLS_SERVICE_URL,
  LM_STUDIO_EVAL_BATCH_SIZE,
  LM_STUDIO_DEFAULT_MAX_CONTEXT,
} from "../../config.ts";
import { TYPES, getDefaultModels } from "../config.ts";
// Default MCP server URL for ephemeral tool integrations (vault-resolved)
const DEFAULT_MCP_SERVER_URL = "http://lazy-tool-service:7778";
import {
  convertToolsToOpenAI,
  buildPayloadParams,
  prepareOpenAICompatMessages,
  expandVideoToFrames,
  processNonStreamingResponse,
  fetchOpenAICompat,
  parseSSEStream,
  STREAMING_DISPATCHER,
  MEDIA_STRATEGIES,
  type PreparedMessage,
  type OpenAICompletionResponse,
} from "../utils/openai-compat.ts";
import { ORCHESTRATOR_ONLY_TOOLS } from "../services/OrchestratorPrompt.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import { PROVIDERS } from "../constants.ts";
// ── Native /api/v1/chat SSE stream parser ────────────────────
// The native endpoint emits named SSE events: reasoning.start/delta/end,
// message.start/delta/end, content.start/delta/end, chat.end.
// This generator yields the same event types as parseSSEStream so both
// paths integrate seamlessly with the rest of the pipeline.
async function* parseNativeSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: ProviderOptions = {},
) {
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = null;
  // Track partial output tokens from content/reasoning deltas as a fallback
  // when the stream terminates before chat.end delivers final stats.
  let partialOutputCharacters = 0;
  let partialReasoningCharacters = 0;
  // Accumulate tool call arguments for streaming tool events
  let currentToolCall = null;
  let usageYielded = false;
  // Reactive abort: when the signal fires, cancel the reader immediately
  // so the pending reader.read() resolves with { done: true } instead of
  // blocking until the next chunk arrives from the upstream server.
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
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (!trimmed.startsWith("data: ")) continue;
        try {
          const json = JSON.parse(trimmed.slice(6));
          const type = json.type;
          // ── Chat lifecycle events ──
          if (type === "chat.start") {
            yield { type: "status", message: "Starting…", phase: "starting" };
          }
          // ── Reasoning events ──
          else if (type === "reasoning.delta" && json.content) {
            partialReasoningCharacters += (json.content as string).length;
            yield { type: "thinking", content: json.content };
          }
          // ── Message content events ──
          else if (
            (type === "content.delta" || type === "message.delta") &&
            json.content
          ) {
            partialOutputCharacters += (json.content as string).length;
            yield json.content;
          }
          // ── Model loading events ──
          else if (type === "model_load.start") {
            yield {
              type: "status",
              message: "Loading model… 0%",
              phase: "loading",
            };
          } else if (type === "model_load.progress") {
            const percentage =
              json.progress != null ? Math.round(json.progress * 100) : 0;
            yield {
              type: "status",
              message: `Loading model… ${percentage}%`,
              phase: "loading",
            };
          } else if (type === "model_load.end") {
            yield {
              type: "status",
              message: "Loading model… 100%",
              phase: "loading",
            };
          }
          // ── Prompt processing events ──
          else if (type === "prompt_processing.start") {
            yield {
              type: "status",
              message: "Processing prompt…",
              phase: "prefilling",
              progress: 0,
            };
          } else if (type === "prompt_processing.progress") {
            const progress = json.progress != null ? json.progress : 0;
            const percentage = Math.round(progress * 100);
            yield {
              type: "status",
              message: `Processing prompt… ${percentage}%`,
              phase: "prefilling",
              progress,
            };
          } else if (type === "prompt_processing.end") {
            yield {
              type: "status",
              message: "Processing prompt… done",
              phase: "prefilling",
              progress: 1,
            };
          }
          // ── Generation start ──
          else if (type === "message.start") {
            yield {
              type: "status",
              message: "Generating…",
              phase: "generating",
            };
          }
          // ── Tool call events (MCP) ──
          else if (type === "tool_call.start") {
            currentToolCall = {
              tool: "any",
              arguments: {},
            };
          } else if (type === "tool_call.name") {
            // Separate event with the tool name
            if (currentToolCall) {
              currentToolCall.tool = json.tool_name || "any";
            }
            yield {
              type: "toolCall",
              id: json.tool_call_id || null,
              name: json.tool_name || "any",
              args: {},
              status: "calling",
              native: true, // MCP-executed, skip agentic loop re-execution
            };
          } else if (type === "tool_call.arguments") {
            // Arguments arrive as a parsed object, not a streamed string
            if (currentToolCall && json.arguments) {
              currentToolCall.arguments =
                typeof json.arguments === "object"
                  ? json.arguments
                  : safeParseJSON(json.arguments);
            }
            if (currentToolCall && json.tool) {
              currentToolCall.tool = json.tool;
            }
          } else if (type === "tool_call.success") {
            const toolName = json.tool || currentToolCall?.tool || "any";
            const args = json.arguments || currentToolCall?.arguments || {};
            yield {
              type: "toolCall",
              id: json.tool_call_id || null,
              name: toolName,
              args: typeof args === "object" ? args : safeParseJSON(args),
              result: json.output ? safeParseJSON(json.output) : json.output,
              status: "done",
              native: true,
            };
            currentToolCall = null;
          } else if (type === "tool_call.failure") {
            yield {
              type: "toolCall",
              id: json.tool_call_id || null,
              name: json.tool || currentToolCall?.tool || "any",
              args: currentToolCall?.arguments || {},
              result: { error: json.reason || "Tool call failed" },
              status: "error",
              native: true,
            };
            currentToolCall = null;
          }
          // ── Error event ──
          else if (type === "error") {
            const errorMessage =
              json.error?.message || JSON.stringify(json.error);
            logger.warn(`[LM-Studio] Stream error: ${errorMessage}`);
            // Yield as text so the client sees the error
            yield `\n\n⚠️ **LM Studio Error:** ${errorMessage}`;
          }
          // ── Chat end with stats ──
          else if (type === "chat.end") {
            const stats = json.result?.stats || json.stats;
            if (stats) {
              usage = {
                inputTokens: stats.input_tokens || 0,
                outputTokens: stats.total_output_tokens || 0,
                // Enrich with LM Studio-specific perf metrics
                tokensPerSec: stats.tokens_per_second || undefined,
                timeToFirstToken:
                  stats.time_to_first_token_seconds || undefined,
                reasoningOutputTokens:
                  stats.reasoning_output_tokens || undefined,
              };
            }
          }
        } catch {
          // skip malformed JSON
        }
      }
    }
  } catch (streamError) {
    // Yield partial usage BEFORE re-throwing — the for-await consumer
    // won't see yields from `finally` after a throw, so we must yield
    // the partial usage event here while the generator is still active.
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
    // Happy path: yield usage if the stream completed normally without error.
    if (!usageYielded) {
      usageYielded = true;
      if (usage) {
        yield { type: "usage", usage };
      } else {
        yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
      }
    }
  }
}
function safeParseJSON(serializedString: unknown) {
  try {
    return JSON.parse(String(serializedString));
  } catch {
    return serializedString;
  }
}
// Build the native /api/v1/chat input from OpenAI-style messages.
// The native API only accepts `input` (current turn) + `system_prompt` — it has
// no built-in multi-turn message array. We serialize prior conversation turns
// as formatted text context so the model retains conversational memory.
// For the last user turn with images, we use the array format with type: "text"|"image".
function buildNativeInput(messages: PreparedMessage[]) {
  // Separate system, conversation history, and the last user message
  const nonSystemMessages = messages.filter(
    (message) => message.role !== "system",
  );
  if (nonSystemMessages.length === 0) return "";
  const lastUser = [...nonSystemMessages]
    .reverse()
    .find((message) => message.role === "user");
  if (!lastUser) return "";
  // Find the index of the last user message to separate history from current turn
  const lastUserIndex = nonSystemMessages.lastIndexOf(lastUser);
  const historyMessages = nonSystemMessages.slice(0, lastUserIndex);
  // Build conversation history prefix (prior turns only)
  let historyPrefix = "";
  if (historyMessages.length > 0) {
    const lines: string[] = [];
    for (const message of historyMessages) {
      const role = message.role === "user" ? "User" : "Assistant";
      const text =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .filter(
                  (item): item is { type: "text"; text: string } =>
                    item.type === "text",
                )
                .map((item) => item.text)
                .join("\n")
            : "";
      if (text) lines.push(`[${role}]: ${text}`);
    }
    if (lines.length > 0) {
      historyPrefix =
        "[Conversation History]\n" +
        lines.join("\n") +
        "\n\n[Current Message]\n";
    }
  }
  // Check if the last user message has images (multi-part)
  if (Array.isArray(lastUser.content)) {
    const parts: Array<Record<string, unknown>> = [];
    // Prepend history as a text part if present
    let textContent = lastUser.content
      .filter(
        (item): item is { type: "text"; text: string } => item.type === "text",
      )
      .map((item) => item.text)
      .join("\n");
    if (historyPrefix) textContent = historyPrefix + textContent;
    if (textContent) parts.push({ type: "text", content: textContent });
    // Add images
    for (const content of lastUser.content) {
      if (content.type === "image_url" && content.image_url?.url) {
        parts.push({ type: "image", data_url: content.image_url.url });
      }
    }
    return parts;
  }
  // Simple text-only message → use string input (enables reasoning)
  const currentText =
    typeof lastUser.content === "string" ? lastUser.content : "";
  return historyPrefix ? historyPrefix + currentText : currentText;
}
import {
  AGENT_IDS,
  DEFAULT_PROJECT,
} from "@rodrigo-barraza/utilities-library/taxonomy";

export interface LmStudioProvider extends Provider {
  listModels(): Promise<ListModelsResult>;
  loadModel(
    model: string,
    options?: ProviderOptions,
    signal?: AbortSignal,
  ): Promise<void>;
  unloadModel(instanceId: string): Promise<void>;
  unloadModelByKey(modelKey: string): Promise<void>;
  ensureModelLoaded(
    modelKey: string,
    options?: ProviderOptions,
    signal?: AbortSignal,
    onStatus?: (status: string) => void,
  ): Promise<EnsureModelLoadedResult>;
  _streamOpenAICompat(
    prepared: PreparedMessage[],
    model: string,
    options: ProviderOptions,
    baseUrl: string,
  ): AsyncGenerator<StreamChunk, void, unknown>;
}

export function createLmStudioProvider(
  baseUrl: string,
  instanceId: string = PROVIDERS.LM_STUDIO,
): LmStudioProvider {
  const getBaseUrl = () => baseUrl;
  const MCP_SERVER_URL = DEFAULT_MCP_SERVER_URL;
  // ── Per-instance model load mutex (singleflight) ──────────
  // Prevents duplicate model loads when multiple concurrent requests
  // (e.g. sub-agents) hit the same instance before the first load finishes.
  // Key: model name → Promise that resolves when the load completes.

  const _loadInflight = new Map<string, Promise<void>>();
  const _loadModelInflight = new Map<string, Promise<void>>();
  const _activeRequestsCount = new Map<string, number>();
  // ── GPU-constrained context ceiling per model ──────────────
  // When a model load at the requested context length fails (GPU OOM)
  // and falls back to a smaller context, we record the practical GPU
  // ceiling here. Without this, every agentic iteration sees
  // loadedContext < minContextLength and triggers a futile reload loop.
  const _gpuConstrainedContextLength = new Map<string, number>();
  return {
    name: instanceId,
    async generateText(
      messages: ChatMessage[],
      model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)[
        PROVIDERS.LM_STUDIO
      ],
      options: ProviderOptions = {},
    ): Promise<GenerateTextResult> {
      const baseUrl = getBaseUrl();
      let isRequestActive = false;
      logger.provider(
        "LM Studio",
        `generateText model=${model} baseUrl=${baseUrl}`,
      );
      try {
        if (options.signal?.aborted) {
          throw new DOMException("The user aborted a request.", "AbortError");
        }
        // Expand video attachments to image frames (ffmpeg) before message prep
        await expandVideoToFrames(messages);

        // Ensure the model is loaded with appropriate batch and context size
        const loadOpts: ProviderOptions = {
          eval_batch_size: options.evalBatchSize || LM_STUDIO_EVAL_BATCH_SIZE,
        };
        if (options.minContextLength) {
          loadOpts.context_length = options.minContextLength;
        }

        await this.ensureModelLoaded(model, loadOpts, options.signal);

        // Track active request count to prevent auto-unloads
        const activeCount = _activeRequestsCount.get(model) || 0;
        _activeRequestsCount.set(model, activeCount + 1);
        isRequestActive = true;

        if (options.signal?.aborted) {
          throw new DOMException("The user aborted a request.", "AbortError");
        }

        const prepared = prepareOpenAICompatMessages(messages, {
          mediaStrategy: MEDIA_STRATEGIES.IMAGES_ONLY,
        });
        const payload: Record<string, unknown> = {
          messages: prepared,
          model,
          ...buildPayloadParams(options),
          // LM Studio extensions: top_k, min_p, repeat_penalty
          ...(options.topK !== undefined &&
            options.topK > 0 && { top_k: options.topK }),
          ...(options.minP !== undefined && { min_p: options.minP }),
          ...(options.repeatPenalty !== undefined &&
            options.repeatPenalty !== 1 && {
              repeat_penalty: options.repeatPenalty,
            }),
          stream: false,
        };
        // Function calling tools
        const tools = convertToolsToOpenAI(options.tools);
        if (tools) payload.tools = tools;
        const response = await fetchOpenAICompat(
          `${baseUrl}/v1/chat/completions`,
          payload,
          { signal: options.signal },
        );
        const data = (await response.json()) as OpenAICompletionResponse;
        const { text, thinking, usage, toolCalls } =
          processNonStreamingResponse(data, options);
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
          PROVIDERS.LM_STUDIO,
          getErrorMessage(error),
          500,
          error,
        );
      } finally {
        if (isRequestActive) {
          const activeCount = _activeRequestsCount.get(model) || 0;
          if (activeCount <= 1) {
            _activeRequestsCount.delete(model);
          } else {
            _activeRequestsCount.set(model, activeCount - 1);
          }
        }
      }
    },
    // ── Streaming Text Generation (SSE) ──────────────────────
    async *generateTextStream(
      messages: ChatMessage[],
      model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)[
        PROVIDERS.LM_STUDIO
      ],
      options: ProviderOptions = {},
    ): AsyncGenerator<StreamChunk, void, unknown> {
      const baseUrl = getBaseUrl();
      let isRequestActive = false;
      logger.provider(
        "LM Studio",
        `generateTextStream model=${model} baseUrl=${baseUrl}`,
      );
      try {
        try {
          while (true) {
            if (options.signal?.aborted) return;

            if (_loadInflight.has(model)) {
              logger.info(
                `[LM-Studio:${instanceId}] Model "${model}" already loading (singleflight) — waiting…`,
              );
              yield {
                type: "status",
                message: "Waiting for model load…",
                phase: "loading",
              };
              try {
                await _loadInflight.get(model);
              } catch {
                /* ignore load failures of other workers, we'll re-evaluate and retry if needed */
              }
              continue;
            }

            // Register synchronously BEFORE any async check
            let resolveInflight: (() => void) | undefined = undefined;
            let rejectInflight: ((error: unknown) => void) | undefined =
              undefined;
            let isPromiseSettled = false;
            const inflightPromise = new Promise<void>((resolve, reject) => {
              resolveInflight = () => {
                isPromiseSettled = true;
                resolve();
              };
              rejectInflight = (error) => {
                isPromiseSettled = true;
                reject(error);
              };
            });
            inflightPromise.catch(() => {}); // prevent unhandled rejection
            _loadInflight.set(model, inflightPromise);

            try {
              const refreshed = await this.listModels();
              if (options.signal?.aborted) return;

              const entry = (refreshed.models || []).find(
                (modelItem) => modelItem.key === model,
              );
              const isLoaded = (entry?.loaded_instances?.length ?? 0) > 0;

              // Capture loaded context for tool cap calculation
              if (isLoaded && entry?.loaded_instances) {
                const loadedContext = entry.loaded_instances[0]?.config;
                if (
                  loadedContext &&
                  typeof loadedContext === "object" &&
                  !Array.isArray(loadedContext)
                ) {
                  const configRecord = loadedContext as Record<string, unknown>;
                  if (typeof configRecord.context_length === "number")
                    options._loadedContextLength = configRecord.context_length;
                  if (typeof configRecord.eval_batch_size === "number")
                    options._loadedEvalBatchSize = configRecord.eval_batch_size;
                  if (typeof configRecord.physical_batch_size === "number")
                    options._loadedPhysicalBatchSize =
                      configRecord.physical_batch_size;
                }
              }

              // If minContextLength is requested (e.g. agentic mode) and model is loaded
              // with insufficient context, force a reload with the required minimum.
              // BUT: skip reload if the model is already at its maximum context — reloading
              // would just load the same max again, creating an infinite unload/reload loop
              // (e.g. minContextLength=150k but model max is 32k → loads at 32k → 32k<150k → reload → 32k → …).
              const modelMaximumContext =
                typeof entry?.max_context_length === "number"
                  ? entry.max_context_length
                  : 0;
              // Check both the model's theoretical max AND the GPU-constrained
              // practical max (recorded after a fallback load). Without the GPU
              // check, every agentic iteration sees loaded=65k < min=120k and
              // triggers a futile unload/reload cycle.
              const gpuCeiling = _gpuConstrainedContextLength.get(model);
              const effectiveMaxContext = gpuCeiling
                ? Math.min(modelMaximumContext || Infinity, gpuCeiling)
                : modelMaximumContext;
              const alreadyAtMax =
                effectiveMaxContext > 0 &&
                ((options._loadedContextLength as number) || 0) >=
                  effectiveMaxContext;

              const isActive = (_activeRequestsCount.get(model) || 0) > 0;
              const needsReload =
                isLoaded &&
                !!options.minContextLength &&
                !!options._loadedContextLength &&
                options._loadedContextLength < options.minContextLength &&
                !alreadyAtMax &&
                !isActive;

              if (
                alreadyAtMax &&
                options.minContextLength &&
                ((options._loadedContextLength as number) || 0) <
                  options.minContextLength
              ) {
                logger.info(
                  `[LM-Studio] Model ${model} already at max context (${options._loadedContextLength}/${effectiveMaxContext}${gpuCeiling ? ` gpu-ceiling=${gpuCeiling}` : ""}) — skipping reload (requested ${options.minContextLength})`,
                );
              }

              if (isLoaded && !needsReload) {
                resolveInflight!();
                break;
              }

              // Proceed with unload and load
              if (needsReload && options.minContextLength) {
                const maxContext =
                  typeof entry?.max_context_length === "number"
                    ? entry.max_context_length
                    : options.minContextLength;
                const target = Math.min(options.minContextLength, maxContext);
                logger.info(
                  `[LM-Studio] Reloading ${model}: loaded ctx ${options._loadedContextLength} < required ${options.minContextLength}, target=${target}`,
                );
                yield {
                  type: "status",
                  message: `Reloading model with ${(target / 1000).toFixed(0)}k context…`,
                };
                for (const instance of entry?.loaded_instances || []) {
                  await this.unloadModel(instance.id);
                }
              } else {
                // Unload any other loaded models first (single-model enforcement)
                for (const currentModelEntryItem of refreshed.models || []) {
                  if (options.signal?.aborted) return;
                  const otherModelKey = currentModelEntryItem.key;
                  if ((_activeRequestsCount.get(otherModelKey) || 0) > 0) {
                    logger.warn(
                      `[LM-Studio] Skipping auto-unload of active model "${otherModelKey}" because it is currently in use`,
                    );
                    continue;
                  }
                  for (const instance of currentModelEntryItem.loaded_instances ||
                    []) {
                    yield {
                      type: "status",
                      message: "Unloading previous model…",
                    };
                    logger.info(
                      `Auto-unloading ${instance.id} before loading ${model}`,
                    );
                    await this.unloadModel(instance.id);
                  }
                }
              }

              if (options.signal?.aborted) return;
              logger.info(`Auto-loading model ${model} for streaming`);
              yield {
                type: "status",
                message: "Loading model… 0%",
                phase: "loading",
              };
              const loadOpts: ProviderOptions = {
                eval_batch_size:
                  options.evalBatchSize || LM_STUDIO_EVAL_BATCH_SIZE,
              };
              if (options.minContextLength) {
                const maxContextLength =
                  entry?.max_context_length || LM_STUDIO_DEFAULT_MAX_CONTEXT;
                // If we already know the GPU ceiling from a previous fallback,
                // cap here to avoid a guaranteed-to-fail load attempt.
                const gpuCeilingForLoad =
                  _gpuConstrainedContextLength.get(model);
                const effectiveMaxForLoad = gpuCeilingForLoad
                  ? Math.min(maxContextLength, gpuCeilingForLoad)
                  : maxContextLength;
                loadOpts.context_length = Math.min(
                  options.minContextLength as number,
                  effectiveMaxForLoad,
                );
                logger.info(
                  `[LM-Studio] Loading with context_length=${loadOpts.context_length} (min=${options.minContextLength}, max=${maxContextLength}${gpuCeilingForLoad ? `, gpu-ceiling=${gpuCeilingForLoad}` : ""})`,
                );
              }

              let loadDone = false;
              let loadError: unknown = null;
              const loadPromise = this.loadModel(
                model,
                loadOpts,
                options.signal,
              )
                .then(() => {
                  loadDone = true;
                })
                .catch((error: unknown) => {
                  loadDone = true;
                  if (
                    (error instanceof Error ? error.name : "") !== "AbortError"
                  )
                    loadError = error;
                });

              const startTime = Date.now();
              const EXPECTED_LOAD_MS = 15000;
              let lastPercentage = 0;
              while (!loadDone) {
                await sleep(500);
                if (options.signal?.aborted) {
                  logger.info(
                    `[LM-Studio] Aborted during model load for ${model}`,
                  );
                  this.unloadModelByKey(model).catch((error: unknown) =>
                    logger.warn(
                      `[LM-Studio] Failed to unload ${model} after abort: ${getErrorMessage(error)}`,
                    ),
                  );
                  return;
                }
                if (loadDone) break;
                const elapsed = Date.now() - startTime;
                const percentage = Math.min(
                  95,
                  Math.round((elapsed / (elapsed + EXPECTED_LOAD_MS)) * 100),
                );
                if (percentage > lastPercentage) {
                  lastPercentage = percentage;
                  yield {
                    type: "status",
                    message: `Loading model… ${percentage}%`,
                    phase: "loading",
                  };
                }
              }
              await loadPromise;
              if (options.signal?.aborted) {
                logger.info(
                  `[LM-Studio] Model ${model} loaded but benchmark aborted — unloading`,
                );
                this.unloadModelByKey(model).catch((error: unknown) =>
                  logger.warn(
                    `[LM-Studio] Failed to unload ${model} after abort: ${getErrorMessage(error)}`,
                  ),
                );
                return;
              }

              if (loadError && loadOpts.context_length) {
                const requestedContextLength = loadOpts.context_length;
                const requestedBatchSize =
                  loadOpts.eval_batch_size || LM_STUDIO_EVAL_BATCH_SIZE;
                const rawTiers = [
                  { contextLength: requestedContextLength, batchSize: 512 },
                  {
                    contextLength: 65_000,
                    batchSize: LM_STUDIO_EVAL_BATCH_SIZE,
                  },
                  { contextLength: 65_000, batchSize: 512 },
                ];

                const fallbackTiers = rawTiers
                  .map((tier) => ({
                    contextLength: tier.contextLength,
                    batchSize: Math.min(tier.batchSize, requestedBatchSize),
                  }))
                  .filter(
                    (tier, index, self) =>
                      self.findIndex(
                        (fallbackTier) =>
                          fallbackTier.contextLength === tier.contextLength &&
                          fallbackTier.batchSize === tier.batchSize,
                      ) === index,
                  );

                for (const tier of fallbackTiers) {
                  // Skip tiers that are >= the original request (already failed)
                  if (
                    tier.contextLength >= requestedContextLength &&
                    tier.batchSize >= requestedBatchSize
                  )
                    continue;
                  // Skip tiers with context >= requested (only batch changed)
                  // unless batch is actually smaller
                  if (tier.contextLength > requestedContextLength) continue;
                  if (options.signal?.aborted) return;

                  logger.warn(
                    `[LM-Studio] Load failed at ctx=${requestedContextLength}/batch=${requestedBatchSize} — retrying with ctx=${tier.contextLength}/batch=${tier.batchSize}`,
                  );
                  yield {
                    type: "status",
                    message: `Load failed — retrying with ${Math.round(tier.contextLength / 1000)}k context, batch ${tier.batchSize}…`,
                    phase: "loading",
                  };

                  try {
                    loadOpts.context_length = tier.contextLength;
                    loadOpts.eval_batch_size = tier.batchSize;
                    await this.loadModel(model, loadOpts, options.signal);
                    loadError = null;
                    // Record the GPU-constrained ceiling so subsequent
                    // iterations don't attempt to reload above this limit.
                    _gpuConstrainedContextLength.set(model, tier.contextLength);
                    logger.info(
                      `[LM-Studio] Fallback load succeeded at ctx=${tier.contextLength}/batch=${tier.batchSize} — recorded as GPU ceiling`,
                    );
                    break;
                  } catch (fallbackLoadError: unknown) {
                    if (
                      fallbackLoadError instanceof Error &&
                      fallbackLoadError.name === "AbortError"
                    )
                      return;
                    logger.warn(
                      `[LM-Studio] Fallback load at ctx=${tier.contextLength}/batch=${tier.batchSize} also failed: ${getErrorMessage(fallbackLoadError)}`,
                    );
                  }
                }
              }

              if (loadError) {
                rejectInflight!(loadError);
                throw loadError;
              }

              yield {
                type: "status",
                message: "Loading model… 100%",
                phase: "loading",
              };

              try {
                const refreshedAfterLoad = await this.listModels();
                const entryAfterLoad = (refreshedAfterLoad.models || []).find(
                  (modelItem) => modelItem.key === model,
                );
                const firstInstance = entryAfterLoad?.loaded_instances?.[0];
                if (
                  firstInstance &&
                  typeof firstInstance.config === "object" &&
                  firstInstance.config !== null
                ) {
                  const configRecord = firstInstance.config as Record<
                    string,
                    unknown
                  >;
                  if (typeof configRecord.context_length === "number")
                    options._loadedContextLength = configRecord.context_length;
                  if (typeof configRecord.eval_batch_size === "number")
                    options._loadedEvalBatchSize = configRecord.eval_batch_size;
                  if (typeof configRecord.physical_batch_size === "number")
                    options._loadedPhysicalBatchSize =
                      configRecord.physical_batch_size;
                }
              } catch {
                /* ignore */
              }

              // Detect silent context capping: if load succeeded but the
              // actual loaded context is smaller than what was requested,
              // record this as the GPU-constrained ceiling so subsequent
              // needsReload checks don't trigger an infinite unload/reload.
              if (
                options._loadedContextLength &&
                loadOpts.context_length &&
                (options._loadedContextLength as number) < loadOpts.context_length
              ) {
                logger.info(
                  `[LM-Studio] Model loaded successfully but context was silently capped from ${loadOpts.context_length} to ${options._loadedContextLength}. Recording GPU ceiling.`,
                );
                _gpuConstrainedContextLength.set(
                  model,
                  options._loadedContextLength as number,
                );
              }

              resolveInflight!();
              break;
            } catch (error) {
              rejectInflight!(error);
              throw error;
            } finally {
              if (!isPromiseSettled) {
                rejectInflight!(new Error("Load aborted or cancelled"));
              }
              _loadInflight.delete(model);
            }
          }

          // Model is loaded and ready for inference
          const activeCount = _activeRequestsCount.get(model) || 0;
          _activeRequestsCount.set(model, activeCount + 1);
          isRequestActive = true;
        } catch (loadCheckError: unknown) {
          // If model load explicitly failed, re-throw so the generator exits
          // cleanly. runSingleModel will catch it and record an error result,
          // allowing the benchmark to continue to the next model.
          const isModelLoadFailed =
            loadCheckError instanceof Error &&
            loadCheckError.cause &&
            typeof loadCheckError.cause === "object" &&
            "type" in loadCheckError.cause &&
            (loadCheckError.cause as { type?: unknown }).type ===
              "model_load_failed";

          if (
            isModelLoadFailed ||
            getErrorMessage(loadCheckError)?.includes("Failed to load") ||
            getErrorMessage(loadCheckError)?.includes("API error")
          ) {
            throw loadCheckError;
          }
          logger.warn(
            `Could not check/load model before streaming: ${getErrorMessage(loadCheckError)}`,
          );
        }
        if (options.signal?.aborted) return;
        // Expand video attachments to image frames (ffmpeg) before message prep.
        // This lets the model analyze video content as a sequence of frames,
        // which is the standard approach for Gemma 4 and other VLMs.
        const hasVideo = messages.some((messageItem: ChatMessage) => {
          const message = messageItem as unknown as Record<string, unknown>;
          return (
            "video" in message &&
            Array.isArray(message.video) &&
            message.video.length > 0
          );
        });
        if (hasVideo) {
          yield { type: "status", message: "Extracting video frames…" };
          await expandVideoToFrames(messages);
        }
        const prepared = prepareOpenAICompatMessages(messages, {
          mediaStrategy: MEDIA_STRATEGIES.IMAGES_ONLY,
        });
        // ── Determine tool-calling strategy ──────────────────────
        // When called from Prism's agentic loop (options.agent is set),
        // ALWAYS use the OpenAI-compat /v1/chat/completions endpoint.
        // Prism's loop handles multi-turn tool re-prompting with full
        // tool schemas on every turn — critical for smaller models that
        // lose structured FC format across turns. Native MCP delegates
        // the loop to LM Studio, which conflicts with Prism's approval
        // gating, error budgets, and context window management.
        //
        // Orchestrator tools (team_create, etc.) are Prism-local and
        // also require this path since they can't route via MCP.
        const orchestratorSet = new Set(ORCHESTRATOR_ONLY_TOOLS);
        const hasOrchestratorTools = options.tools?.some((tool) =>
          orchestratorSet.has(tool.name),
        );
        if (options.agent || hasOrchestratorTools) {
          // ── OpenAI-compat path (agentic + orchestrator) ─────────
          yield* this._streamOpenAICompat(prepared, model, options, baseUrl);
          return;
        }
        // ── Native /api/v1/chat path (MCP-based tools) ──────────
        // The native API supports reasoning toggle, MCP tool calling,
        // model load events, and structured stats — all in one path.
        const nativePayload = {
          model,
          input: buildNativeInput(prepared),
          stream: true,
          store: false,
        };
        // Extract system prompt from messages
        const systemMessage = prepared.find(
          (message) => message.role === "system",
        );
        if (systemMessage?.content) {
          (nativePayload as Record<string, unknown>).system_prompt =
            systemMessage.content;
        }
        // Temperature & max tokens from options
        const params = buildPayloadParams(options);
        if (params.temperature != null)
          (nativePayload as Record<string, unknown>).temperature =
            params.temperature;
        if ((params as Record<string, unknown>).max_tokens)
          (nativePayload as Record<string, unknown>).max_output_tokens = (
            params as Record<string, unknown>
          ).max_tokens;
        // Extended sampling params for native API
        if (params.seed != null)
          (nativePayload as Record<string, unknown>).seed = params.seed;
        if (options.topK !== undefined && options.topK > 0)
          (nativePayload as Record<string, unknown>).top_k = options.topK;
        if (options.minP !== undefined)
          (nativePayload as Record<string, unknown>).min_p = options.minP;
        if (options.repeatPenalty !== undefined && options.repeatPenalty !== 1)
          (nativePayload as Record<string, unknown>).repeat_penalty =
            options.repeatPenalty;
        // Reasoning toggle — may be rejected by models that don't support it.
        // We'll try first, and retry without reasoning if it fails.
        let useReasoning = null;
        if (options.thinkingEnabled === false) {
          useReasoning = "off";
        } else if (options.thinkingEnabled === true) {
          useReasoning = "on";
        }
        if (useReasoning) {
          (nativePayload as Record<string, unknown>).reasoning = useReasoning;
        }
        // ── MCP integrations for function calling ──
        // When tools are requested, attach tools-api as an ephemeral MCP server.
        // LM Studio handles the agentic loop — calls tools, re-prompts, streams.
        // NOTE: Each MCP tool schema averages ~500 tokens. We cap the tool count
        // to prevent context overflow. The model's loaded context determines the cap.
        if (options.tools && options.tools.length > 0) {
          let toolNames = options.tools.map((tool) => tool.name);
          // Cap tool count based on loaded model context
          // ~500 tokens/tool; reserve 50% of context for conversation
          const contextLength =
            options._loadedContextLength || options.contextLength || 8192;
          const maxTools = Math.max(1, Math.floor((contextLength * 0.5) / 500));
          let skipMcp = false;
          // If context is too small for even 1 tool, skip MCP entirely
          if (contextLength < 4096) {
            logger.warn(
              `[LM-Studio] Context (${contextLength}) too small for MCP tools. Minimum 4096 recommended. Skipping tools.`,
            );
            yield `⚠️ **Context too small for function calling.** Loaded context is ${contextLength} tokens — each tool requires ~500 tokens. Increase model context to at least **4,096** (8,192+ recommended) to use tools.`;
            skipMcp = true;
          } else if (toolNames.length > maxTools) {
            logger.warn(
              `[LM-Studio] Tool count (${toolNames.length}) exceeds safe limit for ctx=${contextLength}. Capping at ${maxTools}.`,
            );
            toolNames = toolNames.slice(0, maxTools);
            yield {
              type: "status",
              message: `Context limit (${contextLength}) — using ${maxTools} of ${options.tools.length} tools`,
            };
          }
          if (!skipMcp) {
            (nativePayload as Record<string, unknown>).integrations = [
              {
                type: "ephemeral_mcp",
                server_label: "tools",
                server_url: `${MCP_SERVER_URL}/mcp/sse?project=${encodeURIComponent(options.project || DEFAULT_PROJECT)}&agent=${encodeURIComponent(options.agent || AGENT_IDS.CODING)}${options.username ? `&username=${encodeURIComponent(String(options.username))}` : ""}`,
                allowed_tools: toolNames,
              },
            ];
            logger.info(
              `[LM-Studio] MCP integration: ${toolNames.length} tools via ${MCP_SERVER_URL}/mcp/sse`,
            );
          }
        }
        // ── Send request (with reasoning fallback) ──
        // Some models (e.g. DeepSeek R1 Distill) don't expose reasoning config.
        // If the request fails with a reasoning-related error, retry without it.
        const makeRequest = async (payload: Record<string, unknown>) => {
          const payloadString = JSON.stringify(payload, null, 2);
          const inputShape = Array.isArray(payload.input)
            ? `array[${payload.input.length}]: ${payload.input.map((record: Record<string, unknown>) => record.type).join(", ")}`
            : `string[${((payload.input || "") as string).length}]`;
          logger.info(
            `[LM-Studio] Native API: reasoning=${payload.reasoning || "default"}, tools=${payload.integrations ? "mcp" : "none"}, input=${inputShape}, ${payloadString.length} chars`,
          );
          const response = await fetch(`${baseUrl}/api/v1/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            dispatcher: STREAMING_DISPATCHER,
            ...(options.signal && { signal: options.signal }),
          } as RequestInit & { dispatcher: typeof STREAMING_DISPATCHER });
          return response;
        };
        let nativeResponse = await makeRequest(nativePayload);
        // If reasoning param was rejected, retry without it
        if (!nativeResponse.ok && useReasoning) {
          const errorText = await nativeResponse.text();
          if (
            nativeResponse.status === 400 &&
            (errorText.includes("reasoning") ||
              errorText.includes("does not expose"))
          ) {
            logger.warn(
              `[LM-Studio] Model ${model} does not support reasoning config, retrying without it`,
            );
            delete (nativePayload as Record<string, unknown>).reasoning;
            nativeResponse = await makeRequest(nativePayload);
          } else {
            throw new Error(`API error: ${nativeResponse.status} ${errorText}`);
          }
        }
        if (!nativeResponse.ok) {
          const errorText = await nativeResponse.text();
          throw new Error(`API error: ${nativeResponse.status} ${errorText}`);
        }
        if (!nativeResponse.body) throw new Error("No response body");
        const nativeReader = nativeResponse.body.getReader();
        for await (const chunk of parseNativeSSEStream(nativeReader, {
          signal: options.signal,
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
        // Enrich generic network errors (e.g. Node.js undici "terminated" for
        // premature connection close) with LM Studio-specific diagnostic context.
        const rawMessage = getErrorMessage(error);
        const errorCode =
          (error instanceof Error && (error as NodeJS.ErrnoException).code) ||
          null;
        const errorCause =
          error instanceof Error && error.cause
            ? getErrorMessage(error.cause)
            : null;
        const diagnosticParts = [
          `LM Studio (${instanceId}) stream error: ${rawMessage}`,
          `model=${model}`,
          errorCode && `code=${errorCode}`,
          errorCause && errorCause !== rawMessage && `cause=${errorCause}`,
        ].filter(Boolean);
        throw new ProviderError(
          PROVIDERS.LM_STUDIO,
          diagnosticParts.join(", "),
          500,
          error,
        );
      } finally {
        if (isRequestActive) {
          const activeCount = _activeRequestsCount.get(model) || 0;
          if (activeCount <= 1) {
            _activeRequestsCount.delete(model);
          } else {
            _activeRequestsCount.set(model, activeCount - 1);
          }
        }
      }
    },
    /**
     * OpenAI-compat streaming path — used when orchestrator tools are enabled.
     * Sends a standard /v1/chat/completions request with `tools` array.
     * Tool calls yield as non-native events, so Prism's agentic loop
     * executes them (including team_create, send_message, stop_agent).
     *
     * @private
     */
    async *_streamOpenAICompat(
      prepared: PreparedMessage[],
      model: string,
      options: ProviderOptions,
      baseUrl: string,
    ): AsyncGenerator<StreamChunk, void, unknown> {
      const payload = {
        messages: prepared,
        model,
        ...buildPayloadParams(options),
        ...(options.topK !== undefined &&
          options.topK > 0 && { top_k: options.topK }),
        ...(options.minP !== undefined && { min_p: options.minP }),
        ...(options.repeatPenalty !== undefined &&
          options.repeatPenalty !== 1 && {
            repeat_penalty: options.repeatPenalty,
          }),
        stream: true,
        // Request usage in the final streamed chunk
        stream_options: { include_usage: true },
      };
      // Convert tool schemas to OpenAI format
      const tools = convertToolsToOpenAI(options.tools);
      if (tools) {
        // ── Cap tool count based on loaded model context ──────────
        // Each tool schema averages ~500 tokens. Reserve 50% of context
        // for the conversation. Without this cap, 65+ tool schemas
        // overflow the context and LM Studio returns empty responses.
        const contextLength =
          options._loadedContextLength || options.contextLength || 8192;
        const maxTools = Math.max(
          1,
          Math.floor(((contextLength as number) * 0.5) / 500),
        );
        if (tools.length > maxTools) {
          logger.warn(
            `[LM-Studio] OpenAI-compat: tool count (${tools.length}) exceeds safe limit for ctx=${contextLength}. Capping at ${maxTools}.`,
          );
          (payload as Record<string, unknown>).tools = tools.slice(0, maxTools);
        } else {
          (payload as Record<string, unknown>).tools = tools;
        }
      }
      logger.info(
        `[LM-Studio] OpenAI-compat streaming (agentic): model=${model}, tools=${((payload as Record<string, unknown>).tools as unknown[] | undefined)?.length || 0}/${options.tools?.length || 0}, ctx=${options._loadedContextLength || "unset"}`,
      );
      yield { type: "status", message: "Starting…", phase: "starting" };
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        dispatcher: STREAMING_DISPATCHER,
        ...(options.signal && { signal: options.signal }),
      } as RequestInit & { dispatcher: typeof STREAMING_DISPATCHER });
      if (!response.ok) {
        const errorText = await response.text();
        throw new ProviderError(
          PROVIDERS.LM_STUDIO,
          `API error: ${response.status} ${errorText}`,
          response.status,
        );
      }
      yield {
        type: "status",
        message: "Processing prompt…",
        phase: "prefilling",
        progress: 0,
      };
      if (!response.body) throw new Error("No response body");
      const reader = response.body.getReader();
      let emittedPhaseTransition = false;
      for await (const chunk of parseSSEStream(reader, {
        signal: options.signal,
        thinkingEnabled: options.thinkingEnabled,
      })) {
        // Emit the correct phase based on the first chunk type —
        // avoids a false "generating" → "thinking" flicker when the
        // model starts with reasoning tokens.
        if (!emittedPhaseTransition) {
          emittedPhaseTransition = true;
          const isThinking =
            chunk && typeof chunk === "object" && chunk.type === "thinking";
          yield {
            type: "status",
            message: isThinking ? "Thinking…" : "Generating…",
            phase: isThinking ? "thinking" : "generating",
          };
        }
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
    },
    // ── Embedding Generation ─────────────────────────────────
    /**
     * Generate an embedding via the OpenAI-compatible /v1/embeddings endpoint.
     * LM Studio exposes this for any loaded embedding model (e.g. Granite,
     * nomic-embed, etc.).
     */
    async generateEmbedding(
      content: unknown,
      model: string,
      options: ProviderOptions = {},
    ) {
      const baseUrl = getBaseUrl();
      logger.provider(
        "LM Studio",
        `generateEmbedding model=${model} baseUrl=${baseUrl}`,
      );
      try {
        const payload = { model, input: content };
        if (options.dimensions)
          (payload as Record<string, unknown>).dimensions = options.dimensions;
        const response = await fetchOpenAICompat(
          `${baseUrl}/v1/embeddings`,
          payload,
        );
        const data = await response.json();
        const embedding = (data as Record<string, unknown>).data as
          | Array<Record<string, unknown>>
          | undefined;
        const firstEmbedding = embedding?.[0]?.embedding as
          | number[]
          | undefined;
        if (!firstEmbedding) {
          throw new Error("No embedding data in LM Studio response");
        }
        return { embedding: firstEmbedding, dimensions: firstEmbedding.length };
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          PROVIDERS.LM_STUDIO,
          getErrorMessage(error),
          500,
          error,
        );
      }
    },
    async captionImage(
      images: string[],
      prompt: string = "Describe this image.",
      model: string = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)[
        PROVIDERS.LM_STUDIO
      ],
      systemPrompt?: string,
    ): Promise<{
      text: string;
      usage: { inputTokens: number; outputTokens: number };
    }> {
      const baseUrl = getBaseUrl();
      logger.provider(
        "LM Studio",
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
        const data = await response.json();
        const text = (data as Record<string, unknown>).choices
          ? ((
              (data as Record<string, unknown>).choices as Array<
                Record<string, unknown>
              >
            )?.[0]?.message as Record<string, unknown>)
          : undefined;
        const textContent = (text?.content as string) || "";
        const rawUsage = (data as Record<string, unknown>).usage as
          | Record<string, number>
          | undefined;
        return {
          text: textContent,
          usage: {
            inputTokens: rawUsage?.prompt_tokens || 0,
            outputTokens: rawUsage?.completion_tokens || 0,
          },
        };
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          PROVIDERS.LM_STUDIO,
          getErrorMessage(error),
          500,
          error,
        );
      }
    },
    // ── Model Management ─────────────────────────────────────
    /**
     * Ensure exactly one model is loaded in LM Studio.
     * - If the requested model is already loaded, returns immediately with its context info.
     * - If a different model is loaded, unloads it first.
     * - If no model is loaded, loads the requested one.
     */
    async ensureModelLoaded(
      modelKey: string,
      loadOptions: ProviderOptions = {},
      signal?: AbortSignal,
      onStatus?: (message: string) => void,
    ) {
      if (signal?.aborted) return { alreadyLoaded: false, contextLength: null };

      while (true) {
        if (signal?.aborted)
          return { alreadyLoaded: false, contextLength: null };

        if (_loadInflight.has(modelKey)) {
          logger.info(
            `[LM-Studio:${instanceId}] ensureModelLoaded("${modelKey}") — waiting on inflight load…`,
          );
          onStatus?.("Waiting for model load…");
          try {
            await _loadInflight.get(modelKey);
          } catch {
            // Ignore, we'll recheck status
          }
          continue;
        }

        const { models: ensureModels } = await this.listModels();
        if (signal?.aborted)
          return { alreadyLoaded: false, contextLength: null };

        const modelEntry = (ensureModels || []).find(
          (modelItem) => modelItem.key === modelKey,
        );
        const isLoaded = (modelEntry?.loaded_instances?.length ?? 0) > 0;

        if (isLoaded) {
          const loadedInstance = modelEntry?.loaded_instances?.[0];
          const loadedContextValue =
            loadedInstance?.config?.context_length || null;
          logger.info(
            `[LM-Studio] Model ${modelKey} already loaded (ctx=${loadedContextValue})`,
          );
          return { alreadyLoaded: true, contextLength: loadedContextValue };
        }

        // Double check map before loading
        if (_loadInflight.has(modelKey)) {
          continue;
        }

        // Register synchronously
        let resolveInflight: (() => void) | undefined = undefined;
        let rejectInflight: ((error: unknown) => void) | undefined = undefined;
        let isPromiseSettled = false;
        const inflightPromise = new Promise<void>((resolve, reject) => {
          resolveInflight = () => {
            isPromiseSettled = true;
            resolve();
          };
          rejectInflight = (error) => {
            isPromiseSettled = true;
            reject(error);
          };
        });
        inflightPromise.catch(() => {});
        _loadInflight.set(modelKey, inflightPromise);

        try {
          // Unload any other loaded models first (single-model enforcement)
          for (const currentModelEntry of ensureModels || []) {
            if (signal?.aborted)
              return { alreadyLoaded: false, contextLength: null };

            const otherModelKey = currentModelEntry.key as string;
            if ((_activeRequestsCount.get(otherModelKey) || 0) > 0) {
              logger.warn(
                `[LM-Studio] Skipping auto-unload of active model "${otherModelKey}" because it is currently in use`,
              );
              continue;
            }

            for (const instance of currentModelEntry.loaded_instances || []) {
              onStatus?.("Unloading previous model…");
              logger.info(
                `[LM-Studio] Auto-unloading ${instance.id} before loading ${modelKey}`,
              );
              try {
                await this.unloadModel(instance.id);
              } catch (error: unknown) {
                // If it fails (e.g. concurrent unload), log and continue
                logger.warn(
                  `Failed to unload instance ${instance.id}: ${getErrorMessage(error)}`,
                );
              }
            }
          }
          if (signal?.aborted)
            return { alreadyLoaded: false, contextLength: null };

          // Cap load request against known GPU ceiling to avoid pointless
          // over-requests that will just be silently capped again.
          if (
            loadOptions.context_length &&
            typeof loadOptions.context_length === "number"
          ) {
            const gpuCeilingForEnsure =
              _gpuConstrainedContextLength.get(modelKey);
            if (
              gpuCeilingForEnsure &&
              loadOptions.context_length > gpuCeilingForEnsure
            ) {
              logger.info(
                `[LM-Studio] ensureModelLoaded: capping context_length from ${loadOptions.context_length} to GPU ceiling ${gpuCeilingForEnsure}`,
              );
              loadOptions.context_length = gpuCeilingForEnsure;
            }
          }

          logger.info(`[LM-Studio] Loading model ${modelKey}`);
          onStatus?.("Loading model… 0%");
          await this.loadModel(modelKey, loadOptions, signal);
          onStatus?.("Loading model… 100%");

          const refreshed = await this.listModels();
          const entry = (refreshed.models || []).find(
            (modelItem) => modelItem.key === modelKey,
          );
          const contextLength =
            entry?.loaded_instances?.[0]?.config?.context_length || null;

          // Detect silent context capping and record GPU ceiling
          if (
            contextLength &&
            loadOptions.context_length &&
            typeof loadOptions.context_length === "number" &&
            contextLength < loadOptions.context_length
          ) {
            logger.info(
              `[LM-Studio] ensureModelLoaded: context silently capped from ${loadOptions.context_length} to ${contextLength}. Recording GPU ceiling.`,
            );
            _gpuConstrainedContextLength.set(modelKey, contextLength);
          }

          resolveInflight!();
          return { alreadyLoaded: false, contextLength };
        } catch (error) {
          rejectInflight!(error);
          throw error;
        } finally {
          if (!isPromiseSettled) {
            rejectInflight!(new Error("Load aborted or cancelled"));
          }
          _loadInflight.delete(modelKey);
        }
      }
    },

    /**
     * List all models available in LM Studio.
     * Uses the proprietary GET /api/v1/models endpoint.
     */
    async listModels(): Promise<ListModelsResult> {
      const baseUrl = getBaseUrl();
      logger.provider("LM Studio", "listModels");
      try {
        const response = await fetch(`${baseUrl}/api/v1/models`, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        });
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API error: ${response.status} ${errorText}`);
        }
        const data = await response.json();
        const rawRecord = data as Record<string, unknown>;
        const rawModels = (rawRecord.models || rawRecord.data || []) as Array<
          Record<string, unknown>
        >;
        for (const model of rawModels) {
          const arch = model.architecture as string | undefined;
          const params = model.params_string as string | undefined;
          const sizeBytes = (model.size_bytes as number) || 0;
          const bitsPerWeight =
            ((model.quantization as Record<string, unknown>)
              ?.bits_per_weight as number) || 4;
          model.archParams = resolveArchParams(
            arch ?? null,
            params ?? null,
            sizeBytes,
            bitsPerWeight,
          );
          if (!model.key) model.key = String(model.id || "");
          if (!model.display_name)
            model.display_name = String(model.display_name || model.id || "");
          if (!model.type) model.type = "llm";
        }
        const models = rawModels as unknown as LmStudioModelEntry[];
        return { models, data: models };
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          PROVIDERS.LM_STUDIO,
          getErrorMessage(error),
          500,
          error,
        );
      }
    },
    async loadModel(
      model: string,
      options: ProviderOptions = {},
      signal?: AbortSignal,
    ) {
      // ── Singleflight: coalesce concurrent loads of the same model ──
      // LM Studio creates a NEW instance every time /api/v1/models/load
      // is called, even if the model is already loading. This gate ensures
      // only the first caller actually POSTs — all others await the same
      // inflight promise.
      if (_loadModelInflight.has(model)) {
        logger.info(
          `[LM-Studio:${instanceId}] loadModel("${model}") — singleflight: already loading, waiting…`,
        );
        return _loadModelInflight.get(model);
      }

      const baseUrl = getBaseUrl();
      logger.provider("LM Studio", `loadModel model=${model}`);

      const loadWork = (async () => {
        try {
          const payload: LmStudioLoadConfig = { model };
          if (options.context_length != null)
            payload.context_length = options.context_length;
          if (options.flash_attention != null)
            payload.flash_attention = options.flash_attention;
          if (options.offload_kv_cache_to_gpu != null)
            payload.offload_kv_cache_to_gpu = options.offload_kv_cache_to_gpu;
          if (options.eval_batch_size != null)
            payload.eval_batch_size = options.eval_batch_size;
          if (options.parallel != null)
            payload.parallel = options.parallel;
          if (options.unified_kv_cache != null)
            payload.unified_kv_cache = options.unified_kv_cache;

          const response = await fetch(`${baseUrl}/api/v1/models/load`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            ...(signal && { signal }),
          });
          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API error: ${response.status} ${errorText}`);
          }
          await response.json();
        } catch (error: unknown) {
          if (error instanceof Error && error.name === "AbortError")
            throw error;
          if (error instanceof ProviderError) throw error;
          throw new ProviderError(
            PROVIDERS.LM_STUDIO,
            getErrorMessage(error),
            500,
            error,
          );
        }
      })();

      _loadModelInflight.set(model, loadWork);
      try {
        return await loadWork;
      } finally {
        _loadModelInflight.delete(model);
      }
    },
    /**
     * Unload a model from LM Studio by its model key.
     * Looks up the loaded instance ID and unloads it.
     */
    async unloadModelByKey(modelKey: string) {
      try {
        const { models } = await this.listModels();
        for (const modelEntry of models || []) {
          if (modelEntry.key !== modelKey) continue;
          for (const instance of modelEntry.loaded_instances || []) {
            logger.info(
              `[LM-Studio] Unloading ${instance.id} (cleanup after abort)`,
            );
            await this.unloadModel(instance.id);
          }
        }
      } catch (error: unknown) {
        logger.warn(
          `[LM-Studio] unloadModelByKey(${modelKey}) failed: ${getErrorMessage(error)}`,
        );
      }
    },
    async unloadModel(instanceId: string) {
      const baseUrl = getBaseUrl();
      logger.provider("LM Studio", `unloadModel instanceId=${instanceId}`);
      try {
        const response = await fetch(`${baseUrl}/api/v1/models/unload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instance_id: instanceId }),
        });
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API error: ${response.status} ${errorText}`);
        }
        await response.json();
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          PROVIDERS.LM_STUDIO,
          getErrorMessage(error),
          500,
          error,
        );
      }
    },
  };
}
