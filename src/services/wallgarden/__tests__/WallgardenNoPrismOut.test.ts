/**
 * Wallgarden must reach the in-process chat handler (the same
 * handleConversation the POST /chat route uses) instead of POSTing to
 * prism-service on :7777. Regression guard for the outbound-Prism removal:
 * on the reverted source callPrismChat fetches ${REAL_PRISM_URL}/chat and
 * never invokes the handler, so both assertions fail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SseEvent } from "../../../types/SseTypes.js";
import { recommendChannels } from "../WallgardenService.js";

// Instance registry: one online Jetson serving the expected model so
// resolveProviderAndModel passes without touching the network.
vi.mock("../../../providers/instance-registry.js", () => ({
  getInstancesByType: () => [
    {
      id: "vllm",
      nickname: "Jetson",
      baseUrl: "http://10.0.0.30:8000",
      model: "nemotron35",
      status: "online",
    },
  ],
}));

// The in-process chat handler: record the params it receives and emit a
// minimal chunk+done conversation, like the real handler would.
const { handleConversationCalls, handleConversationMock } = vi.hoisted(() => {
  const calls: Array<Record<string, unknown>> = [];
  const fn = async (
    params: Record<string, unknown>,
    emit: (event: SseEvent) => void,
  ) => {
    calls.push(params);
    emit({ type: "chunk", content: '{"channels":[{"name":"Channel"}]}' } as SseEvent);
    emit({ type: "done", provider: "vllm", model: params.model } as SseEvent);
  };
  return { handleConversationCalls: calls, handleConversationMock: fn };
});
// Mock both specifier spellings — the source imports the `.js` alias of
// ChatRoutes.ts, and the resolver may expose either.
vi.mock("../../../core/chat/ChatGeneration.js", () => ({ handleConversation: handleConversationMock }));
vi.mock("../../../core/chat/ChatGeneration.ts", () => ({ handleConversation: handleConversationMock }));

// Fail the test loudly if anything fetches — especially prism's :7777.
const fetchCalls: string[] = [];
vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
  fetchCalls.push(url);
  // The vLLM box probe (discoverModels → queryVllmBox) is answered locally so
  // resolveProviderAndModel sees an online Jetson; everything else — above all
  // prism :7777 — must never be fetched.
  if (url.includes("10.0.0.30:8000/v1/models")) {
    return Promise.resolve(new Response(
      JSON.stringify({ object: "list", data: [{ id: "nemotron35" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
  }
  return Promise.reject(new Error(`unexpected network fetch in test: ${url}`));
});

describe("WallgardenService — outbound chat goes in-process, never to prism :7777", () => {
  beforeEach(() => {
    handleConversationCalls.length = 0;
    fetchCalls.length = 0;
  });

  it("routes the completion through the local chat handler", async () => {
    const result = await recommendChannels({ channels: ["Some Channel"] });
    expect(handleConversationCalls).toHaveLength(1);
    const params = handleConversationCalls[0];
    expect(params.provider).toBe("vllm");
    expect(params.model).toBe("nemotron35");
    expect(Array.isArray(params.messages)).toBe(true);
    expect(params.skipConversation).toBe(true);
    expect(result.channels[0].name).toBe("Channel");
  });

  it("never fetches prism-service on :7777", async () => {
    await recommendChannels({ channels: ["Some Channel"] });
    const prismCalls = fetchCalls.filter((u) => u.includes(":7777") || u.includes("/chat"));
    expect(prismCalls).toEqual([]);
  });
});
