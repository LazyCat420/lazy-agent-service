/**
 * Shared utilities for function calling (FC) message expansion.
 *
 * Both HomePage.js and ConsoleComponent.js need to expand assistant messages
 * with toolCalls into the [assistant(tool_calls), tool(result), ...] format
 * expected by the OpenAI Chat Completions spec. This module centralises that
 * logic to avoid duplication.
 */

import type { ChatMessage, ToolCallEntry } from "../types/admin.ts";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { fitForPrism } from "../services/ModelVisibleToolResult.ts";

// ── Array keys whose entries get capped during truncation ─────
const TRUNCATABLE_ARRAY_KEYS = [
  "events",
  "products",
  "trends",
  "articles",
  "earnings",
  "predictions",
  "commodities",
];

function isTruncatableResult(
  value: unknown,
): value is object | string | number | boolean | null | undefined {
  return typeof value !== "function" && typeof value !== "symbol";
}

/**
 * Truncate a tool result to avoid blowing up the model's context window.
 * Caps arrays at 10 items and bounds the serialized JSON at ~maxChars
 * (prism's per-result semantics, ch.06 item 7). The cut is prism's, not a
 * byte slice: oversized strings become a line-aligned preview and oversized
 * JSON is shortened to valid JSON that fits — never `serialized.slice(0,
 * maxChars) + "…}"`, which shipped invalid JSON to OpenAI-compatible
 * providers. The full result is still stored in the DB and shown in the UI;
 * this only affects what gets re-sent to the model.
 */
export function truncateToolResult(
  result: object | string | number | boolean | null | undefined,
  maxChars = 8000,
): object | string | number | boolean | null | undefined {
  if (typeof result === "string") {
    if (result.length <= maxChars) return result;
    return fitForPrism(result, maxChars).text;
  }
  if (!result || typeof result !== "object") return result;

  // Also handle top-level arrays (e.g. tides, earthquakes)
  if (Array.isArray(result) && result.length > 10) {
    const sliced = result.slice(0, 10);
    sliced.push({ _truncated: `Showing 10 of ${result.length}` });
    const serialized = JSON.stringify(sliced);
    return serialized.length > maxChars
      ? fitForPrism(serialized, maxChars).text
      : sliced;
  }

  // If result has a known array wrapper, cap items at 10
  const resultRecord = result as Record<string, unknown>;
  const trimmed = { ...resultRecord };
  for (const key of TRUNCATABLE_ARRAY_KEYS) {
    const items = trimmed[key];
    if (Array.isArray(items) && items.length > 10) {
      const total = items.length;
      trimmed[key] = items.slice(0, 10);
      trimmed[`_${key}Truncated`] = `Showing 10 of ${total}`;
    }
  }

  const serialized = JSON.stringify(trimmed);
  if (serialized.length <= maxChars) return trimmed;
  return fitForPrism(serialized, maxChars).text;
}

interface ExpandOptions {
  filterDeleted?: boolean;
}

interface ExpandedToolCall {
  id?: string | null;
  name: string;
  args?: unknown;
  responsesItemId?: string;
  thoughtSignature?: string;
  reasoningItem?: {
    id: string;
    summary: Array<{ type: string; text: string }>;
  };
}

interface ExpandedMessage {
  role: string;
  content?: string | unknown | null;
  name?: string;
  tool_call_id?: string | null;
  thinking?: string;
  thinkingSignature?: string;
  reasoning_content?: string;
  toolCalls?: ExpandedToolCall[];
  images?: string[];
  video?: string[];
  audio?: string | string[];
  pdf?: string[];
}

function shouldKeepExpandedMessage(messageItem: ChatMessage): boolean {
  if (messageItem.deleted) return false;
  if (messageItem.role !== "assistant") return true;
  return Boolean(
    messageItem.content?.toString().trim() || messageItem.toolCalls?.length,
  );
}

function mapExpandedToolCallEntry(toolCall: ToolCallEntry) {
  return {
    id: toolCall.id,
    name: toolCall.name,
    args: toolCall.args,
    ...(toolCall.responsesItemId
      ? { responsesItemId: toolCall.responsesItemId }
      : {}),
    ...(toolCall.thoughtSignature
      ? { thoughtSignature: toolCall.thoughtSignature }
      : {}),
    ...(toolCall.reasoningItem
      ? { reasoningItem: toolCall.reasoningItem }
      : {}),
  };
}

function stripSubAgentMessagesFromResult(result: unknown): unknown {
  if (!Array.isArray(result)) return result;
  return result.map((subAgentResult) => {
    if (subAgentResult && typeof subAgentResult === "object") {
      const { messages: _messages, ...rest } = subAgentResult;
      return rest;
    }
    return subAgentResult;
  });
}

function formatExpandedToolResultMessage(
  toolCall: ToolCallEntry,
): ExpandedMessage {
  let finalResult = toolCall.result;
  if (
    toolCall.name === TOOL_NAMES.CREATE_SUBAGENT ||
    toolCall.name === "team_create"
  ) {
    finalResult = stripSubAgentMessagesFromResult(toolCall.result);
  }

  const truncatableResult = isTruncatableResult(finalResult)
    ? finalResult
    : undefined;

  const serializedContent =
    typeof finalResult === "string"
      ? finalResult.length > 8000
        ? fitForPrism(finalResult).text
        : finalResult
      : JSON.stringify(truncateToolResult(truncatableResult));

  return {
    role: "tool",
    name: toolCall.name,
    tool_call_id: toolCall.id,
    content: serializedContent,
  };
}

function expandAssistantToolCallMessage(
  message: ChatMessage,
): ExpandedMessage[] {
  const msgWithReasoning = message as ChatMessage & {
    reasoning_content?: string;
  };
  const reasoning = msgWithReasoning.reasoning_content || message.thinking;
  const toolCalls = message.toolCalls || [];
  const assistantMessage: ExpandedMessage = {
    role: "assistant",
    content: message.content?.toString().trim() || null,
    ...(message.thinking && { thinking: message.thinking }),
    ...(reasoning && { reasoning_content: reasoning }),
    ...(message.thinkingSignature && {
      thinkingSignature: message.thinkingSignature,
    }),
    toolCalls: toolCalls.map(mapExpandedToolCallEntry),
  };
  const toolMessages = toolCalls
    .filter((toolCall: ToolCallEntry) => toolCall.result !== undefined)
    .map(formatExpandedToolResultMessage);
  return [assistantMessage, ...toolMessages];
}

function hasNonEmptyMediaField(media: unknown): boolean {
  if (!media) return false;
  return Array.isArray(media) ? media.length > 0 : Boolean(media);
}

function attachStandardMessageMedia(
  target: ExpandedMessage,
  message: ChatMessage,
): void {
  if (hasNonEmptyMediaField(message.images)) target.images = message.images;
  if (hasNonEmptyMediaField(message.video)) target.video = message.video;
  if (hasNonEmptyMediaField(message.audio)) target.audio = message.audio;
  if (hasNonEmptyMediaField(message.pdf)) target.pdf = message.pdf;
}

function attachAssistantReasoningFields(
  target: ExpandedMessage,
  message: ChatMessage,
): void {
  if (message.role !== "assistant") return;
  const msgWithExtras = message as ChatMessage & {
    reasoning_content?: string;
    thinkingSignature?: string;
  };
  if (message.thinking) {
    target.thinking = message.thinking;
  }
  const reasoning = msgWithExtras.reasoning_content || message.thinking;
  if (reasoning) {
    target.reasoning_content = reasoning;
  }
  if (msgWithExtras.thinkingSignature) {
    target.thinkingSignature = msgWithExtras.thinkingSignature;
  }
}

function expandStandardMessage(message: ChatMessage): ExpandedMessage[] {
  const hasContent = Boolean(message.content?.toString().trim());
  const expanded: ExpandedMessage = {
    role: message.role,
    content: hasContent ? message.content : " ",
  };
  attachStandardMessageMedia(expanded, message);
  attachAssistantReasoningFields(expanded, message);
  return [expanded];
}

/**
 * Expand a messages array into the format expected by LLM providers for
 * function calling. Assistant messages with toolCalls are expanded into
 * [assistant(tool_calls), tool(result1), tool(result2), ...] per the
 * OpenAI Chat Completions spec.
 */
export function expandMessagesForFunctionCall(
  messages: ChatMessage[],
  { filterDeleted = true }: ExpandOptions = {},
): ExpandedMessage[] {
  const filtered = filterDeleted
    ? messages.filter(shouldKeepExpandedMessage)
    : messages;

  return filtered.flatMap((message) => {
    if (
      message.role === "assistant" &&
      message.toolCalls &&
      message.toolCalls.length > 0
    ) {
      return expandAssistantToolCallMessage(message);
    }

    if (message.role === "tool") {
      const content =
        typeof message.content === "string" && message.content.length > 8000
          ? fitForPrism(message.content).text
          : message.content;
      return [
        {
          role: "tool",
          tool_call_id: message.tool_call_id,
          name: message.name,
          content,
        },
      ];
    }

    return expandStandardMessage(message);
  });
}
