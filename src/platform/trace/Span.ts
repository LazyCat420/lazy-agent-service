import crypto from "node:crypto";
import type { SpanData, SpanStatus, SpanAttributes, SpanEvent, SpanLink } from "../contracts/telemetry.ts";

export class Span {
  readonly trace_id: string;
  readonly span_id: string;
  readonly parent_span_id: string | null;
  readonly run_id: string;
  readonly name: string;
  readonly kind: SpanData["kind"];
  readonly start_time: string;
  status: SpanStatus = "UNSET";
  status_message?: string;
  end_time?: string;
  duration_ms?: number;
  attributes: SpanAttributes = {};
  events: SpanEvent[] = [];
  links: SpanLink[] = [];

  private startTimeMs: number;

  constructor(options: {
    trace_id?: string;
    span_id?: string;
    parent_span_id?: string | null;
    run_id: string;
    name: string;
    kind: SpanData["kind"];
    attributes?: SpanAttributes;
  }) {
    this.trace_id = options.trace_id || crypto.randomUUID().replaceAll("-", "").slice(0, 32);
    this.span_id = options.span_id || crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    this.parent_span_id = options.parent_span_id ?? null;
    this.run_id = options.run_id;
    this.name = options.name;
    this.kind = options.kind;
    this.startTimeMs = Date.now();
    this.start_time = new Date(this.startTimeMs).toISOString();
    if (options.attributes) {
      this.attributes = { ...options.attributes };
    }
  }

  setAttribute(key: string, value: unknown): this {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attrs: SpanAttributes): this {
    Object.assign(this.attributes, attrs);
    return this;
  }

  addEvent(name: string, attributes?: Record<string, unknown>): this {
    this.events.push({
      name,
      timestamp: new Date().toISOString(),
      attributes,
    });
    return this;
  }

  addLink(link: SpanLink): this {
    this.links.push(link);
    return this;
  }

  setStatus(status: SpanStatus, message?: string): this {
    this.status = status;
    if (message) this.status_message = message;
    return this;
  }

  end(status?: SpanStatus, message?: string): SpanData {
    const endTimeMs = Date.now();
    this.end_time = new Date(endTimeMs).toISOString();
    this.duration_ms = endTimeMs - this.startTimeMs;
    if (status) {
      this.status = status;
    } else if (this.status === "UNSET") {
      this.status = "OK";
    }
    if (message) {
      this.status_message = message;
    }
    return this.toJSON();
  }

  toJSON(): SpanData {
    return {
      trace_id: this.trace_id,
      span_id: this.span_id,
      parent_span_id: this.parent_span_id,
      run_id: this.run_id,
      name: this.name,
      kind: this.kind,
      status: this.status,
      status_message: this.status_message,
      start_time: this.start_time,
      end_time: this.end_time,
      duration_ms: this.duration_ms,
      attributes: this.attributes,
      events: this.events,
      links: this.links,
    };
  }
}
