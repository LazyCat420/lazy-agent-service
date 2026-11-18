import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import logger from "../utils/logger.ts";

const scopeSchema = z.object({
  app_id: z.string().min(1).max(128), username: z.string().min(1).max(128),
  session_id: z.string().min(1).max(256), profile_id: z.string().min(1).max(128),
  expires_at: z.number().int().positive(), nonce: z.string().uuid(),
}).strict();
export type RuntimeScope = z.infer<typeof scopeSchema>;
export const runtimeSecret = () => process.env.RUNTIME_API_TOKEN || process.env.RUNTIME_AUTH_SECRET || process.env.INTERNAL_EXECUTE_TOKEN;
/** Env vars that may supply the runtime credential, in priority order. */
export const RUNTIME_TOKEN_SOURCES = ["RUNTIME_API_TOKEN", "RUNTIME_AUTH_SECRET", "INTERNAL_EXECUTE_TOKEN"] as const;
const sign = (value: string) => crypto.createHmac("sha256", runtimeSecret()!).update(`runtime-session.v1:${value}`).digest("base64url");
const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** Minted only by a trusted backend after application authentication. Never send the signing key to a desktop. */
export function issueRuntimeSession(scope: Omit<RuntimeScope, "nonce">): string {
  if (!runtimeSecret()) throw new Error("Runtime authentication unavailable");
  if (scope.expires_at <= Date.now() || scope.expires_at > Date.now() + 24 * 3600000) throw new Error("Session expiry must be within 24 hours");
  const payload = Buffer.from(JSON.stringify(scopeSchema.parse({ ...scope, nonce: crypto.randomUUID() }))).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
export function getRuntimeScope(res: Response): RuntimeScope | undefined { return res.locals.runtimeScope; }
export function scopeOwnsRun(res: Response, run: { session_id?: string; profile_id: string }): boolean {
  const scope = getRuntimeScope(res);
  return !scope || (run.session_id === scope.session_id && run.profile_id === scope.profile_id);
}

/** Trusted backends assert identity; scoped desktop sessions have identity fixed by their signature. */
export function runtimeAuth(req: Request, res: Response, next: NextFunction): void {
  const configured = runtimeSecret();
  if (!configured) { res.status(503).json({ error: { code: "RUNTIME_AUTH_UNAVAILABLE" } }); return; }
  const supplied = req.get("x-runtime-token");
  if (supplied && equal(configured, supplied)) { res.locals.runtimeBackend = true; next(); return; }
  // The auth scheme is case-insensitive (RFC 9110 §11.1); the token itself is still verified below.
  const bearer = req.get("authorization")?.replace(/^Bearer /i, "");
  if (bearer && bearer.length < 4096) {
    const [payload, signature, extra] = bearer.split(".");
    try {
      if (extra || !payload || !signature || !equal(sign(payload), signature)) throw new Error("Invalid session");
      const scope = scopeSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
      if (scope.expires_at <= Date.now()) throw new Error("Session expired");
      req.project = scope.app_id; req.username = scope.username;
      res.locals.runtimeScope = scope;
      next(); return;
    } catch { /* Never include submitted credentials in errors. */ }
  }
  res.status(401).json({ error: { code: "RUNTIME_UNAUTHORIZED" } });
}

/** Loopback and the NAS host itself: peers allowed to fall back to identity headers on reads. */
const DEFAULT_TRUSTED_INTERNAL_IPS = ["127.0.0.1", "::1", "10.0.0.16"] as const;

/**
 * Read-only routes that first-party UIs (prism-client) call with identity
 * headers only. A request that presents a token is authenticated exactly like
 * `runtimeAuth`; a request with no token at all is accepted only from a trusted
 * peer address and logged, so the UI keeps working while mutations,
 * `/harness2/run` and `/execute` stay token-only. Extend with
 * `TRUSTED_INTERNAL_IPS` (comma-separated).
 */
export function runtimeAuthOrTrustedPeer(req: Request, res: Response, next: NextFunction): void {
  if (req.get("x-runtime-token") || req.get("authorization")) {
    runtimeAuth(req, res, next);
    return;
  }
  const trustedIps = new Set<string>([
    ...DEFAULT_TRUSTED_INTERNAL_IPS,
    ...(process.env.TRUSTED_INTERNAL_IPS || "").split(",").map((ip) => ip.trim()).filter(Boolean),
  ]);
  const peer = (req.ip || "").replace(/^::ffff:/, "");
  if (trustedIps.has(peer)) {
    logger.info(`[RuntimeAuth] identity-only trusted-peer ${peer} on ${req.method} ${req.originalUrl}`);
    next();
    return;
  }
  res.status(401).json({ error: { code: "RUNTIME_UNAUTHORIZED" } });
}
