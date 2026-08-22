import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildOutcomesBlock } from "../WallgardenService.js";
import type { BrainstormContext, TopicOutcomes } from "../WallgardenService.js";

// The measured-outcomes block is the only feedback the model gets about what
// its OWN past suggestions did. These tests pin two things: the block says the
// right thing, and it actually reaches the outbound prompt (a block that is
// built and then dropped on the floor is the failure mode this repo has hit
// before — `failedExamples` was silently dropped by the /similar route, and
// `topicPolicies` is pushed to the sync service to this day and goes nowhere).

const OUTCOMES: TopicOutcomes = {
  proven: [{ t: "one man sawmill", likes: 3, plays: 5 }],
  ignored: [{ t: "water treatment", shown: 12 }],
  slop: ["hazard analysis"],
};

describe("buildOutcomesBlock", () => {
  it("returns empty string when there is nothing measured", () => {
    expect(buildOutcomesBlock(undefined)).toBe("");
    expect(buildOutcomesBlock({})).toBe("");
    expect(buildOutcomesBlock({ proven: [], ignored: [], slop: [] })).toBe("");
  });

  it("renders proven topics with their real counts", () => {
    const block = buildOutcomesBlock(OUTCOMES);
    expect(block).toContain("one man sawmill");
    expect(block).toContain("3 liked");
    expect(block).toContain("5 played");
  });

  it("frames ignored topics as a SHAPE to avoid, not just words", () => {
    const block = buildOutcomesBlock(OUTCOMES);
    expect(block).toContain("water treatment");
    expect(block).toContain("shown 12x, never played");
    // The instruction is the point — a bare list would just look like another
    // blacklist, which the prompt already has three of.
    expect(block).toMatch(/SHAPE/);
  });

  it("drops malformed entries instead of emitting empty quotes", () => {
    const block = buildOutcomesBlock({
      proven: [{ t: "" } as any, null as any],
      ignored: [undefined as any],
      slop: ["", null as any],
    });
    expect(block).toBe("");
  });

  it("omits a section that has no data rather than printing empty brackets", () => {
    const block = buildOutcomesBlock({ proven: [{ t: "raku firing", likes: 1 }] });
    expect(block).toContain("WORKED");
    expect(block).not.toContain("IGNORED");
    expect(block).not.toContain("SLOP");
  });
});

// ── The part that matters: does it reach the model? ────────────────
const JETSON_MODEL = "cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit";
let chatBodies: any[];

function installFetchStub() {
  chatBodies = [];
  vi.stubGlobal("fetch", async (url: any, init?: any) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return { ok: true, json: async () => ({ data: [{ id: JETSON_MODEL }] }) } as any;
    }
    chatBodies.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({ text: '{"topics": ["wood ash glaze"]}', model: JETSON_MODEL }),
    } as any;
  });
}

const CTX: BrainstormContext = {
  interests: ["ceramics"], disliked: [], recentUsed: [], burnedQueries: [], numTopics: 5,
};

beforeEach(() => installFetchStub());
afterEach(() => vi.unstubAllGlobals());

async function loadService() {
  vi.resetModules();
  return import("../WallgardenService.js");
}

describe("outcomes reach the outbound prompt", () => {
  it("brainstorm carries the block when outcomes are supplied", async () => {
    const { brainstormTopics } = await loadService();
    await brainstormTopics({ ...CTX, topicOutcomes: OUTCOMES });

    expect(chatBodies.length).toBeGreaterThan(0);
    const user = chatBodies[0].messages.find((m: any) => m.role === "user").content;
    expect(user).toContain("MEASURED RESULTS OF PAST SUGGESTIONS");
    expect(user).toContain("one man sawmill");
    expect(user).toContain("water treatment");
  });

  it("brainstorm prompt is unchanged when no outcomes are supplied", async () => {
    const { brainstormTopics } = await loadService();
    await brainstormTopics(CTX);

    const user = chatBodies[0].messages.find((m: any) => m.role === "user").content;
    expect(user).not.toContain("MEASURED RESULTS");
    // The rest of the prompt must survive untouched — this block is additive.
    expect(user).toContain("My interest topics:");
    expect(user).toContain("Suggest 5 new topics.");
  });

  it("similar carries the block too — it is the path browsing signals feed", async () => {
    const { generateSimilarTopics } = await loadService();
    await generateSimilarTopics({ ...CTX, query: "wood ash glaze", topicOutcomes: OUTCOMES });

    const user = chatBodies[0].messages.find((m: any) => m.role === "user").content;
    expect(user).toContain("MEASURED RESULTS OF PAST SUGGESTIONS");
    expect(user).toContain('Suggest 5 topics related to "wood ash glaze".');
  });

  it("does not blow the input budget", async () => {
    const { brainstormTopics } = await loadService();
    const big: TopicOutcomes = {
      proven: Array.from({ length: 12 }, (_, i) => ({ t: `proven topic ${i}`, likes: i, plays: i })),
      ignored: Array.from({ length: 10 }, (_, i) => ({ t: `ignored topic ${i}`, shown: 20 })),
      slop: Array.from({ length: 10 }, (_, i) => `slop ${i}`),
    };
    await brainstormTopics({ ...CTX, topicOutcomes: big });
    const user = chatBodies[0].messages.find((m: any) => m.role === "user").content;
    // The Jetson's window is 65,536 and a full brainstorm sat near 2k tokens.
    // A worst-case outcomes block must stay a rounding error against that.
    expect(user.length).toBeLessThan(12000);
  });
});
