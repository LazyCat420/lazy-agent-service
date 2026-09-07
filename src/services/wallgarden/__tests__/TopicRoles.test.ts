import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  planBrainstormBatches,
  BRAINSTORM_MAX_BATCHES,
  UNRATED_WEIGHT,
  EXPLORE_LOW_FIT_WEIGHT,
} from "../WallgardenService.js";
import type { BrainstormContext } from "../WallgardenService.js";

// Roles are decided by the BATCH. The old prompt told 75% of every call to
// leave the user's scene; now one blended CORE batch, ADJACENT batches by
// cluster share, and a small EXPLORE slot. Every assertion here is on the
// OUTBOUND /chat body or on the pure planner — never on a builder's return,
// because a block that is built and then dropped is the failure this repo
// keeps hitting.

describe("planBrainstormBatches", () => {
  const clusters = [
    { name: "raku", videos: ["a", "b"], size: 12 },
    { name: "synths", videos: ["c"], size: 5 },
    { name: "sawmill", videos: ["d"], size: 3 },
  ];

  it("one core, one explore, adjacent batches by cluster size", () => {
    const plan = planBrainstormBatches(60, clusters);
    const roles = plan.map(b => b.role);
    expect(roles.filter(r => r === "core")).toHaveLength(1);
    expect(roles.filter(r => r === "explore")).toHaveLength(1);
    expect(roles[0]).toBe("core");
    expect(roles[roles.length - 1]).toBe("explore");
    const adj = plan.filter(b => b.role === "adjacent");
    expect(adj.length).toBeGreaterThan(0);
    // largest cluster gets the largest adjacent batch
    const targeted = adj.filter(b => b.cluster);
    expect(targeted[0].cluster?.name).toBe("raku");
    for (let i = 1; i < targeted.length; i++) expect(targeted[i - 1].size).toBeGreaterThanOrEqual(targeted[i].size);
    // sizes sum to the request, every batch under the ceiling, count bounded
    expect(plan.reduce((a, b) => a + b.size, 0)).toBe(60);
    expect(plan.every(b => b.size <= 25)).toBe(true);
    expect(plan.length).toBeLessThanOrEqual(BRAINSTORM_MAX_BATCHES);
  });

  it("core is cooler than explore", () => {
    const plan = planBrainstormBatches(60, clusters);
    const core = plan.find(b => b.role === "core")!;
    const explore = plan.find(b => b.role === "explore")!;
    expect(core.temperature).toBeLessThanOrEqual(0.8);
    expect(explore.temperature).toBeGreaterThan(core.temperature);
  });

  it("no clusters still yields core + adjacent (+ explore when big enough)", () => {
    const small = planBrainstormBatches(10, []);
    expect(small.map(b => b.role)).toEqual(["core", "adjacent"]);
    expect(small.reduce((a, b) => a + b.size, 0)).toBe(10);
    const big = planBrainstormBatches(100, []);
    expect(big.reduce((a, b) => a + b.size, 0)).toBe(100);
    expect(big.every(b => b.size <= 25)).toBe(true);
    expect(big.some(b => b.role === "explore")).toBe(true);
  });

  it("clamps an unbounded request", () => {
    const plan = planBrainstormBatches(5000, clusters);
    expect(plan.reduce((a, b) => a + b.size, 0)).toBeLessThanOrEqual(100);
    expect(plan.length).toBeLessThanOrEqual(BRAINSTORM_MAX_BATCHES);
  });

  it("a long tail of tiny clusters pools instead of fanning out", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: "c" + i, videos: ["x"], size: 2 }));
    const plan = planBrainstormBatches(60, many);
    expect(plan.length).toBeLessThanOrEqual(BRAINSTORM_MAX_BATCHES);
    expect(plan.reduce((a, b) => a + b.size, 0)).toBe(60);
  });
});

// ── Outbound bodies ────────────────────────────────────────────────
const JETSON_MODEL = "cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit";
let chatBodies: any[];
let replyFor: (body: any) => string;

function installFetchStub() {
  chatBodies = [];
  replyFor = () => '{"topics": ["wood ash glaze", "raku kiln reduction"]}';
  vi.stubGlobal("fetch", async (url: any, init?: any) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return { ok: true, json: async () => ({ data: [{ id: JETSON_MODEL }] }) } as any;
    }
    const body = JSON.parse(init.body);
    chatBodies.push(body);
    return { ok: true, json: async () => ({ text: replyFor(body), model: JETSON_MODEL }) } as any;
  });
}
const userOf = (b: any) => b.messages.find((m: any) => m.role === "user").content as string;
const systemOf = (b: any) => b.messages.find((m: any) => m.role === "system").content as string;

const CTX: BrainstormContext = {
  interests: ["ceramics"], disliked: [], recentUsed: [], burnedQueries: [], numTopics: 60,
  likedVideos: ["Building a raku kiln (Ceramics Guy)"],
  likedClusters: [
    { name: "raku", videos: ["Building a raku kiln (Ceramics Guy)", "Raku glaze test (Pots)"], size: 6 },
    { name: "synths", videos: ["Eurorack patch from scratch (Synth Nerd)"], size: 2 },
  ],
  tasteProfile: "Watches long-form ceramics process video.",
};

beforeEach(() => installFetchStub());
afterEach(() => vi.unstubAllGlobals());

async function loadService() {
  vi.resetModules();
  return import("../WallgardenService.js");
}

describe("brainstorm bodies carry the roles", () => {
  it("one CORE body listing every cluster, one EXPLORE, no lateral quota, anchor test everywhere", async () => {
    const { brainstormTopics } = await loadService();
    const out = await brainstormTopics(CTX);
    const users = chatBodies.map(userOf);
    const cores = users.filter(u => u.includes("THIS BATCH — CORE"));
    const explores = users.filter(u => u.includes("THIS BATCH — EXPLORE"));
    expect(cores).toHaveLength(1);
    expect(explores).toHaveLength(1);
    expect(cores[0]).toContain("raku kiln");
    expect(cores[0]).toContain("Eurorack");
    expect(users.filter(u => u.includes("THIS BATCH — ADJACENT")).length).toBeGreaterThan(0);
    expect(users.some(u => u.includes("Ignore my other clusters"))).toBe(false);
    for (const b of chatBodies) {
      expect(systemOf(b)).not.toContain("~40% LATERAL");
      expect(systemOf(b)).toContain("THE ANCHOR TEST");
      expect(systemOf(b)).toContain("ONE ROLE");
    }
    const coreBody = chatBodies.find(b => userOf(b).includes("THIS BATCH — CORE"))!;
    const exploreBody = chatBodies.find(b => userOf(b).includes("THIS BATCH — EXPLORE"))!;
    expect(coreBody.temperature).toBeLessThanOrEqual(0.8);
    expect(exploreBody.temperature).toBeGreaterThanOrEqual(coreBody.temperature);
    // the first role wins on a duplicate: every stub reply is the same two
    // topics, so both must come out as core
    expect(out.every(t => t.role === "core")).toBe(true);
  });
});

describe("rateTopics with and without taste", () => {
  it("without taste the prompt is the anchoring rubric alone (extract path unchanged)", async () => {
    const { rateTopics } = await loadService();
    replyFor = () => '{"ratings":[{"t":"raku kiln reduction","tier":"A"}]}';
    const { rated } = await rateTopics(["raku kiln reduction", "skipped one"]);
    expect(systemOf(chatBodies[0])).not.toContain("FIT");
    expect(userOf(chatBodies[0])).not.toContain("TOPICS TO RATE");
    expect(rated.find(r => r.topic === "raku kiln reduction")?.weight).toBe(8);
    expect(rated.find(r => r.topic === "skipped one")?.weight).toBe(4); // legacy B
  });

  it("with taste the evidence reaches the model and fit drives the weight", async () => {
    const { rateTopics } = await loadService();
    replyFor = () => JSON.stringify({ ratings: [
      { t: "raku kiln reduction", tier: "A", fit: "HIGH" },
      { t: "options trading", tier: "A", fit: "LOW" },
      { t: "wild leap", tier: "A", fit: "LOW" },
      { t: "plant health", tier: "B", fit: "MED" },
      { t: "garbage one", tier: "C", fit: "HIGH" },
    ] });
    const roles = new Map([["wild leap", "explore" as const], ["options trading", "adjacent" as const]]);
    const { rated } = await rateTopics(
      ["raku kiln reduction", "options trading", "wild leap", "plant health", "garbage one", "never graded"],
      undefined, undefined,
      { taste: { tasteProfile: "ceramics person", likedTitles: ["Building a raku kiln"], interests: ["ceramics"] }, roles },
    );
    expect(systemOf(chatBodies[0])).toContain("FIT");
    const user = userOf(chatBodies[0]);
    expect(user).toContain("ceramics person");
    expect(user).toContain("Building a raku kiln");
    expect(user).toContain("TOPICS TO RATE");
    const by = Object.fromEntries(rated.map(r => [r.topic, r]));
    expect(by["raku kiln reduction"].weight).toBe(8);
    expect(by["options trading"]).toBeUndefined();            // LOW fit, adjacent -> dropped
    expect(by["wild leap"].weight).toBe(EXPLORE_LOW_FIT_WEIGHT); // LOW fit, explore -> floor
    expect(by["plant health"].weight).toBe(3);
    expect(by["garbage one"]).toBeUndefined();                 // C still dropped first
    expect(by["never graded"].weight).toBe(UNRATED_WEIGHT);
    expect(by["never graded"].unrated).toBe(true);
    expect(by["never graded"].weight).toBeLessThan(by["plant health"].weight);
  });

  it("a rater that returns garbage yields the unrated floor, not B", async () => {
    const { rateTopics } = await loadService();
    replyFor = () => "not json at all";
    const { rated, failedBatches } = await rateTopics(["raku kiln reduction"], undefined, undefined, { taste: { interests: ["x"] } });
    expect(failedBatches).toBe(1);
    expect(rated[0].weight).toBe(UNRATED_WEIGHT);
    expect(rated[0].unrated).toBe(true);
  });
});

describe("/similar body", () => {
  it("carries every seed, the failed-shape line, and the adjacency-first quota", async () => {
    const { generateSimilarTopics } = await loadService();
    await generateSimilarTopics({
      ...CTX, query: "one man sawmill", seeds: ["one man sawmill", "bandsaw mill build", "chainsaw milling"],
      failedExamples: ["water treatment"], numTopics: 6,
    });
    const user = userOf(chatBodies[0]);
    expect(user).toContain("bandsaw mill build");
    expect(user).toContain("chainsaw milling");
    expect(user).toContain("FAILED");
    expect(user).toContain("water treatment");
    expect(user).toContain('adjacent to "one man sawmill"');
    expect(systemOf(chatBodies[0])).toContain("~60% ADJACENT");
    expect(chatBodies[0].temperature).toBeLessThanOrEqual(0.7);
  });
});

describe("grounding evidence", () => {
  it("renders views and years when supplied and accepts DEAD", async () => {
    const { judgeTopicGrounding } = await loadService();
    replyFor = () => '{"verdicts":[{"t":"dead scene","verdict":"DEAD"}]}';
    const { judged } = await judgeTopicGrounding([{
      topic: "dead scene", titles: ["old one"],
      results: [{ title: "old one", channel: "Ghost", views: 312, year: 2013 }],
    }]);
    const user = userOf(chatBodies[0]);
    expect(user).toContain("312 views");
    expect(user).toContain("2013");
    expect(user).toContain("Ghost");
    expect(systemOf(chatBodies[0])).toContain("DEAD");
    expect(judged[0].verdict).toBe("DEAD");
  });
});
