import {
  DEFAULT_USERNAME,
  DEFAULT_PROJECT,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { Request, Response, NextFunction } from "express";
import { requestContext } from "../utils/RequestContext.ts";

/** Priority: query param → body → x-project header → DEFAULT_PROJECT. */
function resolveProject(req: Request): string {
  return (
    (req.query?.project as string) ||
    req.body?.project ||
    (req.headers["x-project"] as string) ||
    DEFAULT_PROJECT
  );
}

/** Prefer the first x-forwarded-for hop; normalize IPv4-mapped IPv6 addresses. */
function resolveClientIp(req: Request): string | undefined {
  const forwardedFor = req.headers["x-forwarded-for"];
  const forwardedIp =
    typeof forwardedFor === "string" ? forwardedFor.split(",")[0]?.trim() : null;
  const rawIp = forwardedIp || req.ip || null;
  return rawIp?.replace(/^::ffff:/, "") || rawIp || undefined;
}

/** Mirror the auth-resolved values into the AsyncLocalStorage request context. */
function applyToRequestContext(req: Request): void {
  const store = requestContext.getStore();
  if (!store) return;
  store.project = req.project || DEFAULT_PROJECT;
  store.username = req.username || DEFAULT_USERNAME;
  store.clientIp = req.clientIp || null;
  store.workspaceId = req.workspaceId || null;
  store.workspaceRoot = req.workspaceRoot || null;
}

/**
 * Express middleware that attaches x-project, x-username, and x-workspace-id
 * headers to the request object for downstream route handlers.
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // Single source of truth for project resolution.
  req.project = resolveProject(req);

  // Normalize IPv4-mapped IPv6 addresses (::ffff:127.0.0.1 → 127.0.0.1)
  req.clientIp = resolveClientIp(req);

  // Use x-username header when provided; otherwise fall back to DEFAULT_USERNAME.
  // Never use the raw client IP as the username — IPs in MinIO object keys
  // (e.g. projects/lupos/127.0.0.1/...) cause path duplication when the
  // same logical user is later identified by a proper username header.
  req.username = (req.headers["x-username"] as string) || DEFAULT_USERNAME;

  // Workspace ID for multi-workspace scoping (optional — null means default workspace)
  req.workspaceId = (req.headers["x-workspace-id"] as string) || undefined;

  // Workspace root path — absolute filesystem path selected by the user.
  // Takes precedence over workspaceId for routing agent tools to the correct directory.
  req.workspaceRoot = (req.headers["x-workspace-root"] as string) || undefined;

  // Update AsyncLocalStorage context with auth-resolved values
  applyToRequestContext(req);

  next();
}
