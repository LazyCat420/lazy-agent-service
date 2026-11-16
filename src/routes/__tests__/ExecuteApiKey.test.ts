import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireExecuteKey } from "../ExecuteRoutes.ts";
import { TOOL_CONTEXT_ARG } from "../../services/TradingToolContext.ts";

function run(headers: Record<string, string>, body: Record<string, unknown> = {}) {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const next = vi.fn();
  requireExecuteKey({ headers, body } as never, { status, json } as never, next);
  return { next, status };
}

afterEach(() => vi.unstubAllEnvs());

describe("fail-closed /execute key (audit D11, A10)", () => {
  it("closes the route with 503 when EXECUTE_API_KEY is unset", () => {
    const { next, status } = run({});
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(503);
  });

  it("still accepts a signed trading tool context while the key is unset", () => {
    expect(run({}, { [TOOL_CONTEXT_ARG]: "signed" }).next).toHaveBeenCalled();
    expect(run({}, { arguments: { [TOOL_CONTEXT_ARG]: "signed" } }).next).toHaveBeenCalled();
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
