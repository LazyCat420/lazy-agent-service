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
 * executed them; `canonicalName()` mirrors the normalisation the SQL side does
 * so registry lookups and usage rows agree on a single key.
 */

import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { Router, Request, Response } from "express";
import { promises as fs } from "fs";
import path from "path";

import logger from "../utils/logger.ts";
import { platformQuery, getPlatformPool } from "../db/postgres.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

const router = Router();

const MCP_PREFIXES = [
  "mcp__lazy-agent-service__",
  "mcp__lazy-tool-service__",
  "mcp__lazy-tools__",
  "mcp_",
];

/** Strip whichever MCP namespace prefix a caller happened to record. */
function canonicalName(name: string): string {
  let out = name || "";
  for (const prefix of MCP_PREFIXES) {
    if (out.startsWith(prefix)) out = out.slice(prefix.length);
  }
  return out;
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

/** tool name -> owning app, for attributing usage rows to a project. */
async function ownerIndex(): Promise<Map<string, string>> {
  const tools = await loadRegistry();
  const index = new Map<string, string>();
  for (const t of tools) {
    if (t?.name) index.set(canonicalName(t.name), t.owner_app || "unknown");
  }
  return index;
}

/**
 * GET /platform/registry
 * The tool registry grouped by owning app — the canonical answer to
 * "which project owns which tools".
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

/**
 * GET /platform/stats?hours=24
 * Per-tool usage rolled up per owning project. Reads the shared
 * `tool_usage_stats` table (written by every service that executes a tool).
 */
router.get(
  "/stats",
  asyncHandler(async (req: Request, res: Response) => {
    const hours = Math.min(
      Math.max(parseInt(String(req.query.hours ?? "24"), 10) || 24, 1),
      720,
    );

    if (!getPlatformPool()) {
      return res.status(503).json({
        error: "DATABASE_URL is not configured — platform telemetry unavailable",
        projects: [],
      });
    }

    try {
      const rows = await platformQuery<{
        tool_name: string;
        service_source: string;
        total_calls: string;
        success_count: string;
        avg_ms: string | null;
        max_ms: number | null;
        last_called: Date | null;
      }>(
        `SELECT
            tool_name,
            COALESCE(service_source, 'unknown') AS service_source,
            COUNT(*)                            AS total_calls,
            SUM(CASE WHEN success THEN 1 ELSE 0 END) AS success_count,
            ROUND(AVG(execution_ms)::numeric, 1)     AS avg_ms,
            MAX(execution_ms)                        AS max_ms,
            MAX(called_at)                           AS last_called
         FROM tool_usage_stats
         WHERE called_at > NOW() - INTERVAL '1 hour' * $1
         GROUP BY 1, 2`,
        [hours],
      );

      const owners = await ownerIndex();

      interface Agg {
        tool_name: string;
        project: string;
        total_calls: number;
        success_count: number;
        avg_ms: number;
        max_ms: number;
        last_called: string | null;
        service_sources: Set<string>;
      }
      const byTool = new Map<string, Agg>();

      for (const r of rows) {
        const name = canonicalName(r.tool_name);
        const calls = Number(r.total_calls) || 0;
        const existing = byTool.get(name);
        const avg = r.avg_ms ? Number(r.avg_ms) : 0;
        if (existing) {
          // Weighted mean so multi-source tools report an honest average.
          const totalCalls = existing.total_calls + calls;
          existing.avg_ms = totalCalls
            ? (existing.avg_ms * existing.total_calls + avg * calls) / totalCalls
            : 0;
          existing.total_calls = totalCalls;
          existing.success_count += Number(r.success_count) || 0;
          existing.max_ms = Math.max(existing.max_ms, r.max_ms || 0);
          existing.service_sources.add(r.service_source);
          const last = r.last_called ? new Date(r.last_called).toISOString() : null;
          if (last && (!existing.last_called || last > existing.last_called)) {
            existing.last_called = last;
          }
        } else {
          byTool.set(name, {
            tool_name: name,
            project: owners.get(name) || "unregistered",
            total_calls: calls,
            success_count: Number(r.success_count) || 0,
            avg_ms: avg,
            max_ms: r.max_ms || 0,
            last_called: r.last_called ? new Date(r.last_called).toISOString() : null,
            service_sources: new Set([r.service_source]),
          });
        }
      }

      // Registered-but-silent tools, per project — the useful half of the
      // picture that a pure usage query can never show.
      const registry = await loadRegistry();
      const called = new Set(byTool.keys());

      const projects = new Map<
        string,
        {
          project: string;
          total_calls: number;
          success_count: number;
          tools: Array<Record<string, unknown>>;
          never_called: string[];
          registered: number;
        }
      >();

      const ensure = (project: string) => {
        let p = projects.get(project);
        if (!p) {
          p = {
            project,
            total_calls: 0,
            success_count: 0,
            tools: [],
            never_called: [],
            registered: 0,
          };
          projects.set(project, p);
        }
        return p;
      };

      for (const t of registry) {
        const p = ensure(t.owner_app || "unknown");
        p.registered += 1;
        if (!called.has(canonicalName(t.name))) p.never_called.push(t.name);
      }

      for (const agg of byTool.values()) {
        const p = ensure(agg.project);
        p.total_calls += agg.total_calls;
        p.success_count += agg.success_count;
        p.tools.push({
          tool_name: agg.tool_name,
          total_calls: agg.total_calls,
          success_count: agg.success_count,
          failure_count: agg.total_calls - agg.success_count,
          success_rate: agg.total_calls
            ? Math.round((agg.success_count / agg.total_calls) * 1000) / 10
            : 0,
          avg_ms: Math.round(agg.avg_ms * 10) / 10,
          max_ms: agg.max_ms,
          last_called: agg.last_called,
          service_sources: [...agg.service_sources].sort().join(","),
        });
      }

      const projectList = [...projects.values()]
        .map((p) => ({
          ...p,
          never_called: p.never_called.sort(),
          tools: p.tools.sort(
            (a, b) => (b.total_calls as number) - (a.total_calls as number),
          ),
          success_rate: p.total_calls
            ? Math.round((p.success_count / p.total_calls) * 1000) / 10
            : 0,
        }))
        .sort((a, b) => b.total_calls - a.total_calls);

      const totalCalls = projectList.reduce((s, p) => s + p.total_calls, 0);
      const totalSuccess = projectList.reduce((s, p) => s + p.success_count, 0);

      res.json({
        period_hours: hours,
        summary: {
          total_calls: totalCalls,
          total_success: totalSuccess,
          success_rate: totalCalls
            ? Math.round((totalSuccess / totalCalls) * 1000) / 10
            : 0,
          unique_tools_used: byTool.size,
          total_registered: registry.length,
          projects: projectList.length,
        },
        projects: projectList,
      });
    } catch (e) {
      logger.warn(`[Platform] stats query failed: ${getErrorMessage(e)}`);
      res.status(500).json({ error: getErrorMessage(e), projects: [] });
    }
  }),
);

/**
 * GET /platform/recent?project=&tool=&limit=
 * Recent individual calls, optionally scoped to one project or tool.
 */
router.get(
  "/recent",
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1),
      200,
    );
    const project = req.query.project ? String(req.query.project) : null;
    const tool = req.query.tool ? String(req.query.tool) : null;

    if (!getPlatformPool()) {
      return res.status(503).json({
        error: "DATABASE_URL is not configured — platform telemetry unavailable",
        calls: [],
      });
    }

    try {
      const owners = await ownerIndex();
      // Over-fetch when filtering by project: attribution happens in JS (the
      // owner map lives in the registry file, not the database), so the SQL
      // LIMIT alone could return a page with nothing from the wanted project.
      const sqlLimit = project ? Math.min(limit * 20, 4000) : limit;

      const rows = await platformQuery<{
        tool_name: string;
        agent_name: string | null;
        cycle_id: string | null;
        success: boolean;
        execution_ms: number | null;
        error_message: string | null;
        called_at: Date | null;
        service_source: string | null;
      }>(
        `SELECT tool_name, agent_name, cycle_id, success, execution_ms,
                error_message, called_at, service_source
           FROM tool_usage_stats
          ORDER BY called_at DESC
          LIMIT $1`,
        [sqlLimit],
      );

      let calls = rows.map((r) => {
        const name = canonicalName(r.tool_name);
        return {
          tool_name: name,
          project: owners.get(name) || "unregistered",
          agent_name: r.agent_name || "",
          cycle_id: r.cycle_id || "",
          success: r.success,
          execution_ms: r.execution_ms ?? 0,
          error_message: r.error_message || null,
          called_at: r.called_at ? new Date(r.called_at).toISOString() : null,
          service_source: r.service_source || "unknown",
        };
      });

      if (project) calls = calls.filter((c) => c.project === project);
      if (tool) calls = calls.filter((c) => c.tool_name === tool);

      res.json({ calls: calls.slice(0, limit), total: Math.min(calls.length, limit) });
    } catch (e) {
      logger.warn(`[Platform] recent query failed: ${getErrorMessage(e)}`);
      res.status(500).json({ error: getErrorMessage(e), calls: [] });
    }
  }),
);

/**
 * GET /platform/services?hours=24
 * Which executing service actually ran the calls (trading-service,
 * lazy-tool-service, prism, …) — the SDK/runtime half of the picture.
 */
router.get(
  "/services",
  asyncHandler(async (req: Request, res: Response) => {
    const hours = Math.min(
      Math.max(parseInt(String(req.query.hours ?? "24"), 10) || 24, 1),
      720,
    );

    if (!getPlatformPool()) {
      return res.status(503).json({
        error: "DATABASE_URL is not configured — platform telemetry unavailable",
        services: [],
      });
    }

    try {
      const rows = await platformQuery<{
        service_source: string;
        total_calls: string;
        success_count: string;
        avg_ms: string | null;
        distinct_tools: string;
        last_called: Date | null;
      }>(
        `SELECT COALESCE(service_source, 'unknown') AS service_source,
                COUNT(*)                                 AS total_calls,
                SUM(CASE WHEN success THEN 1 ELSE 0 END) AS success_count,
                ROUND(AVG(execution_ms)::numeric, 1)     AS avg_ms,
                COUNT(DISTINCT tool_name)                AS distinct_tools,
                MAX(called_at)                           AS last_called
           FROM tool_usage_stats
          WHERE called_at > NOW() - INTERVAL '1 hour' * $1
          GROUP BY 1
          ORDER BY 2 DESC`,
        [hours],
      );

      res.json({
        period_hours: hours,
        services: rows.map((r) => {
          const calls = Number(r.total_calls) || 0;
          const ok = Number(r.success_count) || 0;
          return {
            service_source: r.service_source,
            total_calls: calls,
            success_count: ok,
            success_rate: calls ? Math.round((ok / calls) * 1000) / 10 : 0,
            avg_ms: r.avg_ms ? Number(r.avg_ms) : 0,
            distinct_tools: Number(r.distinct_tools) || 0,
            last_called: r.last_called ? new Date(r.last_called).toISOString() : null,
          };
        }),
      });
    } catch (e) {
      logger.warn(`[Platform] services query failed: ${getErrorMessage(e)}`);
      res.status(500).json({ error: getErrorMessage(e), services: [] });
    }
  }),
);

export default router;
