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
// There is no fallback to a scraping engine, on purpose. Callers that want news
// use news_search (keyed news APIs) instead.
//
// Reached through POST /execute/web_search. It is deliberately not in
// tool_schemas.json, so agents do not see it; services call it.
// ============================================================
import logger from "../utils/logger.ts";

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
  published: string;
  author: string;
}

export type WebSearchStatus = "ok" | "error" | "rate_limited" | "busy";

export interface WebSearchResult {
  status: WebSearchStatus;
  provider: "exa";
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
const inFlight = new Map<string, Promise<WebSearchResult>>();
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
      published: field("Published"),
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

async function callExa(query: string, limit: number, deps: WebSearchDeps): Promise<WebSearchResult> {
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
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
    const result = message.result as { content?: { type?: string; text?: string }[]; isError?: boolean } | undefined;
    const text = (result?.content ?? []).map(part => part?.text ?? "").join("\n---\n");
    if (result?.isError) {
      return { status: "error", provider: "exa", cached: false, results: [], error: `Exa: ${text.slice(0, 200)}` };
    }
    return { status: "ok", provider: "exa", cached: false, results: parseExaText(text).slice(0, limit) };
  } catch (error) {
    const name = (error as Error)?.name;
    const reason = name === "TimeoutError" ? `timed out after ${TIMEOUT_MS / 1_000} s` : (error as Error)?.message ?? String(error);
    return { status: "error", provider: "exa", cached: false, results: [], error: `Exa unreachable: ${reason}` };
  }
}

/**
 * Search the web through Exa's keyless endpoint, cached and paced for the whole
 * network. Never throws. An `ok` with no results is a real "nothing found";
 * every other status says why there are no results.
 */
export async function webSearch(query: string, limit = 6, deps: WebSearchDeps = defaultDeps): Promise<WebSearchResult> {
  const trimmed = String(query ?? "").trim();
  const capped = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(limit) || 6)));
  if (!trimmed) {
    return finish({ status: "error", provider: "exa", cached: false, results: [], error: "query is required" }, deps);
  }
  const key = cacheKey(trimmed, capped);
  const hit = cache.get(key);
  if (hit && deps.now() - hit.at < CACHE_TTL_MS) {
    stats.cacheHits += 1;
    return finish({ ...hit.value, cached: true }, deps);
  }
  const pending = inFlight.get(key);
  if (pending) {
    stats.cacheHits += 1;
    return finish({ ...(await pending), cached: true }, deps);
  }
  const work = callExa(trimmed, capped, deps);
  inFlight.set(key, work);
  try {
    const result = await work;
    // Only successful answers are cached; a failure must not stick for 30 minutes.
    if (result.status === "ok") {
      if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
      cache.set(key, { at: deps.now(), value: result });
    }
    return finish(result, deps);
  } finally {
    inFlight.delete(key);
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
