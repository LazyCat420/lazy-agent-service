/**
 * Harness² runs as background jobs (documentation ch.13 §6 item 8).
 *
 * - One active run per domain: a second run would read the library before the first one writes.
 * - Every run leaves a record at <libraryRoot>/<domain>/runs/<runId>.json: the request, then the
 *   whole result (stages, notes, rollouts, selection, raw reflection) or the error.
 * - The registry lives in this process; a record still "running" after a restart reads as
 *   "interrupted".
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import logger from "../../utils/logger.ts";
import { runHarness2, type Harness2Request, type Harness2Result } from "./Harness2Service.ts";
import { libraryRootOf, slug } from "./Library.ts";

export type RunStatus = "running" | "done" | "cancelled" | "error" | "interrupted";

export interface RunRecord {
  runId: string;
  taskId: string;
  domain: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  request: Omit<Harness2Request, "libraryRoot">;
  result?: Harness2Result;
  error?: string;
}

type Runner = typeof runHarness2;

interface Job {
  record: RunRecord;
  controller: AbortController;
  done: Promise<RunRecord>;
}

/** Finished jobs kept in memory for polling; older ones are read back from disk. */
const KEEP_FINISHED = 50;
const RUN_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,200}$/;

const jobs = new Map<string, Job>();
const activeByDomain = new Map<string, string>();
let runner: Runner = runHarness2;

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const recordPath = (root: string, domain: string, runId: string) => path.join(root, slug(domain), "runs", `${runId}.json`);

/** Tests swap in a fake runner; `undefined` restores the real one. */
export function setRunnerForTests(fn?: Runner): void {
  runner = fn ?? runHarness2;
}

function persist(root: string, record: RunRecord): void {
  try {
    const file = recordPath(root, record.domain, record.runId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2), "utf8");
    fs.renameSync(`${file}.tmp`, file);
  } catch (error) {
    logger.warn(`[harness2] run record ${record.runId} not written: ${errText(error)}`);
  }
}

function forgetOldFinished(): void {
  const finished = [...jobs.values()].filter((j) => j.record.status !== "running");
  for (const job of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) jobs.delete(job.record.runId);
}

/** The run id holding `domain`, if one is running. */
export function activeRun(domain: string): string | undefined {
  return activeByDomain.get(slug(domain));
}

/** Start a run in the background, or report the run that already holds the domain. */
export function startRun(req: Harness2Request): { record: RunRecord } | { conflict: string } {
  const key = slug(req.domain);
  const busy = activeByDomain.get(key);
  if (busy) return { conflict: busy };
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  const runId = `${slug(req.taskId).replace(/\./g, "_")}-${stamp}-${randomBytes(3).toString("hex")}`;
  const root = libraryRootOf(req.libraryRoot);
  const { libraryRoot: _root, ...request } = req;
  const record: RunRecord = { runId, taskId: req.taskId, domain: req.domain, status: "running", startedAt: new Date().toISOString(), request };
  const controller = new AbortController();
  activeByDomain.set(key, runId);
  persist(root, record);
  const done = runner(req, { signal: controller.signal })
    .then((result) => {
      record.result = result;
      record.status = result.status === "cancelled" ? "cancelled" : "done";
    })
    .catch((error) => {
      record.status = controller.signal.aborted ? "cancelled" : "error";
      record.error = errText(error);
      logger.warn(`[harness2] run ${runId} failed: ${record.error}`);
    })
    .then(() => {
      record.finishedAt = new Date().toISOString();
      persist(root, record);
      activeByDomain.delete(key);
      forgetOldFinished();
      return record;
    });
  jobs.set(runId, { record, controller, done });
  return { record };
}

/** A run's record: from memory, else from disk under any domain of the library root. */
export function getRun(runId: string, root?: string): RunRecord | null {
  if (!RUN_ID_RE.test(runId)) return null;
  const job = jobs.get(runId);
  if (job) return job.record;
  const base = libraryRootOf(root);
  if (!fs.existsSync(base)) return null;
  for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
    const file = path.join(base, ent.name, "runs", `${runId}.json`);
    if (!ent.isDirectory() || !fs.existsSync(file)) continue;
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as RunRecord;
    // Not in this process's registry, so whatever ran it is gone.
    return record.status === "running" ? { ...record, status: "interrupted" } : record;
  }
  return null;
}

/** Abort a running run; false when it is unknown here or already finished. */
export function cancelRun(runId: string): boolean {
  const job = jobs.get(runId);
  if (!job || job.record.status !== "running") return false;
  job.controller.abort(new Error("cancelled"));
  return true;
}

/** Resolves with the final record once the run finishes. */
export function waitRun(runId: string): Promise<RunRecord> | null {
  return jobs.get(runId)?.done ?? null;
}
