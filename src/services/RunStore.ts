import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import logger from "../utils/logger.ts";
import type { RunRecord, RunResult, RunState } from "../types/run.ts";
import { RunStateMachine } from "./RunStateMachine.ts";

export interface IdempotencyEntry {
  key: string;
  runId: string;
  status: "running" | "completed";
  result?: RunResult;
  expiresAt: number;
}

export class RunStore {
  private static runs: Map<string, RunRecord> = new Map();
  private static idempotency: Map<string, IdempotencyEntry> = new Map();
  private static persistenceFile: string = process.env.RUNTIME_STORE_PATH || path.resolve(
    process.cwd(),
    "data",
    "run_store_durable.json",
  );
  private static isInitialized = false;

  static setPersistenceFile(filePath: string): void {
    this.persistenceFile = filePath;
  }

  static async init(): Promise<void> {
    if (this.isInitialized) return;
    await this.loadFromDisk();
    this.isInitialized = true;
  }

  private static async loadFromDisk(): Promise<void> {
    try {
      if (fs.existsSync(this.persistenceFile)) {
        const content = fs.readFileSync(this.persistenceFile, "utf-8");
        const data = JSON.parse(content);
        if (Array.isArray(data.runs)) {
          for (const r of data.runs) {
            if (!RunStateMachine.isTerminal(r.status)) {
              r.status = "failed";
              r.completed_at = new Date().toISOString();
              r.error = { code: "RUN_INTERRUPTED", message: "Runtime restarted before completion; pending effects are not replayed", retryable: false, category: "RUNTIME" };
              r.events = [...(r.events || []), { id: `evt-${crypto.randomUUID()}`, run_id: r.run_id, type: "run.failed", timestamp: r.completed_at, data: { status: "failed", error: r.error } }];
            }
            this.runs.set(r.run_id, r);
          }
        }
        if (Array.isArray(data.idempotency)) {
          const now = Date.now();
          for (const item of data.idempotency) {
            if (item.expiresAt > now) {
              const run = this.runs.get(item.runId);
              if (run && RunStateMachine.isTerminal(run.status)) {
                item.status = "completed";
                item.result = { ...run, id: run.run_id };
              }
              this.idempotency.set(item.key, item);
            }
          }
        }
        await this.flushToDisk();
        logger.debug(
          `[RunStore] Loaded ${this.runs.size} runs and ${this.idempotency.size} idempotency records from disk`,
        );
      }
    } catch (err: any) {
      throw new Error("Durable run store could not be loaded; refusing to lose execution history", { cause: err });
    }
  }

  private static async flushToDisk(): Promise<void> {
    try {
      const dir = path.dirname(this.persistenceFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const now = Date.now();
      const validIdempotency = Array.from(this.idempotency.values()).filter(
        (i) => i.expiresAt > now,
      );
      const payload = {
        saved_at: new Date().toISOString(),
        runs: Array.from(this.runs.values()),
        idempotency: validIdempotency,
      };
      const temporary = `${this.persistenceFile}.tmp`;
      fs.writeFileSync(
        temporary,
        JSON.stringify(payload, null, 2),
        "utf-8",
      );
      fs.renameSync(temporary, this.persistenceFile);
    } catch (err: any) {
      throw new Error(`Run persistence failed: ${err.message}`);
    }
  }

  /**
   * Create and record a new RunRecord
   */
  static async createRun(record: RunRecord): Promise<void> {
    await this.init();
    this.runs.set(record.run_id, { ...record });
    await this.flushToDisk();
  }

  /**
   * Retrieve a RunRecord by ID
   */
  static async getRun(runId: string): Promise<RunRecord | null> {
    await this.init();
    const run = this.runs.get(runId);
    return run ? { ...run } : null;
  }

  static async appendEvent(event: import("../types/run.ts").RunEvent): Promise<void> {
    await this.init();
    if (!this.runs.has(event.run_id)) return; // Rejected admission has no admitted run.
    await this.mutateRun(event.run_id, run => ({ events: [...(run.events || []), event] }));
  }

  static async mutateRun(runId: string, mutate: (run: RunRecord) => Partial<RunRecord>): Promise<RunRecord> {
    await this.init();
    const current = this.runs.get(runId);
    if (!current) throw new Error("Run not found");
    const updates = mutate(current);
    if (updates.status && updates.status !== current.status) RunStateMachine.assertValidTransition(runId, current.status, updates.status);
    const updated = { ...current, ...updates };
    this.runs.set(runId, updated);
    await this.flushToDisk();
    return { ...updated };
  }

  /**
   * Update RunRecord fields
   */
  static async updateRun(
    runId: string,
    updates: Partial<RunRecord>,
  ): Promise<RunRecord> {
    await this.init();
    const current = this.runs.get(runId);
    if (!current) {
      throw new Error(`Run ${runId} not found in store`);
    }

    if (updates.status && updates.status !== current.status) {
      RunStateMachine.assertValidTransition(
        runId,
        current.status,
        updates.status,
      );
    }

    const updated: RunRecord = {
      ...current,
      ...updates,
    };

    this.runs.set(runId, updated);
    await this.flushToDisk();
    return { ...updated };
  }

  /**
   * Update status with state machine enforcement
   */
  static async updateState(
    runId: string,
    newState: RunState,
    additionalUpdates: Partial<RunRecord> = {},
  ): Promise<RunRecord> {
    return this.updateRun(runId, {
      status: newState,
      ...additionalUpdates,
    });
  }

  /**
   * Atomically reserve an idempotency key.
   */
  static async reserveIdempotencyKey(
    key: string,
    runId: string,
    ttlMs: number = 3600000,
  ): Promise<{
    success: boolean;
    conflict?: boolean;
    existingRunId?: string;
    cachedResult?: RunResult;
  }> {
    await this.init();
    const now = Date.now();
    const existing = this.idempotency.get(key);

    if (existing) {
      // Check TTL
      if (existing.expiresAt <= now) {
        this.idempotency.delete(key);
      } else if (existing.status === "running") {
        return {
          success: false,
          conflict: true,
          existingRunId: existing.runId,
        };
      } else if (existing.status === "completed" && existing.result) {
        return {
          success: false,
          conflict: false,
          cachedResult: existing.result,
        };
      }
    }

    // Key is free to acquire
    const entry: IdempotencyEntry = {
      key,
      runId,
      status: "running",
      expiresAt: now + ttlMs,
    };

    this.idempotency.set(key, entry);
    await this.flushToDisk();
    return { success: true };
  }

  /**
   * Seal terminal result into idempotency store
   */
  static async completeIdempotency(
    key: string,
    result: RunResult,
    ttlMs: number = 3600000,
  ): Promise<void> {
    await this.init();
    const now = Date.now();
    this.idempotency.set(key, {
      key,
      runId: result.run_id,
      status: "completed",
      result: { ...result },
      expiresAt: now + ttlMs,
    });
    await this.flushToDisk();
  }

  static async getIdempotency(key: string): Promise<IdempotencyEntry | null> {
    await this.init();
    const entry = this.idempotency.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.idempotency.delete(key);
      return null;
    }
    return { ...entry };
  }

  static clearAll(): void {
    this.runs.clear();
    this.idempotency.clear();
    try {
      if (fs.existsSync(this.persistenceFile)) {
        fs.unlinkSync(this.persistenceFile);
      }
    } catch {
      // Ignore
    }
    this.isInitialized = false;
  }

  static async reload(): Promise<void> {
    this.runs.clear();
    this.idempotency.clear();
    this.isInitialized = false;
    await this.init();
  }
}
