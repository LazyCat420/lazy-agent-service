import { evalChaosEnabled, executeEvalChaos } from "./EvalChaosCapabilities.ts";
import { safeFetch, UnsafeUrlError, type SafeFetchResult } from "../utils/UrlSafety.ts";
import { webSearch, type WebResult } from "./WebSearchService.ts";
import { webExtract, type WebExtractResult } from "./WebExtractService.ts";

export interface ExecutionResult {
  success: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

function buildWebSearchResults(
  query: string,
  items: WebResult[],
  provider: string | undefined,
): ExecutionResult {
  return {
    success: true,
    result: {
      query,
      results: items.map((r: WebResult) => ({
        title: r.title || "Untitled",
        url: r.url || "",
        snippet: r.snippet || "",
        ...(r.published ? { published: r.published } : {}),
        source: provider || "web",
      })),
    },
  };
}

function buildWebSearchFailure(
  status: string | undefined,
  errorDetail: string | undefined,
): ExecutionResult {
  return {
    success: false,
    error: {
      code: "WEB_SEARCH_FAILED",
      message: `Web search did not run (${status || "error"}): ${errorDetail || "no detail"}. Try again later.`,
    },
  };
}

function mapWebSearchError(
  err: any,
  signal?: AbortSignal,
): ExecutionResult {
  if (signal?.aborted || err?.name === "AbortError") {
    return { success: false, error: { code: "CAPABILITY_CANCELLED", message: "Web search was cancelled" } };
  }
  return {
    success: false,
    error: {
      code: "WEB_SEARCH_FAILED",
      message: err.message || "Failed to execute web search",
    },
  };
}

interface PageMetadata {
  title: string;
  description: string;
  image: string | undefined;
}

function extractPageMetadata(html: string): PageMetadata {
  const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  const descMatch = /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i.exec(html);
  const ogImgMatch = /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(html);
  return {
    title: titleMatch ? titleMatch[1].trim() : "Metadata Result",
    description: descMatch ? descMatch[1].trim() : "",
    image: ogImgMatch ? ogImgMatch[1].trim() : undefined,
  };
}

async function fetchMetadataHtml(
  url: string,
  signal?: AbortSignal,
): Promise<SafeFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    return await safeFetch(url, { signal: controller.signal, maxBytes: 512_000 });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export class GlobalCapabilityExecutor {
  /** Injectable fallback extractor for `global.web.read_page` on 401/403 or EMPTY_CONTENT. */
  static webExtractFallback: (
    url: string,
    charLimit?: number,
  ) => Promise<WebExtractResult> = webExtract;

  /** Injectable safeFetch implementation for testing `global.web.read_page`. */
  static safeFetchImpl: typeof safeFetch = safeFetch;

  /**
   * Execute a registered global capability.
   */
  static async execute(
    capabilityId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    if (["global.document.summarize", "global.media.transcribe", "global.media.describe_image"].includes(capabilityId)) {
      return { success: false, error: { code: "CAPABILITY_UNAVAILABLE", message: "No tested executor is installed for this capability" } };
    }
    try {
      if (capabilityId.startsWith("global.eval_chaos.")) {
        if (!evalChaosEnabled()) return { success: false, error: { code: "UNKNOWN_CAPABILITY", message: `Unknown global capability '${capabilityId}'` } };
        return await executeEvalChaos(capabilityId, signal);
      }
      return await this.dispatchCapability(capabilityId, args, signal);
    } catch (err: any) {
      if (signal?.aborted || err?.name === "AbortError") {
        return { success: false, error: { code: "CAPABILITY_CANCELLED", message: "Capability execution was cancelled" } };
      }
      return {
        success: false,
        error: {
          code: "CAPABILITY_EXECUTION_FAILED",
          message: err.message || "Unknown error executing global capability",
        },
      };
    }
  }

  private static async dispatchCapability(
    capabilityId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    switch (capabilityId) {
      case "global.data.sort":
        return this.executeSort(args);
      case "global.data.filter":
        return this.executeFilter(args);
      case "global.data.transform":
        return this.executeTransform(args);
      case "global.data.extract":
        return this.executeExtract(args);
      case "global.data.group":
        return this.executeGroup(args);
      case "global.data.classify":
        return this.executeClassify(args);
      case "global.document.chunk":
        return this.executeChunk(args);
      case "global.time.now":
        return this.executeTimeNow(args);
      case "global.math.calculate":
        return this.executeCalculate(args);
      case "global.web.search":
        return await this.executeWebSearch(args, signal);
      case "global.web.read_page":
        return await this.executeReadPage(args, signal);
      case "global.web.fetch_metadata":
        return await this.executeFetchMetadata(args, signal);
      default:
        return {
          success: false,
          error: {
            code: "UNKNOWN_CAPABILITY",
            message: `Unknown global capability '${capabilityId}'`,
          },
        };
    }
  }

  private static executeSort(args: Record<string, unknown>): ExecutionResult {
    const items = args.items;
    const key = args.key as string;
    const direction = (args.direction as string) || "asc";

    if (!Array.isArray(items)) {
      return {
        success: false,
        error: { code: "INVALID_ARGUMENTS", message: "items must be an array of objects" },
      };
    }
    if (!key || typeof key !== "string") {
      return {
        success: false,
        error: { code: "INVALID_ARGUMENTS", message: "key must be a non-empty string" },
      };
    }

    const sorted = [...items].sort((a: any, b: any) => {
      const valA = a?.[key];
      const valB = b?.[key];
      if (valA === valB) return 0;
      if (valA === undefined || valA === null) return 1;
      if (valB === undefined || valB === null) return -1;

      if (direction === "desc") {
        return valA < valB ? 1 : -1;
      }
      return valA > valB ? 1 : -1;
    });

    return {
      success: true,
      result: {
        items: sorted,
        count: sorted.length,
      },
    };
  }

  private static executeFilter(args: Record<string, unknown>): ExecutionResult {
    const items = args.items;
    const predicate = args.predicate as Record<string, unknown>;

    if (!Array.isArray(items)) {
      return {
        success: false,
        error: { code: "INVALID_ARGUMENTS", message: "items must be an array of objects" },
      };
    }
    if (!predicate || typeof predicate !== "object") {
      return {
        success: false,
        error: { code: "INVALID_ARGUMENTS", message: "predicate must be an object with field, op, value" },
      };
    }

    const field = predicate.field as string;
    const op = predicate.op as string;
    const targetVal = predicate.value;

    const filtered = items.filter((item: any) => {
      const itemVal = item?.[field];
      switch (op) {
        case "eq":
          return itemVal === targetVal;
        case "neq":
          return itemVal !== targetVal;
        case "gt":
          return Number(itemVal) > Number(targetVal);
        case "gte":
          return Number(itemVal) >= Number(targetVal);
        case "lt":
          return Number(itemVal) < Number(targetVal);
        case "lte":
          return Number(itemVal) <= Number(targetVal);
        case "contains":
          return String(itemVal).toLowerCase().includes(String(targetVal).toLowerCase());
        case "in":
          return Array.isArray(targetVal) && targetVal.includes(itemVal);
        default:
          return true;
      }
    });

    return {
      success: true,
      result: {
        items: filtered,
        count: filtered.length,
      },
    };
  }

  private static pickFieldsFromObject(
    item: Record<string, unknown>,
    fields: string[],
  ): Record<string, unknown> {
    const picked: Record<string, unknown> = {};
    for (const f of fields) {
      if (item && item[f] !== undefined) picked[f] = item[f];
    }
    return picked;
  }

  private static applyPickTransform(current: any, fields: string[]): any {
    if (Array.isArray(current)) {
      return current.map((item: any) => this.pickFieldsFromObject(item, fields));
    }
    if (typeof current === "object" && current !== null) {
      return this.pickFieldsFromObject(current, fields);
    }
    return current;
  }

  private static renameFieldsInObject(
    item: Record<string, unknown>,
    mapping: Record<string, string>,
  ): Record<string, unknown> {
    const renamed = { ...item };
    for (const [oldKey, newKey] of Object.entries(mapping)) {
      if (renamed[oldKey] !== undefined) {
        renamed[newKey] = renamed[oldKey];
        delete renamed[oldKey];
      }
    }
    return renamed;
  }

  private static applyRenameTransform(
    current: any,
    mapping: Record<string, string>,
  ): any {
    if (Array.isArray(current)) {
      return current.map((item: any) => this.renameFieldsInObject(item, mapping));
    }
    if (typeof current === "object" && current !== null) {
      return this.renameFieldsInObject(current, mapping);
    }
    return current;
  }

  private static computeAggregateValue(
    aggType: string,
    numbers: number[],
    totalCount: number,
  ): number {
    if (aggType === "sum") return numbers.reduce((a, b) => a + b, 0);
    if (aggType === "avg") {
      return numbers.length > 0
        ? numbers.reduce((a, b) => a + b, 0) / numbers.length
        : 0;
    }
    if (aggType === "min") return numbers.length > 0 ? Math.min(...numbers) : 0;
    if (aggType === "max") return numbers.length > 0 ? Math.max(...numbers) : 0;
    if (aggType === "count") return totalCount;
    return 0;
  }

  private static applyAggregateTransform(current: any[], op: any): any {
    const aggKey = op.aggregate_key as string;
    const aggType = op.aggregate_type as string;
    const numbers = current
      .map((item: any) => Number(item?.[aggKey]))
      .filter((n: number) => !isNaN(n));
    const aggVal = this.computeAggregateValue(aggType, numbers, current.length);
    return {
      [aggKey || "result"]: aggVal,
      aggregate_type: aggType,
      count: current.length,
    };
  }

  private static executeTransform(args: Record<string, unknown>): ExecutionResult {
    const input = args.input;
    const operations = args.operations;

    if (input === undefined || input === null) {
      return {
        success: false,
        error: { code: "INVALID_ARGUMENTS", message: "input must be provided" },
      };
    }
    if (!Array.isArray(operations)) {
      return {
        success: false,
        error: { code: "INVALID_ARGUMENTS", message: "operations must be an array" },
      };
    }

    let current: any = JSON.parse(JSON.stringify(input));
    let applied = 0;

    for (const op of operations) {
      if (op.op === "pick" && Array.isArray(op.fields)) {
        current = this.applyPickTransform(current, op.fields);
        applied++;
      } else if (op.op === "rename" && typeof op.mapping === "object" && op.mapping !== null) {
        current = this.applyRenameTransform(current, op.mapping as Record<string, string>);
        applied++;
      } else if (op.op === "aggregate" && Array.isArray(current)) {
        current = this.applyAggregateTransform(current, op);
        applied++;
      }
    }

    return {
      success: true,
      result: {
        output: current,
        operations_applied: applied,
      },
    };
  }

  private static executeExtract(args: Record<string, unknown>): ExecutionResult {
    const text = String(args.text || "");
    const patterns = (args.patterns as Record<string, string>) || {};

    const entities: Record<string, string[]> = {};
    for (const [name, regexStr] of Object.entries(patterns)) {
      try {
        const regex = new RegExp(regexStr, "gi");
        const matches = text.match(regex) || [];
        entities[name] = Array.from(new Set(matches));
      } catch {
        entities[name] = [];
      }
    }

    return {
      success: true,
      result: {
        entities,
      },
    };
  }

  private static async executeWebSearch(args: Record<string, unknown>, signal?: AbortSignal): Promise<ExecutionResult> {
    const query = String(args.query || "");
    if (!query.trim()) {
      return {
        success: false,
        error: { code: "INVALID_ARGUMENTS", message: "query cannot be empty" },
      };
    }
    const maxResults = Math.min(20, Math.max(1, Number(args.max_results || 5)));

    try {
      // Consolidated 2026-10-10: this used to call newsSearch (Bing/Google
      // News RSS only). The shared webSearch (Exa keyless + SearXNG fallback,
      // one cache and rate limit for the whole network) covers news AND the
      // general web, so every consumer of this capability gets the better
      // backend. Result shape is unchanged; `source` carries the provider.
      const searchRes = await webSearch(query, Math.min(10, maxResults), undefined, signal);
      const items = (searchRes?.results || []).slice(0, maxResults);
      if (searchRes?.status === "cancelled") {
        return { success: false, error: { code: "CAPABILITY_CANCELLED", message: "Web search was cancelled" } };
      }
      if (searchRes?.status !== "ok" && items.length === 0) {
        return buildWebSearchFailure(searchRes?.status, searchRes?.error);
      }
      return buildWebSearchResults(query, items, searchRes?.provider);
    } catch (err: any) {
      return mapWebSearchError(err, signal);
    }
  }

  private static async tryWebExtractPageFallback(
    url: string,
    maxChars: number,
    minTrimmedLength: number,
  ): Promise<ExecutionResult | null> {
    try {
      const fallback = await this.webExtractFallback(url, maxChars);
      if (
        fallback.status === "ok" &&
        fallback.content.trim().length >= minTrimmedLength
      ) {
        const fallbackBounded = fallback.content.slice(0, maxChars);
        return {
          success: true,
          result: {
            url,
            title: "Extracted Page Content",
            content: fallbackBounded,
            character_count: fallbackBounded.length,
            fallback_used: "web_extract",
            ...(fallback.engineUsed ? { engine_used: fallback.engineUsed } : {}),
          },
        };
      }
    } catch {
      // Ignore fallback error and return null so caller returns standard error
    }
    return null;
  }

  private static async fetchPageHtmlBounded(
    url: string,
    signal?: AbortSignal,
  ): Promise<SafeFetchResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      const headers: Record<string, string> = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      };
      return await this.safeFetchImpl(url, {
        signal: controller.signal,
        headers,
        maxBytes: 2_000_000,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  private static mapReadPageError(
    err: any,
    signal?: AbortSignal,
  ): ExecutionResult {
    if (err instanceof UnsafeUrlError || err?.cause instanceof UnsafeUrlError) {
      return {
        success: false,
        error: {
          code: "URL_BLOCKED",
          message: `blocked: ${(err.cause ?? err).message} (SSRF guard)`,
        },
      };
    }
    if (signal?.aborted) {
      return {
        success: false,
        error: {
          code: "CAPABILITY_CANCELLED",
          message: "Page read was cancelled",
        },
      };
    }
    if (err?.name === "AbortError") {
      return {
        success: false,
        error: {
          code: "TIMEOUT",
          message:
            "Page read timed out after 15 s. Use the search snippet or another source.",
        },
      };
    }
    return {
      success: false,
      error: {
        code: "FETCH_FAILED",
        message: `Failed to read page: ${err?.message || "network error"}. Use the search snippet or another source.`,
      },
    };
  }

  private static async executeReadPage(args: Record<string, unknown>, signal?: AbortSignal): Promise<ExecutionResult> {
    const url = String(args.url || "");
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return {
        success: false,
        error: { code: "INVALID_ARGUMENTS", message: "url must be a valid HTTP/HTTPS address" },
      };
    }
    const maxChars = Math.min(50000, Math.max(500, Number(args.max_chars || 8000)));

    try {
      const res = await this.fetchPageHtmlBounded(url, signal);
      const canRunFallback =
        this.webExtractFallback !== webExtract ||
        typeof (this.safeFetchImpl as { mock?: unknown })?.mock === "undefined";

      if (!res.ok) {
        const isBlockStatus =
          res.status === 401 || res.status === 403 || res.status === 429;
        if (canRunFallback && isBlockStatus) {
          const fallbackResult = await this.tryWebExtractPageFallback(
            url,
            maxChars,
            1,
          );
          if (fallbackResult) return fallbackResult;
        }
        return {
          success: false,
          error: {
            code: "HTTP_ERROR",
            message: `HTTP ${res.status} ${res.statusText}: the site blocked automated access or the page was not found. Use the search snippet or another source.`,
          },
        };
      }

      const stripped = res.text
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const bounded = stripped.slice(0, maxChars);
      if (bounded.trim().length < 200) {
        if (canRunFallback) {
          const fallbackResult = await this.tryWebExtractPageFallback(
            url,
            maxChars,
            200,
          );
          if (fallbackResult) return fallbackResult;
        }
        return {
          success: false,
          error: {
            code: "EMPTY_CONTENT",
            message: `The page returned no readable text (${bounded.trim().length} chars). It may need JavaScript. Use the search snippet or another source.`,
          },
        };
      }
      return {
        success: true,
        result: {
          url,
          title: "Extracted Page Content",
          content: bounded,
          character_count: bounded.length,
        },
      };
    } catch (err: any) {
      return this.mapReadPageError(err, signal);
    }
  }

  private static executeGroup(args: Record<string, unknown>): ExecutionResult {
    const items = args.items;
    const groupBy = String(args.group_by || "");
    if (!Array.isArray(items)) {
      return { success: false, error: { code: "INVALID_ARGUMENTS", message: "items must be an array" } };
    }
    if (!groupBy) {
      return { success: false, error: { code: "INVALID_ARGUMENTS", message: "group_by must be specified" } };
    }
    const groups: Record<string, any[]> = {};
    for (const item of items) {
      const key = String(item?.[groupBy] ?? "undefined");
      if (!groups[key]) groups[key] = [];
      groups[key].push(item);
    }
    return {
      success: true,
      result: {
        groups,
        group_count: Object.keys(groups).length,
      },
    };
  }

  private static executeClassify(args: Record<string, unknown>): ExecutionResult {
    const item = args.item as Record<string, unknown>;
    const rules = args.rules as Array<{ field: string; match: string; category: string }>;
    if (!item || typeof item !== "object" || !Array.isArray(rules)) {
      return { success: false, error: { code: "INVALID_ARGUMENTS", message: "item and rules required" } };
    }
    const categories: string[] = [];
    for (const rule of rules) {
      const val = String(item[rule.field] || "");
      if (val.includes(rule.match) || new RegExp(rule.match, "i").test(val)) {
        categories.push(rule.category);
      }
    }
    return {
      success: true,
      result: { categories },
    };
  }

  private static executeChunk(args: Record<string, unknown>): ExecutionResult {
    const text = String(args.text || "");
    const chunkSize = Math.max(100, Number(args.chunk_size || 1000));
    const overlap = Math.max(0, Math.min(chunkSize - 1, Number(args.overlap || 100)));
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      chunks.push(text.slice(start, end));
      if (end >= text.length) break;
      start += chunkSize - overlap;
    }
    return {
      success: true,
      result: { chunks, count: chunks.length },
    };
  }


  private static executeTimeNow(args: Record<string, unknown>): ExecutionResult {
    const timezone = String(args.timezone || "UTC");
    const now = new Date();
    return {
      success: true,
      result: {
        iso: now.toISOString(),
        timestamp: now.getTime(),
        timezone,
      },
    };
  }

  private static executeCalculate(args: Record<string, unknown>): ExecutionResult {
    const expr = String(args.expression || "").trim();
    if (!/^[\d\s+\-*/().%^]+$/.test(expr)) {
      return { success: false, error: { code: "INVALID_ARGUMENTS", message: "Invalid arithmetic expression" } };
    }
    try {
      // Safe numeric calculation
      const sanitized = expr.replace(/\^/g, "**");
      // eslint-disable-next-line no-new-func
      const calcFn = new Function(`return (${sanitized});`);
      const result = Number(calcFn());
      if (isNaN(result) || !isFinite(result)) {
        return { success: false, error: { code: "CALCULATION_ERROR", message: "Result is not a finite number" } };
      }
      return { success: true, result: { result } };
    } catch (err: any) {
      return { success: false, error: { code: "CALCULATION_ERROR", message: err.message } };
    }
  }

  private static async executeFetchMetadata(args: Record<string, unknown>, signal?: AbortSignal): Promise<ExecutionResult> {
    const url = String(args.url || "");
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return { success: false, error: { code: "INVALID_ARGUMENTS", message: "url must be a valid HTTP/HTTPS address" } };
    }
    try {
      const res = await fetchMetadataHtml(url, signal);
      const html = res.text;
      const { title, description, image } = extractPageMetadata(html);
      return {
        success: true,
        result: {
          url,
          title,
          description,
          canonical_url: url,
          image,
        },
      };
    } catch (err: any) {
      if (err instanceof UnsafeUrlError || err?.cause instanceof UnsafeUrlError) {
        return { success: false, error: { code: "URL_BLOCKED", message: `blocked: ${(err.cause ?? err).message} (SSRF guard)` } };
      }
      if (signal?.aborted || err?.name === "AbortError") {
        return { success: false, error: { code: "CAPABILITY_CANCELLED", message: "Metadata fetch was cancelled" } };
      }
      return { success: false, error: { code: "METADATA_FETCH_FAILED", message: err.message || "Metadata retrieval failed" } };
    }
  }



}
