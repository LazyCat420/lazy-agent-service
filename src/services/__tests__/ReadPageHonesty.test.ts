/**
 * Honest read_page (2026-10-17): HTTP failures and JS-only pages must come
 * back as structured errors the model can act on, not as success:true with
 * "Failed to fetch" text disguised as page content.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/UrlSafety.ts", () => {
  class UnsafeUrlError extends Error {}
  return {
    UnsafeUrlError,
    safeFetch: vi.fn(),
    allowPrivateUrls: () => false,
    isPrivateAddress: () => false,
    assertPublicUrl: vi.fn(),
  };
});

import { GlobalCapabilityExecutor } from "../GlobalCapabilityExecutor.ts";
import { safeFetch, type SafeFetchResult } from "../../utils/UrlSafety.ts";

const mockFetch = vi.mocked(safeFetch);

afterEach(() => {
  vi.restoreAllMocks();
  mockFetch.mockReset();
});

describe("global.web.read_page honesty", () => {
  it("returns HTTP_ERROR failure on 404", async () => {
    const result: SafeFetchResult = { ok: false, status: 404, statusText: "Not Found", url: "https://example.com/missing", headers: new Headers(), text: "", truncated: false };
    mockFetch.mockResolvedValue(result);
    const executed = await GlobalCapabilityExecutor.execute("global.web.read_page", { url: "https://example.com/missing" }, undefined);
    expect(executed.success).toBe(false);
    expect(executed.error?.code).toBe("HTTP_ERROR");
    expect(executed.error?.message).toContain("HTTP 404");
  });

  it("returns EMPTY_CONTENT failure when only scripts are stripped", async () => {
    const result: SafeFetchResult = { ok: true, status: 200, statusText: "OK", url: "https://example.com", headers: new Headers(), text: "<html><body><script>x</script></body></html>", truncated: false };
    mockFetch.mockResolvedValue(result);
    const executed = await GlobalCapabilityExecutor.execute("global.web.read_page", { url: "https://example.com" }, undefined);
    expect(executed.success).toBe(false);
    expect(executed.error?.code).toBe("EMPTY_CONTENT");
  });

  it("returns success with content for a real text page", async () => {
    const paragraph = "A".repeat(1000);
    const result: SafeFetchResult = { ok: true, status: 200, statusText: "OK", url: "https://example.com", headers: new Headers(), text: `<html><body><p>${paragraph}</p></body></html>`, truncated: false };
    mockFetch.mockResolvedValue(result);
    const executed = await GlobalCapabilityExecutor.execute("global.web.read_page", { url: "https://example.com" }, undefined);
    expect(executed.success).toBe(true);
    expect(executed.result?.content).toBe(paragraph);
  });
});
