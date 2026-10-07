import { formatBytes } from "@rodrigo-barraza/utilities-library";
import logger from "../utils/logger.js";
import { requestContext } from "../utils/RequestContext.js";
/**
 * Express middleware that:
 *   1. Sets AsyncLocalStorage context (project, username, clientIp)
 *      so deep call-stack code (providers, services) can read it.
 *   2. Logs every completed request with identity, IP, method, path,
 *      status, timing, and transfer sizes.
 */
export function requestLoggerMiddleware(req, res, next) {
    const start = performance.now();
    // Resolve identity + IP early (before authMiddleware for admin/files routes)
    // Fall back to headers, then to path-based extraction for /files/projects/{project}/{username}/
    let project = req.project || req.headers["x-project"] || "any";
    let username = req.username || req.headers["x-username"] || "any";
    if (project === "any" && req.originalUrl.startsWith("/files/projects/")) {
        const segments = req.originalUrl.split("/");
        // /files/projects/{project}/{username}/...
        if (segments.length >= 5) {
            project = segments[3] || "any";
            username = segments[4]?.split("?")[0] || "any";
        }
    }
    const forwardedFor = req.headers["x-forwarded-for"];
    const forwardedIp = typeof forwardedFor === "string"
        ? forwardedFor.split(",")[0]?.trim()
        : null;
    const rawIp = req.clientIp || forwardedIp || req.ip || null;
    // Normalize IPv4-mapped IPv6 (::ffff:127.0.0.1 → 127.0.0.1)
    const clientIp = rawIp?.replace(/^::ffff:/, "") || rawIp;
    const agent = req.headers["x-agent"] || null;
    // Log on response finish
    res.on("finish", () => {
        // Skip SSE streaming requests — those are logged in detail by the route handlers
        const contentType = res.getHeader("content-type") || "";
        if (typeof contentType === "string" &&
            contentType.includes("text/event-stream"))
            return;
        // Skip binary audio streams — logged by route handler
        if (typeof contentType === "string" && contentType.includes("audio/"))
            return;
        const elapsed = performance.now() - start;
        // Re-read project/username in case authMiddleware set them after us
        const finalProject = req.project || project;
        const finalUsername = req.username || username;
        const finalIp = req.clientIp || clientIp;
        const method = req.method;
        const path = req.originalUrl;
        const status = res.statusCode;
        // Format timing
        const time = elapsed >= 1000
            ? `${(elapsed / 1000).toFixed(2)}s`
            : `${Math.round(elapsed)}ms`;
        // Request / response sizes (from headers — zero-cost)
        const inBytes = parseInt(req.headers["content-length"] || "0", 10);
        const outHeader = res.getHeader("content-length");
        const outBytes = parseInt(typeof outHeader === "string" ? outHeader : "0", 10);
        const totalBytes = inBytes + outBytes;
        const sizeTag = `(in: ${formatBytes(inBytes)}, out: ${formatBytes(outBytes)}, total: ${formatBytes(totalBytes)})`;
        logger.request(finalProject, finalUsername, finalIp, `${method} ${path} ${status} — ${time} ${sizeTag}`);
    });
    // Attach agent to req for downstream route handlers
    if (agent)
        req.agent = agent;
    // Run the rest of the middleware chain inside AsyncLocalStorage context
    requestContext.run({ project, username, clientIp, agent }, () => {
        next();
    });
}
//# sourceMappingURL=RequestLoggerMiddleware.js.map