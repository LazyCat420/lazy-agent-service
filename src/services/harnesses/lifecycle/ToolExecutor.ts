import ToolOrchestratorService from "../../ToolOrchestratorService.ts";
import ToolContext from "../../ToolContext.ts";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import logger from "../../../logger.ts";

import type AgenticLoopState from "../../AgenticLoopState.ts";

function truncateResultIfNeeded(result: any, project?: string, toolName?: string): any {
  if (project === "vllm-trading-bot" && result !== undefined && result !== null) {
    const resultStr = typeof result === "string" ? result : JSON.stringify(result);
    if (resultStr.length > 50000) {
      logger.warn(`[ToolExecutor] Truncating huge tool result for ${toolName}: ${resultStr.length} chars`);
      return resultStr.slice(0, 50000) + `\n\n[TRUNCATED: result was ${resultStr.length} chars, showing first 50,000]`;
    }
  }
  return result;
}
import type AgentHooks from "../../AgentHooks.ts";
import type {
  ToolCall,
  ToolResult,
  AgenticContext,
  ResolvedTools,
} from "../types.ts";

/**
 * ToolExecutor — parallel and single tool execution extracted from
 * ReActHarness. Handles custom tools, streaming tools,
 * and standard tools-api dispatch.
 *
 * Reusable by any harness implementation.
 */

/** Execute a batch of tool calls in parallel. */
export async function executeToolBatch(
  toolCalls: ToolCall[],
  context: AgenticContext,
  tools: ResolvedTools,
  hooks: AgentHooks,
  state: AgenticLoopState,
): Promise<ToolResult[]> {
  const {
    project,
    username,
    agent,
    agentConversationId,
    conversationId,
    traceId,
    providerName,
    resolvedModel,
    workspaceRoot,
    emit,
  } = context;

  const resolvedAgentConversationId = agentConversationId || "";

  const results = await Promise.all(
    toolCalls.map(async (toolCall) => {
      await hooks.run("beforeToolCall", toolCall, context);

      if (toolCall.isUnauthorized) {
        const result = {
          success: false,
          error: "PERMISSION_DENIED",
          message: `The tool "${toolCall.name}" is not whitelisted for your agent role. You must reason using the data in the 'Pre-Collected Data Report' instead of calling unauthorized tools.`,
        };
        await hooks.run("afterToolCall", toolCall, result, context);
        return { name: toolCall.name, id: toolCall.id, result, durationMs: 0 };
      }

      if (ToolOrchestratorService.isStreamable(toolCall.name)) {
        const startTime = Date.now();
        const result = await ToolOrchestratorService.executeToolStreaming(
          toolCall.name,
          toolCall.args as Record<string, unknown>,
          (
            event: string,
            data: string | null,
            meta?: Record<string, unknown>,
          ) => {
            emit({
              type: SERVER_SENT_EVENT_TYPES.TOOL_OUTPUT,
              toolCallId: toolCall.id,
              name: toolCall.name,
              event,
              data: data || undefined,
              meta: meta || undefined,
            });
          },
          {
            project,
            username,
            agent,
            requestId: context.requestId,
            agentConversationId: resolvedAgentConversationId,
            conversationId,
            iteration: state.iterations,
            workspaceRoot,
            _toolState: ToolContext.getStore(resolvedAgentConversationId),
          },
        );
        const durationMs = Date.now() - startTime;
        await hooks.run("afterToolCall", toolCall, result, context);
        return { name: toolCall.name, id: toolCall.id, result: truncateResultIfNeeded(result, project, toolCall.name), durationMs };
      }

      const startTime = Date.now();
      const result = await ToolOrchestratorService.executeTool(
        toolCall.name,
        toolCall.args as Record<string, unknown>,
        {
          messages: context._currentMessages || context.messages,
          project,
          username,
          agent: agent || null,
          traceId: traceId || null,
          agentConversationId: resolvedAgentConversationId,
          conversationId,
          clientIp: context.clientIp || null,
          requestId: context.requestId,
          iteration: state.iterations,
          _providerName: providerName,
          _resolvedModel: resolvedModel,
          _emit: emit,
          _maxSubAgentIterations: context.options?.maxSubAgentIterations,
          _minContextLength: context.options?.minContextLength,
          workspaceRoot,
          _toolState: ToolContext.getStore(resolvedAgentConversationId),
          enabledTools: tools.finalTools.map((toolSchema) => toolSchema.name),
          _topology:
            typeof context.options?.topology === "string"
              ? context.options.topology
              : undefined,
          _recursionDepth:
            typeof context._recursionDepth === "number"
              ? context._recursionDepth
              : undefined,
          _maxRecursionDepth:
            typeof context._maxRecursionDepth === "number"
              ? context._maxRecursionDepth
              : typeof context.options?.maxRecursionDepth === "number"
                ? context.options.maxRecursionDepth
                : undefined,
          _thinkingEnabled: context.options?.thinkingEnabled,
          _reasoningEffort: context.options?.reasoningEffort,
          _thinkingBudget: context.options?.thinkingBudget,
        },
      );
      const durationMs = Date.now() - startTime;
      await hooks.run("afterToolCall", toolCall, result, context);

      if (toolCall.name === "describe_tools" && toolCall.args && Array.isArray(toolCall.args.tool_names)) {
        for (const name of toolCall.args.tool_names) {
          if (typeof name === "string") {
            const cleanName = name.replace(/^(mcp__[a-zA-Z0-9_-]+__)/, "");
            state.loadedTools.add(cleanName);
          }
        }
      }

      return { name: toolCall.name, id: toolCall.id, result: truncateResultIfNeeded(result, project, toolCall.name), durationMs };
    }),
  );

  return results;
}

/** Execute a single tool call (for one-at-a-time execution). */
export async function executeToolSingle(
  toolCall: ToolCall,
  context: AgenticContext,
  tools: ResolvedTools,
  hooks: AgentHooks,
  state: AgenticLoopState,
): Promise<ToolResult> {
  const [result] = await executeToolBatch(
    [toolCall],
    context,
    tools,
    hooks,
    state,
  );
  return result;
}
