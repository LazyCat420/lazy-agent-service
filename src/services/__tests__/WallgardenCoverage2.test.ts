/**
 * WallgardenService — candidate classification and taste-profile generation.
 * The in-process chat handler is a fake that emits SSE chunk/done events; the
 * Jetson gate, retry backoff, JSON extraction and batching run for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SseEvent } from "../../types/SseTypes.ts";
import { JetsonGateRejectedError } from "../wallgarden/JetsonGate.ts";

const fakes = vi.hoisted(() => ({ handleConversation: vi.fn() }));

vi.mock("../../providers/instance-registry.js", () => ({
  getInstancesByType: () => [
    {
      id: "vllm",
      nickname: "Jetson",
      baseUrl: "http://vllm.test:8000",
      model: "nemotron35",
      status: "online",
    },
  ],
}));
vi.mock("../../core/chat/ChatGeneration.js", () => ({
  handleConversation: fakes.handleConversation,
}));
vi.mock("../../core/chat/ChatGeneration.ts", () => ({
  handleConversation: fakes.handleConversation,
}));

import {
  classifyCandidateVideos,
  generateTasteProfile,
} from "../wallgarden/WallgardenService.ts";

/** Make the chat handler answer with one chunk carrying `text`. */
function respondWith(text: string) {
  fakes.handleConversation.mockImplementation(
    async (_params: Record<string, unknown>, emit: (event: SseEvent) => void) => {
      emit({ type: "chunk", content: text } as SseEvent);
      emit({ type: "done", provider: "vllm", model: "nemotron35" } as SseEvent);
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/v1/models")) {
      return new Response(
        JSON.stringify({ object: "list", data: [{ id: "nemotron35" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`unexpected network fetch in test: ${url}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("classifyCandidateVideos", () => {
  it("returns an empty result without calling the model", async () => {
    const result = await classifyCandidateVideos({ topic: "t", candidates: [] });

    expect(result).toEqual({ classifications: [], failed: false });
    expect(fakes.handleConversation).not.toHaveBeenCalled();
  });

  it("parses a bare JSON array of classifications", async () => {
    respondWith(
      JSON.stringify([
        { id: "a", classification: "on_topic", reason: "matches" },
        { id: "b", classification: "nonsense" },
        { classification: "ON_TOPIC" },
      ]),
    );

    const result = await classifyCandidateVideos({
      topic: "blacksmithing",
      candidates: [
        { id: "a", title: "Forging a knife" },
        { id: "b", title: "Cooking pasta" },
      ],
    });

    expect(result.failed).toBe(false);
    expect(result.classifications).toEqual([
      { id: "a", classification: "ON_TOPIC", reason: "matches" },
      // Unknown classification falls back to ADJACENT; the id-less entry is
      // dropped, and "b" keeps the parsed entry with no reason.
      { id: "b", classification: "ADJACENT", reason: undefined },
    ]);
  });

  it("parses an object with a classifications array", async () => {
    respondWith(
      JSON.stringify({
        classifications: [{ id: "x", classification: "NOVELTY", reason: "fresh" }],
      }),
    );

    const result = await classifyCandidateVideos({
      topic: "t",
      candidates: [{ id: "x", title: "A" }],
    });

    expect(result.classifications).toEqual([
      { id: "x", classification: "NOVELTY", reason: "fresh" },
    ]);
  });

  it("extracts JSON embedded in surrounding prose", async () => {
    respondWith(
      'Sure, here you go: {"classifications":[{"id":"p","classification":"OFF_TOPIC"}]} done.',
    );

    const result = await classifyCandidateVideos({
      topic: "t",
      candidates: [{ id: "p", title: "A" }],
    });

    expect(result.classifications[0]).toEqual({
      id: "p",
      classification: "OFF_TOPIC",
      reason: undefined,
    });
  });

  it("salvages truncated objects when the JSON is invalid", async () => {
    respondWith(
      '{"classifications":[{"id":"s1","classification":"ON_TOPIC","reason":"good"},{"id":"s2","classification":"SLOP","reason":"bad"',
    );

    const result = await classifyCandidateVideos({
      topic: "t",
      candidates: [{ id: "s1", title: "A" }, { id: "s2", title: "B" }],
    });

    expect(result.classifications).toEqual([
      { id: "s1", classification: "ON_TOPIC", reason: "good" },
      // s2's object is truncated (no closing brace), so it is not salvaged and
      // falls back to unclassified.
      { id: "s2", classification: "ADJACENT", reason: "unclassified" },
    ]);
  });

  it("includes intent and facet hints in the prompt", async () => {
    respondWith(JSON.stringify([{ id: "a", classification: "ON_TOPIC" }]));

    await classifyCandidateVideos({
      topic: "raku",
      intent: "ceramics",
      includeFacets: ["kiln", "glaze"],
      excludeFacets: ["vlog"],
      candidates: [{ id: "a", title: "A", channel: "C", durationSecs: 130, description: "  d  " }],
    });

    const params = fakes.handleConversation.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMessage = params.messages.find((message) => message.role === "user")?.content ?? "";
    expect(userMessage).toContain('Target Topic: "raku"');
    expect(userMessage).toContain("Target Domain/Intent: ceramics");
    expect(userMessage).toContain("Include Facets: [kiln, glaze]");
    expect(userMessage).toContain("Exclude / Novelty Patterns: [vlog]");
    expect(userMessage).toContain('channel: "C"');
    expect(userMessage).toContain("duration: 2min");
    expect(userMessage).toContain('desc: "d"');
  });

  it("retries once and reports failure when nothing parses", async () => {
    vi.useFakeTimers();
    respondWith("no json here at all");

    const promise = classifyCandidateVideos({
      topic: "t",
      candidates: [{ id: "a", title: "A" }],
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;

    expect(fakes.handleConversation).toHaveBeenCalledTimes(2);
    expect(result.failed).toBe(true);
    expect(result.classifications).toEqual([
      { id: "a", classification: "ADJACENT", reason: "unclassified" },
    ]);
  });

  it("succeeds on the retry after a handler error", async () => {
    vi.useFakeTimers();
    fakes.handleConversation
      .mockRejectedValueOnce(new Error("handler blew up"))
      .mockImplementation(
        async (_params: Record<string, unknown>, emit: (event: SseEvent) => void) => {
          emit({
            type: "chunk",
            content: JSON.stringify([{ id: "a", classification: "ON_TOPIC" }]),
          } as SseEvent);
          emit({ type: "done", provider: "vllm", model: "nemotron35" } as SseEvent);
        },
      );

    const promise = classifyCandidateVideos({
      topic: "t",
      candidates: [{ id: "a", title: "A" }],
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;

    expect(result.failed).toBe(false);
    expect(result.classifications[0].classification).toBe("ON_TOPIC");
  });

  it("splits large candidate lists into batches of 15", async () => {
    respondWith(JSON.stringify([{ id: "none", classification: "ON_TOPIC" }]));
    const candidates = Array.from({ length: 16 }, (_, index) => ({
      id: `c-${index}`,
      title: `title ${index}`,
    }));

    const result = await classifyCandidateVideos({ topic: "t", candidates });

    expect(fakes.handleConversation).toHaveBeenCalledTimes(2);
    expect(result.classifications).toHaveLength(16);
    // Only "none" was returned, so every real candidate falls back to ADJACENT.
    expect(result.classifications.every((entry) => entry.classification === "ADJACENT")).toBe(
      true,
    );
  });
});

describe("generateTasteProfile", () => {
  it("rejects an empty like list", async () => {
    await expect(generateTasteProfile([])).rejects.toThrow("No liked videos to profile");
    expect(fakes.handleConversation).not.toHaveBeenCalled();
  });

  it("parses a well-formed profile and its clusters", async () => {
    respondWith(
      JSON.stringify({
        profile: "  Loves precision machining  ",
        clusters: [
          { name: " machining ", evidence: ["lathe", 42] },
          { evidence: ["nameless"] },
        ],
      }),
    );

    const profile = await generateTasteProfile(["video one"], ["machining"]);

    expect(profile.profile).toBe("Loves precision machining");
    expect(profile.clusters).toEqual([{ name: "machining", evidence: ["lathe"] }]);
    expect(fakes.handleConversation).toHaveBeenCalledTimes(1);
  });

  it("parses a profile wrapped in prose", async () => {
    respondWith('Here: {"profile":"Restoration work","clusters":[]} — enjoy');

    const profile = await generateTasteProfile(["v"]);
    expect(profile).toEqual({ profile: "Restoration work", clusters: [] });
  });

  it("salvages just the profile text from a truncated reply", async () => {
    respondWith('{"profile":"Hand tool woodworking","clusters":[{"name":"wood');

    const profile = await generateTasteProfile(["v"]);
    expect(profile).toEqual({ profile: "Hand tool woodworking", clusters: [] });
  });

  it("retries twice and then throws when nothing parses", async () => {
    vi.useFakeTimers();
    respondWith("total nonsense");

    const promise = generateTasteProfile(["v"]);
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(promise).rejects.toThrow("No profile parsed from response");
    expect(fakes.handleConversation).toHaveBeenCalledTimes(3);
  });

  it("recovers when a later attempt returns a valid profile", async () => {
    vi.useFakeTimers();
    fakes.handleConversation
      .mockRejectedValueOnce(new Error("handler down"))
      .mockImplementation(
        async (_params: Record<string, unknown>, emit: (event: SseEvent) => void) => {
          emit({
            type: "chunk",
            content: JSON.stringify({ profile: "Recovered", clusters: [] }),
          } as SseEvent);
          emit({ type: "done", provider: "vllm", model: "nemotron35" } as SseEvent);
        },
      );

    const promise = generateTasteProfile(["v"]);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(promise).resolves.toEqual({ profile: "Recovered", clusters: [] });
  });

  it("propagates a gate rejection without retrying", async () => {
    fakes.handleConversation.mockRejectedValue(new JetsonGateRejectedError(2, 30_000));

    await expect(generateTasteProfile(["v"])).rejects.toBeInstanceOf(JetsonGateRejectedError);
    expect(fakes.handleConversation).toHaveBeenCalledTimes(1);
  });
});
