// ============================================================
// PrismMcpRedial — keep prism-service's MCP link to this service alive
// ============================================================
//
// prism-service dials its MCP servers once, at its own boot
// (MCPClientService.connectAllFromDB). It never re-dials. So every time this
// service is deployed or restarts, prism's SSE link to /mcp/sse dies and every
// prism agent loses this service's tools until someone runs, by hand:
//
//   curl -X POST http://10.0.0.16:7777/mcp-servers/<id>/connect \
//        -H 'x-project: vllm-trading-bot' -H 'x-username: lazy-trader'
//
// (trading-client ch.47 row 4.3; the earlier re-dialer lived in trading-client,
// ef1705c3, and left with the prism exit, ab57ab38.) This service knows when it
// has (re)started, so the re-dial lives here. Prism is Rodrigo's repo: this
// module only uses prism's existing HTTP interface.
//
// Prism endpoints used (prism-service src/routes/McpServersRoutes.ts, read
// 2026-10-26):
//   POST /mcp-servers/:id/connect  (:324) — replaces any existing connection of
//        that server (MCPClientService.connect, :600-602), so a repeat dial is
//        safe. 200 {success:true, toolCount, ...}; 200 {success:false,
//        authorizationRequired:true} for OAuth servers; 404 unknown id in this
//        scope; 409/502/503 {error} when the dial fails.
//   GET  /mcp-servers  (:128) — the scope's servers with `id`, `enabled`,
//        `connected`, `toolCount`. The scope travels in the x-project /
//        x-username HEADERS (query params resolve another scope and answer []).
//
// Why prism's `connected` is not enough: it is just "an entry exists in
// prism's connection map" (MCPClientService.isServerConnected / getConnected-
// Servers). Prism never removes the entry when the transport closes, so after
// this service restarts prism keeps reporting connected:true over a dead link.
// Hence two rules:
//   1. On boot, always dial (we know the old link died with the old process).
//   2. Periodically, dial when prism says connected:false OR when this side
//      holds no live, initialised MCP session from a client named "prism"
//      (McpAdapter.countLiveClientSessions). The second check is what catches
//      the stale entry.
//
// Never throws out of a timer, never blocks startup; timers are unref()'d and
// stop() clears them (registered with the shutdown cleanup in index.ts).

import defaultLogger from "../utils/logger.ts";

export interface PrismMcpRedialConfig {
  /** prism-service base URL, e.g. http://10.0.0.16:7777 (no trailing slash). */
  url: string;
  /** prism's Mongo id of the MCP server document that points at this service. */
  serverId: string;
  project: string;
  username: string;
  /** Periodic check interval. */
  intervalMs: number;
  /** Delay between "HTTP server listening" and the boot dial. */
  bootDelayMs: number;
  /** Boot-dial retry delays; after the last one the periodic check takes over. */
  bootRetryDelaysMs: number[];
  /** Per-request timeout. A connect makes prism dial us and list our tools. */
  requestTimeoutMs: number;
  /** MCP clientInfo.name prism announces; "" disables the local-session check. */
  clientName: string;
  /**
   * Minimum gap between two stale-entry re-dials (prism connected:true, no
   * live local prism session). Guards against a local session count that
   * reads 0 over a healthy link: each re-dial replaces prism's connection and
   * can cut its in-flight tool calls. Boot and connected:false dials ignore it.
   */
  staleRedialMinMs: number;
}

export interface RedialLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface PrismMcpRedialDeps {
  fetch?: typeof fetch;
  logger?: RedialLogger;
  /**
   * Live, initialised MCP sessions on this side whose client is named
   * `clientName`. Return null when unknown (the check is then skipped).
   */
  countLocalClientSessions?: (clientName: string) => number | null;
  /** Clock (ms since epoch); injectable for tests. Defaults to Date.now. */
  now?: () => number;
}

export const DEFAULT_INTERVAL_MS = 300_000;
export const DEFAULT_BOOT_DELAY_MS = 5_000;
export const DEFAULT_BOOT_RETRY_DELAYS_MS = [5_000, 15_000, 60_000];
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_STALE_REDIAL_MIN_MS = 3_600_000;
export const STALE_RULE_UNRELIABLE_WARNING =
  "[PrismMcpRedial] local session check reads 0 right after a re-dial; the stale-entry rule is unreliable here";

const LOG_PREFIX = "[PrismMcpRedial]";

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** The redial config from env, or null when URL or server id is unset (disabled). */
export function readPrismMcpRedialConfig(
  env: NodeJS.ProcessEnv = process.env,
): PrismMcpRedialConfig | null {
  const url = (env.PRISM_MCP_REDIAL_URL || "").trim().replace(/\/+$/, "");
  const serverId = (env.PRISM_MCP_SERVER_ID || "").trim();
  if (!url || !serverId) return null;
  const retries = (env.PRISM_MCP_REDIAL_BOOT_RETRIES_MS || "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  return {
    url,
    serverId,
    project: (env.PRISM_MCP_PROJECT || "").trim() || "vllm-trading-bot",
    username: (env.PRISM_MCP_USERNAME || "").trim() || "lazy-trader",
    intervalMs: positiveInt(env.PRISM_MCP_REDIAL_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    bootDelayMs: positiveInt(env.PRISM_MCP_REDIAL_BOOT_DELAY_MS, DEFAULT_BOOT_DELAY_MS),
    bootRetryDelaysMs: retries.length > 0 ? retries : [...DEFAULT_BOOT_RETRY_DELAYS_MS],
    requestTimeoutMs: positiveInt(env.PRISM_MCP_REDIAL_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
    clientName: env.PRISM_MCP_CLIENT_NAME === undefined ? "prism" : env.PRISM_MCP_CLIENT_NAME.trim(),
    staleRedialMinMs: positiveInt(env.PRISM_MCP_STALE_REDIAL_MIN_MS, DEFAULT_STALE_REDIAL_MIN_MS),
  };
}

export type DialOutcome =
  | { ok: true; toolCount: number }
  | { ok: false; reason: string };

export type CheckOutcome =
  | { action: "healthy"; toolCount: number }
  | { action: "redialed"; reason: string; dial: DialOutcome }
  | { action: "skipped"; reason: string };

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? `: ${cause.message}` : "";
    return `${error.message}${causeText}`.slice(0, 300);
  }
  return String(error).slice(0, 300);
}

export class PrismMcpRedialer {
  readonly config: PrismMcpRedialConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly log: RedialLogger;
  private readonly countLocal?: (clientName: string) => number | null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private busy = false;
  private readonly now: () => number;
  /** When the last stale-entry re-dial was attempted (null = never). */
  private lastStaleRedialAt: number | null = null;
  /** The previous check did a stale-entry re-dial; the next one verifies it. */
  private verifyAfterStaleRedial = false;
  private warnedStaleRuleUnreliable = false;

  constructor(config: PrismMcpRedialConfig, deps: PrismMcpRedialDeps = {}) {
    this.config = config;
    // Read the global at call time unless injected, so test stubs apply.
    this.fetchImpl = deps.fetch ?? ((...args) => globalThis.fetch(...args));
    this.log = deps.logger ?? defaultLogger;
    this.countLocal = deps.countLocalClientSessions;
    this.now = deps.now ?? Date.now;
  }

  get running(): boolean {
    return !this.stopped;
  }

  /** Start the boot dial (after bootDelayMs) and then the periodic check. Never throws. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.log.info(
      `${LOG_PREFIX} enabled: prism ${this.config.url}, server ${this.config.serverId} ` +
        `[${this.config.project}/${this.config.username}], boot dial in ${this.config.bootDelayMs}ms, ` +
        `check every ${this.config.intervalMs}ms`,
    );
    this.schedule(this.config.bootDelayMs, () => this.bootAttempt(0));
  }

  /** Cancel every pending timer. In-flight requests finish but schedule nothing. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number, task: () => Promise<void>): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      task().catch((error: unknown) => {
        // Belt and braces: the tasks catch their own errors.
        this.log.error(`${LOG_PREFIX} unexpected error: ${describeError(error)}`);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private async bootAttempt(attempt: number): Promise<void> {
    const reason =
      attempt === 0
        ? "boot: lazy-agent-service (re)started, prism's old link died with the old process"
        : `boot retry ${attempt}/${this.config.bootRetryDelaysMs.length}`;
    const outcome = await this.dial(reason);
    if (this.stopped) return;
    // `in` narrowing: the repo compiles with strict:false, where a boolean
    // discriminant (`outcome.ok`) does not narrow the union.
    if (!("reason" in outcome)) {
      this.schedule(this.config.intervalMs, () => this.tick());
      return;
    }
    const failure = outcome.reason;
    const nextDelay = this.config.bootRetryDelaysMs[attempt];
    if (nextDelay !== undefined) {
      this.log.warn(`${LOG_PREFIX} boot dial failed (${failure}); retrying in ${nextDelay}ms`);
      this.schedule(nextDelay, () => this.bootAttempt(attempt + 1));
    } else {
      this.log.warn(
        `${LOG_PREFIX} boot dial failed after ${attempt + 1} attempts (${failure}); ` +
          `periodic check every ${this.config.intervalMs}ms takes over`,
      );
      this.schedule(this.config.intervalMs, () => this.tick());
    }
  }

  private async tick(): Promise<void> {
    await this.checkOnce();
    this.schedule(this.config.intervalMs, () => this.tick());
  }

  private headers(): Record<string, string> {
    return { "x-project": this.config.project, "x-username": this.config.username };
  }

  /** POST /mcp-servers/:id/connect. Never throws. */
  async dial(reason: string): Promise<DialOutcome> {
    const target = `${this.config.url}/mcp-servers/${encodeURIComponent(this.config.serverId)}/connect`;
    this.log.info(`${LOG_PREFIX} re-dialing prism → ${target} (reason: ${reason})`);
    try {
      const response = await this.fetchImpl(target, {
        method: "POST",
        headers: this.headers(),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok) {
        const detail = typeof body?.error === "string" ? body.error : JSON.stringify(body);
        const failure = `HTTP ${response.status}: ${String(detail).slice(0, 300)}`;
        this.log.error(`${LOG_PREFIX} re-dial refused by prism: ${failure}`);
        return { ok: false, reason: failure };
      }
      if (body?.success !== true) {
        const failure = body?.authorizationRequired
          ? "prism says the server needs OAuth authorization"
          : `unexpected connect body: ${JSON.stringify(body).slice(0, 300)}`;
        this.log.error(`${LOG_PREFIX} re-dial did not connect: ${failure}`);
        return { ok: false, reason: failure };
      }
      const toolCount = typeof body.toolCount === "number" ? body.toolCount : 0;
      this.log.info(`${LOG_PREFIX} prism re-connected to this service: ${toolCount} tools`);
      return { ok: true, toolCount };
    } catch (error: unknown) {
      const failure = `prism unreachable: ${describeError(error)}`;
      this.log.warn(`${LOG_PREFIX} re-dial failed: ${failure}`);
      return { ok: false, reason: failure };
    }
  }

  /** One periodic pass: read prism's status, re-dial when the link is down. Never throws. */
  async checkOnce(): Promise<CheckOutcome> {
    if (this.busy) return { action: "skipped", reason: "previous check still running" };
    this.busy = true;
    try {
      const listed = await this.fetchServerList();
      if ("reason" in listed) {
        return { action: "skipped", reason: listed.reason };
      }
      const servers = listed.servers;

      if (!Array.isArray(servers)) {
        const reason = "GET /mcp-servers did not return a list";
        this.log.warn(`${LOG_PREFIX} status check skipped: ${reason}`);
        return { action: "skipped", reason };
      }
      const server = servers.find(
        (entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === "object" &&
          ((entry as Record<string, unknown>).id === this.config.serverId ||
            (entry as Record<string, unknown>)._id === this.config.serverId),
      );
      if (!server) {
        const reason =
          `server ${this.config.serverId} is not in prism's list for ` +
          `${this.config.project}/${this.config.username} (check PRISM_MCP_SERVER_ID / scope)`;
        this.log.error(`${LOG_PREFIX} status check skipped: ${reason}`);
        return { action: "skipped", reason };
      }
      if (server.enabled === false) {
        const reason = "server is disabled in prism; leaving it alone";
        this.log.info(`${LOG_PREFIX} ${reason}`);
        return { action: "skipped", reason };
      }

      // Only the first check that reads prism's status after a stale-entry
      // re-dial verifies it; clear the flag whatever this check finds.
      const verifyingStaleRedial = this.verifyAfterStaleRedial;
      this.verifyAfterStaleRedial = false;

      const down = this.resolveDownReason(server, verifyingStaleRedial);

      if (!down.reason) {
        const toolCount = typeof server.toolCount === "number" ? server.toolCount : 0;
        return { action: "healthy", toolCount };
      }
      if (down.staleEntry) {
        const suppressed = this.suppressOrRecordStaleRedial();
        if (suppressed) return suppressed;
      }
      const dial = await this.dial(down.reason);
      return { action: "redialed", reason: down.reason, dial };
    } catch (error: unknown) {
      const reason = `unexpected error: ${describeError(error)}`;
      this.log.error(`${LOG_PREFIX} ${reason}`);
      return { action: "skipped", reason };
    } finally {
      this.busy = false;
    }
  }

  /** GET /mcp-servers; a failure is reported, never thrown. */
  private async fetchServerList(): Promise<
    { ok: true; servers: unknown } | { ok: false; reason: string }
  > {
    try {
      const response = await this.fetchImpl(`${this.config.url}/mcp-servers`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      if (!response.ok) {
        const reason = `GET /mcp-servers answered HTTP ${response.status}`;
        this.log.warn(`${LOG_PREFIX} status check skipped: ${reason}`);
        return { ok: false, reason };
      }
      return { ok: true, servers: await response.json() };
    } catch (error: unknown) {
      const reason = `prism unreachable: ${describeError(error)}`;
      this.log.warn(`${LOG_PREFIX} status check skipped: ${reason}`);
      return { ok: false, reason };
    }
  }

  /** Why prism's view of the link looks down, and whether it is a stale entry. */
  private resolveDownReason(
    server: Record<string, unknown>,
    verifyingStaleRedial: boolean,
  ): { reason: string | null; staleEntry: boolean } {
    let reason: string | null = null;
    let staleEntry = false;
    if (server.connected !== true) {
      reason = "prism reports connected:false";
    } else if (this.config.clientName && this.countLocal) {
      let local: number | null = null;
      try {
        local = this.countLocal(this.config.clientName);
      } catch (error: unknown) {
        this.log.warn(`${LOG_PREFIX} local session count failed: ${describeError(error)}`);
      }
      if (local === 0 && verifyingStaleRedial && !this.warnedStaleRuleUnreliable) {
        this.warnedStaleRuleUnreliable = true;
        this.log.warn(STALE_RULE_UNRELIABLE_WARNING);
      }
      if (local === 0) {
        staleEntry = true;
        reason =
          `prism reports connected:true but this service holds no live MCP session ` +
          `from client "${this.config.clientName}" (stale entry in prism's connection map)`;
      }
    }
    return { reason, staleEntry };
  }

  /** Record a stale-entry re-dial, unless the minimum gap has not elapsed. */
  private suppressOrRecordStaleRedial(): CheckOutcome | null {
    const now = this.now();
    const sinceLast = this.lastStaleRedialAt === null ? Infinity : now - this.lastStaleRedialAt;
    if (sinceLast < this.config.staleRedialMinMs) {
      const skip =
        `stale-entry re-dial suppressed: last one ${Math.round(sinceLast / 1000)}s ago, ` +
        `minimum gap ${Math.round(this.config.staleRedialMinMs / 1000)}s (PRISM_MCP_STALE_REDIAL_MIN_MS)`;
      this.log.info(`${LOG_PREFIX} ${skip}`);
      return { action: "skipped", reason: skip };
    }
    this.lastStaleRedialAt = now;
    this.verifyAfterStaleRedial = true;
    return null;
  }
}

/**
 * Start the re-dialer from env. Returns null (after logging once) when
 * PRISM_MCP_REDIAL_URL or PRISM_MCP_SERVER_ID is unset.
 */
export function startPrismMcpRedial(
  deps: PrismMcpRedialDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): PrismMcpRedialer | null {
  const config = readPrismMcpRedialConfig(env);
  if (!config) {
    (deps.logger ?? defaultLogger).info(
      `${LOG_PREFIX} disabled: set PRISM_MCP_REDIAL_URL and PRISM_MCP_SERVER_ID to keep prism's MCP link to this service alive`,
    );
    return null;
  }
  const redialer = new PrismMcpRedialer(config, deps);
  redialer.start();
  return redialer;
}
