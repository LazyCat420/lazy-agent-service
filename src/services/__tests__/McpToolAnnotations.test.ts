import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MCP_TOOL_ANNOTATIONS,
  annotationsFor,
  toMcpTool,
  type McpToolAnnotations,
} from "../McpToolAnnotations.js";

type CatalogEntry = {
  name: string;
  description?: string;
  parameters?: unknown;
  permission?: string;
};

const catalog: CatalogEntry[] = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "tool_schemas.json"), "utf-8"),
);
const byName = new Map(catalog.map((t) => [t.name, t]));

// A local mirror of prism-service's rules (ToolCapabilities.capabilitiesFromMcpAnnotations
// and UntrustedSpans.isTaintSensitive). Prism is not ours to change and its
// listing hides annotations, so the live probe is the final proof; this pins
// what we assume the annotations achieve.
function prismCapabilities(a?: McpToolAnnotations): string[] {
  const caps = ["mcp", a?.readOnlyHint === true ? "fs_read" : "external_side_effect"];
  if (a?.openWorldHint !== false) caps.push("network");
  return caps;
}
function taintSensitive(caps: string[]): boolean {
  return (
    caps.includes("shell") ||
    caps.includes("fs_write") ||
    (caps.includes("network") && caps.includes("external_side_effect"))
  );
}

// Money movement, persistence that later agents run or obey, and scheduling:
// a tool result must never be able to steer these without a human.
// The catalog labels run_equation, run_backtest, save_equation and
// run_tool_chain read_only although they execute model-written Python,
// overwrite a library equation's stats, persist a new equation, or chain other
// calls, so the label is no guide and they are pinned by name.
const MUST_STAY_GATED = [
  "buy_stock",
  "sell_stock",
  "add_to_watchlist",
  "remove_from_watchlist",
  "save_equation",
  "run_equation",
  "run_backtest",
  "run_tool_chain",
  "schedule_research",
  "request_research_now",
  "cancel_scheduled_research",
  "propose_parameter_change",
  "watch_ticker",
  "clear_watch",
];

// Tools whose free-text arguments repeated an earlier tool result (a URL, a
// headline, an equation name) and were denied by prism in a live unattended
// probe before they were annotated. Dropping one brings the denial back with
// nothing else failing, so the membership is pinned here.
const MUST_BE_ANNOTATED = [
  "scrape_url",
  "whiteboard_write",
  "whiteboard_annotate",
  "lazy_web_search",
  "search_equations",
];

describe("MCP tool annotations", () => {
  it("premise: an unannotated MCP tool is one prism denies on a tainted argument", () => {
    expect(taintSensitive(prismCapabilities(undefined))).toBe(true);
  });

  it("every annotated tool is one the gate no longer treats as taint-sensitive", () => {
    for (const [name, a] of Object.entries(MCP_TOOL_ANNOTATIONS)) {
      expect(taintSensitive(prismCapabilities(a)), name).toBe(false);
    }
  });

  it("every annotated name is a live catalog tool (no stale rows)", () => {
    for (const name of Object.keys(MCP_TOOL_ANNOTATIONS)) {
      expect(byName.has(name), `${name} is not in tool_schemas.json`).toBe(true);
    }
  });

  it("read-only is claimed exactly for the tools the catalog labels read_only", () => {
    for (const [name, a] of Object.entries(MCP_TOOL_ANNOTATIONS)) {
      expect(a.readOnlyHint === true, name).toBe(byName.get(name)?.permission === "read_only");
    }
  });

  it("a write tool is annotated as additive and closed-world, never read-only", () => {
    for (const [name, a] of Object.entries(MCP_TOOL_ANNOTATIONS)) {
      if (byName.get(name)?.permission !== "write") continue;
      expect(a.readOnlyHint, name).toBe(false);
      expect(a.destructiveHint, name).toBe(false);
      expect(a.openWorldHint, name).toBe(false);
    }
  });

  it("no tool is ever annotated destructive", () => {
    for (const [name, a] of Object.entries(MCP_TOOL_ANNOTATIONS)) {
      expect(a.destructiveHint, name).not.toBe(true);
    }
  });

  it("the tools the live probe saw denied stay annotated", () => {
    for (const name of MUST_BE_ANNOTATED) {
      expect(byName.has(name), `${name} left the catalog; drop it from this list`).toBe(true);
      expect(annotationsFor(name), name).toBeDefined();
    }
  });

  it("trade execution, code execution, persistence and scheduling tools stay behind the gate", () => {
    for (const name of MUST_STAY_GATED) {
      expect(byName.has(name), `${name} left the catalog; drop it from this list`).toBe(true);
      expect(annotationsFor(name), name).toBeUndefined();
    }
  });

  it("annotationsFor hands out a copy, so a caller cannot rewrite the table", () => {
    const first = annotationsFor("scrape_url");
    expect(first).toBeDefined();
    first!.readOnlyHint = false;
    expect(annotationsFor("scrape_url")?.readOnlyHint).toBe(true);
  });

  it("an annotated tool lists its annotations; every other tool lists exactly what it did before", () => {
    for (const t of catalog) {
      const listed = toMcpTool(t);
      const expected = annotationsFor(t.name);
      if (expected) {
        expect(listed.annotations, t.name).toEqual(expected);
      } else {
        expect(Object.keys(listed).sort(), t.name).toEqual(["description", "inputSchema", "name"]);
      }
      expect(listed.name).toBe(t.name);
      expect(listed.description).toBe(t.description || "");
      expect(listed.inputSchema).toEqual(t.parameters || { type: "object", properties: {} });
    }
  });
});
