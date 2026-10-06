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
});
