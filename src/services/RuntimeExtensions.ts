import type { AgentProfile } from "./ProfileRegistry.ts";
import type { CreateRunRequest } from "../types/run.ts";

export interface WorkerTaskResult {
  taskId: string;
  status: "success" | "error" | "cancelled";
  output: unknown;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    durationMs: number;
  };
  evidenceRefs: string[];
  error?: { code: string; message: string; retryable: boolean; category: string };
}

export interface RuntimeWorker {
  id: string;
  capabilities: string[];
  execute: (task: {
    workerId: string;
    taskId: string;
    parameters: Record<string, unknown>;
    allocatedBudget: { maxTokens: number; maxDurationMs: number };
  }, context: {
    parentRunId: string;
    traceId: string;
    parentSpanId: string;
    signal: AbortSignal;
    emitEvent: (type: string, data: unknown) => void;
  }) => Promise<WorkerTaskResult>;
}

export interface RuntimeExtension {
  context?: (request: CreateRunRequest) => Promise<string>;
  beforeTool?: (call: unknown) => Promise<void>;
  afterTool?: (call: unknown, observation: unknown) => Promise<void>;
  validate?: (messages: unknown[]) => Promise<void>;
  worker?: RuntimeWorker;
}

/** Trusted server registrations only; requests cannot install or bypass a guard. */
export class RuntimeExtensions {
  private static registered = new Map<string, RuntimeExtension>();
  static register(name: string, extension: RuntimeExtension): void { this.registered.set(name, extension); }
  static resolve(profile: AgentProfile): RuntimeExtension[] {
    const groups = profile.plugins || {};
    for (const [kind, names] of Object.entries(groups)) {
      for (const name of names || []) {
        const extension = this.registered.get(name);
        const valid = extension && (kind === "context_contributors" ? extension.context : kind === "verifiers" ? extension.validate : kind === "worker_plugins" ? extension.worker : false);
        if (!valid) throw Object.assign(new Error(`Required ${kind} extension '${name}' is unavailable`), { code: "PROFILE_NOT_READY" });
      }
    }
    return [...new Set(Object.values(groups).flat())].map(name => this.registered.get(name)!);
  }

  static workers(profile: AgentProfile): RuntimeWorker[] {
    return (profile.plugins?.worker_plugins || []).map(name => this.registered.get(name)!.worker!);
  }
}
