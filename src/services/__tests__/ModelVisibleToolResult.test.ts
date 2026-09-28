import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  bridgeContent, fitForPrism, modelVisibleText, prismMeasure,
  PRISM_ARRAY_ITEMS, PRISM_CAPPED_ARRAY_KEYS, PRISM_INLINE_RESULT_CHARS,
} from "../ModelVisibleToolResult.ts";

// The two bridge results prism offloaded on 2026-09-28 (read back from prism's
// offloaded_tool_results): CRH news for the junior analyst, and the USA bear rebuttal a
// whiteboard_read returned. Both reached the model as a preview of four wrapper keys.
const fixture = (name: string) => JSON.parse(fs.readFileSync(
  path.resolve(__dirname, "../../../test/fixtures/prism-offload-2026-09-28", name), "utf8"));
const news = fixture("get_finnhub_news.bridge.json");
const whiteboard = fixture("whiteboard_read.bridge.json");

/** prism's decision, restated from its source: MCPClientService.transformCallResult parses a lone
 * JSON text block (anything else becomes {result: text}); FunctionCallingUtilities.truncateToolResult
 * passes a string through while it is <= 8000 characters, and an object or array only while
 * JSON.stringify of it is <= 8000 AND no top-level array, nor an array under one of its listed
 * keys, holds more than 10 items. Anything else is offloaded behind retrieve_offloaded_content. */
function prismPassesWhole(text: string): boolean {
  let value: unknown;
  try { value = JSON.parse(text); } catch { value = { result: text }; }
  if (typeof value === "string") return value.length <= PRISM_INLINE_RESULT_CHARS;
  if (!value || typeof value !== "object") return true;
  if (Array.isArray(value) && value.length > PRISM_ARRAY_ITEMS) return false;
  if (!Array.isArray(value) && PRISM_CAPPED_ARRAY_KEYS.some((key) => {
    const items = (value as Record<string, unknown>)[key];
    return Array.isArray(items) && items.length > PRISM_ARRAY_ITEMS;
  })) return false;
  return JSON.stringify(value).length <= PRISM_INLINE_RESULT_CHARS;
}

describe("the bridge result the model reads", () => {
  it("SABOTAGE CONTROL: the wrapped results prism offloaded on 2026-09-28 do not pass whole", () => {
    // If this ever passes, the fixtures no longer reproduce the failure the rest of the file fixes.
    expect(prismPassesWhole(JSON.stringify(news))).toBe(false);
    expect(prismPassesWhole(JSON.stringify(whiteboard))).toBe(false);
  });

  it("drops the tool-message wrapper and its second layer of escaping, keeping a small result as it is", () => {
    const content = JSON.stringify({ total_matches: 1, rows: [{ ticker: "CRH", pe_ratio: 14.58, note: "a \"quoted\" word" }] });
    const wrapped = { role: "tool", tool_call_id: "call_lazy_tool_bridge", name: "screener_query", content, service_source: "trading-service" };
    const visible = modelVisibleText(wrapped);
    expect(visible).toMatchObject({ text: content, cut: false });
    expect(visible.text.length).toBeLessThan(JSON.stringify(wrapped).length);
  });

  it("leaves every non-bridge result exactly as it was", () => {
    const timeout = { error: "TOOL_TIMEOUT: x", is_error: true };
    expect(modelVisibleText(timeout)).toEqual({ text: JSON.stringify(timeout), cut: false });
    expect(modelVisibleText("plain")).toEqual({ text: "plain", cut: false });
    expect(modelVisibleText({ role: "assistant", content: "x" })).toEqual({ text: '{"role":"assistant","content":"x"}', cut: false });
    expect(bridgeContent({ role: "tool", content: { nested: true } })).toBeNull();
  });

  it("keeps whole leading news lines — the header and the newest articles — and says what it cut", () => {
    const inner = bridgeContent(news)!;
    const visible = fitForPrism(inner);
    expect(visible.cut).toBe(true);
    expect(prismPassesWhole(visible.text)).toBe(true);
    const shown = visible.text.split("\n");
    const original = inner.split("\n");
    const note = shown.pop()!;
    expect(note).toMatch(/^\[lazy-agent-service: cut to fit .* showing \d+ of 22 lines/);
    expect(shown).toEqual(original.slice(0, shown.length));
    expect(shown.find((line) => line.trim())).toContain("COLD NEWS");
    expect(shown.filter((line) => line.trim().startsWith("Title:")).length).toBeGreaterThanOrEqual(6);
  });

  it("shortens a whiteboard section's long strings but keeps its identity and structure", () => {
    const inner = bridgeContent(whiteboard)!;
    const visible = fitForPrism(inner);
    expect(visible.cut).toBe(true);
    expect(prismPassesWhole(visible.text)).toBe(true);
    const before = JSON.parse(inner);
    const after = JSON.parse(visible.text);
    expect(after.status).toBe(before.status);
    expect(after.data).toMatchObject({ id: before.data.id, section: before.data.section, author_agent: before.data.author_agent });
    expect(after.data.content.summary.slice(0, 200)).toBe(before.data.content.summary.slice(0, 200));
    expect(after._cut).toContain("per-result limit");
  });

  it("pre-empts prism's 10-item list cap, which fires on a small result too", () => {
    const events = Array.from({ length: 15 }, (_, i) => ({ date: `2026-10-${10 + i}`, kind: "earnings" }));
    const keyed = fitForPrism(JSON.stringify({ ticker: "CRH", events }));
    expect(keyed.cut).toBe(true);
    expect(prismPassesWhole(keyed.text)).toBe(true);
    const parsed = JSON.parse(keyed.text);
    expect(parsed.events).toHaveLength(PRISM_ARRAY_ITEMS);
    expect(parsed.events.at(-1)).toMatch(/6 more items cut/);
    const top = fitForPrism(JSON.stringify(events));
    expect(JSON.parse(top.text)).toHaveLength(PRISM_ARRAY_ITEMS);
    expect(prismPassesWhole(top.text)).toBe(true);
    // An unlisted key is not capped by prism, so it is not cut here either.
    const rows = JSON.stringify({ rows: events });
    expect(fitForPrism(rows)).toMatchObject({ text: rows, cut: false });
  });

  it("falls back to leading text for JSON no string or list cut can shrink", () => {
    const wide = Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`k${i}`, i]));
    const visible = fitForPrism(JSON.stringify(wide));
    expect(visible.cut).toBe(true);
    expect(prismPassesWhole(visible.text)).toBe(true);
    expect(visible.text).toContain('"k0": 0');
  });

  it("cuts an over-long single line by characters when not even one whole line fits", () => {
    const line = "x".repeat(20_000);
    const visible = fitForPrism(line);
    expect(prismPassesWhole(visible.text)).toBe(true);
    expect(visible.text.startsWith("x".repeat(1000))).toBe(true);
    expect(visible.text).toMatch(/showing 0 of 1 lines/);
  });

  it("is a fixed point: a fitted result fits as it is", () => {
    for (const content of [bridgeContent(news)!, bridgeContent(whiteboard)!]) {
      const once = fitForPrism(content);
      expect(fitForPrism(once.text)).toMatchObject({ text: once.text, cut: false });
      expect(prismMeasure(once.text)).toBe(once.after);
    }
  });
});
