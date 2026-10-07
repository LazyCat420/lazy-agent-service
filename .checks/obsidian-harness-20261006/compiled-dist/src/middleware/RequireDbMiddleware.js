import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../config.js";
/**
 * Express middleware that attaches the MongoDB database instance to `req.db`.
 * Returns 503 if the database is not available, eliminating the need for
 * per-route `const client = MongoWrapper.getClient(...)` + null-check boilerplate.
 *
 * Usage: `router.use(requireDb)` or per-route `router.get("/", requireDb, handler)`
 */
export default function requireDb(req, res, next) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) {
        return res.status(503).json({ error: "Database not available" });
    }
    req.db = db;
    next();
}
//# sourceMappingURL=RequireDbMiddleware.js.map