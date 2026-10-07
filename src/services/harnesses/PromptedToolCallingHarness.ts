import BaseAgenticHarness from "./BaseAgenticHarness.ts";
import logger from "../../utils/logger.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  MAX_TOOL_ITERATIONS,
} from "@rodrigo-barraza/utilities-library/taxonomy";

import { createStandardHooks } from "./lifecycle/HookInitializer.ts";
import { executeToolBatch } from "./lifecycle/ToolExecutor.ts";
import { checkAndWaitForApproval } from "./lifecycle/ApprovalGate.ts";
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
- Never invent tool results. Never emit a <tool_call> block after your final answer.`;

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

  async run(): Promise<{ messages: ConversationMessage[] }> {
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
      emit,
      signal,
    } = context;

    // ── Resolve max iterations — same mechanism as ReActHarness ──
    const clientMaxIterations = options.maxIterations;
    const resolvedMaxIterations =
      clientMaxIterations === 0
        ? Infinity
        : clientMaxIterations
          ? Math.min(100, Math.max(1, clientMaxIterations))
          : MAX_TOOL_ITERATIONS;

    let currentMessages: ConversationMessage[] = [...context.messages];
    let hasCleanTextBreak = false;
    // One repair re-prompt per run for a malformed <tool_call> block.
    let repairAttempted = false;

    const { hooks, approvalEngine } = createStandardHooks({
      workspaceRoot: workspaceRoot || undefined,
      autoApprove: options.autoApprove === true,
      policies: options.policies,
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

        // ── Iteration 1: identity prompt + <tools> system prompt ──
        if (state.iterations === 1) {
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

          // The prompted-tools system prompt is prepended so it precedes the
          // conversation; the model has no native tools parameter to receive.
          currentMessages.unshift({
            role: "system",
            content: buildPromptedToolSystemPrompt(tools),
          });
        }

        // ── Pass options: NO native tools — calls are parsed from text ──
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
        currentMessages = pressureResult.messages;

        currentMessages = this.enforceContextWindow(
          currentMessages,
          0,
        );

        const pass = this.createPassState(passOptions);
        const requestIdBase =
          context.requestId || agentConversationId || crypto.randomUUID();
        const passRequestId = `${requestIdBase}-iter-${state.iterations}`;
        pass.requestId = passRequestId;

        this.registerTrackerRequest(passRequestId);

        const stream = this.createProviderStream(currentMessages, passOptions);
        if (stream === null) {
          logger.warn(
            `[PromptedToolCallingHarness] Context exhaustion guard fired on iteration ${state.iterations}.`,
          );
          injectErrorAsConversationMessage(
            currentMessages,
            `Context window exhausted on iteration ${state.iterations}: the remaining output ` +
              `token budget is too small to produce a complete response.`,
            context,
          );
          state.conversationOutcome = "exhausted";
          this.logIteration(pass, currentMessages);
          break;
        }

        // No native tool names: text chunks only — <tool_call> parsing is ours.
        await this.consumeStream(stream, pass, new Set<string>());

        finalizePassTracker(pass, passRequestId);
        this.emitGenerationProgress();
        this.emitUsageUpdate();

        if (signal?.aborted) break;

        if (checkCostBudget(state, context.resolvedModel, options.maxCostDollars, emit)) {
          break;
        }

        const responseText = pass.streamedText || "";
        const blocks = extractToolCallBlocks(responseText);

        // ── No tool call: this is the final answer ────────────────
        if (blocks.length === 0) {
          if (!responseText.trim()) {
            logger.warn(
              `[PromptedToolCallingHarness] Empty output on iteration ${state.iterations} — breaking.`,
            );
            this.logIteration(pass, currentMessages);
            break;
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
          hasCleanTextBreak = true;
          break;
        }

        // ── Parse the first block ────────────────────────────────
        const parsed = parsePromptedToolCall(blocks[0]);
        if (parsed.ok === false) {
          currentMessages.push({
            role: "assistant",
            content: responseText,
          });
          if (!repairAttempted) {
            // Exactly ONE repair re-prompt with the parse error...
            repairAttempted = true;
            currentMessages.push({
              role: "user",
              content:
                `Your previous message contained a <tool_call> block that could not be parsed:\n` +
                `${parsed.error}\n\n` +
                `Re-emit the call as a single <tool_call>{"name": ..., "arguments": ...}</tool_call> block with valid JSON.`,
              _isSystemWarning: true,
            });
            logger.info(
              `[PromptedToolCallingHarness] Parse failure on iteration ${state.iterations} — repair re-prompt issued.`,
            );
          } else {
            // ...then surface a structured error observation.
            currentMessages.push({
              role: "user",
              content: buildToolCallErrorObservation(parsed.error),
              _isSystemWarning: true,
            });
            logger.warn(
              `[PromptedToolCallingHarness] Parse failure persisted after repair on iteration ${state.iterations} — structured error observation surfaced.`,
            );
          }
          this.logIteration(pass, currentMessages);
          continue;
        }

        const toolCall: ToolCall = {
          id: `ptc-${state.iterations}`,
          name: parsed.call.name,
          args: parsed.call.args,
        };

        // ── One call per turn: execute the first, defer the rest ──
        const extraCallCount = blocks.length - 1;

        // ── Execute through the same path ReActHarness uses ──────
        context._currentMessages = currentMessages;

        const { isApproved, shouldApproveAll } = await checkAndWaitForApproval(
          [toolCall],
          context,
          approvalEngine,
        );

        let results: ToolResult[];
        if (!isApproved) {
          results = [
            {
              name: toolCall.name,
              id: toolCall.id,
              result: {
                success: false,
                error: "USER_REJECTED",
                message: "Tool execution was manually rejected by the user.",
              },
            },
          ];
        } else {
          if (shouldApproveAll) options.autoApprove = true;
          results = await executeToolBatch(
            [toolCall],
            context,
            this.tools,
            hooks,
            state,
          );
        }

        await processToolResultMedia([toolCall], results, state, pass, emit, context);
        trackToolErrors([toolCall], results, state, 3, emit);
        emitPostExecutionStatus([toolCall], emit);

        const result = results[0];
        const resultJson = JSON.stringify(result?.result ?? null, null, 2) || "null";
        const observationParts: string[] = [
          `<tool_result name="${toolCall.name}" status="success">\n${resultJson}\n</tool_result>`,
        ];
        if (extraCallCount > 0) {
          observationParts.push(
            `You emitted ${blocks.length} <tool_call> blocks; only the first was executed. ` +
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

        this.checkAndApplyToolSetChanges(currentMessages);
        this.logIteration(pass, currentMessages);
        continue;
      }

      // ── Exhaustion recovery — same discipline as ReActHarness ──
      if (!hasCleanTextBreak && !signal?.aborted) {
        state.conversationOutcome = "exhausted";
        await runExhaustionRecoveryPass(this, context, state, currentMessages);
      }

      await this.finalize(currentMessages, hooks);
      return { messages: currentMessages };
    } catch (loopError: unknown) {
      logger.error(
        `[PromptedToolCallingHarness] Loop error on iteration ${state.iterations}: ${loopError instanceof Error ? loopError.message : String(loopError)}.`,
      );
      injectErrorAsConversationMessage(
        currentMessages,
        loopError instanceof Error ? loopError.message : String(loopError),
        context,
      );
      state.conversationOutcome = "error";
      try {
        await this.finalize(currentMessages, hooks);
      } catch (persistError: unknown) {
        logger.error(
          `[PromptedToolCallingHarness] Failed to persist messages on error path: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
        );
      }
      throw loopError;
    }
  }
}
