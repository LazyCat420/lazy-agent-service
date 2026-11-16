import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireExecuteKey } from "../ExecuteRoutes.ts";
import { TOOL_CONTEXT_ARG, signToolContext } from "../../services/TradingToolContext.ts";

function run(headers: Record<string, string>, body: Record<string, unknown> = {}) {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const next = vi.fn();
  requireExecuteKey({ headers, body } as never, { status, json } as never, next);
  return { next, status };
}

function signedContext(): string {
  vi.stubEnv("TRADING_TOOL_CONTEXT_KEY", `tc_${crypto.randomBytes(12).toString("hex")}`);
  return signToolContext({
    project: "vllm-trading-bot",
    agentName: "audit-test",
    cycleId: "cycle-1",
    ticker: "AAPL",
    conversationId: "conv-1",
    allowedTools: ["buy_stock"],
    expiresAt: Date.now() + 60_000,
  });
}

afterEach(() => vi.unstubAllEnvs());

describe("fail-closed /execute key (audit D11, A10)", () => {
  it("closes the route with 503 when EXECUTE_API_KEY is unset", () => {
    const { next, status } = run({});
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(503);
  });

  it("still accepts a verified trading tool context while the key is unset", () => {
    const token = signedContext();
    expect(run({}, { [TOOL_CONTEXT_ARG]: token }).next).toHaveBeenCalled();
    expect(run({}, { arguments: { [TOOL_CONTEXT_ARG]: token } }).next).toHaveBeenCalled();
  });

  it("does not let a forged or expired context skip the key", () => {
    const token = signedContext();
    const forged = `${token.split(".")[0]}.${crypto.randomBytes(32).toString("base64url")}`;
    expect(run({}, { [TOOL_CONTEXT_ARG]: forged }).status).toHaveBeenCalledWith(503);
    expect(run({}, { [TOOL_CONTEXT_ARG]: "signed" }).status).toHaveBeenCalledWith(503);

    vi.stubEnv("EXECUTE_API_KEY", `auth_${crypto.randomBytes(12).toString("hex")}`);
    expect(run({}, { arguments: { [TOOL_CONTEXT_ARG]: forged } }).status).toHaveBeenCalledWith(401);
  });

  it("requires the key once configured", () => {
    const key = `auth_${crypto.randomBytes(12).toString("hex")}`;
    vi.stubEnv("EXECUTE_API_KEY", key);
    expect(run({}).status).toHaveBeenCalledWith(401);
    expect(run({ "x-api-key": "wrong" }).status).toHaveBeenCalledWith(401);
    expect(run({ "x-api-key": key }).next).toHaveBeenCalled();
    expect(run({ authorization: `Bearer ${key}` }).next).toHaveBeenCalled();
  });
});
