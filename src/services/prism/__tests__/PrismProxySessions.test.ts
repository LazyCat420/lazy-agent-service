import { afterEach, describe, expect, it } from "vitest";
import { PrismProxyService } from "../PrismProxyService.ts";

afterEach(() => PrismProxyService.__resetForTests());

describe("prism-proxy session whitelists survive a restart (audit D11 fail-open)", () => {
  it("enforces a registered whitelist after the in-memory registry is lost", async () => {
    PrismProxyService.registerSession("cycle-restart", ["get_market_data"]);
    expect(PrismProxyService.isToolAllowed("cycle-restart", "mcp__lazy-agent-service__run_backtest")).toBe(false);
    await PrismProxyService.__flushForTests();

    PrismProxyService.__resetForTests(); // simulates a service restart
    expect(PrismProxyService.isToolAllowed("cycle-restart", "run_backtest")).toBe(false);
    expect(PrismProxyService.isToolAllowed("cycle-restart", "get_market_data")).toBe(true);
  });

  it("does not restrict conversations that never went through the proxy", () => {
    expect(PrismProxyService.isToolAllowed("plain-agent-conversation", "web_search")).toBe(true);
  });
});
