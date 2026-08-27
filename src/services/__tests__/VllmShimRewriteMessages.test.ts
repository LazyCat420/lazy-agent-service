import { afterEach, describe, expect, it } from "vitest";
import { VllmShimService } from "../vllm/VllmShimService.js";

// 2026-08-26 (cycle-v3-1787786020/KSS, request 7f0929e2): after two MCP tool
// timeouts, prism's empty-output recovery stacked four IDENTICAL
// `<empty-output-recovery>` role:"system" messages onto the conversation with
// no assistant/user turn between them. Prism demotes non-leading system
// messages only for models matching "qwen3.6" (its TEMP PATCH), so DeepSeek's
// chat template got the raw stack — and answered each retry with a lone EOS
// (outputTokens=1, 34,048/34,342 input tokens cache-read). Prism is read-only
// upstream; this shim carries ALL prism→vLLM traffic, so the repair lives
// here.

const RECOVERY =
  "<empty-output-recovery>\n\nYour previous response was empty. Please provide output.\n\n</empty-output-recovery>";

// The shape of the actual KSS iteration-4 payload, reduced: leading system
// prompt, real turns, assistant tool-call turn, retry guidance, then the
// stacked recovery nudges.
const kssTail = () => [
  { role: "system", content: "You are the Junior Analyst..." },
  { role: "user", content: "Acknowledged. I am ready to process the quantitative data." },
  { role: "user", content: "## Ticker: KSS ..." },
  { role: "assistant", content: "" },
  { role: "system", content: "<tool-retry-guidance>\n\n[TOOL RETRY GUIDANCE] 2 tool call(s) failed...\n\n</tool-retry-guidance>" },
  { role: "system", content: RECOVERY },
  { role: "system", content: RECOVERY },
  { role: "system", content: RECOVERY },
];

describe("VllmShimService.rewriteMessages", () => {
  afterEach(() => {
    delete process.env.VLLM_SHIM_REWRITE_MESSAGES;
  });

  it("collapses the stacked recovery nudges and demotes non-leading system turns (the KSS tail)", () => {
    const body = { model: "deepseek-v4-flash-0731", messages: kssTail() };
    const out = VllmShimService.rewriteMessages(body) as { messages: Array<{ role: string; content: string }> };

    // Three identical consecutive recovery messages became one.
    const recoveries = out.messages.filter((m) => m.content === RECOVERY);
    expect(recoveries).toHaveLength(1);

    // The leading system prompt survives as system; every later system turn
    // is now a user turn, so the template sees alternation again.
    expect(out.messages[0].role).toBe("system");
    expect(out.messages.slice(1).every((m) => m.role !== "system")).toBe(true);

    // Nothing else was reordered or dropped.
    expect(out.messages.map((m) => m.content)).toEqual([
      "You are the Junior Analyst...",
      "Acknowledged. I am ready to process the quantitative data.",
      "## Ticker: KSS ...",
      "",
      "<tool-retry-guidance>\n\n[TOOL RETRY GUIDANCE] 2 tool call(s) failed...\n\n</tool-retry-guidance>",
      RECOVERY,
    ]);
  });

  it("returns the body by IDENTITY when nothing needs rewriting", () => {
    const body = {
      model: "deepseek-v4-flash-0731",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    };
    expect(VllmShimService.rewriteMessages(body)).toBe(body);
  });

  it("does not collapse non-consecutive or non-identical repeats", () => {
    const body = {
      messages: [
        { role: "system", content: "sys" },
        { role: "system", content: RECOVERY },
        { role: "user", content: "something in between" },
        { role: "system", content: RECOVERY },
      ],
    };
    const out = VllmShimService.rewriteMessages(body) as { messages: Array<{ role: string }> };
    // Demoted, but both recovery messages survive: they are not consecutive.
    expect(out.messages).toHaveLength(4);
  });

  it("kill switch VLLM_SHIM_REWRITE_MESSAGES=false restores pass-through", () => {
    process.env.VLLM_SHIM_REWRITE_MESSAGES = "false";
    const body = { messages: kssTail() };
    expect(VllmShimService.rewriteMessages(body)).toBe(body);
  });

  it("SABOTAGE CONTROL: the pre-fix payload really does carry the degenerate stack", () => {
    // What reached DeepSeek before the fix: assert the defect is present in
    // the fixture so the collapse test above cannot pass vacuously.
    const messages = kssTail();
    const trailingSystems = messages.slice(-4).filter((m) => m.role === "system");
    expect(trailingSystems).toHaveLength(4);
    expect(messages.slice(-3).every((m) => m.content === RECOVERY)).toBe(true);
  });
});
