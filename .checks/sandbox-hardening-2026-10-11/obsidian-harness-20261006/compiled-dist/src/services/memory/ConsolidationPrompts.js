// ─── Memory Consolidation Prompts ────────────────────────────
// LLM system prompts and memory formatters for the consolidation pipeline.
// Extracted from MemoryConsolidationService.ts
import { daysSinceIso } from "@rodrigo-barraza/utilities-library";
import PromptLocaleService from "../PromptLocaleService.js";
function daysSince(isoDate) {
    return daysSinceIso(isoDate);
}
// ─── System Prompts ─────────────────────────────────────────
export const CONSOLIDATION_PROMPT = PromptLocaleService.get("en", "memory.consolidationPrompt");
export const CONVERSATIONAL_CONSOLIDATION_PROMPT = PromptLocaleService.get("en", "memory.conversationalConsolidationPrompt");
// ─── Memory Formatters ──────────────────────────────────────
export function formatMemoryEntry(memory) {
    const age = daysSince(memory.createdAt);
    return PromptLocaleService.get("en", "memory.formatting.memoryEntry", {
        id: memory.id,
        type: memory.type,
        title: memory.title || (memory.content ? memory.content.substring(0, 60) : "untitled"),
        content: memory.content,
        age: String(age),
    });
}
export function formatConversationalMemoryEntry(memory) {
    const age = daysSince(memory.createdAt);
    return PromptLocaleService.get("en", "memory.formatting.conversationalMemoryEntry", {
        id: memory.id,
        category: memory.type,
        aboutUsername: memory.aboutUsername || "any",
        aboutUserId: memory.aboutUserId || "?",
        sourceUsername: memory.sourceUsername || "any",
        sourceUserId: memory.sourceUserId || "?",
        content: memory.content,
        age: String(age),
    });
}
// ─── Batch Input Builders ───────────────────────────────────
export function buildConversationalBatchInput(clusterBatch, staleBatch, partitionMeta) {
    const sections = [];
    if (partitionMeta) {
        sections.push(PromptLocaleService.get("en", "memory.formatting.attributionContextHeader"));
        sections.push(PromptLocaleService.get("en", "memory.formatting.aboutUserLine", {
            aboutUsername: partitionMeta.aboutUsername,
            aboutUserId: partitionMeta.aboutUserId,
        }));
        sections.push(PromptLocaleService.get("en", "memory.formatting.observedByLine", {
            sourceUsername: partitionMeta.sourceUsername,
            sourceUserId: partitionMeta.sourceUserId,
        }));
        sections.push("");
    }
    if (clusterBatch.length > 0) {
        sections.push(`${PromptLocaleService.get("en", "memory.formatting.clustersOfSimilarFacts")}\n`);
        clusterBatch.forEach((cluster, clusterIndex) => {
            sections.push(PromptLocaleService.get("en", "memory.formatting.clusterFactHeader", {
                index: String(clusterIndex + 1),
                count: String(cluster.length),
            }));
            cluster.forEach((memory) => {
                sections.push(formatConversationalMemoryEntry(memory));
            });
            sections.push("");
        });
    }
    if (staleBatch.length > 0) {
        sections.push(`${PromptLocaleService.get("en", "memory.formatting.potentiallyStaleFacts")}\n`);
        staleBatch.forEach((memory) => {
            sections.push(formatConversationalMemoryEntry(memory));
        });
    }
    if (sections.length === 0) {
        return null;
    }
    return sections.join("\n");
}
/**
 * Build the LLM input for a single batch of clusters and stale memories.
 * Returns null if both arrays are empty.
 */
export function buildBatchInput(clusterBatch, staleBatch) {
    const sections = [];
    if (clusterBatch.length > 0) {
        sections.push(`${PromptLocaleService.get("en", "memory.formatting.clustersOfSimilarMemories")}\n`);
        clusterBatch.forEach((cluster, clusterIndex) => {
            sections.push(PromptLocaleService.get("en", "memory.formatting.clusterMemoryHeader", {
                index: String(clusterIndex + 1),
                count: String(cluster.length),
            }));
            cluster.forEach((memory) => {
                sections.push(formatMemoryEntry(memory));
            });
            sections.push("");
        });
    }
    if (staleBatch.length > 0) {
        sections.push(`${PromptLocaleService.get("en", "memory.formatting.potentiallyStaleMemories")}\n`);
        staleBatch.forEach((memory) => {
            sections.push(formatMemoryEntry(memory));
        });
    }
    if (sections.length === 0) {
        return null;
    }
    return sections.join("\n");
}
//# sourceMappingURL=ConsolidationPrompts.js.map