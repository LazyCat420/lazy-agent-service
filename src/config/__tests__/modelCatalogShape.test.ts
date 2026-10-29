import { describe, expect, it } from "vitest";
import { MODELS } from "../models.ts";
import { MODEL_TYPES } from "../../constants.ts";
import {
  OPENAI_VOICES,
  GOOGLE_VOICES,
  ELEVENLABS_VOICES,
  INWORLD_VOICES,
} from "../voices.ts";

/**
 * Shape tests for the hand-maintained model and voice catalogs.
 *
 * These do not assert specific models or voices — they pin the invariants
 * every entry must satisfy so a silent edit (dropped provider, missing token
 * budget, duplicated id) fails the suite instead of shipping.
 */

interface ModelEntry {
  name?: unknown;
  provider?: unknown;
  modelType?: unknown;
  maxInputTokens?: unknown;
  maxOutputTokens?: unknown;
  tools?: unknown;
}

const modelEntries = Object.entries(MODELS) as Array<[string, ModelEntry]>;

describe("model catalog shape", () => {
  it("every entry has a non-empty name, a provider and a modelType", () => {
    expect(modelEntries.length).toBeGreaterThan(0);
    for (const [key, model] of modelEntries) {
      expect(typeof model.name, `${key}.name`).toBe("string");
      expect((model.name as string).length, `${key}.name`).toBeGreaterThan(0);
      expect(model.provider, `${key}.provider`).toBeTruthy();
      expect(model.modelType, `${key}.modelType`).toBeTruthy();
    }
  });

  it("conversation models declare positive input and output token budgets", () => {
    const conversationModels = modelEntries.filter(
      ([, model]) => model.modelType === MODEL_TYPES.CONVERSATION,
    );
    expect(conversationModels.length).toBeGreaterThan(0);
    for (const [key, model] of conversationModels) {
      expect(
        typeof model.maxInputTokens === "number" && model.maxInputTokens > 0,
        `${key}.maxInputTokens`,
      ).toBe(true);
      expect(
        typeof model.maxOutputTokens === "number" && model.maxOutputTokens > 0,
        `${key}.maxOutputTokens`,
      ).toBe(true);
    }
  });

  it("non-conversation models may omit maxOutputTokens but never declare a non-positive one", () => {
    for (const [key, model] of modelEntries) {
      if (model.modelType === MODEL_TYPES.CONVERSATION) continue;
      if (model.maxOutputTokens === undefined) continue;
      expect(
        typeof model.maxOutputTokens === "number" && model.maxOutputTokens > 0,
        `${key}.maxOutputTokens`,
      ).toBe(true);
    }
  });

  it("declared tools lists are non-empty string arrays", () => {
    for (const [key, model] of modelEntries) {
      if (model.tools === undefined) continue;
      expect(Array.isArray(model.tools), `${key}.tools`).toBe(true);
      const tools = model.tools as unknown[];
      expect(tools.length, `${key}.tools`).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(typeof tool, `${key}.tools entry`).toBe("string");
      }
    }
  });

  it("model names are unique within each modelType", () => {
    // Conversation models and their speech-to-text variants deliberately share
    // one provider model name (e.g. GEMINI_3_FLASH / GEMINI_3_FLASH_STT), so
    // uniqueness is enforced per model type rather than across the catalog.
    for (const modelType of Object.values(MODEL_TYPES)) {
      const names = modelEntries
        .filter(([, model]) => model.modelType === modelType)
        .map(([, model]) => model.name as string);
      expect(new Set(names).size, `${modelType} duplicate model name`).toBe(names.length);
    }
  });
});

interface VoiceEntry {
  name?: unknown;
}

const VOICE_TABLES: Record<string, ReadonlyArray<VoiceEntry>> = {
  openai: OPENAI_VOICES,
  google: GOOGLE_VOICES,
  elevenlabs: ELEVENLABS_VOICES,
  inworld: INWORLD_VOICES,
};

describe("voice catalog shape", () => {
  for (const [provider, voices] of Object.entries(VOICE_TABLES)) {
    it(`${provider} voices have non-empty names and no duplicates`, () => {
      expect(voices.length).toBeGreaterThan(0);
      const names = voices.map((voice) => {
        expect(typeof voice.name, `${provider} voice name`).toBe("string");
        const name = voice.name as string;
        expect(name.length, `${provider} voice name`).toBeGreaterThan(0);
        return name;
      });
      expect(new Set(names).size, `${provider} duplicate voice name`).toBe(names.length);
    });
  }
});
