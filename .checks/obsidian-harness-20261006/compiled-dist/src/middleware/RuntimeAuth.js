import crypto from "node:crypto";
import { z } from "zod";
const scopeSchema = z.object({
    app_id: z.string().min(1).max(128), username: z.string().min(1).max(128),
    session_id: z.string().min(1).max(256), profile_id: z.string().min(1).max(128),
    expires_at: z.number().int().positive(), nonce: z.string().uuid(),
}).strict();
export const runtimeSecret = () => process.env.RUNTIME_API_TOKEN || process.env.RUNTIME_AUTH_SECRET || process.env.INTERNAL_EXECUTE_TOKEN;
const sign = (value) => crypto.createHmac("sha256", runtimeSecret()).update(`runtime-session.v1:${value}`).digest("base64url");
const equal = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
/** Minted only by a trusted backend after application authentication. Never send the signing key to a desktop. */
export function issueRuntimeSession(scope) {
    if (!runtimeSecret())
        throw new Error("Runtime authentication unavailable");
    if (scope.expires_at <= Date.now() || scope.expires_at > Date.now() + 24 * 3600000)
        throw new Error("Session expiry must be within 24 hours");
    const payload = Buffer.from(JSON.stringify(scopeSchema.parse({ ...scope, nonce: crypto.randomUUID() }))).toString("base64url");
    return `${payload}.${sign(payload)}`;
}
export function getRuntimeScope(res) { return res.locals.runtimeScope; }
export function scopeOwnsRun(res, run) {
    const scope = getRuntimeScope(res);
    return !scope || (run.session_id === scope.session_id && run.profile_id === scope.profile_id);
}
/** Trusted backends assert identity; scoped desktop sessions have identity fixed by their signature. */
export function runtimeAuth(req, res, next) {
    const configured = runtimeSecret();
    if (!configured) {
        res.status(503).json({ error: { code: "RUNTIME_AUTH_UNAVAILABLE" } });
        return;
    }
    const supplied = req.get("x-runtime-token");
    if (supplied && equal(configured, supplied)) {
        res.locals.runtimeBackend = true;
        next();
        return;
    }
    const bearer = req.get("authorization")?.replace(/^Bearer /, "");
    if (bearer && bearer.length < 4096) {
        const [payload, signature, extra] = bearer.split(".");
        try {
            if (extra || !payload || !signature || !equal(sign(payload), signature))
                throw new Error("Invalid session");
            const scope = scopeSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
            if (scope.expires_at <= Date.now())
                throw new Error("Session expired");
            req.project = scope.app_id;
            req.username = scope.username;
            res.locals.runtimeScope = scope;
            next();
            return;
        }
        catch { /* Never include submitted credentials in errors. */ }
    }
    res.status(401).json({ error: { code: "RUNTIME_UNAUTHORIZED" } });
}
//# sourceMappingURL=RuntimeAuth.js.map