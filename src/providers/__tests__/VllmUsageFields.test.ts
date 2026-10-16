/**
 * Contract audit 2026-10-16 F3 — vLLM usage must keep cache/reasoning counts.
 *
 * normalizeUsage maps `prompt_tokens_details.cached_tokens` →
 * `cacheReadInputTokens` (and nets it out of `inputTokens`) and
 * `completion_tokens_details.reasoning_tokens` → `reasoningOutputTokens`.
 * The vLLM provider used to rebuild usage from inputTokens/outputTokens only,
 * so trading's `extract_cached_tokens` always saw 0 and its prompt_tokens
 * (which reads `totalInputTokens` first) under-counted by the cached share.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createVllmProvider } from "../vllm.ts";
import { withTotalInputTokens } from "../../utils/CostCalculator.ts";
import BaseAgenticHarness from "../../services/harnesses/BaseAgenticHarness.ts";
import { finalizeTextGeneration } from "../../services/harnesses/lifecycle/Finalizer.ts";

const VLLM_USAGE = {
  prompt_tokens: 1000,
  completion_tokens: 300,
  total_tokens: 1300,
  prompt_tokens_details: { cached_tokens: 800 },
  completion_tokens_details: { reasoning_tokens: 120 },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(events: unknown[]): Response {
  const body =
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("vLLM provider usage", () => {
  it("non-streaming generateText keeps cacheReadInputTokens and reasoningOutputTokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
          usage: VLLM_USAGE,
        }),
      ),
    );
    const provider = createVllmProvider("http://vllm.test");
    const result = await provider.generateText!([{ role: "user", content: "hi" }], "m");
    expect(result.usage).toMatchObject({
      inputTokens: 200,
      outputTokens: 300,
      cacheReadInputTokens: 800,
      reasoningOutputTokens: 120,
    });
  });

  it("streaming usage chunk keeps cacheReadInputTokens and reasoningOutputTokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          { choices: [], usage: VLLM_USAGE },
        ]),
      ),
    );
    const provider = createVllmProvider("http://vllm.test");
    const usageChunks: unknown[] = [];
    for await (const chunk of provider.generateTextStream!(
      [{ role: "user", content: "hi" }],
      "m",
    )) {
      if (typeof chunk === "object" && chunk.type === "usage") usageChunks.push(chunk.usage);
    }
    expect(usageChunks.length).toBeGreaterThan(0);
    expect(usageChunks.at(-1)).toMatchObject({
      inputTokens: 200,
      outputTokens: 300,
      cacheReadInputTokens: 800,
      reasoningOutputTokens: 120,
    });
  });
});

describe("totalInputTokens on emitted usage", () => {
  it("withTotalInputTokens sums net input + cache read + cache creation", () => {
    expect(
      withTotalInputTokens({
        inputTokens: 200,
        cacheReadInputTokens: 800,
        cacheCreationInputTokens: 5,
        outputTokens: 1,
      }),
    ).toMatchObject({ totalInputTokens: 1005, inputTokens: 200 });
    expect(withTotalInputTokens(null)).toBeNull();
  });

  it("usage_update carries totalInputTokens", () => {
    const events: Array<Record<string, unknown>> = [];
    const fakeHarness = {
      context: { emit: (e: Record<string, unknown>) => events.push(e), resolvedModel: "m" },
      state: {
        overallUsage: { inputTokens: 200, outputTokens: 300, cacheReadInputTokens: 800 },
        iterations: 2,
      },
    };
    BaseAgenticHarness.prototype.emitUsageUpdate.call(
      fakeHarness as unknown as BaseAgenticHarness,
    );
    expect(events).toHaveLength(1);
    expect(events[0].usage).toMatchObject({
      inputTokens: 200,
      cacheReadInputTokens: 800,
      totalInputTokens: 1000,
      requests: 2,
    });
  });

  it("done carries totalInputTokens", async () => {
    const events: Array<Record<string, unknown>> = [];
    await finalizeTextGeneration(
      {
        providerName: "vllm",
        resolvedModel: "m",
        messages: [],
        options: { agenticLoopEnabled: true },
        conversationId: null,
        emit: (e) => events.push(e),
      },
      {
        text: "OK",
        thinking: null,
        usage: {
          inputTokens: 200,
          outputTokens: 300,
          cacheReadInputTokens: 800,
          reasoningOutputTokens: 120,
        },
      },
    );
    const done = events.find((e) => e.type === "done");
    expect(done?.usage).toMatchObject({
      inputTokens: 200,
      cacheReadInputTokens: 800,
      reasoningOutputTokens: 120,
      totalInputTokens: 1000,
    });
  });
});
