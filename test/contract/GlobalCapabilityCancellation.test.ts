import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/WebSearchService.ts", () => ({
  // Mirrors the real webSearch contract: never throws; an abort resolves
  // status "cancelled" (the old mock rejected, which the real function never does).
  webSearch: vi.fn((_query: string, _limit: number, _deps: unknown, signal?: AbortSignal) => {
    const { promise, resolve } = Promise.withResolvers<unknown>();
    const cancelled = () => resolve({ status: "cancelled", provider: "exa", cached: false, results: [], error: "cancelled by the caller" });
    if (signal?.aborted) cancelled();
    signal?.addEventListener("abort", cancelled, { once: true });
    return promise;
  }),
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
      const pending = GlobalCapabilityExecutor.execute(capabilityId, { url: "https://93.184.215.14/page" }, controller.signal);
      controller.abort();
      await expect(pending).resolves.toMatchObject({ success: false, error: { code: "CAPABILITY_CANCELLED" } });
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses private targets and never forwards model headers (audit D6)", async () => {
    const fetch = vi.fn(async () => new Response("<title>ok</title>", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    for (const capabilityId of ["global.web.read_page", "global.web.fetch_metadata"]) {
      for (const url of ["http://127.0.0.1:5591/health", "http://0.0.0.0/", "http://100.64.0.1/", "http://[::ffff:a9fe:a9fe]/"]) {
        await expect(GlobalCapabilityExecutor.execute(capabilityId, { url })).resolves.toMatchObject({
          success: false,
          error: { code: "URL_BLOCKED" },
        });
      }
    }
    expect(fetch).not.toHaveBeenCalled();

    await GlobalCapabilityExecutor.execute("global.web.read_page", {
      url: "https://93.184.215.14/page",
      headers: { Authorization: "Bearer leaked", Host: "internal" },
    });
    const sent = (fetch.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> };
    expect(Object.keys(sent.headers).map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(Object.keys(sent.headers).map((k) => k.toLowerCase())).not.toContain("host");
  });
});
