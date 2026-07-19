/**
 * Postgres pool for platform telemetry.
 *
 * The tool-call telemetry (`tool_usage_stats`) lives in the shared `trading_bot`
 * Postgres database, not in this service's Mongo. Everything else in this
 * service uses Mongo — this pool exists purely so the platform dashboard can
 * read cross-project tool usage without routing through trading-service (which
 * would re-create exactly the coupling the dashboard was split out to remove).
 *
 * Connection details come from DATABASE_URL, which is already present in the
 * container. Note it is written in SQLAlchemy dialect form
 * (`postgresql+asyncpg://…`) because the python mirror shared the variable;
 * node-postgres does not understand the `+driver` suffix, so it is stripped.
 * Credentials are never defaulted in code — no DATABASE_URL means the platform
 * routes degrade to an explicit "not configured" error rather than guessing.
 */

import pg from "pg";
import logger from "../utils/logger.ts";

let pool: pg.Pool | null = null;
let initialised = false;

function normaliseConnectionString(raw: string): string {
  // postgresql+asyncpg:// | postgres+psycopg2:// -> postgresql://
  return raw.replace(/^(postgres(?:ql)?)\+[a-z0-9]+:\/\//i, "$1://");
}

export function getPlatformPool(): pg.Pool | null {
  if (initialised) return pool;
  initialised = true;

  const raw = process.env.DATABASE_URL;
  if (!raw) {
    logger.warn(
      "[PlatformDB] DATABASE_URL is not set — platform telemetry endpoints will report unconfigured",
    );
    return null;
  }

  try {
    pool = new pg.Pool({
      connectionString: normaliseConnectionString(raw),
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // Read-only dashboard queries; fail fast rather than hanging the request.
      statement_timeout: 10_000,
    });
    pool.on("error", (err) => {
      logger.error(`[PlatformDB] idle client error: ${err.message}`);
    });
    logger.info("[PlatformDB] Postgres pool initialised for platform telemetry");
  } catch (err) {
    logger.error(`[PlatformDB] Failed to initialise pool: ${String(err)}`);
    pool = null;
  }
  return pool;
}

export async function platformQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const p = getPlatformPool();
  if (!p) throw new Error("DATABASE_URL is not configured");
  const result = await p.query<T>(sql, params);
  return result.rows;
}
