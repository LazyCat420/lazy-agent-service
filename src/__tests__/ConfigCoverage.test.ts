/**
 * config.ts — model catalog derivations.
 *
 * Exercises the exported helpers over the real MODELS catalog: option
 * projection (capability flags, metadata, extended config), per-provider
 * defaults, pricing and the recommended-default priority ladder.
 */
import { describe, expect, it } from "vitest";
import {
  MODELS,
  TYPES,
  getModelByName,
  getModelOptions,
  getModels,
  getPricing,
  getDefaultModels,
  resolveRecommendedDefault,
} from "../config.ts";

const combos: Array<[string, string]> = [
  [TYPES.TEXT, TYPES.TEXT],
  [TYPES.IMAGE, TYPES.TEXT],
  [TYPES.AUDIO, TYPES.TEXT],
  [TYPES.PDF, TYPES.TEXT],
  [TYPES.TEXT, TYPES.AUDIO],
  [TYPES.TEXT, TYPES.IMAGE],
  [TYPES.TEXT, TYPES.EMBEDDING],
  [TYPES.VIDEO, TYPES.EMBEDDING],
];

const findEntry = (input: string, output: string, name: string) =>
  Object.values(getModelOptions(input, output))
    .flat()
    .find((entry) => entry.name === name);

describe("config.ts — getModels", () => {
  it("filters the catalog by both input and output type", () => {
    const textToText = getModels(TYPES.TEXT, TYPES.TEXT);
    expect(textToText.length).toBeGreaterThan(0);
    expect(textToText.map((model) => model.name)).toContain("gpt-5.2");
    expect(textToText.every((model) => model.outputTypes.includes(TYPES.TEXT))).toBe(true);

    const textToImage = getModels(TYPES.TEXT, TYPES.IMAGE).map((model) => model.name);
    expect(textToImage).toContain("gpt-image-1.5");
    expect(textToImage).not.toContain("gpt-5.2");
  });

  it("returns an empty list for a combination nothing supports", () => {
    expect(getModels(TYPES.VIDEO, TYPES.IMAGE)).toEqual([]);
  });
});

describe("config.ts — getModelOptions", () => {
  it("groups listed models by provider and drops unlisted ones", () => {
    const grouped = getModelOptions(TYPES.TEXT, TYPES.TEXT);
    expect(Object.keys(grouped).sort()).toEqual(["anthropic", "google", "openai"]);
    const names = Object.values(grouped).flat().map((entry) => entry.name);
    expect(names).toContain("gpt-5.5");
    // `listed: false` catalog entries are filtered out of the client options.
    expect(names).not.toContain("gpt-4o");
    expect(names).not.toContain("gpt-4.1-mini");
  });

  it("projects every optional field across all type combinations", () => {
    for (const [input, output] of combos) {
      for (const entry of Object.values(getModelOptions(input, output)).flat()) {
        expect(typeof entry.name).toBe("string");
        expect(typeof entry.label).toBe("string");
        if (entry.inputTypes) expect(Array.isArray(entry.inputTypes)).toBe(true);
        if (entry.outputTypes) expect(Array.isArray(entry.outputTypes)).toBe(true);
        if (entry.pricing) expect(Object.keys(entry.pricing).length).toBeGreaterThan(0);
        if (entry.arena) expect(Object.keys(entry.arena).length).toBeGreaterThan(0);
        if (entry.contextLength) expect(entry.contextLength).toBeGreaterThan(0);
        if (entry.maxOutputTokens) expect(entry.maxOutputTokens).toBeGreaterThan(0);
        if (entry.defaultTemperature !== undefined) {
          expect(entry.defaultTemperature).toBeGreaterThan(0);
        }
        if (entry.thinkingLevels) expect(entry.thinkingLevels.length).toBeGreaterThan(0);
        if (entry.mediaLimits) expect(typeof entry.mediaLimits).toBe("object");
        if (entry.year) expect(entry.year).toBeGreaterThanOrEqual(2020);
      }
    }
  });

  it("derives capability flags from catalog metadata", () => {
    const gpt = findEntry(TYPES.TEXT, TYPES.TEXT, "gpt-5.2");
    expect(gpt).toMatchObject({
      thinking: true,
      vision: true,
      webSearch: true,
      jsonMode: true,
      verbosity: true,
      reasoningSummary: true,
      responsesAPI: true,
      modelType: "conversation",
      supportsSystemPrompt: true,
    });

    const opus = findEntry(TYPES.TEXT, TYPES.TEXT, "claude-opus-4-7");
    expect(opus).toMatchObject({
      assistantImages: false,
      codeExecution: true,
      webFetch: true,
      lockedSampling: true,
      adaptiveThinking: true,
    });

    const gemini = findEntry(TYPES.TEXT, TYPES.TEXT, "gemini-3-flash-preview");
    expect(gemini).toMatchObject({ jsonMode: true, urlContext: true, codeExecution: true });

    const live = findEntry(TYPES.TEXT, TYPES.AUDIO, "gemini-3.1-flash-live-preview");
    expect(live).toMatchObject({ liveAPI: true, thinking: true, vision: true });
  });

  it("honours an explicit supportsSystemPrompt: false", () => {
    const image = findEntry(TYPES.TEXT, TYPES.IMAGE, "gpt-image-1.5");
    expect(image).toBeDefined();
    expect(image!.supportsSystemPrompt).toBe(false);
    expect(image!.vision).toBe(true);
  });

  it("leaves capability flags off when the model has no matching metadata", () => {
    const embedding = findEntry(TYPES.TEXT, TYPES.EMBEDDING, "text-embedding-3-small");
    expect(embedding).toBeDefined();
    expect(embedding!.thinking).toBeUndefined();
    expect(embedding!.jsonMode).toBeUndefined();
    expect(embedding!.supportsSystemPrompt).toBe(false);
  });
});

describe("config.ts — defaults and pricing", () => {
  it("returns one default per provider", () => {
    expect(getDefaultModels(TYPES.TEXT, TYPES.TEXT)).toMatchObject({
      openai: "gpt-5.5",
      anthropic: "claude-sonnet-4-5-20250929",
      google: "gemini-3-pro-image-preview",
    });
    expect(getDefaultModels(TYPES.TEXT, TYPES.EMBEDDING)).toMatchObject({
      "jetson-embedding": "embeddinggemma-2",
    });
  });

  it("returns a pricing map keyed by model name", () => {
    const pricing = getPricing(TYPES.TEXT, TYPES.TEXT);
    expect(pricing["gpt-5.2"].outputPerMillion).toBe(14.0);
    // Models outside the combination never enter the map.
    expect(pricing["whisper-1"]).toBeUndefined();
    expect(getPricing(TYPES.TEXT, TYPES.EMBEDDING)["gpt-5.2"]).toBeUndefined();
  });

  it("looks a model up by API name", () => {
    expect(getModelByName("gpt-5.5")).toBe(MODELS.GPT_55);
    expect(getModelByName("does-not-exist")).toBeNull();
  });
});

describe("config.ts — resolveRecommendedDefault priority ladder", () => {
  it("prefers the Google Flash tier when Google is available", () => {
    expect(resolveRecommendedDefault(TYPES.TEXT, TYPES.TEXT, new Set(["google"]))).toEqual({
      provider: "google",
      model: "gemini-3.5-flash",
      temperature: 1,
    });
  });

  it("falls back to the first eligible Google model when no Flash candidate matches", () => {
    expect(resolveRecommendedDefault(TYPES.TEXT, TYPES.IMAGE, new Set(["google"]))).toMatchObject({
      provider: "google",
      model: "gemini-3-pro-image-preview",
    });
  });

  it("picks Haiku for an Anthropic-only deployment", () => {
    expect(resolveRecommendedDefault(TYPES.TEXT, TYPES.TEXT, new Set(["anthropic"]))).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
    });
  });

  it("picks a mini/nano OpenAI model for an OpenAI-only deployment", () => {
    expect(resolveRecommendedDefault(TYPES.TEXT, TYPES.TEXT, new Set(["openai"]))).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-mini",
    });
  });

  it("walks to any provider that has an eligible model", () => {
    expect(resolveRecommendedDefault(TYPES.TEXT, TYPES.AUDIO, new Set(["inworld"]))).toMatchObject({
      provider: "inworld",
      model: "inworld-tts-2",
    });
  });

  it("ignores providers with no catalog entries", () => {
    expect(resolveRecommendedDefault(TYPES.TEXT, TYPES.TEXT, new Set(["vllm", "ollama"]))).toBeNull();
  });

  it("returns null when no provider is available", () => {
    expect(resolveRecommendedDefault(TYPES.TEXT, TYPES.TEXT, new Set())).toBeNull();
  });

  it("restricts candidates to tool-calling models when asked", () => {
    expect(resolveRecommendedDefault(TYPES.TEXT, TYPES.TEXT, new Set(["google"]), true)).toMatchObject({
      provider: "google",
      model: "gemini-3.5-flash",
    });
    // Image-generation models list no "Tool Calling" tool, so the whole ladder
    // ends empty rather than recommending a model the caller cannot use.
    expect(resolveRecommendedDefault(TYPES.TEXT, TYPES.IMAGE, new Set(["google", "openai"]), true)).toBeNull();
    // A provider whose only models lack tool calling is skipped entirely.
    expect(resolveRecommendedDefault(TYPES.TEXT, TYPES.AUDIO, new Set(["elevenlabs"]), true)).toBeNull();
  });
});
