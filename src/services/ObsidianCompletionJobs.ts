import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface CompletionJob {
  id: string;
  fingerprint: string;
  status: "running" | "completed" | "failed";
  createdAt: number;
  response?: { status: number; data?: unknown; errText?: string };
}

/** Durable model steps. Vault tools remain on the Obsidian client. */
export class ObsidianCompletionJobs {
  private active = new Map<string, CompletionJob>();
  private controllers = new Map<string, AbortController>();
  constructor(private directory = path.join(path.dirname(process.env.RUNTIME_STORE_PATH || path.resolve("data/run_store_durable.json")), "obsidian-completions"), private transport: typeof fetch = fetch) {}

  private file(scope: string, id: string) {
    if (!/^[\da-f-]{36}$/i.test(id)) throw new Error("Invalid completion id");
    const owner = crypto.createHash("sha256").update(scope).digest("hex");
    return path.join(this.directory, owner, `${id}.json`);
  }
  private write(file: string, job: CompletionJob) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(job), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  get(scope: string, id: string): CompletionJob | null {
    const file = this.file(scope, id);
    const active = this.active.get(file);
    if (active) return active;
    if (!fs.existsSync(file)) return null;
    const job: CompletionJob = JSON.parse(fs.readFileSync(file, "utf8"));
    if (job.status === "running") {
      job.status = "failed";
      job.response = { status: 503, errText: "Model job interrupted by a service restart. It was not replayed." };
      this.write(file, job);
    }
    return job;
  }
  cancel(scope: string, id: string): CompletionJob | null {
    const file = this.file(scope, id); const job = this.get(scope, id);
    if (job?.status === "running") this.controllers.get(file)?.abort();
    return job;
  }
  submit(scope: string, id: string, target: string, payload: Record<string, unknown>): CompletionJob {
    // A desktop cannot use this endpoint as an arbitrary network proxy.
    const allowed = ["http://10.0.0.30:8000/v1", "http://10.0.0.141:8000/v1"];
    target = target.replace(/\/+$/, "");
    if (!allowed.includes(target)) throw new Error("Model endpoint is not allowed for durable Vault Notes");
    if (!Array.isArray(payload.messages) || typeof payload.model !== "string" || JSON.stringify(payload).length > 2_000_000) throw new Error("Invalid model request");
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify([target, payload])).digest("hex");
    const existing = this.get(scope, id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("Completion id already belongs to another request");
      return existing;
    }
    if (this.active.size >= 8) throw new Error("Durable completion capacity reached; retry later");
    const job: CompletionJob = { id, fingerprint, status: "running", createdAt: Date.now() };
    const file = this.file(scope, id);
    this.write(file, job); // Commit acceptance before releasing the HTTP connection.
    this.active.set(file, job);
    this.controllers.set(file, new AbortController());
    void this.execute(file, job, target, payload);
    return job;
  }
  private async execute(file: string, job: CompletionJob, target: string, payload: Record<string, unknown>) {
    try {
      const response = await this.transport(`${target}/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, stream: false }), signal: AbortSignal.any([this.controllers.get(file)!.signal, AbortSignal.timeout(180000)]),
      });
      job.response = response.ok ? { status: response.status, data: await response.json() } : { status: response.status, errText: (await response.text()).slice(0, 4000) };
      job.status = response.ok ? "completed" : "failed";
    } catch (error) {
      job.status = "failed";
      job.response = { status: this.controllers.get(file)?.signal.aborted ? 499 : 502, errText: this.controllers.get(file)?.signal.aborted ? "Model job cancelled" : error instanceof Error ? error.message : String(error) };
    }
    try { this.write(file, job); this.active.delete(file); this.controllers.delete(file); }
    catch {
      // Keep a failed record in memory rather than acknowledging an unsaved result.
      job.status = "failed";
      job.response = { status: 507, errText: "Could not persist the model outcome on the server" };
    }
  }
}
