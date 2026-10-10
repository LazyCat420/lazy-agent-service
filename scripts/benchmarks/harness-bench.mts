#!/usr/bin/env node
/**
 * Harness micro-benchmark with 95% confidence intervals (improvement item 9).
 *
 * Benches the pure hot paths a harness change can regress — context
 * normalization, truncation, micro-compaction — and prints mean ± 95% CI so a
 * "faster/slower" claim has a number behind it. Run under testrun:
 *   testrun -- pnpm exec tsx scripts/benchmarks/harness-bench.mts [reps]
 */
import { performance } from "node:perf_hooks";
import { meanWithCI } from "../../src/utils/ConfidenceInterval.ts";
import { truncateAndStore } from "../../src/services/WebExtractService.ts";
import { normalizeRoleAlternation } from "../../src/services/RoleAlternation.ts";
import MicroCompactionService from "../../src/services/compact/MicroCompactionService.ts";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

const REPS = Math.max(10, Number(process.argv[2]) || 50);

function syntheticPage(chars: number): string {
  const line = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod.\n";
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
}

function syntheticMessages(turns: number) {
  const messages: any[] = [{ role: "system", content: "You are a trading analyst." }];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: `Turn ${i}: analyze the tape.` });
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [{ id: `t${i}`, name: "lazy_web_search", args: { query: "lulu price" }, result: syntheticPage(40_000) }],
    });
  }
  return messages;
}

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-bench-"));
const bigPage = syntheticPage(120_000);
const messy = [
  { role: "system", content: "sys" },
  { role: "user", content: "a" },
  { role: "user", content: "b" },
  { role: "assistant", content: "", toolCalls: [{ id: "1", name: "x", args: {}, result: "r" }] },
  { role: "assistant", content: "second assistant in a row" },
];

type Case = { name: string; run: () => unknown };
const cases: Case[] = [
  { name: "truncateAndStore(120k chars → 15k budget)", run: () => truncateAndStore(bigPage, 15_000) },
  { name: "normalizeRoleAlternation(5 messages)", run: () => normalizeRoleAlternation(messy as any) },
  {
    name: "MicroCompactionService.microcompactMessages(20 turns)",
    run: () => MicroCompactionService.microcompactMessages(syntheticMessages(20) as any, 5),
  },
];

const rows: string[] = [];
for (const c of cases) {
  // warmup
  for (let i = 0; i < 3; i++) c.run();
  const samples: number[] = [];
  for (let i = 0; i < REPS; i++) {
    const t0 = performance.now();
    c.run();
    samples.push(performance.now() - t0);
  }
  const r = meanWithCI(samples);
  rows.push(`${c.name.padEnd(48)} ${r.mean.toFixed(3).padStart(8)} ms ± ${r.halfWidth.toFixed(3)} (n=${r.n})`);
}

fs.rmSync(storeDir, { recursive: true, force: true });

console.log(`harness-bench: ${REPS} reps per case`);
for (const row of rows) console.log("  " + row);
