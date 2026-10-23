/**
 * Shared pieces of the Harness² improvement benchmark (documentation chapter 13 §10): an isolated
 * environment, a seeded invoice-reconciliation task family, a strict scorer, and the harnesses.
 * Import it BEFORE any service module: the service modules read the environment at import time.
 *
 * Isolation: run store, proxy sessions and libraries live under the caller's state directory or
 * an OS temp directory; VAULT_SERVICE_URL and MONGO_URI are unset (so workflow memory cannot carry
 * anything from one attempt to the next); fetch reaches only the Jetson, the Spark, the NAS
 * tools-service and localhost. The allowlist confines this process, not the solver: its
 * tools-service tools (read_url, execute_python, ...) run on the NAS.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const REPO = process.env.HARNESS2_EVAL_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const config = JSON.parse(fs.readFileSync(path.join(REPO, "projects.json"), "utf8")).config;
const jetson = String(config.JETSON_VLLM_URL).replace(/\/+$/, "");
const spark = String(config.DGX_SPARK_VLLM_URL).replace(/\/+$/, "");
/** The solver's tools-service tools (evaluate_expression and the rest of its catalog) run on the NAS. */
const TOOLS = process.env.HARNESS2_EVAL_TOOLS_URL || "http://10.0.0.16:5590";
export const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "harness2-eval-"));
delete process.env.VAULT_SERVICE_URL;
delete process.env.MONGO_URI;
process.env.RUNTIME_STORE_PATH = path.join(TMP, "run_store.json");
process.env.PRISM_PROXY_SESSIONS_FILE = path.join(TMP, "prism-proxy-sessions.json");
process.env.HARNESS2_LIBRARY_PATH = path.join(TMP, "library");
process.env.ALLOW_MISSING_PROJECTS_JSON = "1";
process.env.PROVIDER_VLLM_1_URL = jetson; // instance "vllm", as deployed
process.env.PROVIDER_VLLM_1_CONCURRENCY = "2";
process.env.PROVIDER_VLLM_2_URL = spark; // instance "vllm-2"
process.env.PROVIDER_VLLM_2_CONCURRENCY = "2";
process.env.TOOLS_SERVICE_URL = TOOLS;

const allowed = new Set([new URL(jetson).host, new URL(spark).host, new URL(TOOLS).host]);
export const blocked = new Map<string, number>();
// As boot.ts does: the provider client passes an undici dispatcher, which needs undici's own fetch.
const realFetch = createRequire(path.join(REPO, "package.json"))("undici").fetch as typeof fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(href);
  if (allowed.has(u.host) || ["127.0.0.1", "localhost"].includes(u.hostname)) return realFetch(input, init);
  blocked.set(u.host, (blocked.get(u.host) ?? 0) + 1);
  throw new Error(`harness2 eval: external fetch blocked: ${u.host}`);
}) as typeof fetch;
export const mod = (rel: string) => import(path.join(REPO, rel));
export const cleanup = () => fs.rmSync(TMP, { recursive: true, force: true });

/** Seeded PRNG (mulberry32), so every arm sees the same tasks. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VENDORS = ["Acme Supplies", "Brightline", "Coastal Freight", "Delta Office", "Evergreen Labs", "Harbor Tools", "Ironwood", "Juniper Media",
  "Keystone", "Lumen Power", "Northwind", "Orchid Print", "Pinecrest", "Quarry Works"];
const money = (cents: number) => (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface Task { id: string; text: string; totalCents: number; dups: string[]; rows: string[] }

/**
 * One reconciliation task: 4-5 distinct invoices, 2 exact repeats, 1 decoy (a different id with
 * another line's vendor and amount, which IS counted). Each repeat comes after its original.
 */
export function makeTask(index: number, seed = 20261023): Task {
  const r = rng(seed * 1000 + index);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const nDistinct = 4 + Math.floor(r() * 2);
  const base = 100 * (index + 3);
  const vendors = [...VENDORS].sort(() => r() - 0.5);
  const lines = Array.from({ length: nDistinct }, (_, i) => ({ id: `INV-${base + i + 1}`, vendor: vendors[i], cents: 5_000 + Math.floor(r() * 295_000) }));
  const like = pick(lines);
  lines.push({ id: `INV-${base + nDistinct + 1}`, vendor: like.vendor, cents: like.cents }); // decoy
  const order = [...lines].sort(() => r() - 0.5);
  const dupSources = [...lines].filter((l) => l !== lines[lines.length - 1]).sort(() => r() - 0.5).slice(0, 2);
  for (const d of dupSources) {
    const at = order.indexOf(d);
    order.splice(at + 1 + Math.floor(r() * (order.length - at)), 0, d);
  }
  const rows = order.map((l) => `| ${l.id} | ${l.vendor} | ${money(l.cents)} |`);
  const text =
    "Reconcile these invoice lines. A duplicate is a line whose invoice id already appeared; lines with different ids are " +
    "never duplicates, even when vendor and amount match. Report (1) the total of the de-duplicated lines and (2) every " +
    "duplicated invoice id. End your answer with exactly these two lines:\nTOTAL: <the total, with two decimals>\n" +
    "DUPLICATES: <the duplicated invoice ids, comma-separated>\n\n| invoice | vendor | amount |\n|---|---|---|\n" + rows.join("\n");
  return { id: `bench-${index}`, text, totalCents: lines.reduce((s, l) => s + l.cents, 0), dups: dupSources.map((d) => d.id).sort(), rows };
}

/** Strict score from the required closing lines (the last occurrence of each counts). */
export function score(raw: string, task: Task) {
  const output = raw.replace(/[*_`]/g, ""); // markdown emphasis around the label is not a format error
  const totals = [...output.matchAll(/TOTAL:\s*\$?\s*([\d,]+(?:\.\d+)?)/gi)];
  const dupLines = [...output.matchAll(/DUPLICATES:\s*([^\n]*)/gi)];
  const total = totals.length ? Math.round(Number(totals[totals.length - 1][1].replace(/,/g, "")) * 100) : NaN;
  const dups = dupLines.length ? [...new Set(dupLines[dupLines.length - 1][1].match(/INV-\d+/gi) ?? [])].map((s) => s.toUpperCase()).sort() : [];
  const totalOk = total === task.totalCents;
  const dupsOk = JSON.stringify(dups) === JSON.stringify(task.dups);
  return { correct: totalOk && dupsOk, totalOk, dupsOk, formatted: totals.length > 0 && dupLines.length > 0 };
}

/** Run jobs with at most `n` in flight. */
export async function pool<T>(n: number, jobs: Array<() => Promise<T>>): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  }));
  return out;
}

/** A deliberately weak base harness: "one sentence" fights a request for a total AND a list. */
export const BASE = { "systemprompt.md": "You are an accounts-payable assistant. Be brief: answer in one sentence.\n" };

/**
 * A neutral base harness: no handicap and no procedure. The loop must then improve a reasonable
 * prompt, rather than undo the weak base's "one sentence" rule (run.ts --base=neutral).
 */
export const NEUTRAL_BASE = { "systemprompt.md": "You are an accounts-payable assistant.\n" };

/** A hand-written reference harness (a ceiling to compare against, never part of the loop). */
export const HANDWRITTEN = {
  "systemprompt.md":
    "You are an accounts-payable assistant.\n\nTo reconcile invoice lines:\n" +
    "1. First write the kept lines, one per distinct invoice id, in table order. For an id that repeats, keep its FIRST line (it still counts once). A line whose vendor and amount match another line but whose id differs is its own kept line. Write how many kept lines there are.\n" +
    "2. Add the kept amounts with the evaluate_expression tool, one addition per call: operation \"add\", a = the running total (start with the first kept amount), b = the next kept amount. Keep going until every kept amount is in: that is (kept lines - 1) calls. Never add in your head.\n" +
    "3. End with the two lines the task asks for; TOTAL is the last result, written with two decimals.\n",
};

/**
 * Environment facts only: one tool's name, signature and what it does, not what to use it for.
 * "Among": the solver is offered ~50 tools (tools-service core domains, orchestrator tools,
 * execute_python); this names the one the hand-written harness uses.
 */
export const TOOL_NOTE =
  "Among the solver's tools is evaluate_expression(operation, a, b). It performs exact arbitrary-precision " +
  "arithmetic on two numbers; operation is one of add, subtract, multiply, divide, modulo, power, sqrt, and a and b are " +
  "passed as strings.";
