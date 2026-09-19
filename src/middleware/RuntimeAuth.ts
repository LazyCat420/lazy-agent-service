import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

/** Trusted application backends may assert project/user identity; browsers may not. */
export function runtimeAuth(req: Request, res: Response, next: NextFunction): void {
  const configured = process.env.RUNTIME_API_TOKEN || process.env.RUNTIME_AUTH_SECRET || process.env.INTERNAL_EXECUTE_TOKEN;
  if (!configured) { res.status(503).json({ error: { code: "RUNTIME_AUTH_UNAVAILABLE" } }); return; }
  const supplied = req.get("x-runtime-token");
  const expected = Buffer.from(configured);
  const actual = Buffer.from(supplied || "");
  if (!supplied || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    res.status(401).json({ error: { code: "RUNTIME_UNAUTHORIZED" } }); return;
  }
  next();
}
