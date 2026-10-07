/**
 * The identity system prompt must reach an OpenAI-compatible model.
 *
 * Until 2026-10-07 our vLLM / LM Studio / Ollama / llama.cpp / OpenAI providers
 * built requests from the messages array alone and never sent
 * `options.systemPrompt`, and ReActHarness replaced a caller's own
 * `systemPrompt` with the persona's assembled prompt. Together: a trading cycle
 * agent on the native /agent route (which sends its role prompt only as
 * `systemPrompt`) reached vLLM with no system prompt at all. These pin the
 * request the provider actually sends.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { prependIdentitySystemMessage } from "../../utils/openai-compat.ts";
import { createVllmProvider } from "../vllm.ts";
import { applyAssembledSystemPrompt } from "../../services/harnesses/lifecycle/IdentityPrompt.ts";

function completion(): Response {
  return new Response(JSON.stringify({
    id: "c1", object: "chat.completion", model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function captureBodies(): Array<{ messages: Array<{ role: string; content: unknown }> }> {
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    bodies.push(JSON.parse(String((init as RequestInit).body)));
    return completion();
  });
  return bodies;
}

describe("the identity system prompt reaches the model", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is prepended as the first message, and nothing changes without one", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(prependIdentitySystemMessage(messages, "ROLE")).toEqual([
      { role: "system", content: "ROLE" }, { role: "user", content: "hi" }]);
    expect(prependIdentitySystemMessage(messages, undefined)).toBe(messages);
    expect(prependIdentitySystemMessage(messages, "")).toBe(messages);
  });

  it("vLLM sends options.systemPrompt as the leading system message", async () => {
    const bodies = captureBodies();
    const provider = createVllmProvider("http://box:8000");
    await provider.generateText!([{ role: "user", content: "## Ticker: COF" }], "m", { systemPrompt: "ROLE PROMPT" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].messages[0]).toEqual({ role: "system", content: "ROLE PROMPT" });
    expect(bodies[0].messages[1]).toMatchObject({ role: "user" });
  });

  it("vLLM without a systemPrompt sends the messages as given", async () => {
    const bodies = captureBodies();
    const provider = createVllmProvider("http://box:8000");
    await provider.generateText!([{ role: "user", content: "hi" }], "m", {});
    expect(bodies[0].messages.map((m) => m.role)).toEqual(["user"]);
  });
});

describe("a caller's own system prompt wins over the persona's", () => {
  it("keeps the caller's prompt", () => {
    const options: { systemPrompt?: string } = { systemPrompt: "trading role prompt" };
    applyAssembledSystemPrompt(options, "persona prompt");
    expect(options.systemPrompt).toBe("trading role prompt");
  });

  it("uses the persona's prompt when the caller sent none", () => {
    const options: { systemPrompt?: string } = {};
    applyAssembledSystemPrompt(options, "persona prompt");
    expect(options.systemPrompt).toBe("persona prompt");
  });
});
