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
    // A streaming request gets an SSE response; the fallback (non-stream) request gets JSON.
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => String(init?.body).includes('"stream":true')
      ? new Response("data: {\"id\":\"chatcmpl-1\",\"model\":\"test-model\",\"choices\":[{\"delta\":{\"content\":\"VAULT_CHAT_OK\"}}]}\n\ndata: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } })
      : new Response(JSON.stringify({ choices: [{ message: { content: "VAULT_CHAT_OK" } }] }), { status: 200 }));
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
    // Two upstream calls on the successful run: the stream attempt (answered non-SSE) plus the non-stream fallback.
    expect(transport).toHaveBeenCalledTimes(3);
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

  it("grows job.partial during a streamed run and completes with the full response", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-completion-stream-"));
    // The test releases each chunk itself, so partial growth is observed without real-time sleeps.
    const releaseChunk = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const sse = (chunks: string[]) => new Response(new ReadableStream({
      async start(controller) {
        for (const [index, chunk] of chunks.entries()) {
          await releaseChunk[index].promise;
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "chatcmpl-2", model: "test-model", choices: [{ delta: { content: chunk } }] })}\n\n`));
        }
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => String(init?.body).includes('"stream":true')
      ? sse(["Once ", "upon ", "a ", "time"])
      : new Response(JSON.stringify({ choices: [{ message: { content: "fallback" } }] }), { status: 200 }));
    const jobs = new ObsidianCompletionJobs(directory, transport);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.project = "test-project"; req.username = "test-user"; next(); });
    app.use("/obsidian-completions", createObsidianCompletionRouter(jobs));
    server = await new Promise<http.Server>((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}/obsidian-completions`;
    const id = crypto.randomUUID();
    const body = { target: "http://10.0.0.141:8000/v1", payload: { model: "test-model", messages: [{ role: "user", content: "story" }] } };
    await fetch(`${base}/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const scope = JSON.stringify(["test-project", "test-user"]);

    // partial grows between polls while the stream is open
    releaseChunk[0].resolve();
    await vi.waitFor(() => expect(jobs.get(scope, id)?.partial).toBe("Once "));
    releaseChunk[1].resolve();
    await vi.waitFor(() => expect(jobs.get(scope, id)?.partial).toBe("Once upon "));
    releaseChunk[2].resolve();
    await vi.waitFor(() => expect(jobs.get(scope, id)?.partial).toBe("Once upon a "));
    releaseChunk[3].resolve();

    await vi.waitFor(() => expect(jobs.get(scope, id)?.status).toBe("completed"));
    const done = jobs.get(scope, id)!;
    expect(done.response?.data).toMatchObject({ object: "chat.completion", choices: [{ message: { role: "assistant", content: "Once upon a time" } }] });
    expect(done.partial).toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("falls back to the non-stream path when the model endpoint returns no SSE", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-completion-nostream-"));
    const transport = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "buffered reply" } }] }), { status: 200 }));
    const jobs = new ObsidianCompletionJobs(directory, transport);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.project = "test-project"; req.username = "test-user"; next(); });
    app.use("/obsidian-completions", createObsidianCompletionRouter(jobs));
    server = await new Promise<http.Server>((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}/obsidian-completions`;
    const id = crypto.randomUUID();
    const body = { target: "http://10.0.0.141:8000/v1", payload: { model: "test-model", messages: [{ role: "user", content: "hi" }] } };
    await fetch(`${base}/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await vi.waitFor(() => expect(jobs.get(JSON.stringify(["test-project", "test-user"]), id)?.status).toBe("completed"));
    const done = jobs.get(JSON.stringify(["test-project", "test-user"]), id)!;
    expect(done.response?.data).toMatchObject({ choices: [{ message: { content: "buffered reply" } }] });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("reassembles streamed tool calls and the choice-level finish_reason (vLLM shape)", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-completion-tools-"));
    // Chunk shape captured from GLM on vLLM: reasoning, then tool calls split by index, finish_reason on the choice.
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "search the web" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "search_web", arguments: "" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"query\":\"top " } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "news\"}" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "search_web", arguments: "{\"query\":\"world news\"}" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    const transport = vi.fn(async () => new Response(chunks.map((c) => `data: ${JSON.stringify({ id: "chatcmpl-3", model: "GLM", ...c })}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const jobs = new ObsidianCompletionJobs(directory, transport);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.project = "test-project"; req.username = "test-user"; next(); });
    app.use("/obsidian-completions", createObsidianCompletionRouter(jobs));
    server = await new Promise<http.Server>((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
    const address = server.address() as { port: number };
    const id = crypto.randomUUID();
    const body = { target: "http://10.0.0.141:8000/v1", payload: { model: "GLM", messages: [{ role: "user", content: "news today" }], tools: [] } };
    await fetch(`http://127.0.0.1:${address.port}/obsidian-completions/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const scope = JSON.stringify(["test-project", "test-user"]);
    await vi.waitFor(() => expect(jobs.get(scope, id)?.status).toBe("completed"));
    // Completed job data is the assembled chat.completion built by consumeStream.
    const data = jobs.get(scope, id)!.response?.data as { choices: Array<{ finish_reason: string | null; message: { content: string; tool_calls?: unknown[] } }> };
    const choice = data.choices[0];
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message.content).toBe("");
    expect(choice.message.tool_calls).toEqual([
      { id: "call_a", type: "function", function: { name: "search_web", arguments: "{\"query\":\"top news\"}" } },
      { id: "call_b", type: "function", function: { name: "search_web", arguments: "{\"query\":\"world news\"}" } },
    ]);
  });
});
