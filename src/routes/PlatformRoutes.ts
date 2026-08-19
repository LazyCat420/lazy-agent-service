/**
 * Platform Routes — cross-project tool telemetry for the platform dashboard.
 *
 * WHY THIS EXISTS: tool usage used to be surfaced only inside trading-client's
 * Tools tab, which meant the trading UI listed (and scored) html-notes and
 * treesearch tools alongside its own. Ownership lives on each schema entry as
 * `owner_app`, so the cross-project view belongs here — in the service that
 * actually owns the tool registry — and trading-client now scopes itself to
 * `owner_app === "trading"`.
 *
 * Tool names are recorded with assorted MCP prefixes depending on which caller
 * executed them; `canonicalName()` mirrors the normalisation so registry lookups
 * and usage rows agree on a single key.
 *
 * Data source: 100% Native MongoDB collection `tool_usage_stats` (in TRADING_MONGO_DB).
 */

import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { Router, Request, Response } from "express";
import { promises as fs } from "fs";
import path from "path";

import logger from "../utils/logger.ts";
import { guardStats } from "../services/ToolCallGuard.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import { stripMcpPrefix, ACCEPTED_MCP_PREFIXES } from "../services/McpPrefix.ts";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { TRADING_MONGO_DB } from "../../config.ts";

const router = Router();

/**
 * The trading database, or a 503 — never a 500.
 *
 * MongoManager keys connections by NAME and THROWS `Database not connected`
 * for one nobody registered, so an unconfigured trading database used to reach
 * the generic catch and answer 500 "Database not connected: trading_bot". That
 * is a lie about whose fault it is: this service is a dashboard over another
 * project's collection, and "the data source is not configured here" is a 503,
 * exactly as the old `getPlatformPool()` null-check answered before the
 * Postgres path was removed.
 */
function tradingDb(res: Response) {
  try {
    return MongoWrapper.getDb(TRADING_MONGO_DB);
  } catch (e) {
    logger.error(`[Platform] trading database unavailable: ${e}`);
    res.status(503).json({
      error: `trading database (${TRADING_MONGO_DB}) is not connected`,
      hint: "set MONGO_URI and TRADING_MONGO_DB, then restart the service",
    });
    return null;
  }
}

function canonicalName(name: string): string {
  return stripMcpPrefix(name || "");
}

interface ToolSchema {
  name: string;
  description?: string;
  owner_app?: string;
  domain?: string;
  tier?: string;
  permission?: string;
  source?: string;
}

let schemaCache: ToolSchema[] | null = null;

async function loadRegistry(): Promise<ToolSchema[]> {
  if (schemaCache) return schemaCache;
  try {
    const schemaPath = path.resolve(process.cwd(), "tool_schemas.json");
    const data = await fs.readFile(schemaPath, "utf-8");
    schemaCache = JSON.parse(data) as ToolSchema[];
    return schemaCache;
  } catch (e) {
    logger.error(`[Platform] Failed to load tool_schemas.json: ${e}`);
    return [];
  }
}

/**
 * GET /platform/registry
 * The tool registry grouped by owning app — the canonical answer to
 * "which project owns which tools".
 *
 * RESTORED 2026-08-19. It reads `tool_schemas.json` off disk and has never
 * touched a database, so it was removed as collateral in the Postgres->Mongo
 * rewrite rather than deliberately. A read-only filesystem endpoint is not
 * part of that migration; deleting it silently turns "which project owns this
 * tool" into a 404 for every caller.
 */
router.get(
  "/registry",
  asyncHandler(async (_req: Request, res: Response) => {
    const tools = await loadRegistry();
    const projects: Record<string, ToolSchema[]> = {};
    for (const t of tools) {
      const owner = t.owner_app || "unknown";
      (projects[owner] ||= []).push({
        name: t.name,
        description: t.description,
        owner_app: owner,
        domain: t.domain,
        tier: t.tier,
        permission: t.permission,
        source: t.source,
      });
    }
    res.json({
      total: tools.length,
      projects: Object.entries(projects)
        .map(([project, projectTools]) => ({
          project,
          count: projectTools.length,
          tools: projectTools.sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => b.count - a.count),
    });
  }),
);

// ── GET /stats ─────────────────────────────────────────────────────────────
// Cross-project usage, latencies, failure rates, and owner_app attribution.
router.get(
  "/stats",
  asyncHandler(async (req: Request, res: Response) => {
    const hours = Math.max(1, Math.min(168, parseInt((req.query.hours as string) || "24", 10)));
    const ownerFilter = (req.query.owner_app as string) || undefined;
    const serviceFilter = (req.query.service as string) || undefined;

    const schemas = await loadRegistry();
    const schemaMap = new Map<string, ToolSchema>();
    for (const s of schemas) {
      schemaMap.set(canonicalName(s.name), s);
    }

    try {
      const db = tradingDb(res);
      if (!db) return;
      const since = new Date(Date.now() - hours * 3600 * 1000);
      const match: Record<string, any> = {
        called_at: { $gte: since },
        service_source: { $ne: "probe" },
      };
      if (serviceFilter) {
        match.service_source = serviceFilter;
      }

      const pipeline: any[] = [
        { $match: match },
        {
          $group: {
            _id: "$tool_name",
            total_calls: { $sum: 1 },
            success_count: { $sum: { $cond: ["$success", 1, 0] } },
            failure_count: { $sum: { $cond: ["$success", 0, 1] } },
            avg_ms: { $avg: "$execution_ms" },
            last_called: { $max: "$called_at" },
            last_error: { $last: "$error_message" },
            sources: { $addToSet: "$service_source" },
          },
        },
      ];

      const docs = await db.collection("tool_usage_stats").aggregate(pipeline).toArray();

      const combined = new Map<
        string,
        {
          tool_name: string;
          canonical_name: string;
          total_calls: number;
          success_count: number;
          failure_count: number;
          avg_ms: number;
          last_called: string | null;
          last_error: string | null;
          sources: string[];
        }
      >();

      for (const d of docs) {
        const cName = canonicalName(d._id);
        const existing = combined.get(cName);
        if (!existing) {
          combined.set(cName, {
            tool_name: cName,
            canonical_name: cName,
            total_calls: Number(d.total_calls || 0),
            success_count: Number(d.success_count || 0),
            failure_count: Number(d.failure_count || 0),
            avg_ms: Number(d.avg_ms || 0),
            last_called: d.last_called ? new Date(d.last_called).toISOString() : null,
            last_error: d.last_error || null,
            sources: (d.sources || []).filter(Boolean),
          });
        } else {
          const newTotal = existing.total_calls + Number(d.total_calls || 0);
          const weightedMs =
            newTotal > 0
              ? (existing.avg_ms * existing.total_calls + Number(d.avg_ms || 0) * Number(d.total_calls || 0)) / newTotal
              : 0;
          existing.total_calls = newTotal;
          existing.success_count += Number(d.success_count || 0);
          existing.failure_count += Number(d.failure_count || 0);
          existing.avg_ms = weightedMs;
          if (d.last_called && (!existing.last_called || new Date(d.last_called) > new Date(existing.last_called))) {
            existing.last_called = new Date(d.last_called).toISOString();
            existing.last_error = d.last_error || existing.last_error;
          }
          for (const s of d.sources || []) {
            if (s && !existing.sources.includes(s)) existing.sources.push(s);
          }
        }
      }

      for (const [cName, schema] of schemaMap.entries()) {
        if (!combined.has(cName)) {
          combined.set(cName, {
            tool_name: schema.name,
            canonical_name: cName,
            total_calls: 0,
            success_count: 0,
            failure_count: 0,
            avg_ms: 0,
            last_called: null,
            last_error: null,
            sources: [],
          });
        }
      }

      const enriched = Array.from(combined.values())
        .map((row) => {
          const schema = schemaMap.get(row.canonical_name);
          const total = row.total_calls;
          const successRate = total > 0 ? row.success_count / total : 1.0;
          const ownerApp = schema?.owner_app || "shared";

          return {
            ...row,
            owner_app: ownerApp,
            domain: schema?.domain || "general",
            tier: schema?.tier || "read_only",
            permission: schema?.permission || "read_only",
            description: schema?.description || "",
            in_registry: Boolean(schema),
            success_rate: Math.round(successRate * 1000) / 1000,
            avg_latency_ms: Math.round(row.avg_ms * 10) / 10,
          };
        })
        .filter((row) => !ownerFilter || row.owner_app === ownerFilter);

      const byOwner: Record<string, { total_calls: number; failures: number; tools: number }> = {};
      for (const row of enriched) {
        const o = row.owner_app;
        if (!byOwner[o]) byOwner[o] = { total_calls: 0, failures: 0, tools: 0 };
        byOwner[o].total_calls += row.total_calls;
        byOwner[o].failures += row.failure_count;
        byOwner[o].tools += 1;
      }

      const totalCalls = enriched.reduce((sum, r) => sum + r.total_calls, 0);
      const totalFailures = enriched.reduce((sum, r) => sum + r.failure_count, 0);

      res.json({
        hours,
        total_registered: schemas.length,
        total_active: enriched.filter((r) => r.total_calls > 0).length,
        total_calls: totalCalls,
        total_failures: totalFailures,
        overall_success_rate:
          totalCalls > 0 ? Math.round(((totalCalls - totalFailures) / totalCalls) * 1000) / 1000 : 1.0,
        by_owner: byOwner,
        guards: guardStats(),
        tools: enriched,
      });
    } catch (e) {
      logger.error(`[Platform] /stats failed: ${e}`);
      res.status(500).json({ error: getErrorMessage(e) });
    }
  }),
);

// ── GET /storms ────────────────────────────────────────────────────────────
// Rapid sequential failures: detects loops where an agent hammers a failing tool.
router.get(
  "/storms",
  asyncHandler(async (req: Request, res: Response) => {
    const hours = Math.max(1, Math.min(72, parseInt((req.query.hours as string) || "6", 10)));
    const minFailures = Math.max(2, parseInt((req.query.min_failures as string) || "3", 10));

    try {
      const db = tradingDb(res);
      if (!db) return;
      const since = new Date(Date.now() - hours * 3600 * 1000);

      const docs = await db
        .collection("tool_usage_stats")
        .find(
          { called_at: { $gte: since }, service_source: { $ne: "probe" } },
          { sort: { agent_name: 1, cycle_id: 1, called_at: 1 } },
        )
        .toArray();

      const storms: Array<{
        tool_name: string;
        agent_name: string;
        cycle_id: string;
        service_source: string;
        failures: number;
        first_failure: string;
        last_failure: string;
        span_seconds: number;
        last_error: string;
      }> = [];

      let curKey = "";
      let failStreak = 0;
      let firstFailTime: Date | null = null;
      let lastFailTime: Date | null = null;
      let lastErr = "";
      let curTool = "";
      let curAgent = "";
      let curCycle = "";
      let curSource = "";

      function flush() {
        if (failStreak >= minFailures && firstFailTime && lastFailTime) {
          storms.push({
            tool_name: canonicalName(curTool),
            agent_name: curAgent,
            cycle_id: curCycle,
            service_source: curSource,
            failures: failStreak,
            first_failure: firstFailTime.toISOString(),
            last_failure: lastFailTime.toISOString(),
            span_seconds: Math.round((lastFailTime.getTime() - firstFailTime.getTime()) / 1000),
            last_error: lastErr,
          });
        }
        failStreak = 0;
        firstFailTime = null;
        lastFailTime = null;
        lastErr = "";
      }

      for (const d of docs) {
        const key = `${d.agent_name || ""}|${d.cycle_id || ""}|${canonicalName(d.tool_name)}`;
        if (key !== curKey) {
          flush();
          curKey = key;
          curTool = d.tool_name || "";
          curAgent = d.agent_name || "";
          curCycle = d.cycle_id || "";
          curSource = d.service_source || "";
        }

        if (!d.success) {
          failStreak += 1;
          const dt = new Date(d.called_at);
          if (!firstFailTime) firstFailTime = dt;
          lastFailTime = dt;
          lastErr = d.error_message || "";
        } else {
          flush();
        }
      }
      flush();

      res.json({
        hours,
        min_failures: minFailures,
        total_storms: storms.length,
        storms: storms.sort((a, b) => b.failures - a.failures),
      });
    } catch (e) {
      logger.error(`[Platform] /storms failed: ${e}`);
      res.status(500).json({ error: getErrorMessage(e) });
    }
  }),
);

// ── GET /recent ────────────────────────────────────────────────────────────
// Last N tool invocations across all services.
router.get(
  "/recent",
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.max(1, Math.min(200, parseInt((req.query.limit as string) || "50", 10)));
    const toolFilter = (req.query.tool as string) || undefined;
    const failuresOnly = req.query.failures_only === "true" || req.query.failures_only === "1";

    try {
      const db = tradingDb(res);
      if (!db) return;
      const match: Record<string, any> = { service_source: { $ne: "probe" } };
      if (toolFilter) {
        match.tool_name = { $regex: toolFilter, $options: "i" };
      }
      if (failuresOnly) {
        match.success = false;
      }

      const docs = await db
        .collection("tool_usage_stats")
        .find(match, { sort: { called_at: -1 }, limit })
        .toArray();

      res.json({
        limit,
        total: docs.length,
        calls: docs.map((d) => ({
          id: d.id,
          tool_name: d.tool_name,
          canonical_name: canonicalName(d.tool_name),
          agent_name: d.agent_name,
          cycle_id: d.cycle_id,
          service_source: d.service_source,
          execution_ms: d.execution_ms,
          success: d.success,
          error_message: d.error_message,
          args_hash: d.args_hash,
          was_blocked: d.was_blocked,
          called_at: d.called_at ? new Date(d.called_at).toISOString() : null,
        })),
      });
    } catch (e) {
      logger.error(`[Platform] /recent failed: ${e}`);
      res.status(500).json({ error: getErrorMessage(e) });
    }
  }),
);

// ── GET /services ──────────────────────────────────────────────────────────
// List known `service_source` values with call counts in the window.
router.get(
  "/services",
  asyncHandler(async (req: Request, res: Response) => {
    const hours = Math.max(1, Math.min(168, parseInt((req.query.hours as string) || "24", 10)));

    try {
      const db = tradingDb(res);
      if (!db) return;
      const since = new Date(Date.now() - hours * 3600 * 1000);
      const pipeline = [
        { $match: { called_at: { $gte: since }, service_source: { $ne: "probe" } } },
        {
          $group: {
            _id: "$service_source",
            calls: { $sum: 1 },
            failures: { $sum: { $cond: ["$success", 0, 1] } },
            last_active: { $max: "$called_at" },
          },
        },
      ];

      const docs = await db.collection("tool_usage_stats").aggregate(pipeline).toArray();

      res.json({
        hours,
        services: docs.map((d) => ({
          service: d._id || "unknown",
          calls: Number(d.calls || 0),
          failures: Number(d.failures || 0),
          last_active: d.last_active ? new Date(d.last_active).toISOString() : null,
        })),
      });
    } catch (e) {
      logger.error(`[Platform] /services failed: ${e}`);
      res.status(500).json({ error: getErrorMessage(e) });
    }
  }),
);

export default router;
