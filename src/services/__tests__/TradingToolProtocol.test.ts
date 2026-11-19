import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { PromotionController } from "../PromotionController.ts";
import {
  applyTradingToolProtocol,
  FINAL_TURN_DIRECTIVE,
  INTERLOCK_MARKER,
  isTradingToolErrorContent,
  NATIVE_EXHAUSTION_PREFIX,
  PARALLEL_TOOL_HINT,
  openingStackLine,
  registerShimInterlockConfig,
  resolveActiveShimInterlock,
  tradingShimProfileId,
} from "../TradingToolProtocol.ts";

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

  it("directs the forced turn as prism sends it since 2026-09-27: tools kept, tool_choice none, a system notice", () => {
    // The tools stay byte-stable for the prompt cache and calling is switched off instead
    // (cycle-v3-1790602200 CRH v3_junior_analyst, 22nd message), and the notice arrives as a
    // system message: the shim's rewriteMessages demotes it to user only AFTER this protocol
    // (lazy-agent-service log on the verification run: "demoted 2 non-leading system message(s)"
    // on the wall turn, 1 on every other turn).
    const systemNotice = () => {
      const turn = wallTurn();
      turn.messages[3] = { role: "system", content: notice };
      return { ...turn, tools: [tool("get_market_data")], tool_choice: "none" };
    };
    for (const body of [systemNotice(), { ...wallTurn(), tools: [tool("get_market_data")], tool_choice: "none" }]) {
      const fixed = applyTradingToolProtocol(body, ["get_market_data"]);
      expect(fixed.finalTurnDirected).toBe(true);
      expect(fixed.body.messages[3].content).toBe(notice + "\n" + FINAL_TURN_DIRECTIVE);
      expect(fixed.body.messages[3].role).toBe(body.messages[3].role);
      expect(fixed.body.tools).toEqual([tool("get_market_data")]);
      expect(fixed.body.tool_choice).toBe("none");
    }
  });

  it("does not direct an earlier system message that merely quotes the notice", () => {
    const body = wallTurn();
    body.messages.splice(1, 0, { role: "system", content: "Earlier: " + notice } as any);
    body.messages.push({ role: "assistant", content: "{}" } as any);
    expect(applyTradingToolProtocol(body).finalTurnDirected).toBe(false);
  });

  it("leaves a wall notice alone while a tool can still be called", () => {
    for (const tool_choice of [undefined, "auto", "required"]) {
      const body = { ...wallTurn(), tools: [tool("get_market_data")], ...(tool_choice && { tool_choice }) };
      expect(applyTradingToolProtocol(body, ["get_market_data"]).finalTurnDirected).toBe(false);
    }
  });

  it("leaves ordinary tool-less requests alone", () => {
    const fixed = applyTradingToolProtocol({ messages: [{ role: "system", content: "role" }, { role: "user", content: "## Ticker: NSC" }] });
    expect(fixed.finalTurnDirected).toBe(false);
    expect(fixed.body.messages[1].content).toBe("## Ticker: NSC");
  });
});

describe("parallel tool-call hint", () => {
  const body = () => ({ tools: [tool("get_finnhub_news"), tool("get_upcoming_events")],
    messages: [{ role: "system", content: "role instructions" }, { role: "user", content: "## Ticker: AMD" }] });
  afterEach(() => { delete process.env.TRADING_PARALLEL_TOOL_HINT; });

  it("ends the system message with the hint so every turn of a run shares one prefix", () => {
    const first = applyTradingToolProtocol(body(), ["get_finnhub_news", "get_upcoming_events"]).body.messages[0].content;
    const later = applyTradingToolProtocol({ ...body(), messages: [...body().messages,
      { role: "assistant", tool_calls: [{ id: "a", function: { name: "get_finnhub_news", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "a", content: "news" }] }, ["get_finnhub_news", "get_upcoming_events"]).body.messages[0].content;
    expect(first.endsWith("role instructions\n\n" + PARALLEL_TOOL_HINT)).toBe(true);
    expect(later).toBe(first);
  });

  it("is absent when one or no tool can be called, and when switched off", () => {
    expect(applyTradingToolProtocol(body(), ["get_finnhub_news"]).body.messages[0].content).not.toContain(PARALLEL_TOOL_HINT);
    expect(applyTradingToolProtocol(body(), []).body.messages[0].content).not.toContain(PARALLEL_TOOL_HINT);
    process.env.TRADING_PARALLEL_TOOL_HINT = "false";
    expect(applyTradingToolProtocol(body()).body.messages[0].content).not.toContain(PARALLEL_TOOL_HINT);
  });

  it("names the learned opening stack only for tools the request can call", () => {
    const stack = ["get_upcoming_events", "get_finnhub_news", "get_institutional_holdings"];
    const content = applyTradingToolProtocol(body(), ["get_finnhub_news", "get_upcoming_events"], stack).body.messages[0].content;
    expect(content.endsWith(PARALLEL_TOOL_HINT + "\n" + openingStackLine(["get_upcoming_events", "get_finnhub_news"]))).toBe(true);
    expect(applyTradingToolProtocol(body(), ["get_finnhub_news"], stack).body.messages[0].content).not.toContain("opening bundle");
  });
});

describe("promoted completion & tool-retry interlock (WI-3, TC-3)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    delete process.env.PROMOTION_INTERLOCK_STORE_PATH;
    delete process.env.TRADING_SHIM_INTERLOCK;
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  const isolatePromotion = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-interlock-test-"));
    tmpDirs.push(dir);
    process.env.PROMOTION_INTERLOCK_STORE_PATH = path.join(dir, "shim_interlocks.json");
    (PromotionController as unknown as { state: Map<string, unknown> }).state = new Map();
    (PromotionController as unknown as { initialized: boolean }).initialized = false;
    (PromotionController as unknown as { storePath: string }).storePath = path.join(dir, "promo.json");
  };

  it("TC-3: keeps outgoing payload byte-identical when no active promotion exists", () => {
    isolatePromotion();
    const profileId = tradingShimProfileId("v3_quant_analyst", "qwen");
    registerShimInterlockConfig(profileId, {
      version: "1.0.0",
      maxConsecutiveToolErrors: 2,
      turnWarnThreshold: 6,
      matchNativeExhaustionNotice: true,
    });
    // Registered in shadow only (not active): resolveActiveShimInterlock must return null.
    PromotionController.register(profileId, "1.0.0", "shadow");
    expect(resolveActiveShimInterlock("v3_quant_analyst", "Qwen3.8-Flash-Next")).toBeNull();

    const payload = {
      tools: [tool("get_polygon_price_history"), tool("run_equation")],
      messages: [
        { role: "system", content: "quant role" },
        { role: "user", content: "## Ticker: CVI" },
        { role: "assistant", content: null, tool_calls: [{ id: "e1", function: { name: "run_equation", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "e1", content: "Equation execution failed: TypeError: float() argument must be a real number, not 'dict'" },
        { role: "assistant", content: null, tool_calls: [{ id: "e2", function: { name: "run_equation", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "e2", content: "Equation execution failed: TypeError: float() argument must be a real number, not 'dict'" },
      ],
    };
    const baseline = applyTradingToolProtocol(payload, ["get_polygon_price_history", "run_equation"]);
    const withInactive = applyTradingToolProtocol(
      payload,
      ["get_polygon_price_history", "run_equation"],
      [],
      resolveActiveShimInterlock("v3_quant_analyst", "Qwen3.8-Flash-Next"),
    );
    const hash = (x: unknown) => crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
    expect(hash(withInactive.body)).toBe(hash(baseline.body));
    expect(withInactive.interlockFired).toBeNull();
  });

  it("fires single-shot tool-retry and native-exhaustion directives only after PromotionController reaches active, preserving earlier KV prefix", () => {
    isolatePromotion();
    const profileId = tradingShimProfileId("v3_quant_analyst", "qwen");
    const cfg = {
      version: "1.1.0",
      maxConsecutiveToolErrors: 2,
      turnWarnThreshold: 6,
      matchNativeExhaustionNotice: true,
      toolErrorHint: "Return scalar or flat string values in run_equation, never nested dicts.",
    };
    registerShimInterlockConfig(profileId, cfg);
    PromotionController.register(profileId, "1.1.0");
    const verdict = { outcome: "improved" as const, delta: 0.25, ciLower: 0.08, ciUpper: 0.42 };
    PromotionController.transition({ profileId, version: "1.1.0", from: "offline_candidate", to: "shadow", reason: "s", experiment: verdict });
    PromotionController.transition({ profileId, version: "1.1.0", from: "shadow", to: "canary_5", reason: "c5", experiment: verdict });
    PromotionController.transition({ profileId, version: "1.1.0", from: "canary_5", to: "canary_25", reason: "c25", experiment: verdict });
    PromotionController.transition({ profileId, version: "1.1.0", from: "canary_25", to: "active", reason: "go", experiment: verdict });

    const active = resolveActiveShimInterlock("v3_quant_analyst", "Qwen3.8-Flash-Next");
    expect(active?.version).toBe("1.1.0");
    // DeepSeek is unaffected by Qwen's family-scoped profile.
    expect(resolveActiveShimInterlock("v3_quant_analyst", "DeepSeek-V4.1-Flash-1017")).toBeNull();

    const turn1Messages = [
      { role: "system", content: "quant role" },
      { role: "user", content: "## Ticker: CVI" },
      { role: "assistant", content: null, tool_calls: [{ id: "p1", function: { name: "get_polygon_price_history", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "p1", content: '{"price_rows":252}' },
    ];
    const r1 = applyTradingToolProtocol(
      { tools: [tool("get_polygon_price_history"), tool("run_equation")], messages: turn1Messages },
      ["get_polygon_price_history", "run_equation"],
      [],
      active,
    );
    expect(r1.interlockFired).toBeNull();

    const turn3Messages = [
      ...turn1Messages,
      { role: "assistant", content: null, tool_calls: [{ id: "e1", function: { name: "run_equation", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "e1", content: "Equation execution failed: TypeError: not 'dict'" },
      { role: "assistant", content: null, tool_calls: [{ id: "e2", function: { name: "run_equation", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "e2", content: "Equation execution failed: TypeError: not 'dict'" },
    ];
    const r3 = applyTradingToolProtocol(
      { tools: [tool("get_polygon_price_history"), tool("run_equation")], messages: turn3Messages },
      ["get_polygon_price_history", "run_equation"],
      [],
      active,
    );
    expect(r3.interlockFired).toBe("tool-retry");
    expect(r3.interlockVersion).toBe("1.1.0");
    // KV-cache prefix invariant: messages[0..3] are byte-identical to turn 1!
    expect(r3.body.messages.slice(0, 4)).toEqual(r1.body.messages.slice(0, 4));
    expect(r3.body.messages[r3.body.messages.length - 1].content).toContain(`${INTERLOCK_MARKER} [tool-retry]`);
    expect(r3.body.messages[r3.body.messages.length - 1].content).toContain("never nested dicts");

    // Native CoreLoop final-pass notice (`CoreLoop.ts` `FINAL_PASS_INSTRUCTION`) is also directed to emit JSON artifact.
    const nativeWall = applyTradingToolProtocol(
      {
        tools: [tool("run_equation")],
        tool_choice: "none",
        messages: [
          ...turn1Messages,
          { role: "user", content: `${NATIVE_EXHAUSTION_PREFIX} Answer the user now using only the information already gathered.` },
        ],
      },
      ["run_equation"],
      [],
      active,
    );
    expect(nativeWall.finalTurnDirected).toBe(true);
    expect(nativeWall.interlockFired).toBe("final-turn");
    expect(nativeWall.body.messages[nativeWall.body.messages.length - 1].content).toContain(FINAL_TURN_DIRECTIVE);
  });

  it("fires tool-retry and turn-budget notices strictly once across unmodified client history, ignores prose error words, and refuses mutating registered interlock versions", () => {
    isolatePromotion();
    const profileId = tradingShimProfileId("v3_quant_analyst", "qwen");
    const cfg = {
      version: "2.0.0",
      maxConsecutiveToolErrors: 2,
      turnWarnThreshold: 3,
      toolErrorHint: "Emit scalar output.",
    };
    registerShimInterlockConfig(profileId, cfg);
    // Idempotent re-registration of identical config is allowed; mutating the config under the same version throws!
    expect(() => registerShimInterlockConfig(profileId, { ...cfg })).not.toThrow();
    expect(() =>
      registerShimInterlockConfig(profileId, { ...cfg, maxConsecutiveToolErrors: 5 }),
    ).toThrow(/Refusing to overwrite immutable shim interlock config/);

    // Error classifier ignores prose "standard error" / "tracking error" and JSON `{"error": null}`.
    expect(isTradingToolErrorContent('{"error": null, "tracking_error": 0.02, "note": "standard error 1.1%"}')).toBe(false);
    expect(isTradingToolErrorContent("Finnhub article: margin of error narrows in Q4 guidance")).toBe(false);
    expect(isTradingToolErrorContent('{"error": "Upstream timeout", "is_error": true}')).toBe(true);
    expect(isTradingToolErrorContent("Equation execution failed: TypeError: not 'dict'")).toBe(true);

    // Client resends unmodified history (without INTERLOCK_MARKER) on Turn N+1: notice fires at count===2, NOT at count===3!
    const clientMsgsTurn2 = [
      { role: "system", content: "quant role" },
      { role: "user", content: "## Ticker: CVI" },
      { role: "assistant", content: null, tool_calls: [{ id: "e1", function: { name: "run_equation", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "e1", content: "Equation execution failed: TypeError: 1" },
      { role: "assistant", content: null, tool_calls: [{ id: "e2", function: { name: "run_equation", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "e2", content: "Equation execution failed: TypeError: 2" },
    ];
    const atCrossing = applyTradingToolProtocol(
      { tools: [tool("run_equation"), tool("get_polygon_price_history")], messages: clientMsgsTurn2 },
      ["run_equation", "get_polygon_price_history"],
      [],
      cfg,
    );
    expect(atCrossing.interlockFired).toBe("tool-retry");

    const clientMsgsTurn3 = [
      ...clientMsgsTurn2, // client's unmodified messages (no INTERLOCK_MARKER)
      { role: "assistant", content: null, tool_calls: [{ id: "e3", function: { name: "run_equation", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "e3", content: "Equation execution failed: TypeError: 3" },
    ];
    const afterCrossing = applyTradingToolProtocol(
      { tools: [tool("run_equation"), tool("get_polygon_price_history")], messages: clientMsgsTurn3 },
      ["run_equation", "get_polygon_price_history"],
      [],
      cfg,
    );
    expect(afterCrossing.interlockFired).toBeNull();
    expect(afterCrossing.body.messages[afterCrossing.body.messages.length - 1].content).not.toContain(INTERLOCK_MARKER);

    // Turn-budget fires strictly at assistantTurns === 3 (not 4) and counts JSON `{"error": null}` as a valid read!
    const budgetMsgs3 = [
      { role: "system", content: "quant role" },
      { role: "user", content: "## Ticker: CVI" },
      { role: "assistant", content: null, tool_calls: [{ id: "r1", function: { name: "get_polygon_price_history", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "r1", content: '{"error": null, "tracking_error": 0.03}' },
      { role: "assistant", content: null, tool_calls: [{ id: "r2", function: { name: "get_polygon_price_history", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "r2", content: '{"price_rows": 252}' },
      { role: "assistant", content: null, tool_calls: [{ id: "r3", function: { name: "get_polygon_price_history", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "r3", content: '{"price_rows": 252}' },
    ];
    const b3 = applyTradingToolProtocol(
      { tools: [tool("run_equation"), tool("get_polygon_price_history")], messages: budgetMsgs3 },
      ["run_equation", "get_polygon_price_history"],
      [],
      cfg,
    );
    expect(b3.interlockFired).toBe("turn-budget");

    const budgetMsgs4 = [
      ...budgetMsgs3,
      { role: "assistant", content: null, tool_calls: [{ id: "r4", function: { name: "get_polygon_price_history", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "r4", content: '{"price_rows": 252}' },
    ];
    const b4 = applyTradingToolProtocol(
      { tools: [tool("run_equation"), tool("get_polygon_price_history")], messages: budgetMsgs4 },
      ["run_equation", "get_polygon_price_history"],
      [],
      cfg,
    );
    expect(b4.interlockFired).toBeNull();
  });
});
