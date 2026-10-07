import crypto from "node:crypto";
/**
 * LifecycleMemoryEngine — Enforces strict state progression, ownership boundaries,
 * provenance requirements, and freshness validation for durable agent memories.
 */
export class LifecycleMemoryEngine {
    /**
     * Generates a deterministic SHA-256 hash of the memory content.
     */
    static hashContent(content) {
        return crypto.createHash("sha256").update(content.trim()).digest("hex");
    }
    /**
     * Replaces "save when uncertain" with "create a trace-backed candidate observation".
     * Memory starts in 'CANDIDATE' (or 'OBSERVED') state and CANNOT become 'ACTIVE' without explicit verification.
     */
    static createCandidateObservation(input) {
        // 1. Boundary enforcement: quarantine trading-specific memories from general agent memory
        if (input.scope.ticker || input.scope.domain === "trading") {
            throw new Error("Domain Boundary Violation: Ticker and trading outcome memories belong strictly to trading-service, not general agent memory.");
        }
        if (!input.scope.agent && !input.scope.project) {
            throw new Error("Memory scope error: durable memories must have a defined agent or project scope.");
        }
        if (!input.provenance.trace_id || !input.provenance.source_ref) {
            throw new Error("Memory provenance error: candidate observations require valid trace_id and source_ref.");
        }
        const now = new Date();
        const nowIso = now.toISOString();
        const contentHash = this.hashContent(input.content);
        const memoryId = `mem_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
        let expiresAt = null;
        if (input.ttlSeconds && input.ttlSeconds > 0) {
            expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000).toISOString();
        }
        return {
            id: memoryId,
            lifecycle_state: "CANDIDATE",
            scope: {
                domain: input.scope.domain || "general",
                project: input.scope.project || null,
                agent: input.scope.agent || null,
                username: input.scope.username || null,
                task_id: input.scope.task_id || null,
            },
            provenance: {
                trace_id: input.provenance.trace_id,
                span_id: input.provenance.span_id,
                source_ref: input.provenance.source_ref,
                observed_at: input.provenance.observed_at || nowIso,
                verified_at: null,
                verified_by: null,
            },
            freshness: {
                created_at: nowIso,
                expires_at: expiresAt,
                revalidate_after: null,
                access_count: 0,
                last_accessed_at: null,
            },
            type: input.type,
            title: input.title || null,
            content: input.content,
            content_hash: contentHash,
            metadata: input.metadata || {},
        };
    }
    /**
     * Promotes a CANDIDATE memory to ACTIVE after verification evidence is verified.
     */
    static promoteToActive(memory, verification) {
        if (memory.lifecycle_state !== "CANDIDATE" && memory.lifecycle_state !== "VERIFIED") {
            throw new Error(`Cannot promote memory in state '${memory.lifecycle_state}' to ACTIVE.`);
        }
        if (!verification.verified_by || !verification.verification_evidence_ref) {
            throw new Error("Promotion error: promotion to ACTIVE requires verified_by and verification_evidence_ref.");
        }
        const nowIso = new Date().toISOString();
        return {
            ...memory,
            lifecycle_state: "ACTIVE",
            provenance: {
                ...memory.provenance,
                verified_at: nowIso,
                verified_by: verification.verified_by,
                source_ref: `${memory.provenance.source_ref} | verified_by:${verification.verification_evidence_ref}`,
            },
        };
    }
    /**
     * Evaluates memory freshness and checks if it should be marked for REVALIDATE, SUPERSEDED, or RETIRED.
     */
    static evaluateFreshness(memory, now = new Date()) {
        if (memory.lifecycle_state !== "ACTIVE") {
            return memory;
        }
        if (memory.freshness.expires_at) {
            const expDate = new Date(memory.freshness.expires_at);
            if (now >= expDate) {
                return {
                    ...memory,
                    lifecycle_state: "RETIRED",
                };
            }
        }
        if (memory.freshness.revalidate_after) {
            const revDate = new Date(memory.freshness.revalidate_after);
            if (now >= revDate) {
                return {
                    ...memory,
                    lifecycle_state: "REVALIDATE",
                };
            }
        }
        return memory;
    }
    /**
     * Filter memories eligible for prompt injection: only 'ACTIVE' memories matching scope are allowed.
     */
    static filterActiveForPrompt(memories, targetScope) {
        const now = new Date();
        return memories.filter((mem) => {
            const evaluated = this.evaluateFreshness(mem, now);
            if (evaluated.lifecycle_state !== "ACTIVE") {
                return false;
            }
            // Project scope check
            if (targetScope.project && evaluated.scope.project && evaluated.scope.project !== targetScope.project) {
                return false;
            }
            // Agent scope check
            if (targetScope.agent && evaluated.scope.agent && evaluated.scope.agent !== targetScope.agent) {
                return false;
            }
            return true;
        });
    }
}
//# sourceMappingURL=LifecycleMemory.js.map