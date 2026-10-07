const FAULT_CYCLE = /^probe-boundary-\d+-fault-(cut|toolstall)$/;
export function probeFault(cycleId) {
    if (process.env.PROBE_FAULTS_ENABLED === "0")
        return null;
    if (typeof cycleId !== "string")
        return null;
    const m = FAULT_CYCLE.exec(cycleId);
    return m ? m[1] : null;
}
/** How long a probed tool call hangs. Longer than trading's tool-phase window in the probe (45 s). */
export function probeToolStallMs() {
    const raw = Number(process.env.PROBE_TOOL_STALL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 240_000;
}
/** A streamed completion that stops after one delta: no finish_reason, no [DONE]. */
export function cutStreamBody(model) {
    const chunk = {
        id: "probe-cut", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta: { role: "assistant", content: "probe" }, finish_reason: null }],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
}
//# sourceMappingURL=ProbeFault.js.map