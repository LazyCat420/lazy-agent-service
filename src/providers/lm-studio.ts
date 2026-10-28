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
  LAZY_AGENT_SERVICE_URL,
  LM_STUDIO_EVAL_BATCH_SIZE,
  LM_STUDIO_DEFAULT_MAX_CONTEXT,
} from "../../config.ts";
import { TYPES, getDefaultModels } from "../config.ts";
// Default MCP server URL for ephemeral tool integrations. This is OUR OWN
// /mcp endpoint, so address it on loopback via the bind port. It used to be
// the hardcoded docker-DNS name "http://lazy-agent-service:7778", which only
// resolved from inside the same compose project (no shared `networks:` block
// exists in this ecosystem) and was silently coupled to IMAGE_NAME in deploy.sh.
const DEFAULT_MCP_SERVER_URL = LAZY_AGENT_SERVICE_URL;
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
  prependIdentitySystemMessage,
} from "../utils/openai-compat.ts";
import { ORCHESTRATOR_ONLY_TOOLS } from "../services/OrchestratorPrompt.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import { PROVIDERS } from "../constants.ts";
// ── Native /api/v1/chat SSE stream parser ────────────────────
// The native endpoint emits named SSE events: reasoning.start/delta/end,
// message.start/delta/end, content.start/delta/end, chat.end.
// This generator yields the same event types as parseSSEStream so both
// paths integrate seamlessly with the rest of the pipeline.
interface NativeStreamState {
  usage: {
    inputTokens: number;
    outputTokens: number;
    tokensPerSec?: number;
    timeToFirstToken?: number;
    reasoningOutputTokens?: number;
  } | null;
  partialOutputCharacters: number;
  partialReasoningCharacters: number;
  currentToolCall: {
    tool: string;
    arguments: Record<string, unknown>;
  } | null;
}

const NATIVE_STATIC_STATUS_EVENTS: Record<
  string,
  { type: "status"; message: string; phase: string; progress?: number }
> = {
  "chat.start": { type: "status", message: "Starting…", phase: "starting" },
  "model_load.start": {
    type: "status",
    message: "Loading model… 0%",
    phase: "loading",
  },
  "model_load.end": {
    type: "status",
    message: "Loading model… 100%",
    phase: "loading",
  },
  "prompt_processing.start": {
    type: "status",
    message: "Processing prompt…",
    phase: "prefilling",
    progress: 0,
  },
  "prompt_processing.end": {
    type: "status",
    message: "Processing prompt… done",
    phase: "prefilling",
    progress: 1,
  },
  "message.start": {
    type: "status",
    message: "Generating…",
    phase: "generating",
  },
};

function handleNativeProgressEvent(json: Record<string, unknown>) {
  const type = json.type as string;
  if (type === "model_load.progress") {
    const percentage =
      json.progress != null ? Math.round(Number(json.progress) * 100) : 0;
    return {
      type: "status" as const,
      message: `Loading model… ${percentage}%`,
      phase: "loading",
    };
  }
  if (type === "prompt_processing.progress") {
    const progress = json.progress != null ? Number(json.progress) : 0;
    const percentage = Math.round(progress * 100);
    return {
      type: "status" as const,
      message: `Processing prompt… ${percentage}%`,
      phase: "prefilling",
      progress,
    };
  }
  return null;
}

function handleNativeToolCallNameOrArgs(
  json: Record<string, unknown>,
  state: NativeStreamState,
) {
  const type = json.type as string;
  if (type === "tool_call.name") {
    const toolName = (json.tool_name as string) || "any";
    if (state.currentToolCall) {
      state.currentToolCall.tool = toolName;
    }
    return {
      type: "toolCall" as const,
      id: (json.tool_call_id as string) || null,
      name: toolName,
      args: {},
      status: "calling" as const,
      native: true,
    };
  }
  if (state.currentToolCall && json.arguments) {
    state.currentToolCall.arguments =
      typeof json.arguments === "object"
        ? (json.arguments as Record<string, unknown>)
        : safeParseJSON(json.arguments);
  }
  if (state.currentToolCall && json.tool) {
    state.currentToolCall.tool = json.tool as string;
  }
  return null;
}

function handleNativeToolCallCompletion(
  json: Record<string, unknown>,
  state: NativeStreamState,
) {
  const type = json.type as string;
  if (type === "tool_call.success") {
    const toolName =
      (json.tool as string) || state.currentToolCall?.tool || "any";
    const args = json.arguments || state.currentToolCall?.arguments || {};
    state.currentToolCall = null;
    return {
      type: "toolCall" as const,
      id: (json.tool_call_id as string) || null,
      name: toolName,
      args: typeof args === "object" ? args : safeParseJSON(args),
      result: json.output ? safeParseJSON(json.output) : json.output,
      status: "done" as const,
      native: true,
    };
  }
  const failName =
    (json.tool as string) || state.currentToolCall?.tool || "any";
  const failArgs = state.currentToolCall?.arguments || {};
  state.currentToolCall = null;
  return {
    type: "toolCall" as const,
    id: (json.tool_call_id as string) || null,
    name: failName,
    args: failArgs,
    result: { error: (json.reason as string) || "Tool call failed" },
    status: "error" as const,
    native: true,
  };
}

function handleNativeToolCallEvent(
  json: Record<string, unknown>,
  state: NativeStreamState,
) {
  const type = json.type as string;
  if (type === "tool_call.start") {
    state.currentToolCall = { tool: "any", arguments: {} };
    return null;
  }
  if (type === "tool_call.name" || type === "tool_call.arguments") {
    return handleNativeToolCallNameOrArgs(json, state);
  }
  if (type === "tool_call.success" || type === "tool_call.failure") {
    return handleNativeToolCallCompletion(json, state);
  }
  return null;
}

function recordNativeChatEndStats(
  json: Record<string, unknown>,
  state: NativeStreamState,
): void {
  const resultObj = json.result as Record<string, unknown> | undefined;
  const stats = (resultObj?.stats || json.stats) as
    | Record<string, number>
    | undefined;
  if (!stats) return;
  state.usage = {
    inputTokens: stats.input_tokens || 0,
    outputTokens: stats.total_output_tokens || 0,
    tokensPerSec: stats.tokens_per_second || undefined,
    timeToFirstToken: stats.time_to_first_token_seconds || undefined,
    reasoningOutputTokens: stats.reasoning_output_tokens || undefined,
  };
}

function processNativeSSEEventObject(
  json: Record<string, unknown>,
  state: NativeStreamState,
) {
  const type = json.type as string;
  if (type in NATIVE_STATIC_STATUS_EVENTS) {
    return NATIVE_STATIC_STATUS_EVENTS[type];
  }
  if (type === "reasoning.delta" && json.content) {
    state.partialReasoningCharacters += (json.content as string).length;
    return { type: "thinking" as const, content: json.content as string };
  }
  if ((type === "content.delta" || type === "message.delta") && json.content) {
    state.partialOutputCharacters += (json.content as string).length;
    return json.content as string;
  }
  const progressChunk = handleNativeProgressEvent(json);
  if (progressChunk) return progressChunk;

  if (typeof type === "string" && type.startsWith("tool_call.")) {
    return handleNativeToolCallEvent(json, state);
  }
  if (type === "error") {
    const errObj = json.error as { message?: string } | undefined;
    const errorMessage = errObj?.message || JSON.stringify(json.error);
    logger.warn(`[LM-Studio] Stream error: ${errorMessage}`);
    return `\n\n⚠️ **LM Studio Error:** ${errorMessage}`;
  }
  if (type === "chat.end") {
    recordNativeChatEndStats(json, state);
  }
  return null;
}

function buildPartialNativeUsageEvent(state: NativeStreamState) {
  if (state.usage) {
    return { type: "usage" as const, usage: state.usage };
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
      type: "usage" as const,
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

async function* parseNativeSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: ProviderOptions = {},
) {
  const decoder = new TextDecoder();
  let buffer = "";
  const state: NativeStreamState = {
    usage: null,
    partialOutputCharacters: 0,
    partialReasoningCharacters: 0,
    currentToolCall: null,
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
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        try {
          const json = JSON.parse(trimmed.slice(6));
          const emitted = processNativeSSEEventObject(json, state);
          if (emitted !== null) {
            yield emitted;
          }
        } catch {
          // skip malformed JSON
        }
      }
    }
  } catch (streamError) {
    if (!usageYielded) {
      usageYielded = true;
      const partialEvent = buildPartialNativeUsageEvent(state);
      if (partialEvent) yield partialEvent;
    }
    throw streamError;
  } finally {
    options.signal?.removeEventListener("abort", abortHandler);
    if (!usageYielded) {
      usageYielded = true;
      yield {
        type: "usage",
        usage: state.usage || { inputTokens: 0, outputTokens: 0 },
      };
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

interface LmStudioState {
  baseUrl: string;
  instanceId: string;
  mcpServerUrl: string;
  loadInflight: Map<string, Promise<void>>;
  loadModelInflight: Map<string, Promise<void>>;
  activeRequestsCount: Map<string, number>;
  gpuConstrainedContextLength: Map<string, number>;
}

function incrementActiveRequests(
  activeRequestsCount: Map<string, number>,
  model: string,
): void {
  const activeCount = activeRequestsCount.get(model) || 0;
  activeRequestsCount.set(model, activeCount + 1);
}

function decrementActiveRequests(
  activeRequestsCount: Map<string, number>,
  model: string,
): void {
  const activeCount = activeRequestsCount.get(model) || 0;
  if (activeCount <= 1) {
    activeRequestsCount.delete(model);
  } else {
    activeRequestsCount.set(model, activeCount - 1);
  }
}

function createInflightGate() {
  let resolveInflight!: () => void;
  let rejectInflight!: (error: unknown) => void;
  const gateState = { settled: false };
  const promise = new Promise<void>((resolve, reject) => {
    resolveInflight = () => {
      gateState.settled = true;
      resolve();
    };
    rejectInflight = (error: unknown) => {
      gateState.settled = true;
      reject(error);
    };
  });
  promise.catch(() => {});
  return { promise, resolveInflight, rejectInflight, gateState };
}

function buildLmStudioSamplingFields(
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
    ext.repeat_penalty = options.repeatPenalty;
  }
  return ext;
}

function formatLmStudioToolCalls(
  toolCalls: Array<{
    id?: string;
    name: string;
    args?: unknown;
    thoughtSignature?: string | null;
  }>,
) {
  return toolCalls.map((toolCall) => ({
    id: toolCall.id || "",
    name: toolCall.name,
    args:
      typeof toolCall.args === "object" && toolCall.args !== null
        ? (toolCall.args as Record<string, unknown>)
        : {},
    thoughtSignature: toolCall.thoughtSignature || undefined,
  }));
}

async function lmStudioGenerateText(
  provider: LmStudioProvider,
  state: LmStudioState,
  messages: ChatMessage[],
  model: string,
  options: ProviderOptions,
): Promise<GenerateTextResult> {
  let isRequestActive = false;
  logger.provider(
    "LM Studio",
    `generateText model=${model} baseUrl=${state.baseUrl}`,
  );
  try {
    if (options.signal?.aborted) {
      throw new DOMException("The user aborted a request.", "AbortError");
    }
    await expandVideoToFrames(messages);

    const loadOpts: ProviderOptions = {
      eval_batch_size: options.evalBatchSize || LM_STUDIO_EVAL_BATCH_SIZE,
    };
    if (options.minContextLength) {
      loadOpts.context_length = options.minContextLength;
    }

    await provider.ensureModelLoaded(model, loadOpts, options.signal);

    incrementActiveRequests(state.activeRequestsCount, model);
    isRequestActive = true;

    if (options.signal?.aborted) {
      throw new DOMException("The user aborted a request.", "AbortError");
    }

    const prepared = prepareOpenAICompatMessages(
      prependIdentitySystemMessage(messages, options.systemPrompt),
      { mediaStrategy: MEDIA_STRATEGIES.IMAGES_ONLY },
    );
    const payload: Record<string, unknown> = {
      messages: prepared,
      model,
      ...buildPayloadParams(options),
      ...buildLmStudioSamplingFields(options),
      stream: false,
    };
    const tools = convertToolsToOpenAI(options.tools);
    if (tools) payload.tools = tools;
    const response = await fetchOpenAICompat(
      `${state.baseUrl}/v1/chat/completions`,
      payload,
      { signal: options.signal },
    );
    const data = (await response.json()) as OpenAICompletionResponse;
    const { text, thinking, usage, toolCalls } = processNonStreamingResponse(
      data,
      options,
    );
    const result: GenerateTextResult = {
      text,
      usage: {
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
      },
    };
    if (thinking) result.thinking = thinking;
    if (toolCalls) {
      result.toolCalls = formatLmStudioToolCalls(toolCalls);
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
      decrementActiveRequests(state.activeRequestsCount, model);
    }
  }
}

function captureLoadedInstanceConfig(
  entry: LmStudioModelEntry | undefined,
  options: ProviderOptions,
): void {
  const loadedContext = entry?.loaded_instances?.[0]?.config;
  if (
    !loadedContext ||
    typeof loadedContext !== "object" ||
    Array.isArray(loadedContext)
  ) {
    return;
  }
  const configRecord = loadedContext as Record<string, unknown>;
  if (typeof configRecord.context_length === "number") {
    options._loadedContextLength = configRecord.context_length;
  }
  if (typeof configRecord.eval_batch_size === "number") {
    options._loadedEvalBatchSize = configRecord.eval_batch_size;
  }
  if (typeof configRecord.physical_batch_size === "number") {
    options._loadedPhysicalBatchSize = configRecord.physical_batch_size;
  }
}

function computeEffectiveMaxContext(
  state: LmStudioState,
  model: string,
  entry: LmStudioModelEntry | undefined,
): { effectiveMaxContext: number; gpuCeiling: number | undefined } {
  const modelMaximumContext =
    typeof entry?.max_context_length === "number"
      ? entry.max_context_length
      : 0;
  const gpuCeiling = state.gpuConstrainedContextLength.get(model);
  const effectiveMaxContext = gpuCeiling
    ? Math.min(modelMaximumContext || Infinity, gpuCeiling)
    : modelMaximumContext;
  return { effectiveMaxContext, gpuCeiling };
}

function evaluateStreamModelReloadNeed(
  state: LmStudioState,
  model: string,
  entry: LmStudioModelEntry | undefined,
  isLoaded: boolean,
  options: ProviderOptions,
): boolean {
  const { effectiveMaxContext, gpuCeiling } = computeEffectiveMaxContext(
    state,
    model,
    entry,
  );
  const loadedCtx = (options._loadedContextLength as number) || 0;
  const alreadyAtMax =
    effectiveMaxContext > 0 && loadedCtx >= effectiveMaxContext;
  const requestedMinCtx = options.minContextLength || 0;
  const needsLargerCtx = requestedMinCtx > 0 && loadedCtx < requestedMinCtx;

  if (alreadyAtMax && needsLargerCtx) {
    logger.info(
      `[LM-Studio] Model ${model} already at max context (${options._loadedContextLength}/${effectiveMaxContext}${gpuCeiling ? ` gpu-ceiling=${gpuCeiling}` : ""}) — skipping reload (requested ${options.minContextLength})`,
    );
  }

  const isActive = (state.activeRequestsCount.get(model) || 0) > 0;
  return Boolean(
    isLoaded && loadedCtx > 0 && needsLargerCtx && !alreadyAtMax && !isActive,
  );
}

async function* unloadModelsBeforeStreamLoad(
  provider: LmStudioProvider,
  state: LmStudioState,
  model: string,
  entry: LmStudioModelEntry | undefined,
  allModels: LmStudioModelEntry[],
  needsReload: boolean,
  options: ProviderOptions,
): AsyncGenerator<StreamChunk, boolean, unknown> {
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
      await provider.unloadModel(instance.id);
    }
    return false;
  }

  for (const currentModelEntryItem of allModels) {
    if (options.signal?.aborted) return true;
    const otherModelKey = currentModelEntryItem.key;
    if ((state.activeRequestsCount.get(otherModelKey) || 0) > 0) {
      logger.warn(
        `[LM-Studio] Skipping auto-unload of active model "${otherModelKey}" because it is currently in use`,
      );
      continue;
    }
    for (const instance of currentModelEntryItem.loaded_instances || []) {
      yield {
        type: "status",
        message: "Unloading previous model…",
      };
      logger.info(`Auto-unloading ${instance.id} before loading ${model}`);
      await provider.unloadModel(instance.id);
    }
  }
  return false;
}

function buildStreamLoadOptions(
  state: LmStudioState,
  model: string,
  entry: LmStudioModelEntry | undefined,
  options: ProviderOptions,
): ProviderOptions {
  const loadOpts: ProviderOptions = {
    eval_batch_size: options.evalBatchSize || LM_STUDIO_EVAL_BATCH_SIZE,
  };
  if (options.minContextLength) {
    const maxContextLength =
      entry?.max_context_length || LM_STUDIO_DEFAULT_MAX_CONTEXT;
    const gpuCeilingForLoad = state.gpuConstrainedContextLength.get(model);
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
  return loadOpts;
}

async function* pollModelLoadWithProgress(
  provider: LmStudioProvider,
  model: string,
  loadOpts: ProviderOptions,
  signal: AbortSignal | undefined,
): AsyncGenerator<
  StreamChunk,
  { aborted: boolean; loadError: unknown },
  unknown
> {
  let loadDone = false;
  let loadError: unknown = null;
  const loadPromise = provider
    .loadModel(model, loadOpts, signal)
    .then(() => {
      loadDone = true;
    })
    .catch((error: unknown) => {
      loadDone = true;
      if ((error instanceof Error ? error.name : "") !== "AbortError") {
        loadError = error;
      }
    });

  const startTime = Date.now();
  const EXPECTED_LOAD_MS = 15000;
  let lastPercentage = 0;
  while (!loadDone) {
    await sleep(500);
    if (signal?.aborted) {
      logger.info(`[LM-Studio] Aborted during model load for ${model}`);
      provider
        .unloadModelByKey(model)
        .catch((error: unknown) =>
          logger.warn(
            `[LM-Studio] Failed to unload ${model} after abort: ${getErrorMessage(error)}`,
          ),
        );
      return { aborted: true, loadError: null };
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
  if (signal?.aborted) {
    logger.info(
      `[LM-Studio] Model ${model} loaded but benchmark aborted — unloading`,
    );
    provider
      .unloadModelByKey(model)
      .catch((error: unknown) =>
        logger.warn(
          `[LM-Studio] Failed to unload ${model} after abort: ${getErrorMessage(error)}`,
        ),
      );
    return { aborted: true, loadError: null };
  }
  return { aborted: false, loadError };
}

function buildFallbackLoadTiers(
  requestedContextLength: number,
  requestedBatchSize: number,
): Array<{ contextLength: number; batchSize: number }> {
  const rawTiers = [
    { contextLength: requestedContextLength, batchSize: 512 },
    { contextLength: 65_000, batchSize: LM_STUDIO_EVAL_BATCH_SIZE },
    { contextLength: 65_000, batchSize: 512 },
  ];
  return rawTiers
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
        ) === index &&
        tier.contextLength <= requestedContextLength &&
        !(
          tier.contextLength >= requestedContextLength &&
          tier.batchSize >= requestedBatchSize
        ),
    );
}

async function* retryModelLoadWithFallbackTiers(
  provider: LmStudioProvider,
  state: LmStudioState,
  model: string,
  loadOpts: ProviderOptions,
  options: ProviderOptions,
  initialLoadError: unknown,
): AsyncGenerator<
  StreamChunk,
  { aborted: boolean; loadError: unknown },
  unknown
> {
  if (!initialLoadError || !loadOpts.context_length) {
    return { aborted: false, loadError: initialLoadError };
  }
  let loadError: unknown = initialLoadError;
  const requestedContextLength = loadOpts.context_length;
  const requestedBatchSize =
    loadOpts.eval_batch_size || LM_STUDIO_EVAL_BATCH_SIZE;
  const fallbackTiers = buildFallbackLoadTiers(
    requestedContextLength,
    requestedBatchSize,
  );

  for (const tier of fallbackTiers) {
    if (options.signal?.aborted) {
      return { aborted: true, loadError: null };
    }
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
      await provider.loadModel(model, loadOpts, options.signal);
      loadError = null;
      state.gpuConstrainedContextLength.set(model, tier.contextLength);
      logger.info(
        `[LM-Studio] Fallback load succeeded at ctx=${tier.contextLength}/batch=${tier.batchSize} — recorded as GPU ceiling`,
      );
      break;
    } catch (fallbackLoadError: unknown) {
      if (
        fallbackLoadError instanceof Error &&
        fallbackLoadError.name === "AbortError"
      ) {
        return { aborted: true, loadError: null };
      }
      logger.warn(
        `[LM-Studio] Fallback load at ctx=${tier.contextLength}/batch=${tier.batchSize} also failed: ${getErrorMessage(fallbackLoadError)}`,
      );
    }
  }
  return { aborted: false, loadError };
}

async function refreshLoadedModelMetricsAfterLoad(
  provider: LmStudioProvider,
  state: LmStudioState,
  model: string,
  loadOpts: ProviderOptions,
  options: ProviderOptions,
): Promise<void> {
  try {
    const refreshedAfterLoad = await provider.listModels();
    const entryAfterLoad = (refreshedAfterLoad.models || []).find(
      (modelItem) => modelItem.key === model,
    );
    captureLoadedInstanceConfig(entryAfterLoad, options);
  } catch {
    /* ignore */
  }

  if (
    options._loadedContextLength &&
    loadOpts.context_length &&
    (options._loadedContextLength as number) < loadOpts.context_length
  ) {
    logger.info(
      `[LM-Studio] Model loaded successfully but context was silently capped from ${loadOpts.context_length} to ${options._loadedContextLength}. Recording GPU ceiling.`,
    );
    state.gpuConstrainedContextLength.set(
      model,
      options._loadedContextLength as number,
    );
  }
}

async function* performStreamModelLoadAttempt(
  provider: LmStudioProvider,
  state: LmStudioState,
  model: string,
  options: ProviderOptions,
  resolveInflight: () => void,
  rejectInflight: (error: unknown) => void,
): AsyncGenerator<
  StreamChunk,
  { done: boolean; aborted: boolean },
  unknown
> {
  const refreshed = await provider.listModels();
  if (options.signal?.aborted) return { done: true, aborted: true };

  const allModels = refreshed.models || [];
  const entry = allModels.find((modelItem) => modelItem.key === model);
  const isLoaded = (entry?.loaded_instances?.length ?? 0) > 0;
  if (isLoaded) {
    captureLoadedInstanceConfig(entry, options);
  }

  const needsReload = evaluateStreamModelReloadNeed(
    state,
    model,
    entry,
    isLoaded,
    options,
  );
  if (isLoaded && !needsReload) {
    resolveInflight();
    return { done: true, aborted: false };
  }

  const unloadAborted = yield* unloadModelsBeforeStreamLoad(
    provider,
    state,
    model,
    entry,
    allModels,
    needsReload,
    options,
  );
  if (unloadAborted || options.signal?.aborted) {
    return { done: true, aborted: true };
  }

  logger.info(`Auto-loading model ${model} for streaming`);
  yield {
    type: "status",
    message: "Loading model… 0%",
    phase: "loading",
  };
  const loadOpts = buildStreamLoadOptions(state, model, entry, options);
  const pollRes = yield* pollModelLoadWithProgress(
    provider,
    model,
    loadOpts,
    options.signal,
  );
  if (pollRes.aborted) return { done: true, aborted: true };

  const fallbackRes = yield* retryModelLoadWithFallbackTiers(
    provider,
    state,
    model,
    loadOpts,
    options,
    pollRes.loadError,
  );
  if (fallbackRes.aborted) return { done: true, aborted: true };
  if (fallbackRes.loadError) {
    rejectInflight(fallbackRes.loadError);
    throw fallbackRes.loadError;
  }

  yield {
    type: "status",
    message: "Loading model… 100%",
    phase: "loading",
  };
  await refreshLoadedModelMetricsAfterLoad(
    provider,
    state,
    model,
    loadOpts,
    options,
  );
  resolveInflight();
  return { done: true, aborted: false };
}

function isFatalModelLoadError(loadCheckError: unknown): boolean {
  const isModelLoadFailed =
    loadCheckError instanceof Error &&
    loadCheckError.cause &&
    typeof loadCheckError.cause === "object" &&
    "type" in loadCheckError.cause &&
    (loadCheckError.cause as { type?: unknown }).type === "model_load_failed";
  const msg = getErrorMessage(loadCheckError) || "";
  return Boolean(
    isModelLoadFailed ||
      msg.includes("Failed to load") ||
      msg.includes("API error"),
  );
}

async function* ensureStreamModelReady(
  provider: LmStudioProvider,
  state: LmStudioState,
  model: string,
  options: ProviderOptions,
): AsyncGenerator<
  StreamChunk,
  { aborted: boolean; requestActive: boolean },
  unknown
> {
  try {
    while (true) {
      if (options.signal?.aborted) {
        return { aborted: true, requestActive: false };
      }
      if (state.loadInflight.has(model)) {
        logger.info(
          `[LM-Studio:${state.instanceId}] Model "${model}" already loading (singleflight) — waiting…`,
        );
        yield {
          type: "status",
          message: "Waiting for model load…",
          phase: "loading",
        };
        try {
          await state.loadInflight.get(model);
        } catch {
          /* ignore load failures of other workers */
        }
        continue;
      }

      const gate = createInflightGate();
      state.loadInflight.set(model, gate.promise);
      try {
        const res = yield* performStreamModelLoadAttempt(
          provider,
          state,
          model,
          options,
          gate.resolveInflight,
          gate.rejectInflight,
        );
        if (res.aborted) return { aborted: true, requestActive: false };
        if (res.done) break;
      } catch (error) {
        gate.rejectInflight(error);
        throw error;
      } finally {
        if (!gate.gateState.settled) {
          gate.rejectInflight(new Error("Load aborted or cancelled"));
        }
        state.loadInflight.delete(model);
      }
    }

    incrementActiveRequests(state.activeRequestsCount, model);
    return { aborted: false, requestActive: true };
  } catch (loadCheckError: unknown) {
    if (isFatalModelLoadError(loadCheckError)) {
      throw loadCheckError;
    }
    logger.warn(
      `Could not check/load model before streaming: ${getErrorMessage(loadCheckError)}`,
    );
    return { aborted: false, requestActive: false };
  }
}

function buildNativeChatBasePayload(
  prepared: PreparedMessage[],
  model: string,
  options: ProviderOptions,
): { nativePayload: Record<string, unknown>; useReasoning: string | null } {
  const nativePayload: Record<string, unknown> = {
    model,
    input: buildNativeInput(prepared),
    stream: true,
    store: false,
  };
  const systemMessage = prepared.find((message) => message.role === "system");
  if (systemMessage?.content) {
    nativePayload.system_prompt = systemMessage.content;
  }
  const params = buildPayloadParams(options) as Record<string, unknown>;
  if (params.temperature != null) {
    nativePayload.temperature = params.temperature;
  }
  if (params.max_tokens) {
    nativePayload.max_output_tokens = params.max_tokens;
  }
  if (params.seed != null) {
    nativePayload.seed = params.seed;
  }
  Object.assign(nativePayload, buildLmStudioSamplingFields(options));

  let useReasoning: string | null = null;
  if (options.thinkingEnabled === false) {
    useReasoning = "off";
  } else if (options.thinkingEnabled === true) {
    useReasoning = "on";
  }
  if (useReasoning) {
    nativePayload.reasoning = useReasoning;
  }
  return { nativePayload, useReasoning };
}

async function* attachNativeMcpToolsIfNeeded(
  nativePayload: Record<string, unknown>,
  options: ProviderOptions,
  mcpServerUrl: string,
): AsyncGenerator<StreamChunk, void, unknown> {
  if (!options.tools || options.tools.length === 0) return;
  let toolNames = options.tools.map((tool) => tool.name);
  const contextLength =
    options._loadedContextLength || options.contextLength || 8192;
  const maxTools = Math.max(1, Math.floor((contextLength * 0.5) / 500));

  if (contextLength < 4096) {
    logger.warn(
      `[LM-Studio] Context (${contextLength}) too small for MCP tools. Minimum 4096 recommended. Skipping tools.`,
    );
    yield `⚠️ **Context too small for function calling.** Loaded context is ${contextLength} tokens — each tool requires ~500 tokens. Increase model context to at least **4,096** (8,192+ recommended) to use tools.`;
    return;
  }

  if (toolNames.length > maxTools) {
    logger.warn(
      `[LM-Studio] Tool count (${toolNames.length}) exceeds safe limit for ctx=${contextLength}. Capping at ${maxTools}.`,
    );
    toolNames = toolNames.slice(0, maxTools);
    yield {
      type: "status",
      message: `Context limit (${contextLength}) — using ${maxTools} of ${options.tools.length} tools`,
    };
  }

  const userParam = options.username
    ? `&username=${encodeURIComponent(String(options.username))}`
    : "";
  nativePayload.integrations = [
    {
      type: "ephemeral_mcp",
      server_label: "tools",
      server_url: `${mcpServerUrl}/mcp/sse?project=${encodeURIComponent(options.project || DEFAULT_PROJECT)}&agent=${encodeURIComponent(options.agent || AGENT_IDS.CODING)}${userParam}`,
      allowed_tools: toolNames,
    },
  ];
  logger.info(
    `[LM-Studio] MCP integration: ${toolNames.length} tools via ${mcpServerUrl}/mcp/sse`,
  );
}

async function sendNativeChatRequestWithFallback(
  baseUrl: string,
  model: string,
  nativePayload: Record<string, unknown>,
  useReasoning: string | null,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const makeRequest = async (payload: Record<string, unknown>) => {
    const payloadString = JSON.stringify(payload, null, 2);
    const inputShape = Array.isArray(payload.input)
      ? `array[${payload.input.length}]: ${payload.input.map((record: Record<string, unknown>) => record.type).join(", ")}`
      : `string[${((payload.input || "") as string).length}]`;
    logger.info(
      `[LM-Studio] Native API: reasoning=${payload.reasoning || "default"}, tools=${payload.integrations ? "mcp" : "none"}, input=${inputShape}, ${payloadString.length} chars`,
    );
    return fetch(`${baseUrl}/api/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      dispatcher: STREAMING_DISPATCHER,
      ...(signal && { signal }),
    } as RequestInit & { dispatcher: typeof STREAMING_DISPATCHER });
  };

  let nativeResponse = await makeRequest(nativePayload);
  if (!nativeResponse.ok && useReasoning) {
    const errorText = await nativeResponse.text();
    if (
      nativeResponse.status === 400 &&
      (errorText.includes("reasoning") || errorText.includes("does not expose"))
    ) {
      logger.warn(
        `[LM-Studio] Model ${model} does not support reasoning config, retrying without it`,
      );
      delete nativePayload.reasoning;
      nativeResponse = await makeRequest(nativePayload);
    } else {
      throw new Error(`API error: ${nativeResponse.status} ${errorText}`);
    }
  }
  if (!nativeResponse.ok) {
    const errorText = await nativeResponse.text();
    throw new Error(`API error: ${nativeResponse.status} ${errorText}`);
  }
  return nativeResponse;
}

function normalizeLmStudioStreamChunk(chunk: unknown): StreamChunk {
  if (typeof chunk !== "object" || chunk === null) {
    return chunk as StreamChunk;
  }
  const typed = chunk as StreamChunk & {
    type?: string;
    id?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      tokensPerSec?: number;
    };
  };
  if (typed.type === "usage" && typed.usage) {
    return {
      type: "usage",
      usage: {
        inputTokens: typed.usage.inputTokens || 0,
        outputTokens: typed.usage.outputTokens || 0,
        ...(typed.usage.tokensPerSec != null && {
          tokensPerSec: typed.usage.tokensPerSec,
        }),
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

function buildLmStudioStreamDiagnosticError(
  error: unknown,
  instanceId: string,
  model: string,
): ProviderError {
  const rawMessage = getErrorMessage(error);
  const errorCode =
    (error instanceof Error && (error as NodeJS.ErrnoException).code) || null;
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
  return new ProviderError(
    PROVIDERS.LM_STUDIO,
    diagnosticParts.join(", "),
    500,
    error,
  );
}

function messagesContainVideo(messages: ChatMessage[]): boolean {
  return messages.some((messageItem: ChatMessage) => {
    const message = messageItem as unknown as Record<string, unknown>;
    return (
      "video" in message &&
      Array.isArray(message.video) &&
      message.video.length > 0
    );
  });
}

async function* lmStudioGenerateTextStream(
  provider: LmStudioProvider,
  state: LmStudioState,
  messages: ChatMessage[],
  model: string,
  options: ProviderOptions,
): AsyncGenerator<StreamChunk, void, unknown> {
  let isRequestActive = false;
  logger.provider(
    "LM Studio",
    `generateTextStream model=${model} baseUrl=${state.baseUrl}`,
  );
  try {
    const readyRes = yield* ensureStreamModelReady(
      provider,
      state,
      model,
      options,
    );
    isRequestActive = readyRes.requestActive;
    if (readyRes.aborted || options.signal?.aborted) return;

    if (messagesContainVideo(messages)) {
      yield { type: "status", message: "Extracting video frames…" };
      await expandVideoToFrames(messages);
    }
    const prepared = prepareOpenAICompatMessages(
      prependIdentitySystemMessage(messages, options.systemPrompt),
      { mediaStrategy: MEDIA_STRATEGIES.IMAGES_ONLY },
    );

    const orchestratorSet = new Set(ORCHESTRATOR_ONLY_TOOLS);
    const hasOrchestratorTools = options.tools?.some((tool) =>
      orchestratorSet.has(tool.name),
    );
    if (options.agent || hasOrchestratorTools) {
      yield* provider._streamOpenAICompat(
        prepared,
        model,
        options,
        state.baseUrl,
      );
      return;
    }

    const { nativePayload, useReasoning } = buildNativeChatBasePayload(
      prepared,
      model,
      options,
    );
    yield* attachNativeMcpToolsIfNeeded(
      nativePayload,
      options,
      state.mcpServerUrl,
    );

    const nativeResponse = await sendNativeChatRequestWithFallback(
      state.baseUrl,
      model,
      nativePayload,
      useReasoning,
      options.signal,
    );
    if (!nativeResponse.body) throw new Error("No response body");
    const nativeReader = nativeResponse.body.getReader();
    for await (const chunk of parseNativeSSEStream(nativeReader, {
      signal: options.signal,
    })) {
      yield normalizeLmStudioStreamChunk(chunk);
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") return;
    if (error instanceof ProviderError) throw error;
    throw buildLmStudioStreamDiagnosticError(error, state.instanceId, model);
  } finally {
    if (isRequestActive) {
      decrementActiveRequests(state.activeRequestsCount, model);
    }
  }
}

function capOpenAICompatTools(options: ProviderOptions) {
  const tools = convertToolsToOpenAI(options.tools);
  if (!tools) return undefined;
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
    return tools.slice(0, maxTools);
  }
  return tools;
}

async function* lmStudioStreamOpenAICompat(
  prepared: PreparedMessage[],
  model: string,
  options: ProviderOptions,
  baseUrl: string,
): AsyncGenerator<StreamChunk, void, unknown> {
  const payload: Record<string, unknown> = {
    messages: prepared,
    model,
    ...buildPayloadParams(options),
    ...buildLmStudioSamplingFields(options),
    stream: true,
    stream_options: { include_usage: true },
  };
  const cappedTools = capOpenAICompatTools(options);
  if (cappedTools) {
    payload.tools = cappedTools;
  }
  logger.info(
    `[LM-Studio] OpenAI-compat streaming (agentic): model=${model}, tools=${(payload.tools as unknown[] | undefined)?.length || 0}/${options.tools?.length || 0}, ctx=${options._loadedContextLength || "unset"}`,
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
    yield normalizeLmStudioStreamChunk(chunk);
  }
}

async function lmStudioGenerateEmbedding(
  baseUrl: string,
  content: unknown,
  model: string,
  options: ProviderOptions,
) {
  logger.provider(
    "LM Studio",
    `generateEmbedding model=${model} baseUrl=${baseUrl}`,
  );
  try {
    const payload: Record<string, unknown> = { model, input: content };
    if (options.dimensions) payload.dimensions = options.dimensions;
    const response = await fetchOpenAICompat(
      `${baseUrl}/v1/embeddings`,
      payload,
    );
    const data = (await response.json()) as Record<string, unknown>;
    const embedding = data.data as Array<Record<string, unknown>> | undefined;
    const firstEmbedding = embedding?.[0]?.embedding as number[] | undefined;
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
}

async function lmStudioCaptionImage(
  baseUrl: string,
  images: string[],
  prompt: string,
  model: string,
  systemPrompt?: string,
): Promise<{
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}> {
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
    const data = (await response.json()) as Record<string, unknown>;
    const choices = data.choices as
      | Array<Record<string, unknown>>
      | undefined;
    const firstMsg = choices?.[0]?.message as
      | Record<string, unknown>
      | undefined;
    const textContent = (firstMsg?.content as string) || "";
    const rawUsage = data.usage as Record<string, number> | undefined;
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
}

async function unloadOtherLoadedModelsForEnsure(
  provider: LmStudioProvider,
  state: LmStudioState,
  ensureModels: LmStudioModelEntry[],
  modelKey: string,
  signal?: AbortSignal,
  onStatus?: (message: string) => void,
): Promise<boolean> {
  for (const currentModelEntry of ensureModels) {
    if (signal?.aborted) return true;
    const otherModelKey = currentModelEntry.key as string;
    if ((state.activeRequestsCount.get(otherModelKey) || 0) > 0) {
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
        await provider.unloadModel(instance.id);
      } catch (error: unknown) {
        logger.warn(
          `Failed to unload instance ${instance.id}: ${getErrorMessage(error)}`,
        );
      }
    }
  }
  return Boolean(signal?.aborted);
}

function capEnsureLoadContextLength(
  state: LmStudioState,
  modelKey: string,
  loadOptions: ProviderOptions,
): void {
  if (typeof loadOptions.context_length !== "number") return;
  const gpuCeiling = state.gpuConstrainedContextLength.get(modelKey);
  if (gpuCeiling && loadOptions.context_length > gpuCeiling) {
    logger.info(
      `[LM-Studio] ensureModelLoaded: capping context_length from ${loadOptions.context_length} to GPU ceiling ${gpuCeiling}`,
    );
    loadOptions.context_length = gpuCeiling;
  }
}

async function performEnsureModelLoad(
  provider: LmStudioProvider,
  state: LmStudioState,
  ensureModels: LmStudioModelEntry[],
  modelKey: string,
  loadOptions: ProviderOptions,
  signal: AbortSignal | undefined,
  onStatus: ((message: string) => void) | undefined,
  resolveInflight: () => void,
): Promise<EnsureModelLoadedResult> {
  const aborted = await unloadOtherLoadedModelsForEnsure(
    provider,
    state,
    ensureModels,
    modelKey,
    signal,
    onStatus,
  );
  if (aborted) return { alreadyLoaded: false, contextLength: null };

  capEnsureLoadContextLength(state, modelKey, loadOptions);

  logger.info(`[LM-Studio] Loading model ${modelKey}`);
  onStatus?.("Loading model… 0%");
  await provider.loadModel(modelKey, loadOptions, signal);
  onStatus?.("Loading model… 100%");

  const refreshed = await provider.listModels();
  const entry = (refreshed.models || []).find(
    (modelItem) => modelItem.key === modelKey,
  );
  const contextLength =
    entry?.loaded_instances?.[0]?.config?.context_length || null;

  if (
    contextLength &&
    typeof loadOptions.context_length === "number" &&
    contextLength < loadOptions.context_length
  ) {
    logger.info(
      `[LM-Studio] ensureModelLoaded: context silently capped from ${loadOptions.context_length} to ${contextLength}. Recording GPU ceiling.`,
    );
    state.gpuConstrainedContextLength.set(modelKey, contextLength);
  }

  resolveInflight();
  return { alreadyLoaded: false, contextLength };
}

async function lmStudioEnsureModelLoaded(
  provider: LmStudioProvider,
  state: LmStudioState,
  modelKey: string,
  loadOptions: ProviderOptions = {},
  signal?: AbortSignal,
  onStatus?: (message: string) => void,
): Promise<EnsureModelLoadedResult> {
  while (!signal?.aborted) {
    if (state.loadInflight.has(modelKey)) {
      logger.info(
        `[LM-Studio:${state.instanceId}] ensureModelLoaded("${modelKey}") — waiting on inflight load…`,
      );
      onStatus?.("Waiting for model load…");
      try {
        await state.loadInflight.get(modelKey);
      } catch {
        // Ignore, we'll recheck status
      }
      continue;
    }

    const { models: ensureModels } = await provider.listModels();
    if (signal?.aborted) return { alreadyLoaded: false, contextLength: null };

    const modelEntry = (ensureModels || []).find(
      (modelItem) => modelItem.key === modelKey,
    );
    const isLoaded = (modelEntry?.loaded_instances?.length ?? 0) > 0;
    if (isLoaded) {
      const loadedContextValue =
        modelEntry?.loaded_instances?.[0]?.config?.context_length || null;
      logger.info(
        `[LM-Studio] Model ${modelKey} already loaded (ctx=${loadedContextValue})`,
      );
      return { alreadyLoaded: true, contextLength: loadedContextValue };
    }

    if (state.loadInflight.has(modelKey)) continue;

    const gate = createInflightGate();
    state.loadInflight.set(modelKey, gate.promise);
    try {
      return await performEnsureModelLoad(
        provider,
        state,
        ensureModels || [],
        modelKey,
        loadOptions,
        signal,
        onStatus,
        gate.resolveInflight,
      );
    } catch (error) {
      gate.rejectInflight(error);
      throw error;
    } finally {
      if (!gate.gateState.settled) {
        gate.rejectInflight(new Error("Load aborted or cancelled"));
      }
      state.loadInflight.delete(modelKey);
    }
  }
  return { alreadyLoaded: false, contextLength: null };
}

function enrichRawLmStudioModelEntry(model: Record<string, unknown>): void {
  const arch = (model.architecture as string | undefined) ?? null;
  const params = (model.params_string as string | undefined) ?? null;
  const sizeBytes = (model.size_bytes as number) || 0;
  const quantObj = model.quantization as Record<string, unknown> | undefined;
  const bitsPerWeight = (quantObj?.bits_per_weight as number) || 4;
  model.archParams = resolveArchParams(arch, params, sizeBytes, bitsPerWeight);
  if (!model.key) model.key = String(model.id || "");
  if (!model.display_name) {
    model.display_name = String(model.display_name || model.id || "");
  }
  if (!model.type) model.type = "llm";
}

async function lmStudioListModels(baseUrl: string): Promise<ListModelsResult> {
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
    const data = (await response.json()) as Record<string, unknown>;
    const rawModels = (data.models || data.data || []) as Array<
      Record<string, unknown>
    >;
    for (const model of rawModels) {
      enrichRawLmStudioModelEntry(model);
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
}

function buildLmStudioLoadPayload(
  model: string,
  options: ProviderOptions,
): LmStudioLoadConfig {
  const payload: LmStudioLoadConfig = { model };
  if (options.context_length != null) {
    payload.context_length = options.context_length;
  }
  if (options.flash_attention != null) {
    payload.flash_attention = options.flash_attention;
  }
  if (options.offload_kv_cache_to_gpu != null) {
    payload.offload_kv_cache_to_gpu = options.offload_kv_cache_to_gpu;
  }
  if (options.eval_batch_size != null) {
    payload.eval_batch_size = options.eval_batch_size;
  }
  if (options.parallel != null) {
    payload.parallel = options.parallel;
  }
  if (options.unified_kv_cache != null) {
    payload.unified_kv_cache = options.unified_kv_cache;
  }
  return payload;
}

async function executeLmStudioLoadModelRequest(
  baseUrl: string,
  model: string,
  options: ProviderOptions,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const payload = buildLmStudioLoadPayload(model, options);
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
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      PROVIDERS.LM_STUDIO,
      getErrorMessage(error),
      500,
      error,
    );
  }
}

async function lmStudioLoadModel(
  state: LmStudioState,
  model: string,
  options: ProviderOptions = {},
  signal?: AbortSignal,
): Promise<void> {
  if (state.loadModelInflight.has(model)) {
    logger.info(
      `[LM-Studio:${state.instanceId}] loadModel("${model}") — singleflight: already loading, waiting…`,
    );
    return state.loadModelInflight.get(model);
  }

  logger.provider("LM Studio", `loadModel model=${model}`);
  const loadWork = executeLmStudioLoadModelRequest(
    state.baseUrl,
    model,
    options,
    signal,
  );
  state.loadModelInflight.set(model, loadWork);
  try {
    return await loadWork;
  } finally {
    state.loadModelInflight.delete(model);
  }
}

async function lmStudioUnloadModelByKey(
  provider: LmStudioProvider,
  modelKey: string,
): Promise<void> {
  try {
    const { models } = await provider.listModels();
    for (const modelEntry of models || []) {
      if (modelEntry.key !== modelKey) continue;
      for (const instance of modelEntry.loaded_instances || []) {
        logger.info(
          `[LM-Studio] Unloading ${instance.id} (cleanup after abort)`,
        );
        await provider.unloadModel(instance.id);
      }
    }
  } catch (error: unknown) {
    logger.warn(
      `[LM-Studio] unloadModelByKey(${modelKey}) failed: ${getErrorMessage(error)}`,
    );
  }
}

async function lmStudioUnloadModel(
  baseUrl: string,
  instanceId: string,
): Promise<void> {
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
}

export function createLmStudioProvider(
  baseUrl: string,
  instanceId: string = PROVIDERS.LM_STUDIO,
): LmStudioProvider {
  const state: LmStudioState = {
    baseUrl,
    instanceId,
    mcpServerUrl: DEFAULT_MCP_SERVER_URL,
    loadInflight: new Map<string, Promise<void>>(),
    loadModelInflight: new Map<string, Promise<void>>(),
    activeRequestsCount: new Map<string, number>(),
    gpuConstrainedContextLength: new Map<string, number>(),
  };

  const provider: LmStudioProvider = {
    name: instanceId,
    generateText(
      messages: ChatMessage[],
      model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)[
        PROVIDERS.LM_STUDIO
      ],
      options: ProviderOptions = {},
    ): Promise<GenerateTextResult> {
      return lmStudioGenerateText(this, state, messages, model, options);
    },
    generateTextStream(
      messages: ChatMessage[],
      model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)[
        PROVIDERS.LM_STUDIO
      ],
      options: ProviderOptions = {},
    ): AsyncGenerator<StreamChunk, void, unknown> {
      return lmStudioGenerateTextStream(this, state, messages, model, options);
    },
    _streamOpenAICompat(
      prepared: PreparedMessage[],
      model: string,
      options: ProviderOptions,
      targetBaseUrl: string,
    ): AsyncGenerator<StreamChunk, void, unknown> {
      return lmStudioStreamOpenAICompat(prepared, model, options, targetBaseUrl);
    },
    generateEmbedding(
      content: unknown,
      model: string,
      options: ProviderOptions = {},
    ) {
      return lmStudioGenerateEmbedding(state.baseUrl, content, model, options);
    },
    captionImage(
      images: string[],
      prompt: string = "Describe this image.",
      model: string = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)[
        PROVIDERS.LM_STUDIO
      ],
      systemPrompt?: string,
    ) {
      return lmStudioCaptionImage(
        state.baseUrl,
        images,
        prompt,
        model,
        systemPrompt,
      );
    },
    ensureModelLoaded(
      modelKey: string,
      loadOptions: ProviderOptions = {},
      signal?: AbortSignal,
      onStatus?: (message: string) => void,
    ) {
      return lmStudioEnsureModelLoaded(
        this,
        state,
        modelKey,
        loadOptions,
        signal,
        onStatus,
      );
    },
    listModels() {
      return lmStudioListModels(state.baseUrl);
    },
    loadModel(
      model: string,
      options: ProviderOptions = {},
      signal?: AbortSignal,
    ) {
      return lmStudioLoadModel(state, model, options, signal);
    },
    unloadModelByKey(modelKey: string) {
      return lmStudioUnloadModelByKey(this, modelKey);
    },
    unloadModel(targetInstanceId: string) {
      return lmStudioUnloadModel(state.baseUrl, targetInstanceId);
    },
  };
  return provider;
}
