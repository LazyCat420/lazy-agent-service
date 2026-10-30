/**
 * Characterization of the POST /embed content builders.
 *
 * Pins text-only vs multimodal selection, data-URL parsing with mime
 * fallbacks, and the input-order of image/media parts. Pure functions — no
 * provider, database or HTTP server involved.
 */
import { describe, expect, it } from "vitest";
import {
  buildEmbeddingContent,
  hasContentInput,
  parseDataUrl,
} from "../EmbedRoutes.ts";

describe("POST /embed — parseDataUrl", () => {
  it("splits a base64 data URL into payload and declared mime type", () => {
    expect(parseDataUrl("data:image/png;base64,AAAA", "image/jpeg")).toEqual({
      data: "AAAA",
      mimeType: "image/png",
    });
  });

  it("keeps raw base64 and applies the fallback mime type", () => {
    expect(parseDataUrl("AAAA", "audio/mpeg")).toEqual({
      data: "AAAA",
      mimeType: "audio/mpeg",
    });
  });
});

describe("POST /embed — hasContentInput", () => {
  it("accepts any single content input", () => {
    expect(hasContentInput({ text: "hello" })).toBe(true);
    expect(hasContentInput({ images: ["a"] })).toBe(true);
    expect(hasContentInput({ audio: "a" })).toBe(true);
    expect(hasContentInput({ video: "a" })).toBe(true);
    expect(hasContentInput({ pdf: "a" })).toBe(true);
  });

  it("rejects an empty body and an empty image list", () => {
    expect(hasContentInput({})).toBe(false);
    expect(hasContentInput({ images: [] })).toBe(false);
  });
});

describe("POST /embed — buildEmbeddingContent", () => {
  it("returns plain text when there is no media", () => {
    expect(buildEmbeddingContent({ text: "hello", images: [] })).toBe("hello");
  });

  it("builds multimodal parts in input order with per-type fallback mimes", () => {
    expect(
      buildEmbeddingContent({
        text: "caption",
        images: ["data:image/png;base64,IMG", "RAWIMG"],
        audio: "data:audio/wav;base64,AUD",
        video: "RAWVID",
        pdf: "data:application/pdf;base64,PDF",
      }),
    ).toEqual([
      { text: "caption" },
      { inlineData: { data: "IMG", mimeType: "image/png" } },
      { inlineData: { data: "RAWIMG", mimeType: "image/jpeg" } },
      { inlineData: { data: "AUD", mimeType: "audio/wav" } },
      { inlineData: { data: "RAWVID", mimeType: "video/mp4" } },
      { inlineData: { data: "PDF", mimeType: "application/pdf" } },
    ]);
  });

  it("omits the text part for media-only input", () => {
    expect(buildEmbeddingContent({ images: ["RAWIMG"] })).toEqual([
      { inlineData: { data: "RAWIMG", mimeType: "image/jpeg" } },
    ]);
  });
});
