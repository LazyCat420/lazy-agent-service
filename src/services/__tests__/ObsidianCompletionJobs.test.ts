import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ObsidianCompletionJobs } from "../ObsidianCompletionJobs";

const target = "http://10.0.0.30:8000/v1";

function payload(text = "hello") {
  return { model: "test-model", messages: [{ role: "user", content: text }] };
}

function response(data: unknown = { choices: [] }): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function store() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-completion-jobs-"));
  return {
    directory,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

describe("ObsidianCompletionJobs", () => {
  it("accepts a UUID before transport resolves and deduplicates the exact request", async () => {
    const temp = store();
    const pending = deferred<Response>();
    const transport = vi.fn(() => pending.promise);
    const jobs = new ObsidianCompletionJobs(temp.directory, transport);
    const id = crypto.randomUUID();
    try {
      const request = payload();

      expect(jobs.submit("desktop", id, target, request).status).toBe("running");
      expect(jobs.get("desktop", id)?.status).toBe("running");
      const scopeDirectory = fs.readdirSync(temp.directory).map((owner) => path.join(temp.directory, owner));
      const record = fs.readdirSync(scopeDirectory[0]).find((file) => file.endsWith(".json"));
      expect(record).toBeDefined();
      expect(JSON.parse(fs.readFileSync(path.join(scopeDirectory[0], record!), "utf8"))).toMatchObject({ status: "running" });
      expect(jobs.submit("desktop", id, target, request).status).toBe("running");
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      pending.resolve(response());
      await vi.waitFor(() => expect(jobs.get("desktop", id)?.status).toBe("completed"));
      temp.cleanup();
    }
  });

  it("persists the completed response and a second store can fetch it", async () => {
    const temp = store();
    const pending = deferred<Response>();
    try {
      const first = new ObsidianCompletionJobs(temp.directory, vi.fn(() => pending.promise));
      const id = crypto.randomUUID();
      first.submit("desktop", id, target, payload("durable"));
      pending.resolve(response({ answer: "saved" }));
      await vi.waitFor(() => expect(first.get("desktop", id)?.status).toBe("completed"));

      const second = new ObsidianCompletionJobs(temp.directory, vi.fn());
      expect(second.get("desktop", id)).toMatchObject({
        status: "completed",
        response: { status: 200, data: { answer: "saved" } },
      });
    } finally {
      temp.cleanup();
    }
  });

  it("isolates scopes and rejects mismatched, disallowed, or invalid requests", async () => {
    const temp = store();
    const pending = deferred<Response>();
    const id = crypto.randomUUID();
    const jobs = new ObsidianCompletionJobs(temp.directory, vi.fn(() => pending.promise));
    try {
      const request = payload();
      jobs.submit("desktop", id, target, request);

      expect(jobs.get("other-scope", id)).toBeNull();
      expect(() => jobs.submit("desktop", id, target, payload("different"))).toThrow("another request");
      expect(() => jobs.submit("desktop", crypto.randomUUID(), "http://127.0.0.1:8000/v1", request)).toThrow("not allowed");
      expect(() => jobs.submit("desktop", "invalid-id", target, request)).toThrow("Invalid completion id");
    } finally {
      pending.resolve(response());
      await vi.waitFor(() => expect(jobs.get("desktop", id)?.status).toBe("completed"));
      temp.cleanup();
    }
  });

  it("cancels only the matching scoped job and persists its aborted outcome", async () => {
    const temp = store(); const id = crypto.randomUUID();
    const transport = vi.fn((_url: any, options: any) => new Promise<Response>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")))));
    const jobs = new ObsidianCompletionJobs(temp.directory, transport as any);
    try {
      jobs.submit("desktop", id, target, payload());
      expect(jobs.cancel("other", id)).toBeNull();
      expect(jobs.get("desktop", id)?.status).toBe("running");
      jobs.cancel("desktop", id);
      await vi.waitFor(() => expect(jobs.get("desktop", id)).toMatchObject({ status: "failed", response: { status: 499 } }));
      expect(new ObsidianCompletionJobs(temp.directory, vi.fn()).get("desktop", id)?.response?.status).toBe(499);
    } finally { temp.cleanup(); }
  });

  it("marks an interrupted running record failed without replaying transport", async () => {
    const temp = store();
    const pending = deferred<Response>();
    const transport = vi.fn(() => pending.promise);
    const first = new ObsidianCompletionJobs(temp.directory, transport);
    const id = crypto.randomUUID();
    try {
      first.submit("desktop", id, target, payload("interrupted"));

      const restartedTransport = vi.fn();
      const second = new ObsidianCompletionJobs(temp.directory, restartedTransport);
      expect(second.get("desktop", id)).toMatchObject({
        status: "failed",
        response: { status: 503 },
      });
      expect(restartedTransport).not.toHaveBeenCalled();
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      pending.resolve(response());
      await vi.waitFor(() => expect(first.get("desktop", id)?.status).toBe("completed"));
      temp.cleanup();
    }
  });
});
