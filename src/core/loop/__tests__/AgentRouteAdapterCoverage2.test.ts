/**
 * Coverage2 for AgentRouteAdapter's non-streaming chunk adapter
 * (`yieldNonStreamingResponseChunks`) driven through runCoreLoopForAgent with
 * a generateText-only provider: thinking, text, tool calls and usage chunks.
 */
import { describe, it, expect } from "vitest";
import type { ChatMessage } from "../../../types/ProviderTypes.ts";
import { runCoreLoopForAgent } from "../AgentRouteAdapter.ts";
import type { AgentRouteAdapterContext } from "../AgentRouteAdapter.ts";

interface EmittedEvent {
  type: string;
  [key: string]: unknown;
}

const buildContext = (
  generateText: AgentRouteAdapterContext["provider"]["generateText"],
  executor?: AgentRouteAdapterContext["runtimeToolExecutor"],
) => {
  const emitted: EmittedEvent[] = [];
  const context: AgentRouteAdapterContext = {
    project: "p",
    username: "u",
    options: {},
    messages: [{ role: "user", content: "hi" }] as ChatMessage[],
    provider: { generateText },
    resolvedModel: "openai/gpt-4o",
    signal: new AbortController().signal,
    runtimeTools: {
      finalTools: [
        {
          name: "get_quote",
          description: "quote",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    runtimeToolExecutor: executor,
    emit: (event) => {
      emitted.push(event as EmittedEvent);
    },
  };
  return { context, emitted };
};

describe("runCoreLoopForAgent non-streaming provider", () => {
  it("emits thinking, text, tool execution and usage chunks", async () => {
    const responses = [
      {
        thinking: "let me check",
        text: "checking the market",
        toolCalls: [{ id: "call-1", name: "get_quote", args: { ticker: "AAPL" } }],
        usage: { inputTokens: 5, outputTokens: 6 },
      },
      {
        text: "final answer",
        usage: { inputTokens: 2, outputTokens: 3 },
      },
    ];
    let callIndex = 0;

    const { context, emitted } = buildContext(
      async () => responses[Math.min(callIndex++, responses.length - 1)],
      async () => "AAPL 190.00",
    );

    const output = await runCoreLoopForAgent(context);

    expect(emitted).toContainEqual({ type: "thinking", content: "let me check" });
    expect(emitted).toContainEqual({ type: "chunk", content: "checking the market" });
    expect(emitted).toContainEqual({ type: "chunk", content: "final answer" });
    expect(emitted).toContainEqual({
      type: "tool_execution",
      tool: { id: "call-1", name: "get_quote", args: { ticker: "AAPL" } },
      status: "calling",
    });
    expect(
      emitted.some(
        (event) =>
          event.type === "tool_execution" &&
          event.status === "done" &&
          (event.tool as { result?: string }).result === "AAPL 190.00",
      ),
    ).toBe(true);

    expect(output.toolCalls).toEqual([
      { id: "call-1", name: "get_quote", args: { ticker: "AAPL" }, result: "AAPL 190.00" },
    ]);
    expect(output.result.text).toBe("final answer");
    expect(output.usage.requests).toBe(2);
    expect(output.usage.inputTokens).toBe(7);
    expect(output.usage.outputTokens).toBe(9);
  });

  it("finishes without tool calls and without a usage block", async () => {
    const { context, emitted } = buildContext(async () => ({ text: "plain" }));

    const output = await runCoreLoopForAgent(context);

    expect(output.result.text).toBe("plain");
    expect(output.toolCalls).toEqual([]);
    expect(emitted).toContainEqual({ type: "chunk", content: "plain" });
    expect(emitted.some((event) => event.type === "usage_update")).toBe(false);
  });
});
