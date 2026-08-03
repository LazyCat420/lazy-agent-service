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
