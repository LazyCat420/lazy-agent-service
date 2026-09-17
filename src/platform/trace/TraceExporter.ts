import type { SpanData, AgentRunManifest, TelemetryBatch } from "../contracts/telemetry.ts";

export interface ExporterConfig {
  collectorEndpoint: string;
  maxQueueSize?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  serviceSource?: string;
  authToken?: string;
}

export interface ExporterMetrics {
  queue_depth_spans: number;
  queue_depth_runs: number;
  overflow_drops: number;
  export_failures: number;
  rejected_batches: number;
  successful_exports: number;
  last_success_time: string | null;
  last_failure_time: string | null;
}

export const DEFAULT_EXPORTER_CONFIG: ExporterConfig = {
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
export function sanitizeTelemetryPayload(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sanitizeTelemetryPayload);
  }
  if (obj && typeof obj === "object") {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      // Preserve numeric token metrics unconditionally
      const isNumericTokenField =
        typeof value === "number" &&
        /token/i.test(key);
      const isKnownTokenMetric =
        /^(total_tokens|tokens_input|tokens_output|tokens_cache|prompt_tokens|completion_tokens|inputTokens|outputTokens|totalTokens|tokens)$/i.test(key);

      if (isNumericTokenField || isKnownTokenMetric) {
        clean[key] = value;
      } else if (/password|secret|token|bearer|api[_-]?key|credential|private[_-]?key/i.test(key)) {
        clean[key] = "[REDACTED]";
      } else {
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
  private static instance: TraceExporter | null = null;
  private queue: SpanData[] = [];
  private runQueue: AgentRunManifest[] = [];
  private config: ExporterConfig;
  private timer: NodeJS.Timeout | null = null;
  private isFlushing = false;

  // Producer-side observability metrics
  private overflowDrops = 0;
  private exportFailures = 0;
  private rejectedBatches = 0;
  private successfulExports = 0;
  private lastSuccessTime: string | null = null;
  private lastFailureTime: string | null = null;

  constructor(config: Partial<ExporterConfig> = {}) {
    this.config = { ...DEFAULT_EXPORTER_CONFIG, ...config };
    this.startPeriodicFlush();
  }

  static getGlobalInstance(): TraceExporter {
    if (!this.instance) {
      this.instance = new TraceExporter();
    }
    return this.instance;
  }

  static setGlobalInstance(exporter: TraceExporter): void {
    if (this.instance) {
      this.instance.stop();
    }
    this.instance = exporter;
  }

  enqueueSpan(span: SpanData): void {
    const max = this.config.maxQueueSize || 2000;
    if (this.queue.length >= max) {
      // Drop oldest 10% to prevent unbounded memory growth and track drops
      const droppedCount = Math.floor(max * 0.1);
      this.queue.splice(0, droppedCount);
      this.overflowDrops += droppedCount;
    }
    this.queue.push(span);
  }

  enqueueRun(run: AgentRunManifest): void {
    const max = this.config.maxQueueSize || 2000;
    if (this.runQueue.length >= max) {
      const droppedCount = Math.floor(max * 0.1);
      this.runQueue.splice(0, droppedCount);
      this.overflowDrops += droppedCount;
    }
    this.runQueue.push(run);
  }

  private startPeriodicFlush(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.flush().catch(() => {
        // Suppress unhandled rejections — telemetry never crashes runtime
      });
    }, this.config.flushIntervalMs || 5000);
    if (this.timer.unref) this.timer.unref();
  }

  async flush(): Promise<void> {
    if (this.isFlushing || (this.queue.length === 0 && this.runQueue.length === 0)) {
      return;
    }

    this.isFlushing = true;
    const batchSize = this.config.batchSize || 50;
    const spansToExport = this.queue.splice(0, batchSize);
    const runsToExport = this.runQueue.splice(0, batchSize);

    try {
      const batch: TelemetryBatch = {
        schema_version: "1.0",
        service_source: this.config.serviceSource || "lazy-agent-service",
        exported_at: new Date().toISOString(),
        spans: sanitizeTelemetryPayload(spansToExport) as SpanData[],
        runs: sanitizeTelemetryPayload(runsToExport) as AgentRunManifest[],
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const headers: Record<string, string> = {
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
        } else {
          // HTTP rejection counts as failure
          this.exportFailures++;
          this.rejectedBatches++;
          this.lastFailureTime = new Date().toISOString();
        }
      } catch {
        // Network failure or timeout
        this.exportFailures++;
        this.lastFailureTime = new Date().toISOString();
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      this.exportFailures++;
      this.lastFailureTime = new Date().toISOString();
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Bounded shutdown flush that drains the complete queue in batches within the timeout.
   */
  async flushAll(timeoutMs: number = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((this.queue.length > 0 || this.runQueue.length > 0) && Date.now() < deadline) {
      await this.flush();
    }
  }

  getQueueLength(): { spans: number; runs: number } {
    return { spans: this.queue.length, runs: this.runQueue.length };
  }

  getQueuedSpans(): SpanData[] {
    return [...this.queue];
  }

  getMetrics(): ExporterMetrics {
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

  clear(): void {
    this.queue = [];
    this.runQueue = [];
    this.overflowDrops = 0;
    this.exportFailures = 0;
    this.rejectedBatches = 0;
    this.successfulExports = 0;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
