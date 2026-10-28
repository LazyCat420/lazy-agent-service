import ToolOrchestratorService from "../../ToolOrchestratorService.ts";
import ToolContext from "../../ToolContext.ts";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import logger from "../../../logger.ts";
import { HarnessInstrumenter } from "../../../platform/trace/HarnessInstrumenter.ts";
import type { SideEffectClass } from "../../../platform/contracts/telemetry.ts";

import type AgenticLoopState from "../../AgenticLoopState.ts";
import SkillRegistry from "../../../platform/skills/SkillRegistry.ts";

import { normalizeEmptyToolContent } from "../../ToolResult.ts";
function classifySideEffect(toolName: string): SideEffectClass {
  const name = toolName.toLowerCase();
  if (
    name.includes("write") ||
    name.includes("replace") ||
    name.includes("create") ||
    name.includes("save") ||
    name.includes("delete") ||
    name.includes("remove") ||
    name.includes("drop") ||
    name.includes("deploy") ||
    name.includes("kill")
  ) {
    return "MUTATING";
  }
  return "READ_ONLY";
}

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
import { authorizeToolCalls } from "./ApprovalGate.ts";
import { executeAskUser } from "./AskUserTool.ts";
import { executeTakeNote, NoteStore } from "../../../platform/memory/NoteStore.ts";
import { retrieveOffloadedContentTool } from "../../../platform/offload/retrieveOffloadedContent.ts";
import { OffloadPolicy, OFFLOAD_STUB_HEADER } from "../../../platform/offload/OffloadPolicy.ts";
import { getSharedOffloadStore } from "../../../platform/offload/OffloadStore.ts";

/** Process-wide retrieve tool; file-backed store shared via data/offload_store/. */
const retrieveOffloadedTool = retrieveOffloadedContentTool(getSharedOffloadStore());

/**
 * Offload oversized tool results (prism pattern): the model sees leading
 * lines within the 7,600-char budget plus a pointer; the full payload is
 * retrievable via retrieve_offloaded_content with the returned offload_id.
 * Idempotent — already-offloaded stubs and small results pass through.
 */
async function applyOffloadPolicyToResults(
  results: ToolResult[],
  context: AgenticContext,
): Promise<void> {
  for (const entry of results) {
    if (entry.name === "retrieve_offloaded_content") continue;
    if (typeof entry.result === "string" && entry.result.startsWith(OFFLOAD_STUB_HEADER)) continue;
    try {
      const applied = await OffloadPolicy.apply(entry.result, {
        toolName: entry.name,
        runId: context.runId,
      });
      if (applied.offloaded && applied.offloadId) {
        entry.result = applied.modelVisible;
      }
    } catch (offloadErr: unknown) {
      logger.debug(
        `[ToolExecutor] Offload policy skipped for ${entry.name}: ${offloadErr instanceof Error ? offloadErr.message : String(offloadErr)}`,
      );
    }
  }
}
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
async function handleMalformedToolCall(
  toolCall: ToolCall,
  context: AgenticContext,
  hooks: AgentHooks,
): Promise<ToolResult> {
  const result = {
    success: false,
    error: "MALFORMED_TOOL_CALL_JSON",
    message:
      `The JSON arguments for your "${toolCall.name}" call could not be parsed ` +
      `(likely truncated or invalid). Re-emit the tool call with complete, valid JSON arguments.` +
      (toolCall._rawArgs ? `\nUnparseable argument text (excerpt): ${toolCall._rawArgs}` : ""),
  };
  await hooks.run("afterToolCall", toolCall, result, context);
  return { name: toolCall.name, id: toolCall.id, result, durationMs: 0 };
}

async function tryExecuteInternalTool(
  toolCall: ToolCall,
  context: AgenticContext,
  hooks: AgentHooks,
  resolvedAgentConversationId: string,
): Promise<ToolResult | null> {
  if (toolCall.name === "skill_read") {
    const started = Date.now();
    const requestedName = typeof toolCall.args?.name === "string" ? toolCall.args.name : "";
    const body = new SkillRegistry().loadBody(requestedName);
    const result = {
      success: body !== null,
      ...(body !== null
        ? { name: requestedName, body }
        : {
            error: "skill_not_found",
            message: `No skill named "${requestedName}" is registered. Check the Available Skills section of the system prompt.`,
          }),
    };
    await hooks.run("afterToolCall", toolCall, result, context);
    return { name: toolCall.name, id: toolCall.id, result, durationMs: Date.now() - started };
  }

  if (toolCall.name === "take_note") {
    const started = Date.now();
    const runId =
      typeof (context as { runId?: unknown }).runId === "string"
        ? String((context as { runId?: unknown }).runId)
        : resolvedAgentConversationId;
    const result = await executeTakeNote(
      toolCall.args ?? {},
      runId,
      new NoteStore({ repoRoot: context.workspaceRoot || undefined }),
    );
    await hooks.run("afterToolCall", toolCall, result, context);
    return { name: toolCall.name, id: toolCall.id, result, durationMs: Date.now() - started };
  }

  if (toolCall.name === "ask_user") {
    const started = Date.now();
    let result: Record<string, unknown>;
    try {
      result = await executeAskUser(toolCall.args ?? {}, context);
    } catch (askError: unknown) {
      result = { error: askError instanceof Error ? askError.message : String(askError) };
    }
    await hooks.run("afterToolCall", toolCall, result, context);
    return { name: toolCall.name, id: toolCall.id, result, durationMs: Date.now() - started };
  }

  if (toolCall.name === "retrieve_offloaded_content") {
    const started = Date.now();
    const result = await retrieveOffloadedTool.execute(toolCall.args ?? {});
    await hooks.run("afterToolCall", toolCall, result, context);
    return { name: toolCall.name, id: toolCall.id, result, durationMs: Date.now() - started };
  }

  return null;
}

async function executeStreamingToolCall(
  toolCall: ToolCall,
  context: AgenticContext,
  hooks: AgentHooks,
  state: AgenticLoopState,
  resolvedAgentConversationId: string,
  parentSpan: any,
  sideEffect: ReturnType<typeof classifySideEffect>,
): Promise<ToolResult> {
  const { project, username, agent, conversationId, workspaceRoot, emit } = context;
  const startTime = Date.now();
  const result = await HarnessInstrumenter.traceToolExecution(
    toolCall.name,
    toolCall.args,
    parentSpan,
    sideEffect,
    async () => {
      return await ToolOrchestratorService.executeToolStreaming(
        toolCall.name,
        toolCall.args as Record<string, unknown>,
        (event: string, data: string | null, meta?: Record<string, unknown>) => {
          emit({
            type: SERVER_SENT_EVENT_TYPES.TOOL_OUTPUT,
            toolCallId: toolCall.id,
            name: toolCall.name,
            event,
            data: data || undefined,
            meta: meta || undefined,
            ...(context.traceId ? { trace_id: context.traceId } : {}),
            ...((context as any).runId ? { run_id: (context as any).runId } : {}),
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
    },
  );
  const durationMs = Date.now() - startTime;
  await hooks.run("afterToolCall", toolCall, result, context);
  return {
    name: toolCall.name,
    id: toolCall.id,
    result: truncateResultIfNeeded(result, project, toolCall.name),
    durationMs,
  };
}

function resolveMaxRecursionDepth(context: AgenticContext): number | undefined {
  if (typeof context._maxRecursionDepth === "number") {
    return context._maxRecursionDepth;
  }
  if (typeof context.options?.maxRecursionDepth === "number") {
    return context.options.maxRecursionDepth;
  }
  return undefined;
}

function buildStandardToolExecContext(
  context: AgenticContext,
  tools: ResolvedTools,
  state: AgenticLoopState,
  resolvedAgentConversationId: string,
) {
  const {
    project,
    username,
    agent,
    conversationId,
    traceId,
    providerName,
    resolvedModel,
    workspaceRoot,
    emit,
  } = context;
  return {
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
    _topology: typeof context.options?.topology === "string" ? context.options.topology : undefined,
    _recursionDepth: typeof context._recursionDepth === "number" ? context._recursionDepth : undefined,
    _maxRecursionDepth: resolveMaxRecursionDepth(context),
    _thinkingEnabled: context.options?.thinkingEnabled,
    _reasoningEffort: context.options?.reasoningEffort,
    _thinkingBudget: context.options?.thinkingBudget,
    _policies: context.options?.policies,
  };
}

function recordDescribedTools(toolCall: ToolCall, state: AgenticLoopState): void {
  if (toolCall.name === "describe_tools" && toolCall.args && Array.isArray(toolCall.args.tool_names)) {
    for (const name of toolCall.args.tool_names) {
      if (typeof name === "string") {
        const cleanName = name.replace(/^(mcp__[a-zA-Z0-9_-]+__)/, "");
        state.loadedTools.add(cleanName);
      }
    }
  }
}

async function executeSingleAuthorizedTool(
  toolCall: ToolCall,
  authorization: Awaited<ReturnType<typeof authorizeToolCalls>>,
  context: AgenticContext,
  tools: ResolvedTools,
  hooks: AgentHooks,
  state: AgenticLoopState,
  resolvedAgentConversationId: string,
): Promise<ToolResult> {
  if (toolCall._argsParseError) {
    return handleMalformedToolCall(toolCall, context, hooks);
  }

  const denial = authorization.denied.get(toolCall);
  if (denial) {
    await hooks.run("afterToolCall", toolCall, denial, context);
    return { name: toolCall.name, id: toolCall.id, result: denial, durationMs: 0 };
  }
  if (!authorization.executable.has(toolCall)) {
    throw new Error(`Tool call "${toolCall.name}" reached execution without an allow verdict`);
  }

  if (context.runtimeToolExecutor) {
    const started = Date.now();
    const result = await context.runtimeToolExecutor(toolCall);
    await hooks.run("afterToolCall", toolCall, result, context);
    return {
      name: toolCall.name,
      id: toolCall.id,
      result: normalizeEmptyToolContent(result),
      durationMs: Date.now() - started,
    };
  }

  const internalResult = await tryExecuteInternalTool(
    toolCall,
    context,
    hooks,
    resolvedAgentConversationId,
  );
  if (internalResult) return internalResult;

  const parentSpan = (context as any).rootSpan;
  const sideEffect = classifySideEffect(toolCall.name);

  if (ToolOrchestratorService.isStreamable(toolCall.name)) {
    return executeStreamingToolCall(
      toolCall,
      context,
      hooks,
      state,
      resolvedAgentConversationId,
      parentSpan,
      sideEffect,
    );
  }

  const startTime = Date.now();
  const execContext = buildStandardToolExecContext(
    context,
    tools,
    state,
    resolvedAgentConversationId,
  );
  const result = await HarnessInstrumenter.traceToolExecution(
    toolCall.name,
    toolCall.args,
    parentSpan,
    sideEffect,
    async () => {
      return await ToolOrchestratorService.executeTool(
        toolCall.name,
        toolCall.args as Record<string, unknown>,
        execContext,
      );
    },
  );
  const durationMs = Date.now() - startTime;
  await hooks.run("afterToolCall", toolCall, result, context);
  recordDescribedTools(toolCall, state);

  return {
    name: toolCall.name,
    id: toolCall.id,
    result: truncateResultIfNeeded(
      normalizeEmptyToolContent(truncateResultIfNeeded(result, context.project, toolCall.name)),
      context.project,
      toolCall.name,
    ),
    durationMs,
  };
}

export async function executeToolBatch(
  toolCalls: ToolCall[],
  context: AgenticContext,
  tools: ResolvedTools,
  hooks: AgentHooks,
  state: AgenticLoopState,
): Promise<ToolResult[]> {
  const resolvedAgentConversationId = context.agentConversationId || "";
  const authorization = await authorizeToolCalls(toolCalls, context, hooks);

  const results = await Promise.all(
    toolCalls.map((toolCall) =>
      executeSingleAuthorizedTool(
        toolCall,
        authorization,
        context,
        tools,
        hooks,
        state,
        resolvedAgentConversationId,
      ),
    ),
  );

  await applyOffloadPolicyToResults(results, context);
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
