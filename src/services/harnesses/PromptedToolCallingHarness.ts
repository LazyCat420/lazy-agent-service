import BaseAgenticHarness from "./BaseAgenticHarness.ts";
import logger from "../../utils/logger.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  MAX_TOOL_ITERATIONS,
} from "@rodrigo-barraza/utilities-library/taxonomy";

import { createStandardHooks } from "./lifecycle/HookInitializer.ts";
import { executeToolBatch } from "./lifecycle/ToolExecutor.ts";
import { authorizeToolCalls } from "./lifecycle/ApprovalGate.ts";
import {
  emitPostExecutionStatus,
  processToolResultMedia,
  trackToolErrors,
} from "./lifecycle/PostExecutionEmitter.ts";
import { runExhaustionRecoveryPass } from "./lifecycle/ExhaustionRecovery.ts";
import { injectErrorAsConversationMessage } from "./lifecycle/OutputTruncationRecovery.ts";
import { manageContextPressure } from "./lifecycle/ContextPressureManager.ts";
import { finalizePassTracker } from "./lifecycle/TrackerFinalizer.ts";
import { checkCostBudget } from "./lifecycle/CostBudgetEnforcer.ts";
import { applyAssembledSystemPrompt } from "./lifecycle/IdentityPrompt.ts";
import {
  partitionCodeInterpreterCalls,
  runCodeInterpreterCalls,
} from "./CodeInterpreter.ts";
import {
  RUNNING_SUMMARY_INSTRUCTIONS,
  applyRunningSummary,
  extractLatestRunningSummary,
} from "./RunningSummary.ts";

import type {
  AgenticOptions,
  BeforePromptHookContext,
  ConversationMessage,
  ToolCall,
  ToolSchema,
  ToolResult,
} from "./types.ts";

/**
 * PromptedToolCallingHarness — in-band XML tool-calling loop for models
 * WITHOUT native tool-calling support (Hermes function-calling format).
 *
 * Reference: docs/harness-research/PLAN_hermes.md (NousResearch/Hermes-Function-Calling).
 *
 * The provider never sees a `tools` parameter. Instead:
 *   1. The system prompt embeds tool definitions as OpenAI-format JSON
 *      inside `<tools></tools>` and instructs the model to emit
 *      `<tool_call>{"name":...,"arguments":...}</tool_call>` blocks.
 *   2. Before each call the model is asked for a `<scratch_pad>` block
 *      (Goal / Actions / Observation / Reflection + "are the params known yet?").
 *   3. The harness parses the block leniently; on a JSON parse failure it
 *      re-prompts ONCE with the parse error, then surfaces a structured
 *      error observation instead of crashing the loop.
 *   4. One call per turn: if the model emits several blocks, the first is
 *      executed and the observation tells it to issue the next.
 *
 * Tool execution, approval gating, and persistence reuse the exact same
 * lifecycle modules as ReActHarness (ToolExecutor / ApprovalGate /
 * PostExecutionEmitter / Finalizer) — no duplicated dispatch.
 */

/** A leniently parsed `<tool_call>` payload. */
export interface ParsedPromptedToolCall {
  name: string;
  args: Record<string, unknown>;
}

export type PromptedToolCallParse =
  | { ok: true; call: ParsedPromptedToolCall }
  | { ok: false; error: string };

/** Extract the inner text of every `<tool_call>...</tool_call>` block in a response. */
export function extractToolCallBlocks(text: string): string[] {
  const blocks: string[] = [];
  const pattern = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

/**
 * Lenient parse of a tool-call block: trim, JSON.parse, and on failure
 * retry against the widest `{...}` substring (models occasionally wrap
 * the JSON in prose). `arguments` may arrive as an object or a JSON string.
 */
export function parsePromptedToolCall(inner: string): PromptedToolCallParse {
  const attempt = (candidate: string): PromptedToolCallParse | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (parseError) {
      return {
        ok: false,
        error: `Invalid JSON in <tool_call>: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        error: "Invalid <tool_call> payload: expected a JSON object with 'name' and 'arguments' fields.",
      };
    }
    const record = parsed as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) {
      return {
        ok: false,
        error: "Invalid <tool_call> payload: missing or empty 'name' field.",
      };
    }
    let args: Record<string, unknown> = {};
    const rawArgs = record.arguments ?? record.args ?? {};
    if (typeof rawArgs === "string") {
      try {
        args = JSON.parse(rawArgs) as Record<string, unknown>;
      } catch (argsError) {
        return {
          ok: false,
          error: `Invalid 'arguments' field: ${argsError instanceof Error ? argsError.message : String(argsError)}`,
        };
      }
    } else if (typeof rawArgs === "object" && rawArgs !== null) {
      args = rawArgs as Record<string, unknown>;
    }
    return { ok: true, call: { name, args } };
  };

  const trimmed = inner.trim();
  const direct = attempt(trimmed);
  if (direct?.ok) return direct;

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const widened = attempt(trimmed.slice(start, end + 1));
    if (widened?.ok) return widened;
  }
  return (
    direct ?? {
      ok: false,
      error: "Invalid <tool_call> block: content is not parseable JSON.",
    }
  );
}

/** Render the OpenAI-format JSON schema block embedded in the system prompt. */
export function buildPromptedToolCatalog(tools: ToolSchema[]): string {
  const catalog = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? { type: "object", properties: {} },
  }));
  return JSON.stringify(catalog, null, 2);
}

const PROMPTED_TOOL_INSTRUCTIONS = `You can call tools. The available tools are listed below as OpenAI function-calling schemas inside <tools>.

<tools>
{CATALOG}
</tools>

To call a tool, emit EXACTLY one block in your reply:
<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>

Before each tool call you MUST think in a <scratch_pad> block:
<scratch_pad>
Goal: the outcome you are working toward.
Actions: what you have done so far.
Observation: what the last tool result told you.
Reflection: what to do next and why.
Are the params known yet? yes/no — if no, ask the user or gather more information instead of guessing arguments.
</scratch_pad>

Rules:
- Emit at most ONE <tool_call> block per message. Wait for the tool result before issuing another call.
- After a <tool_result> observation, either issue the next call or give your final answer as plain text (no <tool_call> block) to finish.
- Never invent tool results. Never emit a <tool_call> block after your final answer.

${RUNNING_SUMMARY_INSTRUCTIONS}`;

/** Build the full system prompt embedding the tool catalog. */
export function buildPromptedToolSystemPrompt(tools: ToolSchema[]): string {
  return PROMPTED_TOOL_INSTRUCTIONS.replace(
    "{CATALOG}",
    buildPromptedToolCatalog(tools),
  );
}

/** Structured error observation surfaced when parsing fails twice. */
export function buildToolCallErrorObservation(
  error: string,
): string {
  return `<tool_result status="error">
{"error": "TOOL_CALL_PARSE_ERROR", "message": ${JSON.stringify(error)}}
</tool_result>`;
}

interface IterationPassOptions extends AgenticOptions {
  project: string;
  agent?: string | null;
  username: string;
}

/**
 * PromptedToolCallingHarness — see module docblock.
 */
export default class PromptedToolCallingHarness extends BaseAgenticHarness {
  static id = "prompted-xml";
  static label = "Prompted XML Tool Calling";
  static description =
    "In-band <tool_call> tool loop for models without native tool-calling (Hermes format).";

  private resolveMaxToolIterations(clientMaxIterations?: number): number {
    if (clientMaxIterations === 0) return Infinity;
    if (clientMaxIterations) {
      return Math.min(100, Math.max(1, clientMaxIterations));
    }
    return MAX_TOOL_ITERATIONS;
  }

  private async prepareFirstIterationPrompt(
    currentMessages: ConversationMessage[],
    tools: ToolSchema[],
    hooks: ReturnType<typeof createStandardHooks>["hooks"],
  ): Promise<void> {
    const context = this.context;
    const state = this.state;
    const {
      options,
      conversationId,
      agentConversationId,
      traceId,
      project,
      username,
      agent,
      workspaceRoot,
    } = context;

    const hookContext: BeforePromptHookContext = {
      messages: currentMessages,
      project,
      username,
      agent,
      traceId,
      conversationId,
      agentConversationId,
      parentAgentConversationId: context.parentAgentConversationId,
      agentContext: options.agentContext,
      enabledTools: this.tools.resolvedEnabledTools,
      resolvedToolNames: tools.map((tool) => tool.name),
      workspaceRoot: workspaceRoot || undefined,
      workspaceEnabled: options.workspaceEnabled as boolean | undefined,
      locale: options.locale as string | undefined,
      loadedTools: state.loadedTools,
    };
    await hooks.run("beforePrompt", hookContext);

    if (hookContext._assembledSystemPrompt) {
      applyAssembledSystemPrompt(
        options,
        hookContext._assembledSystemPrompt as string,
      );
    }

    currentMessages.unshift({
      role: "system",
      content: buildPromptedToolSystemPrompt(tools),
    });
  }

  private appendParseFailurePrompt(
    currentMessages: ConversationMessage[],
    responseText: string,
    parseError: string,
    repairAttempted: boolean,
  ): boolean {
    currentMessages.push({
      role: "assistant",
      content: responseText,
    });
    if (!repairAttempted) {
      currentMessages.push({
        role: "user",
        content:
          `Your previous message contained a <tool_call> block that could not be parsed:\n` +
          `${parseError}\n\n` +
          `Re-emit the call as a single <tool_call>{"name": ..., "arguments": ...}</tool_call> block with valid JSON.`,
        _isSystemWarning: true,
      });
      logger.info(
        `[PromptedToolCallingHarness] Parse failure on iteration ${this.state.iterations} — repair re-prompt issued.`,
      );
      return true;
    }
    currentMessages.push({
      role: "user",
      content: buildToolCallErrorObservation(parseError),
      _isSystemWarning: true,
    });
    logger.warn(
      `[PromptedToolCallingHarness] Parse failure persisted after repair on iteration ${this.state.iterations} — structured error observation surfaced.`,
    );
    return true;
  }

  private async executeParsedPromptedToolCall(
    toolCall: ToolCall,
    tools: ToolSchema[],
    hooks: ReturnType<typeof createStandardHooks>["hooks"],
  ): Promise<ToolResult[]> {
    const context = this.context;
    const state = this.state;
    const partition = partitionCodeInterpreterCalls([toolCall], tools);
    const isLocalInterpreter = partition.interpreterCalls.length > 0;
    if (
      !isLocalInterpreter &&
      !tools.some((tool) => tool.name === toolCall.name)
    ) {
      toolCall.isUnauthorized = true;
    }

    if (isLocalInterpreter && context.runtimeToolExecutor) {
      return [
        {
          name: toolCall.name,
          id: toolCall.id,
          result: {
            success: false,
            error: "CODE_INTERPRETER_NOT_ADMITTED",
            message:
              "code_interpreter is not in this run's profile whitelist.",
          },
        },
      ];
    }
    if (isLocalInterpreter) {
      const authorization = await authorizeToolCalls(
        [toolCall],
        context,
        hooks,
      );
      const denial = authorization.denied.get(toolCall);
      if (denial) {
        return [{ name: toolCall.name, id: toolCall.id, result: denial }];
      }
      if (authorization.executable.has(toolCall)) {
        return runCodeInterpreterCalls([toolCall]);
      }
      throw new Error(
        `Tool call "${toolCall.name}" reached execution without an allow verdict`,
      );
    }
    return executeToolBatch([toolCall], context, this.tools, hooks, state);
  }

  private appendToolCallObservationAndSummary(
    currentMessages: ConversationMessage[],
    pass: ReturnType<BaseAgenticHarness["createPassState"]>,
    responseText: string,
    toolCall: ToolCall,
    result: ToolResult | undefined,
    totalBlocks: number,
  ): void {
    const resultJson =
      JSON.stringify(result?.result ?? null, null, 2) || "null";
    const observationParts: string[] = [
      `<tool_result name="${toolCall.name}" status="success">\n${resultJson}\n</tool_result>`,
    ];
    if (totalBlocks > 1) {
      observationParts.push(
        `You emitted ${totalBlocks} <tool_call> blocks; only the first was executed. ` +
          `Issue the next call in a new message (one call per turn).`,
      );
    }
    currentMessages.push({
      role: "assistant",
      content: responseText,
      ...(pass.streamedThinking.trim() && {
        thinking: pass.streamedThinking.trim(),
      }),
      ...(pass.thinkingSignature && {
        thinkingSignature: pass.thinkingSignature,
      }),
    });
    currentMessages.push({
      role: "user",
      content: observationParts.join("\n\n"),
      _isSystemWarning: true,
    });

    const latestSummary = extractLatestRunningSummary(currentMessages);
    if (
      latestSummary !== null &&
      currentMessages[0]?.role === "system" &&
      typeof currentMessages[0].content === "string"
    ) {
      currentMessages[0] = {
        ...currentMessages[0],
        content: applyRunningSummary(currentMessages[0].content, latestSummary),
      };
    }
  }

  private handleExhaustedStreamGuard(
    currentMessages: ConversationMessage[],
    pass: ReturnType<BaseAgenticHarness["createPassState"]>,
  ): void {
    logger.warn(
      `[PromptedToolCallingHarness] Context exhaustion guard fired on iteration ${this.state.iterations}.`,
    );
    injectErrorAsConversationMessage(
      currentMessages,
      `Context window exhausted on iteration ${this.state.iterations}: the remaining output ` +
        `token budget is too small to produce a complete response.`,
      this.context,
    );
    this.state.conversationOutcome = "exhausted";
    this.logIteration(pass, currentMessages);
  }

  private handleNoToolCallBlocks(
    currentMessages: ConversationMessage[],
    pass: ReturnType<BaseAgenticHarness["createPassState"]>,
    responseText: string,
  ): boolean {
    if (!responseText.trim()) {
      logger.warn(
        `[PromptedToolCallingHarness] Empty output on iteration ${this.state.iterations} — breaking.`,
      );
      this.logIteration(pass, currentMessages);
      return false;
    }
    currentMessages.push({
      role: "assistant",
      content: responseText,
      ...(pass.streamedThinking.trim() && {
        thinking: pass.streamedThinking.trim(),
      }),
      ...(pass.thinkingSignature && {
        thinkingSignature: pass.thinkingSignature,
      }),
    });
    this.logIteration(pass, currentMessages);
    return true;
  }

  private async persistErrorAndRethrow(
    loopError: unknown,
    currentMessages: ConversationMessage[],
    hooks: ReturnType<typeof createStandardHooks>["hooks"],
  ): Promise<never> {
    const errMsg =
      loopError instanceof Error ? loopError.message : String(loopError);
    logger.error(
      `[PromptedToolCallingHarness] Loop error on iteration ${this.state.iterations}: ${errMsg}.`,
    );
    injectErrorAsConversationMessage(currentMessages, errMsg, this.context);
    this.state.conversationOutcome = "error";
    try {
      await this.finalize(currentMessages, hooks);
    } catch (persistError: unknown) {
      logger.error(
        `[PromptedToolCallingHarness] Failed to persist messages on error path: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
      );
    }
    throw loopError;
  }

  async run(): Promise<{ messages: ConversationMessage[] }> {
    const context = this.context;
    const state = this.state;
    const {
      options,
      agentConversationId,
      project,
      username,
      agent,
      workspaceRoot,
      emit,
      signal,
    } = context;

    const resolvedMaxIterations = this.resolveMaxToolIterations(
      options.maxIterations,
    );
    let currentMessages: ConversationMessage[] = [...context.messages];
    let hasCleanTextBreak = false;
    let repairAttempted = false;

    const { hooks } = createStandardHooks({
      workspaceRoot: workspaceRoot || undefined,
      enableCriticGate: options.enableCriticGate === true,
      criticModel: options.criticModel || undefined,
    });
    const tools = (this.tools.finalTools || []) as ToolSchema[];

    try {
      while (state.iterations < resolvedMaxIterations) {
        state.iterations++;
        emit({
          type: SERVER_SENT_EVENT_TYPES.STATUS,
          message: STATUS_MESSAGES.ITERATION_PROGRESS,
          iteration: state.iterations,
          maxIterations: resolvedMaxIterations,
        });

        if (state.iterations === 1) {
          await this.prepareFirstIterationPrompt(currentMessages, tools, hooks);
        }

        const passOptions: IterationPassOptions = {
          ...options,
          tools: undefined,
          project,
          agent,
          username,
        };
        const pressureResult = await manageContextPressure(
          currentMessages,
          context,
          state,
          "PromptedToolCallingHarness",
        );
        currentMessages = this.enforceContextWindow(pressureResult.messages, 0);

        const pass = this.createPassState(passOptions);
        const requestIdBase =
          context.requestId || agentConversationId || crypto.randomUUID();
        const passRequestId = `${requestIdBase}-iter-${state.iterations}`;
        pass.requestId = passRequestId;
        this.registerTrackerRequest(passRequestId);

        const stream = await this.createProviderStream(
          currentMessages,
          passOptions,
        );
        if (stream === null) {
          this.handleExhaustedStreamGuard(currentMessages, pass);
          break;
        }

        await this.consumeStream(stream, pass, new Set<string>());
        finalizePassTracker(pass, passRequestId);
        this.emitGenerationProgress();
        this.emitUsageUpdate();

        if (signal?.aborted) break;
        const budgetExceeded = await checkCostBudget(
          state,
          context.resolvedModel,
          options.maxCostDollars,
          emit,
          context.conversationId,
          {
            signal: context.signal,
            pauseTimeoutMs: options.budgetPauseTimeoutMs,
          },
        );
        if (budgetExceeded) break;

        const responseText = pass.streamedText || "";
        const blocks = extractToolCallBlocks(responseText);
        if (blocks.length === 0) {
          hasCleanTextBreak = this.handleNoToolCallBlocks(
            currentMessages,
            pass,
            responseText,
          );
          break;
        }

        const parsed = parsePromptedToolCall(blocks[0]);
        if (parsed.ok === false) {
          repairAttempted = this.appendParseFailurePrompt(
            currentMessages,
            responseText,
            parsed.error,
            repairAttempted,
          );
          this.logIteration(pass, currentMessages);
          continue;
        }

        const toolCall: ToolCall = {
          id: `ptc-${state.iterations}`,
          name: parsed.call.name,
          args: parsed.call.args,
        };
        context._currentMessages = currentMessages;
        const results = await this.executeParsedPromptedToolCall(
          toolCall,
          tools,
          hooks,
        );

        await processToolResultMedia(
          [toolCall],
          results,
          state,
          pass,
          emit,
          context,
        );
        trackToolErrors([toolCall], results, state, 3, emit);
        emitPostExecutionStatus([toolCall], emit);

        this.appendToolCallObservationAndSummary(
          currentMessages,
          pass,
          responseText,
          toolCall,
          results[0],
          blocks.length,
        );

        this.checkAndApplyToolSetChanges(currentMessages);
        this.logIteration(pass, currentMessages);
      }

      if (!hasCleanTextBreak && !signal?.aborted) {
        state.conversationOutcome = "exhausted";
        await runExhaustionRecoveryPass(this, context, state, currentMessages);
      }

      await this.finalize(currentMessages, hooks);
      return { messages: currentMessages };
    } catch (loopError: unknown) {
      return this.persistErrorAndRethrow(loopError, currentMessages, hooks);
    }
  }
}
