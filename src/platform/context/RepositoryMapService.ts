import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface RepoMapEntry {
  repoName: string;
  commitSha: string;
  generatedAt: string;
  treeSummary: string;
  shaHash: string;
}

/**
 * RepositoryMapService — Caches deterministic repository structure keyed by repository and commit SHA.
 */
export class RepositoryMapService {
  private static cache = new Map<string, RepoMapEntry>();

  static getCacheKey(repoName: string, commitSha: string): string {
    return `${repoName}@${commitSha}`;
  }

  /**
   * Retrieves or builds a cached repository map.
   */
  static getOrBuildMap(repoRoot: string, repoName: string, commitSha: string): RepoMapEntry {
    const key = this.getCacheKey(repoName, commitSha);
    const existing = this.cache.get(key);
    if (existing) {
      return existing;
    }

    const treeSummary = this.scanDirectoryStructure(repoRoot);
    const shaHash = crypto.createHash("sha256").update(treeSummary).digest("hex");

    const entry: RepoMapEntry = {
      repoName,
      commitSha,
      generatedAt: new Date().toISOString(),
      treeSummary,
      shaHash,
    };

    this.cache.set(key, entry);
    return entry;
  }

  /**
   * Scans shallow directory structure avoiding node_modules, .git, etc.
   */
  private static scanDirectoryStructure(dir: string, depth: number = 2): string {
    if (!fs.existsSync(dir) || depth < 0) return "";
    const lines: string[] = [];

    const walk = (current: string, currentDepth: number, prefix: string = "") => {
      if (currentDepth > depth) return;
      try {
        const entries = fs.readdirSync(current, { withFileTypes: true });
        // Deterministic alphabetical sort
        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
          if (
            entry.name.startsWith(".") ||
            entry.name === "node_modules" ||
            entry.name === "dist" ||
            entry.name === "__pycache__"
          ) {
            continue;
          }

          if (entry.isDirectory()) {
            lines.push(`${prefix}📁 ${entry.name}/`);
            walk(path.join(current, entry.name), currentDepth + 1, `${prefix}  `);
          } else {
            lines.push(`${prefix}📄 ${entry.name}`);
          }
        }
      } catch {
        // Safe fallback for unreadable paths
      }
    };

    walk(dir, 0);
    return lines.join("\n");
  }

  static clearCache(): void {
    this.cache.clear();
  }
}
