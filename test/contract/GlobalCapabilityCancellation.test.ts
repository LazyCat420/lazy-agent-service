import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/NewsSearchService.ts", () => ({
  newsSearch: vi.fn((_query: string, _limit: number, _country: string | undefined, _category: string | undefined, _debug: unknown, signal?: AbortSignal) =>
    new Promise((_resolve, reject) => {
      if (signal?.aborted) reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    })),
}));

import { GlobalCapabilityExecutor } from "../../src/services/GlobalCapabilityExecutor.ts";

afterEach(() => vi.unstubAllGlobals());

function hangingFetch() {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  }));
}

describe("global capability cancellation", () => {
  it("cancels an in-flight news search through its provider signal", async () => {
    const controller = new AbortController();
    const pending = GlobalCapabilityExecutor.execute("global.web.search", { query: "fixture" }, controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ success: false, error: { code: "CAPABILITY_CANCELLED" } });
  });

  it("aborts page and metadata network requests and cleans up their timers", async () => {
    const fetch = hangingFetch();
    vi.stubGlobal("fetch", fetch);

    for (const capabilityId of ["global.web.read_page", "global.web.fetch_metadata"]) {
      const controller = new AbortController();
      const pending = GlobalCapabilityExecutor.execute(capabilityId, { url: "https://fixture.test/page" }, controller.signal);
      controller.abort();
      await expect(pending).resolves.toMatchObject({ success: false, error: { code: "CAPABILITY_CANCELLED" } });
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
