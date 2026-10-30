/**
 * Characterization of llama.cpp `getServerProps` normalization.
 *
 * Pins the shape returned for a fully populated server, the documented
 * defaults for a bare /props response, and the null/[] fallbacks when an
 * endpoint answers with an error status. fetch is stubbed — no server involved.
 */
import { describe, expect, it, vi, afterEach } from "vitest";

import { createLlamaCppProvider } from "../llama-cpp.ts";

const respondJson = (body: unknown) => ({
  ok: true,
  json: async () => body,
});
const respondError = { ok: false, json: async () => ({}) };

const stubFetch = (routes: Record<string, unknown>) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = routes[new URL(url).pathname];
      return body === undefined ? respondError : respondJson(body);
    }),
  );
};

describe("llama-cpp getServerProps", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes /props, /slots and /health into the server props contract", async () => {
    stubFetch({
      "/props": {
        total_slots: 2,
        model_path: "/models/qwen.gguf",
        model_alias: "qwen",
        chat_template: "chatml",
        modalities: { vision: true },
        endpoint_slots: true,
        endpoint_metrics: true,
        default_generation_settings: {
          n_ctx: 8192,
          params: {
            temperature: 0.2,
            top_k: 20,
            top_p: 0.9,
            min_p: 0.1,
            repeat_penalty: 1.1,
            presence_penalty: 0.5,
            frequency_penalty: 0.25,
            seed: 7,
            n_predict: 256,
            samplers: ["top_k", "top_p"],
          },
          cache_type_k: "q8_0",
          cache_type_v: "q8_0",
        },
      },
      "/slots": [
        { id: 0, is_processing: true, model: "qwen", n_ctx: 4096, n_past: 12, tokens_predicted: 30, cache_tokens: 4 },
        { id: 1, model: "", n_ctx: 0 },
      ],
      "/health": { status: "ok", slots_idle: 1, slots_processing: 1 },
    });

    const props = await createLlamaCppProvider("http://llama.test").getServerProps();

    expect(props).toEqual({
      totalSlots: 2,
      modelPath: "/models/qwen.gguf",
      modelAlias: "qwen",
      chatTemplate: "chatml",
      modalities: { vision: true, audio: false },
      endpointSlots: true,
      endpointMetrics: true,
      defaultGenerationSettings: {
        contextLength: 8192,
        temperature: 0.2,
        topK: 20,
        topP: 0.9,
        minP: 0.1,
        repeatPenalty: 1.1,
        presencePenalty: 0.5,
        frequencyPenalty: 0.25,
        seed: 7,
        maxTokens: 256,
        samplers: ["top_k", "top_p"],
        cacheTypeK: "q8_0",
        cacheTypeV: "q8_0",
      },
      slots: [
        {
          id: 0,
          state: "processing",
          model: "qwen",
          contextLength: 4096,
          tokensUsed: 12,
          tokensPredicted: 30,
          cacheTokens: 4,
          isProcessing: true,
        },
        {
          id: 1,
          state: "idle",
          model: null,
          contextLength: 0,
          tokensUsed: 0,
          tokensPredicted: 0,
          cacheTokens: 0,
          isProcessing: false,
        },
      ],
      health: { status: "ok", slotsIdle: 1, slotsProcessing: 1 },
    });
  });

  it("applies the documented generation defaults for a bare /props response", async () => {
    stubFetch({
      "/props": { default_generation_settings: { params: {} } },
      "/slots": [],
      "/health": { status: "loading model" },
    });

    const props = await createLlamaCppProvider("http://llama.test").getServerProps();

    expect(props.defaultGenerationSettings).toEqual({
      contextLength: 0,
      temperature: 0.8,
      topK: 40,
      topP: 0.95,
      minP: 0.05,
      repeatPenalty: 1.0,
      presencePenalty: 0.0,
      frequencyPenalty: 0.0,
      seed: -1,
      maxTokens: -1,
      samplers: [],
      cacheTypeK: null,
      cacheTypeV: null,
    });
    expect(props.totalSlots).toBe(0);
    expect(props.modalities).toBeNull();
    expect(props.endpointSlots).toBe(false);
    expect(props.endpointMetrics).toBe(false);
    expect(props.slots).toEqual([]);
    expect(props.health).toEqual({ status: "loading model", slotsIdle: null, slotsProcessing: null });
  });

  it("falls back to null/empty when every endpoint answers with an error status", async () => {
    stubFetch({});

    const props = await createLlamaCppProvider("http://llama.test").getServerProps();

    expect(props).toEqual({
      totalSlots: 0,
      modelPath: null,
      modelAlias: null,
      chatTemplate: null,
      modalities: null,
      endpointSlots: false,
      endpointMetrics: false,
      defaultGenerationSettings: null,
      slots: [],
      health: null,
    });
  });
});
