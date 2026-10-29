import Anthropic from "@anthropic-ai/sdk";
import { ProviderError } from "../utils/errors.ts";
import logger from "../utils/logger.ts";
import { extractAnthropicRateLimits } from "../utils/rateLimits.ts";
import { compressImageForSizeLimit } from "../utils/media.ts";
import { EMPTY_USAGE } from "../utils/openai-compat.ts";
import { ANTHROPIC_API_KEY } from "../../config.ts";
import { TYPES, getDefaultModels, getModelByName, type ModelDefinition } from "../config.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../constants/TokenBudgetDefaults.ts";
import { sleep } from "@rodrigo-barraza/utilities-library";

import { ProviderOptions, ChatMessage } from "../types/ProviderTypes.ts";
import type { TokenUsage } from "../types/admin.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

export interface AnthropicBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  source?: { type: string; media_type?: string; data?: string; url?: string };
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicBlock[];
  citations?: Array<{
    type: string;
    url?: string;
    title?: string;
    cited_text?: string;
  }>;
  url?: string;
  title?: string;
  page_age?: string;
}

/** Typed shape for errors thrown by the Anthropic SDK. */
interface AnthropicSdkError extends Error {
  status?: number;
  type?: string;
  error?: { type?: string };
}

/** Result shape returned by generateText/captionImage. */
export interface AnthropicGenerateResult {
  text: string;
  usage: TokenUsage;
  thinking?: string | null;
  thinkingSignature?: string | null;
  citations?: Array<{ url?: string; title?: string; citedText?: string }>;
  toolCalls?: Array<{
    id?: string;
    name?: string;
    args: Record<string, unknown>;
  }>;
  rateLimits?: ReturnType<typeof extractAnthropicRateLimits>;
  stopReason?: string;
  stopDetails?: Record<string, unknown>;
}

// Default budget tokens mapped from effort level (for non-adaptive models)
const EFFORT_BUDGET_MAP: Record<string, number> = {
  low: 1024,
  medium: 4096,
  high: 50000,
  xhigh: 100000,
  max: 128000,
};

// Retry config for transient Anthropic errors (overloaded, rate limit)
const RETRY_DELAY_MS = 10_000;
const MAX_RETRIES = 3;
function isRetryableError(error: unknown): boolean {
  const errorObject = error as AnthropicSdkError;
  const errorType = errorObject?.error?.type || errorObject?.type;
  if (errorType === "overloaded_error") return true;
  if (errorObject.status === 529) return true;
  return false;
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    if (!ANTHROPIC_API_KEY) {
      throw new ProviderError("anthropic", "ANTHROPIC_API_KEY is not set", 401);
    }
    client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
  return client;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Walk all Anthropic-format message content blocks and compress any
 * base64 image that exceeds 5 MB. Mutates the messages array in-place.
 */
async function enforceImageSizeLimits(messages: ChatMessage[]) {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as AnthropicBlock[]) {
      if (block.type !== "image" || block.source?.type !== "base64") continue;
      const data = block.source.data;
      if (!data) continue;

      // Enforce byte-size limit
      const size = data.length; // Anthropic checks base64 STRING length
      if (size <= MAX_IMAGE_BYTES) continue;

      logger.warn(
        `[anthropic] SAFETY NET: image still ${(size / 1024 / 1024).toFixed(2)} MB after prepareMessages. Compressing now...`,
      );
      const result = await compressImageForSizeLimit(
        data,
        block.source.media_type || "image/png",
      );
      block.source.data = result.data;
      block.source.media_type = result.mediaType;

      const newSize = result.data.length;
      logger.info(
        `[anthropic] SAFETY NET compressed: ${(size / 1024 / 1024).toFixed(2)} → ${(newSize / 1024 / 1024).toFixed(2)} MB`,
      );
    }
  }
}

function detectImageMediaType(mimeType: string, data: string): string {
  if (data.startsWith("/9j/")) return "image/jpeg";
  if (data.startsWith("iVBOR")) return "image/png";
  if (data.startsWith("R0lG")) return "image/gif";
  if (data.startsWith("UklG")) return "image/webp";
  return mimeType;
}

async function convertDataUrlToAnthropicBlock(
  dataUrl: string,
): Promise<AnthropicBlock | null> {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const mimeType = match[1];
  const rawData = match[2];

  if (mimeType.startsWith("image/")) {
    const initialMediaType = detectImageMediaType(mimeType, rawData);
    logger.info(
      `[anthropic] Image block: ${initialMediaType}, b64_len=${rawData.length} (${(rawData.length / 1024 / 1024).toFixed(2)} MB), decoded=${(Buffer.byteLength(rawData, "base64") / 1024 / 1024).toFixed(2)} MB`,
    );
    const compressed = await compressImageForSizeLimit(
      rawData,
      initialMediaType,
    );
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: compressed.mediaType,
        data: compressed.data,
      },
    };
  }

  if (mimeType === "application/pdf") {
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: rawData,
      },
    };
  }

  if (mimeType.startsWith("text/") || mimeType === "application/json") {
    try {
      const decoded = Buffer.from(rawData, "base64").toString("utf-8");
      return {
        type: "text",
        text: `[Attached file (${mimeType})]:\n${decoded}`,
      };
    } catch {
      return null;
    }
  }

  return null;
}

async function buildAnthropicMediaMessage(message: ChatMessage) {
  const contentBlocks: AnthropicBlock[] = [];
  for (const dataUrl of message.images || []) {
    const block = await convertDataUrlToAnthropicBlock(dataUrl);
    if (block) contentBlocks.push(block);
  }
  const textContent =
    typeof message.content === "string" ? message.content : "";
  if (textContent) {
    contentBlocks.push({ type: "text", text: textContent });
  }
  return {
    role: message.role,
    content: contentBlocks.length > 0 ? contentBlocks : message.content,
  };
}

function buildAssistantToolCallsMessage(message: ChatMessage) {
  const contentBlocks: AnthropicBlock[] = [];
  if (message.thinking && message.thinkingSignature) {
    contentBlocks.push({
      type: "thinking",
      thinking: message.thinking,
      signature: message.thinkingSignature,
    });
  }
  if (typeof message.content === "string" && message.content.trim()) {
    contentBlocks.push({ type: "text", text: message.content });
  }
  for (const toolCall of message.toolCalls || []) {
    contentBlocks.push({
      type: "tool_use",
      id: toolCall.id || toolCall.name || `toolCall-${Date.now()}`,
      name: toolCall.name,
      input: (toolCall.args as Record<string, unknown>) || {},
    });
  }
  return {
    role: "assistant",
    content: contentBlocks,
  };
}

function buildAssistantThinkingOnlyMessage(message: ChatMessage) {
  const contentBlocks: AnthropicBlock[] = [];
  if (message.thinkingSignature && message.thinking) {
    contentBlocks.push({
      type: "thinking",
      thinking: message.thinking,
      signature: message.thinkingSignature,
    });
  }
  const trimmedText =
    typeof message.content === "string" ? message.content.trim() : "";
  contentBlocks.push({ type: "text", text: trimmedText || " " });
  return {
    role: "assistant",
    content: contentBlocks.length > 1 ? contentBlocks : trimmedText || " ",
  };
}

function cleanAssistantAnthropicMessage(
  message: ChatMessage,
): ChatMessage {
  if (message.toolCalls?.length) {
    return buildAssistantToolCallsMessage(message);
  }
  if (message.thinking) {
    return buildAssistantThinkingOnlyMessage(message);
  }
  const hasNonEmptyText =
    typeof message.content === "string"
      ? Boolean(message.content.trim())
      : Boolean(message.content);
  return { role: "assistant", content: hasNonEmptyText ? message.content : " " };
}

function serializeAnthropicRoleContent(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

async function cleanSingleAnthropicMessage(
  message: ChatMessage,
): Promise<ChatMessage> {
  if (message.role === "tool") {
    const toolUseId =
      message.tool_call_id || message.id || message.name || "unknown";
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: serializeAnthropicRoleContent(message.content),
        },
      ] as unknown as ChatMessage["content"],
    };
  }

  if (message.role === "system") {
    return {
      role: "user",
      content: serializeAnthropicRoleContent(message.content),
    };
  }

  if (message.images && message.images.length > 0) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      return buildAssistantToolCallsMessage(message);
    }
    return buildAnthropicMediaMessage(message);
  }

  if (message.role === "assistant") {
    return cleanAssistantAnthropicMessage(message);
  }

  return { role: message.role, content: message.content || " " };
}

function toAnthropicBlockList(content: unknown): AnthropicBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return (content as AnthropicBlock[]) || [];
}

function mergeConsecutiveSameRoleMessages(
  cleaned: ChatMessage[],
): ChatMessage[] {
  return cleaned.reduce((acc: ChatMessage[], current: ChatMessage) => {
    if (acc.length && acc[acc.length - 1].role === current.role) {
      const previous = acc[acc.length - 1];
      if (
        typeof previous.content === "string" &&
        typeof current.content === "string"
      ) {
        previous.content += `\n\n${current.content}`;
      } else {
        previous.content = [
          ...toAnthropicBlockList(previous.content),
          ...toAnthropicBlockList(current.content),
        ];
      }
    } else {
      acc.push({ ...current });
    }
    return acc;
  }, []);
}

function deduplicateUserToolResults(merged: ChatMessage[]): void {
  for (const message of merged) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const seenToolResultIds = new Set();
    message.content = (message.content as AnthropicBlock[]).filter(
      (block: AnthropicBlock) => {
        if (block.type !== "tool_result") return true;
        if (seenToolResultIds.has(block.tool_use_id)) return false;
        seenToolResultIds.add(block.tool_use_id);
        return true;
      },
    );
  }
}

function messageHasToolResult(msg: ChatMessage | undefined): boolean {
  return Boolean(
    msg?.role === "user" &&
      Array.isArray(msg.content) &&
      (msg.content as AnthropicBlock[]).some(
        (b: AnthropicBlock) => b.type === "tool_result",
      ),
  );
}

function stripOrphanedToolUseBlocks(merged: ChatMessage[]): void {
  for (let i = 0; i < merged.length; i++) {
    const message = merged[i];
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    const blocks = message.content as AnthropicBlock[];
    const hasToolUse = blocks.some((b: AnthropicBlock) => b.type === "tool_use");
    if (!hasToolUse || messageHasToolResult(merged[i + 1])) continue;

    const filtered = blocks.filter((b: AnthropicBlock) => b.type !== "tool_use");
    message.content = filtered.length > 0 ? filtered : " ";
  }
}

function trimAssistantTrailingWhitespace(merged: ChatMessage[]): void {
  for (const message of merged) {
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") {
      message.content = message.content.trimEnd() || " ";
    } else if (Array.isArray(message.content)) {
      for (const block of message.content as AnthropicBlock[]) {
        if (block.type === "text" && typeof block.text === "string") {
          block.text = block.text.trimEnd() || " ";
        }
      }
    }
  }
}

function isSupportedAnthropicRole(role: string): boolean {
  return (
    role === "user" ||
    role === "assistant" ||
    role === "tool" ||
    role === "system"
  );
}

/**
 * Anthropic requires alternating user/assistant roles and handles system messages separately.
 * This helper extracts the system message and merges consecutive same-role messages.
 */
async function prepareMessages(messages: ChatMessage[]) {
  let systemMessage: string | undefined;

  const conversation = messages.map((chatMessage: ChatMessage) => ({
    ...chatMessage,
  }));
  if (conversation.length > 0 && conversation[0].role === "system") {
    systemMessage = conversation.shift()?.content as string | undefined;
  }

  const cleaned = await Promise.all(
    conversation
      .filter((chatMessage: ChatMessage) =>
        isSupportedAnthropicRole(chatMessage.role),
      )
      .map(cleanSingleAnthropicMessage),
  );

  const merged = mergeConsecutiveSameRoleMessages(cleaned);
  deduplicateUserToolResults(merged);

  if (merged.length > 0 && merged[0].role === "assistant") {
    merged.shift();
  }

  stripOrphanedToolUseBlocks(merged);
  trimAssistantTrailingWhitespace(merged);

  return { systemMessage, messages: merged };
}
function buildTools(options: ProviderOptions) {
  const tools: Array<Record<string, unknown>> = [];
  if (options.webSearch) {
    tools.push({
      type: "web_search_20260209",
      name: "web_search",
      max_uses: 5,
    });
  }
  if (options.webFetch) {
    tools.push({
      type: "web_fetch_20250910",
      name: "web_fetch",
      max_uses: 10,
    });
  }
  if (options.codeExecution) {
    tools.push({
      type: "code_execution_20250825",
      name: "code_execution",
    });
  }
  // Custom function calling tools
  if (options.tools && Array.isArray(options.tools)) {
    for (const tool of options.tools) {
      tools.push({
        name: tool.name,
        description: tool.description || "",
        input_schema: tool.parameters || { type: "object", properties: {} },
      });
    }
  }
  return tools.length > 0 ? tools : undefined;
}
function extractResponseContent(contentBlocks: AnthropicBlock[]) {
  let text = "";
  let thinking: string | null = null;
  let thinkingSignature: string | null = null;
  const citations: Array<{ url?: string; title?: string; citedText?: string }> =
    [];
  const toolCalls: Array<{
    id?: string;
    name?: string;
    args: Record<string, unknown>;
  }> = [];

  for (const block of contentBlocks || []) {
    if (block.type === "text") {
      text += block.text || "";
      // Collect inline citations from this text block
      if (block.citations) {
        for (const cite of block.citations) {
          if (cite.type === "web_search_result_location") {
            citations.push({
              url: cite.url,
              title: cite.title,
              citedText: cite.cited_text,
            });
          }
        }
      }
    } else if (block.type === "thinking") {
      thinking = block.thinking ?? null;
      if (block.signature) thinkingSignature = block.signature;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        args: block.input || {},
      });
    }
    // server_tool_use and *_tool_result blocks are informational — skip
  }

  return { text, thinking, thinkingSignature, citations, toolCalls };
}
function buildUsage(
  responseUsage:
    | {
        input_tokens?: number | null;
        output_tokens?: number | null;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      }
    | null
    | undefined,
): TokenUsage {
  return {
    inputTokens: responseUsage?.input_tokens ?? 0,
    outputTokens: responseUsage?.output_tokens ?? 0,
    cacheReadInputTokens: responseUsage?.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: responseUsage?.cache_creation_input_tokens ?? 0,
  };
}

// ── Request payload ────────────────────────────────────────────

/**
 * Build the Messages API payload shared by generateText and generateTextStream.
 * The streaming path additionally runs enforceImageSizeLimits on its messages,
 * exactly as before.
 */
async function buildAnthropicPayload(
  messages: ChatMessage[],
  model: string,
  options: ProviderOptions,
): Promise<Record<string, unknown>> {
  const prepared = await prepareMessages(messages);
  const payload: Record<string, unknown> = {
    cache_control: { type: "ephemeral" },
    system: prepared.systemMessage,
    model,
    messages: prepared.messages,
    max_tokens: options.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS,
    temperature:
      options.temperature !== undefined ? Math.min(options.temperature, 1) : undefined,
    top_p:
      options.temperature === undefined && options.topP !== undefined
        ? options.topP
        : undefined,
    top_k: options.topK !== undefined ? options.topK : undefined,
    stop_sequences: options.stopSequences !== undefined ? options.stopSequences : undefined,
    ...(options.serviceTier && {
      service_tier:
        options.serviceTier === "standard" ? "standard_only" : options.serviceTier,
    }),
    ...(options.responseFormat === "json_object" && {
      output_config: {
        format: {
          type: "json_schema" as const,
          schema: { type: "object", additionalProperties: false },
        },
      },
    }),
  };

  // Server tools
  const tools = buildTools(options);
  if (tools) payload.tools = tools;

  const isAdaptiveThinking = applyAnthropicSamplingLocks(payload, getModelByName(model));
  applyAnthropicThinking(payload, isAdaptiveThinking, options);
  return payload;
}

/**
 * Opus 4.7+ lock sampling parameters — the API rejects non-default values.
 * Returns whether the model's thinking is inherent (adaptive).
 */
function applyAnthropicSamplingLocks(
  payload: Record<string, unknown>,
  modelDefinition: ModelDefinition | null,
): boolean {
  const hasLockedSampling =
    modelDefinition !== null &&
    "lockedSampling" in modelDefinition &&
    modelDefinition.lockedSampling === true;
  if (hasLockedSampling) {
    delete payload.temperature;
    delete payload.top_p;
    delete payload.top_k;
  }

  const isAdaptiveThinking =
    modelDefinition !== null &&
    "adaptiveThinking" in modelDefinition &&
    modelDefinition.adaptiveThinking === true;
  if (isAdaptiveThinking) delete payload.top_k;
  return isAdaptiveThinking;
}

/**
 * Adaptive thinking models (Fable 5, Mythos 5, Opus 4.7+) think by default
 * unless explicitly disabled. Legacy models (Opus 4.x, Sonnet 4.x) get manual
 * extended thinking with a budget_tokens. Anthropic requires temperature=1 and
 * top_p/top_k unset when thinking is enabled.
 */
function applyAnthropicThinking(
  payload: Record<string, unknown>,
  isAdaptiveThinking: boolean,
  options: ProviderOptions,
) {
  if (options.thinkingEnabled === false) return;

  if (isAdaptiveThinking) {
    payload.thinking = { type: "adaptive" };
    if (options.reasoningEffort) {
      // Payload fields are untyped by construction; output_config is an object when set.
      const existingOutputConfig = (payload.output_config ?? {}) as Record<string, unknown>;
      payload.output_config = { ...existingOutputConfig, effort: options.reasoningEffort };
    }
    payload.temperature = 1;
    delete payload.top_p;
    delete payload.top_k;
    return;
  }

  if (!(options.thinkingEnabled === true || options.thinkingBudget || options.reasoningEffort)) {
    return;
  }
  const budget = options.thinkingBudget
    ? parseInt(String(options.thinkingBudget))
    : (options.reasoningEffort ? EFFORT_BUDGET_MAP[options.reasoningEffort] : undefined) ||
      EFFORT_BUDGET_MAP.high;
  payload.thinking = { type: "enabled", budget_tokens: budget };
  // Built above from options.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS.
  const maxTokens = payload.max_tokens as number;
  if (maxTokens <= budget) {
    payload.max_tokens = budget + 1024;
  }
  payload.temperature = 1;
  delete payload.top_p;
  delete payload.top_k;
}

// ── Streaming event reducers ───────────────────────────────────

type AnthropicMessageStream = ReturnType<Anthropic["messages"]["stream"]>;
type AnthropicStreamYield = Record<string, unknown> | string;

interface AnthropicStreamState {
  currentBlockType: string | null;
  currentBlockName: string | null;
  currentToolUseId: string | null;
  codeInput: string;
  usage: TokenUsage | null;
  messageStartUsage: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  } | null;
  rateLimits: ReturnType<typeof extractAnthropicRateLimits> | null;
}

function createAnthropicStreamState(): AnthropicStreamState {
  return {
    currentBlockType: null,
    currentBlockName: null,
    currentToolUseId: null,
    codeInput: "",
    usage: null,
    messageStartUsage: null,
    rateLimits: null,
  };
}

/**
 * One Anthropic stream event in, the chunks to yield out. Pure with respect to
 * the stream itself: state carries the block/usage accumulators.
 */
function reduceAnthropicStreamEvent(
  state: AnthropicStreamState,
  chunk: Anthropic.MessageStreamEvent,
  stream: AnthropicMessageStream,
  model: string,
): AnthropicStreamYield[] {
  switch (chunk.type) {
    case "message_start":
      return reduceAnthropicMessageStart(state, chunk, stream, model);
    case "content_block_start":
      return reduceAnthropicBlockStart(state, chunk);
    case "content_block_stop":
      return reduceAnthropicBlockStop(state);
    case "content_block_delta":
      return reduceAnthropicBlockDelta(state, chunk);
    case "message_delta":
      return reduceAnthropicMessageDelta(state, chunk);
    default:
      return [];
  }
}

/** Capture input tokens and rate limits from message_start (sent once). */
function reduceAnthropicMessageStart(
  state: AnthropicStreamState,
  chunk: Anthropic.MessageStreamEvent & { type: "message_start" },
  stream: AnthropicMessageStream,
  model: string,
): AnthropicStreamYield[] {
  if (chunk.message?.usage) {
    state.messageStartUsage = chunk.message.usage;
    if (!state.rateLimits && stream.response) {
      state.rateLimits = extractAnthropicRateLimits(stream.response, model);
    }
  }
  return [];
}

/** Track the block kind; emit the tool-call disclosure and server tool results. */
function reduceAnthropicBlockStart(
  state: AnthropicStreamState,
  chunk: Anthropic.MessageStreamEvent & { type: "content_block_start" },
): AnthropicStreamYield[] {
  const block = chunk.content_block;
  state.currentBlockType = block?.type || null;
  state.currentBlockName = "name" in block ? block.name : null;
  state.currentToolUseId = "id" in block ? block.id : null;
  state.codeInput = "";

  const events: AnthropicStreamYield[] = [];
  if (block?.type === "tool_use" && state.currentBlockName && state.currentToolUseId) {
    events.push({
      type: "toolCallStart",
      id: state.currentToolUseId,
      name: state.currentBlockName,
    });
  }
  events.push(...reduceAnthropicBlockResult(block));
  return events;
}

/** Server tool results arrive as their own content blocks. */
function reduceAnthropicBlockResult(
  block: Anthropic.ContentBlock | undefined,
): AnthropicStreamYield[] {
  if (block?.type === "code_execution_tool_result") {
    return reduceAnthropicCodeResult(block.content);
  }
  if (
    block?.type === "web_search_tool_result" ||
    block?.type === "web_fetch_tool_result"
  ) {
    const results = extractAnthropicWebResults(block.content);
    return results ? [{ type: "webSearchResult", results }] : [];
  }
  return [];
}

function reduceAnthropicCodeResult(
  result: Anthropic.CodeExecutionToolResultBlock["content"],
): AnthropicStreamYield[] {
  if (!("stdout" in result)) return [];
  return [
    {
      type: "codeExecutionResult",
      output: result.stdout || result.stderr || "",
      outcome: result.return_code === 0 ? "OK" : "ERROR",
    },
  ];
}

/** Search/fetch result links, only when the block carries a result array. */
function extractAnthropicWebResults(
  content: unknown,
): Array<{ url: string; title: string; pageAge: string | null }> | null {
  if (!Array.isArray(content)) return null;
  const results = content
    .filter(
      (entry): entry is { url: string; title: string; page_age: string | null; type: string } =>
        entry !== null &&
        typeof entry === "object" &&
        "type" in entry &&
        (entry.type === "web_search_result" || entry.type === "web_fetch_result"),
    )
    .map((entry) => ({ url: entry.url, title: entry.title, pageAge: entry.page_age }));
  return results.length > 0 ? results : null;
}

/** A block ended: flush accumulated code / tool arguments and reset the block. */
function reduceAnthropicBlockStop(state: AnthropicStreamState): AnthropicStreamYield[] {
  const events = [
    ...reduceAnthropicCodeExecutionStop(state),
    ...reduceAnthropicToolUseStop(state),
  ];
  state.currentBlockType = null;
  state.currentBlockName = null;
  state.currentToolUseId = null;
  state.codeInput = "";
  return events;
}

/** Server code execution: parse the accumulated input JSON into a code event. */
function reduceAnthropicCodeExecutionStop(
  state: AnthropicStreamState,
): AnthropicStreamYield[] {
  if (
    state.currentBlockType !== "server_tool_use" ||
    state.currentBlockName !== "code_execution" ||
    !state.codeInput
  ) {
    return [];
  }
  try {
    // Parsed from the model's streamed JSON; shape checked before use.
    const parsed = JSON.parse(state.codeInput) as {
      code?: string;
      language?: string;
    } | null;
    return parsed?.code
      ? [
          {
            type: "executableCode",
            code: parsed.code,
            language: parsed.language || "bash",
          },
        ]
      : [];
  } catch {
    // Not valid JSON, skip
    return [];
  }
}

/** Custom tool_use block ended — emit the finalized tool call. */
function reduceAnthropicToolUseStop(
  state: AnthropicStreamState,
): AnthropicStreamYield[] {
  if (state.currentBlockType !== "tool_use") return [];
  let args: unknown = {};
  if (state.codeInput) {
    try {
      args = JSON.parse(state.codeInput);
    } catch {
      // Not valid JSON, use empty
    }
  }
  return [
    {
      type: "toolCall",
      id: state.currentToolUseId,
      name: state.currentBlockName,
      args,
    },
  ];
}

/** Thinking, signature and text deltas; input JSON accumulates for tools. */
function reduceAnthropicBlockDelta(
  state: AnthropicStreamState,
  chunk: Anthropic.MessageStreamEvent & { type: "content_block_delta" },
): AnthropicStreamYield[] {
  const delta = chunk.delta;
  if (delta.type === "thinking_delta") {
    return [{ type: "thinking", content: delta.thinking }];
  }
  if (delta.type === "signature_delta") {
    return [{ type: "thinking_signature", signature: delta.signature }];
  }
  if (delta.type === "text_delta") return [delta.text];
  if (
    delta.type === "input_json_delta" &&
    (state.currentBlockType === "server_tool_use" || state.currentBlockType === "tool_use")
  ) {
    const partial = delta.partial_json || "";
    state.codeInput += partial;
    // Progress event keeps generation throughput tracking alive during FC
    // argument streaming.
    if (state.currentBlockType === "tool_use" && partial.length > 0) {
      return [{ type: "toolCallDelta", characters: partial.length }];
    }
  }
  return [];
}

/** message_delta carries output_tokens plus stop details. */
function reduceAnthropicMessageDelta(
  state: AnthropicStreamState,
  chunk: Anthropic.MessageStreamEvent & { type: "message_delta" },
): AnthropicStreamYield[] {
  if (chunk.usage) {
    state.usage = {
      inputTokens: state.messageStartUsage?.input_tokens ?? 0,
      outputTokens: chunk.usage.output_tokens ?? 0,
      cacheReadInputTokens: state.messageStartUsage?.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: state.messageStartUsage?.cache_creation_input_tokens ?? 0,
    };
  }
  return reduceAnthropicStopDetails(chunk.delta);
}

function reduceAnthropicStopDetails(
  delta: { stop_reason?: string | null; stop_details?: unknown } | undefined,
): AnthropicStreamYield[] {
  const events: AnthropicStreamYield[] = [];
  if (delta?.stop_reason) {
    events.push({ type: "stopReason", stopReason: delta.stop_reason });
  }
  if (delta && "stop_details" in delta) {
    events.push({ type: "stopDetails", stopDetails: delta.stop_details });
  }
  return events;
}

/** Prefer the finalized message's usage; fall back to message_delta usage. */
async function resolveAnthropicStreamUsage(
  state: AnthropicStreamState,
  stream: AnthropicMessageStream,
): Promise<TokenUsage> {
  try {
    const finalMessage = await stream.finalMessage();
    if (finalMessage?.usage) return buildUsage(finalMessage.usage);
  } catch {
    // finalMessage() can throw for tool_use stop reasons — use message_delta usage
  }
  return state.usage ?? EMPTY_USAGE;
}

/**
 * Send a Messages API request, retrying overloaded/rate-limited responses with
 * the same delay and attempt policy as before.
 */
async function requestAnthropicMessage(
  request: Anthropic.MessageCreateParamsNonStreaming,
  model: string,
): Promise<AnthropicGenerateResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { data: response, response: rawResponse } = await getClient()
        .messages.create(request)
        .withResponse();
      const rateLimits = extractAnthropicRateLimits(rawResponse, model);
      const message = response as Anthropic.Messages.Message;

      const { text, thinking, thinkingSignature, citations, toolCalls } =
        extractResponseContent(message.content as AnthropicBlock[]);
      const result: AnthropicGenerateResult = {
        text,
        usage: buildUsage(message.usage),
      };
      if (thinking) result.thinking = thinking;
      if (thinkingSignature) result.thinkingSignature = thinkingSignature;
      if (citations.length > 0) result.citations = citations;
      if (toolCalls.length > 0) result.toolCalls = toolCalls;
      if (rateLimits) result.rateLimits = rateLimits;
      // Forward structured stop details for observability (SDK 0.82+)
      if (message.stop_reason) result.stopReason = message.stop_reason;
      if ("stop_details" in message && message.stop_details)
        result.stopDetails = { ...message.stop_details };
      return result;
    } catch (error: unknown) {
      lastError = error;
      if (isRetryableError(error) && attempt < MAX_RETRIES) {
        logger.warn(
          `[anthropic] Overloaded on attempt ${attempt}/${MAX_RETRIES} for generateText model=${model}. Retrying in ${RETRY_DELAY_MS / 1000}s...`,
        );
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw new ProviderError(
        "anthropic",
        getErrorMessage(error),
        (error as AnthropicSdkError)?.status || 500,
        error,
      );
    }
  }
  // Should never reach here, but safety net
  throw new ProviderError(
    "anthropic",
    lastError instanceof Error ? lastError.message : "Max retries exceeded",
    (lastError as AnthropicSdkError)?.status || 500,
    lastError,
  );
}

const anthropicProvider = {
  name: "anthropic",

  async generateText(
    messages: ChatMessage[],
    model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT).anthropic,
    options: ProviderOptions = {},
  ) {
    logger.provider("Anthropic", `generateText model=${model}`);

    const payload = await buildAnthropicPayload(messages, model, options);
    // Built above as a Messages API payload.
    const request = payload as unknown as Anthropic.MessageCreateParamsNonStreaming;

    return await requestAnthropicMessage(request, model);
  },

  async captionImage(
    images: string[],
    prompt: string = "Describe this image.",
    model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT).anthropic,
    systemPrompt?: string,
  ) {
    logger.provider("Anthropic", `captionImage model=${model}`);
    try {
      const contentBlocks: AnthropicBlock[] = [];

      for (const imageUrlOrBase64 of images) {
        const match = imageUrlOrBase64.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          let mediaType = match[1];
          let data = match[2];
          // Auto-detect media type from data prefix
          if (data.startsWith("/9j/")) mediaType = "image/jpeg";
          else if (data.startsWith("iVBOR")) mediaType = "image/png";
          else if (data.startsWith("R0lG")) mediaType = "image/gif";
          else if (data.startsWith("UklG")) mediaType = "image/webp";

          // Enforce Anthropic's 5 MB per-image limit
          const compressed = await compressImageForSizeLimit(data, mediaType);
          data = compressed.data;
          mediaType = compressed.mediaType;

          contentBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data,
            },
          });
        } else if (imageUrlOrBase64.startsWith("http")) {
          // URL-based image
          contentBlocks.push({
            type: "image",
            source: {
              type: "url",
              url: imageUrlOrBase64,
            },
          });
        }
      }

      contentBlocks.push({ type: "text", text: prompt });

      const payload: Record<string, unknown> = {
        model,
        messages: [{ role: "user", content: contentBlocks }],
        max_tokens: 1000,
      };
      if (systemPrompt) {
        payload.system = systemPrompt;
      }

      const response = (await getClient().messages.create(
        payload as unknown as Anthropic.MessageCreateParamsNonStreaming,
      )) as Anthropic.Messages.Message;

      const { text } = extractResponseContent(
        response.content as AnthropicBlock[],
      );
      return {
        text,
        usage: buildUsage(response.usage),
      };
    } catch (error: unknown) {
      throw new ProviderError(
        "anthropic",
        getErrorMessage(error),
        (error as AnthropicSdkError)?.status || 500,
        error,
      );
    }
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async *generateTextStream(
    messages: ChatMessage[],
    model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT).anthropic,
    options: ProviderOptions = {},
  ): AsyncGenerator<Record<string, unknown> | string> {
    logger.provider("Anthropic", `generateTextStream model=${model}`);
    try {
      const payload = await buildAnthropicPayload(messages, model, options);
      // Built above from prepareMessages(); enforceImageSizeLimits mutates it.
      const preparedMessages = payload.messages as ChatMessage[];
      await enforceImageSizeLimits(preparedMessages);

      // Built above as a Messages API payload.
      const request = payload as unknown as Anthropic.MessageCreateParamsNonStreaming;
      const stream = getClient().messages.stream(request, {
        ...(options.signal && { signal: options.signal }),
      });

      const state = createAnthropicStreamState();
      for await (const chunk of stream) {
        if (options.signal?.aborted) {
          stream.abort();
          break;
        }
        yield* reduceAnthropicStreamEvent(state, chunk, stream, model);
      }

      yield { type: "usage", usage: await resolveAnthropicStreamUsage(state, stream) };
      if (state.rateLimits) {
        yield { type: "rateLimits", rateLimits: state.rateLimits };
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") return;
      // For streaming, retry overloaded errors with the same delay/attempts policy
      if (isRetryableError(error)) {
        // Recursive retry with attempt tracking via options._retryAttempt
        const attempt = options._retryAttempt ?? 1;
        if (attempt < MAX_RETRIES) {
          logger.warn(
            `[anthropic] Overloaded on attempt ${attempt}/${MAX_RETRIES} for generateTextStream model=${model}. Retrying in ${RETRY_DELAY_MS / 1000}s...`,
          );
          await sleep(RETRY_DELAY_MS);
          yield* this.generateTextStream(messages, model, {
            ...options,
            _retryAttempt: attempt + 1,
          });
          return;
        }
      }
      throw new ProviderError(
        "anthropic",
        getErrorMessage(error),
        (error as AnthropicSdkError)?.status || 500,
        error,
      );
    }
  },

};

export default anthropicProvider;
