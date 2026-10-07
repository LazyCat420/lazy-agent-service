// ─── Memory Consolidation Tracker ────────────────────────────
// Run counting, daily cost guard, and history recording for
// the memory consolidation pipeline.
// Extracted from MemoryConsolidationService.ts
import MongoWrapper from "../../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../../config.js";
import logger from "../../utils/logger.js";
import { COLLECTIONS } from "../../constants.js";
/** Min sessions between consolidation runs */
export const SESSIONS_BETWEEN_RUNS = 5;
/** Max consolidation runs per project per day (cost guard) */
export const DAILY_MAX_CONSOLIDATIONS = 20;
const RUNS_COLLECTION = COLLECTIONS.MEMORY_CONSOLIDATION_RUNS;
const HISTORY_COLLECTION = COLLECTIONS.MEMORY_CONSOLIDATION_HISTORY;
// ─── Run Counting ───────────────────────────────────────────
export async function getRunCount(project) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db)
        return 0;
    const document = await db.collection(RUNS_COLLECTION).findOne({ project });
    return document?.sessionsSinceLastRun || 0;
}
export async function incrementRunCount(project) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db)
        return;
    await db
        .collection(RUNS_COLLECTION)
        .updateOne({ project }, { $inc: { sessionsSinceLastRun: 1 } }, { upsert: true });
}
export async function resetRunCount(project) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db)
        return;
    await db.collection(RUNS_COLLECTION).updateOne({ project }, {
        $set: {
            sessionsSinceLastRun: 0,
            lastConsolidatedAt: new Date().toISOString(),
        },
    }, { upsert: true });
}
// ─── History Recording ──────────────────────────────────────
export async function recordHistory(project, trigger, memoriesBefore, actions, summary, durationMs) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db)
        return;
    const mergeCount = actions
        .filter((action) => action.type === "merge")
        .reduce((sum, action) => sum + (action.sourceIds?.length || 0), 0);
    const deleteCount = actions.filter((action) => action.type === "delete").length;
    await db.collection(HISTORY_COLLECTION).insertOne({
        project,
        runAt: new Date().toISOString(),
        trigger,
        memoriesBefore,
        memoriesAfter: memoriesBefore -
            mergeCount -
            deleteCount +
            actions.filter((action) => action.type === "merge").length,
        actionsApplied: actions.length,
        actions: actions.map((action) => ({
            type: action.type,
            ...(action.sourceIds && { sourceIds: action.sourceIds }),
            ...(action.merged && { mergedTitle: action.merged.title }),
            ...(action.id && { deletedId: action.id }),
            reason: action.reason || "",
        })),
        summary,
        durationMs,
    });
}
// ─── Cost Guard ─────────────────────────────────────────────
/**
 * Check if the daily consolidation budget is exhausted.
 * Returns true if more runs are allowed.
 */
export async function canRunToday(project) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db)
        return true;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayCount = await db.collection(HISTORY_COLLECTION).countDocuments({
        project,
        runAt: { $gte: startOfDay.toISOString() },
    });
    if (todayCount >= DAILY_MAX_CONSOLIDATIONS) {
        logger.warn(`[MemoryConsolidation] Daily limit reached for "${project}" (${todayCount}/${DAILY_MAX_CONSOLIDATIONS})`);
        return false;
    }
    return true;
}
// ─── History Query ──────────────────────────────────────────
export async function getHistory(project, limit = 10) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db)
        return [];
    return db
        .collection(HISTORY_COLLECTION)
        .find({ project })
        .sort({ runAt: -1 })
        .limit(limit)
        .project({ _id: 0 })
        .toArray();
}
//# sourceMappingURL=ConsolidationTracker.js.map