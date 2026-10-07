/**
 * RunningSummary — running-summary discipline tests (PLAN_hermes.md §3).
 *
 *   - latest <running_summary> block wins, stale ones never duplicate
 *   - system messages are skipped when scanning for model-emitted blocks
 *   - the PromptedToolCallingHarness carries the newest block forward into
 *     the next turn's system prompt
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

vi.mock("../RequestLogger.ts", () => ({
  default: {
    insertPending: async () => null,
    logChatGeneration: async () => {},
    log: async () => {},
  },
}));

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
} from "../PromptedToolCallingHarness.ts";
import AgenticLoopState from "../../AgenticLoopState.ts";
import {
  RUNNING_SUMMARY_INSTRUCTIONS,
  applyRunningSummary,
  extractLatestRunningSummary,
  extractRunningSummary,
} from "../RunningSummary.ts";
import type { AgenticContext, ConversationMessage, ToolSchema } from "../types.ts";

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
    runtimeToolExecutor: async () => ({ price: 42.5 }),
    requestId: "test-req",
    traceId: "test-trace",
  } as unknown as AgenticContext;
  return context;
}

function systemPromptOf(calls: ProviderCall[], index: number): string {
  const system = calls[index].messages.find((m) => m.role === "system");
  return String(system?.content ?? "");
}

describe("extractRunningSummary (pure)", () => {
  it("extracts the single block", () => {
    const summary = extractRunningSummary(
      "prose before\n<running_summary>\nfound X\n</running_summary>\nprose after",
    );
    expect(summary).toBe("found X");
  });

  it("extracts the LAST block when several are present", () => {
    const summary = extractRunningSummary(
      "<running_summary>\nold\n</running_summary>\nmid text\n<running_summary>\nnewest\n</running_summary>",
    );
    expect(summary).toBe("newest");
  });

  it("returns null when no block is present", () => {
    expect(extractRunningSummary("plain answer")).toBeNull();
  });
});

describe("extractLatestRunningSummary (pure)", () => {
  it("scans newest-first and skips system messages", () => {
    const messages: Array<Pick<ConversationMessage, "role" | "content">> = [
      { role: "system", content: "<running_summary>\nstale injected copy\n</running_summary>" },
      { role: "user", content: "go on" },
      { role: "assistant", content: "<running_summary>\nolder model block\n</running_summary>" },
      { role: "user", content: "<tool_result>ok</tool_result>" },
      { role: "assistant", content: "findings\n<running_summary>\nnewest model block\n</running_summary>" },
    ];
    expect(extractLatestRunningSummary(messages)).toBe("newest model block");
  });

  it("returns null when only system messages carry a block", () => {
    const messages: Array<Pick<ConversationMessage, "role" | "content">> = [
      { role: "system", content: "<running_summary>\ninjected\n</running_summary>" },
      { role: "user", content: "hi" },
    ];
    expect(extractLatestRunningSummary(messages)).toBeNull();
  });
});

describe("applyRunningSummary (pure)", () => {
  it("replaces an existing block in place — no stale duplicates", () => {
    const prompt = `<tools>catalog</tools>\n<running_summary>\nSTALE\n</running_summary>\nrules`;
    const updated = applyRunningSummary(prompt, "fresh findings");
    expect(updated).toContain("fresh findings");
    expect(updated).not.toContain("STALE");
    expect(updated.match(/<running_summary>/g)).toHaveLength(1);
  });

  it("replaces EVERY existing block when several crept in", () => {
    const prompt = "<running_summary>\na\n</running_summary>\n<running_summary>\nb\n</running_summary>";
    const updated = applyRunningSummary(prompt, "only this");
    expect(updated.match(/<running_summary>/g)).toHaveLength(1);
    expect(updated).toContain("only this");
  });

  it("appends the block when the prompt has none", () => {
    const updated = applyRunningSummary("system rules", "first findings");
    expect(updated.startsWith("system rules")).toBe(true);
    expect(updated).toContain("<running_summary>\nfirst findings\n</running_summary>");
  });
});

describe("PromptedToolCallingHarness carries the running summary forward", () => {
  it("injects the newest model-emitted summary into the next turn's system prompt", async () => {
    const calls: ProviderCall[] = [];
    const provider = scriptedProvider(
      [
        'Looking it up.\n<running_summary>\nCOF price unknown\n</running_summary>\n<tool_call>{"name": "get_market_data", "arguments": {"ticker": "COF"}}</tool_call>',
        "Findings so far.\n<running_summary>\nCOF trades at 42.5; trend bullish\n</running_summary>\nAll done.",
      ],
      calls,
    );
    const context = makeContext(provider);
    const harness = new PromptedToolCallingHarness(
      context,
      new AgenticLoopState({ originalMessageCount: 1 }),
      context.runtimeTools,
    );
    await harness.run();

    // The first turn's system prompt teaches the discipline but carries no
    // model summary yet.
    expect(systemPromptOf(calls, 0)).toContain(RUNNING_SUMMARY_INSTRUCTIONS);
    expect(systemPromptOf(calls, 0)).not.toContain("COF price unknown");

    // Second turn: the newest model-emitted summary was carried forward in
    // the LAST complete block (the instructions embed a format example).
    const secondPrompt = systemPromptOf(calls, 1);
    const blocks = secondPrompt.match(/<running_summary>[\s\S]*?<\/running_summary>/g) ?? [];
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks.at(-1)).toBe("<running_summary>\nCOF price unknown\n</running_summary>");
  });
});

describe("buildPromptedToolSystemPrompt embeds the running-summary discipline", () => {
  it("includes the carry-forward rule", () => {
    const prompt = buildPromptedToolSystemPrompt(TOOLS);
    expect(prompt).toContain("<running_summary>");
    expect(prompt).toContain("carried forward");
  });
});
