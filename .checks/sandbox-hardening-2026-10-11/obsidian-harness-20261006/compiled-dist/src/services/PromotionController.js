/**
 * PromotionController — P1 phase 3: channel state machine + gated
 * transitions for profile versions.
 *
 * Channels: offline_candidate → shadow → canary_5 → canary_25 → active,
 * plus revalidate (back one step), superseded, retired, and rollback
 * (atomic swap back to previous_active).
 *
 * Design notes:
 *  - State is persisted per profile_id+version so a restart doesn't forget.
 *  - Transitions are compare-and-swap: they only apply from the exact
 *    expected state, so two concurrent promotions can't both win.
 *  - Hard gates (safety) are evaluated separately from quality/operations
 *    gates; a hard-gate failure is never overridable by quality.
 *  - Rollback swaps active back to previous_active atomically.
 */
import fs from "node:fs";
import path from "node:path";
export const CHANNEL_ORDER = [
    "offline_candidate", "shadow", "canary_5", "canary_25", "active",
];
const TRANSITIONS = {
    offline_candidate: ["shadow"],
    shadow: ["canary_5", "revalidate", "superseded"],
    canary_5: ["canary_25", "revalidate", "superseded"],
    canary_25: ["active", "revalidate", "superseded"],
    active: ["revalidate", "superseded", "retired"],
    revalidate: ["shadow", "superseded"],
    superseded: ["retired"],
    retired: [],
};
export class PromotionController {
    static storePath = process.env.PROMOTION_STORE_PATH || path.resolve(process.cwd(), "runtime-data", "promotion_state.json");
    static state = new Map();
    static initialized = false;
    static init() {
        if (this.initialized)
            return;
        try {
            if (fs.existsSync(this.storePath)) {
                const raw = JSON.parse(fs.readFileSync(this.storePath, "utf-8"));
                for (const [key, rec] of Object.entries(raw)) {
                    this.state.set(key, rec);
                }
            }
        }
        catch { /* fresh start */ }
        this.initialized = true;
    }
    static flush() {
        const dir = path.dirname(this.storePath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.storePath, JSON.stringify(Object.fromEntries(this.state), null, 1));
    }
    static key(profileId, version) {
        return `${profileId}@${version}`;
    }
    static get(profileId, version) {
        this.init();
        return this.state.get(this.key(profileId, version));
    }
    static listByProfile(profileId) {
        this.init();
        return [...this.state.values()].filter((r) => r.profileId === profileId);
    }
    static getActive(profileId) {
        this.init();
        return this.listByProfile(profileId).find((r) => r.channel === "active");
    }
    static register(profileId, version, channel = "offline_candidate") {
        this.init();
        const key = this.key(profileId, version);
        const existing = this.state.get(key);
        if (existing)
            return existing;
        const rec = {
            profileId, version, channel,
            updatedAt: new Date().toISOString(),
            history: [{ from: "offline_candidate", to: channel, at: new Date().toISOString(), reason: "registered" }],
        };
        this.state.set(key, rec);
        this.flush();
        return rec;
    }
    /**
     * Evaluate whether a transition is allowed. Hard gates (any failure)
     * block unconditionally; the experiment outcome gates forward promotion.
     */
    static evaluate(req) {
        const blockers = [];
        const allowedTargets = TRANSITIONS[req.from] || [];
        if (!allowedTargets.includes(req.to)) {
            blockers.push(`illegal transition: ${req.from} → ${req.to} (allowed: ${allowedTargets.join(", ")})`);
        }
        for (const gate of req.hardGates || []) {
            if (!gate.passed)
                blockers.push(`hard gate failed: ${gate.gate} — ${gate.detail}`);
        }
        const isForward = CHANNEL_ORDER.indexOf(req.to) > CHANNEL_ORDER.indexOf(req.from) && req.to !== "superseded" && req.to !== "retired";
        if (isForward && req.experiment) {
            if (req.experiment.outcome === "regressed")
                blockers.push("experiment regressed");
            if (req.experiment.outcome === "inconclusive")
                blockers.push("experiment inconclusive — cannot promote without a verdict");
            // improved/neutral are allowed to proceed (neutral = no harm proven).
        }
        else if (isForward && !req.experiment && (req.to === "canary_25" || req.to === "active")) {
            blockers.push("forward promotion to canary_25/active requires an experiment verdict");
        }
        return { allowed: blockers.length === 0, blockers };
    }
    /**
     * Compare-and-swap transition. Only applies if the record's current
     * channel matches `from` exactly. On promotion to active, the current
     * active version (if any) is moved to superseded and remembered as
     * previous_active for atomic rollback.
     */
    static transition(req) {
        this.init();
        const { allowed, blockers } = this.evaluate(req);
        if (!allowed)
            return { ok: false, blockers };
        const key = this.key(req.profileId, req.version);
        const rec = this.state.get(key);
        if (!rec || rec.channel !== req.from) {
            return { ok: false, blockers: [`CAS failure: expected ${req.from}, actual ${rec?.channel ?? "unregistered"}`] };
        }
        // Promotion to active: demote the incumbent, remember it.
        let previousActive;
        if (req.to === "active") {
            const incumbent = this.getActive(req.profileId);
            if (incumbent && incumbent.version !== req.version) {
                incumbent.channel = "superseded";
                incumbent.history.push({ from: "active", to: "superseded", at: new Date().toISOString(), reason: `demoted by ${req.version} promotion` });
                incumbent.updatedAt = new Date().toISOString();
                previousActive = incumbent.version;
            }
        }
        rec.channel = req.to;
        rec.previousActive = previousActive ?? rec.previousActive;
        rec.updatedAt = new Date().toISOString();
        rec.history.push({ from: req.from, to: req.to, at: rec.updatedAt, reason: req.reason });
        this.flush();
        return { ok: true, record: rec };
    }
    /** Atomic rollback to previous_active. */
    static rollback(profileId, currentVersion, reason) {
        this.init();
        const current = this.get(profileId, currentVersion);
        if (!current)
            return { ok: false, blockers: [`unknown current version ${currentVersion}`] };
        if (!current.previousActive)
            return { ok: false, blockers: ["no previous_active recorded for this version"] };
        const previous = this.get(profileId, current.previousActive);
        if (!previous)
            return { ok: false, blockers: [`previous_active ${current.previousActive} not found`] };
        // Demote the current version (CAS from its actual channel).
        const demote = this.transition({
            profileId, version: currentVersion,
            from: current.channel, to: "superseded",
            reason: `rollback: ${reason}`,
        });
        if (!demote.ok)
            return demote;
        // Promote the previous version back to active. Direct state write, not
        // transition(): the recorded channel may be superseded (illegal CAS
        // source), and this is the one operation that must always succeed.
        previous.channel = "active";
        previous.updatedAt = new Date().toISOString();
        previous.history.push({ from: "superseded", to: "active", at: previous.updatedAt, reason: `restored by rollback of ${currentVersion}` });
        this.flush();
        return { ok: true, record: current };
    }
}
//# sourceMappingURL=PromotionController.js.map