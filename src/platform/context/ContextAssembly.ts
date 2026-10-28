import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ContextBudget } from "./ContextBudget.ts";
import type { ContextReceipt, ReplayManifest } from "../contracts/manifest.ts";
import type { DurableMemoryRecord } from "../memory/LifecycleMemory.ts";
import { LifecycleMemoryEngine } from "../memory/LifecycleMemory.ts";
import { SkillRegistry } from "../skills/SkillRegistry.ts";

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
  /** Bodies of path-scoped rules matched for the current tool-call paths. */
  pathScopedRules?: string[];
  /** Contents of always-on memory markdown files. Auto-loaded when omitted. */
  alwaysOnMemories?: string[];
  /** Skill name/description pairs for on-demand loading. Auto-discovered when omitted. */
  skills?: Array<{ name: string; description: string }>;
  /** Repository root for auto-loading rules/memory/skills (default: cwd). */
  repoRoot?: string;
  /** Additional roots that @import paths in memory files may resolve into. */
  allowedRoots?: string[];
  /** Callback fired for each @import excluded for escaping the allowed roots. */
  onUnapprovedImport?: (unapproved: { file: string; importPath: string }) => void;
  /** Prior-run tool observations seeded into the evidence layer (DeepSeek pattern). */
  seededToolResults?: Array<{ toolName: string; content: string }>;
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
  /** @import paths excluded from memory files for escaping the allowed roots. */
  unapprovedImports: Array<{ file: string; importPath: string }>;
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
   * Resolve an @import path from a memory file. Absolute paths and any
   * path resolving outside the allowed roots are refused.
   */
  private static resolveApprovedImport(
    importPath: string,
    memoryDir: string,
    allowedRoots: string[],
  ): string | null {
    if (!importPath || path.isAbsolute(importPath)) return null;
    const resolved = path.resolve(memoryDir, importPath);
    const inside = allowedRoots.some(
      (root) => resolved === root || resolved.startsWith(root + path.sep),
    );
    return inside ? resolved : null;
  }

  /**
   * Expand `@path/to/file.md` import lines within a memory file body.
   * Imports resolve relative to the memory file's directory; those
   * outside the allowed roots are excluded and recorded. Nested imports
   * are followed with a visited-set cycle guard.
   */
  private static expandMemoryImports(
    content: string,
    sourceFile: string,
    memoryDir: string,
    allowedRoots: string[],
    unapproved: Array<{ file: string; importPath: string }>,
    visited: Set<string>,
  ): string {
    const lines = content.split("\n");
    const expanded = lines.map((line) => {
      const match = /^[ \t]*@(\S+)[ \t]*$/.exec(line);
      if (!match) return line;
      const importPath = match[1];
      const resolved = ContextAssembly.resolveApprovedImport(
        importPath,
        memoryDir,
        allowedRoots,
      );
      if (resolved === null) {
        unapproved.push({ file: sourceFile, importPath });
        return `[unapproved import excluded: @${importPath}]`;
      }
      if (visited.has(resolved)) {
        return `[circular import skipped: @${importPath}]`;
      }
      visited.add(resolved);
      try {
        const imported = fs.readFileSync(resolved, "utf8");
        return ContextAssembly.expandMemoryImports(
          imported,
          `${sourceFile} -> ${importPath}`,
          path.dirname(resolved),
          allowedRoots,
          unapproved,
          visited,
        ).trimEnd();
      } catch {
        unapproved.push({ file: sourceFile, importPath });
        return `[import unreadable: @${importPath}]`;
      }
    });
    return expanded.join("\n");
  }

  /**
   * Load every markdown file under `<root>/memory/*.md` as always-on
   * context (order: alphabetical by filename for determinism).
   * `@path` import lines are expanded only when the resolved path stays
   * inside the workspace root (plus any configured allowed roots);
   * escaping imports are excluded and reported via `unapprovedImports`.
   */
  private static loadAlwaysOnMemories(
    repoRoot: string,
    allowedRoots: string[],
  ): { contents: string[]; unapprovedImports: Array<{ file: string; importPath: string }> } {
    const memoryDir = path.join(repoRoot, "memory");
    const unapprovedImports: Array<{ file: string; importPath: string }> = [];
    let entries: string[];
    try {
      entries = fs.readdirSync(memoryDir);
    } catch {
      return { contents: [], unapprovedImports };
    }
    const contents = entries
      .filter((entry) => entry.endsWith(".md") && !entry.startsWith("README"))
      .sort()
      .map((entry) => {
        try {
          const raw = fs.readFileSync(path.join(memoryDir, entry), "utf8");
          const expanded = ContextAssembly.expandMemoryImports(
            raw,
            entry,
            memoryDir,
            allowedRoots,
            unapprovedImports,
            new Set([path.join(memoryDir, entry)]),
          );
          const content = expanded.trim();
          return content.length > 0 ? content : null;
        } catch {
          return null;
        }
      })
      .filter((content): content is string => content !== null);
    return { contents, unapprovedImports };
  }

  private resolveAlwaysOnMemoriesForScope(options: AssemblyOptions): {
    memories: string[];
    unapprovedImports: Array<{ file: string; importPath: string }>;
  } {
    const repoRoot = options.repoRoot || process.cwd();
    const allowedRoots = [
      path.resolve(repoRoot),
      ...(options.allowedRoots ?? []).map((r) => path.resolve(r)),
    ];
    if (options.alwaysOnMemories !== undefined) {
      return { memories: options.alwaysOnMemories, unapprovedImports: [] };
    }
    const loaded = ContextAssembly.loadAlwaysOnMemories(repoRoot, allowedRoots);
    for (const unapproved of loaded.unapprovedImports) {
      options.onUnapprovedImport?.(unapproved);
    }
    return {
      memories: loaded.contents,
      unapprovedImports: loaded.unapprovedImports,
    };
  }

  private buildProjectScopeLayer(options: AssemblyOptions) {
    const sortedTools = [...options.selectedToolSchemas].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const toolIds = sortedTools.map((t) => t.name);
    const toolDocLines = sortedTools.map(
      (t) =>
        `- **${t.name}**: ${t.description || "No description"} (schema: ${JSON.stringify(t.parameters || {})})`,
    );

    const projectComponents: string[] = [];
    if (options.approvedProcedures && options.approvedProcedures.length > 0) {
      projectComponents.push(
        `# Approved Procedures\n${options.approvedProcedures.join("\n")}`,
      );
    }

    const { memories, unapprovedImports } =
      this.resolveAlwaysOnMemoriesForScope(options);
    if (memories.length > 0) {
      projectComponents.push(`# Always-On Memory\n${memories.join("\n\n")}`);
    }

    const repoRoot = options.repoRoot || process.cwd();
    const skills =
      options.skills ??
      new SkillRegistry(path.join(repoRoot, "skills")).describeAll();
    if (skills.length > 0) {
      const skillLines = skills.map(
        (s) => `- **${s.name}**: ${s.description} (load with \`skill_read\`)`,
      );
      projectComponents.push(`# Available Skills\n${skillLines.join("\n")}`);
    }

    projectComponents.push(
      `# Active Tool Schemas (${sortedTools.length})\n${toolDocLines.join("\n")}`,
    );
    if (toolIds.some((id) => id.startsWith("global.web."))) {
      projectComponents.push(
        "# Sources\nWhen your answer uses facts from web search or a fetched page, name where each fact came from (site name or URL) in the answer, and end the answer with a line starting `Sources:` that lists the sites or URLs you used.",
      );
    }
    if (options.repoMapSummary) {
      projectComponents.push(
        `# Repository Map (${options.repoCommitSha || "HEAD"})\n${options.repoMapSummary}`,
      );
    }

    const rawProjectScope = projectComponents.join("\n\n");
    const { text: projectScopeText, summary: projectScopeSummary } =
      this.budget.clampLayer(
        rawProjectScope,
        this.budget.projectScopeBudgetChars,
        projectComponents.length,
      );
    const projectScopeHash = ContextAssembly.hash(projectScopeText);
    return {
      projectScopeText,
      projectScopeSummary,
      projectScopeHash,
      toolIds,
      unapprovedImports,
    };
  }

  private buildRetrievedEvidenceLayer(
    options: AssemblyOptions,
    exclusions: Array<{ id?: string; reason: string; layer: string }>,
  ) {
    const evidenceComponents: string[] = [];
    if (options.seededToolResults && options.seededToolResults.length > 0) {
      const seededBlocks = options.seededToolResults.map(
        (seeded) =>
          `<!-- seeded: replayed prior run -->\n[assistant tool_call] ${seeded.toolName}\n[tool result]\n${seeded.content}`,
      );
      evidenceComponents.push(
        `# Seeded Prior-Run Tool History\n${seededBlocks.join("\n\n")}`,
      );
    }

    const memoryIds: string[] = [];
    const artifactRefs = options.artifactExcerpts
      ? options.artifactExcerpts.map((_, i) => `artifact_${i}`)
      : [];

    if (options.verifiedMemories && options.verifiedMemories.length > 0) {
      const activeMemories = LifecycleMemoryEngine.filterActiveForPrompt(
        options.verifiedMemories,
        {
          domain: "general",
          project: options.project,
          agent: options.agentRole,
        },
      );

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
        activeMemories.sort((a, b) =>
          a.content_hash.localeCompare(b.content_hash),
        );
        const memLines = activeMemories.map((m) => {
          memoryIds.push(m.id);
          return `- [${m.type}] ${m.title ? `${m.title}: ` : ""}${m.content}`;
        });
        evidenceComponents.push(
          `# Verified Memory Context\n${memLines.join("\n")}`,
        );
      }
    }

    if (options.workflowCheckpoints && options.workflowCheckpoints.length > 0) {
      evidenceComponents.push(
        `# Workflow Checkpoints\n${options.workflowCheckpoints.join("\n")}`,
      );
    }
    if (options.artifactExcerpts && options.artifactExcerpts.length > 0) {
      evidenceComponents.push(
        `# Artifact Excerpts\n${options.artifactExcerpts.join("\n\n")}`,
      );
    }

    const rawEvidence = evidenceComponents.join("\n\n");
    const { text: evidenceText, summary: evidenceSummary } =
      this.budget.clampLayer(
        rawEvidence,
        this.budget.evidenceBudgetChars,
        evidenceComponents.length,
      );
    const evidenceHash = ContextAssembly.hash(evidenceText);
    return {
      evidenceText,
      evidenceSummary,
      evidenceHash,
      memoryIds,
      artifactRefs,
    };
  }

  private buildDynamicTailLayer(options: AssemblyOptions) {
    const tailComponents: string[] = [];
    tailComponents.push(`# Task Instruction\n${options.userTask.trim()}`);
    if (options.currentState) {
      tailComponents.push(
        `# Current Execution State\n${options.currentState.trim()}`,
      );
    }
    if (options.pathScopedRules && options.pathScopedRules.length > 0) {
      tailComponents.push(
        `# Path-Scoped Rules (apply to the files you are touching)\n${options.pathScopedRules.join("\n\n")}`,
      );
    }
    if (options.recentToolOutputs && options.recentToolOutputs.length > 0) {
      tailComponents.push(
        `# Recent Tool Outputs\n${options.recentToolOutputs.join("\n\n")}`,
      );
    }

    const rawTail = tailComponents.join("\n\n");
    const { text: dynamicTailText, summary: dynamicTailSummary } =
      this.budget.clampLayer(
        rawTail,
        this.budget.dynamicTailBudgetChars,
        tailComponents.length,
      );
    const dynamicTailHash = ContextAssembly.hash(dynamicTailText);
    return { dynamicTailText, dynamicTailSummary, dynamicTailHash };
  }

  /**
   * Assembles the 4-layer bounded prompt and generates a cryptographic receipt.
   */
  assemble(options: AssemblyOptions): AssembledContextResult {
    const exclusions: Array<{ id?: string; reason: string; layer: string }> = [];

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

    const {
      projectScopeText,
      projectScopeSummary,
      projectScopeHash,
      toolIds,
      unapprovedImports,
    } = this.buildProjectScopeLayer(options);

    const {
      evidenceText,
      evidenceSummary,
      evidenceHash,
      memoryIds,
      artifactRefs,
    } = this.buildRetrievedEvidenceLayer(options, exclusions);

    const { dynamicTailText, dynamicTailSummary, dynamicTailHash } =
      this.buildDynamicTailLayer(options);

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
      unapprovedImports,
      layerTexts: {
        prefix: prefixText,
        projectScope: projectScopeText,
        retrievedEvidence: evidenceText,
        dynamicTail: dynamicTailText,
      },
    };
  }
}

/**
 * Convert a ReplayManifest's ordered_tool_events into the
 * `seededToolResults` shape consumed by ContextAssembly. Payloads come
 * from cached_tool_results matched by result_hash; events without a
 * cached payload keep provenance via their result_hash. Ordered by turn.
 */
export function seedFromReplayManifest(
  manifest: ReplayManifest,
): Array<{ toolName: string; content: string }> {
  const payloadByResultHash = new Map(
    (manifest.cached_tool_results ?? []).map((cached) => [cached.result_hash, cached] as const),
  );

  return [...(manifest.ordered_tool_events ?? [])]
    .sort((a, b) => a.turn - b.turn)
    .map((event) => {
      const cached = payloadByResultHash.get(event.result_hash);
      if (!cached) {
        const prefix = event.status === "error" ? "[error] " : "";
        return {
          toolName: event.tool_name,
          content: `${prefix}[no cached payload; status=${event.status}; result_hash=${event.result_hash}]`,
        };
      }
      const payload = cached.result_payload;
      const rendered = typeof payload === "string" ? payload : JSON.stringify(payload) ?? "";
      const content = event.status === "error" || cached.is_error
        ? `[error] ${rendered}`
        : rendered;
      return { toolName: event.tool_name, content };
    });
}
