import crypto from "node:crypto";
import { ContextBudget } from "./ContextBudget.ts";
import type { ContextReceipt, LayerBudgetSummary } from "../contracts/manifest.ts";
import type { DurableMemoryRecord } from "../memory/LifecycleMemory.ts";
import { LifecycleMemoryEngine } from "../memory/LifecycleMemory.ts";

export interface AssemblyOptions {
  agentRole: string;
  project: string;
  roleRules: string;
  outputContract: string;
  toolProtocol: string;
  selectedToolSchemas: Array<{ name: string; description?: string; parameters?: unknown }>;
  approvedProcedures?: string[];
  repoMapSummary?: string;
  repoCommitSha?: string;
  verifiedMemories?: DurableMemoryRecord[];
  workflowCheckpoints?: string[];
  artifactExcerpts?: string[];
  userTask: string;
  currentState?: string;
  recentToolOutputs?: string[];
  budgetConfig?: { totalMaxChars?: number };
}

export interface AssembledContextResult {
  fullPrompt: string;
  receipt: ContextReceipt;
  layerTexts: {
    prefix: string;
    projectScope: string;
    retrievedEvidence: string;
    dynamicTail: string;
  };
}

export class ContextAssembly {
  private budget: ContextBudget;

  constructor(budgetConfig: { totalMaxChars?: number } = {}) {
    this.budget = new ContextBudget(budgetConfig);
  }

  private static hash(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
  }

  /**
   * Assembles the 4-layer bounded prompt and generates a cryptographic receipt.
   */
  assemble(options: AssemblyOptions): AssembledContextResult {
    const exclusions: Array<{ id?: string; reason: string; layer: string }> = [];

    // ─────────────────────────────────────────────────────────────
    // Layer 1: Immutable Prefix
    // ─────────────────────────────────────────────────────────────
    // Role rules, stable output contract, stable tool protocol
    const prefixComponents = [
      `# Role & System Rules\n${options.roleRules.trim()}`,
      `# Output Contract\n${options.outputContract.trim()}`,
      `# Tool Protocol\n${options.toolProtocol.trim()}`,
    ];
    const rawPrefix = prefixComponents.join("\n\n");
    const { text: prefixText, summary: prefixSummary } = this.budget.clampLayer(
      rawPrefix,
      this.budget.prefixBudgetChars,
      prefixComponents.length
    );
    const prefixHash = ContextAssembly.hash(prefixText);

    // ─────────────────────────────────────────────────────────────
    // Layer 2: Scoped Project Layer
    // ─────────────────────────────────────────────────────────────
    // Approved procedures, selected tools, repository map
    const sortedTools = [...options.selectedToolSchemas].sort((a, b) => a.name.localeCompare(b.name));
    const toolIds = sortedTools.map((t) => t.name);
    const toolDocLines = sortedTools.map(
      (t) => `- **${t.name}**: ${t.description || "No description"} (schema: ${JSON.stringify(t.parameters || {})})`
    );

    const projectComponents: string[] = [];
    if (options.approvedProcedures && options.approvedProcedures.length > 0) {
      projectComponents.push(`# Approved Procedures\n${options.approvedProcedures.join("\n")}`);
    }
    projectComponents.push(`# Active Tool Schemas (${sortedTools.length})\n${toolDocLines.join("\n")}`);
    if (options.repoMapSummary) {
      projectComponents.push(`# Repository Map (${options.repoCommitSha || "HEAD"})\n${options.repoMapSummary}`);
    }

    const rawProjectScope = projectComponents.join("\n\n");
    const { text: projectScopeText, summary: projectScopeSummary } = this.budget.clampLayer(
      rawProjectScope,
      this.budget.projectScopeBudgetChars,
      projectComponents.length
    );
    const projectScopeHash = ContextAssembly.hash(projectScopeText);

    // ─────────────────────────────────────────────────────────────
    // Layer 3: Retrieved Evidence Layer
    // ─────────────────────────────────────────────────────────────
    // Bounded verified memories (ACTIVE only), workflow checkpoints, artifact excerpts
    const evidenceComponents: string[] = [];
    const memoryIds: string[] = [];
    const artifactRefs = options.artifactExcerpts ? options.artifactExcerpts.map((_, i) => `artifact_${i}`) : [];

    if (options.verifiedMemories && options.verifiedMemories.length > 0) {
      // Filter strictly to ACTIVE memories
      const activeMemories = LifecycleMemoryEngine.filterActiveForPrompt(options.verifiedMemories, {
        domain: "general",
        project: options.project,
        agent: options.agentRole,
      });

      for (const mem of options.verifiedMemories) {
        if (!activeMemories.some((a) => a.id === mem.id)) {
          exclusions.push({
            id: mem.id,
            reason: `Lifecycle state '${mem.lifecycle_state}' not eligible for prompt injection`,
            layer: "retrieved_evidence",
          });
        }
      }

      if (activeMemories.length > 0) {
        // Deterministic sort by content hash
        activeMemories.sort((a, b) => a.content_hash.localeCompare(b.content_hash));
        const memLines = activeMemories.map((m) => {
          memoryIds.push(m.id);
          return `- [${m.type}] ${m.title ? `${m.title}: ` : ""}${m.content}`;
        });
        evidenceComponents.push(`# Verified Memory Context\n${memLines.join("\n")}`);
      }
    }

    if (options.workflowCheckpoints && options.workflowCheckpoints.length > 0) {
      evidenceComponents.push(`# Workflow Checkpoints\n${options.workflowCheckpoints.join("\n")}`);
    }
    if (options.artifactExcerpts && options.artifactExcerpts.length > 0) {
      evidenceComponents.push(`# Artifact Excerpts\n${options.artifactExcerpts.join("\n\n")}`);
    }

    const rawEvidence = evidenceComponents.join("\n\n");
    const { text: evidenceText, summary: evidenceSummary } = this.budget.clampLayer(
      rawEvidence,
      this.budget.evidenceBudgetChars,
      evidenceComponents.length
    );
    const evidenceHash = ContextAssembly.hash(evidenceText);

    // ─────────────────────────────────────────────────────────────
    // Layer 4: Dynamic Tail
    // ─────────────────────────────────────────────────────────────
    // User task, current state, latest tool outputs
    const tailComponents: string[] = [];
    tailComponents.push(`# Task Instruction\n${options.userTask.trim()}`);
    if (options.currentState) {
      tailComponents.push(`# Current Execution State\n${options.currentState.trim()}`);
    }
    if (options.recentToolOutputs && options.recentToolOutputs.length > 0) {
      tailComponents.push(`# Recent Tool Outputs\n${options.recentToolOutputs.join("\n\n")}`);
    }

    const rawTail = tailComponents.join("\n\n");
    const { text: dynamicTailText, summary: dynamicTailSummary } = this.budget.clampLayer(
      rawTail,
      this.budget.dynamicTailBudgetChars,
      tailComponents.length
    );
    const dynamicTailHash = ContextAssembly.hash(dynamicTailText);

    // ─────────────────────────────────────────────────────────────
    // Full Prompt & Receipt Compilation
    // ─────────────────────────────────────────────────────────────
    const fullPrompt = [prefixText, projectScopeText, evidenceText, dynamicTailText]
      .filter((s) => s.length > 0)
      .join("\n\n---\n\n");

    const receiptId = ContextAssembly.hash(
      `${prefixHash}:${projectScopeHash}:${evidenceHash}:${dynamicTailHash}`
    );

    const receipt: ContextReceipt = {
      receipt_id: receiptId,
      agent_role: options.agentRole,
      project: options.project,
      task_delivery: dynamicTailSummary.truncated ? "truncated" : "exact",
      created_at: new Date().toISOString(),
      layers: {
        prefix: { ...prefixSummary, hash: prefixHash },
        project_scope: {
          ...projectScopeSummary,
          hash: projectScopeHash,
          tool_ids: toolIds,
          repo_sha: options.repoCommitSha,
        },
        retrieved_evidence: {
          ...evidenceSummary,
          hash: evidenceHash,
          memory_ids: memoryIds,
          artifact_refs: artifactRefs,
        },
        dynamic_tail: { ...dynamicTailSummary, hash: dynamicTailHash },
      },
      total_chars: fullPrompt.length,
      excluded_items: exclusions,
    };

    return {
      fullPrompt,
      receipt,
      layerTexts: {
        prefix: prefixText,
        projectScope: projectScopeText,
        retrievedEvidence: evidenceText,
        dynamicTail: dynamicTailText,
      },
    };
  }
}
