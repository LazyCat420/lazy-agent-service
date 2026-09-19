import logger from "../utils/logger.ts";
import { newsSearch } from "./NewsSearchService.ts";

export interface ExecutionResult {
  success: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export class GlobalCapabilityExecutor {
  /**
   * Execute a registered global capability.
   */
  static async execute(
    capabilityId: string,
    args: Record<string, unknown>,
  ): Promise<ExecutionResult> {
    if (["global.document.summarize", "global.media.transcribe", "global.media.describe_image"].includes(capabilityId)) {
      return { success: false, error: { code: "CAPABILITY_UNAVAILABLE", message: "No tested executor is installed for this capability" } };
    }
    try {
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
          return await this.executeWebSearch(args);
        case "global.web.read_page":
          return await this.executeReadPage(args);
        case "global.web.fetch_metadata":
          return await this.executeFetchMetadata(args);
        default:
          return {
            success: false,
            error: {
              code: "UNKNOWN_CAPABILITY",
              message: `Unknown global capability '${capabilityId}'`,
            },
          };
      }
    } catch (err: any) {
      return {
        success: false,
        error: {
          code: "CAPABILITY_EXECUTION_FAILED",
          message: err.message || "Unknown error executing global capability",
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
        if (Array.isArray(current)) {
          current = current.map((item: any) => {
            const picked: Record<string, unknown> = {};
            for (const f of op.fields) {
              if (item && item[f] !== undefined) picked[f] = item[f];
            }
            return picked;
          });
        } else if (typeof current === "object" && current !== null) {
          const picked: Record<string, unknown> = {};
          for (const f of op.fields) {
            if (current[f] !== undefined) picked[f] = current[f];
          }
          current = picked;
        }
        applied++;
      } else if (op.op === "rename" && typeof op.mapping === "object" && op.mapping !== null) {
        const mapping = op.mapping as Record<string, string>;
        if (Array.isArray(current)) {
          current = current.map((item: any) => {
            const renamed = { ...item };
            for (const [oldKey, newKey] of Object.entries(mapping)) {
              if (renamed[oldKey] !== undefined) {
                renamed[newKey] = renamed[oldKey];
                delete renamed[oldKey];
              }
            }
            return renamed;
          });
        } else if (typeof current === "object" && current !== null) {
          const renamed = { ...current };
          for (const [oldKey, newKey] of Object.entries(mapping)) {
            if (renamed[oldKey] !== undefined) {
              renamed[newKey] = renamed[oldKey];
              delete renamed[oldKey];
            }
          }
          current = renamed;
        }
        applied++;
      } else if (op.op === "aggregate" && Array.isArray(current)) {
        const aggKey = op.aggregate_key as string;
        const aggType = op.aggregate_type as string;
        const numbers = current
          .map((item: any) => Number(item?.[aggKey]))
          .filter((n: number) => !isNaN(n));

        let aggVal: number = 0;
        if (aggType === "sum") {
          aggVal = numbers.reduce((a, b) => a + b, 0);
        } else if (aggType === "avg") {
          aggVal = numbers.length > 0 ? numbers.reduce((a, b) => a + b, 0) / numbers.length : 0;
        } else if (aggType === "min") {
          aggVal = numbers.length > 0 ? Math.min(...numbers) : 0;
        } else if (aggType === "max") {
          aggVal = numbers.length > 0 ? Math.max(...numbers) : 0;
        } else if (aggType === "count") {
          aggVal = current.length;
        }
        current = { [aggKey || "result"]: aggVal, aggregate_type: aggType, count: current.length };
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

  private static async executeWebSearch(args: Record<string, unknown>): Promise<ExecutionResult> {
    const query = String(args.query || "");
    if (!query.trim()) {
      return {
        success: false,
        error: { code: "INVALID_ARGUMENTS", message: "query cannot be empty" },
      };
    }
    const maxResults = Math.min(20, Math.max(1, Number(args.max_results || 5)));

    try {
      const searchRes = await newsSearch(query, maxResults);
      const items = (searchRes?.items || []).slice(0, maxResults);
      return {
        success: true,
        result: {
          query,
          results: items.map((r: any) => ({
            title: r.title || "Untitled",
            url: r.url || "",
            snippet: r.snippet || r.description || "",
            source: r.source || searchRes?.source || "web",
          })),
        },
      };
    } catch (err: any) {
      return {
        success: false,
        error: {
          code: "WEB_SEARCH_FAILED",
          message: err.message || "Failed to execute web search",
        },
      };
    }
  }

  private static async executeReadPage(args: Record<string, unknown>): Promise<ExecutionResult> {
    const url = String(args.url || "");
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return {
        success: false,
        error: { code: "INVALID_ARGUMENTS", message: "url must be a valid HTTP/HTTPS address" },
      };
    }
    const maxChars = Math.min(50000, Math.max(500, Number(args.max_chars || 8000)));

    try {
      // Bounded HTTP fetch
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) {
        return {
          success: false,
          error: {
            code: "PAGE_FETCH_ERROR",
            message: `HTTP fetch failed with status ${res.status}`,
          },
        };
      }

      const html = await res.text();
      // Simple text strip for bounded markdown
      const stripped = html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const bounded = stripped.slice(0, maxChars);
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
      return {
        success: false,
        error: {
          code: "PAGE_READ_FAILED",
          message: err.message || "Failed to read page content",
        },
      };
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

  private static async executeFetchMetadata(args: Record<string, unknown>): Promise<ExecutionResult> {
    const url = String(args.url || "");
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return { success: false, error: { code: "INVALID_ARGUMENTS", message: "url must be a valid HTTP/HTTPS address" } };
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      const html = await res.text();
      const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
      const descMatch = /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i.exec(html);
      const ogImgMatch = /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(html);
      return {
        success: true,
        result: {
          url,
          title: titleMatch ? titleMatch[1].trim() : "Metadata Result",
          description: descMatch ? descMatch[1].trim() : "",
          canonical_url: url,
          image: ogImgMatch ? ogImgMatch[1].trim() : undefined,
        },
      };
    } catch (err: any) {
      return { success: false, error: { code: "METADATA_FETCH_FAILED", message: err.message || "Metadata retrieval failed" } };
    }
  }



}
