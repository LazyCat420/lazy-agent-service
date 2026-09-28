import { describe, it, expect } from "vitest";
import { applyTradingToolProtocol, FINAL_TURN_DIRECTIVE } from "../TradingToolProtocol.ts";

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

describe("prism's forced final turn", () => {
  // The notice prism appends at its maxIterations ceiling, verbatim from a stored
  // trading payload (cycle-v3-1790464211 NSC v3_bull_agent, 6th provider payload).
  const notice = "<iteration-limit>\n\nMaximum tool-call iterations reached for this turn. Summarize progress so far, report partial results, and state what remains to be done.\n\n</iteration-limit>";
  const wallTurn = () => ({ messages: [
    { role: "system", content: "role" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "get_market_data", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "quote" },
    { role: "user", content: notice },
  ] });

  it("tells the model the turn is for the artifact when the tools are gone", () => {
    const body = wallTurn();
    const before = JSON.stringify(body);
    const fixed = applyTradingToolProtocol(body, ["get_market_data"]);
    const last = fixed.body.messages[fixed.body.messages.length - 1];
    expect(fixed.finalTurnDirected).toBe(true);
    expect(last.content).toBe(notice + "\n" + FINAL_TURN_DIRECTIVE);
    expect(fixed.body.messages[2]).toBe(body.messages[2]);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("leaves a turn that still offers tools alone", () => {
    const body = { ...wallTurn(), tools: [tool("get_market_data")] };
    const fixed = applyTradingToolProtocol(body, ["get_market_data"]);
    expect(fixed.finalTurnDirected).toBe(false);
    expect(fixed.body.messages[3].content).toBe(notice);
  });

  it("treats a catalog the role filter emptied as no tools", () => {
    const body = { ...wallTurn(), tools: [tool("execute_python")] };
    const fixed = applyTradingToolProtocol(body, ["get_market_data"]);
    expect(fixed.body).not.toHaveProperty("tools");
    expect(fixed.finalTurnDirected).toBe(true);
  });

  it("does not touch a notice that is not the last turn, and never appends twice", () => {
    const earlier = wallTurn();
    earlier.messages.push({ role: "assistant", content: "{}", tool_calls: undefined } as any);
    expect(applyTradingToolProtocol(earlier).finalTurnDirected).toBe(false);
    const once = applyTradingToolProtocol(wallTurn()).body;
    const twice = applyTradingToolProtocol(once);
    expect(twice.finalTurnDirected).toBe(false);
    expect(twice.body.messages[3].content.split(FINAL_TURN_DIRECTIVE).length).toBe(2);
  });

  it("leaves ordinary tool-less requests alone", () => {
    const fixed = applyTradingToolProtocol({ messages: [{ role: "system", content: "role" }, { role: "user", content: "## Ticker: NSC" }] });
    expect(fixed.finalTurnDirected).toBe(false);
    expect(fixed.body.messages[1].content).toBe("## Ticker: NSC");
  });
});
