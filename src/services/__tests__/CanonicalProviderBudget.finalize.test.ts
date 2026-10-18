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

function fakeProvider(script: Chunk[][]) {
  let call = 0;
  return {
    generateTextStream(_messages: unknown[], _model: string, _options: Record<string, unknown>) {
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
    // 7000 chars of payload → ~2000 + 256 estimated tokens, well under 4000.
    const message = "x".repeat(7000);
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

  it("throws TOKEN_BUDGET_EXHAUSTED when even the final reserve cannot cover the call", async () => {
    const budget = new CanonicalProviderBudget(4000, new AbortController().signal);
    budget.chargeExternalUsage(3990, 0);
    budget.allowFinalPass();
    const provider = budget.wrap(fakeProvider([["final", USAGE]]));
    await expect(
      drain(provider.generateTextStream([{ role: "user", content: "hi" }], "m", {})),
    ).rejects.toMatchObject({ code: "TOKEN_BUDGET_EXHAUSTED" });
  });
});
