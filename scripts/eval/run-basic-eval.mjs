#!/usr/bin/env node
// Live basic-fetch benchmark against deployed lazy-agent-service (LAS).
// Sends the shared 8 basic questions through /v1/runs for selected app
// profiles, grades each answer with a local GLM judge, and guards against
// LAS container restarts during the run. Plain Node 22+, no npm deps.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
let QUESTIONS = JSON.parse(readFileSync(resolve(HERE, "questions.json"), "utf8"));
let RUBRIC = QUESTIONS.rubric;
let QUESTIONS_LIST = QUESTIONS.questions;

const LAS_URL = process.env.LAS_URL || "http://10.0.0.16:5591";
const JUDGE_URL = process.env.JUDGE_URL || "http://10.0.0.141:8000/v1/chat/completions";
const JUDGE_MODEL = process.env.JUDGE_MODEL || "GLM-5.3-Flash-EXL3-TF";
const RUN_TIMEOUT_MS = 660_000;

// ── auth token ────────────────────────────────────────────────────────────
let TOKEN = process.env.INTERNAL_EXECUTE_TOKEN;
if (!TOKEN) {
  const envFile = "/home/lazycat/github/projects/sun/deploy-kit/.env.deploy";
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && m[1] === "INTERNAL_EXECUTE_TOKEN") TOKEN = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
if (!TOKEN) {
  console.error("INTERNAL_EXECUTE_TOKEN not set and not found in .env.deploy");
  process.exit(1);
}

// ── CLI ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { profiles: [], questions: [], outDir: null, concurrency: 1, questionsFile: null, noJudge: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profiles") out.profiles = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--questions-file") out.questionsFile = argv[++i];
    else if (a === "--no-judge") out.noJudge = true;
    else if (a === "--questions") {
      for (const part of argv[++i].split(",")) {
        const range = part.match(/^(\d+)-(\d+)$/);
        if (range) for (let q = +range[1]; q <= +range[2]; q++) out.questions.push(q);
        else if (part.trim()) out.questions.push(+part.trim());
      }
    } else if (a === "--out") out.outDir = argv[++i];
    else if (a === "--concurrency") out.concurrency = +argv[++i] || 1;
    else { console.error(`Unknown arg: ${a}`); process.exit(1); }
  }
  if (!out.profiles.length) out.profiles = ["trading", "html-notes"];
  if (!out.questions.length) out.questions = QUESTIONS_LIST.map((q) => q.id);
  if (!out.outDir) { console.error("--out <dir> is required"); process.exit(1); }
  return out;
}

const DEFAULT_PROFILES = {
  trading: {
    profile_id: "trading-strategy-chat-v1",
    profile_version: "1.2.0",
    app_id: "trading",
    project: "trading",
    username: "strategy-chat",
    budget: { max_tool_calls: 20, max_tokens: 49152 },
    input: (text) => [{ role: "user", content: text }],
  },
  "html-notes": {
    profile_id: "html-notes-canvas-v1",
    app_id: "html-notes",
    project: "html-notes",
    username: "eval",
    input: (text) => text,
  },
};
let PROFILES_ACTIVE = DEFAULT_PROFILES;

// ── restart guard ─────────────────────────────────────────────────────────
async function lasRestartSnapshot() {
  const sshCmd = ["ssh", "-o", "ConnectTimeout=8", "-o", "BatchMode=yes", "nas",
    "sudo -n /usr/local/bin/docker inspect lazy-agent-service --format '{{.RestartCount}} {{.State.StartedAt}}'"];
  try {
    const stdout = execFileSync(sshCmd[0], sshCmd.slice(1), { encoding: "utf8", timeout: 20_000 });
    const [restartCount, startedAt] = stdout.trim().split(" ");
    if (!restartCount || !startedAt) throw new Error(`unexpected output: ${stdout.trim()}`);
    return { method: "ssh-nas-docker-inspect", restart_count: +restartCount, started_at: startedAt };
  } catch (err) {
    // Fallback: /health uptime fields from LAS itself.
    try {
      const res = await fetch(`${LAS_URL}/health`, { signal: AbortSignal.timeout(10_000) });
      const body = await res.json();
      return { method: "las-health-fallback", health: body };
    } catch (err2) {
      return { method: "unavailable", error: String(err.message || err), fallback_error: String(err2?.message || err2) };
    }
  }
}

function restartChanged(before, after) {
  if (!before || !after) return null;
  if (before.method === "ssh-nas-docker-inspect" && after.method === "ssh-nas-docker-inspect") {
    return before.restart_count !== after.restart_count || before.started_at !== after.started_at;
  }
  if (before.method === "las-health-fallback" && after.method === "las-health-fallback") {
    return JSON.stringify(before.health) !== JSON.stringify(after.health);
  }
  return null; // methods differ; incomparable
}

// ── run one question through LAS ──────────────────────────────────────────
async function runOne(profileName, question) {
  const profile = PROFILES_ACTIVE[profileName];
  const started = Date.now();
  const body = {
    profile_id: profile.profile_id,
    app_id: profile.app_id,
    input: profile.input(question.text),
    stream: true,
  };
  if (profile.profile_version) body.profile_version = profile.profile_version;
  if (profile.budget) body.budget = profile.budget;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  const record = {
    profile: profileName,
    question_id: question.id,
    question: question.text,
    wall_seconds: null,
    event_types: [],
    run_id: null,
    // Non-delta events with seconds since request start: shows when the soft deadline, finalize and tools happened.
    timeline: [],
    tool_calls: [],
    status: null,
    error_code: null,
    answer: null,
    usage: null,
  };

  try {
    const res = await fetch(`${LAS_URL}/v1/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-runtime-token": TOKEN,
        "x-project": profile.project,
        "x-username": profile.username,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      record.status = "http_error";
      record.error_code = `HTTP_${res.status}`;
      record.answer = null;
      record.http_error = text.slice(0, 500);
      return record;
    }
    if (!res.body) throw new Error("no response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let finalText = "";
    const toolNames = new Set();

    // SSE parse loop
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          let event;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }
          if (!record.event_types.includes(event.type)) record.event_types.push(event.type);
          const data = event.data || {};
          record.run_id ??= event.run_id || event.runId || null;
          if (event.type !== "message.delta") {
            record.timeline.push({
              t: +((Date.now() - started) / 1000).toFixed(1),
              type: event.type,
              ...(data.code ? { code: data.code } : {}),
              ...(data.reason ? { reason: data.reason } : {}),
              ...(data.tool_name || data.name ? { tool: data.tool_name || data.name } : {}),
            });
          }
          if (event.type === "message.delta" && typeof data.delta === "string") finalText += data.delta;
          if (event.type === "message.completed" && typeof data.content === "string" && data.content) {
            // prefer completed message text if deltas were empty
            if (!finalText) finalText = data.content;
          }
          // Shared (global.*) tools emit only tool.completed / tool.failed; local tools emit tool.invoked first.
          // Count each tool_call_id once.
          const toolName = data.tool_name || data.name;
          if (["tool.invoked", "tool.completed", "tool.failed"].includes(event.type) && toolName
            && !record.tool_calls.some((t) => t.id === data.tool_call_id)) {
            record.tool_calls.push({ id: data.tool_call_id, name: toolName, outcome: event.type });
            toolNames.add(toolName);
          }
          if (event.type === "run.completed") {
            record.status = "run.completed";
            record.usage = data.usage || null;
            if (typeof data.answer === "string" && data.answer) finalText = data.answer;
          }
          if (event.type === "run.failed") {
            record.status = "run.failed";
            const err = data.error || {};
            record.error_code = err.code || "RUN_FAILED";
            record.error_message = err.message || "Runtime did not complete";
          }
          if (event.type === "run.cancelled") {
            record.status = "run.cancelled";
            record.error_code = data.error?.code || "RUN_CANCELLED";
          }
        }
      }
    }
    record.answer = finalText || null;
    record.tool_call_count = toolNames.size;
  } catch (err) {
    record.status = record.status || "client_error";
    record.error_code = record.error_code || (err.name === "AbortError" ? "CLIENT_TIMEOUT_660S" : "CLIENT_ERROR");
    record.error_message = String(err.message || err);
  } finally {
    clearTimeout(timer);
    record.wall_seconds = +((Date.now() - started) / 1000).toFixed(1);
  }
  return record;
}

// ── judge ─────────────────────────────────────────────────────────────────
function extractJson(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  // find matching closing brace
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

async function judge(record, today) {
  if (record.status !== "run.completed") {
    return { grade: "FAIL", reason: `run did not complete: ${record.status} ${record.error_code || ""}` };
  }
  const toolLog = record.tool_calls.map((t) => t.name).join(", ") || "(none)";
  const answer = (record.answer || "").slice(0, 3000);
  const prompt = `You are grading an agent's answer to a web question. Apply this rubric literally.

Rubric: ${RUBRIC}

"today" means: ${today}.

Question: ${record.question}

Tool calls made (names, in order): ${toolLog}

Agent's final answer:
${answer}

Respond with ONLY a JSON object: {"grade":"PASS|WEAK|FAIL","reason":"one sentence"}.`;

  // The judge shares GLM with the runs under test, so one slow reply is infra noise: retry once before grading FAIL.
  for (let attempt = 1; ; attempt++) {
  try {
    const res = await fetch(JUDGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(240_000),
    });
    if (!res.ok) return { grade: "FAIL", reason: `judge http ${res.status}` };
    const body = await res.json();
    const content = body.choices?.[0]?.message?.content || "";
    const parsed = extractJson(content);
    if (parsed && ["PASS", "WEAK", "FAIL"].includes(parsed.grade)) {
      return { grade: parsed.grade, reason: parsed.reason || "" };
    }
    return { grade: "FAIL", reason: `judge returned unparseable output: ${content.slice(0, 200)}` };
  } catch (err) {
    if (attempt < 2) continue;
    return { grade: "FAIL", reason: `judge error: ${String(err.message || err)}` };
  }
  }
}

// ── no-judge grading ──────────────────────────────────────────────────────
function noJudgeGrade(record) {
  const answer = (record.answer || "").trim();
  const grade = record.status === "run.completed" && answer ? "PASS" : "FAIL";
  return { grade, reason: `no-judge: status=${record.status} answer_chars=${answer.length}` };
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  if (args.questionsFile) {
    const data = JSON.parse(readFileSync(resolve(process.cwd(), args.questionsFile), "utf8"));
    QUESTIONS = data; RUBRIC = data.rubric || RUBRIC; QUESTIONS_LIST = data.questions;
    if (data.profiles) {
      PROFILES_ACTIVE = {};
      for (const [name, p] of Object.entries(data.profiles)) {
        PROFILES_ACTIVE[name] = { ...p, input: p.input || ((text) => text) };
      }
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  mkdirSync(args.outDir, { recursive: true });

  const restartBefore = await lasRestartSnapshot();

  const results = [];
  const work = [];
  for (const p of args.profiles) {
    if (!PROFILES_ACTIVE[p]) { console.error(`Unknown profile: ${p}`); process.exit(1); }
    for (const qid of args.questions) {
      const q = QUESTIONS_LIST.find((x) => x.id === qid);
      if (!q) { console.error(`Unknown question id: ${qid}`); process.exit(1); }
      work.push({ profile: p, question: q });
    }
  }

  // limited-concurrency worker pool
  let cursor = 0;
  async function worker() {
    while (cursor < work.length) {
      const job = work[cursor++];
      const record = await runOne(job.profile, job.question);
      record.grade_result = args.noJudge ? noJudgeGrade(record) : await judge(record, today);
      record.grade = record.grade_result.grade;
      results.push(record);
    }
  }
  await Promise.all(Array.from({ length: Math.min(args.concurrency, work.length) }, worker));

  const restartAfter = await lasRestartSnapshot();
  const restartDetected = restartChanged(restartBefore, restartAfter);

  writeFileSync(resolve(args.outDir, "results.json"), JSON.stringify({
    date: today,
    restart_before: restartBefore,
    restart_after: restartAfter,
    restart_detected: restartDetected === true,
    results,
  }, null, 2));

  // ── summary ─────────────────────────────────────────────────────────────
  const lines = [];
  lines.push(`# Basic fetch eval — ${today}`);
  lines.push("");
  lines.push("| question | profile | grade | wall s | tools | failure code |");
  lines.push("|---|---|---|---|---|---|");
  const order = new Map(args.profiles.flatMap((p, i) => args.questions.map((q) => [`${p}:${q}`, i])));
  for (const r of [...results].sort((a, b) =>
    (order.get(`${a.profile}:${a.question_id}`) ?? 0) - (order.get(`${b.profile}:${b.question_id}`) ?? 0))) {
    lines.push(`| ${r.question_id} | ${r.profile} | ${r.grade} | ${r.wall_seconds} | ${r.tool_calls?.length ?? 0} | ${r.error_code || ""} |`);
  }
  lines.push("");
  for (const p of args.profiles) {
    const rs = results.filter((r) => r.profile === p);
    const pass = rs.filter((r) => r.grade === "PASS").length;
    const weak = rs.filter((r) => r.grade === "WEAK").length;
    const fail = rs.filter((r) => r.grade === "FAIL").length;
    lines.push(`**${p}**: ${pass} PASS / ${weak} WEAK / ${fail} FAIL of ${rs.length}`);
  }
  lines.push("");
  lines.push(`restart check: ${restartDetected === true ? "RESTART DETECTED" : restartDetected === null ? "incomparable" : "ok"} (method: ${restartAfter.method}, before: ${JSON.stringify(restartBefore)}, after: ${JSON.stringify(restartAfter)})`);
  const summary = lines.join("\n");
  writeFileSync(resolve(args.outDir, "summary.md"), summary + "\n");
  console.log(summary);

  process.exitCode = restartDetected === true ? 2 : 0;
}

main().catch((err) => {
  console.error("script error:", err);
  process.exit(1);
});
