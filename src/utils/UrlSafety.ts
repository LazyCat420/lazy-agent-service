// ============================================================
// UrlSafety — one SSRF guard for every outbound fetch a model can steer.
//
// assertPublicUrl(): parse, require http(s), reject localhost / *.local /
// single-label names, and resolve the host — EVERY A/AAAA answer must be a
// public address (an attacker-controlled name such as 127.0.0.1.nip.io
// resolves private). safeFetch(): the same check per redirect hop
// (redirect: "manual"), a connect-time lookup that re-validates the
// address actually dialled (closes the DNS-rebinding window), and a
// streamed body read under a byte cap. ALLOW_PRIVATE_URLS=1 lifts the
// private-address rules (dev only).
// ============================================================
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { Agent } from "undici";

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fe80::", 10],
  ["fc00::", 7],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) PRIVATE.addSubnet(net, bits, "ipv6");

export const allowPrivateUrls = (): boolean =>
  ["1", "true"].includes((process.env.ALLOW_PRIVATE_URLS || "").trim().toLowerCase());

/** IPv4 embedded in an IPv4-mapped (::ffff:a.b.c.d / ::ffff:7f00:1) or NAT64 (64:ff9b::) address. */
function embeddedIpv4(ipv6: string): string | null {
  const lower = ipv6.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses. */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").split("%")[0];
  const family = isIP(bare);
  if (family === 4) return PRIVATE.check(bare, "ipv4");
  if (family === 6) {
    const v4 = embeddedIpv4(bare);
    if (v4 !== null) return PRIVATE.check(v4, "ipv4");
    return PRIVATE.check(bare, "ipv6");
  }
  return true; // not an address at all — fail closed
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export interface UrlSafetyOptions {
  /** Permit plain http:// (default true; WebExtract requires https). */
  allowHttp?: boolean;
  /** Resolver override for tests. */
  resolve?: (host: string) => Promise<string[]>;
}

const defaultResolve = (host: string): Promise<string[]> =>
  new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses.map((entry) => entry.address));
    });
  });

/** Throws unless the URL scheme (and credentials) are allowed. */
function _assertUrlShape(url: URL, allowHttp: boolean): void {
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new UnsafeUrlError(`protocol ${url.protocol} is not allowed`);
  }
  if (url.username || url.password) throw new UnsafeUrlError("credentials in URL are not allowed");
}

/** Throws when the host is a local/internal name. */
function _assertHostNotLocal(host: string): void {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new UnsafeUrlError(`host ${host} is local`);
  }
}

/** Throws when any resolved address is private or the host resolved to nothing. */
function _assertResolvedAddresses(host: string, addresses: string[]): void {
  if (addresses.length === 0) throw new UnsafeUrlError(`${host} has no addresses`);
  const bad = addresses.find(isPrivateAddress);
  if (bad) throw new UnsafeUrlError(`${host} resolves to private address ${bad}`);
}

/** Throws UnsafeUrlError unless the URL is http(s) and every address its host resolves to is public. */
export async function assertPublicUrl(raw: string, options: UrlSafetyOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("invalid URL");
  }
  const allowHttp = options.allowHttp ?? true;
  _assertUrlShape(url, allowHttp);
  if (allowPrivateUrls()) return url;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  _assertHostNotLocal(host);
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError(`address ${host} is private or reserved`);
    return url;
  }
  if (!host.includes(".")) throw new UnsafeUrlError(`single-label host ${host} is not allowed`);
  let addresses: string[];
  try {
    addresses = await (options.resolve ?? defaultResolve)(host);
  } catch (error) {
    throw new UnsafeUrlError(`could not resolve ${host}: ${(error as Error).message}`);
  }
  _assertResolvedAddresses(host, addresses);
  return url;
}

/** Connect-time guard: the address undici actually dials is re-checked (DNS rebinding). */
const guardedAgent = new Agent({
  connect: {
    lookup: (hostname, options, callback) => {
      dnsLookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
        if (error) return callback(error, "", 0);
        const list = addresses as Array<{ address: string; family: number }>;
        if (!allowPrivateUrls()) {
          const bad = list.find((entry) => isPrivateAddress(entry.address));
          if (bad) return callback(new UnsafeUrlError(`${hostname} resolves to private address ${bad.address}`), "", 0);
        }
        if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
        return callback(null, list[0].address, list[0].family);
      });
    },
  },
});

export interface SafeFetchOptions extends UrlSafetyOptions {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  maxRedirects?: number;
  /** Body bytes read before the stream is cut (default 2 MB). */
  maxBytes?: number;
  /** Transport override for tests (default: undici fetch through the guarded agent). */
  fetchImpl?: (url: URL, init: Record<string, unknown>) => Promise<Response>;
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: Headers;
  text: string;
  truncated: boolean;
}

/** Fetch a model-supplied URL: every hop checked, body streamed under a byte cap. Throws UnsafeUrlError when blocked. */
export async function safeFetch(raw: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? 5;
  const maxBytes = options.maxBytes ?? 2_000_000;
  let current = raw;
  for (let hop = 0; ; hop++) {
    const url = await assertPublicUrl(current, options);
    const init = {
      method: options.method ?? "GET",
      headers: options.headers,
      signal: options.signal,
      redirect: "manual",
      dispatcher: guardedAgent,
    };
    const response = options.fetchImpl
      ? await options.fetchImpl(url, init)
      : await globalThis.fetch(url, init as unknown as RequestInit);
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel().catch(() => {});
      if (hop >= maxRedirects) throw new UnsafeUrlError(`too many redirects (>${maxRedirects})`);
      current = new URL(response.headers.get("location") as string, url).toString();
      continue;
    }
    const { text, truncated } = await readCapped(response.body, maxBytes);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: url.toString(),
      headers: response.headers as unknown as Headers,
      text,
      truncated,
    };
  }
}

async function readCapped(
  body: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString("utf-8"), truncated };
}
