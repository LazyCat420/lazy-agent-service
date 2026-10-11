import { describe, expect, it } from "vitest";
import { assertPublicUrl, isPrivateAddress, safeFetch, UnsafeUrlError } from "../UrlSafety.ts";

const publicDns = async () => ["93.184.215.14"];

describe("isPrivateAddress (audit D6)", () => {
  it.each([
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "100.127.255.254", "127.0.0.1", "169.254.169.254",
    "172.16.0.1", "192.168.1.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::7f00:1",
  ])("blocks %s", (address) => expect(isPrivateAddress(address)).toBe(true));

  it.each(["93.184.215.14", "8.8.8.8", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])(
    "allows %s",
    (address) => expect(isPrivateAddress(address)).toBe(false),
  );
});

describe("assertPublicUrl", () => {
  it("refuses a public-looking name that resolves private", async () => {
    await expect(
      assertPublicUrl("https://127.0.0.1.nip.io/", { resolve: async () => ["127.0.0.1"] }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("refuses when ANY resolved address is private", async () => {
    await expect(
      assertPublicUrl("https://mixed.example.com/", { resolve: async () => ["8.8.8.8", "10.0.0.5"] }),
    ).rejects.toThrow(/private/);
  });

  it.each([
    "http://0.0.0.0:5591/health", "http://100.64.1.1/", "http://[::ffff:127.0.0.1]/", "http://0x7f000001/",
    "http://localhost/", "http://intranet/", "file:///etc/passwd", "https://user:pw@example.com/",
    "http://metadata.google.internal/",
  ])("refuses %s", async (url) => {
    await expect(assertPublicUrl(url, { resolve: publicDns })).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("accepts a public host", async () => {
    await expect(assertPublicUrl("https://example.com/a", { resolve: publicDns })).resolves.toBeInstanceOf(URL);
  });
});

describe("safeFetch", () => {
  it("re-checks every redirect hop", async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: URL) => {
      seen.push(url.toString());
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    };
    await expect(
      safeFetch("https://example.com/", { resolve: publicDns, fetchImpl }),
    ).rejects.toThrow(/169\.254\.169\.254/);
    expect(seen).toEqual(["https://example.com/"]);
  });

  it("does not follow redirects by itself and caps the body", async () => {
    const inits: Array<Record<string, unknown>> = [];
    const fetchImpl = async (_url: URL, init: Record<string, unknown>) => {
      inits.push(init);
      return new Response("x".repeat(10_000), { status: 200 });
    };
    const result = await safeFetch("https://example.com/", { resolve: publicDns, fetchImpl, maxBytes: 100 });
    expect(inits[0].redirect).toBe("manual");
    expect(result.text.length).toBe(100);
    expect(result.truncated).toBe(true);
  });
});
