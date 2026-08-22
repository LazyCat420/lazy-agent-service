import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BrainstormContext } from "../WallgardenService.js";

// Wallgarden is pinned to the Jetson. These tests drive the REAL seam —
// discovery + resolution + the outbound prism call — by stubbing global fetch,
// because the bug this pin prevents is invisible to a parser test: the old
// resolver preferred Gold Spark and took any client-supplied provider verbatim,
// so a stale browser localStorage value silently kept driving the wrong box.

const JETSON_URL = "http://10.0.0.30:8000";
const GOLD_SPARK_URL = "http://10.0.0.141:8000";
const JETSON_MODEL = "cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit";
const GOLD_SPARK_MODEL = "deepseek-v4-flash-0731";

/** Minimum viable BrainstormContext — typed, so a field added to the
 *  interface breaks compilation here rather than throwing at runtime. */
const CTX: BrainstormContext = {
  interests: ["ceramics"],
  disliked: [],
  recentUsed: [],
  burnedQueries: [],
  numTopics: 5,
};

/** Records every prism /chat body sent during a test. */
let chatBodies: any[];
/** Which boxes answer /v1/models. */
let onlineBoxes: Record<string, string>;

function installFetchStub() {
  chatBodies = [];
  vi.stubGlobal("fetch", async (url: any, init?: any) => {
    const u = String(url);

    if (u.endsWith("/v1/models")) {
      const base = u.replace(/\/v1\/models$/, "");
      const model = onlineBoxes[base];
      if (!model) throw new Error(`connection refused: ${base}`);
      return {
        ok: true,
        json: async () => ({ data: [{ id: model }] }),
      } as any;
    }

    if (u.includes("/chat")) {
      chatBodies.push(JSON.parse(init.body));
      return {
        ok: true,
        json: async () => ({
          text: '{"topics": ["wood ash glaze"]}',
          provider: "vllm",
          model: JETSON_MODEL,
        }),
      } as any;
    }

    throw new Error(`unexpected fetch: ${u}`);
  });
}

/** Fresh module each test — discoverModels holds a 60s in-module cache. */
async function loadService() {
  vi.resetModules();
  return import("../WallgardenService.js");
}

beforeEach(() => {
  installFetchStub();
  onlineBoxes = { [JETSON_URL]: JETSON_MODEL, [GOLD_SPARK_URL]: GOLD_SPARK_MODEL };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Jetson pin", () => {
  it("sends the Jetson model even though Gold Spark is also online", async () => {
    const { brainstormTopics } = await loadService();
    await brainstormTopics(CTX);

    expect(chatBodies.length).toBeGreaterThan(0);
    for (const body of chatBodies) {
      expect(body.model).toBe(JETSON_MODEL);
      expect(body.provider).toBe("vllm");
    }
  });

  it("ignores a stale client hint pointing at Gold Spark", async () => {
    const { brainstormTopics } = await loadService();
    // Exactly what an old browser tab replays out of localStorage.
    await brainstormTopics({
      ...CTX,
      provider: "vllm-2",
      model: GOLD_SPARK_MODEL,
    });

    expect(chatBodies.length).toBeGreaterThan(0);
    for (const body of chatBodies) {
      expect(body.model).toBe(JETSON_MODEL);
      expect(body.provider).toBe("vllm");
    }
  });

  it("fails loudly instead of falling back to Gold Spark when the Jetson is down", async () => {
    onlineBoxes = { [GOLD_SPARK_URL]: GOLD_SPARK_MODEL }; // Jetson offline
    const { brainstormTopics } = await loadService();

    await expect(
      brainstormTopics(CTX)
    ).rejects.toThrow(/Jetson/);

    // The point of the pin: nothing was sent to any model at all.
    expect(chatBodies).toEqual([]);
  });

  it("still disables thinking — Qwen3.6 reasons by default and would return empty text", async () => {
    const { brainstormTopics } = await loadService();
    await brainstormTopics(CTX);

    for (const body of chatBodies) {
      expect(body.thinkingEnabled).toBe(false);
    }
  });

  it("only advertises the Jetson to the dashboard dropdown", async () => {
    const { discoverModels, JETSON_PROVIDER } = await loadService();
    const boxes = await discoverModels();
    const usable = boxes.filter((b: any) => b.id === JETSON_PROVIDER);

    expect(usable).toHaveLength(1);
    expect(usable[0].model).toBe(JETSON_MODEL);
  });
});
