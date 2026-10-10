// ============================================================
// WebExtractService — read a page's text through scraper-service
// (POST /scrape, engine "auto": http first, Chromium for JS-heavy
// pages), with Hermes' deterministic truncate-and-store pipeline.
//
// WHY: search results are metadata; page content is a deliberate
// second call. Raw pages can be huge (forum threads, docs, filings),
// so the extract applies a fixed character budget — no LLM
// summarization:
//   - at or under the budget: returned whole;
//   - over: a head+tail window (75% / 25%, cut on line boundaries)
//     plus an explicit [TRUNCATED] footer naming the file that holds
//     the FULL clean text, so the agent can page through the rest;
//   - over 2 MB of stored text: capped at 2 MB.
//
// Extracts are cached for 20 minutes under the URL and a bucketed
// char limit, so repeated reads and subagent fan-outs share one
// scrape. Only successes are cached. scraper-service runs at
// SCRAPER_SERVICE_URL (default http://localhost:8001, same
// convention as treesearch-service's scraper_client).
// ============================================================
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import logger from "../utils/logger.ts";

export interface WebExtractResult {
  status: "ok" | "error";
  url: string;
  /** The (possibly truncated) content shown to the model. */
  content: string;
  /** True when the content above is a window over the full page. */
  truncated: boolean;
  /** Present only when truncated: path of the file with the full text. */
  storedPath?: string;
  /** Present only when truncated: the read_file call that pages the middle. */
  readHint?: string;
  engineUsed?: string;
  cached: boolean;
  error?: string;
}

export interface WebExtractDeps {
  fetch: typeof fetch;
  now: () => number;
}

const envNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const SCRAPER_URL = (process.env.SCRAPER_SERVICE_URL || "http://localhost:8001").replace(/\/$/, "");
const SCRAPER_KEY = (process.env.SCRAPER_API_KEY || "").trim();
const DEFAULT_CHAR_LIMIT = envNumber("WEB_EXTRACT_CHAR_LIMIT", 15_000);
const MIN_LIMIT = 2_000;
const MAX_LIMIT = 500_000;
const STORED_TEXT_CAP = 2_000_000;
const CACHE_TTL_MS = envNumber("WEB_EXTRACT_CACHE_TTL_MS", 20 * 60 * 1_000);
const TIMEOUT_MS = envNumber("WEB_EXTRACT_TIMEOUT_MS", 120_000);

const defaultDeps: WebExtractDeps = {
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
};

const storeDir = process.env.WEB_EXTRACT_STORE_DIR || path.join(os.tmpdir(), "lazy-agent-web-extract");

const cache = new Map<string, { at: number; value: WebExtractResult }>();
const inFlight = new Map<string, Promise<WebExtractResult>>();
const MAX_CACHE_ENTRIES = 500;

/** Bucket the per-call limit so `14000` and `15000` share one cache entry. */
export function bucketCharLimit(charLimit: number): number {
  const buckets = [MIN_LIMIT, 5_000, 15_000, 50_000, MAX_LIMIT];
  for (const bucket of buckets) if (charLimit <= bucket) return bucket;
  return MAX_LIMIT;
}

/**
 * Head+tail window over the text, cut on line boundaries: the start of the
 * page and the end (where conclusions/references live) survive; the middle
 * goes to the stored file.
 */
export function truncateAndStore(text: string, charLimit: number): { content: string; truncated: boolean } {
  if (text.length <= charLimit) return { content: text, truncated: false };

  const headLen = Math.floor(charLimit * 0.75);
  const tailLen = charLimit - headLen;
  let head = text.slice(0, headLen);
  let tail = text.slice(text.length - tailLen);
  const headCut = head.lastIndexOf("\n");
  if (headCut > headLen * 0.5) head = head.slice(0, headCut);
  const tailCut = tail.indexOf("\n");
  if (tailCut > -1 && tailCut < tailLen * 0.5) tail = tail.slice(tailCut + 1);

  const omitted = text.length - head.length - tail.length;
  return {
    content: `${head}\n\n[TRUNCATED] ${omitted.toLocaleString()} characters of the middle were cut. The full text is stored at {STORED_PATH} — read it to continue.\n\n${tail}`,
    truncated: true,
  };
}

async function scrapeViaScraperService(url: string, deps: WebExtractDeps): Promise<WebExtractResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (SCRAPER_KEY) headers["x-scraper-key"] = SCRAPER_KEY;
  try {
    const response = await deps.fetch(`${SCRAPER_URL}/scrape`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url, engine: "auto" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      return { status: "error", url, content: "", truncated: false, cached: false, error: `scraper-service HTTP ${response.status}: ${(await response.text()).slice(0, 200)}` };
    }
    const body = (await response.json()) as { success?: boolean; content?: string | null; error?: string | null; engine_used?: string };
    if (!body.success || !body.content) {
      return { status: "error", url, content: "", truncated: false, cached: false, engineUsed: body.engine_used, error: `scrape failed${body.error ? `: ${body.error.slice(0, 200)}` : " (no content extracted)"}` };
    }
    return { status: "ok", url, content: body.content, truncated: false, cached: false, engineUsed: body.engine_used };
  } catch (error) {
    const name = (error as Error)?.name;
    const reason = name === "TimeoutError" ? `timed out after ${TIMEOUT_MS / 1_000} s` : (error as Error)?.message ?? String(error);
    return { status: "error", url, content: "", truncated: false, cached: false, error: `scraper-service unreachable: ${reason}` };
  }
}

/**
 * Fetch and extract a page's readable text under a character budget.
 * Never throws. The stored full text lives for the process lifetime in
 * storeDir; the footer names it so the agent can read the omitted middle.
 */
export async function webExtract(url: string, charLimit = DEFAULT_CHAR_LIMIT, deps: WebExtractDeps = defaultDeps): Promise<WebExtractResult> {
  const cleanUrl = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(cleanUrl)) {
    return { status: "error", url: cleanUrl, content: "", truncated: false, cached: false, error: "url is required and must start with http(s)://" };
  }
  const requested = Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.floor(Number(charLimit) || DEFAULT_CHAR_LIMIT)));
  const key = `${cleanUrl}|${bucketCharLimit(requested)}`;
  const hit = cache.get(key);
  if (hit && deps.now() - hit.at < CACHE_TTL_MS) return { ...hit.value, cached: true };
  const pending = inFlight.get(key);
  if (pending) return { ...(await pending), cached: true };

  const work = (async (): Promise<WebExtractResult> => {
    const scraped = await scrapeViaScraperService(cleanUrl, deps);
    if (scraped.status !== "ok") return scraped;

    const fullText = scraped.content.slice(0, STORED_TEXT_CAP);
    const { content, truncated } = truncateAndStore(fullText, requested);
    if (!truncated) return { ...scraped, content };

    const digest = createHash("sha1").update(cleanUrl).digest("hex").slice(0, 12);
    const storedPath = path.join(storeDir, `${digest}-${deps.now()}.txt`);
    try {
      await fs.mkdir(storeDir, { recursive: true });
      await fs.writeFile(storedPath, fullText, "utf-8");
    } catch (error) {
      logger.warn(`[WebExtract] could not store full text: ${(error as Error).message}`);
      return { ...scraped, content: `${fullText.slice(0, Math.floor(requested * 0.75))}\n\n[TRUNCATED] the middle was cut and could not be stored (${(error as Error).message.slice(0, 100)}).`, truncated: true };
    }
    const content_ = content.replace("{STORED_PATH}", storedPath);
    return { ...scraped, content: content_, truncated: true, storedPath, readHint: `read_file "${storedPath}" and page with line ranges to reach the omitted middle` };
  })();

  inFlight.set(key, work);
  try {
    const result = await work;
    if (result.status === "ok") {
      if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
      cache.set(key, { at: deps.now(), value: result });
    }
    return result;
  } finally {
    inFlight.delete(key);
  }
}

/** For health endpoints: what the shared extractor has been doing. */
export function webExtractStatus(now = Date.now()): Record<string, unknown> {
  return {
    scraperUrl: SCRAPER_URL,
    defaultCharLimit: DEFAULT_CHAR_LIMIT,
    cacheEntries: cache.size,
    cacheTtlMs: CACHE_TTL_MS,
    timeoutMs: TIMEOUT_MS,
    storeDir,
  };
}

export function __resetWebExtractForTests(): void {
  cache.clear();
  inFlight.clear();
}
