// ============================================================
// EditorialHeadlinesService — what a front page led with today.
//
// WHY THIS EXISTS. `news_search` with an EMPTY topic means "the top stories",
// and it used to be answered by whichever keyed provider happened to have a
// top-headlines endpoint and a live quota. Those endpoints are not the same
// product. Measured 2026-09-05, asking this service for the top stories
// returned, in one call:
//
//     nwfdailynews.com   Michael J Thomas (Solo Show) @Ruth's Chris
//     espn.com           Cards, Rockies tilt caps in protest against ump
//     espn.com           Michigan stuns Western Michigan on Hail Mary
//     bloomberg.com      Constitution doesn't include right to clean water
//
// and minutes later BYU football, Utah Buddhist monks and a 10,000 Maniacs
// anniversary show — the last SIX of eight rows being the same article
// repeated, because nothing on that path dedupes. currentsapi's /latest-news
// is a RECENCY feed: it answers "what was published in the last few minutes",
// which is a different question from "what is the news today", and its country
// filter did not bind either.
//
// Scored against eight independent newsrooms (see html-notes
// bench/news/editorial_ref.py — CBS, Guardian, PBS, Politico, The Hill, LA
// Times, NBC, none of them read here), that answer carried 0.00 of the day's
// stories. Google News RSS on the same minute carried 0.75.
//
// So the top-headlines path is now EDITORIAL: feeds whose order is a newsroom's
// own judgement about what led. Keyed providers are untouched for a topic
// search, where they are genuinely better (real URLs, real photos, ~1s), and
// they remain the fallback here if every feed is down.
//
// TWO TRAPS ENCODED BELOW, both previously paid for:
//
//  1. A Google News /rss/articles/CBMi... link is a REDIRECT STUB. It does not
//     resolve server-side, and its og:image is Google's own logo — the same
//     image for every story. So a Google row is marked `stub: true` with an
//     empty image, and callers must not try to scrape it. Where a publisher
//     feed carries the same story we adopt ITS url, image and snippet, which
//     turns a stub into a real article.
//  2. Consensus counts NEWSROOMS, not feeds. Google's top and world sections
//     are one newsroom; counting them separately would make every story look
//     twice-confirmed.
// ============================================================
import logger from "../utils/logger.ts";

export interface EditorialItem {
  title: string;
  url: string;
  image: string;
  source: string;
  snippet: string;
  date: string;
  /** Which feed this row came from, "newsroom:section". */
  feed: string;
  /** Position within its own feed — the newsroom's own ordering. */
  rank: number;
  /** A Google redirect link: unscrapeable, no article photo. */
  stub: boolean;
  /** How many INDEPENDENT newsrooms carried this story. Set by mergeAndRank. */
  consensus?: number;
  /** Section it was found in: top | world | us | business | ... */
  category?: string;
}

/** The sections a caller may ask for. Order is the order a mixed card shows. */
export const CATEGORIES = [
  "top",
  "us",
  "world",
  "business",
  "technology",
  "science",
  "health",
  "sports",
  "entertainment",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Google News section slugs. "top" is the front page and has no topic path. */
const GOOGLE_SECTION: Record<string, string> = {
  us: "NATION",
  world: "WORLD",
  business: "BUSINESS",
  technology: "TECHNOLOGY",
  science: "SCIENCE",
  health: "HEALTH",
  sports: "SPORTS",
  entertainment: "ENTERTAINMENT",
};

/** Sections a bare "top stories" ask blends, in the order they are shown. */
const MIXED_SECTIONS = ["us", "world", "business", "technology"];

/**
 * Publisher front pages, for the US edition. These exist to supply what Google
 * cannot: a real article URL and a real photo. They are also the second opinion
 * that makes `consensus` mean something.
 */
const PUBLISHER_FEEDS: Record<string, string> = {
  nyt: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
  bbc: "https://feeds.bbci.co.uk/news/rss.xml",
  npr: "https://feeds.npr.org/1001/rss.xml",
  abc: "https://abcnews.go.com/abcnews/topstories",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const CACHE_TTL_MS = 5 * 60 * 1000;
/** How long a cached answer may still be served once every feed is failing. */
const STALE_MAX_MS = 30 * 60 * 1000;
const FEED_TIMEOUT_MS = 2500;

interface CacheEntry {
  items: EditorialItem[];
  at: number;
}
const cache = new Map<string, CacheEntry>();

/** Test seam: the cache is process-global and would leak between cases. */
export function __resetEditorialCacheForTests(): void {
  cache.clear();
}

// ── parsing ────────────────────────────────────────────────────────────────
// A regex reader rather than an XML dependency. The shapes here are narrow and
// known (eight feeds we choose), trading-service reads its own feeds the same
// way, and adding a parser to this service would mean a lockfile change on a
// deploy whose only purpose is the news path.

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * One RSS feed body -> items, in the feed's own order.
 *
 * `rank` is that order and is load-bearing: it is the newsroom's judgement
 * about what led, and it is the only signal that survives when a story is
 * carried by just one outlet.
 */
export function parseFeed(xml: string, feed: string): EditorialItem[] {
  if (!xml || !/<item[\s>]/i.test(xml)) return [];
  const blocks: string[] = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  const out: EditorialItem[] = [];

  blocks.forEach((b) => {
    let title = tag(b, "title");
    const url = tag(b, "link");
    if (!title || !url) return;

    // <source url="https://www.washingtonpost.com">The Washington Post</source>
    const srcEl = b.match(/<source[^>]*url="([^"]+)"[^>]*>([\s\S]*?)<\/source>/i);
    const srcName = srcEl ? decode(srcEl[2]) : "";
    let source = srcEl ? hostOf(srcEl[1]) : hostOf(url);

    // Google suffixes every headline with " - Publisher". Left in place, the
    // publisher name becomes a token two unrelated headlines can agree on.
    if (srcName && title.endsWith(` - ${srcName}`)) {
      title = title.slice(0, -(srcName.length + 3)).trim();
    }

    const stub = /(^|\.)news\.google\.com$/.test(hostOf(url));
    if (stub && !source) source = srcName;

    const media =
      b.match(/<media:content[^>]*url="([^"]+)"/i) ||
      b.match(/<media:thumbnail[^>]*url="([^"]+)"/i) ||
      b.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image/i);

    out.push({
      title,
      url,
      // A stub's photo is Google's logo, identical for every story, so it has
      // no image at all rather than a misleading one.
      image: stub ? "" : media ? media[1] : "",
      source,
      snippet: stub ? "" : tag(b, "description").slice(0, 400),
      date: tag(b, "pubDate"),
      feed,
      rank: out.length,
      stub,
    });
  });

  return out;
}

// ── story identity ─────────────────────────────────────────────────────────

const STOP = new Set(
  `the a an of to in on for and or with as at by from is are be been was were
   after over into vs new news says say said this that these those it its his
   her their our your what how why who when where will would could should may
   might can has have had do does did not no more most than then there here
   about`.split(/\s+/),
);

/** Content tokens of a headline: the named things two desks would both use. */
export function titleTokens(title: string): Set<string> {
  const t = (title || "").replace(/\s+[-|]\s+[^-|]{2,40}$/, "");
  const words: string[] = t.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter((w) => !STOP.has(w) && (w.length > 2 || /\d/.test(w))));
}

/**
 * Do two headlines describe the same event?
 *
 * Two newsrooms write one story with different words, so exact matching finds
 * nothing. What survives is the named things — Witkoff, Putin, Iranian,
 * tankers — hence an overlap ratio against the SHORTER headline (a Jaccard
 * would punish a long headline for being long) with an absolute floor of two
 * shared tokens so one common word cannot carry a match alone.
 *
 * Thresholds match html-notes bench/news/editorial_ref.py, where they were
 * calibrated by sweeping a positive and a negative control: 0.30 was the
 * highest true-match rate at zero false positives.
 */
export function sameStory(a: Set<string>, b: Set<string>, ratio = 0.3): boolean {
  if (!a.size || !b.size) return false;
  let shared = 0;
  a.forEach((w) => {
    if (b.has(w)) shared += 1;
  });
  if (shared < 2) return false;
  return shared / Math.min(a.size, b.size) >= ratio;
}

/**
 * Commerce wearing a news feed's clothes.
 *
 * Google's BUSINESS and TECHNOLOGY sections mix affiliate roundups in with
 * reporting, and they are indistinguishable from news by every structural
 * signal — real publisher, real date, real photo, high in the feed. Live
 * 2026-09-05 a technology ask returned a Sonos soundbar "back to a record low"
 * and "5 Excellent 90+ Rated Steam Games For Under $25". Matched on the title,
 * because that is where the tell is.
 */
const SHOPPING = [
  /\bdeals?\b/i,
  /\bsales?\b.*\b(cart|shop|buy|save)\b/i,
  /\b(labor day|black friday|cyber monday|prime day)\b.*\b(sale|deal|shop)/i,
  /\brecord low\b/i,
  /\b\d+% off\b/i,
  /\bworth adding to your cart\b/i,
  /\byou can get\b.*\bfor (under|just) \$/i,
  /\bbest\b.*\b(deals|discounts|prices)\b/i,
  /\b(save|snag|grab) \$?\d+/i,
  /\bcoupon\b/i,
];

export function isShopping(title: string): boolean {
  return SHOPPING.some((re) => re.test(title || ""));
}

/** "google:world" -> "google". Consensus counts newsrooms, not feeds. */
function newsroomOf(feed: string): string {
  return feed.split(":")[0];
}

function categoryOf(feed: string): string {
  const [room, section] = feed.split(":");
  if (room !== "google") return "";
  return section && section !== "top" ? section : "top";
}

/**
 * Merge every feed into one ranked list.
 *
 * Ranking is consensus first, then the newsroom's own ordering. Consensus is
 * the honest signal for "is this a top story": one desk can lead with anything,
 * but three leading with the same event is the day's news.
 */
export function mergeAndRank(
  feeds: Record<string, EditorialItem[]>,
  opts: { limit?: number; seedFeeds?: string[] } = {},
): EditorialItem[] {
  const limit = opts.limit ?? 10;
  // Which feeds may INTRODUCE a story, as opposed to merely confirming one.
  //
  // For a section ask the answer must come from that section. The publisher
  // front pages are still fetched — they supply the real article URL, the photo
  // and the second opinion that makes consensus meaningful — but they carry the
  // day's biggest general news, which outranks anything sector-specific. Live,
  // the first build answered "business news" with Putin, Iran, a triumphal arch
  // and the Nepal floods, none of which is business news.
  const seeds = opts.seedFeeds;
  const canSeed = (feed: string) => !seeds || seeds.includes(feed);
  const merged: Array<EditorialItem & { rooms: Set<string>; tokens: Set<string> }> = [];

  for (const [feed, items] of Object.entries(feeds)) {
    for (const item of items) {
      const tokens = titleTokens(item.title);
      const hit = merged.find((m) => sameStory(m.tokens, tokens));
      if (!hit) {
        if (!canSeed(feed) || isShopping(item.title)) continue;
        merged.push({
          ...item,
          feed,
          rooms: new Set([newsroomOf(feed)]),
          tokens,
          category: categoryOf(feed) || "top",
        });
        continue;
      }
      hit.rooms.add(newsroomOf(feed));
      // A publisher feed carries a real URL and a real photo; a Google row does
      // not. Whichever arrived first, the article wins over the redirect.
      if (hit.stub && !item.stub) {
        hit.url = item.url;
        hit.image = item.image || hit.image;
        hit.snippet = item.snippet || hit.snippet;
        hit.source = item.source || hit.source;
        hit.stub = false;
      } else if (!hit.image && item.image) {
        hit.image = item.image;
      }
      if (!hit.snippet && item.snippet) hit.snippet = item.snippet;
      // First SECTION to carry it names it; a publisher front page has none.
      const cat = categoryOf(feed);
      if (cat && cat !== "top" && (!hit.category || hit.category === "top")) {
        hit.category = cat;
      }
    }
  }

  return merged
    .map((m) => ({ ...m, consensus: m.rooms.size }))
    .sort((a, b) => b.consensus - a.consensus || a.rank - b.rank)
    .slice(0, limit)
    .map(({ rooms: _rooms, tokens: _tokens, ...item }) => item);
}

// ── fetching ───────────────────────────────────────────────────────────────

export type Fetcher = (url: string) => Promise<string>;

async function defaultFetcher(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": UA },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function googleUrl(section: string, country: string): string {
  const gl = (country || "us").toUpperCase();
  const hl = `en-${gl}`;
  const ceid = `${gl}:en`;
  const slug = GOOGLE_SECTION[section];
  return slug
    ? `https://news.google.com/rss/headlines/section/topic/${slug}?hl=${hl}&gl=${gl}&ceid=${ceid}`
    : `https://news.google.com/rss?hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

export interface TopHeadlinesResult {
  items: EditorialItem[];
  /** Served from a cache entry older than the TTL because live feeds failed. */
  stale: boolean;
  feeds: string[];
}

/**
 * Today's headlines for a country and (optionally) a section.
 *
 * With no category on the US edition this blends the front page with the US,
 * world, business and technology sections, so ONE call can answer "top stories"
 * with a spread rather than with eight variations of whatever led.
 */
export async function topHeadlines(opts: {
  country?: string;
  category?: string;
  limit?: number;
  fetcher?: Fetcher;
}): Promise<TopHeadlinesResult> {
  const country = (opts.country || "us").toLowerCase();
  const category = (opts.category || "").toLowerCase();
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 30);
  const fetcher = opts.fetcher || defaultFetcher;
  const key = `${country}:${category}`;
  const now = Date.now();

  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return { items: hit.items.slice(0, limit), stale: false, feeds: ["cache"] };
  }

  const wanted: Record<string, string> = {};
  if (category && GOOGLE_SECTION[category]) {
    wanted[`google:${category}`] = googleUrl(category, country);
  } else {
    wanted["google:top"] = googleUrl("top", country);
    for (const s of MIXED_SECTIONS) wanted[`google:${s}`] = googleUrl(s, country);
  }
  // Publisher front pages are US editions; for another market they would be
  // the wrong country's news, so only Google is asked.
  if (country === "us") {
    for (const [name, url] of Object.entries(PUBLISHER_FEEDS)) wanted[name] = url;
  }

  const started = Date.now();
  const names = Object.keys(wanted);
  const bodies = await Promise.allSettled(names.map((n) => fetcher(wanted[n])));

  const feeds: Record<string, EditorialItem[]> = {};
  const alive: string[] = [];
  bodies.forEach((res, i) => {
    if (res.status !== "fulfilled") return;
    const items = parseFeed(res.value, names[i]);
    if (items.length) {
      feeds[names[i]] = items;
      alive.push(names[i]);
    }
  });

  if (!alive.length) {
    // Yesterday's front page beats an empty card, but only for a while, and the
    // caller is told which it got.
    if (hit && now - hit.at < STALE_MAX_MS) {
      logger.warn(`[Editorial] every feed failed for ${key}; serving cache from ${new Date(hit.at).toISOString()}`);
      return { items: hit.items.slice(0, limit), stale: true, feeds: ["cache:stale"] };
    }
    logger.warn(`[Editorial] every feed failed for ${key} and nothing is cached`);
    return { items: [], stale: false, feeds: [] };
  }

  // Merge generously, then cache the long list so a later smaller limit is a
  // cache hit rather than a refetch.
  const sectionAsked = Boolean(category && GOOGLE_SECTION[category]);
  const ranked = mergeAndRank(feeds, {
    limit: 30,
    seedFeeds: sectionAsked ? [`google:${category}`] : undefined,
  });
  cache.set(key, { items: ranked, at: now });

  const consensus = ranked.filter((i) => (i.consensus ?? 0) >= 2).length;
  const stubs = ranked.filter((i) => i.stub).length;
  logger.info(
    `[Editorial] ${alive.join("+")} -> ${ranked.length} items ` +
      `(${consensus} consensus>=2, ${stubs} stubs) in ${Date.now() - started}ms [${key}]`,
  );

  return { items: ranked.slice(0, limit), stale: false, feeds: alive };
}

/** Health surface: what is cached and how old it is. */
export function editorialStatus(): Record<string, unknown> {
  const now = Date.now();
  return {
    cached: [...cache.entries()].map(([key, e]) => ({
      key,
      items: e.items.length,
      ageSec: Math.round((now - e.at) / 1000),
      fresh: now - e.at < CACHE_TTL_MS,
    })),
    ttlSec: CACHE_TTL_MS / 1000,
    categories: CATEGORIES,
  };
}
