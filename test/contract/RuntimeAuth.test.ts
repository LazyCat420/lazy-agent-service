import crypto from "node:crypto";
import type { Request, Response } from "express";
import { afterEach, it, expect, vi } from "vitest";
import { runtimeAuth, runtimeAuthOrTrustedPeer, issueRuntimeSession, scopeOwnsRun } from "../../src/middleware/RuntimeAuth.ts";
afterEach(() => vi.unstubAllEnvs());
it("authenticates internal callers and fails closed without credentials", () => {
  const credential = crypto.randomBytes(32).toString("hex");
  vi.stubEnv("RUNTIME_API_TOKEN", credential);
  const next = vi.fn();
  const response: any = { locals: {}, status: vi.fn().mockReturnThis(), json: vi.fn() };
  runtimeAuth({ get: () => undefined } as any, response, next);
  expect(response.status).toHaveBeenCalledWith(401);
  expect(next).not.toHaveBeenCalled();
  runtimeAuth({ get: () => credential } as any, response, next);
  expect(next).toHaveBeenCalledOnce();
});

it("pins desktop identity and resource scope and rejects tampered or expired sessions", () => {
  vi.stubEnv("RUNTIME_API_TOKEN", crypto.randomBytes(32).toString("hex"));
  const scope = { app_id: "obsidian", username: "fixture", session_id: "vault-session", profile_id: "obsidian-vault-v1", expires_at: Date.now() + 60000 };
  const bearer = issueRuntimeSession(scope);
  const req: any = { project: "trading", username: "forged", get: (name: string) => name === "authorization" ? `Bearer ${bearer}` : undefined };
  const res: any = { locals: {}, status: vi.fn().mockReturnThis(), json: vi.fn() };
  const next = vi.fn(); runtimeAuth(req, res, next);
  expect(next).toHaveBeenCalledOnce();
  expect(req.project).toBe("obsidian"); expect(req.username).toBe("fixture");
  expect(scopeOwnsRun(res, { session_id: scope.session_id, profile_id: scope.profile_id })).toBe(true);
  expect(scopeOwnsRun(res, { session_id: "another-vault", profile_id: scope.profile_id })).toBe(false);
  req.get = () => `Bearer ${bearer}x`; runtimeAuth(req, res, next);
  expect(next).toHaveBeenCalledOnce(); expect(res.status).toHaveBeenCalledWith(401);
  expect(() => issueRuntimeSession({ ...scope, expires_at: Date.now() - 1 })).toThrow();
});

it("lets a trusted peer read with identity headers only, and rejects everyone else [A9]", () => {
  const next = vi.fn();
  // Test doubles stand in for Express objects; only the fields the guard reads exist.
  const res = { locals: {}, status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
  const read = (ip: string) =>
    ({ ip, method: "GET", originalUrl: "/custom-agents", get: () => undefined }) as unknown as Request;

  runtimeAuthOrTrustedPeer(read("127.0.0.1"), res, next);
  runtimeAuthOrTrustedPeer(read("::ffff:127.0.0.1"), res, next);
  runtimeAuthOrTrustedPeer(read("10.0.0.16"), res, next);
  expect(next).toHaveBeenCalledTimes(3);

  runtimeAuthOrTrustedPeer(read("10.0.0.99"), res, next);
  expect(res.status).toHaveBeenLastCalledWith(401);

  // A presented token is always verified; a trusted address never substitutes for it.
  vi.stubEnv("RUNTIME_API_TOKEN", crypto.randomBytes(32).toString("hex"));
  runtimeAuthOrTrustedPeer({ ip: "127.0.0.1", method: "GET", originalUrl: "/custom-agents", get: () => "wrong" } as unknown as Request, res, next);
  expect(res.status).toHaveBeenLastCalledWith(401);
  expect(next).toHaveBeenCalledTimes(3);
});
