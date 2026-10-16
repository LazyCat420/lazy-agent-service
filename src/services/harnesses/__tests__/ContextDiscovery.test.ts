// Tests for ch.06 item 4: context-length discovery on vLLM and the
// calibrated output clamp (ContextBudgets + ContextBudgetTracker, ported
// from prism-service).
import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverContextWindow } from "../../../platform/models/discoverContextWindow.ts";
import { createVllmProvider } from "../../../providers/vllm.ts";
import ContextBudgetTracker from "../ContextBudgetTracker.ts";
import {
  computeContextBudgets,
  estimateRequestInputTokens,
  messageTokenBudget,
} from "../../../services/compact/ContextBudgets.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("context-length discovery (vLLM)", () => {
  it("reads max_model_len from /v1/models", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "Qwen3-32B", max_model_len: 40_960 }],
          }),
          { status: 200 },
        ),
      ) as unknown as typeof fetch,
    );
    expect(await discoverContextWindow("http://localhost:8000", "Qwen3-32B")).toBe(40_960);
  });

  it("falls back to /model_info and the first entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/v1/models")
          ? new Response("{}", { status: 404 })
          : new Response(
              JSON.stringify({ data: { "m": { max_input_tokens: 131_072 } } }),
              { status: 200 },
            ),
      ) as unknown as typeof fetch,
    );
    expect(await discoverContextWindow("http://localhost:8000", "m")).toBe(131_072);
  });

  it("returns undefined when the endpoint says nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })) as unknown as typeof fetch,
    );
    expect(await discoverContextWindow("http://localhost:9", "m")).toBeUndefined();
  });

  it("the vLLM provider writes the discovered window onto options", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/v1/models")
        ? new Response(
            JSON.stringify({ data: [{ id: "Qwen3-32B", max_model_len: 40_960 }] }),
            { status: 200 },
          )
        : new Response("{}", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const provider = createVllmProvider("http://localhost:8000");
    const options: Record<string, unknown> = {};
    await provider.discoverContextWindow?.("Qwen3-32B", options);
    expect(options._loadedContextLength).toBe(40_960);
    // A second call is a no-op (already set) and issues no further probes.
    await provider.discoverContextWindow?.("Qwen3-32B", options);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("ContextBudgetTracker (calibrated output clamp)", () => {
  const emitted: unknown[] = [];
  const tracker = new ContextBudgetTracker(
    (event: unknown) => emitted.push(event),
    32_768,
  );

  it("counts system prompt and tool schemas, not just messages", () => {
    const systemPrompt = "x".repeat(4_000); // ~1000 tokens
    const toolSchemas = [{ name: "t", description: "y".repeat(400) }];
    const { clampedMaxTokens } = tracker.computeAndEmitEstimate(
      30_000,
      systemPrompt,
      toolSchemas,
      8_192,
    );
    // 30k messages + ~1k prompt + schema tokens + 10% safety + 1024 headroom
    // must leave less than 8192 for output on a 32k window.
    expect(clampedMaxTokens).toBeLessThan(8_192);
    expect(clampedMaxTokens).toBeGreaterThanOrEqual(1_024);
    const snapshot = tracker.getSnapshot();
    expect(snapshot?.systemPromptTokens).toBeGreaterThan(0);
    expect(snapshot?.toolSchemaTokens).toBeGreaterThan(0);
    expect(snapshot?.source).toBe("estimated");
  });

  it("calibrates the estimate from reported usage", () => {
    const before = tracker.getCalibrationRatio();
    tracker.recordRealUsage(
      {
        inputTokens: 60_000,
        outputTokens: 100,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      30_000,
    );
    // real (60k + prompt + schemas) ÷ estimated (~31k) — clamped to [0.5, 2]
    expect(tracker.getCalibrationRatio()).toBeGreaterThan(before ?? 0);
    expect(tracker.getCalibrationRatio()).toBeLessThanOrEqual(2);
    expect(tracker.getSnapshot()?.source).toBe("reported");
    expect(emitted.length).toBeGreaterThanOrEqual(2);
  });

  it("ignores usage without input tokens", () => {
    const tracker2 = new ContextBudgetTracker(() => {}, 32_768);
    tracker2.recordRealUsage({ inputTokens: 0, outputTokens: 5 }, 100);
    expect(tracker2.getCalibrationRatio()).toBeNull();
  });
});

describe("ContextBudgets (unified window)", () => {
  it("keeps the truncation budget at or above the compaction threshold", () => {
    for (const [window, output] of [
      [128_000, 16_384],
      [200_000, 64_000],
      [32_768, 8_192],
    ] as const) {
      const budgets = computeContextBudgets(window, output);
      expect(budgets.autoCompactThreshold).toBeLessThanOrEqual(
        budgets.truncationBudget,
      );
      expect(budgets.effectiveWindow).toBeLessThanOrEqual(window);
    }
  });

  it("round-trips estimate and message budget in the same units", () => {
    const inputs = {
      overheadTokens: 2_000,
      baseline: { inputTokens: 50_000, messageTokens: 47_000 },
      calibrationRatio: null,
    };
    const estimate = estimateRequestInputTokens({
      ...inputs,
      messageTokens: 49_000,
    });
    expect(estimate.source).toBe("reported");
    // Reported 50k over 49k estimated (47k messages + 2k overhead):
    // ratio ≈ 1.0204, so +2k messages ⇒ +2_041 tokens.
    expect(estimate.tokens).toBe(52_041);
    expect(messageTokenBudget(51_000, inputs)).toBe(47_980);
  });
});
