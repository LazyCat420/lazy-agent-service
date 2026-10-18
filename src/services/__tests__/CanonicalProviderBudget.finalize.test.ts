/**
 * Final-reserve budget behaviour (soft token budget, 2026-10-17).
 *
 * Measured: the reservation was Buffer.byteLength(JSON) treated as TOKENS —
 * a several-fold overcount that killed runs with TOKEN_BUDGET_EXHAUSTED while
 * the model already had evidence in hand. Now: chars/3.5 estimate, a final
 * reserve kept for a tool-free answer pass, and TOKEN_BUDGET_FINALIZE instead
 * of a hard kill.
 */
import { describe, expect, it } from "vitest";

import { CanonicalProviderBudget } from "../CanonicalProviderBudget.ts";

type UsageChunk = { type: "usage"; usage: { inputTokens: number; outputTokens: number } };
type Chunk = string | UsageChunk;

function fakeProvider(script: Chunk[][], recorded?: Record<string, unknown>[]) {
  let call = 0;
  return {
    generateTextStream(_messages: unknown[], _model: string, options: Record<string, unknown>) {
      recorded?.push(options);
      const chunks = script[call++] ?? [];
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) { /* consume */ }
}

const USAGE: UsageChunk = { type: "usage", usage: { inputTokens: 120, outputTokens: 30 } };

describe("CanonicalProviderBudget finalize reserve", () => {
  it("reserves chars/3.5 + 256, not bytes; measured usage is what is charged", async () => {
    // 4000 chars of payload → ~1155 + 256 estimated tokens; with room for the final pass (2× prompt + 600) still under 4000.
    const message = "x".repeat(4000);
    const budget = new CanonicalProviderBudget(4000, new AbortController().signal);
    const provider = budget.wrap(fakeProvider([[ "answer", USAGE ]]));
    await drain(provider.generateTextStream([{ role: "user", content: message }], "m", {}));
    expect(budget.chargedTokens).toBe(150);
    expect(budget.inputTokens).toBe(120);
    expect(budget.outputTokens).toBe(30);
    expect(budget.measuredCalls).toBe(1);
  });

  it("throws TOKEN_BUDGET_FINALIZE when a normal call cannot fit, then succeeds after allowFinalPass", async () => {
    const budget = new CanonicalProviderBudget(4000, new AbortController().signal);
    // Charge 3500 measured tokens: inputReserve(272) + 15% final reserve (600) leaves nothing for a normal call.
    budget.chargeExternalUsage(3500, 0);
    const provider = budget.wrap(fakeProvider([["final", USAGE]]));
    await expect(
      drain(provider.generateTextStream([{ role: "user", content: "hi" }], "m", {})),
    ).rejects.toMatchObject({ code: "TOKEN_BUDGET_FINALIZE" });

    budget.allowFinalPass();
    await drain(provider.generateTextStream([{ role: "user", content: "hi" }], "m", {}));
    // Measured reconciliation: the reservation is replaced by the real usage (3500 + 150).
    expect(budget.chargedTokens).toBe(3650);
  });

  it("never refuses the final pass, even past the limit; output capped at the final reserve", async () => {
    const budget = new CanonicalProviderBudget(4000, new AbortController().signal);
    budget.chargeExternalUsage(3990, 0);
    budget.allowFinalPass();
    const recorded: Record<string, unknown>[] = [];
    const provider = budget.wrap(fakeProvider([["final", USAGE]], recorded));
    await drain(provider.generateTextStream([{ role: "user", content: "hi" }], "m", { maxTokens: 9999 }));
    expect(recorded[0].maxTokens).toBe(600);
    expect(budget.chargedTokens).toBe(3990 + 150);
  });

  it("a normal call finalizes when it would leave no room for the final pass's prompt", async () => {
    const budget = new CanonicalProviderBudget(4000, new AbortController().signal);
    budget.chargeExternalUsage(2000, 0);
    const provider = budget.wrap(fakeProvider([["final", USAGE]]));
    await expect(
      drain(provider.generateTextStream([{ role: "user", content: "x".repeat(3500) }], "m", {})),
    ).rejects.toMatchObject({ code: "TOKEN_BUDGET_FINALIZE" });

    const fresh = new CanonicalProviderBudget(4000, new AbortController().signal);
    fresh.chargeExternalUsage(0, 0);
    const freshProvider = fresh.wrap(fakeProvider([["final", USAGE]]));
    await drain(freshProvider.generateTextStream([{ role: "user", content: "x".repeat(3500) }], "m", {}));
  });
});
