/**
 * Why answers were wrong (documentation chapter 13 §10): classifies every wrong TOTAL in a
 * harness2-eval state file as a repeat counted twice, the decoy (or its twin) left out, another
 * line left out, or an arithmetic slip. Reads results only; makes no model calls.
 *
 *   testrun --mem 1G -- npx tsx scripts/harness2-eval/anatomy.ts <state>/units.json [...]
 */
import fs from "node:fs";
import path from "node:path";
const { makeTask, cleanup } = await import("./common.ts");

const cents = (s: string) => Math.round(Number(s.replace(/,/g, "")) * 100);
const out: Record<string, Record<string, number>> = {};
for (const file of process.argv.slice(2)) {
  const units = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const [key, u] of Object.entries<any>(units)) {
    const [arm, taskId] = key.split("/");
    const task = makeTask(Number(taskId.split("-")[1]));
    const lines = task.rows.map((r: string) => r.split("|").map((c) => c.trim()).filter(Boolean)).map(([id, vendor, amt]: string[]) => ({ id, vendor, c: cents(amt) }));
    const seen = new Set<string>();
    const kept = lines.filter((l: any) => (seen.has(l.id) ? false : (seen.add(l.id), true)));
    const repeats = lines.filter((l: any, i: number) => lines.findIndex((m: any) => m.id === l.id) !== i);
    const decoy = kept.find((l: any, i: number) => kept.some((m: any, j: number) => j < i && m.vendor === l.vendor && m.c === l.c));
    // A state directory's units.json is named after its run (s2/units.json → "s2"), a copy after its file (s2-units.json).
    const run = path.basename(file) === "units.json" ? path.basename(path.dirname(file)) : path.basename(file, ".json").replace(/-units$/, "");
    const name = `${run} ${arm}`;
    const bucket = (out[name] ??= {});
    for (const a of u.attempts ?? []) {
      if (a.correct) { bucket.right = (bucket.right ?? 0) + 1; continue; }
      const m = [...String(a.tail).replace(/[*_`]/g, "").matchAll(/TOTAL:\s*\$?\s*([\d,]+(?:\.\d+)?)/gi)].pop();
      let why = "no total";
      if (m) {
        const d = cents(m[1]) - task.totalCents;
        if (repeats.some((l: any) => l.c === d)) why = "counted a repeat twice";
        else if (decoy && -d === decoy.c) why = "left out the decoy";
        else if (kept.some((l: any) => -l.c === d)) why = "left out another line";
        else if (Math.abs(d) < 100) why = "arithmetic, off < $1";
        else why = "arithmetic, off ≥ $1";
      }
      bucket[why] = (bucket[why] ?? 0) + 1;
    }
  }
}
for (const [arm, b] of Object.entries(out)) console.log(arm.padEnd(22), JSON.stringify(b));
cleanup();
process.exit(0);
