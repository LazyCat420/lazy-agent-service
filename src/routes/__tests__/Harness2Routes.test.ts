/**
 * POST /harness2/run as an async job, run records, validation, and the library DELETE route
 * (documentation ch.13 §6 Phase 1 item 8, C1–C4). The runner is a fake: no model is called.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import harness2Router from "../Harness2Routes.ts";
import { errorHandler } from "../../utils/errors.ts";
import { setRunnerForTests } from "../../services/harness2/Harness2Jobs.ts";
import type { Harness2Result } from "../../services/harness2/Harness2Service.ts";
import { Library } from "../../services/harness2/Library.ts";
import LocalProviderGateway from "../../services/local-provider/index.ts";

const BASE = { "systemprompt.md": "You are a careful analyst.\n" };
const body = (over: Record<string, unknown> = {}) => ({
  taskId: "t1",
  task: "Sum the rows.",
  domain: "finance",
  baseTree: BASE,
  solver: { provider: "vllm", model: "nemotron35" },
  improver: { provider: "vllm-2", model: "deepseek" },
  preflight: false,
  ...over,
});
const fakeResult = (status: Harness2Result["status"]) => ({ taskId: "t1", domain: "finance", status, learned: false, errors: [] }) as unknown as Harness2Result;

let root = "";
let server: http.Server | undefined;
let base = "";
const savedRoot = process.env.HARNESS2_LIBRARY_PATH;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "harness2-routes-"));
  process.env.HARNESS2_LIBRARY_PATH = root;
  const app = express();
  app.use(express.json());
  app.use("/harness2", harness2Router);
  app.use(errorHandler);
  server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/harness2`;
});
afterEach(() => setRunnerForTests());
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (savedRoot === undefined) delete process.env.HARNESS2_LIBRARY_PATH;
  else process.env.HARNESS2_LIBRARY_PATH = savedRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

const post = (url: string, payload?: unknown) =>
  fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload) });
const poll = async (runId: string) => {
  for (let i = 0; i < 100; i++) {
    const rec = await (await fetch(`${base}/runs/${runId}`)).json();
    if (rec.status !== "running") return rec;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("run never finished");
};
/** A runner held open until `release()`; it reports cancellation if its signal aborts. */
const heldRunner = () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  setRunnerForTests(async (_req, deps) => {
    await Promise.race([gate, new Promise<void>((resolve) => deps?.signal?.addEventListener("abort", () => resolve(), { once: true }))]);
    return fakeResult(deps?.signal?.aborted ? "cancelled" : "ok");
  });
  return () => release();
};

describe("POST /harness2/run is an async job with a run record [C2]", () => {
  it("answers 202 with a run id; the record ends done and is written to disk", async () => {
    setRunnerForTests(async () => fakeResult("ok"));
    const res = await post("/run", body());
    expect(res.status).toBe(202);
    const { runId, poll: pollUrl } = await res.json();
    expect(pollUrl).toBe(`/harness2/runs/${runId}`);
    const rec = await poll(runId);
    expect(rec).toMatchObject({ status: "done", taskId: "t1", domain: "finance", result: { status: "ok" } });
    expect(rec.request).toMatchObject({ task: "Sum the rows.", k: 1, solver: { model: "nemotron35" } });
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, "finance", "runs", `${runId}.json`), "utf8"));
    expect(onDisk.status).toBe("done");
  });

  it("wait: true answers with the finished record", async () => {
    setRunnerForTests(async () => fakeResult("ok"));
    const res = await post("/run", body({ wait: true, domain: "wait-domain" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "done", result: { status: "ok" } });
  });

  it("a runner that throws leaves an error record, not a lost run", async () => {
    setRunnerForTests(async () => {
      throw new Error("disk full");
    });
    const { runId } = await (await post("/run", body({ domain: "crash" }))).json();
    expect(await poll(runId)).toMatchObject({ status: "error", error: "disk full" });
  });

  it("a record left running by a dead process reads as interrupted", async () => {
    fs.mkdirSync(path.join(root, "ghost", "runs"), { recursive: true });
    fs.writeFileSync(path.join(root, "ghost", "runs", "t9-20261022T000000-abc123.json"), JSON.stringify({ runId: "t9-20261022T000000-abc123", domain: "ghost", status: "running" }));
    const rec = await (await fetch(`${base}/runs/t9-20261022T000000-abc123`)).json();
    expect(rec.status).toBe("interrupted");
    expect((await fetch(`${base}/runs/..`)).status).toBe(404);
    expect((await fetch(`${base}/runs/nope`)).status).toBe(404);
  });
});

describe("one run at a time per domain [C4], and cancel", () => {
  it("a second run in a busy domain gets 409; another domain still starts", async () => {
    const release = heldRunner();
    const first = await (await post("/run", body({ domain: "busy" }))).json();
    const second = await post("/run", body({ domain: "busy", taskId: "t2" }));
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ runId: first.runId });
    const other = await post("/run", body({ domain: "other" }));
    expect(other.status).toBe(202);
    release();
    expect((await poll(first.runId)).status).toBe("done");
    expect((await post("/run", body({ domain: "busy", taskId: "t3" }))).status).toBe(202);
  });

  it("cancel aborts the run's signal and the record ends cancelled", async () => {
    heldRunner();
    const { runId } = await (await post("/run", body({ domain: "cancel-me" }))).json();
    const res = await post(`/runs/${runId}/cancel`);
    expect(res.status).toBe(202);
    expect((await poll(runId)).status).toBe("cancelled");
    expect((await post(`/runs/${runId}/cancel`)).status).toBe(409);
  });
});

describe("request validation [C1, C3, A12]", () => {
  it.each([
    ["a dot-led taskId", { taskId: ".." }, /taskId must match/],
    ["a path in the domain", { domain: "../x" }, /domain must match/],
    ["a cloud solver", { solver: { provider: "openai", model: "gpt" } }, /not a local provider/],
    ["a cloud improver", { improver: { provider: "anthropic", model: "c" } }, /not a local provider/],
    ["a measurement word in a bench slot", { bench: { yardstick: "Match the rubric." } }, /bench.yardstick must describe the WORK.*"rubric"/],
    ["an unknown bench slot", { bench: { answers: "x" } }, /unknown slots: answers/],
    ["an unknown selection pool", { selectionPool: "best" }, /selectionPool must be finals or mixed/],
    ["k out of range", { k: 5 }, /k must be an integer 1..4/],
    ["a solver with no model", { solver: { provider: "vllm" } }, /solver.model is required/],
    ["an invalid base tree", { baseTree: { "systemprompt.md": " " } }, /baseTree invalid: systemprompt.md must not be empty/],
    ["no improver model with preflight off", { improver: undefined }, /improver.model is required when preflight is off/],
  ])("refuses %s with 400", async (_name, over, msg) => {
    const res = await post("/run", body(over));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(msg);
  });

  it("bench.work may restate a task that mentions a score", async () => {
    setRunnerForTests(async () => fakeResult("ok"));
    expect((await post("/run", body({ domain: "scores", bench: { work: "Compute each applicant's credit score." } }))).status).toBe(202);
  });
});

describe("library routes", () => {
  it("DELETE drops one stored lesson; unknown and invalid ids are refused", async () => {
    const lib = new Library("lessons");
    lib.add("bad-lesson", BASE, { experience: { cue: "c", lesson: "l", evidence: "e" } });
    lib.add("good-lesson", BASE, { experience: { cue: "c", lesson: "l", evidence: "e" } });
    const res = await fetch(`${base}/library/lessons/bad-lesson`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ domain: "lessons", removed: ["bad-lesson"] });
    expect(new Library("lessons").entries()).toEqual(["good-lesson"]);
    expect((await fetch(`${base}/library/lessons/bad-lesson`, { method: "DELETE" })).status).toBe(404);
    expect((await fetch(`${base}/library/lessons/.hidden`, { method: "DELETE" })).status).toBe(400);
  });

  it("DELETE waits while a run is active in the domain", async () => {
    const release = heldRunner();
    const { runId } = await (await post("/run", body({ domain: "lessons-busy" }))).json();
    expect((await fetch(`${base}/library/lessons-busy/x`, { method: "DELETE" })).status).toBe(409);
    release();
    await poll(runId);
  });

  it("GET refuses an invalid domain", async () => {
    expect((await fetch(`${base}/library/.x`)).status).toBe(400);
    expect((await fetch(`${base}/library/lessons`)).status).toBe(200);
  });
});

describe("served-model preflight [A14]", () => {
  const served: Record<string, string[] | Error> = {
    vllm: ["nemotron35"],
    "vllm-2": ["DeepSeek-V4.1-Flash-1017"],
    "vllm-5": new Error("connect ECONNREFUSED"),
  };
  beforeAll(() => {
    vi.spyOn(LocalProviderGateway, "discoverModelsForInstance").mockImplementation(async (id: string) => {
      const models = served[id] ?? [];
      if (models instanceof Error) throw models;
      return models.map((name) => ({ name })) as never;
    });
  });
  afterAll(() => vi.restoreAllMocks());
  const live = (over: Record<string, unknown>) => body({ preflight: undefined, ...over });

  it("gives the default improver the model its provider serves today", async () => {
    setRunnerForTests(async () => fakeResult("ok"));
    const res = await post("/run", live({ domain: "preflight-ok", improver: undefined }));
    expect(res.status).toBe(202);
    const rec = await poll((await res.json()).runId);
    expect(rec.request.improver).toMatchObject({ provider: "vllm-2", model: "DeepSeek-V4.1-Flash-1017" });
  });

  it.each([
    ["an improver model that is not served", { improver: { provider: "vllm-2", model: "GLM-5.3-Flash-EXL3-TF" } }, 400, /improver.model GLM-5.3-Flash-EXL3-TF is not served by vllm-2 \(serves: DeepSeek-V4.1-Flash-1017\)/],
    ["a solver model that is not served", { solver: { provider: "vllm", model: "gone" } }, 400, /solver.model gone is not served by vllm/],
    ["an unknown instance", { solver: { provider: "vllm-9", model: "m" } }, 400, /vllm-9 serves no models/],
    ["an unreachable provider", { solver: { provider: "vllm-5", model: "m" } }, 502, /could not list the models vllm-5 serves: connect ECONNREFUSED/],
  ])("refuses %s before any rollout", async (_name, over, status, msg) => {
    const res = await post("/run", live(over));
    expect(res.status).toBe(status);
    expect((await res.json()).error).toMatch(msg);
  });
});

