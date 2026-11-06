/**
 * `whiteboard_find` must be offered by the catalog and routed as a read.
 *
 * It reads trading-service's per-(cycle, ticker) data ledger and never fetches,
 * so a repeat is reused or retried instead of blocked by the repeat guard. The
 * catalog entry is what the model is offered; `READ_ONLY_TOOLS` is what the
 * router treats as safe to repeat.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { READ_ONLY_TOOLS, isReadOnlyTool } from "../LocalToolRouter.ts";

type CatalogTool = {
  name: string;
  description?: string;
  parameters?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string; items?: unknown }>;
    required?: string[];
  };
  permission?: string;
};

const catalog: CatalogTool[] = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "tool_schemas.json"), "utf-8"),
);
const byName: Record<string, CatalogTool> = Object.fromEntries(catalog.map((t) => [t.name, t]));

describe("whiteboard_find catalog entry", () => {
  it("is offered with a required key and an optional ticker", () => {
    const tool = byName["whiteboard_find"];
    expect(tool).toBeDefined();
    expect(tool?.permission).toBe("read_only");
    expect(tool?.parameters?.required).toEqual(["key"]);
    expect(tool?.parameters?.properties?.key?.type).toBe("string");
    expect(tool?.parameters?.properties?.ticker?.type).toBe("string");
    expect(tool?.parameters?.properties?.ticker?.description).toContain("current desk ticker");
  });

  it("is routed as read-only under its bare and MCP-prefixed spellings", () => {
    expect(READ_ONLY_TOOLS.has("whiteboard_find")).toBe(true);
    expect(isReadOnlyTool("whiteboard_find")).toBe(true);
    expect(isReadOnlyTool("mcp__lazy-agent-service__whiteboard_find")).toBe(true);
  });
});

describe("whiteboard_write facts parameter", () => {
  it("accepts an array of key/value/unit/source/as_of claims", () => {
    const facts = byName["whiteboard_write"]?.parameters?.properties?.facts;
    expect(facts?.type).toBe("array");
    const items = facts?.items as {
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };
    expect(items?.required).toEqual(["key", "value"]);
    expect(Object.keys(items?.properties ?? {}).sort()).toEqual(
      ["as_of", "key", "source", "unit", "value"].sort(),
    );
    expect(items?.properties?.value?.type).toBe("number");
  });
});

describe("get_portfolio_covariance tickers description", () => {
  it("tells the model a single ticker is padded with the largest holdings", () => {
    const tickers = byName["get_portfolio_covariance"]?.parameters?.properties?.tickers;
    expect(tickers?.description).toBe(
      'Comma-separated tickers, ideally 2+ (e.g. "NVDA,AMD,MSFT"). A single ticker is padded ' +
        "with the largest current holdings (up to 10 total). Leave empty to analyse the current " +
        "holdings, which requires 2+ open positions.",
    );
  });
});
