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
import { ProviderError } from "../utils/errors.js";
import logger from "../utils/logger.js";
import { TYPES, getDefaultModels } from "../config.js";
import { convertToolsToOpenAI, buildPayloadParams, prepareOpenAICompatMessages, expandVideoToFrames, processNonStreamingResponse, parseSSEStream, fetchOpenAICompat, MEDIA_STRATEGIES, } from "../utils/openai-compat.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
// ── Provider ─────────────────────────────────────────────────
export function createLlamaCppProvider(baseUrl, instanceId = "llama-cpp") {
    const getBaseUrl = () => baseUrl;
    return {
        name: instanceId,
        // ── Non-Streaming Text Generation ──────────────────────────
        // POST /v1/chat/completions with stream: false
        async generateText(messages, model = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["llama-cpp"], options = {}) {
            const baseUrl = getBaseUrl();
            logger.provider("llama.cpp", `generateText model=${model} baseUrl=${baseUrl}`);
            try {
                // Expand video attachments to image frames (ffmpeg) before message prep
                await expandVideoToFrames(messages);
                const prepared = prepareOpenAICompatMessages(messages, {
                    mediaStrategy: MEDIA_STRATEGIES.TEXT_FALLBACK,
                });
                const payload = {
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
                const response = await fetchOpenAICompat(`${baseUrl}/v1/chat/completions`, payload);
                const data = (await response.json());
                const { text, thinking, usage, toolCalls } = processNonStreamingResponse(data, {
                    thinkingEnabled: options.thinkingEnabled,
                });
                // Extract timings for tok/s reporting (llama.cpp extension)
                if (data.timings?.predicted_per_second) {
                    usage.tokensPerSec = parseFloat(data.timings.predicted_per_second.toFixed(1));
                }
                const result = {
                    text,
                    usage: {
                        inputTokens: usage.inputTokens || 0,
                        outputTokens: usage.outputTokens || 0,
                    },
                };
                if (thinking)
                    result.thinking = thinking;
                if (toolCalls) {
                    result.toolCalls = toolCalls.map((toolCall) => ({
                        id: toolCall.id || "",
                        name: toolCall.name,
                        args: typeof toolCall.args === "object" && toolCall.args !== null
                            ? toolCall.args
                            : {},
                        thoughtSignature: toolCall.thoughtSignature || undefined,
                    }));
                }
                return result;
            }
            catch (error) {
                if (error instanceof ProviderError)
                    throw error;
                throw new ProviderError("llama-cpp", getErrorMessage(error), 500, error);
            }
        },
        // ── Streaming Text Generation (SSE) ──────────────────────
        async *generateTextStream(messages, model = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["llama-cpp"], options = {}) {
            const baseUrl = getBaseUrl();
            logger.provider("llama.cpp", `generateTextStream model=${model} baseUrl=${baseUrl}`);
            try {
                // Expand video attachments to image frames (ffmpeg) before message prep
                await expandVideoToFrames(messages);
                const prepared = prepareOpenAICompatMessages(messages, {
                    mediaStrategy: MEDIA_STRATEGIES.TEXT_FALLBACK,
                });
                const payload = {
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
                const response = await fetchOpenAICompat(`${baseUrl}/v1/chat/completions`, payload, { signal: options.signal });
                const reader = response.body.getReader();
                for await (const chunk of parseSSEStream(reader, {
                    signal: options.signal,
                    thinkingEnabled: options.thinkingEnabled,
                    // llama.cpp extension: extract timings for tok/s
                    onUsage: (json, usage) => {
                        const timings = json.timings;
                        if (timings?.predicted_per_second) {
                            usage.tokensPerSec = parseFloat(timings.predicted_per_second.toFixed(1));
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
                        }
                        else if (chunk.type === "toolCall") {
                            yield {
                                ...chunk,
                                id: chunk.id || "",
                            };
                        }
                        else {
                            yield chunk;
                        }
                    }
                    else {
                        yield chunk;
                    }
                }
            }
            catch (error) {
                if (error instanceof Error && error.name === "AbortError")
                    return; // Client disconnected
                if (error instanceof ProviderError)
                    throw error;
                throw new ProviderError("llama-cpp", getErrorMessage(error), 500, error);
            }
        },
        // ── Image Captioning ──────────────────────────────────────
        // Uses POST /v1/chat/completions with image_url content parts.
        // Requires a vision-capable model (LLaVA, Qwen-VL, etc.)
        async captionImage(images, prompt = "Describe this image.", model = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)["llama-cpp"], systemPrompt) {
            const baseUrl = getBaseUrl();
            logger.provider("llama.cpp", `captionImage model=${model} baseUrl=${baseUrl}`);
            try {
                const content = [
                    { type: "text", text: prompt },
                    ...images.map((image) => ({
                        type: "image_url",
                        image_url: { url: image },
                    })),
                ];
                const messages = [];
                if (systemPrompt) {
                    messages.push({ role: "system", content: systemPrompt });
                }
                messages.push({ role: "user", content });
                const response = await fetchOpenAICompat(`${baseUrl}/v1/chat/completions`, {
                    messages,
                    model,
                    temperature: 0.7,
                    max_tokens: -1,
                    stream: false,
                });
                const data = (await response.json());
                const text = data.choices?.[0]?.message?.content || "";
                const usage = {
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
            }
            catch (error) {
                if (error instanceof ProviderError)
                    throw error;
                throw new ProviderError("llama-cpp", getErrorMessage(error), 500, error);
            }
        },
        // ── Embedding Generation ─────────────────────────────────
        // POST /v1/embeddings — requires llama-server started with --embedding
        async generateEmbedding(content, model, options = {}) {
            const baseUrl = getBaseUrl();
            logger.provider("llama.cpp", `generateEmbedding model=${model} baseUrl=${baseUrl}`);
            try {
                const payload = {
                    model,
                    input: content,
                };
                if (options.dimensions)
                    payload.dimensions = options.dimensions;
                const response = await fetchOpenAICompat(`${baseUrl}/v1/embeddings`, payload);
                const data = (await response.json());
                const embedding = data.data?.[0]?.embedding;
                if (!embedding) {
                    throw new Error("No embedding data in llama.cpp response");
                }
                return {
                    embedding,
                    dimensions: embedding.length,
                };
            }
            catch (error) {
                if (error instanceof ProviderError)
                    throw error;
                throw new ProviderError("llama-cpp", getErrorMessage(error), 500, error);
            }
        },
        // ── Model Listing ────────────────────────────────────────
        // GET /v1/models
        async listModels() {
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
                const data = (await response.json());
                // Normalize to our standard { models: [...] } format
                const models = (data.data || []).map((model) => ({
                    key: model.id,
                    display_name: model.id,
                    type: "llm",
                    loaded_instances: [{ id: model.id }], // llama.cpp models are always loaded
                }));
                return { models };
            }
            catch (error) {
                if (error instanceof ProviderError)
                    throw error;
                throw new ProviderError("llama-cpp", getErrorMessage(error), 500, error);
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
                const data = (await response.json());
                return {
                    ok: response.ok,
                    status: response.ok
                        ? data.status || "ok"
                        : data.status || data.error?.message || "error",
                    slotsIdle: data.slots_idle ?? null,
                    slotsProcessing: data.slots_processing ?? null,
                };
            }
            catch (error) {
                return {
                    ok: false,
                    status: "unreachable",
                    error: getErrorMessage(error),
                };
            }
        },
        // ── Server Props ─────────────────────────────────────────
        // GET /props + GET /slots — rich runtime metadata
        async getServerProps() {
            const baseUrl = getBaseUrl();
            logger.provider("llama.cpp", "getServerProps");
            // Fetch /props and /slots in parallel with independent timeouts
            const [propsResult, slotsResult, healthResult] = await Promise.allSettled([
                fetch(`${baseUrl}/props`, {
                    method: "GET",
                    signal: AbortSignal.timeout(3000),
                }).then((response) => {
                    if (!response.ok)
                        return null;
                    return response.json();
                }),
                fetch(`${baseUrl}/slots`, {
                    method: "GET",
                    signal: AbortSignal.timeout(3000),
                }).then((response) => {
                    if (!response.ok)
                        return null;
                    return response.json();
                }),
                fetch(`${baseUrl}/health`, {
                    method: "GET",
                    signal: AbortSignal.timeout(3000),
                }).then((response) => {
                    if (!response.ok)
                        return null;
                    return response.json();
                }),
            ]);
            const propsData = propsResult.status === "fulfilled" ? propsResult.value : null;
            const slotsData = slotsResult.status === "fulfilled" ? slotsResult.value : null;
            const healthData = healthResult.status === "fulfilled" ? healthResult.value : null;
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
                ? slotsData.map((slot) => ({
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
//# sourceMappingURL=llama-cpp.js.map