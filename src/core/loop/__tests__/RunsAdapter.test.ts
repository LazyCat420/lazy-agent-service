/**
 * RunsAdapter tests: the real runCoreLoop drives a fake provider through the
 * adapter; the fake provider records every call. No real timers — tools
 * settle immediately and the abort signal is always created fresh.
 */
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../../types/ProviderTypes.ts";
import type { StreamChunk } from "../../../types/provider.ts";
import { runCoreLoopForRun, type RunsAdapterContext } from "../RunsAdapter.ts";

type ProviderTurn = { throw: Error } | { chunks: StreamChunk[] };

interface TestContext extends RunsAdapterContext {
  calls: RecordedCall[];
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  emitted: Array<{ type: string; content?: string; data?: unknown }>;
}

interface RecordedCall {
  messages: ChatMessage[];
  model: string;
  options: Record<string, unknown>;
}

const TOOL = {
  name: "global.web.search",
  description: "Search the web",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

const makeContext = (
  turns: ProviderTurn[],
  overrides: Partial<RunsAdapterContext> = {},
  order?: string[],
): TestContext => {
  const calls: RecordedCall[] = [];
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const provider = {
    generateTextStream(
      messages: ChatMessage[],
      model: string,
      options: Record<string, unknown>,
    ): AsyncIterable<StreamChunk> {
      order?.push("providerCall");
      calls.push({ messages: structuredClone(messages), model, options: structuredClone(options) });
      const turn = turns[calls.length - 1];
      if (!turn) throw new Error("no scripted turn for call " + calls.length);
      if ("throw" in turn) throw turn.throw;
      return (async function* () {
        for (const chunk of turn.chunks) yield chunk;
      })();
    },
  };
  const context: RunsAdapterContext = {
    options: { maxIterations: 10, maxTokens: 2048, temperature: 0.4 },
    messages: [{ role: "user", content: "hi" }],
    provider,
    resolvedModel: "test-model",
    signal: new AbortController().signal,
    runtimeTools: { finalTools: [TOOL] },
    runtimeToolExecutor: async (call) => {
      toolCalls.push({ name: call.name, args: call.args });
      return "search result: 4";
    },
    emit: () => {},
    ...overrides,
  };
  return { ...context, calls, toolCalls, emitted: [] } as TestContext;
};

const collect = async (context: TestContext) => {
  context.emitted = [];
  context.emit = (event) => context.emitted.push(event);
  const returned = await runCoreLoopForRun(context);
  return { ...returned, emitted: context.emitted, toolCalls: context.toolCalls, calls: context.calls };
};

describe("runCoreLoopForRun", () => {
  it("1: a text-only provider completes with chunk events concatenating to the answer", async () => {
    const context = makeContext([{ chunks: ["Hello", " ", "world"] }]);
    const { messages, result, emitted } = await collect(context);

    expect(result.status).toBe("completed");
    expect(result.text).toBe("Hello world");
    const last = messages[messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.content).toBe("Hello world");
    const chunks = emitted.filter((event) => event.type === "chunk");
    expect(chunks.map((event) => event.content).join("")).toBe("Hello world");
  });

  it("2: a toolCall turn executes the runtime executor and pairs a tool message", async () => {
    const context = makeContext([
      { chunks: [{ type: "toolCall", id: "t1", name: "global.web.search", args: { query: "q" } }] },
      { chunks: ["The answer is 4."] },
    ]);
    const { messages, result, toolCalls } = await collect(context);

    expect(result.status).toBe("completed");
    expect(toolCalls).toEqual([{ name: "global.web.search", args: { query: "q" } }]);
    const toolIndex = messages.findIndex((message) => message.role === "tool");
    expect(toolIndex).toBeGreaterThan(-1);
    expect(messages[toolIndex]).toMatchObject({ tool_call_id: "t1", content: "search result: 4" });
    const answer = messages[messages.length - 1];
    expect(answer.role).toBe("assistant");
    expect(answer.content).toBe("The answer is 4.");
    expect(toolIndex).toBeLessThan(messages.length - 1);
  });

  it("6: a tool timeout aborts the signal the runtime tool executor received", async () => {
    const timeout = new AbortController();
    let received: AbortSignal | undefined;
    const context = makeContext(
      [
        { chunks: [{ type: "toolCall", id: "t1", name: "global.web.search", args: { query: "q" } }] },
        { chunks: ["Answer without the tool."] },
      ],
      {
        timeoutSignalFor: () => timeout.signal,
        runtimeToolExecutor: (call, signal) => {
          void call;
          received = signal;
          const { promise, reject } = Promise.withResolvers<unknown>();
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          queueMicrotask(() => timeout.abort(new Error("tool timeout")));
          return promise;
        },
      },
    );
    const { messages, result } = await collect(context);

    expect(received).toBeDefined();
    expect(received?.aborted).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.text).toContain("Answer without the tool.");
    const toolIndex = messages.findIndex((message) => message.role === "tool");
    expect(toolIndex).toBeGreaterThan(-1);
    expect(messages[toolIndex].content).toContain("timed out after");
  });

  it("3: DEADLINE_SOFT finalize forces exactly one provider call with toolChoice none and the FINALIZE warning", async () => {
    const context = makeContext([{ chunks: ["Final answer."] }], {
      finalizeRequested: { reason: "DEADLINE_SOFT" },
    });
    const { result, emitted } = await collect(context);

    expect(result.status).toBe("completed");
    expect(context.calls).toHaveLength(1);
    expect(context.calls[0].options.toolChoice).toBe("none");
    expect(context.calls[0].options.tools).toEqual([TOOL]);
    const warnings = emitted.filter((event) => event.type === "run.warning");
    expect(warnings).toHaveLength(1);
    expect((warnings[0].data as { code: string }).code).toBe("FINALIZE");
    expect((warnings[0].data as { reason: string }).reason).toBe("DEADLINE_SOFT");
  });

  it("4: TOKEN_BUDGET_FINALIZE on a later call finalizes with a final pass", async () => {
    const context = makeContext([
      { chunks: [{ type: "toolCall", id: "t1", name: "global.web.search", args: { query: "q" } }] },
      { throw: Object.assign(new Error("budget"), { code: "TOKEN_BUDGET_FINALIZE" }) },
      { chunks: ["Answering from what I have."] },
    ]);
    const { result } = await collect(context);

    expect(result.status).toBe("completed");
    expect(result.text).toBe("Answering from what I have.");
    expect(context.calls.length).toBe(3);
  });

  it("5: the final pass calls canonicalBudget.allowFinalPass before the provider call", async () => {
    const order: string[] = [];
    const allowFinalPass = vi.fn(() => {
      order.push("allowFinalPass");
    });
    const context = makeContext(
      [
        { chunks: [{ type: "toolCall", id: "t1", name: "global.web.search", args: { query: "q" } }] },
        { throw: Object.assign(new Error("budget"), { code: "TOKEN_BUDGET_FINALIZE" }) },
        { chunks: ["Answering from what I have."] },
      ],
      { canonicalBudget: { allowFinalPass } },
      order,
    );
    const { result } = await collect(context);

    expect(result.status).toBe("completed");
    expect(allowFinalPass).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["providerCall", "providerCall", "allowFinalPass", "providerCall"]);
  });

  it("5: every provider call receives a byte-identical tools option", async () => {
    const context = makeContext([
      { chunks: [{ type: "toolCall", id: "t1", name: "global.web.search", args: { query: "q" } }] },
      { chunks: [{ type: "toolCall", id: "t2", name: "global.web.search", args: { query: "r" } }] },
      { chunks: ["done"] },
    ]);
    await collect(context);

    const serialized = context.calls.map((call) => JSON.stringify(call.options.tools));
    expect(context.calls.length).toBeGreaterThan(1);
    for (const entry of serialized) expect(entry).toBe(serialized[0]);
  });

  it("6: a context-overflow rejection on the first call retries once with a smaller maxTokens", async () => {
    const context = makeContext([
      {
        throw: new Error(
          "This model's maximum context length is 90000 tokens. However, you requested 58082 output tokens and your prompt contains at least 31919 input tokens.",
        ),
      },
      { chunks: ["Recovered."] },
    ]);
    const { result } = await collect(context);

    expect(result.status).toBe("completed");
    expect(context.calls).toHaveLength(2);
    const first = Number(context.calls[0].options.maxTokens);
    const second = Number(context.calls[1].options.maxTokens);
    expect(first).toBe(2048);
    // 90000 window − 31919 reported input − 1024 fixed headroom; halving floors at 1024.
    expect(second).toBe(Math.min(Math.floor(first / 2), 90000 - 31919 - 1024));
    expect(second).toBeLessThan(first);
  });

  it("7: the final pass asks the provider for thinking off", async () => {
    const context = makeContext([
      { chunks: [{ type: "toolCall", id: "t1", name: "global.web.search", args: { query: "q" } }] },
      { throw: Object.assign(new Error("budget"), { code: "TOKEN_BUDGET_FINALIZE" }) },
      { chunks: ["Answer."] },
    ]);
    const { result } = await collect(context);

    expect(result.status).toBe("completed");
    expect(context.calls).toHaveLength(3);
    const first = context.calls[0]!.options;
    const final = context.calls.find((c) => c.options.toolChoice === "none")!;
    expect(final.options.thinkingEnabled).toBe(false);
    expect("thinkingEnabled" in first).toBe(false);
  });

  it("8: every provider call carries the run system prompt", async () => {
    const context = makeContext(
      [
        { chunks: [{ type: "toolCall", id: "t1", name: "global.web.search", args: { query: "q" } }] },
        { throw: Object.assign(new Error("budget"), { code: "TOKEN_BUDGET_FINALIZE" }) },
        { chunks: ["Answer."] },
      ],
      {
        options: { maxIterations: 10, maxTokens: 2048, temperature: 0.4, systemPrompt: "SYS-RULES" },
      },
    );
    const { result } = await collect(context);

    expect(result.status).toBe("completed");
    expect(context.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of context.calls) {
      expect(call.options.systemPrompt).toBe("SYS-RULES");
    }
    const final = context.calls.find((c) => c.options.toolChoice === "none")!;
    expect(final.options.systemPrompt).toBe("SYS-RULES");
  });
});
