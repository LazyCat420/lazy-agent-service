// Trading tool authority at its edges: the signed context (encode, decode, expiry, tampering,
// wrong scope), the SSE transform that attaches it to tool calls, and the request protocol.
// TradingToolContext.test.ts and TradingToolProtocol.test.ts cover the main paths; nothing here
// repeats them.
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  TOOL_CONTEXT_ARG as ARG,
  attachToolContext,
  authorizeTradingTool,
  extractToolContext,
  prepareToolContext,
  signMcpClient,
  signToolContext,
  verifyMcpClient,
  verifyToolContext,
} from "../TradingToolContext.ts";
import { TradingToolStream, bindRecoveredToolArgs, bindToolResponse } from "../TradingToolStream.ts";
import { PARALLEL_TOOL_HINT, applyTradingToolProtocol } from "../TradingToolProtocol.ts";

const NOW = 1_800_000_000_000;
const TAG = "TRADING_TOOL_CONTEXT_V1";
const MCP = "mcp__lazy-agent-service__";

const freshKey = () => randomBytes(24).toString("hex");

beforeEach(() => vi.stubEnv("TRADING_TOOL_CONTEXT_KEY", freshKey()));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const context = () => ({
  project: "vllm-trading-bot" as const,
  agentName: "v3_junior_analyst",
  cycleId: "cycle-v3-test-a",
  ticker: "TEST",
  conversationId: "session-test",
  allowedTools: ["whiteboard_read", "whiteboard_write"],
  expiresAt: Date.now() + 60_000,
});
const marker = (token: string) => `<${TAG}>${token}</${TAG}>`;
const tampered = (token: string) => `${token.slice(0, -4)}AAAA`;

describe("signed trading tool context", () => {
  it("T1 a context survives sign then verify with every field intact, including non-ASCII and an empty tool list", () => {
    const original = { ...context(), agentName: "bull_agent_é", ticker: "BRK.B", allowedTools: [] };
    expect(verifyToolContext(signToolContext(original))).toEqual(original);
  });

  it("T2 a token is valid up to, and not at, its expiry millisecond", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(verifyToolContext(signToolContext({ ...context(), expiresAt: NOW + 1 })).expiresAt).toBe(NOW + 1);
    expect(() => verifyToolContext(signToolContext({ ...context(), expiresAt: NOW }))).toThrow("Expired or malformed");

    const token = signToolContext({ ...context(), expiresAt: NOW + 1_000 });
    expect(verifyToolContext(token).ticker).toBe("TEST");
    vi.setSystemTime(NOW + 1_000);
    expect(() => verifyToolContext(token)).toThrow("Expired or malformed");
  });

  it.each([
    ["undefined", undefined],
    ["a number", 123],
    ["a string over 32,768 characters", "a".repeat(32_769)],
  ])("T3 %s is reported as missing authorization", (_name, token) => {
    expect(() => verifyToolContext(token)).toThrow("Missing trading tool authorization");
  });

  it.each(["", "abc", "a.b.c"])("T3 %j is reported as invalid authorization", (token) => {
    expect(() => verifyToolContext(token)).toThrow("Invalid trading tool authorization");
  });

  it("T4 a payload swapped under another payload's signature is rejected", () => {
    const [, signature] = signToolContext(context()).split(".");
    const widened = Buffer.from(JSON.stringify({ ...context(), allowedTools: ["buy_stock"] })).toString("base64url");
    expect(() => verifyToolContext(`${widened}.${signature}`)).toThrow("Invalid");
  });

  it("T5 a token stops verifying when the signing key changes, and the placeholder key cannot sign", () => {
    const token = signToolContext(context());
    vi.stubEnv("TRADING_TOOL_CONTEXT_KEY", freshKey());
    expect(() => verifyToolContext(token)).toThrow("Invalid");

    vi.stubEnv("TRADING_TOOL_CONTEXT_KEY", "change-me-local-dev");
    expect(() => signToolContext(context())).toThrow("signing key is not configured");
  });

  it.each<[string, Record<string, unknown>]>([
    ["another project", { ...context(), project: "html-notes-client" }],
    ["an empty agent name", { ...context(), agentName: "" }],
    ["an empty conversation id", { ...context(), conversationId: "" }],
    ["allowedTools as a string", { ...context(), allowedTools: "whiteboard_read" }],
    ["allowedTools holding a number", { ...context(), allowedTools: [1] }],
    ["expiresAt as text", { ...context(), expiresAt: "soon" }],
    ["expiresAt of Infinity", { ...context(), expiresAt: Number.POSITIVE_INFINITY }],
    ["a numeric cycle id", { ...context(), cycleId: 5 }],
    ["no ticker field", (({ ticker: _ticker, ...rest }) => rest)(context())],
  ])("T6 a correctly signed context with %s is rejected", (_name, payload) => {
    expect(() => verifyToolContext(signToolContext(payload as never))).toThrow("Expired or malformed");
  });

  it("T7 authorizeTradingTool rejects a call that carries no context", () => {
    expect(() => authorizeTradingTool("whiteboard_read", { ticker: "TEST" })).toThrow("Missing trading tool authorization");
  });

  it("T7 authorizeTradingTool returns the arguments without the context and leaves the caller's object alone", () => {
    const token = signToolContext(context());
    const args = { ticker: "TEST", [ARG]: token };
    const result = authorizeTradingTool("whiteboard_read", args);
    expect(result.arguments).toEqual({ ticker: "TEST" });
    expect(args[ARG]).toBe(token);
  });

  it("T7 a cycle-scoped tool needs a cycle id; other tools do not", () => {
    const noCycle = signToolContext({ ...context(), cycleId: "", allowedTools: ["request_peer_analysis", "get_news"] });
    expect(() => authorizeTradingTool("request_peer_analysis", { [ARG]: noCycle })).toThrow("explicit cycle");
    expect(authorizeTradingTool("get_news", { q: "x", [ARG]: noCycle }).arguments).toEqual({ q: "x" });
  });

  it("T7 a tool whose name only starts with an allowed name is not allowed", () => {
    const token = signToolContext({ ...context(), allowedTools: ["whiteboard_read"] });
    expect(() => authorizeTradingTool("whiteboard_read_extra", { [ARG]: token })).toThrow("not allowed");
  });

  it("T8 attachToolContext treats empty arguments as an empty object", () => {
    expect(JSON.parse(attachToolContext("", "tok"))).toEqual({ [ARG]: "tok" });
  });

  it.each(["[]", "null", '"str"'])("T8 attachToolContext refuses arguments %s that are not an object", (argumentsText) => {
    expect(() => attachToolContext(argumentsText, "tok")).toThrow("Tool arguments must be an object");
  });

  it("T8 attachToolContext refuses unparseable arguments, and replaces a context the model wrote itself", () => {
    expect(() => attachToolContext("{bad", "tok")).toThrow();
    expect(JSON.parse(attachToolContext(`{"${ARG}":"forged","x":1}`, "tok"))).toEqual({ [ARG]: "tok", x: 1 });
  });

  it("T9 the same marker twice in a system message yields one token and leaves no trace in the message", () => {
    const token = signToolContext(context());
    const extracted = extractToolContext({ messages: [{ role: "system", content: `${marker(token)}\nrole\n${marker(token)}` }] });
    expect(extracted.token).toBe(token);
    expect(extracted.body.messages[0].content).not.toContain(token);
    expect(extracted.body.messages[0].content).not.toContain(TAG);
  });

  it("T9 two different valid tokens in one request are a conflict", () => {
    const first = signToolContext(context());
    const second = signToolContext({ ...context(), agentName: "v3_bull_agent" });
    expect(() => extractToolContext({ messages: [{ role: "system", content: marker(first) + marker(second) }] })).toThrow("Conflicting trading tool identities");
  });

  it("T9 a marker holding a tampered token, or one that is never closed, is rejected", () => {
    const token = signToolContext(context());
    expect(() => extractToolContext({ messages: [{ role: "system", content: marker(tampered(token)) }] })).toThrow();
    expect(() => extractToolContext({ messages: [{ role: "system", content: `<${TAG}>abc` }] })).toThrow("Malformed trading tool context marker");
  });

  it("T9 a marker in a user message grants nothing and is left where it is", () => {
    const content = marker(signToolContext(context()));
    const extracted = extractToolContext({ messages: [{ role: "user", content }] });
    expect(extracted.token).toBeUndefined();
    expect(extracted.body.messages[0].content).toBe(content);
  });

  it("T9 the request body passed in is not modified", () => {
    const token = signToolContext(context());
    const body = {
      messages: [
        { role: "system", content: `${marker(token)}\nrole` },
        { role: "assistant", tool_calls: [{ function: { name: "whiteboard_read", arguments: attachToolContext("{}", token) } }] },
      ],
    };
    const before = JSON.stringify(body);
    extractToolContext(body);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("T9 an echoed tool call with unparseable arguments is passed through as the same object", () => {
    const call = { function: { name: "whiteboard_read", arguments: "{bad" } };
    const extracted = extractToolContext({ messages: [{ role: "assistant", tool_calls: [call] }] });
    expect(extracted.body.messages[0].tool_calls[0]).toBe(call);
  });

  const tradingRequest = (extra: Record<string, unknown> = {}) => ({
    project: "vllm-trading-bot",
    agent: "CUSTOM_V3_JUNIOR_ANALYST",
    conversationId: "session-test",
    enabledTools: ["whiteboard_read"],
    messages: [{ role: "user", content: "## Ticker: TEST" }],
    ...extra,
  });
  const preparedContext = (request: Record<string, unknown>) => {
    const prepared = prepareToolContext(request);
    return verifyToolContext(extractToolContext({ messages: [{ role: "system", content: prepared.systemPrompt }] }).token);
  };

  it("T10 a request from another project is returned untouched", () => {
    const body = { project: "html-notes-client", messages: [] };
    expect(prepareToolContext(body)).toBe(body);
  });

  it.each([
    ["no agent", { agent: undefined }],
    ["an agent that is only the custom_ prefix", { agent: "custom_" }],
    ["no conversation id", { conversationId: undefined }],
  ])("T10 a trading request with %s is refused", (_name, extra) => {
    expect(() => prepareToolContext(tradingRequest(extra))).toThrow("requires agent and conversation identity");
  });

  it("T10 the allowed tools are the string entries, without the MCP prefix, each once", () => {
    const allowed = preparedContext(tradingRequest({ enabledTools: [1, null, "whiteboard_read", `${MCP}whiteboard_read`] })).allowedTools;
    expect(allowed).toEqual(["whiteboard_read"]);
  });

  it("T10 the ticker is read only from an upper-case heading", () => {
    expect(preparedContext(tradingRequest({ messages: [{ role: "user", content: "## Ticker: brk" }] })).ticker).toBe("");
    expect(preparedContext(tradingRequest({ messages: [{ role: "user", content: "## Ticker: BRK.B" }] })).ticker).toBe("BRK.B");
  });

  it("T10 a prepared context expires 24 hours after it is minted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(preparedContext(tradingRequest()).expiresAt).toBe(NOW + 86_400_000);
  });

  it("T11 verifyMcpClient returns undefined for anything but an intact client token", () => {
    expect(verifyMcpClient(signMcpClient("p"))).toBe("p");
    expect(verifyMcpClient(tampered(signMcpClient("p")))).toBeUndefined();
    expect(verifyMcpClient("a".repeat(2_049))).toBeUndefined();
    expect(verifyMcpClient(signMcpClient(""))).toBeUndefined();
    expect(verifyMcpClient(`${signMcpClient("p")}.x`)).toBeUndefined();
    expect(verifyMcpClient(42)).toBeUndefined();
  });
});

describe("TradingToolStream and tool-call binding", () => {
  const sse = (payload: unknown) => Buffer.from(`data: ${JSON.stringify(payload)}\n\n`);
  const callChunk = (name: string, args: string) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name, arguments: args } }] } }] });
  const finishChunk = (reason: string) => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });

  const FrameSchema = z.looseObject({
    choices: z
      .array(z.looseObject({ delta: z.looseObject({ tool_calls: z.array(z.looseObject({ function: z.looseObject({ arguments: z.string().optional() }).optional() })).optional() }).optional() }))
      .optional(),
  });
  /** Every tool-call argument fragment in the stream's output, concatenated: what the consumer assembles. */
  const releasedArguments = (output: string): string => {
    let released = "";
    for (const event of output.split("\n\n")) {
      if (!event.startsWith("data: {")) continue;
      for (const choice of FrameSchema.parse(JSON.parse(event.slice(6))).choices ?? []) {
        for (const call of choice.delta?.tool_calls ?? []) released += call.function?.arguments ?? "";
      }
    }
    return released;
  };
  /** Pushes one tool call and its finish event; returns everything the stream emitted. */
  const runCall = (token: string, name: string, args: string, finish = "tool_calls"): string => {
    const stream = new TradingToolStream(token);
    return stream.push(sse(callChunk(name, args))) + stream.push(sse(finishChunk(finish))) + stream.finish();
  };

  it("S1 half an event emits nothing, and ending there is an error", () => {
    const stream = new TradingToolStream(signToolContext(context()));
    expect(stream.push(Buffer.from('data: {"choices"'))).toBe("");
    expect(() => stream.finish()).toThrow("Incomplete trading tool stream");
  });

  it("S2 [DONE] while a tool call is still waiting for its finish event is an error", () => {
    const stream = new TradingToolStream(signToolContext(context()));
    stream.push(sse(callChunk("whiteboard_read", "{}")));
    expect(() => stream.push(Buffer.from("data: [DONE]\n\n"))).toThrow("Tool stream ended without a finish event");
  });

  it("S3 a call finished with stop is released with the context; one finished with content_filter is refused", () => {
    const token = signToolContext(context());
    expect(JSON.parse(releasedArguments(runCall(token, "whiteboard_read", "{}", "stop")))).toEqual({ [ARG]: token });
    expect(() => runCall(token, "whiteboard_read", "{}", "content_filter")).toThrow("Incomplete trading tool arguments");
  });

  it("S4 a call to a tool outside the allowed list, or to think even when listed, is refused at the finish event", () => {
    expect(() => runCall(signToolContext(context()), "buy_stock", "{}")).toThrow("unauthorized trading tool");
    const thinkAllowed = signToolContext({ ...context(), allowedTools: ["think"] });
    expect(() => runCall(thinkAllowed, "think", "{}")).toThrow("unauthorized trading tool");
  });

  it("S5 an allowed tool that is not served locally keeps its arguments and never receives the token", () => {
    const token = signToolContext({ ...context(), allowedTools: ["remote_only_tool_xyz"] });
    const output = runCall(token, "remote_only_tool_xyz", '{"q":"x"}');
    // The transform emits JSON whitespace while it buffers, so the fragments assemble to " {...}".
    expect(releasedArguments(output).trim()).toBe('{"q":"x"}');
    expect(output).not.toContain(token);
  });

  it("S6 an event over 2,000,000 characters and arguments over 1,000,000 characters are refused", () => {
    const token = signToolContext(context());
    expect(() => new TradingToolStream(token).push(Buffer.from(`data: ${"x".repeat(2_000_001)}`))).toThrow("Trading SSE event exceeds bound");
    expect(() => new TradingToolStream(token).push(sse(callChunk("whiteboard_write", "x".repeat(1_000_001))))).toThrow("Trading tool arguments exceed bound");
  });

  it("S7 content, keep-alive comments and [DONE] pass through byte for byte", () => {
    const stream = new TradingToolStream(signToolContext(context()));
    for (const input of [sse({ choices: [{ index: 0, delta: { content: "hi" } }] }), Buffer.from(": keepalive\n\n"), Buffer.from("data: [DONE]\n\n")]) {
      expect(stream.push(input)).toBe(input.toString());
    }
    expect(stream.finish()).toBe("");
  });

  it("S8 an event whose data is not JSON is an error", () => {
    expect(() => new TradingToolStream(signToolContext(context())).push(Buffer.from("data: {not json}\n\n"))).toThrow();
  });

  it("S9 a call that never sends arguments is released with the context as its only argument", () => {
    const token = signToolContext(context());
    const stream = new TradingToolStream(token);
    const output =
      stream.push(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "whiteboard_read" } }] } }] })) +
      stream.push(sse(finishChunk("tool_calls")));
    expect(JSON.parse(releasedArguments(output))).toEqual({ [ARG]: token });
  });

  it("S10 a context the model wrote into its own arguments is replaced and never forwarded", () => {
    const token = signToolContext(context());
    const output = runCall(token, "whiteboard_read", `{"${ARG}":"forged"}`);
    expect(JSON.parse(releasedArguments(output))).toEqual({ [ARG]: token });
    expect(output).not.toContain("forged");
  });

  it("S11 bindToolResponse leaves responses without tool calls as they are", () => {
    const token = signToolContext(context());
    expect(bindToolResponse({ id: "x" }, token)).toEqual({ id: "x", choices: [] });
    const noMessage = { choices: [{ index: 0, finish_reason: "stop" }] };
    expect(bindToolResponse(noMessage, token)).toEqual(noMessage);
    const noCalls = { choices: [{ index: 0, message: { role: "assistant", content: "hi" } }] };
    expect(bindToolResponse(noCalls, token)).toEqual(noCalls);
  });

  it("S11 bindToolResponse attaches the context to a local tool call", () => {
    const token = signToolContext(context());
    const bound = bindToolResponse({ choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "whiteboard_read", arguments: "{}" } }] } }] }, token);
    expect(JSON.parse(bound.choices[0].message.tool_calls[0].function.arguments)).toEqual({ [ARG]: token });
  });

  it("S12 bindRecoveredToolArgs binds only an allowed local tool, and rejects a tampered token", () => {
    const token = signToolContext({ ...context(), allowedTools: ["whiteboard_read", "think"] });
    const args = { ticker: "T" };
    expect(bindRecoveredToolArgs("buy_stock", args, token)).toBe(args);
    expect(bindRecoveredToolArgs("think", args, token)).toBe(args);
    expect(bindRecoveredToolArgs("whiteboard_read", args, token)).toEqual({ ticker: "T", [ARG]: token });
    expect(() => bindRecoveredToolArgs("whiteboard_read", args, tampered(token))).toThrow();
  });
});

describe("applyTradingToolProtocol", () => {
  const CONTRACT = "[TRADING TOOL EXECUTION CONTRACT v1]";
  const notice = "<iteration-limit>\nlimit\n</iteration-limit>";
  const tool = (name: string) => ({ type: "function", function: { name, parameters: { type: "object" } } });
  const twoTools = () => [tool("get_finnhub_news"), tool("get_upcoming_events")];

  it("P1 an empty request gets the contract as its only message and no tool fields", () => {
    const fixed = applyTradingToolProtocol({});
    expect(fixed.body.messages).toHaveLength(1);
    expect(fixed.body.messages[0].role).toBe("system");
    expect(fixed.body.messages[0].content.startsWith(CONTRACT)).toBe(true);
    expect(fixed.body).not.toHaveProperty("tools");
    expect(fixed).toMatchObject({ removedTools: 0, deniedTools: [], correctedAcknowledgements: 0, finalTurnDirected: false });
  });

  it("P2 a leading system message with array content is left alone; the contract goes in front of it", () => {
    const structured = { role: "system", content: [{ type: "text", text: "role" }] };
    const fixed = applyTradingToolProtocol({ messages: [structured] });
    expect(fixed.body.messages).toHaveLength(2);
    expect(fixed.body.messages[0].content.startsWith(CONTRACT)).toBe(true);
    expect(fixed.body.messages[1]).toBe(structured);
  });

  it("P3 only the first system message receives the contract", () => {
    const second = { role: "system", content: "later instructions" };
    const fixed = applyTradingToolProtocol({ messages: [{ role: "system", content: "role" }, second] });
    expect(fixed.body.messages[0].content.startsWith(CONTRACT)).toBe(true);
    expect(fixed.body.messages[1]).toBe(second);
  });

  it("P4 the MCP prefix does not matter on either side of the allowlist", () => {
    const prefixed = applyTradingToolProtocol({ tools: [tool(`${MCP}think`), tool(`${MCP}get_news`)] }, ["get_news"]);
    expect(prefixed.body.tools).toEqual([tool(`${MCP}get_news`)]);
    expect(prefixed).toMatchObject({ removedTools: 1, deniedTools: [] });

    expect(applyTradingToolProtocol({ tools: [tool("get_news")] }, [`${MCP}get_news`]).body.tools).toEqual([tool("get_news")]);
  });

  it("P5 a tool entry with no name is denied under an allowlist and kept without one", () => {
    const nameless = { type: "function" };
    expect(applyTradingToolProtocol({ tools: [nameless] }, []).deniedTools).toEqual(["unknown"]);
    expect(applyTradingToolProtocol({ tools: [nameless] }).body.tools[0]).toBe(nameless);
  });

  it("P6 a tool_choice naming a denied tool falls back to auto, or is dropped with the catalog when nothing is left", () => {
    const forced = (name: string) => ({ type: "function", function: { name } });
    const kept = applyTradingToolProtocol({ tools: [tool("execute_python"), tool("whiteboard_read")], tool_choice: forced("execute_python") }, ["whiteboard_read"]);
    expect(kept.body.tool_choice).toBe("auto");

    const emptied = applyTradingToolProtocol({ tools: [tool("execute_python")], tool_choice: forced("execute_python") }, ["whiteboard_read"]);
    expect(emptied.body).not.toHaveProperty("tools");
    expect(emptied.body).not.toHaveProperty("tool_choice");

    const allowed = applyTradingToolProtocol({ tools: [tool("execute_python"), tool("whiteboard_read")], tool_choice: forced("whiteboard_read") }, ["whiteboard_read"]);
    expect(allowed.body.tool_choice).toEqual(forced("whiteboard_read"));
  });

  it("P7 every think result in one turn is marked as an acknowledgement", () => {
    const think = (id: unknown) => ({ id, function: { name: "think", arguments: "{}" } });
    const fixed = applyTradingToolProtocol({
      messages: [
        { role: "assistant", tool_calls: [think("t1"), think("t2")] },
        { role: "tool", tool_call_id: "t1", content: "Acknowledged" },
        { role: "tool", tool_call_id: "t2", content: "Acknowledged" },
      ],
    });
    expect(fixed.correctedAcknowledgements).toBe(2);
    for (const message of fixed.body.messages.slice(2)) {
      expect(JSON.parse(message.content)).toMatchObject({ status: "reasoning_acknowledgement_only", research_executed: false });
    }
  });

  it("P7 a result is left alone when the think call's id is not a string, or when the result precedes the call", () => {
    const numericResult = { role: "tool", tool_call_id: 7, content: "Acknowledged" };
    const numeric = applyTradingToolProtocol({ messages: [{ role: "assistant", tool_calls: [{ id: 7, function: { name: "think" } }] }, numericResult] });
    expect(numeric.body.messages[2]).toBe(numericResult);
    expect(numeric.correctedAcknowledgements).toBe(0);

    const earlyResult = { role: "tool", tool_call_id: "t1", content: "Acknowledged" };
    const early = applyTradingToolProtocol({ messages: [earlyResult, { role: "assistant", tool_calls: [{ id: "t1", function: { name: "think" } }] }] });
    expect(early.body.messages[1]).toBe(earlyResult);
    expect(early.correctedAcknowledgements).toBe(0);
  });

  it("P8 the request passed in is not modified", () => {
    const body = {
      tools: [tool("think"), tool("get_news"), tool("execute_python")],
      tool_choice: { type: "function", function: { name: "think" } },
      messages: [
        { role: "system", content: "role" },
        { role: "assistant", tool_calls: [{ id: "t1", function: { name: "think", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "t1", content: "Acknowledged" },
        { role: "user", content: notice },
      ],
    };
    const before = JSON.stringify(body);
    applyTradingToolProtocol(body, ["get_news"], ["get_news"]);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("P9 TRADING_PARALLEL_TOOL_HINT=FALSE in upper case switches the hint off", () => {
    const request = () => ({ tools: twoTools(), messages: [{ role: "system", content: "role" }] });
    expect(applyTradingToolProtocol(request()).body.messages[0].content).toContain(PARALLEL_TOOL_HINT);
    vi.stubEnv("TRADING_PARALLEL_TOOL_HINT", "FALSE");
    expect(applyTradingToolProtocol(request()).body.messages[0].content).not.toContain(PARALLEL_TOOL_HINT);
  });

  it("P10 with no system message, the inserted one starts with the contract and ends with the hint", () => {
    const content: string = applyTradingToolProtocol({ tools: twoTools(), messages: [{ role: "user", content: "## Ticker: AMD" }] }).body.messages[0].content;
    expect(content.startsWith(CONTRACT)).toBe(true);
    expect(content.endsWith(`\n\n${PARALLEL_TOOL_HINT}`)).toBe(true);
  });

  it("P11 an opening-stack entry with the MCP prefix matches a tool offered without it", () => {
    const stack = [`${MCP}get_upcoming_events`, "get_finnhub_news"];
    const content: string = applyTradingToolProtocol({ tools: twoTools(), messages: [{ role: "system", content: "role" }] }, undefined, stack).body.messages[0].content;
    expect(content.endsWith(
      `${PARALLEL_TOOL_HINT}\nUsual opening bundle for this role (learned from past runs): ${MCP}get_upcoming_events, get_finnhub_news. ` +
        "They are keyed by the ticker; when you need them, call them together in your first response.",
    )).toBe(true);
  });

  it.each([
    ["the notice inside array content", { role: "user", content: [{ type: "text", text: notice }] }],
    ["the notice from the assistant", { role: "assistant", content: notice }],
    ["the notice as a tool result", { role: "tool", tool_call_id: "c1", content: notice }],
  ])("P12 %s is not a forced final turn", (_name, last) => {
    expect(applyTradingToolProtocol({ messages: [{ role: "system", content: "role" }, last] }).finalTurnDirected).toBe(false);
  });

  it("P12 an empty tool list with the notice is a forced final turn, and the empty list is not sent on", () => {
    const fixed = applyTradingToolProtocol({ tools: [], messages: [{ role: "system", content: "role" }, { role: "user", content: notice }] });
    expect(fixed.finalTurnDirected).toBe(true);
    expect(fixed.body).not.toHaveProperty("tools");
  });

  it("P12 no tool list with tool_choice none is a forced final turn, and tool_choice none is kept", () => {
    const fixed = applyTradingToolProtocol({ tool_choice: "none", messages: [{ role: "system", content: "role" }, { role: "user", content: notice }] });
    expect(fixed.finalTurnDirected).toBe(true);
    expect(fixed.body.tool_choice).toBe("none");
  });
});
