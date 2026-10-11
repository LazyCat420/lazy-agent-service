import { describe, expect, it } from "vitest";
import { buildResumeMessages } from "../ConversationService.ts";

describe("run resume keeps tool call/result pairs (audit e23d775)", () => {
  it("re-emits the embedded result right after its call, never an orphan", () => {
    const resumed = buildResumeMessages([
      { role: "user", content: "price?" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "get_market_data", args: { ticker: "NVDA" }, result: { price: 181 } }] },
      { role: "assistant", content: "NVDA is 181." },
    ] as never);
    expect(resumed.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(resumed[1].toolCalls).toEqual([{ id: "c1", name: "get_market_data", args: { ticker: "NVDA" } }]);
    expect(resumed[2]).toMatchObject({ role: "tool", tool_call_id: "c1", content: '{"price":181}' });
  });

  it("prefers a stored tool message and drops tool rows with no call", () => {
    const resumed = buildResumeMessages([
      { role: "tool", tool_call_id: "ghost", content: "orphan" },
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "web_search", args: {} }] },
      { role: "tool", tool_call_id: "c2", content: "stored result" },
    ] as never);
    expect(resumed.filter((m) => m.role === "tool")).toEqual([{ role: "tool", tool_call_id: "c2", content: "stored result" }]);
  });
});
