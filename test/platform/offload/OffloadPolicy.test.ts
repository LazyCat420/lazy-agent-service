import { afterAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_OFFLOAD_CAP_CHARS,
  OffloadPolicy,
  OFFLOAD_STUB_HEADER,
  PRISM_ARRAY_ITEMS,
} from "../../../src/platform/offload/OffloadPolicy.ts";
import { OffloadStore } from "../../../src/platform/offload/OffloadStore.ts";

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "offload-policy-"));

afterAll(() => fs.rmSync(rootDir, { recursive: true, force: true }));

function tempStore(): OffloadStore {
  return new OffloadStore({ dir: path.join(rootDir, crypto.randomUUID()) });
}

/** A plain-text result over the cap: a short first line, then many full-width filler lines. */
function longText(): string {
  const fillerLine = "x".repeat(100);
  return ["alpha", ...Array.from({ length: 200 }, () => fillerLine)].join("\n");
}

describe("OffloadPolicy", () => {
  it("passes a small result through untouched", async () => {
    const decision = await OffloadPolicy.apply("short and sweet", { store: tempStore() });
    expect(decision.offloaded).toBe(false);
    expect(decision.modelVisible).toBe("short and sweet");
    expect(decision.offloadId).toBeUndefined();
  });

  it("passes a small JSON object through untouched", async () => {
    const result = { symbol: "AAPL", price: 251.4 };
    const decision = await OffloadPolicy.apply(result, { store: tempStore() });
    expect(decision.offloaded).toBe(false);
    expect(JSON.parse(decision.modelVisible)).toEqual(result);
  });

  it("cuts long text to whole leading lines and appends a recoverable note", async () => {
    const result = longText();
    const decision = await OffloadPolicy.apply(result, {
      store: tempStore(),
      toolName: "read_file",
    });
    expect(decision.offloaded).toBe(true);
    expect(decision.offloadId).toMatch(/^tr_[0-9a-f]{24}$/);
    expect(decision.modelVisible.length).toBeLessThanOrEqual(DEFAULT_OFFLOAD_CAP_CHARS);
    // Whole leading lines only: the filler lines shown are never cut mid-line.
    const visibleLines = decision.modelVisible.split("\n").filter((line) => line.startsWith("x"));
    expect(visibleLines.length).toBeGreaterThan(10);
    expect(visibleLines.every((line) => line === "x".repeat(100))).toBe(true);
    expect(decision.modelVisible.startsWith("alpha\n")).toBe(true);
    // The note names the sentinel and the retrieval path with the id.
    expect(decision.modelVisible).toContain(OFFLOAD_STUB_HEADER);
    expect(decision.modelVisible).toContain(`offload_id: ${decision.offloadId} (read_file, 201 lines, ${result.length} characters`);
    expect(decision.modelVisible).toContain("retrieve_offloaded_content");
  });

  it("pre-empts a top-level array over 10 items regardless of size", async () => {
    const result = Array.from({ length: 25 }, (_, i) => ({ i, note: `item-${i}` }));
    const decision = await OffloadPolicy.apply(result, { store: tempStore() });
    expect(decision.offloaded).toBe(true);
    const visible = jsonVisible(decision.modelVisible) as unknown[];
    expect(visible).toHaveLength(PRISM_ARRAY_ITEMS + 1);
    expect(visible[0]).toEqual({ i: 0, note: "item-0" });
    expect(visible[9]).toEqual({ i: 9, note: "item-9" });
    const marker = visible[PRISM_ARRAY_ITEMS] as { _truncated: string; offload_id: string };
    expect(marker._truncated).toBe(`Showing ${PRISM_ARRAY_ITEMS} of 25`);
    expect(marker.offload_id).toBe(decision.offloadId);
    expect(decision.modelVisible).toContain("retrieve_offloaded_content");
    expect(decision.modelVisible.length).toBeLessThanOrEqual(DEFAULT_OFFLOAD_CAP_CHARS);
  });

  it("pre-empts arrays under prism's wrapper keys and preserves identity keys", async () => {
    const result = {
      symbol: "MSFT",
      currency: "USD",
      events: Array.from({ length: 30 }, (_, i) => ({ id: `ev-${i}`, title: `Event ${i}` })),
    };
    const decision = await OffloadPolicy.apply(result, { store: tempStore() });
    expect(decision.offloaded).toBe(true);
    const visible = jsonVisible(decision.modelVisible) as Record<string, unknown>;
    // Identity/leading keys survive untouched.
    expect(visible.symbol).toBe("MSFT");
    expect(visible.currency).toBe("USD");
    const events = visible.events as unknown[];
    expect(events).toHaveLength(PRISM_ARRAY_ITEMS);
    expect(events[0]).toEqual({ id: "ev-0", title: "Event 0" });
    expect(visible._eventsTruncated).toBe(`Showing ${PRISM_ARRAY_ITEMS} of 30`);
    expect((visible._offload as { offload_id: string }).offload_id).toBe(decision.offloadId);
    expect(decision.modelVisible).toContain("retrieve_offloaded_content");
  });

  it("shortens the longest strings of oversized JSON first, keeping keys and leading characters", async () => {
    const filler = (n: number, seed: string) => `${seed}-${"y".repeat(n)}`;
    const result = {
      summary: filler(6000, "summary"),
      analysis: filler(3000, "analysis"),
      symbol: "NVDA",
      count: 7,
    };
    const decision = await OffloadPolicy.apply(result, { store: tempStore() });
    expect(decision.offloaded).toBe(true);
    expect(decision.modelVisible.length).toBeLessThanOrEqual(DEFAULT_OFFLOAD_CAP_CHARS);
    const visible = jsonVisible(decision.modelVisible) as Record<string, unknown>;
    // Every key preserved; scalar identity intact; shortened strings keep their leading characters.
    expect(Object.keys(visible)).toEqual(["summary", "analysis", "symbol", "count"]);
    expect(visible.symbol).toBe("NVDA");
    expect(visible.count).toBe(7);
    expect(visible.summary).toMatch(/^summary-y/);
    expect(String(visible.summary).length).toBeLessThan(6000);
    // Strings already short enough are left whole (only the longest give way).
    expect(visible.analysis).toBe(filler(3000, "analysis"));
    // The note points back at the full payload in the store.
    expect(decision.modelVisible).toContain(`offload_id: ${decision.offloadId}`);
  });

  it("trims long lists after strings when the result is still over budget", async () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({ idx: i, tag: `row-${i}` }));
    const decision = await OffloadPolicy.apply({ rows, meta: "compact" }, { store: tempStore() });
    expect(decision.offloaded).toBe(true);
    expect(decision.modelVisible.length).toBeLessThanOrEqual(DEFAULT_OFFLOAD_CAP_CHARS);
    const visible = jsonVisible(decision.modelVisible) as { rows: unknown[]; meta: string };
    expect(visible.meta).toBe("compact");
    expect(visible.rows.length).toBeLessThan(400);
    expect(visible.rows.length).toBeGreaterThan(0);
    expect((visible.rows[0] as { idx: number }).idx).toBe(0);
  });

  it("derives the same offload_id for the same content", async () => {
    const result = longText();
    const first = await OffloadPolicy.apply(result, { store: tempStore(), toolName: "same_tool" });
    const second = await OffloadPolicy.apply(result, { store: tempStore(), toolName: "same_tool" });
    expect(first.offloadId).toBe(second.offloadId);
  });

  it("respects a custom cap", async () => {
    const decision = await OffloadPolicy.apply(longText(), {
      store: tempStore(),
      cap: 500,
    });
    expect(decision.offloaded).toBe(true);
    expect(decision.modelVisible.length).toBeLessThanOrEqual(500);
  });
});

/** The model-visible stub is fitted JSON followed by the appended note — split them. */
function jsonVisible(modelVisible: string): unknown {
  return JSON.parse(modelVisible.slice(0, modelVisible.indexOf(OFFLOAD_STUB_HEADER)).trim());
}
