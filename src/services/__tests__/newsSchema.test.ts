import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATEGORIES } from "../EditorialHeadlinesService.ts";

const flat = JSON.parse(
  readFileSync(join(process.cwd(), "tool_schemas.json"), "utf8"),
) as Array<Record<string, any>>;
const news = flat.find((t) => t.name === "news_search")!;

describe("news_search schema", () => {
  it("does not require a topic", () => {
    // The router has always treated "" as the top-headlines request, but the
    // schema said `required: ["topic"]`. A schema-validating MCP client could
    // therefore never reach the general-news path — the contract and the code
    // disagreed about the one call that matters most here.
    expect(news.parameters.required).toEqual([]);
  });

  it("offers exactly the sections the service implements", () => {
    // Derived from the service's own export, not transcribed: a hand-copied
    // list agrees with itself while drifting from the code.
    expect(news.parameters.properties.category.enum).toEqual([...CATEGORIES]);
  });

  it("tells the model that an empty topic is the way to ask for top stories", () => {
    expect(news.description.toLowerCase()).toContain("empty");
    expect(news.description).toMatch(/do NOT search for the words 'top stories'/i);
  });

  it("keeps the debug pins OUT of the schema", () => {
    // `_source` / `_provider` pin the mechanism for the bench. A model that
    // could see them could pin production traffic to a single provider.
    expect(Object.keys(news.parameters.properties)).not.toContain("_source");
    expect(Object.keys(news.parameters.properties)).not.toContain("_provider");
  });
});
