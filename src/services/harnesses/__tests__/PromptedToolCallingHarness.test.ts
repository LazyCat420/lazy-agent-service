/**
 * PromptedToolCallingHarness — unit tests with a mock model.
 *
 * Covers the PLAN_hermes.md acceptance criteria:
 *   - valid <tool_call> blocks drive a full tool run with no native tool API
 *   - malformed JSON triggers exactly ONE repair re-prompt, then a
 *     structured error observation
 *   - one call per turn: multiple blocks → first executed, next-call notice
 *   - reasoning_effort passthrough reaches the provider call params
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../wrappers/MongoWrapper.ts", () => {
  class MongoWrapper {
    static getDb() {
      return null;
    }
    static getCollection() {
      return null;
    }
    static getClient() {
      return null;
    }
  }
  return { default: MongoWrapper };
});

vi.mock("../RequestLogger.ts", () => {
  const RequestLogger = {
    insertPending: async () => null,
    logChatGeneration: async () => {},
    log: async () => {},
  };
  return { default: RequestLogger };
});

vi.mock("../../../platform/trace/TraceExporter.ts", () => {
  class TraceExporter {
    private static instance = new TraceExporter();
    static getGlobalInstance() {
      return TraceExporter.instance;
    }
    enqueueSpan() {}
    getQueuedSpans() {
      return [];
    }
  }
  return { TraceExporter };
});

import PromptedToolCallingHarness, {
  buildPromptedToolSystemPrompt,
  extractToolCallBlocks,
  parsePromptedToolCall,
} from "../PromptedToolCallingHarness.ts";
import AgenticLoopState from "../../AgenticLoopState.ts";
import HarnessRegistry from "../HarnessRegistry.ts";
import type {
  AgenticContext,
  ConversationMessage,
  ToolSchema,
} from "../types.ts";

const TOOLS: ToolSchema[] = [
  {
    name: "get_market_data",
    description: "Fetch market data for a ticker.",
    parameters: {
      type: "object",
      properties: { ticker: { type: "string" } },
      required: ["ticker"],
    },
  },
];

interface ProviderCall {
  messages: Array<{ role: string; content: unknown }>;
  model: string;
  options: Record<string, unknown>;
}

/** Mock provider: returns the next scripted response as a single text chunk. */
function scriptedProvider(responses: string[], calls: ProviderCall[] = []) {
  return {
    generateTextStream(
      messages: Array<{ role: string; content: unknown }>,
      model: string,
      options: Record<string, unknown>,
    ) {
      calls.push({ messages, model, options });
      const text = responses.shift() ?? "";
      return (async function* () {
        if (text) yield text;
      })();
    },
  };
}

function makeContext(
  provider: unknown,
  overrides: Record<string, unknown> = {},
): AgenticContext {
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const context = {
    options: {
      maxIterations: 6,
      maxTokens: 100000,
      autoApprove: true,
      ...overrides,
    },
    messages: [{ role: "user", content: "What is COF trading at?" }],
    project: "test",
    username: "tester",
    modelDefinition: null,
    agentConversationId: "conv-test",
    conversationId: "conv-test",
    provider,
    providerName: "mock",
    resolvedModel: "mock-model",
    signal: null,
    emit: () => {},
    runtimeTools: { finalTools: TOOLS, resolvedEnabledTools: null },
    runtimeToolExecutor: async (call: { name: string; args: Record<string, unknown> }) => {
      toolCalls.push({ name: call.name, args: call.args });
      return { ticker: call.args.ticker, price: 42.5 };
    },
    requestId: "test-req",
    traceId: "test-trace",
  } as unknown as AgenticContext;
  return Object.assign(context, { _toolCalls: toolCalls }) as AgenticContext & {
    _toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  };
}

async function runHarness(context: AgenticContext) {
  const state = new AgenticLoopState({ originalMessageCount: context.messages.length });
  const harness = new PromptedToolCallingHarness(
    context,
    state,
    context.runtimeTools!,
  );
  return harness.run();
}

function assistantTexts(messages: ConversationMessage[]): string[] {
  return messages
    .filter((m) => m.role === "assistant")
    .map((m) => String(m.content ?? ""));
}

describe("prompted tool call parsing", () => {
  it("extracts and parses a valid block", () => {
    const blocks = extractToolCallBlocks(
      'thinking first\n<tool_call>{"name": "get_market_data", "arguments": {"ticker": "COF"}}</tool_call>',
    );
    expect(blocks).toHaveLength(1);
    const parsed = parsePromptedToolCall(blocks[0]);
    expect(parsed).toEqual({
      ok: true,
      call: { name: "get_market_data", args: { ticker: "COF" } },
    });
  });

  it("parses leniently: whitespace, prose-wrapped JSON, string arguments", () => {
    expect(parsePromptedToolCall('\n  {"name":"x","arguments":{}}  ').ok).toBe(true);
    const wrapped = parsePromptedToolCall('Sure! {"name":"x","arguments":{"a":1}} hope that helps');
    expect(wrapped.ok).toBe(true);
    const stringArgs = parsePromptedToolCall('{"name":"x","arguments":"{\\"a\\":1}"}');
    expect(stringArgs).toEqual({ ok: true, call: { name: "x", args: { a: 1 } } });
  });

  it("reports a structured parse error for malformed JSON", () => {
    const parsed = parsePromptedToolCall('{"name": "x", "arguments": {broken');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("Invalid JSON");
  });

  it("requires a name", () => {
    const parsed = parsePromptedToolCall('{"arguments": {}}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("name");
  });

  it("embeds the tool catalog as OpenAI-format JSON and the scratch_pad discipline", () => {
    const prompt = buildPromptedToolSystemPrompt(TOOLS);
    expect(prompt).toContain("<tools>");
    expect(prompt).toContain('"get_market_data"');
    expect(prompt).toContain("<tool_call>");
    expect(prompt).toContain("<scratch_pad>");
    expect(prompt).toContain("Are the params known yet?");
  });
});

describe("PromptedToolCallingHarness with a mock model", () => {
  it("registers in the harness registry as prompted-xml", () => {
    expect(HarnessRegistry.has("prompted-xml")).toBe(true);
    expect(HarnessRegistry.get("prompted-xml")?.id).toBe("prompted-xml");
  });

  it("completes a tool run without any native tool API", async () => {
    const calls: ProviderCall[] = [];
    const provider = scriptedProvider(
      [
        '<scratch_pad>\nGoal: get COF price.\nAre the params known yet? yes\n</scratch_pad>\n<tool_call>{"name": "get_market_data", "arguments": {"ticker": "COF"}}</tool_call>',
        "COF is trading at 42.5.",
      ],
      calls,
    );
    const context = makeContext(provider);
    const { messages } = await runHarness(context);

    const executed = (context as unknown as { _toolCalls: Array<{ name: string }> })._toolCalls;
    expect(executed).toEqual([{ name: "get_market_data", args: { ticker: "COF" } }]);

    // The provider never receives a native tools parameter...
    for (const call of calls) {
      expect(call.options.tools).toBeUndefined();
    }
    // ...but does receive the embedded catalog in the system prompt.
    const firstSystem = calls[0].messages.find((m) => m.role === "system");
    expect(String(firstSystem?.content)).toContain("get_market_data");

    // The observation was fed back and the final answer breaks the loop.
    const observation = calls[1].messages.at(-1);
    expect(String(observation?.content)).toContain("tool_result");
    expect(assistantTexts(messages)).toContain("COF is trading at 42.5.");
  });

  it("re-prompts exactly once on malformed JSON, then surfaces a structured error", async () => {
    const calls: ProviderCall[] = [];
    const provider = scriptedProvider(
      [
        '<tool_call>{"name": "get_market_data", "arguments": {"ticker": }}</tool_call>',
        '<tool_call>{"name": "get_market_data", "arguments": {"ticker": "COF"}}</tool_call>',
        "COF trades at 42.5.",
      ],
      calls,
    );
    const context = makeContext(provider);
    const { messages } = await runHarness(context);

    // Second model call carries the parse-error repair prompt; the third
    // carries a valid call which then succeeds.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const repairPrompt = calls[1].messages.at(-1);
    expect(String(repairPrompt?.content)).toContain("could not be parsed");
    expect(String(repairPrompt?.content)).toContain("tool_call");

    const executed = (context as unknown as { _toolCalls: Array<{ name: string; args: { ticker?: string } }> })._toolCalls;
    expect(executed).toEqual([{ name: "get_market_data", args: { ticker: "COF" } }]);
    expect(assistantTexts(messages)).toContain("COF trades at 42.5.");
  });

  it("surfaces a structured error observation when the repair fails too", async () => {
    const calls: ProviderCall[] = [];
    const provider = scriptedProvider(
      [
        '<tool_call>{"name": "get_market_data", "arguments": broken</tool_call>',
        'still broken <tool_call>{"name": "get_market_data", "arguments": oops}</tool_call>',
        "Giving up politely.",
      ],
      calls,
    );
    const context = makeContext(provider);
    await runHarness(context);

    const errorObservation = calls[2].messages.at(-1);
    expect(String(errorObservation?.content)).toContain("TOOL_CALL_PARSE_ERROR");
    const executed = (context as unknown as { _toolCalls: unknown[] })._toolCalls;
    expect(executed).toEqual([]);
    // Exactly one repair attempt: the repair prompt appears once in the
    // second model call's message array.
    const repairPrompt = calls[1].messages.filter((m) => String(m.content).includes("could not be parsed"));
    expect(repairPrompt).toHaveLength(1);
  });

  it("executes only the first call when the model emits two, and asks for the next", async () => {
    const calls: ProviderCall[] = [];
    const provider = scriptedProvider(
      [
        '<tool_call>{"name": "get_market_data", "arguments": {"ticker": "COF"}}</tool_call><tool_call>{"name": "get_market_data", "arguments": {"ticker": "AAPL"}}</tool_call>',
        "Both tickers covered.",
      ],
      calls,
    );
    const context = makeContext(provider);
    const { messages } = await runHarness(context);

    const executed = (context as unknown as { _toolCalls: Array<{ args: { ticker: string } }> })._toolCalls;
    expect(executed).toEqual([{ name: "get_market_data", args: { ticker: "COF" } }]);

    const observation = calls[1].messages.at(-1);
    expect(String(observation?.content)).toContain("only the first was executed");
    expect(String(observation?.content)).toContain("Issue the next call");
    expect(assistantTexts(messages)).toContain("Both tickers covered.");
  });

  it("passes reasoning_effort through to the provider call", async () => {
    const calls: ProviderCall[] = [];
    const provider = scriptedProvider(["Final answer, no tools needed."], calls);
    const context = makeContext(provider, { reasoningEffort: "high" });
    await runHarness(context);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.options.reasoningEffort).toBe("high");
    }
  });
});
