import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import runRouter from "../../src/routes/RunRoutes.ts";
import { authMiddleware } from "../../src/middleware/AuthMiddleware.ts";
import { issueRuntimeSession } from "../../src/middleware/RuntimeAuth.ts";
import { RunExecutionEngine } from "../../src/services/RunExecutionEngine.ts";
import { RunStore } from "../../src/services/RunStore.ts";

const appId = "obsidian";
const username = "fixture-user";
const profileId = "obsidian-vault-agent-v1";
const sessionId = "fixture-vault-session";
const runtimeCredential = crypto.randomBytes(32).toString("hex");

function bearer(overrides: Partial<{ app_id: string; username: string; profile_id: string; session_id: string }> = {}) {
  return issueRuntimeSession({
    app_id: overrides.app_id ?? appId,
    username: overrides.username ?? username,
    profile_id: overrides.profile_id ?? profileId,
    session_id: overrides.session_id ?? sessionId,
    expires_at: Date.now() + 60_000,
  });
}

function seedRun(runId: string, status: "running" | "completed" = "completed") {
  return RunStore.createRun({
    run_id: runId, status, profile_id: profileId, profile_version: "1.0.0",
    session_id: sessionId, identity: { project: appId, username },
    created_at: new Date().toISOString(), current_turn: 1, input: "fixture",
    messages: [{ role: "assistant", content: "fixture result" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, tool_calls_count: 0, retry_count: 0, duration_ms: 1 },
    evidence_records: [], events: [
      { id: "evt-1", run_id: runId, type: "run.started", data: { status }, timestamp: new Date().toISOString() },
      { id: "evt-2", run_id: runId, type: status === "completed" ? "run.completed" : "message.delta", data: { status }, timestamp: new Date().toISOString() },
    ],
  });
}

describe("scoped runtime HTTP routes", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.stubEnv("RUNTIME_API_TOKEN", runtimeCredential);
    RunStore.clearAll();
    const app = express();
    app.use(express.json());
    app.use(authMiddleware);
    app.use("/v1/runs", runRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}/v1/runs`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("mints only for the matching backend identity and pins desktop creation scope", async () => {
    const issue = (body: object, headers: Record<string, string> = {}) => fetch(`${baseUrl}/sessions`, {
      method: "POST", headers: { "content-type": "application/json", "x-runtime-token": runtimeCredential, ...headers },
      body: JSON.stringify(body),
    });
    const valid = { app_id: appId, username, session_id: sessionId, profile_id: profileId, expires_at: Date.now() + 60_000 };
    expect((await issue(valid, { "x-project": appId, "x-username": username })).status).toBe(201);
    expect((await issue(valid, { "x-project": "other-app", "x-username": username })).status).toBe(403);

    const desktop = await fetch(`${baseUrl}/sessions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer()}` }, body: JSON.stringify(valid),
    });
    expect(desktop.status).toBe(403);

    const wrongProfile = await fetch(baseUrl, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer()}` },
      body: JSON.stringify({ app_id: appId, profile_id: "another-profile", session_id: sessionId, input: "x" }),
    });
    expect(wrongProfile.status).toBe(403);
    const wrongSession = await fetch(baseUrl, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer()}` },
      body: JSON.stringify({ app_id: appId, profile_id: profileId, session_id: "another-session", input: "x" }),
    });
    expect(wrongSession.status).toBe(403);
  });

  it("replays persisted events after a cursor without restarting execution", async () => {
    const runId = "scoped-replay";
    await seedRun(runId);
    const startRun = vi.spyOn(RunExecutionEngine, "startRun");
    const response = await fetch(`${baseUrl}/${runId}/events?after=evt-1`, { headers: { authorization: `Bearer ${bearer()}` } });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("id: evt-2");
    expect(body).toContain('"type":"run.completed"');
    expect(startRun).not.toHaveBeenCalled();

    const unknown = await fetch(`${baseUrl}/${runId}/events?after=missing`, { headers: { authorization: `Bearer ${bearer()}` } });
    expect(unknown.status).toBe(409);
  });

  it("returns 404 for cross-vault reads, cancellation, and tool results", async () => {
    const runId = "cross-vault-run";
    await seedRun(runId, "running");
    const other = bearer({ session_id: "other-vault-session", profile_id: "other-profile" });
    const headers = { authorization: `Bearer ${other}`, "content-type": "application/json" };
    expect((await fetch(`${baseUrl}/${runId}`, { headers })).status).toBe(404);
    expect((await fetch(`${baseUrl}/${runId}/cancel`, { method: "POST", headers })).status).toBe(404);
    expect((await fetch(`${baseUrl}/${runId}/tools/call-1/result`, {
      method: "POST", headers, body: JSON.stringify({ result: "x", is_error: false, authorization_receipt: {} }),
    })).status).toBe(404);
  });
});
