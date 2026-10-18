import logger from "../utils/logger.ts";
import { CapabilityRegistry, type CapabilityDefinition } from "./CapabilityRegistry.ts";
import { ProfileRegistry, type AgentProfile } from "./ProfileRegistry.ts";

export const evalChaosEnabled = (): boolean => process.env.LAS_EVAL_CHAOS === "1";

export const EVAL_CHAOS_IDS = [
  "global.eval_chaos.throw",
  "global.eval_chaos.hang",
  "global.eval_chaos.huge",
  "global.eval_chaos.slow",
] as const;

const CHAOS_PARAMETERS = {
  type: "object",
  properties: {
    note: { type: "string" },
  },
  additionalProperties: false,
} as const;

function chaosDefinition(id: string, description: string): CapabilityDefinition {
  return {
    id,
    name: id,
    owner: "lazy-agent-service",
    version: "1.0.0",
    execution: "shared",
    effect: "read",
    timeout_ms: 30000,
    retryable: false,
    rate_limit_class: "cpu_in_memory",
    supports_evidence: false,
    requires_confirmation: false,
    requires_user_scope: false,
    requires_audit: false,
    description,
    parameters: {
      type: "object",
      properties: {
        note: { type: "string" },
      },
      additionalProperties: false,
    },
  };
}

export function registerEvalChaosCapabilities(): void {
  CapabilityRegistry.registerCapability(
    chaosDefinition("global.eval_chaos.throw", "Eval-only chaos tool: always fails with an error."),
  );
  CapabilityRegistry.registerCapability(
    chaosDefinition("global.eval_chaos.hang", "Eval-only chaos tool: never returns until the run cancels it."),
  );
  CapabilityRegistry.registerCapability(
    chaosDefinition("global.eval_chaos.huge", "Eval-only chaos tool: returns about 2 MB of text."),
  );
  CapabilityRegistry.registerCapability(
    chaosDefinition("global.eval_chaos.slow", "Eval-only chaos tool: returns after 20 seconds."),
  );
}

function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function executeEvalChaos(
  id: string,
  signal?: AbortSignal,
): Promise<{ success: true; result: string }> {
  switch (id) {
    case "global.eval_chaos.throw":
      throw new Error("eval chaos: this tool always fails");
    case "global.eval_chaos.hang":
      await new Promise<never>((_, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return { success: true, result: "" };
    case "global.eval_chaos.huge":
      return { success: true, result: "chaos ".repeat(350_000) };
    case "global.eval_chaos.slow":
      await waitWithAbort(20_000, signal);
      return { success: true, result: "slow chaos tool finished" };
    default:
      throw new Error(`unknown eval chaos tool ${id}`);
  }
}

export async function registerEvalChaosProfile(): Promise<void> {
  const base = await ProfileRegistry.loadProfile("html-notes-canvas-v1");
  if (!base) {
    logger.warn("[EvalChaos] Base profile html-notes-canvas-v1 not found; eval-chaos-v1 profile not registered");
    return;
  }
  const copy = structuredClone(base) as AgentProfile;
  copy.profile_id = "eval-chaos-v1";
  copy.tool_policy.whitelist = [...copy.tool_policy.whitelist, ...EVAL_CHAOS_IDS];
  if (Array.isArray(copy.allowed_global_capabilities)) {
    copy.allowed_global_capabilities = [...copy.allowed_global_capabilities, ...EVAL_CHAOS_IDS];
  } else {
    copy.allowed_global_capabilities = [...EVAL_CHAOS_IDS];
  }
  ProfileRegistry.registerProfile(copy);
  logger.warn("[EvalChaos] Registered eval-chaos-v1 profile derived from html-notes-canvas-v1");
}
