import { describe, expect, it } from "vitest";
import { CanonicalProviderBudget } from "../CanonicalProviderBudget";

type StreamOptions = { signal?: AbortSignal };

function makeProvider() {
  const recorded: (StreamOptions | undefined)[] = [];
  const provider = {
    async *generateTextStream(_messages: unknown[], _model: string, options: StreamOptions = {}) {
      recorded.push(options);
      const signal = options.signal;
      yield "a";
      await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason));
      });
    },
  };
  return { provider, recorded };
}

describe("CanonicalProviderBudget signal composition", () => {
  it("propagates a per-call abort signal to the provider and rejects iteration", async () => {
    const run = new AbortController();
    const budget = new CanonicalProviderBudget(1_000_000, run.signal);
    const { provider, recorded } = makeProvider();
    const perCall = new AbortController();
    const iter = budget.wrap(provider).generateTextStream([], "m", { signal: perCall.signal })[Symbol.asyncIterator]();
    await iter.next();
    perCall.abort();
    await expect(iter.next()).rejects.toMatchObject({ message: "This operation was aborted" });
    expect(recorded[0]?.signal).not.toBe(run.signal);
    expect(recorded[0]?.signal?.aborted).toBe(true);
  });

  it("passes the budget run signal when no per-call signal is given", async () => {
    const run = new AbortController();
    const budget = new CanonicalProviderBudget(1_000_000, run.signal);
    const { provider, recorded } = makeProvider();
    const iter = budget.wrap(provider).generateTextStream([], "m", {})[Symbol.asyncIterator]();
    await iter.next();
    expect(recorded[0]?.signal).toBe(run.signal);
    iter.return?.(undefined).catch(() => {});
  });
});
