import type { SpanData, AgentRunManifest, TelemetryBatch } from "../contracts/telemetry.ts";

export interface ExporterConfig {
  collectorEndpoint: string;
  maxQueueSize?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  serviceSource?: string;
}

export const DEFAULT_EXPORTER_CONFIG: ExporterConfig = {
  collectorEndpoint: process.env.TELEMETRY_COLLECTOR_URL || "http://10.0.0.16:5595/v1/telemetry",
  maxQueueSize: 2000,
  batchSize: 50,
  flushIntervalMs: 5000,
  serviceSource: "lazy-agent-service",
};

/**
 * Sanitizes object keys and values against credential / secret patterns.
 */
export function sanitizeTelemetryPayload(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sanitizeTelemetryPayload);
  }
  if (obj && typeof obj === "object") {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (/password|secret|token|api[_-]?key|credential|private[_-]?key/i.test(key)) {
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
 * TraceExporter — Fail-safe, non-blocking asynchronous trace exporter with ring-buffered queue.
 */
export class TraceExporter {
  private static instance: TraceExporter | null = null;
  private queue: SpanData[] = [];
  private runQueue: AgentRunManifest[] = [];
  private config: ExporterConfig;
  private timer: NodeJS.Timeout | null = null;
  private isFlushing = false;

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
      // Drop oldest 10% to prevent unbounded memory growth
      this.queue.splice(0, Math.floor(max * 0.1));
    }
    this.queue.push(span);
  }

  enqueueRun(run: AgentRunManifest): void {
    const max = this.config.maxQueueSize || 2000;
    if (this.runQueue.length >= max) {
      this.runQueue.splice(0, Math.floor(max * 0.1));
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

      // Native fetch with 3-second hard timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      await fetch(this.config.collectorEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
        signal: controller.signal,
      }).catch(() => {
        // Collector unreachable or timed out; drop silently to guarantee harness SLA
      }).finally(() => {
        clearTimeout(timeoutId);
      });
    } catch {
      // Network or serialization error caught; safe fail-open
    } finally {
      this.isFlushing = false;
    }
  }

  getQueueLength(): { spans: number; runs: number } {
    return { spans: this.queue.length, runs: this.runQueue.length };
  }

  getQueuedSpans(): SpanData[] {
    return [...this.queue];
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
