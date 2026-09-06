// ============================================================
// NewsSearchService — shared, multi-provider news lookup.
//
// This is the first tool lazy-tool-service IMPLEMENTS rather than proxies.
// Everything else in LocalToolRouter forwards to html-notes or trading-service;
// news is wanted by several consumers, so it lives here instead of being
// reimplemented per repo.
//
// WHY THIS EXISTS — the failure it replaces:
//
// html-notes fetched news from Google News RSS. That is fast (~0.1s) and
// reliable, but a /rss/articles/CBMi... link is a REDIRECT STUB, not an
// article:
//
//   * The link shows news.google.com, so the user cannot see the publisher.
//   * It does not redirect server-side — it 200s with a JS-driven body — and
//     the og:image it serves is Google's own News logo, THE SAME IMAGE FOR
//     EVERY STORY. A six-story card rendered six identical tiles, and a DOM
//     check passed because they were all valid.
//   * The CBMi blob is opaque; it does not base64-decode to a publisher URL.
//
// GDELT returns real URLs and real photos, and was the previous primary. It was
// demoted for good reason — measured 2026-07-19 from this network:
//
//     request 1  15.6s  200  19 articles (18 with images)
//     request 2  14.9s  200  24 articles (24 with images)
//     request 3  11.5s  429  throttled
//
// 15 seconds ON SUCCESS, 1 req/5s, and a throttled response still takes 11-16s
// to come back. Fronting the news path with it would make every card 15s slower
// and still fail often.
//
// The keyed providers below were measured on the same query and give real
// publisher URLs AND real article images in about a second:
//
//     gnews         0.5s   8/8 with images
//     worldnewsapi  1.1s   8/8 with images   (best relevance)
//     newsapi       0.2s   8/8 with images   (recency-sorted; weak relevance)
//     thenewsapi    1.2s   3/3 with images   (free tier caps at 3)
//
// So: rotate the keyed providers, and keep Google News RSS only as the
// last-resort fallback for when every provider is exhausted or down.
// ============================================================
import CONFIG from "../../config.ts";
import logger from "../utils/logger.ts";
import {
  CATEGORIES,
  editorialStatus,
  topHeadlines,
} from "./EditorialHeadlinesService.ts";

export interface NewsItem {
  title: string;
  url: string;
  image: string;
  source: string;
  snippet: string;
  date: string;
  /** Section the story was found in. Top-headlines path only. */
  category?: string;
  /** How many independent newsrooms led with it. Top-headlines path only. */
  consensus?: number;
  /** A Google redirect link: do not scrape it, it has no article photo. */
  stub?: boolean;
}

export interface NewsSearchResult {
  items: NewsItem[];
  /** Which mechanism answered: "editorial" | "editorial:stale" | a provider name | "". */
  source: string;
}

/** Options that exist for the bench and the provider audit, not for callers. */
export interface NewsSearchDebug {
  /** Pin the mechanism: "keyed" skips the editorial feeds entirely. */
  source?: string;
  /** Pin one keyed provider by name, ignoring rotation order and budgets. */
  provider?: string;
}

interface Provider {
  name: string;
  /** Free-tier requests per day. Used to spread load, not enforced by the API. */
  dailyLimit: number;
  key: () => string | undefined;
  fetch: (topic: string, limit: number, key: string, country: string) => Promise<NewsItem[]>;
  /**
   * Headlines with NO topic. Optional: a provider without one is skipped for
   * general asks rather than being handed a fake query.
   *
   * This exists because "what's going on in the news" used to be turned into a
   * keyword search for the literal string "top stories", which matches ROUNDUP
   * pages that happen to contain that phrase. Measured 2026-09-05, the general
   * news card returned "Alix Earle sheds light on her feud with Alex Cooper and
   * other TOP STORIES highlighted by Us for September 4" — the phrase was the
   * match. Searching for the words "top stories" is not the same request as
   * asking for the top stories.
   */
  top?: (limit: number, key: string, country: string) => Promise<NewsItem[]>;
}

/** Per-provider call counts, reset when the UTC day rolls over. */
const usage = new Map<string, { day: string; count: number }>();
/** Providers that just failed, with the time they may be retried. */
const cooldown = new Map<string, number>();

const COOLDOWN_MS = 10 * 60 * 1000;

/** Region for news lookups when the caller does not name one. Empty = worldwide. */
const DEFAULT_COUNTRY = (CONFIG.NEWS_DEFAULT_COUNTRY ?? "us").trim().toLowerCase();

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function used(name: string, now: number): number {
  const u = usage.get(name);
  if (!u || u.day !== utcDay(now)) return 0;
  return u.count;
}

function noteUse(name: string, now: number): void {
  const day = utcDay(now);
  const u = usage.get(name);
  usage.set(name, u && u.day === day ? { day, count: u.count + 1 } : { day, count: 1 });
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function getJson(
  url: string,
  params: Record<string, string>,
  timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}?${qs}`, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; lazy-tool-service)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

function mapItems(
  rows: unknown,
  f: (r: Record<string, unknown>) => NewsItem,
): NewsItem[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map(f)
    .filter((i) => i.title && i.url);
}

// Every provider was being sent `language: "en"` and NO country, and English is
// not a region. Indian English-language outlets — Economic Times, Hindustan
// Times, Times of India — publish enormous volume, so a generic query like
// "stock market" or an empty top-stories query was reliably dominated by them.
// Measured 2026-09-05, "stock market news" through html-notes returned
// "7.8% GDP growth fails to lift Indian indices", "Former Tata Technologies CEO
// sells Rs 165 crore stake" and economictimes.indiatimes.com. Those ARE stock
// market stories — just not the caller's market, which is why no amount of
// relevance filtering downstream could fix it: the articles are on-topic and
// still wrong.
//
// Each API spells the region differently, and newsapi's /everything has no
// country parameter at all, so it stays unfiltered (it is already the
// last-resort backstop). Empty country = worldwide, the previous behaviour.
const PROVIDERS: Provider[] = [
  {
    name: "gnews",
    dailyLimit: 100,
    key: () => CONFIG.GNEWS_API_KEY,
    fetch: async (topic, limit, key, country) => {
      const j = await getJson("https://gnews.io/api/v4/search", {
        q: topic, lang: "en", max: String(limit), apikey: key,
        ...(country ? { country } : {}),
      });
      return mapItems(j.articles, (a) => ({
        title: str(a.title),
        url: str(a.url),
        image: str(a.image),
        source: str((a.source as Record<string, unknown>)?.name) || hostOf(str(a.url)),
        snippet: str(a.description),
        date: str(a.publishedAt),
      }));
    },
    top: async (limit, key, country) => {
      const j = await getJson("https://gnews.io/api/v4/top-headlines", {
        lang: "en", max: String(limit), apikey: key,
        ...(country ? { country } : {}),
      });
      return mapItems(j.articles, (a) => ({
        title: str(a.title),
        url: str(a.url),
        image: str(a.image),
        source: str((a.source as Record<string, unknown>)?.name) || hostOf(str(a.url)),
        snippet: str(a.description),
        date: str(a.publishedAt),
      }));
    },
  },
  {
    name: "worldnewsapi",
    dailyLimit: 300,
    key: () => CONFIG.WORLDNEWSAPI_KEY,
    fetch: async (topic, limit, key, country) => {
      const j = await getJson("https://api.worldnewsapi.com/search-news", {
        text: topic, language: "en", number: String(limit), "api-key": key,
        ...(country ? { "source-country": country } : {}),
      });
      return mapItems(j.news, (a) => ({
        title: str(a.title),
        url: str(a.url),
        image: str(a.image),
        source: hostOf(str(a.url)),
        snippet: str(a.summary) || str(a.text).slice(0, 300),
        date: str(a.publish_date),
      }));
    },
  },
  {
    name: "currentsapi",
    dailyLimit: 600,
    key: () => CONFIG.CURRENTS_API_KEY,
    fetch: async (topic, limit, key, country) => {
      const j = await getJson("https://api.currentsapi.services/v1/search", {
        keywords: topic, language: "en", page_size: String(limit), apiKey: key,
        ...(country ? { country: country.toUpperCase() } : {}),
      });
      return mapItems(j.news, (a) => ({
        title: str(a.title),
        url: str(a.url),
        // currentsapi writes the string "None" when it has no image.
        image: str(a.image) === "None" ? "" : str(a.image),
        source: hostOf(str(a.url)),
        snippet: str(a.description),
        date: str(a.published),
      }));
    },
    top: async (limit, key, country) => {
      const j = await getJson("https://api.currentsapi.services/v1/latest-news", {
        language: "en", page_size: String(limit), apiKey: key,
        ...(country ? { country: country.toUpperCase() } : {}),
      });
      return mapItems(j.news, (a) => ({
        title: str(a.title),
        url: str(a.url),
        image: str(a.image) === "None" ? "" : str(a.image),
        source: hostOf(str(a.url)),
        snippet: str(a.description),
        date: str(a.published),
      }));
    },
  },
  {
    name: "thenewsapi",
    dailyLimit: 150,
    key: () => CONFIG.THENEWSAPI_KEY,
    fetch: async (topic, limit, key, country) => {
      const j = await getJson("https://api.thenewsapi.com/v1/news/all", {
        search: topic, language: "en", limit: String(Math.min(limit, 3)), api_token: key,
        ...(country ? { locale: country } : {}),
      });
      return mapItems(j.data, (a) => ({
        title: str(a.title),
        url: str(a.url),
        image: str(a.image_url),
        source: str(a.source) || hostOf(str(a.url)),
        snippet: str(a.description) || str(a.snippet),
        date: str(a.published_at),
      }));
    },
    top: async (limit, key, country) => {
      const j = await getJson("https://api.thenewsapi.com/v1/news/top", {
        language: "en", limit: String(Math.min(limit, 3)), api_token: key,
        ...(country ? { locale: country } : {}),
      });
      return mapItems(j.data, (a) => ({
        title: str(a.title),
        url: str(a.url),
        image: str(a.image_url),
        source: str(a.source) || hostOf(str(a.url)),
        snippet: str(a.description) || str(a.snippet),
        date: str(a.published_at),
      }));
    },
  },
  {
    name: "newsapi",
    dailyLimit: 100,
    key: () => CONFIG.NEWSAPI_API_KEY,
    // Last of the keyed providers deliberately: /everything sorted by recency
    // returns topically-unrelated stories (a stabbing report for a "James Webb
    // telescope" query), so it is a availability backstop, not a first choice.
    fetch: async (topic, limit, key) => {
      const j = await getJson("https://newsapi.org/v2/everything", {
        q: topic, language: "en", pageSize: String(limit),
        sortBy: "relevancy", apiKey: key,
      });
      return mapItems(j.articles, (a) => ({
        title: str(a.title),
        url: str(a.url),
        image: str(a.urlToImage),
        source: str((a.source as Record<string, unknown>)?.name) || hostOf(str(a.url)),
        snippet: str(a.description),
        date: str(a.publishedAt),
      }));
    },
    top: async (limit, key, country) => {
      // /top-headlines DOES take a country, unlike /everything above.
      const j = await getJson("https://newsapi.org/v2/top-headlines", {
        language: "en", pageSize: String(limit), apiKey: key,
        ...(country ? { country } : {}),
      });
      return mapItems(j.articles, (a) => ({
        title: str(a.title),
        url: str(a.url),
        image: str(a.urlToImage),
        source: str((a.source as Record<string, unknown>)?.name) || hostOf(str(a.url)),
        snippet: str(a.description),
        date: str(a.publishedAt),
      }));
    },
  },
];

/**
 * Order providers best-first, skipping any that are keyless, cooling down after
 * a failure, or already at their free-tier daily budget.
 */
function candidates(now: number): Provider[] {
  return PROVIDERS.filter((p) => {
    if (!p.key()) return false;
    const until = cooldown.get(p.name);
    if (until && until > now) return false;
    return used(p.name, now) < p.dailyLimit;
  });
}

/**
 * Current headlines with real publisher URLs and real article photos.
 *
 * Tries each usable provider in order and returns the first non-empty result.
 * Returns [] if every provider is exhausted or failing — the CALLER decides
 * what to fall back to, because the fallback differs per consumer (html-notes
 * still has its Google News RSS path).
 */
export async function newsSearch(
  topic: string,
  limit = 6,
  country = DEFAULT_COUNTRY,
  category = "",
  debug: NewsSearchDebug = {},
): Promise<NewsSearchResult> {
  const query = (topic || "").trim();
  const region = (country || "").trim().toLowerCase();
  const section = (category || "").trim().toLowerCase();
  // An EMPTY topic is a real request — "what's going on in the news" — and it
  // must go to each provider's top-headlines endpoint, never to a keyword
  // search. It used to be turned into a search for the literal words "top
  // stories" by the caller, which matches roundup pages containing that phrase.
  const wantTop = !query;

  // THE TOP-HEADLINES PATH IS EDITORIAL. A keyed provider's "top" endpoint is
  // whatever that vendor decided the words mean, and at least one of them
  // (currentsapi /latest-news) means "published in the last few minutes" —
  // which served a Ruth's Chris solo-show listing and a college football recap
  // as the top stories of the day, scoring 0.00 against eight independent
  // newsrooms while Google's own front page scored 0.75 on the same minute.
  // The keyed providers stay exactly as they are for a TOPIC search, where
  // they are the better instrument, and remain the fallback here.
  if (wantTop && debug.source !== "keyed") {
    try {
      const ed = await topHeadlines({ country: region, category: section, limit });
      if (ed.items.length) {
        return { items: ed.items, source: ed.stale ? "editorial:stale" : "editorial" };
      }
      logger.warn("[NewsSearch] editorial feeds returned nothing; falling back to keyed providers");
    } catch (err) {
      logger.warn(`[NewsSearch] editorial path threw, falling back to keyed: ${String(err)}`);
    }
  }

  const now = Date.now();
  const usable = candidates(now)
    .filter((p) => (wantTop ? !!p.top : true))
    .filter((p) => !debug.provider || p.name === debug.provider);
  if (!usable.length) {
    logger.warn(
      `[NewsSearch] no usable provider for ${wantTop ? "top headlines" : `"${query}"`} ` +
        "(no keys, all cooling down, at budget, or none serves top headlines)",
    );
    return { items: [], source: "" };
  }

  for (const p of usable) {
    const started = Date.now();
    try {
      noteUse(p.name, started);
      const items = wantTop
        ? await p.top!(limit, p.key()!, region)
        : await p.fetch(query, limit, p.key()!, region);
      if (items.length) {
        logger.info(
          `[NewsSearch] ${p.name} -> ${items.length} items in ${Date.now() - started}ms ` +
            `(${items.filter((i) => i.image).length} with images` +
            `${region ? `, country=${region}` : ", worldwide"})`,
        );
        return { items: items.slice(0, limit), source: p.name };
      }
      // An empty-but-successful answer is a miss for this topic, not a fault —
      // no cooldown, just move on.
      logger.info(
        `[NewsSearch] ${p.name} returned 0 items for ${wantTop ? "top headlines" : `"${query}"`}`,
      );
    } catch (err) {
      // Quota exhaustion and outages look the same from here, and both mean
      // "stop asking for a while".
      cooldown.set(p.name, Date.now() + COOLDOWN_MS);
      logger.warn(
        `[NewsSearch] ${p.name} ${wantTop ? "top" : "search"} failed ` +
          `(${Date.now() - started}ms): ${String(err)}`,
      );
    }
  }

  logger.warn(
    `[NewsSearch] every provider missed for ${wantTop ? "top headlines" : `"${query}"`}`,
  );
  return { items: [], source: "" };
}

/** Exposed for the health surface: which providers could serve a request now. */
export function newsProviderStatus(): Record<string, unknown> {
  const now = Date.now();
  return {
    usable: candidates(now).map((p) => p.name),
    configured: PROVIDERS.filter((p) => p.key()).map((p) => p.name),
    cooling: [...cooldown.entries()]
      .filter(([, until]) => until > now)
      .map(([name]) => name),
    usedToday: Object.fromEntries(PROVIDERS.map((p) => [p.name, used(p.name, now)])),
    editorial: editorialStatus(),
    categories: CATEGORIES,
  };
}
