import { describe, expect, it } from "vitest";
import {
  buildConversationTextPipeline,
  mapConversationTextItem,
} from "../QueryBuilders.ts";

describe("buildConversationTextPipeline", () => {
  it("omits the preMatch stage when empty and adds no filters", () => {
    const p = buildConversationTextPipeline({ preMatch: {} });
    expect(p[0]).toHaveProperty("$unwind", "$messages");
    expect(p.at(-1)).toEqual({ $sort: { timestamp: -1 } });
  });
  it("prepends preMatch and appends origin/search/provider/model stages", () => {
    const p = buildConversationTextPipeline({
      preMatch: { project: "x" },
      origin: "ai",
      search: "hi",
      provider: "openai",
      model: "openai/gpt",
    });
    expect(p[0]).toEqual({ $match: { project: "x" } });
    expect(p.slice(-4)).toEqual([
      { $match: { role: "assistant" } },
      { $match: { content: { $regex: "hi", $options: "i" } } },
      { $match: { model: { $regex: "^openai/", $options: "i" } } },
      { $match: { model: "openai/gpt" } },
    ]);
  });
  it("maps the user origin", () => {
    const p = buildConversationTextPipeline({ origin: "user" });
    expect(p.at(-1)).toEqual({ $match: { role: "user" } });
  });
});

describe("mapConversationTextItem", () => {
  it("derives origin, title fallback and hasImages", () => {
    const out = mapConversationTextItem({
      convId: "c", project: "p", username: "u", role: "assistant",
      content: "x", timestamp: "t", images: 2,
    });
    expect(out).toMatchObject({ origin: "ai", convTitle: "Untitled", hasImages: true });
  });
});
