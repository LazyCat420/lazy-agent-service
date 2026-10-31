import type { Db } from "mongodb";
import logger from "../utils/logger.ts";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import MinioWrapper from "../wrappers/MinioWrapper.ts";
import ChangeStreamService from "../services/ChangeStreamService.ts";
import MemoryConsolidationService from "../services/MemoryConsolidationService.ts";
import BackgroundHousekeepingService from "../services/BackgroundHousekeepingService.ts";
import MemoryService from "../services/MemoryService.ts";
import { COLLECTIONS } from "../constants.ts";
import { registerCleanup } from "../utils/CleanupRegistry.ts";
import {
  LAZY_AGENT_BIND_PORT,
  MONGO_URI,
  MONGO_DB_NAME,
  TRADING_MONGO_DB,
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
  MINIO_BUCKET_NAME,
} from "../../config.ts";
import { listProviders } from "../providers/index.ts";
import { evalChaosEnabled } from "../services/EvalChaosCapabilities.ts";
import { INDEX_DEFINITIONS, type IndexDefinition } from "./indexes.ts";
import { ENDPOINTS, type HttpRuntime } from "./server.ts";

// Container-internal bind port; the NAS maps host 5591 → container 7778.
// NOTE: LAZY_AGENT_SERVICE_PORT is the EXTERNAL port elsewhere in the ecosystem
// (the vault .env sets it to 5591) — binding to it broke the compose mapping.
// LAZY_AGENT_BIND_PORT is the dedicated override; see config.ts for the split.
export const PORT = LAZY_AGENT_BIND_PORT;

const CONSOLIDATION_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const MIN_MEMORIES_TO_CONSOLIDATE = 10;

type Logger = typeof logger;
/** A connected Mongo database, as MongoWrapper.getDb returns it. */
export type MongoDb = Db;
/** Handle returned by the interval functions (Node timers). */
export type IntervalHandle = NodeJS.Timeout;

export interface RuntimeDeps {
  logger: Logger;
  mongo: typeof MongoWrapper;
  minio: typeof MinioWrapper;
  memoryService: typeof MemoryService;
  changeStream: typeof ChangeStreamService;
  consolidation: typeof MemoryConsolidationService;
  housekeeping: typeof BackgroundHousekeepingService;
  registerCleanup: typeof registerCleanup;
  /** Background daemons; tests replace this list with fakes. */
  daemons: DaemonSpec[];
  env: {
    mongoUri: string | undefined;
    mongoDbName: string;
    tradingDbName: string;
    minioEndpoint?: string;
    minioAccessKey?: string;
    minioSecretKey?: string;
    minioBucketName?: string;
  };
  intervals: {
    consolidationMs: number;
    housekeepingMs: number;
  };
  /** `setInterval`/`clearInterval`, injectable so tests do not leak timers. */
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

/** One background service: start it, and stop it on shutdown if it returns a stopper. */
export interface DaemonSpec {
  name: string;
  start: () => Promise<{ stop: () => Promise<void> | void } | void>;
}

function lazyDaemon(name: string, load: () => Promise<{ init: () => Promise<void>; destroy: () => Promise<void> | void }>): DaemonSpec {
  return {
    name,
    start: async () => {
      const service = await load();
      await service.init();
      return { stop: () => service.destroy() };
    },
  };
}

/** The real daemon set. Every entry imports its module lazily: a broken module must not stop boot. */
export const DEFAULT_DAEMONS: DaemonSpec[] = [
  lazyDaemon("Scheduled Tasks", () => import("../services/ScheduledTaskService.ts").then((m) => m.default)),
  lazyDaemon("Conversation Timers", () => import("../services/ConversationTimerService.ts").then((m) => m.default)),
  lazyDaemon("Webhook Dispatcher", () => import("../services/WebhookDispatcher.ts").then((m) => m.default)),
  {
    name: "Somatic State",
    start: async () => {
      const { default: SomaticStateService } = await import("../services/somatic/SomaticStateService.ts");
      SomaticStateService.initialize();
      return { stop: () => SomaticStateService.persistAll() };
    },
  },
  lazyDaemon("vLLM Model Sync", () => import("../services/VllmModelSyncService.ts").then((m) => m.VllmModelSyncService)),
  {
    name: "Embedding Corpus",
    start: async () => {
      const { default: EmbeddingCorpusService } = await import("../services/EmbeddingCorpusService.ts");
      EmbeddingCorpusService.start();
      return { stop: () => EmbeddingCorpusService.stop() };
    },
  },
];

export function defaultRuntimeDeps(): RuntimeDeps {
  return {
    logger,
    mongo: MongoWrapper,
    minio: MinioWrapper,
    memoryService: MemoryService,
    changeStream: ChangeStreamService,
    consolidation: MemoryConsolidationService,
    housekeeping: BackgroundHousekeepingService,
    registerCleanup,
    daemons: DEFAULT_DAEMONS,
    env: {
      mongoUri: MONGO_URI as string | undefined,
      mongoDbName: MONGO_DB_NAME,
      tradingDbName: TRADING_MONGO_DB,
      minioEndpoint: MINIO_ENDPOINT,
      minioAccessKey: MINIO_ACCESS_KEY,
      minioSecretKey: MINIO_SECRET_KEY,
      minioBucketName: MINIO_BUCKET_NAME,
    },
    intervals: { consolidationMs: CONSOLIDATION_INTERVAL_MS, housekeepingMs: HOUSEKEEPING_INTERVAL_MS },
    setInterval,
    clearInterval,
  };
}

/**
 * Connect the primary database, then the trading one. The platform dashboard
 * reads `tool_usage_stats` out of the TRADING database, which is a different
 * database on the same server — and MongoManager keys its connections by NAME,
 * so a database nobody registered is not "empty", it THROWS:
 * `Database not connected: trading_bot`. Registered second on purpose:
 * MongoManager takes the FIRST connection as the default for name-less getDb()
 * calls, and that has to stay prism's. Failing to reach the trading DB is not
 * fatal — it is a dashboard, not the cycle — so its endpoints degrade to 503.
 */
export async function connectDatabases(deps: RuntimeDeps): Promise<void> {
  await deps.mongo.createClient(deps.env.mongoDbName, deps.env.mongoUri as string);
  if (!deps.env.mongoUri) return;
  try {
    await deps.mongo.createClient(deps.env.tradingDbName, deps.env.mongoUri);
  } catch (e) {
    deps.logger.error(
      `[Platform] trading database ${deps.env.tradingDbName} unavailable — ` +
        `/platform endpoints will answer 503: ${e}`,
    );
  }
}

/**
 * Create every index in `INDEX_DEFINITIONS`. All of them are issued at once and
 * each failure is reported by collection and keys — a failed unique index used
 * to be visible only as a count.
 */
export async function ensureCollectionIndexes(
  db: MongoDb,
  log: Logger = logger,
  definitions: IndexDefinition[] = INDEX_DEFINITIONS,
): Promise<{ created: number; failed: number }> {
  if (!db) return { created: 0, failed: 0 };
  const results = await Promise.allSettled(
    definitions.map((definition) =>
      db
        .collection(definition.collection)
        .createIndex(definition.keys, definition.options ?? {})
        .then(() => ({ collection: definition.collection, keys: definition.keys })),
    ),
  );
  const failed: Array<{ definition: IndexDefinition; reason: unknown }> = [];
  results.forEach((result, index) => {
    if (result.status === "rejected") failed.push({ definition: definitions[index], reason: result.reason });
  });
  for (const { definition, reason } of failed) {
    log.error(
      `Index creation failed for ${definition.collection} ` +
        `${JSON.stringify(definition.keys)}: ${String(reason)}`,
    );
  }
  if (failed.length > 0) log.warn(`${failed.length}/${definitions.length} indexes failed to create`);
  const created = definitions.length - failed.length;
  log.success(`Database indexes ensured (${created}/${definitions.length})`);
  return { created, failed: failed.length };
}

/** Clear `isGenerating` flags left over from a crash/restart, in both conversation collections. */
export async function clearStaleGenerationFlags(db: MongoDb, log: Logger = logger): Promise<number> {
  if (!db) return 0;
  const cleared = await db
    .collection(COLLECTIONS.MODEL_CONVERSATIONS)
    .updateMany({ isGenerating: true }, { $set: { isGenerating: false } });
  if (cleared.modifiedCount > 0) {
    log.info(`Cleared ${cleared.modifiedCount} stale isGenerating flag(s) in conversations`);
  }
  const agentCleared = await db
    .collection(COLLECTIONS.AGENT_CONVERSATIONS)
    .updateMany({ isGenerating: true }, { $set: { isGenerating: false } });
  if (agentCleared.modifiedCount > 0) {
    log.info(`Cleared ${agentCleared.modifiedCount} stale isGenerating flag(s) in agent_conversations`);
  }
  return cleared.modifiedCount + agentCleared.modifiedCount;
}

/** Load custom agents from the database into the persona registry (non-fatal). */
export async function loadCustomAgents(log: Logger = logger): Promise<boolean> {
  try {
    const { default: AgentPersonaRegistryCustom } = await import("../services/AgentPersonaRegistry.js");
    await AgentPersonaRegistryCustom.loadCustomAgents();
    return true;
  } catch (error: unknown) {
    log.warn(`Custom agent loading failed: ${errorMessage(error)}`);
    return false;
  }
}

/**
 * One consolidation sweep: every project with memories, every agent in it with
 * at least `MIN_MEMORIES_TO_CONSOLIDATE` memories. Sequential on purpose — each
 * consolidation loads the full corpus with embeddings (~12KB/memory) and
 * running them concurrently compounds heap usage and can OOM large collections.
 */
export async function consolidateAllProjects(
  db: MongoDb,
  consolidation: typeof MemoryConsolidationService,
  log: Logger = logger,
  minMemories = MIN_MEMORIES_TO_CONSOLIDATE,
): Promise<number> {
  if (!db) return 0;
  let consolidated = 0;
  const projects = await db.collection(COLLECTIONS.MEMORIES).distinct("project");
  for (const project of projects) {
    const agents = await db.collection(COLLECTIONS.MEMORIES).distinct("agent", { project });
    for (const agent of agents) {
      const count = await db.collection(COLLECTIONS.MEMORIES).countDocuments({ project, agent });
      if (count < minMemories) continue;
      log.info(
        `[AutoDream] Scheduled consolidation for agent "${agent}", project "${project}" (${count} memories)`,
      );
      try {
        await consolidation.consolidate({ agent, project, username: "system", trigger: "scheduled" });
        consolidated += 1;
      } catch (error: unknown) {
        log.error(`[AutoDream] Scheduled consolidation failed for "${agent}/${project}": ${errorMessage(error)}`);
      }
    }
  }
  return consolidated;
}

/** One consolidation tick, with its own error handling (a failed tick must not kill the interval). */
export async function runConsolidationSweep(deps: RuntimeDeps): Promise<number> {
  try {
    return await consolidateAllProjects(deps.mongo.getDb(deps.env.mongoDbName), deps.consolidation, deps.logger);
  } catch (error: unknown) {
    deps.logger.error(`[AutoDream] Scheduled consolidation sweep failed: ${errorMessage(error)}`);
    return 0;
  }
}

/** Register the 24h memory-consolidation interval; returns its handle. */
export function startConsolidationSweep(deps: RuntimeDeps): IntervalHandle {
  const handle = deps.setInterval(() => {
    void runConsolidationSweep(deps);
  }, deps.intervals.consolidationMs);
  deps.registerCleanup(async () => deps.clearInterval(handle));
  deps.logger.info(`[AutoDream] Scheduled consolidation every ${deps.intervals.consolidationMs / 3_600_000}h`);
  return handle;
}

/** One housekeeping tick, with its own error handling. */
export async function runHousekeepingSweep(deps: RuntimeDeps): Promise<void> {
  try {
    await deps.housekeeping.run({ trigger: "scheduled" });
  } catch (error: unknown) {
    deps.logger.error(`[Housekeeping] Scheduled run failed: ${errorMessage(error)}`);
  }
}

/** Register the 6h housekeeping interval; returns its handle. */
export function startHousekeepingSweep(deps: RuntimeDeps): IntervalHandle {
  const handle = deps.setInterval(() => {
    void runHousekeepingSweep(deps);
  }, deps.intervals.housekeepingMs);
  deps.registerCleanup(async () => deps.clearInterval(handle));
  deps.logger.info(`[Housekeeping] Scheduled cleanup every ${deps.intervals.housekeepingMs / 3_600_000}h`);
  return handle;
}

/** Start every daemon; one failing daemon never stops the rest. Returns the started names. */
export async function startDaemons(
  specs: DaemonSpec[],
  log: Logger = logger,
  register: typeof registerCleanup = registerCleanup,
): Promise<string[]> {
  const started: string[] = [];
  for (const spec of specs) {
    try {
      const stopper = await spec.start();
      if (stopper) register(async () => stopper.stop());
      started.push(spec.name);
    } catch (error: unknown) {
      log.error(`Failed to initialize ${spec.name}: ${errorMessage(error)}`);
    }
  }
  return started;
}

/** MinIO is optional: without all four secrets, files are stored inline in Mongo. */
export async function initMinio(deps: RuntimeDeps): Promise<boolean> {
  const { minioEndpoint, minioAccessKey, minioSecretKey, minioBucketName } = deps.env;
  if (!(minioEndpoint && minioAccessKey && minioSecretKey && minioBucketName)) {
    deps.logger.info("MinIO not configured — files will be stored inline in MongoDB");
    return false;
  }
  await deps.minio.init(minioEndpoint, minioAccessKey, minioSecretKey, minioBucketName);
  return true;
}

/**
 * Everything that must run before the port opens. Each step is idempotent and
 * logged; the non-fatal ones catch their own errors so a degraded subsystem
 * cannot take the process down at boot.
 */
export async function startRuntime(deps: RuntimeDeps = defaultRuntimeDeps()): Promise<void> {
  const db = () => deps.mongo.getDb(deps.env.mongoDbName);

  await connectDatabases(deps);
  await deps.memoryService.ensureIndexes();

  try {
    await ensureCollectionIndexes(db(), deps.logger);
  } catch (error: unknown) {
    deps.logger.error(`Failed to ensure indexes: ${errorMessage(error)}`);
  }

  try {
    await clearStaleGenerationFlags(db(), deps.logger);
  } catch (error: unknown) {
    deps.logger.error(`Failed to clear stale isGenerating flags: ${errorMessage(error)}`);
  }

  await loadCustomAgents(deps.logger);
  // Change Streams need a replica set; the service falls back gracefully.
  await deps.changeStream.init();

  startConsolidationSweep(deps);

  // Boot-time housekeeping: clean up orphans from previous crashes.
  deps.housekeeping.run({ trigger: "boot" }).catch((error: unknown) =>
    deps.logger.error(`[Housekeeping] Boot-time run failed: ${errorMessage(error)}`),
  );
  startHousekeepingSweep(deps);

  await startDaemons(deps.daemons, deps.logger, deps.registerCleanup);
  await initMinio(deps);
}

const MODALITY_COLORS: Record<string, number[]> = {
  text: [99, 102, 241], // #6366f1 — indigo
  image: [16, 185, 129], // #10b981 — emerald
  audio: [245, 158, 11], // #f59e0b — amber
  video: [244, 63, 94], // #f43f5e — rose
  pdf: [100, 116, 139], // #64748b — slate
  embedding: [6, 182, 212], // #06b6d4 — cyan
};

/** The startup banner: port, providers, coloured modalities, every endpoint. */
export function logStartupBanner(port: number, log: Logger = logger): void {
  log.success(`lazy-agent-service is running on port ${port}`);
  log.info("Available providers:", listProviderNames().join(", "));
  const coloredModalities = Object.entries(MODALITY_COLORS)
    .map(([modality, [r, g, b]]) => `\x1b[38;2;${r};${g};${b}m${modality}\x1b[0m`)
    .join(", ");
  log.info("Available modalities:", coloredModalities);
  for (const endpoint of ENDPOINTS.rest) log.info(`  REST  →  http://localhost:${port}${endpoint}`);
  for (const endpoint of ENDPOINTS.websocket) log.info(`  WS    →  ws://localhost:${port}${endpoint}`);
}

function listProviderNames(): string[] {
  return listProviders();
}

export interface ListeningDeps {
  runtime: HttpRuntime;
  logger: Logger;
  registerCleanup: typeof registerCleanup;
  loadProfiles: () => Promise<void>;
  evalChaosEnabled: () => boolean;
  registerEvalChaos: () => Promise<void>;
  syncPersonas: () => Promise<void>;
  connectMcpServers: () => Promise<void>;
}

/**
 * Work that only makes sense once the port is accepting connections: the
 * startup banner, profiles, eval-chaos, personas and the MCP server reconnects.
 * Nothing here throws; one broken step never blocks the next.
 */
export async function onListening(deps: ListeningDeps): Promise<void> {
  logStartupBanner(PORT, deps.logger);

  try {
    await deps.loadProfiles();
  } catch (error: unknown) {
    deps.logger.warn(`Failed eager profile loading at startup: ${errorMessage(error)}`);
  }

  if (deps.evalChaosEnabled()) {
    await deps.registerEvalChaos();
    deps.logger.warn(
      "[EvalChaos] LAS_EVAL_CHAOS=1: eval-chaos-v1 profile and global.eval_chaos.* tools are enabled",
    );
  }

  // Upsert the client personas our consuming apps run under. Native since
  // 2026-10-16 — prism-service is no longer registered with or called; the
  // personas live in our own custom_agents collection and the live registry.
  await deps.syncPersonas();

  // Reconnect every enabled MCP server so its tools are in the catalog
  // (connections are in-memory; prism does the same on boot).
  try {
    await deps.connectMcpServers();
  } catch (error: unknown) {
    deps.logger.warn(`MCP auto-connect failed: ${errorMessage(error)}`);
  }
}

export function defaultListeningDeps(runtime: HttpRuntime): ListeningDeps {
  return {
    runtime,
    logger,
    registerCleanup,
    loadProfiles: async () => {
      const { ProfileRegistry } = await import("../services/ProfileRegistry.ts");
      await ProfileRegistry.loadProfilesFromDisk();
    },
    evalChaosEnabled: () => evalChaosEnabled(),
    registerEvalChaos: async () => {
      const mod = await import("../services/EvalChaosCapabilities.ts");
      mod.registerEvalChaosCapabilities();
      await mod.registerEvalChaosProfile();
    },
    syncPersonas: async () => {
      const { syncClientPersonas } = await import("../services/ClientPersonaSync.ts");
      await syncClientPersonas();
    },
    connectMcpServers: async () => {
      const { default: MCPClientService } = await import("../services/MCPClientService.ts");
      await MCPClientService.connectAllFromDB(MongoWrapper.getDb(MONGO_DB_NAME));
    },
  };
}
