import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ObsidianCompletionJobs } from "../../services/ObsidianCompletionJobs";
import { createObsidianCompletionRouter } from "../ObsidianCompletionRoutes";

describe("Obsidian completion routes", () => {
  let server: http.Server | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    server = undefined;
    directory = undefined;
  });

  it("reports the contract, persists acceptance, and deduplicates repeated PUTs", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-completion-routes-"));
    const transport = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "VAULT_CHAT_OK" } }] }), { status: 200 }));
    const jobs = new ObsidianCompletionJobs(directory, transport);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.project = "test-project";
      req.username = "test-user";
      next();
    });
    app.use("/obsidian-completions", createObsidianCompletionRouter(jobs));
    server = await new Promise<http.Server>((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}/obsidian-completions`;

    const contract = await fetch(base);
    expect(contract.status).toBe(200);
    expect(await contract.json()).toEqual({ version: 1, durableVaultChat: true });

    const id = crypto.randomUUID();
    const body = {
      target: "http://10.0.0.30:8000/v1",
      payload: { model: "test-model", messages: [{ role: "user", content: "Reply with the vault result." }] },
    };
    const first = await fetch(`${base}/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(first.status).toBe(202);
    expect((await first.json()).status).toBe("running");

    const completed = await fetch(`${base}/${id}`);
    const saved = await completed.json();
    expect(completed.status).toBe(200);
    expect(saved).toMatchObject({ status: "completed", response: { status: 200, data: { choices: [{ message: { content: "VAULT_CHAT_OK" } }] } } });

    const repeated = await fetch(`${base}/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).response.data.choices[0].message.content).toBe("VAULT_CHAT_OK");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("re-runs a previously failed job when the client resubmits the same id", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-completion-rerun-"));
    let attempts = 0;
    const transport = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("model server hiccup");
      return new Response(JSON.stringify({ choices: [{ message: { content: "VAULT_CHAT_OK" } }] }), { status: 200 });
    });
    const jobs = new ObsidianCompletionJobs(directory, transport);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.project = "test-project"; req.username = "test-user"; next(); });
    app.use("/obsidian-completions", createObsidianCompletionRouter(jobs));
    server = await new Promise<http.Server>((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}/obsidian-completions`;

    const id = crypto.randomUUID();
    const body = {
      target: "http://10.0.0.141:8000/v1",
      payload: { model: "test-model", messages: [{ role: "user", content: "Reply with the vault result." }] },
    };
    const first = await fetch(`${base}/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(first.status).toBe(202);
    await vi.waitFor(() => expect(jobs.get(JSON.stringify(["test-project", "test-user"]), id)?.status).toBe("failed"));

    const resubmitted = await fetch(`${base}/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(resubmitted.status).toBe(202);
    expect((await resubmitted.json()).status).toBe("running");

    const completed = await fetch(`${base}/${id}`);
    const saved = await completed.json();
    expect(saved).toMatchObject({ status: "completed", response: { status: 200, data: { choices: [{ message: { content: "VAULT_CHAT_OK" } }] } } });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("does not restart a job the user cancelled when the same id is resubmitted (audit 3e65c57)", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-completion-cancel-"));
    const transport = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }));
    const jobs = new ObsidianCompletionJobs(directory, transport as never);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.project = "test-project"; req.username = "test-user"; next(); });
    app.use("/obsidian-completions", createObsidianCompletionRouter(jobs));
    server = await new Promise<http.Server>((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}/obsidian-completions`;
    const scope = JSON.stringify(["test-project", "test-user"]);
    const id = crypto.randomUUID();
    const body = {
      target: "http://10.0.0.141:8000/v1",
      payload: { model: "test-model", messages: [{ role: "user", content: "long job" }] },
    };
    expect((await fetch(`${base}/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status).toBe(202);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    jobs.cancel(scope, id);
    await vi.waitFor(() => expect(jobs.get(scope, id)?.response?.status).toBe(499));
    const resubmitted = await fetch(`${base}/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await resubmitted.json()).status).toBe("failed");
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
