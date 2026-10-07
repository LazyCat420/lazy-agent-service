/**
 * Our forced final turn must be one the vLLM shim recognises and directs.
 *
 * prism tags its iteration-limit notice `<iteration-limit>`; the shim's
 * TradingToolProtocol keys on that tag (with no callable tool) to append
 * FINAL_TURN_DIRECTIVE, which turned nemotron's empty wall answers into
 * artifacts (43/44 on stored turns). The boundary probe's forced_final_turn
 * contract, run through our native loop on 2026-10-07, found our notice
 * untagged: the turn was never directed.
 */
import { describe, expect, it } from "vitest";

import { iterationLimitNotice } from "../lifecycle/ExhaustionRecovery.ts";
import { applyTradingToolProtocol, FINAL_TURN_DIRECTIVE } from "../../TradingToolProtocol.ts";
import PromptLocaleService from "../../PromptLocaleService.ts";

const message = PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "harness.exhaustionRecovery.message");
const conversation = (last: { role: string; content: string }) => ({
  model: "m",
  messages: [{ role: "system", content: "role prompt" }, { role: "user", content: "## Ticker: COF" }, last],
});

describe("the forced final turn", () => {
  it("is tagged the way prism tags it", () => {
    expect(iterationLimitNotice("stop now")).toBe("<iteration-limit>\n\nstop now\n\n</iteration-limit>");
  });

  it.each(["system", "user"])("is directed by the shim as a %s message (the Qwen rewrite demotes it to user)", (role) => {
    const result = applyTradingToolProtocol(conversation({ role, content: iterationLimitNotice(message) }), ["get_market_data"]);
    expect(result.finalTurnDirected).toBe(true);
    const last = result.body.messages[result.body.messages.length - 1];
    expect(last.content).toContain(FINAL_TURN_DIRECTIVE);
  });

  it("was not directed untagged (the defect)", () => {
    const result = applyTradingToolProtocol(conversation({ role: "system", content: message }), ["get_market_data"]);
    expect(result.finalTurnDirected).toBe(false);
  });
});
