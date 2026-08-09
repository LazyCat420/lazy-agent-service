import { describe, it, expect } from "vitest";
import { VllmShimService } from "../vllm/VllmShimService.js";

describe("VllmShimService.translateChatTemplateKwargs", () => {
  it("mirrors enable_thinking:false onto the DeepSeek thinking key", () => {
    const body = VllmShimService.translateChatTemplateKwargs({
      model: "deepseek-v4-flash-0731",
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false, thinking: false });
  });

  it("mirrors enable_thinking:true onto thinking:true", () => {
    const body = VllmShimService.translateChatTemplateKwargs({
      chat_template_kwargs: { enable_thinking: true },
    });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true, thinking: true });
  });

  it("never overwrites an explicit thinking key", () => {
    const body = VllmShimService.translateChatTemplateKwargs({
      chat_template_kwargs: { enable_thinking: false, thinking: true },
    });
    expect((body.chat_template_kwargs as Record<string, unknown>).thinking).toBe(true);
  });

  it("leaves bodies without chat_template_kwargs untouched", () => {
    const body = VllmShimService.translateChatTemplateKwargs({ model: "m", messages: [] });
    expect("chat_template_kwargs" in body).toBe(false);
  });

  it("ignores a non-object chat_template_kwargs", () => {
    const body = VllmShimService.translateChatTemplateKwargs({
      chat_template_kwargs: "bogus" as unknown as Record<string, unknown>,
    });
    expect(body.chat_template_kwargs).toBe("bogus");
  });
});

describe("VllmShimService.resolveUpstream", () => {
  it("routes gold-spark to the DGX", () => {
    const r = VllmShimService.resolveUpstream("/vllm-shim/gold-spark/v1/chat/completions");
    expect(r?.upstreamUrl).toBe("http://10.0.0.141:8000");
    expect(r?.originalPath).toBe("/v1/chat/completions");
  });

  it("routes jetson and jetson-2 to their ports", () => {
    expect(VllmShimService.resolveUpstream("/vllm-shim/jetson/v1/models")?.upstreamUrl)
      .toBe("http://10.0.0.30:8000");
    expect(VllmShimService.resolveUpstream("/vllm-shim/jetson-2/v1/models")?.upstreamUrl)
      .toBe("http://10.0.0.30:8001");
  });

  it("preserves query strings", () => {
    const r = VllmShimService.resolveUpstream("/vllm-shim/gold-spark/v1/models?x=1");
    expect(r?.originalPath).toBe("/v1/models?x=1");
  });

  it("returns null for unknown upstreams", () => {
    expect(VllmShimService.resolveUpstream("/vllm-shim/nope/v1/models")).toBeNull();
  });

  it("defaults bare upstream to /", () => {
    expect(VllmShimService.resolveUpstream("/vllm-shim/jetson")?.originalPath).toBe("/");
  });
});

describe("thinking-flag arrival accounting", () => {
  const counts = () =>
    (VllmShimService as unknown as {
      thinkingSeen: { absent: number; off: number; on: number; alreadyMirrored: number };
    }).thinkingSeen;

  const reset = () => {
    (VllmShimService as unknown as { thinkingSeen: unknown }).thinkingSeen = {
      absent: 0, off: 0, on: 0, alreadyMirrored: 0,
    };
    (VllmShimService as unknown as { thinkingReportedAt: number }).thinkingReportedAt = Date.now();
  };

  it("counts a missing chat_template_kwargs as absent — the case that strands the flag", () => {
    reset();
    VllmShimService.recordThinkingFlag({ model: "deepseek-v4-flash-0731" });
    expect(counts().absent).toBe(1);
    expect(counts().off).toBe(0);
  });

  it("counts an explicit thinking-off as off, not absent", () => {
    reset();
    VllmShimService.recordThinkingFlag({ chat_template_kwargs: { enable_thinking: false } });
    expect(counts().off).toBe(1);
    expect(counts().absent).toBe(0);
  });

  it("distinguishes thinking-on from a dropped flag", () => {
    reset();
    VllmShimService.recordThinkingFlag({ chat_template_kwargs: { enable_thinking: true } });
    expect(counts().on).toBe(1);
    expect(counts().absent).toBe(0);
  });

  it("never mutates the request it is measuring", () => {
    reset();
    const body = { chat_template_kwargs: { enable_thinking: false } };
    const before = JSON.stringify(body);
    VllmShimService.recordThinkingFlag(body);
    expect(JSON.stringify(body)).toBe(before);
  });
});

describe("VllmShimService.clampEmbeddingInput", () => {
  // The defect this pins (2026-08-09): prism's memory layer sends whole agent
  // prompts to a 2,048-token embedder; vLLM rejected 931 such calls in 14
  // days ("maximum context length is 2048 tokens"), so prism memory was
  // silently OFF for the trading project. The shim now truncates instead.
  const BUDGET = 4_900;

  it("truncates a single oversized string input to the budget", () => {
    const body = VllmShimService.clampEmbeddingInput({ input: "x".repeat(20_000) });
    expect((body.input as string).length).toBe(BUDGET);
  });

  it("leaves an in-budget string untouched", () => {
    const body = VllmShimService.clampEmbeddingInput({ input: "short text" });
    expect(body.input).toBe("short text");
  });

  it("clamps each string of an array input independently", () => {
    const body = VllmShimService.clampEmbeddingInput({
      input: ["ok", "y".repeat(9_000), "z".repeat(5_000)],
    });
    const arr = body.input as string[];
    expect(arr[0]).toBe("ok");
    expect(arr[1].length).toBe(BUDGET);
    expect(arr[2].length).toBe(BUDGET);
  });

  it("passes token-id arrays through untouched — truncating ids corrupts them", () => {
    const ids = Array.from({ length: 6000 }, (_, i) => i);
    const body = VllmShimService.clampEmbeddingInput({ input: ids });
    expect((body.input as number[]).length).toBe(6000);
  });

  it("tolerates bodies with no input field", () => {
    const body = VllmShimService.clampEmbeddingInput({ model: "embeddinggemma" });
    expect("input" in body).toBe(false);
  });
});

describe("VllmShimService.shrinkEmbeddingInput", () => {
  // The defect this pins (2026-08-09, post-clamp): the 4,900-char clamp is a
  // heuristic; the desk's dense JSON/ticker text runs ~2.4 chars per token,
  // so clamped inputs still overflowed the 2,048-token window by a hair
  // ("at least 2049 input tokens"). The shim now rescales by the embedder's
  // own token measurement and retries.

  it("shrinks a long string by the factor", () => {
    const body: Record<string, unknown> = { input: "x".repeat(4_900) };
    const changed = VllmShimService.shrinkEmbeddingInput(body, 0.9, 2_048);
    expect(changed).toBe(true);
    expect((body.input as string).length).toBe(Math.floor(4_900 * 0.9));
  });

  it("leaves strings at or under the floor untouched — they cannot be the overflow", () => {
    const body: Record<string, unknown> = { input: ["a".repeat(2_000), "b".repeat(4_900)] };
    const changed = VllmShimService.shrinkEmbeddingInput(body, 0.5, 2_048);
    const arr = body.input as string[];
    expect(changed).toBe(true);
    expect(arr[0].length).toBe(2_000);
    expect(arr[1].length).toBe(2_450);
  });

  it("reports no change when nothing qualifies, so the caller stops retrying", () => {
    const body: Record<string, unknown> = { input: "short" };
    expect(VllmShimService.shrinkEmbeddingInput(body, 0.5, 2_048)).toBe(false);
    expect(body.input).toBe("short");
  });

  it("passes token-id arrays through untouched", () => {
    const ids = Array.from({ length: 3000 }, (_, i) => i);
    const body: Record<string, unknown> = { input: ids };
    expect(VllmShimService.shrinkEmbeddingInput(body, 0.5, 0)).toBe(false);
    expect((body.input as number[]).length).toBe(3000);
  });

  it("parses the live vLLM rejection into window and measured tokens", () => {
    const live =
      "This model's maximum context length is 2048 tokens. However, you requested " +
      "0 output tokens and your prompt contains at least 2049 input tokens, for a " +
      "total of at least 2049 tokens. Please reduce the length of the input prompt " +
      "or the number of requested output tokens. (parameter=input_tokens, value=2049)";
    const m = live.match((VllmShimService as any).CTX_LEN_RE);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(2048);
    expect(Number(m![2])).toBe(2049);
  });
});
