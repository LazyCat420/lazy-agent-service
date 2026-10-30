/**
 * URL normalization for `scrape_url`.
 *
 * Models write search results and headlines the way the page shows them:
 * `domain.tld/path`, with no scheme. The SSRF guard rejects plain http, so a
 * missing scheme becomes https. A relative path cannot be turned into a host,
 * so it is returned unchanged and the caller rejects it with an actionable
 * message.
 *
 * This lives outside WebExtractService on purpose: LocalToolRouter needs it
 * before the deny-list and budget checks, and importing WebExtractService
 * there would pull the whole provider registry into every router consumer.
 */
export function normalizeScrapeUrl(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (/^[a-z0-9](?:[a-z0-9-]*\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(value)) {
    return `https://${value}`;
  }
  return value;
}
