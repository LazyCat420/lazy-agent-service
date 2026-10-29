import crypto from "node:crypto";
import { RunEvidenceStore } from "../verify/RunEvidenceStore.js";
export class Span {
    trace_id;
    span_id;
    parent_span_id;
    run_id;
    name;
    kind;
    start_time;
    status = "UNSET";
    status_message;
    end_time;
    duration_ms;
    attributes = {};
    events = [];
    links = [];
    startTimeMs;
    constructor(options) {
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
    setAttribute(key, value) {
        this.attributes[key] = value;
        return this;
    }
    setAttributes(attrs) {
        Object.assign(this.attributes, attrs);
        return this;
    }
    addEvent(name, attributes) {
        this.events.push({
            name,
            timestamp: new Date().toISOString(),
            attributes,
        });
        return this;
    }
    addLink(link) {
        this.links.push(link);
        return this;
    }
    setStatus(status, message) {
        this.status = status;
        if (message)
            this.status_message = message;
        return this;
    }
    end(status, message) {
        const endTimeMs = Date.now();
        this.end_time = new Date(endTimeMs).toISOString();
        this.duration_ms = endTimeMs - this.startTimeMs;
        if (status) {
            this.status = status;
        }
        else if (this.status === "UNSET") {
            this.status = "OK";
        }
        if (message) {
            this.status_message = message;
        }
        const data = this.toJSON();
        RunEvidenceStore.getGlobalInstance().record(data);
        return data;
    }
    toJSON() {
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
//# sourceMappingURL=Span.js.map