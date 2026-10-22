// Harness² loop audit repro (documentation chapter 13, 2026-10-22).
// Exercises the REAL src/services/harness2 modules with fake executor/proposer deps: no network,
// no model calls. Library writes go to an OS temp dir that is removed on every exit path.
// Each check prints one `R<n>` line: CONFIRMED = the audited defect still reproduces.
// Run from the repo root on the primary checkout:  testrun --mem 2G -- npx tsx scripts/audit-harness2-loop.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (["127.0.0.1", "localhost"].includes(new URL(href).hostname)) return realFetch(input, init);
  throw new Error(`external fetch blocked in audit repro: ${href}`);
}) as typeof fetch;

// Point every store a service module could persist to at the temp dir (as test/isolation.ts does),
// so a run on a shared checkout cannot write into it. Set before the dynamic imports below.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "harness2-audit-"));
process.env.RUNTIME_STORE_PATH = path.join(TMP, "run_store.json");
process.env.PRISM_PROXY_SESSIONS_FILE = path.join(TMP, "prism-proxy-sessions.json");
process.env.HARNESS2_LIBRARY_PATH = path.join(TMP, "library-default");

// Dynamic imports so the fetch stub and env are in place before any service module loads.
const mod = (name: string) => import(new URL(`../src/services/harness2/${name}.ts`, import.meta.url).href);
const T = await mod("HarnessTree");
const R = await mod("Recursion");
const L = await mod("Library");
const S = await mod("Harness2Service");

// Checks whose claim needs a selector call at k=1 (R1, R5, R18, R19) pass selectionPool "mixed": since
// the finals-only default (ch.13 §6 Q1) a k=1 pool holds one final and is delivered without a selector.
const lines: string[] = [];
const report = (id: string, title: string, confirmed: boolean, observed: string) => {
  const line = `${id} [${confirmed ? "CONFIRMED" : "NOT REPRODUCED"}] ${title} :: ${observed}`;
  lines.push(line);
  console.log(line);
};
const check = async (id: string, title: string, fn: () => Promise<[boolean, string]> | [boolean, string]) => {
  try {
    const [ok, obs] = await fn();
    report(id, title, ok, obs);
  } catch (error) {
    report(id, title, false, `check crashed: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const BASE = { "systemprompt.md": "You are a careful analyst.\n" };
const SKILL = (name: string) => `---\nname: ${name}\ndescription: checks totals\n---\nAdd the rows, compare to the total.\n`;
const editReply = `<file path="systemprompt.md">You are a careful analyst. When totals appear, use the \`totals\` skill.</file>
<file path="skills/totals/SKILL.md">${SKILL("totals")}</file>
<notes>base rollout 1 reported 41 against rows summing to 42</notes>`;
const EXP_OK = `<edits>component: skills/totals/SKILL.md\nverdict: helped</edits>
<experience>
cue: a deliverable reports a total over listed rows
lesson: add a totals skill triggered from systemprompt.md
evidence: dom1 rollout reported 42 vs base 41
confidence: medium, one rollout each
</experience>`;
const execOK = async (tree: Record<string, string>) => {
  const output = T.materialize(tree).includes("Add the rows") ? "total: 42 (checked)" : "total: 41";
  return { ok: true, delivered: true, output, trajectory: `final output:\n${output}`, error: "" };
};
// transportBackoffMs 0: the transport retry (ch.13 §6 item 3) would otherwise sleep 10 s per failed call.
const deps = (propose: any, execute: any = execOK) => ({ bp: { work: "Sum the rows." }, execute, propose, baseTree: BASE, width: 2, transportBackoffMs: 0 });
const req = (over: Record<string, unknown> = {}) => ({
  taskId: "t1", task: "Sum the rows.", domain: "finance", baseTree: BASE, solver: { provider: "x", model: "y" }, k: 1,
  libraryRoot: path.join(TMP, `lib-${Math.random().toString(36).slice(2)}`), ...over,
});

try {
// R1 — the selection order ignores the task: with the default seed every task gets the same permutation,
// so a selector with a first-position bias always lands on the same harness.
await check("R1", "blind-selection order is identical for every task (seed defaults to 0)", async () => {
  const picks: Record<string, number> = {};
  for (let i = 0; i < 12; i++) {
    const r = await S.runHarness2(req({ taskId: `task-${i}`, selectionPool: "mixed" }), {
      execute: execOK,
      propose: async (_p: string, label: string) =>
        label === "select" ? "<why>first one</why>\n```choice\na1\n```" : label === "experience" ? "NO_ENTRY" : label.startsWith("dom") || label.startsWith("agg") ? editReply : "<notes>KEEP_BASE</notes>",
    });
    picks[r.selection.chosenLabel] = (picks[r.selection.chosenLabel] || 0) + 1;
  }
  const order2 = S.shuffle(["base1", "agg1"], 0).join(",");
  return [Object.keys(picks).length === 1, `12 distinct tasks, selector always answers a1 -> picks ${JSON.stringify(picks)}; shuffle([base1,agg1], 0) = [${order2}]`];
});

// R2 — an empty improver reply is indistinguishable from a deliberate KEEP_BASE.
await check("R2", "empty proposer reply is recorded as KEEP_BASE, not as a failure", async () => {
  const d = deps(async () => "");
  const r = await R.runParallel(1, await R.rollBase(d, 1), d);
  const s = r.stages.map((x: any) => `${x.label}:keptBase=${x.keptBase},fellBack=${x.fellBack},notes=${JSON.stringify(x.notes)}`);
  return [r.stages.every((x: any) => x.keptBase && !x.fellBack), s.join(" ")];
});

// R3 — a reply cut off mid-file is accepted; a complete first block plus a truncated second block is
// half-applied and still passes validation.
await check("R3", "truncated proposer reply is silently half-applied or read as KEEP_BASE", async () => {
  const half = `<file path="systemprompt.md">You are a careful analyst. When totals appear, use the \`totals\` skill.</file>\n<file path="skills/totals/SKILL.md">---\nname: totals\ndescription: checks to`;
  const st = await R.runStage({ label: "dom1", dim: "DOM", job: "job", fallback: BASE, base: [], deps: deps(async () => half) });
  const skills = T.skillNames(st.tree);
  return [!st.fellBack && skills.length === 0 && st.tree["systemprompt.md"].includes("`totals` skill"),
    `fellBack=${st.fellBack} keptBase=${st.keptBase}; accepted tree tells the agent to use \`totals\` but has skills=[${skills.join(",")}]`];
});

// R4 — nothing delivered: selection reports an error, yet reflection runs and the library stores an entry.
await check("R4", "library entry is written when no candidate delivered anything", async () => {
  const r = await S.runHarness2(req({ taskId: "t-nodeliver" }), {
    execute: async () => ({ ok: true, delivered: false, output: "", trajectory: "final output:\n(empty)", error: "" }),
    propose: async (_p: string, label: string) => (label === "experience" ? EXP_OK : "<notes>KEEP_BASE</notes>"),
  });
  return [Boolean(r.selection.error) && r.libraryEntry !== null, `selection.error=${JSON.stringify(r.selection.error)} chosen=${r.selection.chosenLabel} libraryEntry=${r.libraryEntry ? path.relative(TMP, r.libraryEntry) : null}`];
});

// R5 — selector failure: an arbitrary candidate is adopted and still becomes a library lesson.
await check("R5", "library entry is written when the selector failed", async () => {
  const r = await S.runHarness2(req({ taskId: "t-badselect", selectionPool: "mixed" }), {
    execute: execOK,
    propose: async (_p: string, label: string) =>
      label === "select" ? "I could not decide." : label === "experience" ? EXP_OK : label.startsWith("dom") || label.startsWith("agg") ? editReply : "<notes>KEEP_BASE</notes>",
  });
  return [Boolean(r.selection.error) && r.libraryEntry !== null, `selection.error=${JSON.stringify(r.selection.error)} adopted=${r.selection.chosenLabel} libraryEntry=${r.libraryEntry ? "written" : null}`];
});

// R6 — re-running a task id feeds the task its OWN earlier entry as "earlier tasks in this domain".
await check("R6", "a re-run task reads its own previous library entry", async () => {
  const q = req({ taskId: "t-rerun" });
  const p1 = async (_p: string, label: string) =>
    label === "select" ? "<why>ok</why>\n```choice\na1\n```" : label === "experience" ? EXP_OK : label.startsWith("dom") || label.startsWith("agg") ? editReply : "<notes>KEEP_BASE</notes>";
  await S.runHarness2(q, { execute: execOK, propose: p1 });
  const seen: Record<string, string> = {};
  await S.runHarness2(q, { execute: execOK, propose: async (p: string, label: string) => ((seen[label] = p), "<notes>KEEP_BASE</notes>") });
  const own = (seen["inv1.a1"] || "").includes("## Entry t-rerun");
  return [own, `second run of t-rerun: inv1 prompt contains "## Entry t-rerun" = ${own}`];
});

// R7 — the English-phrase "grader" regex fires on ordinary finance text, and a lesson that trips it
// throws out of runHarness2 (the route would answer 500 and lose every rollout).
await check("R7", "grader-phrase regex rejects normal finance text and crashes the whole run", async () => {
  let treeErr = "";
  try {
    T.validateTree({ "systemprompt.md": "You review bond portfolios. Treat any bond graded as BBB- or better as investment grade.\n" });
  } catch (e) { treeErr = (e as Error).message; }
  let runErr = "";
  const exp = EXP_OK.replace("lesson: add a totals skill triggered from systemprompt.md", "lesson: when securities are graded by two agencies, add a skill that reconciles both ratings");
  try {
    await S.runHarness2(req({ taskId: "t-grader" }), {
      execute: execOK,
      propose: async (_p: string, label: string) => (label === "select" ? "<why>ok</why>\n```choice\na1\n```" : label === "experience" ? exp : "<notes>KEEP_BASE</notes>"),
    });
  } catch (e) { runErr = (e as Error).message; }
  return [Boolean(treeErr) && Boolean(runErr), `validateTree: "${treeErr}" | runHarness2 threw: "${runErr}"`];
});

// R8 — validation stops at the first problem, so a retry can only fix one problem per attempt.
await check("R8", "validation reports only the first of several problems", () => {
  let msg = "";
  try {
    T.validateTree({ "systemprompt.md": "Hi {{name}}", "skills/abc/SKILL.md": "---\nname: other\n---\nbody\n" });
  } catch (e) { msg = (e as Error).message; }
  // Problems present: template braces, name mismatch, missing description, no trigger line.
  return [!msg.includes("frontmatter") && !msg.includes("trigger"), `4 problems present; error = "${msg}"`];
});

// R9 — "entries are newest-last; the oldest are dropped" — but entries() sorts by name.
await check("R9", "library context cap evicts alphabetically, not oldest-first", async () => {
  const lib = new L.Library("evict", path.join(TMP, "lib-evict"));
  const big = (c: string) => ({ "systemprompt.md": `${c.repeat(40_000)}\n` });
  lib.add("zeta-older", big("z"), { label: "agg1", experience: { cue: "c", lesson: "l", evidence: "e" } });
  await new Promise((res) => setTimeout(res, 20));
  lib.add("alpha-newer", big("a"), { label: "agg1", experience: { cue: "c", lesson: "l", evidence: "e" } });
  const ctx = lib.contextText();
  const keptNew = ctx.includes("## Entry alpha-newer");
  const keptOld = ctx.includes("## Entry zeta-older");
  return [!keptNew && keptOld, `added zeta-older then alpha-newer (40k chars each, cap 60k): kept newer=${keptNew}, kept older=${keptOld}`];
});

// R10 — `..` survives slug(), so a caller-chosen domain or task id resolves outside its directory.
await check("R10", "domain/taskId '..' escapes the library directory (path computation only, nothing written)", () => {
  const root = path.join(TMP, "trav-root");
  const a = new L.Library("..", root);
  const b = new L.Library("x", root);
  const relA = path.relative(root, a.dir);
  const entry = b.entryDir("..");
  return [relA === ".." && entry === b.dir, `Library("..").dir -> root/${relA}; Library("x").entryDir("..") === domain dir: ${entry === b.dir}`];
});

// R11 — diversity is whole-file Jaccard, not upstream's line-Jaccard.
await check("R11", "diversity metric reads a one-line edit as 0% similar", () => {
  const body = Array.from({ length: 50 }, (_, i) => `rule ${i}`).join("\n");
  const t1 = { "systemprompt.md": body };
  const t2 = { "systemprompt.md": body.replace("rule 7", "rule seven") };
  const ours = T.diversity({ a: t1, b: t2 }).meanJaccard;
  const la = new Set(body.split("\n")), lb = new Set(t2["systemprompt.md"].split("\n"));
  const lineJ = [...la].filter((x) => lb.has(x)).length / new Set([...la, ...lb]).size;
  return [ours === 0, `ours meanJaccard=${ours}; upstream-style line Jaccard=${lineJ.toFixed(3)}`];
});

// R12 — every base rollout failed; upstream stops ("base-failed"), ours keeps spending improver calls.
await check("R12", "recursion runs even when every base rollout failed", async () => {
  const calls: string[] = [];
  const r = await S.runHarness2(req({ taskId: "t-basefail" }), {
    execute: async () => { throw new Error("solver provider down"); },
    propose: async (_p: string, label: string) => (calls.push(label), label === "experience" ? "NO_ENTRY" : "<notes>KEEP_BASE</notes>"),
  });
  return [calls.length > 0, `all rollouts failed; improver calls made: [${calls.join(", ")}]; rollouts attempted: ${r.result.ledger.length}`];
});

// R13 — a transport error is not retried; the stage falls back on the first exception.
await check("R13", "a single proposer transport error ends the stage with no retry", async () => {
  const calls: string[] = [];
  const st = await R.runStage({
    label: "inv1", dim: "INV", job: "job", fallback: BASE, base: [],
    deps: deps(async (_p: string, label: string) => { calls.push(label); if (calls.length === 1) throw new Error("ECONNRESET"); return editReply; }),
  });
  return [st.fellBack && calls.length === 1, `fellBack=${st.fellBack} attempts=${st.attempts} proposer calls=${calls.length} error=${JSON.stringify(st.error)}`];
});

// R14/R15 — skills are inlined into every rollout's system prompt, and nothing caps always-on size.
await check("R14", "a skill body is always in the system prompt (costs the same as always-on text)", () => {
  const tree = { "systemprompt.md": "Analyst. When totals appear, use the `totals` skill.\n", "skills/totals/SKILL.md": `---\nname: totals\ndescription: checks totals\n---\n${"step\n".repeat(1000)}` };
  T.validateTree(tree);
  const sys = T.materialize(tree);
  return [sys.length > 5000, `systemprompt.md=${tree["systemprompt.md"].length} chars, skill=${tree["skills/totals/SKILL.md"].length} chars, materialized system prompt=${sys.length} chars`];
});
await check("R15", "no always-on size cap (upstream: 24,000 chars opencode / 8,000 codex)", () => {
  T.validateTree({ "systemprompt.md": "rule\n".repeat(40_000) });
  return [true, "a 200,000-char systemprompt.md passes validateTree"];
});

// R17 — k=1 still runs a selector, and the pool contains the base rollout.
await check("R17", "k=1 runs a selector over base1+agg1 (upstream: no selector, pool = finals only)", async () => {
  const calls: string[] = [];
  const r = await S.runHarness2(req({ taskId: "t-k1" }), {
    execute: execOK,
    propose: async (_p: string, label: string) => (calls.push(label), label === "select" ? "<why>ok</why>\n```choice\na2\n```" : label === "experience" ? "NO_ENTRY" : label.startsWith("agg") ? editReply : "<notes>KEEP_BASE</notes>"),
  });
  return [calls.includes("select") && Object.values(r.selection.ids).includes("base1"), `selector calls=${calls.filter((c) => c === "select").length}; pool ids=${JSON.stringify(r.selection.ids)}`];
});

// R18 — the reflector gets the selector's reasoning (written in anonymous ids) but not the id map,
// and the base harness is rendered twice.
await check("R18", "reflection prompt lacks the anonymous-id map and repeats the base tree", async () => {
  let expPrompt = "";
  const r = await S.runHarness2(req({ taskId: "t-reflect", selectionPool: "mixed" }), {
    execute: execOK,
    propose: async (p: string, label: string) => {
      if (label === "experience") { expPrompt = p; return "NO_ENTRY"; }
      if (label === "select") return "<why>a2 reconciles the total; a1 missed a row</why>\n```choice\na2\n```";
      return label.startsWith("agg") ? editReply : "<notes>KEEP_BASE</notes>";
    },
  });
  const hasMap = Object.entries(r.selection.ids).some(([id, lbl]) => new RegExp(`${id}\\W{1,6}${lbl}`).test(expPrompt));
  const baseRender = T.renderTree(BASE);
  const asCurrent = expPrompt.includes(`# CURRENT HARNESS\n\n${baseRender}`);
  const asBase = expPrompt.includes(`# BASE HARNESS (context/base_harness)\n\n${baseRender}`);
  return [!hasMap && asCurrent && asBase, `ids=${JSON.stringify(r.selection.ids)}; why cites a2: ${/a2 reconciles/.test(expPrompt)}; id->label map in prompt: ${hasMap}; base tree shown as CURRENT HARNESS: ${asCurrent} and again as BASE HARNESS: ${asBase}`];
});

// R19 — candidates are cut at 12,000 chars for the selector, whose FINISH rule penalises visibly
// incomplete sections; there is no "truncation markers are ours" disclaimer.
await check("R19", "selector sees our truncation marker with no disclaimer", async () => {
  let sel = "";
  await S.runHarness2(req({ taskId: "t-long", selectionPool: "mixed" }), {
    execute: async (tree: Record<string, string>) => {
      const output = (T.materialize(tree).includes("Add the rows") ? "checked " : "plain ") + "row\n".repeat(5000);
      return { ok: true, delivered: true, output, trajectory: "final output: (long)", error: "" };
    },
    propose: async (p: string, label: string) => {
      if (label === "select") { sel = p; return "<why>ok</why>\n```choice\na1\n```"; }
      return label === "experience" ? "NO_ENTRY" : label.startsWith("agg") ? editReply : "<notes>KEEP_BASE</notes>";
    },
  });
  const marker = sel.includes("[truncated");
  const disclaimer = /truncation marker/i.test(sel);
  return [marker && !disclaimer, `20,000-char outputs: truncation marker shown=${marker}; disclaimer present=${disclaimer}; FINISH rule present=${sel.includes("visibly incomplete")}`];
});

// R20 — prompt size at k=4 with a tool-using solver (trajectory shaped like trajectoryOf's caps).
await check("R20", "k=4 parallel aggregator prompt size with 20 tool calls per rollout", async () => {
  const traj = [`thinking (excerpt): ${"t".repeat(1500)}`, ...Array.from({ length: 20 }, (_, i) => `tool search_${i}(${"a".repeat(400)}) -> success: ${"r".repeat(800)}`), `final output:\n${"o".repeat(6000)}`].join("\n");
  let maxAgg = 0;
  const d = deps(async (p: string, label: string) => { if (label.startsWith("agg")) maxAgg = Math.max(maxAgg, p.length); return editReply; },
    async (_tree: Record<string, string>) => ({ ok: true, delivered: true, output: "o".repeat(6000), trajectory: traj, error: "" }));
  await R.runParallel(4, await R.rollBase(d, 4), d);
  return [maxAgg > 300_000, `per-rollout trajectory=${traj.length} chars; largest aggregator prompt=${maxAgg.toLocaleString("en-US")} chars (~${Math.round(maxAgg / 4).toLocaleString("en-US")} tokens) before any library text`];
});

// R21 — the retry says "Fix it" but the stateless proposer never sees what it sent the first time.
await check("R21", "retry prompt omits the rejected reply it asks the model to fix", async () => {
  const prompts: string[] = [];
  // A frontmatter name mismatch: still rejected after autotrigger repairs missing trigger lines.
  const rejected = `<file path="skills/totals/SKILL.md">${SKILL("other")}</file><notes>UNIQUE-MARKER-42</notes>`;
  const st = await R.runStage({ label: "dom1", dim: "DOM", job: "job", fallback: BASE, base: [], deps: deps(async (p: string) => (prompts.push(p), rejected)) });
  const second = prompts[1] || "";
  return [second.includes("YOUR PREVIOUS ATTEMPT WAS REJECTED") && !second.includes("UNIQUE-MARKER-42"),
    `attempts=${st.attempts}; 2nd prompt has rejection notice=${second.includes("YOUR PREVIOUS ATTEMPT WAS REJECTED")}, contains its own 1st reply=${second.includes("UNIQUE-MARKER-42")}`];
});

} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`SUMMARY ${lines.filter((l) => l.includes("[CONFIRMED]")).length}/${lines.length} confirmed; temp dir removed: ${!fs.existsSync(TMP)}`);
process.exit(0);
