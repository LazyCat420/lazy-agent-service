// ─── MongoWrapper — Thin adapter over service-library MongoManager ───
//
// Re-exports MongoManager from the service-library while preserving
// the Prism-specific API surface (createClient, getClient, getDb, etc.)
// that is consumed by ~14 internal modules.
//
// This adapter bridges the legacy API to the shared library:
//   createClient(name, uri) → MongoManager.connect(uri, { name })
//   getClient(name)         → ❌ deprecated — use getDb(name) instead
//   getDb(name)             → MongoManager.getDatabase(name)
//   getCollection(db, col)  → MongoManager.getCollection(col, db)
//   closeClient(name)       → MongoManager.disconnect(name)
// ─────────────────────────────────────────────────────────────────────
import { connectDatabase, getDatabase, getCollection, disconnectDatabase, } from "@rodrigo-barraza/utilities-library/service/mongo";
import logger from "../utils/logger.js";
const MongoWrapper = {
    async createClient(name, uri) {
        return connectDatabase(uri, { name, dbName: name, logger });
    },
    getClient(_name) {
        // Deprecated — getClient returns the raw MongoClient, which is no
        // longer exposed by MongoManager. Use getDb() instead.
        // Callers that used getClient(name).db(name) should use getDb(name).
        throw new Error("MongoWrapper.getClient() is deprecated — use MongoWrapper.getDb() instead");
    },
    getDb(name) {
        return getDatabase(name);
    },
    getCollection(dbName, collectionName) {
        // Note: service-library uses (collectionName, dbName) — reversed order
        return getCollection(collectionName, dbName);
    },
    closeClient(name) {
        return disconnectDatabase(name);
    },
};
export default MongoWrapper;
//# sourceMappingURL=MongoWrapper.js.map