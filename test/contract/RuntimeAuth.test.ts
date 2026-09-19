import crypto from "node:crypto";
import { afterEach, it, expect, vi } from "vitest";
import { runtimeAuth } from "../../src/middleware/RuntimeAuth.ts";
afterEach(() => vi.unstubAllEnvs());
it("authenticates internal callers and fails closed without credentials", () => {
  const credential = crypto.randomBytes(32).toString("hex");
  vi.stubEnv("RUNTIME_API_TOKEN", credential);
  const next = vi.fn();
  const response: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  runtimeAuth({ get: () => undefined } as any, response, next);
  expect(response.status).toHaveBeenCalledWith(401);
  expect(next).not.toHaveBeenCalled();
  runtimeAuth({ get: () => credential } as any, response, next);
  expect(next).toHaveBeenCalledOnce();
});
