/**
 * `read_ledger_entry` must be offered by the catalog and routed as a read,
 * while retired `whiteboard_read` / `whiteboard_find` are absent from the
 * catalog and routing sets.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { READ_ONLY_TOOLS, REPEAT_GUARDED_TOOLS, isReadOnlyTool } from "../LocalToolRouter.ts";

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

describe("read_ledger_entry catalog entry and routing", () => {
  it("is offered with lookup keys and optional ticker", () => {
    const tool = byName["read_ledger_entry"];
    expect(tool).toBeDefined();
    expect(tool?.permission).toBe("read_only");
    expect(tool?.parameters?.properties?.tool_name?.type).toBe("string");
    expect(tool?.parameters?.properties?.entry_id?.type).toBe("string");
    expect(tool?.parameters?.properties?.args_hash?.type).toBe("string");
    expect(tool?.parameters?.properties?.ticker?.type).toBe("string");
    expect(tool?.parameters?.properties?.ticker?.description).toContain("current desk ticker");
  });

  it("is routed as read-only under its bare and MCP-prefixed spellings", () => {
    expect(READ_ONLY_TOOLS.has("read_ledger_entry")).toBe(true);
    expect(isReadOnlyTool("read_ledger_entry")).toBe(true);
    expect(isReadOnlyTool("mcp__lazy-agent-service__read_ledger_entry")).toBe(true);
  });

  it("excludes retired whiteboard tools from catalog and router sets", () => {
    for (const retired of ["whiteboard_find", "whiteboard_read", "whiteboard_write", "whiteboard_annotate"]) {
      expect(byName[retired]).toBeUndefined();
      expect(READ_ONLY_TOOLS.has(retired)).toBe(false);
      expect(REPEAT_GUARDED_TOOLS.has(retired)).toBe(false);
    }
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
