export const DEFAULT_EXPORTER_CONFIG = {
    collectorEndpoint: process.env.TELEMETRY_COLLECTOR_URL || "http://10.0.0.16:5595/v1/telemetry",
    maxQueueSize: 2000,
    batchSize: 50,
    flushIntervalMs: 5000,
    serviceSource: "lazy-agent-service",
    authToken: process.env.TELEMETRY_SERVICE_TOKEN,
};
/**
 * Sanitizes object keys and values against credential / secret patterns,
 * while strictly preserving numeric usage metrics (tokens, token counts).
 */
export function sanitizeTelemetryPayload(obj) {
    if (Array.isArray(obj)) {
        return obj.map(sanitizeTelemetryPayload);
    }
    if (obj && typeof obj === "object") {
        const clean = {};
        for (const [key, value] of Object.entries(obj)) {
            // Preserve numeric token metrics unconditionally
            const isNumericTokenField = typeof value === "number" &&
                /token/i.test(key);
            const isKnownTokenMetric = /^(total_tokens|tokens_input|tokens_output|tokens_cache|prompt_tokens|completion_tokens|inputTokens|outputTokens|totalTokens|tokens)$/i.test(key);
            if (isNumericTokenField || isKnownTokenMetric) {
                clean[key] = value;
            }
            else if (/password|secret|token|bearer|api[_-]?key|credential|private[_-]?key/i.test(key)) {
                clean[key] = "[REDACTED]";
            }
            else {
                clean[key] = sanitizeTelemetryPayload(value);
            }
        }
        return clean;
    }
    if (typeof obj === "string") {
        return obj.replace(/<(think|thought_process|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, "[private reasoning omitted]");
    }
    return obj;
}
/**
 * TraceExporter — Fail-safe, non-blocking asynchronous trace exporter with ring-buffered queue,
 * measurable overflow drops, export failures, and shutdown flushing.
 */
export class TraceExporter {
    static instance = null;
    queue = [];
    runQueue = [];
    config;
    timer = null;
    isFlushing = false;
    // Producer-side observability metrics
    overflowDrops = 0;
    exportFailures = 0;
    rejectedBatches = 0;
    successfulExports = 0;
    lastSuccessTime = null;
    lastFailureTime = null;
    constructor(config = {}) {
        this.config = { ...DEFAULT_EXPORTER_CONFIG, ...config };
        this.startPeriodicFlush();
    }
    static getGlobalInstance() {
        if (!this.instance) {
            this.instance = new TraceExporter();
        }
        return this.instance;
    }
    static setGlobalInstance(exporter) {
        if (this.instance) {
            this.instance.stop();
        }
        this.instance = exporter;
    }
    enqueueSpan(span) {
        const max = this.config.maxQueueSize || 2000;
        if (this.queue.length >= max) {
            // Drop oldest 10% to prevent unbounded memory growth and track drops
            const droppedCount = Math.floor(max * 0.1);
            this.queue.splice(0, droppedCount);
            this.overflowDrops += droppedCount;
        }
        this.queue.push(span);
    }
    enqueueRun(run) {
        const max = this.config.maxQueueSize || 2000;
        if (this.runQueue.length >= max) {
            const droppedCount = Math.floor(max * 0.1);
            this.runQueue.splice(0, droppedCount);
            this.overflowDrops += droppedCount;
        }
        this.runQueue.push(run);
    }
    startPeriodicFlush() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = setInterval(() => {
            this.flush().catch(() => {
                // Suppress unhandled rejections — telemetry never crashes runtime
            });
        }, this.config.flushIntervalMs || 5000);
        if (this.timer.unref)
            this.timer.unref();
    }
    async flush() {
        if (this.isFlushing || (this.queue.length === 0 && this.runQueue.length === 0)) {
            return;
        }
        this.isFlushing = true;
        const batchSize = this.config.batchSize || 50;
        const spansToExport = this.queue.splice(0, batchSize);
        const runsToExport = this.runQueue.splice(0, batchSize);
        try {
            const batch = {
                schema_version: "1.0",
                service_source: this.config.serviceSource || "lazy-agent-service",
                exported_at: new Date().toISOString(),
                spans: sanitizeTelemetryPayload(spansToExport),
                runs: sanitizeTelemetryPayload(runsToExport),
            };
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            const headers = {
                "Content-Type": "application/json",
            };
            if (this.config.authToken) {
                headers["X-Service-Token"] = this.config.authToken;
            }
            try {
                const res = await fetch(this.config.collectorEndpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(batch),
                    signal: controller.signal,
                });
                if (res.ok) {
                    this.successfulExports++;
                    this.lastSuccessTime = new Date().toISOString();
                }
                else {
                    // HTTP rejection counts as failure
                    this.exportFailures++;
                    this.rejectedBatches++;
                    this.lastFailureTime = new Date().toISOString();
                }
            }
            catch {
                // Network failure or timeout
                this.exportFailures++;
                this.lastFailureTime = new Date().toISOString();
            }
            finally {
                clearTimeout(timeoutId);
            }
        }
        catch {
            this.exportFailures++;
            this.lastFailureTime = new Date().toISOString();
        }
        finally {
            this.isFlushing = false;
        }
    }
    /**
     * Bounded shutdown flush that drains the complete queue in batches within the timeout.
     */
    async flushAll(timeoutMs = 5000) {
        const deadline = Date.now() + timeoutMs;
        while ((this.queue.length > 0 || this.runQueue.length > 0) && Date.now() < deadline) {
            await this.flush();
        }
    }
    getQueueLength() {
        return { spans: this.queue.length, runs: this.runQueue.length };
    }
    getQueuedSpans() {
        return [...this.queue];
    }
    getMetrics() {
        return {
            queue_depth_spans: this.queue.length,
            queue_depth_runs: this.runQueue.length,
            overflow_drops: this.overflowDrops,
            export_failures: this.exportFailures,
            rejected_batches: this.rejectedBatches,
            successful_exports: this.successfulExports,
            last_success_time: this.lastSuccessTime,
            last_failure_time: this.lastFailureTime,
        };
    }
    clear() {
        this.queue = [];
        this.runQueue = [];
        this.overflowDrops = 0;
        this.exportFailures = 0;
        this.rejectedBatches = 0;
        this.successfulExports = 0;
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
//# sourceMappingURL=TraceExporter.js.map