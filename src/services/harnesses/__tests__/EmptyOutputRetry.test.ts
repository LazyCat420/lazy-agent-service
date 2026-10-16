/**
 * ch.06 item 8 — empty model outputs are retried in-loop.
 *
 * Measured 2026-10-07: 1 of 6 box-pinned V3 replays on our loop ended as an
 * empty GLM reply after one model call; prism retries empty outputs in-loop
 * (MAX_EMPTY_OUTPUT_RETRIES with a temperature bump and a tagged nudge).
 * Until now our ReActHarness broke the turn on the first genuinely empty
 * pass.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../wrappers/MongoWrapper.ts", () => {
  class MongoWrapper {
    static getDb() { return null; }
    static getCollection() { return null; }
    static getClient() { return null; }
  }
  return { default: MongoWrapper };
});
vi.mock("../../../platform/trace/TraceExporter.ts", () => {
  class TraceExporter {
    private static instance = new TraceExporter();
    static getGlobalInstance() { return TraceExporter.instance; }
    enqueueSpan() {}
    getQueuedSpans() { return []; }
  }
  return { TraceExporter };
});

import ReActHarness from "../ReActHarness.ts";
import AgenticLoopState from "../../AgenticLoopState.ts";
import type { AgenticContext, ConversationMessage } from "../types.ts";

type ProviderCall = { messages: unknown[]; model: string; options: Record<string, unknown> };

function scriptedProvider(responses: unknown[], calls: ProviderCall[] = []) {
  return {
    generateTextStream(messages: unknown[], model: string, options: Record<string, unknown>) {
      calls.push({ messages, model, options });
      const chunk = responses.shift();
      return (async function* () {
        if (typeof chunk === "string") { if (chunk) yield chunk; }
        else if (chunk) yield chunk;
      })();
    },
  };
}

function makeContext(provider: unknown): AgenticContext {
  return {
    options: { maxIterations: 8, maxTokens: 100000, autoApprove: true },
    messages: [{ role: "user", content: "Replay the V3 cycle" }] as ConversationMessage[],
    project: "battle",
    username: "tester",
    modelDefinition: null,
    agentConversationId: "conv-empty",
    conversationId: "conv-empty",
    provider,
    providerName: "mock",
    resolvedModel: "mock-model",
    signal: null,
    emit: () => {},
    runtimeTools: { finalTools: [], resolvedEnabledTools: null },
    runtimeToolExecutor: async () => ({ ok: true }),
    requestId: "empty-req",
    traceId: "empty-trace",
  } as unknown as AgenticContext;
}

describe("ReActHarness: empty output retried in-loop", () => {
  it("an empty reply is followed by a tagged nudge and a retry that completes the turn", async () => {
    const calls: ProviderCall[] = [];
    const provider = scriptedProvider(["", "Final answer."], calls);
    const context = makeContext(provider);
    const state = new AgenticLoopState({ originalMessageCount: context.messages!.length });
    const harness = new ReActHarness(context, state, context.runtimeTools!);

    const { messages } = await harness.run();

    // Two model passes: the empty one, then the recovery.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const nudges = calls[1].messages.filter(
      (message) =>
        (message as { role?: string }).role === "system" &&
        String((message as { content?: string }).content).includes(
          "empty-output-recovery",
        ),
    );
    expect(nudges.length).toBeGreaterThanOrEqual(1);
    expect(messages.some((m) => m.role === "assistant" && m.content === "Final answer.")).toBe(true);
    expect(state.conversationOutcome).toBe("completed");
  });

  it("empty output recovery exhausts after MAX_EMPTY_OUTPUT_RETRIES instead of looping forever", async () => {
    const calls: ProviderCall[] = [];
    const provider = scriptedProvider(new Array(20).fill(""), calls);
    const context = makeContext(provider);
    const state = new AgenticLoopState({ originalMessageCount: context.messages!.length });
    const harness = new ReActHarness(context, state, context.runtimeTools!);

    await harness.run().catch(() => {
      /* INCOMPLETE_RUN after recovery exhausts is acceptable — the point is the bounded retries */
    });
    // 1 initial pass + MAX_EMPTY_OUTPUT_RETRIES retries — not 20.
    expect(calls.length).toBeLessThanOrEqual(6);
  });
});
