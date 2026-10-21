/**
 * Soft deadline (2026-10-17): a run approaching its wall-clock limit must
 * answer with the evidence it has instead of being killed by DEADLINE_EXCEEDED.
 *
 * When `context.finalizeRequested` is set (by RunExecutionEngine's soft-deadline
 * timer), ReActHarness skips further tool iterations and routes through the
 * ExhaustionRecovery final pass: tools still sent, `tool_choice: "none"`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../wrappers/MongoWrapper.ts", () => {
  class MongoWrapper {
    static getDb() { return null; }
    static getCollection() { return null; }
    static getClient() { return null; }
  }
  return { default: MongoWrapper };
});
vi.mock("../platform/trace/TraceExporter.ts", () => {
  class TraceExporter {
    private static instance = new TraceExporter();
    static getGlobalInstance() { return TraceExporter.instance; }
    enqueueSpan() {}
    getQueuedSpans() { return []; }
  }
  return { TraceExporter };
});

import ReActHarness from "../harnesses/ReActHarness.ts";
import { CanonicalProviderBudget } from "../CanonicalProviderBudget.ts";
import AgenticLoopState from "../AgenticLoopState.ts";
import type { AgenticContext, ConversationMessage } from "../harnesses/types.ts";

type ProviderCall = { messages: unknown[]; model: string; options: Record<string, unknown> };

/**
 * A provider that would answer with a tool call in normal mode (dragging the
 * loop on), but produces a final answer in the tool-free final pass.
 */
function finalizeAwareProvider(calls: ProviderCall[] = []) {
  return {
    generateTextStream(messages: unknown[], model: string, options: Record<string, unknown>) {
      calls.push({ messages, model, options });
      const final = options.toolChoice === "none";
      return (async function* () {
        if (final) yield "Final answer from gathered evidence.";
        else yield { type: "toolCall", id: "t1", name: "search_web", args: { q: "news" } };
      })();
    },
  };
}

function makeContext(provider: unknown): AgenticContext {
  return {
    options: {
      maxIterations: 8, maxTokens: 100000, autoApprove: true,
      tools: [{ name: "search_web", description: "Search the web", parameters: { type: "object", properties: {} } }],
    },
    messages: [{ role: "user", content: "What happened in the news today?" }] as ConversationMessage[],
    project: "battle",
    username: "tester",
    modelDefinition: null,
    agentConversationId: "conv-soft-deadline",
    conversationId: "conv-soft-deadline",
    provider,
    providerName: "mock",
    resolvedModel: "mock-model",
    signal: null,
    emit: () => {},
    runtimeTools: {
      finalTools: [{ name: "search_web", description: "Search the web", parameters: { type: "object", properties: {} } }],
      resolvedEnabledTools: null,
    },
    runtimeToolExecutor: async () => ({ ok: true }),
    requestId: "soft-deadline-req",
    traceId: "soft-deadline-trace",
    finalizeRequested: { reason: "DEADLINE_SOFT" },
  } as unknown as AgenticContext;
}

describe("ReActHarness honours context.finalizeRequested", () => {
  it("skips tool iterations and runs the tool_choice:none final pass, returning a non-empty answer", async () => {
    const calls: ProviderCall[] = [];
    const provider = finalizeAwareProvider(calls);
    const context = makeContext(provider);
    const state = new AgenticLoopState({ originalMessageCount: context.messages!.length });
    const harness = new ReActHarness(context, state, context.runtimeTools!);

    const { messages } = await harness.run();

    // Exactly one model call — the final pass. No tool iteration ran.
    expect(calls).toHaveLength(1);
    expect(calls[0].options.toolChoice).toBe("none");
    // Tools are still sent; only calling is off.
    expect((calls[0].options.tools as Array<{ name: string }>).map((tool) => tool.name)).toContain("search_web");
    expect(state.conversationOutcome).toBe("exhausted");
    expect(messages.some((m) => m.role === "assistant" && String(m.content || "").trim().length > 0)).toBe(true);
    expect(messages.some((m) => String(m.content || "").includes("Final answer from gathered evidence."))).toBe(true);
  });

  it("a mid-loop TOKEN_BUDGET_FINALIZE exits the iteration loop and runs the final pass", async () => {
    const calls: ProviderCall[] = [];
    const provider = {
      generateTextStream(messages: unknown[], model: string, options: Record<string, unknown>) {
        calls.push({ messages, model, options });
        if (calls.length === 2) {
          // Real budget proxy throws on the first next() of the stream.
          return (async function* () {
            yield await Promise.reject(Object.assign(new Error("budget"), { code: "TOKEN_BUDGET_FINALIZE" }));
          })();
        }
        return (async function* () {
          if (calls.length === 3) yield "final answer";
          else yield { type: "toolCall", id: "t1", name: "search_web", args: { q: "news" } };
        })();
      },
    };
    const context = makeContext(provider);
    if ("finalizeRequested" in context) delete context.finalizeRequested;
    const budget = new CanonicalProviderBudget(4000, new AbortController().signal);
    const allowFinalPass = vi.spyOn(budget, "allowFinalPass");
    // Test seam: AgenticContext carries the budget on its index signature.
    context.canonicalBudget = budget;
    const state = new AgenticLoopState({ originalMessageCount: context.messages!.length });
    state.loadedTools.add("search_web");
    const harness = new ReActHarness(context, state, context.runtimeTools!);

    const { messages } = await harness.run();

    expect(allowFinalPass).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(3);
    expect(calls[2].options.toolChoice).toBe("none");
    expect(messages.some((m) => String(m.content || "").includes("Context window exhausted"))).toBe(false);
    expect(messages.some((m) => m.role === "assistant" && String(m.content || "").includes("final answer"))).toBe(true);
  });
});
