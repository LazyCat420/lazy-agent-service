/**
 * Domain focus (WallgardenDiscovery.md H4 / Option C, backend half).
 *
 * The contract has three legs and each is pinned here:
 *   1. a finance request renders the finance batch WITH the prohibition list;
 *   2. no focus renders the pre-focus prompt byte-for-byte (the literal below
 *      was captured from the code before this feature landed);
 *   3. an unknown focus is rejected instead of silently degrading.
 *
 * Topic generation only: the block forbids inventing likes/ratings, and nothing
 * here lets a focus value change the response shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SseEvent } from "../../../types/SseTypes.js";
import {
  buildBrainstormMessage,
  buildDomainFocusBlock,
  planBrainstormBatches,
  validateDomainFocus,
  brainstormTopics,
  type BrainstormContext,
} from "../WallgardenService.js";

interface ChatBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
}

const chatState = vi.hoisted(() => ({
  bodies: [] as ChatBody[],
  reply: '{"topics": ["raku firing"]}',
}));

vi.mock("../../../core/chat/ChatGeneration.js", () => ({
  handleConversation: async (params: unknown, emit: (event: SseEvent) => void) => {
    const body = params as ChatBody;
    chatState.bodies.push(body);
    emit({ type: "chunk", content: chatState.reply } as SseEvent);
    emit({ type: "done", provider: "vllm", model: body.model } as SseEvent);
  },
}));

const CTX: BrainstormContext = {
  interests: ["ceramics"],
  disliked: ["politics"],
  recentUsed: ["wood ash glaze"],
  burnedQueries: ["pottery tips"],
  searches: ["raku"],
  likedVideos: ["Raku firing (Andy Ward)"],
  watchlist: ["Ash glaze test (Old Forge)"],
  tasteProfile: "A potter.",
  numTopics: 5,
};

// Captured from buildMessage BEFORE the domain-focus change: interests
// ["ceramics"], one liked video, one watchlist save, numTopics 5 → a CORE batch
// of 2 and an ADJACENT batch of 3. Any edit to the no-focus rendering breaks
// this on purpose.
const LEGACY_CORE_PROMPT =
  "WHO I AM AS A VIEWER: A potter.\n\nMy interest topics: [ceramics]\nVideos I actually liked (strongest signal): [Raku firing (Andy Ward)]\nVideos I saved to watch later (strong signal): [Ash glaze test (Old Forge)]\nRecent searches: [raku]\nDisliked: [politics]\nRecently used (avoid these): [wood ash glaze]\nFailed queries (don't reuse these exact phrases, they returned bad results): [pottery tips]\nTHIS BATCH — CORE. Stay INSIDE the scenes in the liked videos above (all of my clusters are listed). Name what a long-time fan of each scene watches next. No leaps.\n\nSuggest 2 new topics.";

const LEGACY_ADJACENT_PROMPT =
  "WHO I AM AS A VIEWER: A potter.\n\nMy interest topics: [ceramics]\nVideos I actually liked (strongest signal): [Raku firing (Andy Ward)]\nVideos I saved to watch later (strong signal): [Ash glaze test (Old Forge)]\nRecent searches: [raku]\nDisliked: [politics]\nRecently used (avoid these): [wood ash glaze]\nFailed queries (don't reuse these exact phrases, they returned bad results): [pottery tips]\nTHIS BATCH — ADJACENT. One step away from the scenes in the liked videos above.\n\nSuggest 3 new topics.";

const [CORE, ADJACENT] = planBrainstormBatches(5, []);

/** Runtime narrowing for the error the service throws (no shape cast). */
function statusOf(err: unknown): number | undefined {
  if (err && typeof err === "object" && "statusCode" in err && typeof err.statusCode === "number") {
    return err.statusCode;
  }
  return undefined;
}

describe("validateDomainFocus", () => {
  it("accepts an absent or known focus", () => {
    expect(validateDomainFocus(undefined)).toBeNull();
    expect(validateDomainFocus(null)).toBeNull();
    expect(validateDomainFocus("")).toBeNull();
    expect(validateDomainFocus("finance")).toBeNull();
    expect(validateDomainFocus(" FINANCE ")).toBeNull();
  });

  it("rejects an unknown focus by name", () => {
    const reason = validateDomainFocus("crypto");
    expect(reason).toContain("unknown domainFocus");
    expect(reason).toContain("crypto");
    expect(reason).toContain("finance");
  });

  it("rejects a non-string focus", () => {
    expect(validateDomainFocus(42)).toBe("domainFocus must be a string");
  });
});

describe("buildDomainFocusBlock", () => {
  it("returns nothing without a focus — the legacy prompt is untouched", () => {
    expect(buildDomainFocusBlock(undefined)).toBe("");
    expect(buildDomainFocusBlock(null, ["equities"])).toBe("");
  });

  it("names the researchable finance facets", () => {
    const block = buildDomainFocusBlock("finance");
    for (const facet of ["equities", "macro", "commodities", "earnings", "sector", "market structure"]) {
      expect(block).toContain(facet);
    }
  });

  it("carries the full prohibition list", () => {
    const block = buildDomainFocusBlock("finance");
    for (const banned of [
      "100x",
      "signal group",
      "guaranteed returns",
      "airdrop",
      "presale",
      "prop-firm",
      "get rich quick",
    ]) {
      expect(block).toContain(banned);
    }
    // Topics a human would watch, not engagement bait; and no invented signal.
    expect(block).toContain("synthetic engagement bait");
    expect(block).toMatch(/never invent likes, ratings/);
    expect(block).toContain("TOPICS ONLY");
  });

  it("passes the user's own seeds through as evidence", () => {
    const block = buildDomainFocusBlock("finance", ["equities", "  ", 7, "macro"]);
    expect(block).toContain("[equities, macro]");
    expect(block).toContain("MY OWN mined/liked topics");
  });
});

describe("no-focus rendering is byte-identical to the pre-focus prompt", () => {
  it("CORE batch", () => {
    expect(buildBrainstormMessage(CTX, CORE)).toBe(LEGACY_CORE_PROMPT);
  });

  it("ADJACENT batch", () => {
    expect(buildBrainstormMessage(CTX, ADJACENT)).toBe(LEGACY_ADJACENT_PROMPT);
  });

  it("an empty focus string does not change the prompt either", () => {
    expect(buildBrainstormMessage({ ...CTX, domainFocus: "" }, CORE)).toBe(LEGACY_CORE_PROMPT);
  });
});

describe("finance focus is additive", () => {
  it("inserts exactly the domain block before the ask", () => {
    const focusCtx: BrainstormContext = { ...CTX, domainFocus: "finance", seedDomains: ["equities"] };
    const focused = buildBrainstormMessage(focusCtx, CORE);
    const block = buildDomainFocusBlock("finance", ["equities"]);
    expect(focused).toBe(LEGACY_CORE_PROMPT.replace("\n\nSuggest", `${block}\n\nSuggest`));
  });
});

// ── Does it reach the model, and is a typo rejected before any call? ──
beforeEach(() => {
  chatState.bodies.length = 0;
  chatState.reply = '{"topics": ["raku firing"]}';
  vi.stubGlobal("fetch", async (url: unknown) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) {
      return { ok: true, json: async () => ({ data: [{ id: "nemotron35" }] }) };
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("brainstormTopics", () => {
  it("sends the finance batch with the prohibition list", async () => {
    await brainstormTopics({ ...CTX, domainFocus: "finance", seedDomains: ["equities"] });
    expect(chatState.bodies.length).toBeGreaterThan(0);
    const user = chatState.bodies[0].messages.find(m => m.role === "user")?.content ?? "";
    expect(user).toContain("DOMAIN FOCUS — FINANCE");
    expect(user).toContain("HARD PROHIBITIONS");
    expect(user).toContain("100x");
    expect(user).toContain("signal group");
    expect(user).toContain("get rich quick");
    expect(user).toContain("[equities]");
  });

  it("sends the untouched prompt when no focus is requested", async () => {
    await brainstormTopics(CTX);
    const user = chatState.bodies[0].messages.find(m => m.role === "user")?.content ?? "";
    expect(user).toBe(LEGACY_CORE_PROMPT);
    expect(user).not.toContain("DOMAIN FOCUS");
  });

  it("rejects an unknown focus without calling the model", async () => {
    await expect(brainstormTopics({ ...CTX, domainFocus: "stocks" })).rejects.toThrow(/unknown domainFocus/);
    expect(chatState.bodies).toHaveLength(0);
  });

  it("marks the rejection as a 400 for the route", async () => {
    const err = await brainstormTopics({ ...CTX, domainFocus: "stocks" }).then(
      () => null,
      (rejected: unknown) => rejected,
    );
    expect(statusOf(err)).toBe(400);
    expect(chatState.bodies).toHaveLength(0);
  });
});
