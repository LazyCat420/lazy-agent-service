/**
 * ch.06 item 10 — the extraction watermark.
 *
 * Every trading run used to re-read the whole transcript for memory
 * extraction; now each call reads only the messages after the last one
 * already extracted, and a span with no user-authored message makes no call
 * at all. Ported from prism-service services/memory/ExtractionWatermark.ts
 * (simplified: content-hash identities + anchor, no platform ids).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../wrappers/MongoWrapper.ts", () => {
  const docs = new Map<string, unknown>();
  class MongoWrapper {
    static getDb() { return null; }
    static getClient() { return null; }
    static getCollection() {
      return {
        async findOne({ key }: { key: string }) {
          return docs.get(key) ?? null;
        },
        async updateOne({ key }: { key: string }, { $set }: { $set: unknown }) {
          docs.set(key, $set);
        },
      };
    }
    static _docs = docs;
  }
  return { default: MongoWrapper };
});

import {
  messageIdentities,
  readWatermark,
  selectExtractionSpan,
  writeWatermark,
} from "../ExtractionWatermark.ts";

const userMessage = (text: string) => ({ role: "user", content: text });
const assistantMessage = (text: string) => ({ role: "assistant", content: text });

describe("ExtractionWatermark.selectExtractionSpan", () => {
  it("first run: the whole transcript, marked first", () => {
    const span = selectExtractionSpan(
      [userMessage("buy COF"), assistantMessage("done")] as Array<Record<string, unknown>>,
      null,
    );
    expect(span.reason).toBe("first");
    expect(span.span).toHaveLength(2);
    expect(span.hasUserAuthored).toBe(true);
  });

  it("after the watermark: only the messages since", async () => {
    const transcript = [
      userMessage("buy COF"),
      assistantMessage("done"),
      userMessage("now sell COF"),
      assistantMessage("sold"),
    ];
    const scope = "conv-wm";
    await writeWatermark(scope, transcript.slice(0, 2) as Array<Record<string, unknown>>);
    const watermark = await readWatermark(scope);
    expect(watermark).not.toBeNull();

    const span = selectExtractionSpan(
      transcript as Array<Record<string, unknown>>,
      watermark,
    );
    expect(span.reason).toBe("watermark");
    expect(span.span).toHaveLength(2);
    expect((span.span[0] as { content: string }).content).toBe("now sell COF");
  });

  it("a repeated short reply is disambiguated by the anchor", async () => {
    const earlier = [
      userMessage("status?"),
      assistantMessage("Done."),
      userMessage("and now?"),
      assistantMessage("Done."),
    ];
    const scope = "conv-anchor";
    // Watermark after the FIRST "Done." (index 1) — its anchor is "status?".
    await writeWatermark(scope, earlier.slice(0, 2) as Array<Record<string, unknown>>);
    const watermark = await readWatermark(scope);

    // The next turn's transcript still contains an identical "Done." whose
    // anchor is "and now?" — it must NOT match the watermark.
    const span = selectExtractionSpan(
      [userMessage("and now?"), assistantMessage("Done.")] as Array<Record<string, unknown>>,
      watermark,
    );
    expect(span.reason).toBe("watermark-lost");
    expect(span.span).toHaveLength(2);
  });

  it("a span with no user-authored message is flagged so no extraction call runs", async () => {
    const span = selectExtractionSpan(
      [assistantMessage("sold COF")] as Array<Record<string, unknown>>,
      null,
    );
    expect(span.hasUserAuthored).toBe(false);
  });

  it("identities cover content and rawContent (persistence swaps them)", () => {
    const fromContent = messageIdentities({ role: "user", content: "buy COF" });
    const fromRaw = messageIdentities({ role: "user", rawContent: "buy COF" });
    expect(fromContent).toEqual(fromRaw);
    expect(fromContent.length).toBe(1);
  });
});
