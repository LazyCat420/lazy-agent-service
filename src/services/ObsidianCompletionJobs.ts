import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface CompletionJob {
  id: string;
  fingerprint: string;
  status: "running" | "completed" | "failed";
  createdAt: number;
  /** Growing assistant text while the streamed generation is in flight; omitted once the job completes. */
  partial?: string;
  response?: { status: number; data?: unknown; errText?: string };
}

/** OpenAI SSE tool-call fragment: name/arguments arrive split across chunks, keyed by index. */
interface StreamToolCallDelta { index?: number; id?: string; function?: { name?: string; arguments?: string } }

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
      if (existing.status !== "failed") return existing;
      // A user cancel (499) is a decision, not a fault: a resubmit of the same
      // id (client reconnect/replay) must not restart work the user stopped.
      if (existing.response?.status === 499) return existing;
      // Any other failure (service restart, transient model error) is re-run on request.
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
  /** Read an OpenAI-compatible SSE chat stream, growing job.partial (persisted at most once per
   *  second) and assembling the full chat.completion object old clients expect. */
  private async consumeStream(file: string, job: CompletionJob, response: Response): Promise<CompletionJob["response"]> {
    if (!response.body) throw new Error("Streaming response had no body");
    let partial = ""; let lastPartialWrite = 0;
    const flushPartial = (force = false) => {
      job.partial = partial; // Always visible in memory for GET; only the disk write is throttled.
      const now = Date.now();
      if (!force && now - lastPartialWrite < 1000) return;
      lastPartialWrite = now;
      try { this.write(file, job); } catch { /* the final write below still reports persistence failures */ }
    };
    let id = `chatcmpl-${job.id}`; let created = Math.floor(Date.now() / 1000); let model = ""; let finishReason: string | null = null;
    let usage: Record<string, unknown> | undefined;
    const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data) as { id?: string; created?: number; model?: string; choices?: Array<{ finish_reason?: string | null; delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: StreamToolCallDelta[] } }>; usage?: Record<string, unknown> };
          if (chunk.id) id = chunk.id;
          if (chunk.created) created = chunk.created;
          if (chunk.model) model = chunk.model;
          if (chunk.usage) usage = chunk.usage;
          const choice = chunk.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const delta = choice?.delta;
          for (const call of delta?.tool_calls || []) {
            const slot = toolCalls[call.index ?? toolCalls.length] ||= { id: "", type: "function", function: { name: "", arguments: "" } };
            if (call.id) slot.id = call.id;
            if (call.function?.name) slot.function.name += call.function.name;
            if (call.function?.arguments) slot.function.arguments += call.function.arguments;
          }
          if (typeof delta?.content === "string" && delta.content) { partial += delta.content; flushPartial(); }
        } catch { /* ignore malformed chunks mid-stream */ }
      }
    }
    flushPartial(true);
    return { status: response.status, data: { id, object: "chat.completion", created, model, choices: [{ index: 0, message: {
      role: "assistant", content: partial,
      ...(toolCalls.length ? { tool_calls: toolCalls.filter(Boolean).map((call, i) => ({ ...call, id: call.id || `call_${job.id}_${i}` })) } : {}),
    }, finish_reason: finishReason }], usage } };
  }
  private async execute(file: string, job: CompletionJob, target: string, payload: Record<string, unknown>) {
    const signal = AbortSignal.any([this.controllers.get(file)!.signal, AbortSignal.timeout(Number(process.env.OBSIDIAN_COMPLETION_TIMEOUT_MS) || 600000)]);
    try {
      // Must exceed the plugin's per-job poll window (maxJobPollMs, default 600s), otherwise
      // the server kills a generation the client is still waiting on.
      const streamed = await this.transport(`${target}/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, stream: true, stream_options: { include_usage: true } }), signal,
      });
      const contentType = streamed.headers.get("content-type") || "";
      if (streamed.ok && contentType.includes("text/event-stream")) {
        job.response = await this.consumeStream(file, job, streamed);
        job.status = "completed";
        delete job.partial; // The final response supersedes the partial text.
      } else {
        // Non-SSE (streaming unsupported or rejected): fall back to the buffered path.
        try { await streamed.arrayBuffer(); } catch { /* drain whatever body arrived */ }
        const response = await this.transport(`${target}/chat/completions`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, stream: false }), signal,
        });
        job.response = response.ok ? { status: response.status, data: await response.json() } : { status: response.status, errText: (await response.text()).slice(0, 4000) };
        job.status = response.ok ? "completed" : "failed";
      }
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
