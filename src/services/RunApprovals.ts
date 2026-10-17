import crypto from "node:crypto";
import { RunStore } from "./RunStore.ts";
import type { RunEvent } from "../types/run.ts";
export interface RunApproval {
  id: string; tool_call_id: string; tool_name: string; arguments_hash: string;
  app_id: string; session_id: string; expires_at: string;
  decision?: "approved" | "denied";
}
export class RunApprovals {
  private static waiters = new Map<string, (approved: boolean) => void>();
  /**
   * Ask a person and wait for the answer. It only reports what the person
   * said (`approved` true/false, null when the approval expired unanswered);
   * the caller turns that answer into the decision via `decideToolCall`.
   * Cancelling the run rejects with the abort reason.
   */
  static async wait(runId: string, call: any, appId: string, sessionId: string, signal: AbortSignal, emit: (event: Omit<RunEvent, "id" | "timestamp">) => void): Promise<{ id: string; approved: boolean | null }> {
    const approval: RunApproval = { id: crypto.randomUUID(), tool_call_id: call.id, tool_name: call.name, arguments_hash: crypto.createHash("sha256").update(JSON.stringify(call.args || {})).digest("hex"), app_id: appId, session_id: sessionId, expires_at: new Date(Date.now() + 180000).toISOString() };
    await RunStore.mutateRun(runId, run => ({ status: "waiting_for_approval", approvals: { ...run.approvals, [approval.id]: approval } }));
    signal.throwIfAborted();
    const approved = await new Promise<boolean | null>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); this.waiters.delete(approval.id); };
      const abort = () => { cleanup(); reject(signal.reason); };
      const timer = setTimeout(() => { cleanup(); resolve(null); }, 180000);
      signal.addEventListener("abort", abort, { once: true });
      this.waiters.set(approval.id, answer => { cleanup(); resolve(answer); });
      try { emit({ run_id: runId, type: "approval.required", data: { ...approval, arguments: call.args || {} } }); } catch (error) { cleanup(); reject(error); }
    });
    return { id: approval.id, approved };
  }
  static async resolve(runId: string, id: string, approved: boolean): Promise<{ duplicate: boolean }> {
    if (typeof approved !== "boolean") throw new Error("Boolean approval decision required");
    const run = await RunStore.getRun(runId), entry = run?.approvals?.[id];
    const decision = approved ? "approved" : "denied";
    if (!entry) throw new Error("Unknown approval");
    if (entry.decision) { if (entry.decision !== decision) throw new Error("Conflicting approval decision"); return { duplicate: true }; }
    if (Date.parse(entry.expires_at) <= Date.now() || !this.waiters.has(id) || !["running", "waiting_for_approval", "waiting_for_tool"].includes(run!.status)) throw new Error("Approval expired or run inactive");
    await RunStore.mutateRun(runId, current => ({ status: "running", approvals: { ...current.approvals, [id]: { ...entry, decision } } }));
    this.waiters.get(id)?.(approved);
    return { duplicate: false };
  }
  static async permits(runId: string, id: string | undefined, call: { id: string; name: string; args: unknown }, appId: string, sessionId: string): Promise<boolean> {
    const entry = id ? (await RunStore.getRun(runId))?.approvals?.[id] : undefined;
    return !!entry && entry.decision === "approved" && entry.tool_call_id === call.id && entry.tool_name === call.name && entry.app_id === appId && entry.session_id === sessionId && Date.parse(entry.expires_at) > Date.now() && entry.arguments_hash === crypto.createHash("sha256").update(JSON.stringify(call.args)).digest("hex");
  }
}
