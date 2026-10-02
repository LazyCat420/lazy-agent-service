import { describe, it, expect, beforeEach } from "vitest";
import { PromotionController } from "../../src/services/PromotionController.ts";

describe("PromotionController", () => {
	beforeEach(() => {
		// Fresh in-memory state per test, isolated store file.
		(PromotionController as unknown as { state: Map<string, unknown> }).state = new Map();
		(PromotionController as unknown as { initialized: boolean }).initialized = false;
		(PromotionController as unknown as { storePath: string }).storePath = `/tmp/promo-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
	});

	it("registers new versions as offline_candidate", () => {
		const rec = PromotionController.register("my-profile", "1.0.0");
		expect(rec.channel).toBe("offline_candidate");
		const again = PromotionController.register("my-profile", "1.0.0");
		expect(again).toBe(rec); // idempotent
	});

	it("enforces legal transitions and rejects illegal ones", () => {
		PromotionController.register("p", "1.0.0");
		const bad = PromotionController.transition({ profileId: "p", version: "1.0.0", from: "offline_candidate", to: "active", reason: "skip" });
		expect(bad.ok).toBe(false);
		expect(bad.blockers?.[0]).toContain("illegal transition");
		const good = PromotionController.transition({ profileId: "p", version: "1.0.0", from: "offline_candidate", to: "shadow", reason: "start" });
		expect(good.ok).toBe(true);
		expect(good.record?.channel).toBe("shadow");
	});

	it("blocks forward promotion to active without an experiment verdict", () => {
		PromotionController.register("p", "1.0.0");
		PromotionController.transition({ profileId: "p", version: "1.0.0", from: "offline_candidate", to: "shadow", reason: "start" });
		PromotionController.transition({ profileId: "p", version: "1.0.0", from: "shadow", to: "canary_5", reason: "c5" });
		PromotionController.transition({ profileId: "p", version: "1.0.0", from: "canary_5", to: "canary_25", reason: "c25" });
		const res = PromotionController.transition({ profileId: "p", version: "1.0.0", from: "canary_25", to: "active", reason: "no verdict" });
		expect(res.ok).toBe(false);
		expect(res.blockers?.[0]).toContain("requires an experiment verdict");
	});

	it("blocks promotion when the experiment regressed or is inconclusive", () => {
		PromotionController.register("p", "1.0.0");
		PromotionController.transition({ profileId: "p", version: "1.0.0", from: "offline_candidate", to: "shadow", reason: "s" });
		const res = PromotionController.transition({
			profileId: "p", version: "1.0.0", from: "shadow", to: "canary_5", reason: "x",
			experiment: { outcome: "regressed", delta: -0.2, ciLower: -0.3, ciUpper: -0.1 },
		});
		expect(res.ok).toBe(false);
		expect(res.blockers?.[0]).toContain("regressed");

		const res2 = PromotionController.transition({
			profileId: "p", version: "1.0.0", from: "shadow", to: "canary_5", reason: "x",
			experiment: { outcome: "inconclusive", delta: 0, ciLower: -0.01, ciUpper: 0.01 },
		});
		expect(res2.ok).toBe(false);
	});

	it("allows promotion on improved/neutral verdicts", () => {
		PromotionController.register("p", "1.0.0");
		PromotionController.transition({ profileId: "p", version: "1.0.0", from: "offline_candidate", to: "shadow", reason: "s" });
		const res = PromotionController.transition({
			profileId: "p", version: "1.0.0", from: "shadow", to: "canary_5", reason: "x",
			experiment: { outcome: "improved", delta: 0.15, ciLower: 0.05, ciUpper: 0.25 },
		});
		expect(res.ok).toBe(true);
	});

	it("hard gate failure blocks unconditionally", () => {
		PromotionController.register("p", "1.0.0");
		const res = PromotionController.transition({
			profileId: "p", version: "1.0.0", from: "offline_candidate", to: "shadow", reason: "x",
			hardGates: [{ gate: "no_unauthorized_mutation", passed: false, detail: "1 unauthorized write observed" }],
			experiment: { outcome: "improved", delta: 0.3, ciLower: 0.1, ciUpper: 0.5 },
		});
		expect(res.ok).toBe(false);
		expect(res.blockers?.[0]).toContain("hard gate failed");
	});

	it("demotes the incumbent on active promotion and remembers previous_active", () => {
		PromotionController.register("p", "1.0.0");
		PromotionController.register("p", "2.0.0");
		// Promote 1.0.0 all the way to active with verdicts.
		const verdict = { outcome: "improved" as const, delta: 0.1, ciLower: 0.02, ciUpper: 0.2 };
		PromotionController.transition({ profileId: "p", version: "1.0.0", from: "offline_candidate", to: "shadow", reason: "s", experiment: verdict });
		PromotionController.transition({ profileId: "p", version: "1.0.0", from: "shadow", to: "canary_5", reason: "c5", experiment: verdict });
		PromotionController.transition({ profileId: "p", version: "1.0.0", from: "canary_5", to: "canary_25", reason: "c25", experiment: verdict });
		PromotionController.transition({ profileId: "p", version: "1.0.0", from: "canary_25", to: "active", reason: "go", experiment: verdict });
		expect(PromotionController.getActive("p")?.version).toBe("1.0.0");

		// Now promote 2.0.0.
		PromotionController.transition({ profileId: "p", version: "2.0.0", from: "offline_candidate", to: "shadow", reason: "s", experiment: verdict });
		PromotionController.transition({ profileId: "p", version: "2.0.0", from: "shadow", to: "canary_5", reason: "c5", experiment: verdict });
		PromotionController.transition({ profileId: "p", version: "2.0.0", from: "canary_5", to: "canary_25", reason: "c25", experiment: verdict });
		PromotionController.transition({ profileId: "p", version: "2.0.0", from: "canary_25", to: "active", reason: "go", experiment: verdict });

		expect(PromotionController.getActive("p")?.version).toBe("2.0.0");
		expect(PromotionController.get("p", "1.0.0")?.channel).toBe("superseded");
		expect(PromotionController.get("p", "2.0.0")?.previousActive).toBe("1.0.0");
	});

	it("rolls back atomically to previous_active", () => {
		PromotionController.register("p", "1.0.0");
		PromotionController.register("p", "2.0.0");
		const verdict = { outcome: "improved" as const, delta: 0.1, ciLower: 0.02, ciUpper: 0.2 };
		for (const [v, path] of [["1.0.0", ["offline_candidate","shadow","canary_5","canary_25"]], ["2.0.0", ["offline_candidate","shadow","canary_5","canary_25"]]] as const) {
			let from: string = path[0];
			PromotionController.transition({ profileId: "p", version: v, from: from as never, to: "shadow", reason: "s", experiment: verdict });
			for (const to of path.slice(1)) {
				PromotionController.transition({ profileId: "p", version: v, from: from as never, to: to as never, reason: to, experiment: verdict });
				from = to;
			}
			PromotionController.transition({ profileId: "p", version: v, from: from as never, to: "active", reason: "go", experiment: verdict });
		}
		// 2.0.0 is active, 1.0.0 superseded, 2.0.0.previousActive = 1.0.0.
		const rb = PromotionController.rollback("p", "2.0.0", "canary regression detected");
		expect(rb.ok).toBe(true);
		expect(PromotionController.get("p", "2.0.0")?.channel).toBe("superseded");
	});

	it("CAS: concurrent transitions from a stale state lose", () => {
		PromotionController.register("p", "1.0.0");
		const a = PromotionController.transition({ profileId: "p", version: "1.0.0", from: "offline_candidate", to: "shadow", reason: "a" });
		expect(a.ok).toBe(true);
		// Same from-state again: CAS fails.
		const b = PromotionController.transition({ profileId: "p", version: "1.0.0", from: "offline_candidate", to: "shadow", reason: "b" });
		expect(b.ok).toBe(false);
		expect(b.blockers?.[0]).toContain("CAS failure");
	});
});
