/** get_finnhub_news results cut 4/10 calls in the 2026-10-16 telemetry window
 * (documentation/chapters/08-tool-metrics.md): the trading bridge renders the
 * articles as `  Title: … | Publisher: … | Date: … | Key Facts: <up to 400
 * chars>` lines (trading-service app/tools/finance_tools.py + text_utils.format_db_section),
 * which blows the model's ~8k per-result limit, and the generic cut kept only
 * the leading lines — the model lost most articles entirely.
 *
 * So the news result the model reads is a COMPACT PROJECTION instead: one JSON
 * object `{note, news: [{headline, source, datetime, summary, url?}]}` with
 * every headline kept and each summary at most 300 characters. A normal
 * result (the bridge caps coverage at 15 articles) fits the budget whole; a
 * bigger one degrades the summary length, never the headline count. The key
 * is `news` on purpose: prism caps a top-level array and any array under
 * `articles` at 10 items regardless of size (ModelVisibleToolResult.ts), which
 * would offload exactly the results this projection exists to save.
 */
import { RESULT_BUDGET_CHARS, bridgeContent } from "./ModelVisibleToolResult.js";

const MAX_SUMMARY_CHARS = 300;

/** One rendered article row. Tolerates the bridge's column names and the
 * finnhub field names (Title/Headline, Publisher/Source, Key Facts/Summary). */
const ARTICLE_LINE =
  /^\s*(?:Title|Headline):\s*(.*?)\s*\|\s*(?:Publisher|Source):\s*(.*?)\s*\|\s*Date:\s*(.*?)(?:\s*\|\s*(?:Key Facts|Summary):\s*(.*))?$/;

export interface ProjectedNewsItem {
  headline: string;
  source: string;
  datetime: string;
  summary?: string;
  url?: string;
}

export interface ParsedNews {
  note: string;
  articles: ProjectedNewsItem[];
}

/** The article rows and any header note (staleness warning, …) in a rendered
 * news result, or null when the text carries no article rows (not a news
 * payload — callers leave it untouched). */
export function parseNewsText(text: string): ParsedNews | null {
  const articles: ProjectedNewsItem[] = [];
  const noteLines: string[] = [];
  for (const line of text.split("\n")) {
    const match = ARTICLE_LINE.exec(line);
    if (match) {
      const summary = (match[4] ?? "").trim();
      const item: ProjectedNewsItem = {
        headline: match[1].trim(),
        source: match[2].trim(),
        datetime: match[3].trim(),
      };
      // A link anywhere in the row is the article URL; keep it as a field
      // instead of leaving it buried in the summary text.
      const url = (summary || item.headline).match(/https?:\/\/\S+/);
      if (url) item.url = url[0];
      if (summary) item.summary = summary;
      articles.push(item);
    } else if (
      line.trim() &&
      !/^## /.test(line.trim()) &&
      !/^\(\d+ records?, showing up to \d+\)/.test(line.trim())
    ) {
      noteLines.push(line.trim());
    }
  }
  if (articles.length === 0) return null;
  return { note: noteLines.join(" "), articles };
}

function render(articles: ProjectedNewsItem[], note: string, summaryCap: number): string {
  const items = articles.map((article) => {
    const { summary, ...rest } = article;
    if (!summary || summaryCap <= 0) return rest;
    return {
      ...rest,
      summary:
        summary.length > summaryCap
          ? `${summary.slice(0, summaryCap).trimEnd()}…`
          : summary,
    };
  });
  const out: Record<string, unknown> = { news: items };
  if (note) out.note = note;
  return JSON.stringify(out);
}

/** The compact JSON projection of a rendered news text, sized under `budget`
 * with every headline kept: summaries shrink (300 → 0) before any article is
 * dropped. Returns null when nothing fits (caller falls back to the generic
 * line cut) or when the text is not a news payload. */
export function projectFinnhubNewsText(
  text: string,
  budget: number = RESULT_BUDGET_CHARS,
): string | null {
  const parsed = parseNewsText(text);
  if (!parsed) return null;
  const at = (summaryCap: number) =>
    render(parsed.articles, parsed.note, summaryCap);
  if (at(MAX_SUMMARY_CHARS).length <= budget) return at(MAX_SUMMARY_CHARS);
  if (at(0).length > budget) return null;
  let low = 0;
  let high = MAX_SUMMARY_CHARS;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (at(mid).length <= budget) low = mid;
    else high = mid - 1;
  }
  return at(low);
}

/** The get_finnhub_news result the model reads: the bridge tool message with
 * its text content replaced by the compact projection. Any other tool, any
 * non-bridge shape and any non-news text passes through unchanged. */
export function compactFinnhubNews(toolName: string, result: unknown): unknown {
  if (!toolName.endsWith("get_finnhub_news")) return result;
  if (typeof result === "string") {
    return projectFinnhubNewsText(result) ?? result;
  }
  const content = bridgeContent(result);
  if (content === null) return result;
  const projected = projectFinnhubNewsText(content);
  if (projected === null) return result;
  return { ...(result as Record<string, unknown>), content: projected };
}
