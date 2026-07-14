import logger from "../../../utils/logger.ts";
import { TOOL_NAMES } from "../../ToolTaxonomyConstants.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";

import type AgenticLoopState from "../../AgenticLoopState.ts";
import type {
  ToolCall,
  ToolResult,
  PassState,
  EmitFunction,
  AgenticContext,
} from "../types.ts";
import FileService from "../../FileService.ts";
import WebhookEventBus from "../../WebhookEventBus.ts";
import ToolOrchestratorService from "../../ToolOrchestratorService.ts";
import { FILE_CATEGORIES } from "../../../constants.ts";

interface ToolResultPayload {
  error?: string;
  screenshotRef?: string;
  audioRef?: string;
  audio?: { data: string; mimeType?: string };
  image?: { data: string; mimeType?: string; minioRef?: string };
  [key: string]: unknown;
}

/**
 * PostExecutionEmitter — status notifications emitted after tool execution.
 *
 * Checks tool calls for specific side-effect patterns (tasks, sub-agents,
 * memories, custom tools) and emits appropriate status events to the
 * frontend so the UI can refresh relevant panels.
 *
 * Extracted from ReActHarness to be reusable across harnesses.
 */

/** Emit status notifications based on which tools were executed. */
export function emitPostExecutionStatus(
  toolCalls: ToolCall[],
  emit: EmitFunction,
): void {
  if (
    toolCalls.some(
      (toolCall) =>
        // TODO(cleanup): Remove "task_" startsWith once historical sessions have aged out
        toolCall.name.includes("_task") || toolCall.name.startsWith("task_"),
    )
  ) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.TASKS_UPDATED,
    });
  }

  if (
    toolCalls.some(
      (toolCall) =>
        toolCall.name === TOOL_NAMES.CREATE_SUBAGENT ||
        // TODO(cleanup): Remove "team_create" once historical sessions have aged out
        toolCall.name === "team_create" ||
        toolCall.name === TOOL_NAMES.STOP_SUBAGENT,
    )
  ) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.SUB_AGENTS_UPDATED,
    });
  }

  if (toolCalls.some((toolCall) => toolCall.name === TOOL_NAMES.SAVE_MEMORY)) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.MEMORIES_UPDATED,
    });
  }
}

/** Process tool results for image/screenshot side-effects. */
export async function processToolResultMedia(
  toolCalls: ToolCall[],
  results: ToolResult[],
  state: AgenticLoopState,
  pass: PassState,
  emit: EmitFunction,
  context?: AgenticContext,
): Promise<void> {
  for (const toolCall of toolCalls) {
    const toolResult = results.find(
      (result) =>
        result.id === toolCall.id ||
        (!result.id && result.name === toolCall.name),
    );
    const resultObject = toolResult?.result as ToolResultPayload | null;
    const hasError = !!resultObject?.error;

    // Check if result has raw audio data, upload it if so
    const audioResult = resultObject?.audio;
    if (audioResult?.data) {
      const mimeType = audioResult.mimeType || "audio/wav";
      const dataUrl = `data:${mimeType};base64,${audioResult.data}`;
      try {
        const uploadResult = await FileService.uploadFile(
          dataUrl,
          FILE_CATEGORIES.GENERATIONS,
        );
        if (resultObject) {
          resultObject.audioRef = uploadResult.ref;
          delete resultObject.audio;
        }
        emit({
          type: SERVER_SENT_EVENT_TYPES.AUDIO,
          data: uploadResult.ref,
          mimeType,
          minioRef: uploadResult.ref,
        });
      } catch (uploadError) {
        logger.error(
          `[PostExecutionEmitter] Failed to upload audio:`,
          uploadError,
        );
      }
    }

    emit({
      type: SERVER_SENT_EVENT_TYPES.TOOL_EXECUTION,
      tool: {
        name: toolCall.name,
        args: toolCall.args || {},
        id: toolCall.id,
        responsesItemId: toolCall.responsesItemId,
        result: resultObject,
        durationMs: toolResult?.durationMs,
      },
      status: hasError ? "error" : "done",
    });

    WebhookEventBus.emit("request.tool_call.completed", {
      requestId: context?.requestId || null,
      toolName: toolCall.name,
      toolEmoji: ToolOrchestratorService.getToolEmoji(toolCall.name),
      toolCallId: toolCall.id,
      toolResult: resultObject,
      durationMs: toolResult?.durationMs || null,
      status: hasError ? "error" : "done",
      agent: context?.agent || null,
      conversationId: context?.conversationId || null,
      agentConversationId: context?.agentConversationId || null,
      project: context?.project || null,
      username: context?.username || null,
      provider: context?.providerName || null,
      model: context?.resolvedModel || null,
    });

    if (resultObject?.screenshotRef) {
      state.streamedImages.push(resultObject.screenshotRef as string);
      pass.streamedImages.push(resultObject.screenshotRef as string);
    }

    const imageResult = resultObject?.image;
    if (imageResult?.data) {
      const toolImgRef =
        imageResult.minioRef ||
        `data:${imageResult.mimeType};base64,${imageResult.data}`;
      state.streamedImages.push(toolImgRef);
      pass.streamedImages.push(toolImgRef);
      emit({
        type: SERVER_SENT_EVENT_TYPES.IMAGE,
        data: imageResult.data,
        mimeType: imageResult.mimeType,
        minioRef: imageResult.minioRef,
      });
      if (resultObject) delete resultObject.image;
    }
  }
}

/** Track consecutive tool errors and log/emit when a tool hits the limit. */
export function trackToolErrors(
  toolCalls: ToolCall[],
  results: ToolResult[],
  state: AgenticLoopState,
  maxConsecutiveErrors: number,
  emit: EmitFunction,
): void {
  for (const toolCall of toolCalls) {
    const toolResult = results.find(
      (result) =>
        result.id === toolCall.id ||
        (!result.id && result.name === toolCall.name),
    );
    const hasError = !!(toolResult?.result as ToolResultPayload)?.error;

    if (hasError) {
      const count = (state.toolErrorCounts.get(toolCall.name) || 0) + 1;
      state.toolErrorCounts.set(toolCall.name, count);
      if (count >= maxConsecutiveErrors) {
        logger.warn(
          `[AgenticLoop] Tool "${toolCall.name}" hit error limit (${count}), skipping in future iterations`,
        );
        emit({
          type: SERVER_SENT_EVENT_TYPES.STATUS,
          message: `Tool "${toolCall.name}" failed ${count} times consecutively — skipping`,
        });
      }
    } else {
      state.toolErrorCounts.delete(toolCall.name);
    }
  }
}
