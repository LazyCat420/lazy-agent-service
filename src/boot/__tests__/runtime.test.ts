/**
 * Boot sequence — every step is a separate function so a degraded subsystem
 * cannot silently take the process down and so each step can be exercised
 * without Mongo, MinIO or a port. These tests drive the real functions with
 * fake deps and assert the observable effects: what was connected, which
 * indexes were attempted, which cleanup ran, which failures were tolerated.
 */
import { describe, expect, it, vi } from "vitest";
import type { Db } from "mongodb";

import {
  clearStaleGenerationFlags,
  connectDatabases,
  consolidateAllProjects,
  ensureCollectionIndexes,
  initMinio,
  logStartupBanner,
  onListening,
  startDaemons,
  runConsolidationSweep,
  runHousekeepingSweep,
  startConsolidationSweep,
  startHousekeepingSweep,
  startRuntime,
  type DaemonSpec,
  type ListeningDeps,
  type RuntimeDeps,
} from "../runtime.ts";
import { INDEX_DEFINITIONS } from "../indexes.ts";
import { ENDPOINTS } from "../server.ts";
import { COLLECTIONS } from "../../constants.ts";

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
  } as unknown as RuntimeDeps["logger"];
}

interface FakeDbOptions {
  failIndexes?: string[];
  isGenerating?: { conversations: number; agentConversations: number };
  projects?: string[];
  agentsByProject?: Record<string, string[]>;
  counts?: Record<string, number>;
}

function makeDb(options: FakeDbOptions = {}): Db {
  const created: Array<{ collection: string; keys: unknown }> = [];
  const db = {
    collection(name: string) {
      return {
        createIndex: async (keys: Record<string, number>) => {
          if (options.failIndexes?.includes(name)) throw new Error(`E11000 ${name}`);
          created.push({ collection: name, keys });
          return name;
        },
        updateMany: async () => ({
          modifiedCount:
            name === COLLECTIONS.MODEL_CONVERSATIONS
              ? options.isGenerating?.conversations ?? 0
              : options.isGenerating?.agentConversations ?? 0,
        }),
        distinct: async (field: string, filter?: { project?: string }) => {
          if (field === "project") return options.projects ?? [];
          const project = filter?.project ?? "";
          return options.agentsByProject?.[project] ?? [];
        },
        countDocuments: async (filter: { project: string; agent: string }) =>
          options.counts?.[`${filter.project}/${filter.agent}`] ?? 0,
      };
    },
    __created: created,
  } as unknown as Db;
  return db;
}

/** The fakes, so tests drive them by name instead of casting the deps object. */
function makeFakes() {
  return {
    createClient: vi.fn<(name: string, uri: string) => Promise<unknown>>(async () => undefined),
    getDb: vi.fn(() => makeDb()),
    minioInit: vi.fn<(endpoint: string, access: string, secret: string, bucket: string) => Promise<unknown>>(async () => undefined),
    ensureIndexes: vi.fn<() => Promise<void>>(async () => undefined),
    changeStreamInit: vi.fn<() => Promise<void>>(async () => undefined),
    consolidate: vi.fn<(args: { agent: string; project: string; username: string; trigger: string }) => Promise<void>>(async () => undefined),
    housekeepingRun: vi.fn<(opts: { trigger: string }) => Promise<void>>(async () => undefined),
    clearInterval: vi.fn(),
    intervals: [] as Array<{ fn: () => void }>,
  };
}

function makeDeps(overrides: Partial<RuntimeDeps> = {}) {
  const cleanups: Array<() => Promise<void>> = [];
  const fakes = makeFakes();
  const deps: RuntimeDeps = {
    logger: makeLog(),
    mongo: { createClient: fakes.createClient, getDb: fakes.getDb } as unknown as RuntimeDeps["mongo"],
    minio: { init: fakes.minioInit } as unknown as RuntimeDeps["minio"],
    memoryService: { ensureIndexes: fakes.ensureIndexes } as unknown as RuntimeDeps["memoryService"],
    changeStream: { init: fakes.changeStreamInit } as unknown as RuntimeDeps["changeStream"],
    consolidation: { consolidate: fakes.consolidate } as unknown as RuntimeDeps["consolidation"],
    housekeeping: { run: fakes.housekeepingRun } as unknown as RuntimeDeps["housekeeping"],
    registerCleanup: (fn) => {
      cleanups.push(fn);
    },
    daemons: [],
    env: {
      mongoUri: "mongodb://localhost:27017",
      mongoDbName: "prism",
      tradingDbName: "trading_bot",
    },
    intervals: { consolidationMs: 1_000, housekeepingMs: 2_000 },
    setInterval: ((fn: () => void) => {
      const handle = { fn };
      fakes.intervals.push(handle);
      return handle;
    }) as unknown as typeof setInterval,
    clearInterval: fakes.clearInterval as unknown as typeof clearInterval,
    ...overrides,
  };
  return { deps, cleanups, fakes };
}

describe("connectDatabases", () => {
  it("connects the primary database first, then the trading one", async () => {
    const { deps, fakes } = makeDeps();
    const order: string[] = [];
    fakes.createClient.mockImplementation(async (name: string) => {
      order.push(name);
    });

    await connectDatabases(deps);

    expect(order).toEqual(["prism", "trading_bot"]);
  });

  it("keeps booting when the trading database is unreachable", async () => {
    const { deps, fakes } = makeDeps();
    fakes.createClient.mockImplementation(async (name: string) => {
      if (name === "trading_bot") throw new Error("Database not connected: trading_bot");
    });

    await expect(connectDatabases(deps)).resolves.toBeUndefined();
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("/platform endpoints will answer 503"),
    );
  });

  it("skips the trading connection when there is no Mongo URI", async () => {
    const { deps, fakes } = makeDeps({ env: { mongoUri: undefined, mongoDbName: "prism", tradingDbName: "trading_bot" } });

    await connectDatabases(deps);

    expect(fakes.createClient).toHaveBeenCalledTimes(1);
  });
});

describe("ensureCollectionIndexes", () => {
  it("creates every declared index and reports the count", async () => {
    const db = makeDb();
    const log = makeLog();

    const result = await ensureCollectionIndexes(db, log);

    expect(result).toEqual({ created: INDEX_DEFINITIONS.length, failed: 0 });
    expect(log.success).toHaveBeenCalledWith(
      `Database indexes ensured (${INDEX_DEFINITIONS.length}/${INDEX_DEFINITIONS.length})`,
    );
  });

  it("names the collection and keys of a failed index instead of only counting it", async () => {
    const target = INDEX_DEFINITIONS[0];
    const db = makeDb({ failIndexes: [target.collection] });
    const log = makeLog();

    const result = await ensureCollectionIndexes(db, log);

    expect(result.failed).toBeGreaterThan(0);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining(target.collection));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("indexes failed to create"));
  });

  it("is a no-op without a database", async () => {
    const log = makeLog();
    const result = await ensureCollectionIndexes(null, log);
    expect(result).toEqual({ created: 0, failed: 0 });
    expect(log.success).not.toHaveBeenCalled();
  });
});

describe("clearStaleGenerationFlags", () => {
  it("clears both conversation collections and reports each count", async () => {
    const db = makeDb({ isGenerating: { conversations: 3, agentConversations: 2 } });
    const log = makeLog();

    const cleared = await clearStaleGenerationFlags(db, log);

    expect(cleared).toBe(5);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("3 stale isGenerating flag(s) in conversations"));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("2 stale isGenerating flag(s) in agent_conversations"));
  });

  it("stays quiet when nothing was stale", async () => {
    const log = makeLog();
    expect(await clearStaleGenerationFlags(makeDb(), log)).toBe(0);
    expect(log.info).not.toHaveBeenCalled();
  });
});

describe("consolidateAllProjects", () => {
  it("skips agents under the memory floor and consolidates the rest", async () => {
    const db = makeDb({
      projects: ["sun"],
      agentsByProject: { sun: ["a1", "a2"] },
      counts: { "sun/a1": 4, "sun/a2": 25 },
    });
    const consolidation = { consolidate: vi.fn(async () => undefined) } as unknown as RuntimeDeps["consolidation"];

    const consolidated = await consolidateAllProjects(db, consolidation, makeLog());

    expect(consolidated).toBe(1);
    expect(consolidation.consolidate).toHaveBeenCalledWith({
      agent: "a2",
      project: "sun",
      username: "system",
      trigger: "scheduled",
    });
  });

  it("keeps sweeping after one agent fails", async () => {
    const db = makeDb({
      projects: ["sun"],
      agentsByProject: { sun: ["a1", "a2"] },
      counts: { "sun/a1": 20, "sun/a2": 20 },
    });
    const consolidation = {
      consolidate: vi.fn(async ({ agent }: { agent: string }) => {
        if (agent === "a1") throw new Error("boom");
      }),
    } as unknown as RuntimeDeps["consolidation"];
    const log = makeLog();

    const consolidated = await consolidateAllProjects(db, consolidation, log);

    expect(consolidated).toBe(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('"a1/sun"'));
  });
});

describe("startDaemons", () => {
  it("starts each daemon and registers its stopper", async () => {
    const stops: string[] = [];
    const specs: DaemonSpec[] = [
      { name: "one", start: async () => ({ stop: () => stops.push("one") }) },
      { name: "two", start: async () => undefined },
    ];
    const cleanups: Array<() => Promise<void>> = [];

    const started = await startDaemons(specs, makeLog(), (fn) => {
      cleanups.push(fn);
    });

    expect(started).toEqual(["one", "two"]);
    expect(cleanups).toHaveLength(1);
    await cleanups[0]();
    expect(stops).toEqual(["one"]);
  });

  it("does not let one broken daemon stop the others", async () => {
    const log = makeLog();
    const specs: DaemonSpec[] = [
      { name: "broken", start: async () => { throw new Error("no module"); } },
      { name: "fine", start: async () => undefined },
    ];

    const started = await startDaemons(specs, log, () => undefined);

    expect(started).toEqual(["fine"]);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Failed to initialize broken"));
  });
});

describe("initMinio", () => {
  it("initialises MinIO when all four secrets are present", async () => {
    const { deps, fakes } = makeDeps({
      env: {
        mongoUri: "mongodb://localhost",
        mongoDbName: "prism",
        tradingDbName: "trading_bot",
        minioEndpoint: "minio:9000",
        minioAccessKey: "a",
        minioSecretKey: "b",
        minioBucketName: "files",
      },
    });

    await expect(initMinio(deps)).resolves.toBe(true);
    expect(fakes.minioInit).toHaveBeenCalledWith("minio:9000", "a", "b", "files");
  });

  it("falls back to inline storage when a secret is missing", async () => {
    const { deps, fakes } = makeDeps();

    await expect(initMinio(deps)).resolves.toBe(false);
    expect(fakes.minioInit).not.toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith(
      "MinIO not configured — files will be stored inline in MongoDB",
    );
  });
});

describe("startRuntime", () => {
  it("runs the whole boot order and survives a failing index step", async () => {
    const calls: string[] = [];
    const { deps, cleanups, fakes } = makeDeps();
    fakes.createClient.mockImplementation(async (name: string) => {
      calls.push(`connect:${name}`);
    });
    fakes.getDb.mockImplementation(() => {
      throw new Error("db unavailable");
    });
    fakes.ensureIndexes.mockImplementation(async () => {
      calls.push("indexes:memory");
    });
    fakes.changeStreamInit.mockImplementation(async () => {
      calls.push("change-streams");
    });

    await startRuntime(deps);

    expect(calls).toEqual(["connect:prism", "connect:trading_bot", "indexes:memory", "change-streams"]);
    expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining("Failed to ensure indexes"));
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to clear stale isGenerating flags"),
    );
    // Two intervals registered (consolidation + housekeeping) plus cleanup.
    expect(fakes.intervals).toHaveLength(2);
    expect(cleanups.length).toBeGreaterThanOrEqual(2);
    expect(fakes.housekeepingRun).toHaveBeenCalledWith({ trigger: "boot" });
  });
});

describe("interval sweeps", () => {
  it("runs a consolidation tick and clears the interval on shutdown", async () => {
    const { deps, cleanups, fakes } = makeDeps();
    const handle = startConsolidationSweep(deps);

    await runConsolidationSweep(deps);
    expect(fakes.consolidate).not.toHaveBeenCalled(); // the fake db has no projects

    await cleanups[0]();
    expect(fakes.clearInterval).toHaveBeenCalledWith(handle);
  });

  it("swallows a tick failure and keeps the interval alive", async () => {
    const { deps, fakes } = makeDeps();
    fakes.getDb.mockImplementation(() => {
      throw new Error("mongo gone");
    });

    await expect(runConsolidationSweep(deps)).resolves.toBe(0);
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Scheduled consolidation sweep failed"),
    );
  });

  it("runs a housekeeping tick and logs a failed run", async () => {
    const { deps, fakes } = makeDeps();
    fakes.housekeepingRun.mockImplementation(() => Promise.reject(new Error("housekeeping boom")));
    startHousekeepingSweep(deps);

    await runHousekeepingSweep(deps);

    expect(fakes.housekeepingRun).toHaveBeenCalledWith({ trigger: "scheduled" });
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Scheduled run failed"),
    );
  });
});

describe("logStartupBanner", () => {
  it("prints the port, providers, modalities and every endpoint", () => {
    const log = makeLog();

    logStartupBanner(7778, log);

    expect(log.success).toHaveBeenCalledWith("lazy-agent-service is running on port 7778");
    expect(log.info).toHaveBeenCalledWith("Available providers:", expect.any(String));
    expect(log.info).toHaveBeenCalledWith("Available modalities:", expect.stringContaining("\x1b[38;2;"));
    for (const endpoint of ENDPOINTS.rest) {
      expect(log.info).toHaveBeenCalledWith(`  REST  →  http://localhost:7778${endpoint}`);
    }
  });
});

describe("onListening", () => {
  function makeListening(overrides: Partial<ListeningDeps> = {}) {
    const cleanups: Array<() => Promise<void>> = [];
    const deps: ListeningDeps = {
      runtime: { mcpAdapter: {} } as unknown as ListeningDeps["runtime"],
      logger: makeLog(),
      registerCleanup: (fn) => {
        cleanups.push(fn);
      },
      loadProfiles: vi.fn(async () => undefined),
      evalChaosEnabled: () => false,
      registerEvalChaos: vi.fn(async () => undefined),
      syncPersonas: vi.fn(async () => undefined),
      connectMcpServers: vi.fn(async () => undefined),
      ...overrides,
    };
    return Object.assign(deps, { cleanups });
  }

  it("logs the banner, syncs personas and reconnects MCP servers", async () => {
    const deps = makeListening();

    await onListening(deps);

    expect(deps.logger.info).toHaveBeenCalled();
    expect(deps.syncPersonas).toHaveBeenCalled();
    expect(deps.connectMcpServers).toHaveBeenCalled();
  });

  it("keeps going when profile loading fails", async () => {
    const deps = makeListening({
      loadProfiles: async () => {
        throw new Error("bad profiles.json");
      },
    });

    await onListening(deps);

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed eager profile loading"),
    );
    expect(deps.syncPersonas).toHaveBeenCalled();
  });

  it("registers eval-chaos only when the flag is on", async () => {
    const off = makeListening();
    await onListening(off);
    expect(off.registerEvalChaos).not.toHaveBeenCalled();

    const on = makeListening({ evalChaosEnabled: () => true });
    await onListening(on);
    expect(on.registerEvalChaos).toHaveBeenCalled();
    expect(on.logger.warn).toHaveBeenCalledWith(expect.stringContaining("[EvalChaos]"));
  });

  it("logs a failed MCP reconnect without failing boot", async () => {
    const deps = makeListening({
      connectMcpServers: async () => {
        throw new Error("mcp down");
      },
    });

    await onListening(deps);

    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("MCP auto-connect failed"));
  });
});
