/** Deliberate faults for trading-service's boundary contract probe — and for nothing else.
 *
 * The probe (trading-service app/audit/boundary_probe.py) checks, daily and after
 * every prism or lazy-agent-service redeploy, that the contracts the desk depends on
 * still hold. Two of them only show when something breaks: how prism reports a model
 * stream that ends without a finish_reason, and whether trading's stream watchdog
 * ends a tool call that hangs. On 2026-09-28 the first became fatal and the second
 * (a call parked on an approval) cost 30 minutes per desk, and neither could be seen
 * until production failed. These faults make them happen on demand.
 *
 * A fault fires only when the SIGNED tool context (minted by our prism proxy from the
 * task's "## Cycle:" line, verified by HMAC) names a cycle `probe-boundary-<epoch>-fault-<kind>`.
 * Tool results and web content cannot set that value, production cycles never carry
 * it, and PROBE_FAULTS_ENABLED=0 turns the whole thing off.
 */
export type ProbeFault = "cut" | "toolstall";

const FAULT_CYCLE = /^probe-boundary-\d+-fault-(cut|toolstall)$/;

export function probeFault(cycleId: unknown): ProbeFault | null {
  if (process.env.PROBE_FAULTS_ENABLED === "0") return null;
  if (typeof cycleId !== "string") return null;
  const m = FAULT_CYCLE.exec(cycleId);
  return m ? (m[1] as ProbeFault) : null;
}

/** How long a probed tool call hangs. Longer than trading's tool-phase window in the probe (45 s). */
export function probeToolStallMs(): number {
  const raw = Number(process.env.PROBE_TOOL_STALL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 240_000;
}

/** A streamed completion that stops after one delta: no finish_reason, no [DONE]. */
export function cutStreamBody(model: unknown): string {
  const chunk = {
    id: "probe-cut", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta: { role: "assistant", content: "probe" }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}
