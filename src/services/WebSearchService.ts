// ============================================================
// WebSearchService — one keyless web search for every service on this network.
//
// WHY THIS EXISTS: every machine in the house leaves through one public IP, and
// the free search engines bot-block it. DuckDuckGo first refused the NAS on
// 2026-07-27; on 2026-10-06 a plain curl from the workstation got its "bots use
// DuckDuckGo too" challenge, and Startpage, Ecosia, Google and Mojeek failed the
// same way. html-notes, treesearch, trading-client's chat and others each scraped
// those engines on their own, and every one of them made the block worse for all.
//
// Exa's keyless MCP endpoint answers from Exa's own index through an API, so the
// bot checks do not apply. Its free tier rate-limits (HTTP 429), so this service
// is the one place that talks to it:
//   - an identical search is answered from a cache for 30 minutes, and identical
//     searches already in flight share one call;
//   - Exa calls go out one at a time, at least 1.5 s apart, for the whole network;
//   - after a 429 nothing is sent for a minute and callers get `rate_limited` at
//     once instead of piling on.
// Exa is the primary backend. Since 2026-10-09 a failed Exa call (rate
// limited, busy, down) falls back to scraper-service's self-hosted SearXNG
// collector, which answers from the LAN and does not share Exa's limits.
//
// Services reach it through POST /execute/web_search, which is deliberately
// not in tool_schemas.json. Agents on this service's harness reach it through
// the ordinary `search_web` tool, which ToolOrchestratorService answers here
// instead of forwarding it to tools-service's DuckDuckGo scrape.
// ============================================================
import logger from "../utils/logger.ts";

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
  published: string;
  author: string;
}

export type WebSearchStatus = "ok" | "error" | "rate_limited" | "busy" | "cancelled";

export type WebSearchProvider = "exa" | "searxng";

export interface WebSearchResult {
  status: WebSearchStatus;
  provider: WebSearchProvider;
  cached: boolean;
  results: WebResult[];
  error?: string;
}

export interface WebSearchDeps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const envNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const EXA_URL = (process.env.WEB_SEARCH_EXA_URL || "https://mcp.exa.ai/mcp").trim();
const MIN_INTERVAL_MS = envNumber("WEB_SEARCH_MIN_INTERVAL_MS", 1_500);
const CACHE_TTL_MS = envNumber("WEB_SEARCH_CACHE_TTL_MS", 30 * 60 * 1_000);
const COOLDOWN_MS = envNumber("WEB_SEARCH_COOLDOWN_MS", 60 * 1_000);
const TIMEOUT_MS = envNumber("WEB_SEARCH_TIMEOUT_MS", 15_000);
// A caller never waits longer than this for its turn; past it the answer is
// `busy`. Queueing without a bound would turn a burst into minutes of latency.
const MAX_WAIT_MS = envNumber("WEB_SEARCH_MAX_WAIT_MS", 20_000);
const MAX_CACHE_ENTRIES = 500;
const MAX_LIMIT = 10;
const SNIPPET_CHARS = 500;

const defaultDeps: WebSearchDeps = {
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

const cache = new Map<string, { at: number; value: WebSearchResult }>();
interface InFlightSearch {
  promise: Promise<WebSearchResult>;
  controller: AbortController;
  /** Callers still awaiting this job; the backend is aborted when the last one leaves. */
  waiters: number;
}
const inFlight = new Map<string, InFlightSearch>();
let nextSlotAt = 0;
let cooldownUntil = 0;
const stats = {
  calls: 0,
  cacheHits: 0,
  rateLimited: 0,
  lastAt: null as number | null,
  lastStatus: null as WebSearchStatus | null,
  lastError: null as string | null,
};

const cacheKey = (query: string, limit: number) =>
  `${query.trim().toLowerCase().replace(/\s+/g, " ")}|${limit}`;

/** Exa's MCP text: one block per result, separated by `---` lines. */
export function parseExaText(text: string): WebResult[] {
  const results: WebResult[] = [];
  for (const block of String(text).split(/\n-{3,}\n/)) {
    const field = (name: string) => block.match(new RegExp(`^${name}:[ \\t]*(.*)$`, "m"))?.[1]?.trim() ?? "";
    const url = field("URL");
    if (!/^https?:\/\//i.test(url)) continue;
    const highlights = block.split(/^Highlights:[ \t]*$/m)[1] ?? "";
    const snippet = highlights.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
    const author = field("Author");
    results.push({
      title: field("Title") || url,
      url,
      snippet,
      // Exa writes "N/A" for an unknown date; callers test truthiness, so
      // an unknown date is "" (like author), never the string "N/A".
      published: /^n\/?a$/i.test(field("Published").trim()) ? "" : field("Published").trim(),
      author: author === "N/A" ? "" : author,
    });
  }
  return results;
}

/** The JSON-RPC message in an MCP reply, sent as SSE `data:` lines or as plain JSON. */
function readMcpMessage(body: string): Record<string, unknown> {
  const dataLines = body.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim());
  const payload = dataLines.length ? dataLines[dataLines.length - 1] : body;
  return JSON.parse(payload) as Record<string, unknown>;
}

/** Reserve the next slot to call Exa; false when the wait would exceed MAX_WAIT_MS. */
async function takeSlot(deps: WebSearchDeps): Promise<boolean> {
  const now = deps.now();
  const slotAt = Math.max(now, nextSlotAt);
  if (slotAt - now > MAX_WAIT_MS) return false;
  // Reserved before any await, so concurrent callers queue in order.
  nextSlotAt = slotAt + MIN_INTERVAL_MS;
  if (slotAt > now) await deps.sleep(slotAt - now);
  return true;
}

function finish(result: WebSearchResult, deps: WebSearchDeps): WebSearchResult {
  stats.lastAt = deps.now();
  stats.lastStatus = result.status;
  stats.lastError = result.error ?? null;
  return result;
}

const rateLimited = (deps: WebSearchDeps): WebSearchResult => ({
  status: "rate_limited",
  provider: "exa",
  cached: false,
  results: [],
  error: `Exa's keyless rate limit was hit; searches resume in ${Math.ceil((cooldownUntil - deps.now()) / 1_000)} s`,
});

async function callExa(query: string, limit: number, deps: WebSearchDeps, signal?: AbortSignal): Promise<WebSearchResult> {
  if (deps.now() < cooldownUntil) return rateLimited(deps);
  if (!(await takeSlot(deps))) {
    return { status: "busy", provider: "exa", cached: false, results: [], error: "too many searches queued; try again shortly" };
  }
  if (deps.now() < cooldownUntil) return rateLimited(deps);
  stats.calls += 1;
  const id = `ws-${stats.calls}`;
  try {
    const response = await deps.fetch(`${EXA_URL}?tools=web_search_exa`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "x-exa-source": "lazy-agent-service",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "web_search_exa", arguments: { query, numResults: limit } },
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.text();
    if (response.status === 429 || /rate limit/i.test(response.ok ? "" : body)) {
      cooldownUntil = deps.now() + COOLDOWN_MS;
      stats.rateLimited += 1;
      logger.warn(`[WebSearch] Exa rate limit (HTTP ${response.status}); pausing searches for ${COOLDOWN_MS / 1_000} s`);
      return rateLimited(deps);
    }
    if (!response.ok) {
      return { status: "error", provider: "exa", cached: false, results: [], error: `Exa HTTP ${response.status}: ${body.slice(0, 200)}` };
    }
    const message = readMcpMessage(body);
    const rpcError = message.error as { message?: string } | undefined;
    if (rpcError) {
      if (/rate limit|429/i.test(String(rpcError.message))) {
        cooldownUntil = deps.now() + COOLDOWN_MS;
        stats.rateLimited += 1;
        return rateLimited(deps);
      }
      return { status: "error", provider: "exa", cached: false, results: [], error: `Exa: ${String(rpcError.message ?? "error").slice(0, 200)}` };
    }
    const result = message.result as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
      _meta?: Record<string, unknown>;
    } | undefined;
    const text = (result?.content ?? []).map(part => part?.text ?? "").join("\n---\n");
    if (result?.isError) {
      return { status: "error", provider: "exa", cached: false, results: [], error: `Exa: ${text.slice(0, 200)}` };
    }
    const results = parseExaText(text).slice(0, limit);
    // The free tier's limit arrives as a SUCCESSFUL reply: HTTP 200, no
    // JSON-RPC error, `_meta["ai.exa/rateLimited"]: true` and a "You've hit
    // Exa's free MCP rate limit" text with no results in it. Read as "ok, 0
    // results" it skipped the fallback and was cached for 30 minutes, so
    // html-notes answered "I couldn't find anything" (2026-10-11).
    if (result?._meta?.["ai.exa/rateLimited"] === true || (!results.length && /rate limit/i.test(text))) {
      cooldownUntil = deps.now() + COOLDOWN_MS;
      stats.rateLimited += 1;
      logger.warn(`[WebSearch] Exa free-tier rate limit (200 + rateLimited); pausing searches for ${COOLDOWN_MS / 1_000} s`);
      return rateLimited(deps);
    }
    return { status: "ok", provider: "exa", cached: false, results };
  } catch (error) {
    const name = (error as Error)?.name;
    const reason = name === "TimeoutError" ? `timed out after ${TIMEOUT_MS / 1_000} s` : (error as Error)?.message ?? String(error);
    return { status: "error", provider: "exa", cached: false, results: [], error: `Exa unreachable: ${reason}` };
  }
}

/** scraper-service's self-hosted SearXNG collector: keyless, LAN-side, no Exa limits. */
const SCRAPER_URL = (process.env.SCRAPER_SERVICE_URL || "http://localhost:8001").replace(/\/$/, "");
const SCRAPER_KEY = (process.env.SCRAPER_API_KEY || "").trim();
const SEARXNG_TIMEOUT_MS = envNumber("WEB_SEARCH_SEARXNG_TIMEOUT_MS", 20_000);

async function callSearxng(query: string, limit: number, deps: WebSearchDeps, signal?: AbortSignal): Promise<WebSearchResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (SCRAPER_KEY) headers["x-scraper-key"] = SCRAPER_KEY;
  try {
    const response = await deps.fetch(`${SCRAPER_URL}/collect`, {
      method: "POST",
      headers,
      body: JSON.stringify({ source: "searxng", query, limit }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(SEARXNG_TIMEOUT_MS)]) : AbortSignal.timeout(SEARXNG_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { status: "error", provider: "searxng", cached: false, results: [], error: `SearXNG fallback HTTP ${response.status}: ${(await response.text()).slice(0, 200)}` };
    }
    const body = (await response.json()) as { success?: boolean; items?: Array<Record<string, unknown>>; error?: string | null };
    if (body.success === false) {
      return { status: "error", provider: "searxng", cached: false, results: [], error: `SearXNG fallback: ${String(body.error ?? "failed").slice(0, 200)}` };
    }
    const results = (body.items ?? [])
      .filter((item) => /^https?:\/\//i.test(String(item.url ?? "")))
      .slice(0, limit)
      .map((item) => ({
        title: String(item.title ?? item.url),
        url: String(item.url),
        snippet: String(item.snippet ?? "").slice(0, SNIPPET_CHARS),
        published: String(item.publishedDate ?? ""),
        author: "",
      }));
    return { status: "ok", provider: "searxng", cached: false, results };
  } catch (error) {
    const name = (error as Error)?.name;
    const reason = name === "TimeoutError" ? `timed out after ${SEARXNG_TIMEOUT_MS / 1_000} s` : (error as Error)?.message ?? String(error);
    return { status: "error", provider: "searxng", cached: false, results: [], error: `SearXNG fallback unreachable: ${reason}` };
  }
}

/**
 * Search the web through Exa's keyless endpoint, cached and paced for the whole
 * network. Never throws. An `ok` with no results means neither Exa nor the
 * SearXNG fallback found anything (and is not cached); every other status
 * says why there are no results.
 */
export async function webSearch(query: string, limit = 6, deps: WebSearchDeps = defaultDeps, signal?: AbortSignal): Promise<WebSearchResult> {
  const trimmed = String(query ?? "").trim();
  const capped = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(limit) || 6)));
  if (!trimmed) {
    return finish({ status: "error", provider: "exa", cached: false, results: [], error: "query is required" }, deps);
  }
  // Cancellation: each caller races its own signal and gets status
  // "cancelled" at once. The backend call is shared by every caller of the
  // same query, so it is aborted only when the LAST waiting caller leaves;
  // the in-flight entry stays until the backend settles, so a caller that
  // leaves early never causes a duplicate Exa call, and a result that
  // arrives after everyone left is still cached. webSearch never throws.
  const cancelled = (): WebSearchResult => ({ status: "cancelled", provider: "exa", cached: false, results: [], error: "cancelled by the caller" });
  if (signal?.aborted) return finish(cancelled(), deps);
  const key = cacheKey(trimmed, capped);
  const hit = cache.get(key);
  if (hit && deps.now() - hit.at < CACHE_TTL_MS) {
    stats.cacheHits += 1;
    return finish({ ...hit.value, cached: true }, deps);
  }
  let job = inFlight.get(key);
  const joined = job !== undefined;
  if (job) {
    stats.cacheHits += 1;
  } else {
    const controller = new AbortController();
    const created: InFlightSearch = { controller, waiters: 0, promise: Promise.resolve(cancelled()) };
    created.promise = (async (): Promise<WebSearchResult> => {
      try {
        const exa = await callExa(trimmed, capped, deps, controller.signal);
        if (controller.signal.aborted) return cancelled();
        // A failed Exa call is not "the web has nothing": try scraper-service's
        // SearXNG collector before reporting failure. SearXNG reads `site:` and
        // most operators natively, so the query passes through unchanged. `busy`
        // is a local queue condition, not a backend failure — a burst must not
        // pile onto the fallback too.
        // An Exa `ok` with NO results also tries SearXNG: Exa's keyless index
        // misses fresh news ("russia ukraine energy ceasefire" came back
        // empty while "latest russia ukraine energy ceasefire" had six).
        if (exa.status === "busy" || (exa.status === "ok" && exa.results.length > 0)) return exa;
        const fallback = await callSearxng(trimmed, capped, deps, controller.signal);
        if (controller.signal.aborted) return cancelled();
        if (fallback.status === "ok" && fallback.results.length > 0) {
          logger.warn(`[WebSearch] Exa ${exa.status}; served '${trimmed.slice(0, 80)}' from the SearXNG fallback (${fallback.results.length} results)`);
          return fallback;
        }
        return exa;
      } finally {
        inFlight.delete(key);
      }
    })().then((result) => {
      // Only answers WITH results are cached: a failure — or an empty answer,
      // which a rate limit or a thin index can produce — must not stick for
      // 30 minutes.
      if (result.status === "ok" && result.results.length > 0) {
        if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
        cache.set(key, { at: deps.now(), value: result });
      }
      return result;
    });
    inFlight.set(key, created);
    job = created;
  }
  const active = job;
  active.waiters += 1;
  let onAbort: (() => void) | undefined;
  const abortPromise = signal
    ? new Promise<WebSearchResult>((resolve) => {
        onAbort = () => resolve(cancelled());
        signal.addEventListener("abort", onAbort, { once: true });
      })
    : null;
  try {
    const result = abortPromise ? await Promise.race([active.promise, abortPromise]) : await active.promise;
    if (result.status === "cancelled") return finish(result, deps);
    return finish(joined ? { ...result, cached: true } : result, deps);
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    active.waiters -= 1;
    if (active.waiters === 0 && signal?.aborted) active.controller.abort();
  }
}

/** For health and the /execute reply: what the shared search has been doing. */
export function webSearchStatus(now = Date.now()): Record<string, unknown> {
  return {
    provider: "exa",
    calls: stats.calls,
    cacheHits: stats.cacheHits,
    rateLimited: stats.rateLimited,
    cooldownSeconds: Math.max(0, Math.ceil((cooldownUntil - now) / 1_000)),
    cacheEntries: cache.size,
    last: stats.lastAt === null ? null : { at: new Date(stats.lastAt).toISOString(), status: stats.lastStatus, error: stats.lastError },
    minIntervalMs: MIN_INTERVAL_MS,
    cacheTtlMs: CACHE_TTL_MS,
  };
}

export function __resetWebSearchForTests(): void {
  cache.clear();
  inFlight.clear();
  nextSlotAt = 0;
  cooldownUntil = 0;
  Object.assign(stats, { calls: 0, cacheHits: 0, rateLimited: 0, lastAt: null, lastStatus: null, lastError: null });
}

/**
 * Claude Code-style domain filters for search results: allow-list first,
 * then block-list, matching the hostname or a parent-domain suffix
 * (example.com covers api.example.com). Unknown args = no filtering.
 */
export function filterResultsByDomain<T extends { url: string }>(results: T[], args: Record<string, unknown>): T[] {
  const parseList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((d): d is string => typeof d === "string" && d.trim().length > 0).map((d) => d.trim().toLowerCase().replace(/^www\./, "")) : [];
  const allowed = parseList(args.allowed_domains);
  const blocked = parseList(args.blocked_domains);
  if (allowed.length === 0 && blocked.length === 0) return results;
  return results.filter((result) => {
    let hostname = "";
    try {
      hostname = new URL(result.url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return allowed.length === 0; // unparseable URL: keep unless an allow-list demands known hosts
    }
    const matches = (domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);
    if (allowed.length > 0 && !allowed.some(matches)) return false;
    return !blocked.some(matches);
  });
}

/**
 * `site:` prefix for a siteSearch arg, as tools-service did it. A single
 * allowed_domains entry is pushed into the query the same way, so the
 * backend returns results from that domain instead of the post-fetch
 * filter emptying a generic top-10 (audit e23d775).
 */
export function withSiteSearch(query: string, args: Record<string, unknown>): string {
  const explicit = typeof args.siteSearch === "string" ? args.siteSearch.trim() : "";
  const allowed = Array.isArray(args.allowed_domains)
    ? args.allowed_domains.filter((d): d is string => typeof d === "string" && d.trim().length > 0)
    : [];
  const site = explicit || (allowed.length === 1 ? allowed[0].trim().toLowerCase().replace(/^www\./, "") : "");
  return site && !/(^|\s)site:/i.test(query) ? `site:${site} ${query}` : query;
}

