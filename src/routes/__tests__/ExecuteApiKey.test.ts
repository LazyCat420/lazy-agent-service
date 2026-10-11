import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireExecuteKey } from "../ExecuteRoutes.ts";

function run(headers: Record<string, string>, body: Record<string, unknown> = {}) {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const next = vi.fn();
  requireExecuteKey({ headers, body } as never, { status, json } as never, next);
  return { next, status };
}

afterEach(() => vi.unstubAllEnvs());

describe("optional /execute key (audit D11)", () => {
  it("stays open when EXECUTE_API_KEY is unset", () => {
    expect(run({}).next).toHaveBeenCalled();
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
