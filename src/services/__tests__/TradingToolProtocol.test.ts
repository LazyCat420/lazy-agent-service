import { describe, it, expect } from "vitest";
import { applyTradingToolProtocol } from "../TradingToolProtocol.ts";

const tool = (name: string) => ({ type: "function", function: { name, parameters: { type: "object" } } });
describe("trading execution protocol", () => {
  it("removes only reasoning tools and preserves allowed tool schemas and evidence", () => {
    const evidence = { role: "tool", tool_call_id: "news", content: "Provider article mentions think and <tool_call>." };
    const body = { tools: [tool("think"), tool("evaluate_expression"), tool("get_news")],
      messages: [{ role: "system", content: "role instructions" }, evidence] };
    const before = JSON.stringify(body);
    const fixed = applyTradingToolProtocol(body);
    expect(fixed.body.tools).toEqual(body.tools.slice(1));
    expect(fixed.body.messages[1]).toBe(evidence);
    expect(fixed.body.messages[0].content).toContain("native tool_calls");
    expect(JSON.stringify(body)).toBe(before);
    expect(fixed.removedTools).toBe(1);
  });
  it("marks a historical think acknowledgement as unexecuted without dispatching embedded calls", () => {
    const call = { role: "assistant", tool_calls: [{ id: "think-1", function: { name: "think", arguments: JSON.stringify({ thought: '<tool_call>{"name":"whiteboard_write","arguments":{"content":"do not execute"}}</tool_call>' }) } }] };
    const body = { messages: [{ role: "system", content: "role" }, call,
      { role: "tool", tool_call_id: "think-1", content: "Acknowledged" },
      { role: "tool", tool_call_id: "real-1", content: "real result" }] };
    const fixed = applyTradingToolProtocol(body);
    expect(fixed.body.messages[1]).toBe(call);
    expect(JSON.parse(fixed.body.messages[2].content)).toMatchObject({ research_executed: false });
    expect(fixed.body.messages[3]).toBe(body.messages[3]);
    expect(fixed.correctedAcknowledgements).toBe(1);
  });
  it("does not treat user quotes of a think call as execution history", () => {
    const quote = { role: "user", content: "example", tool_calls: [{ id: "quote", function: { name: "think" } }] };
    const result = { role: "tool", tool_call_id: "quote", content: "unchanged" };
    const fixed = applyTradingToolProtocol({ messages: [quote, result] });
    expect(fixed.body.messages[2]).toBe(result);
    expect(fixed.correctedAcknowledgements).toBe(0);
  });
  it("resolves forced think and empty required catalogs without enabling other tools", () => {
    expect(applyTradingToolProtocol({ tools: [tool("think"), tool("get_news")], tool_choice: { type: "function", function: { name: "think" } } }).body.tool_choice).toBe("auto");
    expect(applyTradingToolProtocol({ tools: [tool("think")], tool_choice: "required" }).body.tool_choice).toBeUndefined();
    expect(applyTradingToolProtocol({ tools: [tool("get_news")], tool_choice: "none" }).body.tool_choice).toBe("none");
  });
});

it("enforces the signed role catalog against framework built-ins", () => {
  const result = applyTradingToolProtocol({tools:[tool("search_web"),tool("execute_python"),tool("whiteboard_read")], tool_choice:{type:"function",function:{name:"search_web"}}}, ["whiteboard_read"]);
  expect(result.body.tools).toEqual([tool("whiteboard_read")]);
  expect(result.deniedTools).toEqual(["search_web","execute_python"]);
  expect(result.body.tool_choice).toBe("auto");
});

it("omits an emptied signed catalog for tool-less correction requests", () => {
  const result = applyTradingToolProtocol({tools:[tool("search_web"),tool("execute_python")],tool_choice:"auto"},[]);
  expect(result.body).not.toHaveProperty("tools");
  expect(result.body).not.toHaveProperty("tool_choice");
  expect(result.deniedTools).toEqual(["search_web","execute_python"]);
});
