/**
 * ch.06 item 8 — malformed tool-call arguments are never executed.
 *
 * prism flags a tool call whose argument JSON does not parse
 * (providers/openai-compat.ts argsParseError) and its ToolExecutor returns a
 * synthetic MALFORMED_TOOL_CALL_JSON error instead of running the tool with
 * silently-empty args. Ours swallowed the parse error and executed `{}`
 * — the source of most "'data' is required and must be an object" failures
 * from emit_structured_output.
 */
import { describe, expect, it } from "vitest";

import { parseSSEStream } from "../../utils/openai-compat.ts";
import { executeToolBatch } from "../../services/harnesses/lifecycle/ToolExecutor.ts";
import AgentHooks from "../../services/AgentHooks.ts";
import type { AgenticContext, ResolvedTools, ToolCall } from "../../services/harnesses/types.ts";

function reader(frames: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const bytes = new TextEncoder().encode(frames.join(""));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }).getReader();
}

async function drain(frames: string[]) {
  const out: unknown[] = [];
  for await (const chunk of parseSSEStream(reader(frames), { label: "test" })) out.push(chunk);
  return out;
}

const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
  "data: " +
  JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) +
  "\n\n";

describe("parseSSEStream: malformed tool-call arguments", () => {
  it("flags the call instead of yielding silently-empty args", async () => {
    const frames = [
      frame({
        tool_calls: [
          { index: 0, id: "call_1", function: { name: "emit_structured_output", arguments: '{"data": {"ticker": "COF"' } },
        ],
      }),
      frame({}, "tool_calls"),
    ];
    const toolCalls: Array<Record<string, unknown>> = [];
    for (const chunk of await drain(frames)) {
      if (
        typeof chunk === "object" && chunk !== null &&
        (chunk as { type?: string }).type === "toolCall"
      ) {
        toolCalls.push(chunk as Record<string, unknown>);
      }
    }
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].argsParseError).toBe(true);
    expect(String(toolCalls[0].rawArgs)).toContain('"ticker"');
  });

  it("valid arguments carry no flag", async () => {
    const frames = [
      frame({
        tool_calls: [
          { index: 0, id: "call_1", function: { name: "emit_structured_output", arguments: '{"data": {"ticker": "COF"}}' } },
        ],
      }),
      frame({}, "tool_calls"),
    ];
    let flagged = false;
    for (const chunk of await drain(frames)) {
      if (typeof chunk === "object" && chunk !== null && (chunk as { argsParseError?: boolean }).argsParseError) {
        flagged = true;
      }
    }
    expect(flagged).toBe(false);
  });
});

describe("executeToolBatch: MALFORMED_TOOL_CALL_JSON", () => {
  const context = {
    project: "test",
    username: "tester",
    agent: null,
    agentConversationId: "conv",
    conversationId: "conv",
    traceId: "trace",
    providerName: "mock",
    resolvedModel: "mock-model",
    emit: () => {},
  } as unknown as AgenticContext;
  const tools: ResolvedTools = { finalTools: [], resolvedEnabledTools: null };

  it("never executes the call; reports the unparseable text back", async () => {
    let executed = false;
    const contextWithExecutor = Object.assign({}, context, {
      runtimeToolExecutor: async () => {
        executed = true;
        return { ok: true };
      },
    }) as AgenticContext;
    const hooks = new AgentHooks();
    const toolCall = {
      id: "call_1",
      name: "emit_structured_output",
      args: {},
      _argsParseError: true,
      _rawArgs: '{"data": {"ticker": "COF"',
    } as ToolCall;

    const results = await executeToolBatch(
      [toolCall],
      contextWithExecutor,
      tools,
      hooks,
      {} as never,
    );

    expect(executed).toBe(false);
    const result = results[0].result as { error?: string; message?: string };
    expect(result.error).toBe("MALFORMED_TOOL_CALL_JSON");
    expect(result.message).toContain("Re-emit the tool call");
    expect(result.message).toContain('"ticker"');
  });

  it("a well-formed call still executes", async () => {
    const hooks = new AgentHooks();
    const toolCall: ToolCall = {
      id: "call_2",
      name: "get_market_data",
      args: { ticker: "COF" },
    };
    const contextWithExecutor = Object.assign({}, context, {
      runtimeToolExecutor: async () => ({ ticker: "COF" }),
    }) as AgenticContext;
    const results = await executeToolBatch(
      [toolCall],
      contextWithExecutor,
      tools,
      hooks,
      {} as never,
    );
    const result = results[0].result as Record<string, unknown>;
    expect(result).toEqual({ ticker: "COF" });
  });
});
