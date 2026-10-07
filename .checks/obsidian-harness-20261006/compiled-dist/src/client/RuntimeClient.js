/** Transport only: applications execute local tools and submit observations; no reasoning loop. */
export class RuntimeClient {
    baseUrl;
    headers;
    constructor(baseUrl, headers = {}) {
        this.baseUrl = baseUrl;
        this.headers = headers;
        this.baseUrl = baseUrl.replace(/\/$/, "");
        if (!this.baseUrl.endsWith("/v1/runs"))
            this.baseUrl += "/v1/runs";
    }
    async command(path, method, body, signal) {
        const response = await fetch(this.baseUrl + path, { method, headers: { ...this.headers, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal });
        if (!response.ok)
            throw new Error(`Runtime command failed (HTTP ${response.status})`);
        return response.json();
    }
    createRun(request) {
        const { signal, identity: _identity, ...wire } = request;
        return this.command("", "POST", { ...wire, stream: false }, signal);
    }
    getRun(runId) { return this.command(`/${encodeURIComponent(runId)}`, "GET"); }
    cancelRun(runId) { return this.command(`/${encodeURIComponent(runId)}/cancel`, "POST", {}); }
    submitToolResult(runId, callId, result, authorization_receipt, is_error = false) {
        return this.command(`/${encodeURIComponent(runId)}/tools/${encodeURIComponent(callId)}/result`, "POST", { result, authorization_receipt, is_error });
    }
    resolveApproval(runId, approvalId, approved) {
        return this.command(`/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`, "POST", { approved });
    }
    steerRun(runId, instruction) { return this.command(`/${encodeURIComponent(runId)}/steer`, "POST", { instruction }); }
    decide(runId, request) {
        return this.command(`/${encodeURIComponent(runId)}/decisions`, "POST", request);
    }
    async *readEvents(response, expectedRunId) {
        if (!response.body)
            throw new Error("Runtime stream has no body");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const seen = new Set();
        let buffer = "", runId = expectedRunId;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                buffer += decoder.decode(value, { stream: !done });
                let boundary;
                while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
                    const block = buffer.slice(0, boundary.index);
                    buffer = buffer.slice(boundary.index + boundary[0].length);
                    const payload = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
                    if (!payload)
                        continue;
                    if (payload === "[DONE]")
                        throw new Error("Runtime stream ended without a terminal outcome");
                    const event = JSON.parse(payload);
                    if (!event || !event.id || typeof event.id !== "string" || !event.run_id || typeof event.run_id !== "string" || typeof event.type !== "string" || typeof event.timestamp !== "string" || !Number.isFinite(Date.parse(event.timestamp)) || !event.data || typeof event.data !== "object" || Array.isArray(event.data))
                        throw new Error("Invalid runtime event");
                    if (runId && event.run_id !== runId)
                        throw new Error("Runtime event belongs to another run");
                    runId = event.run_id;
                    if (seen.has(event.id))
                        continue;
                    seen.add(event.id);
                    yield event;
                }
                if (done) {
                    if (buffer.trim() && !buffer.trim().startsWith(":"))
                        throw new Error("Incomplete runtime event");
                    return;
                }
            }
        }
        finally {
            try {
                await reader.cancel();
            }
            catch { /* Preserve decoding/transport error. */ }
            reader.releaseLock();
        }
    }
    async *replayEvents(runId, after) {
        const response = await fetch(`${this.baseUrl}/${encodeURIComponent(runId)}/events${after ? `?after=${encodeURIComponent(after)}` : ""}`, { headers: this.headers });
        if (!response.ok)
            throw new Error(`Runtime replay failed (HTTP ${response.status})`);
        yield* this.readEvents(response, runId);
    }
    async *streamRun(request) {
        const { signal, identity: _identity, ...wire } = request;
        const response = await fetch(this.baseUrl, { method: "POST", signal, headers: { ...this.headers, "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify({ ...wire, stream: true }) });
        if (!response.ok || !response.body)
            throw new Error(`Runtime stream failed (HTTP ${response.status})`);
        let runId, terminal = false;
        try {
            for await (const event of this.readEvents(response)) {
                runId = event.run_id;
                terminal = ["run.completed", "run.failed", "run.cancelled"].includes(event.type);
                yield event;
                if (terminal)
                    return;
            }
            throw new Error("Runtime stream ended before a terminal outcome");
        }
        finally {
            if (runId && !terminal) {
                try {
                    await this.command(`/${encodeURIComponent(runId)}/cancel`, "POST", {}, AbortSignal.timeout(2000));
                }
                catch { /* Preserve the stream failure or consumer cancellation. */ }
            }
        }
    }
}
//# sourceMappingURL=RuntimeClient.js.map