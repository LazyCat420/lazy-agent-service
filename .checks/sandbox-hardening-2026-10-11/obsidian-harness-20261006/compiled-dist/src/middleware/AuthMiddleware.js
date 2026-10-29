import { DEFAULT_USERNAME, DEFAULT_PROJECT, } from "@rodrigo-barraza/utilities-library/taxonomy";
import { requestContext } from "../utils/RequestContext.js";
/**
 * Express middleware that attaches x-project, x-username, and x-workspace-id
 * headers to the request object for downstream route handlers.
 */
export function authMiddleware(req, res, next) {
    // Single source of truth for project resolution.
    // Priority: query param → body → x-project header → DEFAULT_PROJECT
    req.project =
        req.query?.project ||
            req.body?.project ||
            req.headers["x-project"] ||
            DEFAULT_PROJECT;
    const forwardedFor = req.headers["x-forwarded-for"];
    const forwardedIp = typeof forwardedFor === "string"
        ? forwardedFor.split(",")[0]?.trim()
        : null;
    const rawIp = forwardedIp || req.ip || null;
    // Normalize IPv4-mapped IPv6 addresses (::ffff:127.0.0.1 → 127.0.0.1)
    req.clientIp = rawIp?.replace(/^::ffff:/, "") || rawIp || undefined;
    // Use x-username header when provided; otherwise fall back to DEFAULT_USERNAME.
    // Never use the raw client IP as the username — IPs in MinIO object keys
    // (e.g. projects/lupos/127.0.0.1/...) cause path duplication when the
    // same logical user is later identified by a proper username header.
    req.username = req.headers["x-username"] || DEFAULT_USERNAME;
    // Workspace ID for multi-workspace scoping (optional — null means default workspace)
    req.workspaceId = req.headers["x-workspace-id"] || undefined;
    // Workspace root path — absolute filesystem path selected by the user.
    // Takes precedence over workspaceId for routing agent tools to the correct directory.
    req.workspaceRoot = req.headers["x-workspace-root"] || undefined;
    // Update AsyncLocalStorage context with auth-resolved values
    const store = requestContext.getStore();
    if (store) {
        store.project = req.project || DEFAULT_PROJECT;
        store.username = req.username || DEFAULT_USERNAME;
        store.clientIp = req.clientIp || null;
        store.workspaceId = req.workspaceId || null;
        store.workspaceRoot = req.workspaceRoot || null;
    }
    next();
}
//# sourceMappingURL=AuthMiddleware.js.map