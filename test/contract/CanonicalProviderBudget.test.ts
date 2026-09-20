import { expect, it } from "vitest";
import { CanonicalProviderBudget } from "../../src/services/CanonicalProviderBudget.ts";
const consume = async (stream: AsyncIterable<unknown>) => { for await (const _ of stream) {} };
it("keeps missing usage unknown and charges a bounded reservation", async () => {
  const budget = new CanonicalProviderBudget(1000, new AbortController().signal);
  const provider = budget.wrap({ async *generateTextStream() { yield { type: "chunk", content: "answer" }; } });
  await consume(provider.generateTextStream([], "fixture", { maxTokens: 100 }));
  expect(budget.usage(0, 1).total_tokens).toBeNull();
  expect(budget.chargedTokens).toBeGreaterThan(100);
});
it("counts every model call and refuses a later call after budget exhaustion", async () => {
  const budget = new CanonicalProviderBudget(700, new AbortController().signal);
  const provider = budget.wrap({ async *generateTextStream() { yield { type: "usage", usage: { inputTokens: 300, outputTokens: 200 } }; } });
  await consume(provider.generateTextStream([], "fixture", { maxTokens: 200 }));
  expect(budget.usage(0, 1).total_tokens).toBe(500);
  await expect(consume(provider.generateTextStream([], "fixture", {}))).rejects.toThrow("next prompt");
  expect(budget.calls).toBe(1);
});
it("retains partial measured coverage and cancels every wrapped call", async () => {
  const controller = new AbortController();
  const budget = new CanonicalProviderBudget(5000, controller.signal);
  let call = 0;
  const provider = budget.wrap({ async *generateTextStream() { if (++call === 1) yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } }; } });
  await consume(provider.generateTextStream([], "fixture", { maxTokens: 100 }));
  await consume(provider.generateTextStream([], "fixture", { maxTokens: 100 }));
  expect(budget.usage(0, 1).coverage.state).toBe("partial");
  expect(budget.usage(0, 1).total_tokens).toBeNull();
  controller.abort();
  await expect(consume(provider.generateTextStream([], "fixture", {}))).rejects.toThrow();
});
it("keeps per-call output caps separate from the total run budget on every generation", async () => {
  const budget = new CanonicalProviderBudget(65536, new AbortController().signal, 8192);
  const caps: number[] = [];
  const generate = async function* (_messages: unknown[], _model: string, options: any) {
    caps.push(options.maxTokens);
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } };
  };
  const provider = budget.wrap({ generateTextStream: generate, generateTextStreamLive: generate });
  await consume(provider.generateTextStream([], "fixture", { maxTokens: 65536 }));
  await consume(provider.generateTextStreamLive([], "fixture", { maxTokens: 65536 }));
  expect(caps).toEqual([8192, 8192]);
  expect(budget.chargedTokens).toBe(240);
});
