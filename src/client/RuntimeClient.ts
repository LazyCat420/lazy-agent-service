import type { CreateRunRequest, RunEvent, RunResult } from "../types/run.ts";

/** Transport only: applications execute local tools and submit observations; no reasoning loop. */
export class RuntimeClient {
  constructor(private baseUrl: string, private headers: Record<string, string> = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    if (!this.baseUrl.endsWith("/v1/runs")) this.baseUrl += "/v1/runs";
  }
  private async command(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<any> {
    const response = await fetch(this.baseUrl + path, { method, headers: { ...this.headers, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal });
    if (!response.ok) throw new Error(`Runtime command failed (HTTP ${response.status})`);
    return response.json();
  }
  createRun(request: CreateRunRequest): Promise<RunResult> {
    const { signal, identity: _identity, ...wire } = request;
    return this.command("", "POST", { ...wire, stream: false }, signal);
  }
  getRun(runId: string): Promise<RunResult> { return this.command(`/${encodeURIComponent(runId)}`, "GET"); }
  cancelRun(runId: string): Promise<unknown> { return this.command(`/${encodeURIComponent(runId)}/cancel`, "POST", {}); }
  submitToolResult(runId: string, callId: string, result: unknown, authorization_receipt: Record<string, unknown>, is_error = false): Promise<unknown> {
    return this.command(`/${encodeURIComponent(runId)}/tools/${encodeURIComponent(callId)}/result`, "POST", { result, authorization_receipt, is_error });
  }
  resolveApproval(runId: string, approvalId: string, approved: boolean): Promise<unknown> {
    return this.command(`/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`, "POST", { approved });
  }
  steerRun(runId: string, instruction: string): Promise<unknown> { return this.command(`/${encodeURIComponent(runId)}/steer`, "POST", { instruction }); }
  decide(runId: string, request: import("../decision-fabric/contracts.ts").TypedDecisionRequest): Promise<import("../decision-fabric/contracts.ts").DecisionReceipt> {
    return this.command(`/${encodeURIComponent(runId)}/decisions`, "POST", request);
  }
  async *replayEvents(runId: string, after?: string): AsyncGenerator<RunEvent> {
    const response = await fetch(`${this.baseUrl}/${encodeURIComponent(runId)}/events${after ? `?after=${encodeURIComponent(after)}` : ""}`, { headers: this.headers });
    if (!response.ok) throw new Error(`Runtime replay failed (HTTP ${response.status})`);
    for (const block of (await response.text()).split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
      if (data) yield JSON.parse(data) as RunEvent;
    }
  }
  async *streamRun(request: CreateRunRequest): AsyncGenerator<RunEvent> {
    const { signal, identity: _identity, ...wire } = request;
    const response = await fetch(this.baseUrl, { method: "POST", signal, headers: { ...this.headers, "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify({ ...wire, stream: true }) });
    if (!response.ok || !response.body) throw new Error(`Runtime stream failed (HTTP ${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const seen = new Set<string>();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const payload = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
          if (!payload) continue;
          if (payload === "[DONE]") throw new Error("Runtime stream ended without a terminal outcome");
          const event = JSON.parse(payload) as RunEvent;
          if (!event || typeof event.id !== "string" || typeof event.run_id !== "string" || typeof event.type !== "string" || typeof event.timestamp !== "string" || !event.data || typeof event.data !== "object") throw new Error("Invalid runtime event");
          if (seen.has(event.id)) continue;
          seen.add(event.id);
          yield event;
          if (["run.completed", "run.failed", "run.cancelled"].includes(event.type)) return;
        }
        if (done) throw new Error("Runtime stream ended before a terminal outcome");
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
  }
}
