import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
/**
 * RepositoryMapService — Caches deterministic repository structure keyed by repository and commit SHA.
 */
export class RepositoryMapService {
    static cache = new Map();
    static getCacheKey(repoName, commitSha) {
        return `${repoName}@${commitSha}`;
    }
    /**
     * Retrieves or builds a cached repository map.
     */
    static getOrBuildMap(repoRoot, repoName, commitSha) {
        const key = this.getCacheKey(repoName, commitSha);
        const existing = this.cache.get(key);
        if (existing) {
            return existing;
        }
        const treeSummary = this.scanDirectoryStructure(repoRoot);
        const shaHash = crypto.createHash("sha256").update(treeSummary).digest("hex");
        const entry = {
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
    static scanDirectoryStructure(dir, depth = 2) {
        if (!fs.existsSync(dir) || depth < 0)
            return "";
        const lines = [];
        const walk = (current, currentDepth, prefix = "") => {
            if (currentDepth > depth)
                return;
            try {
                const entries = fs.readdirSync(current, { withFileTypes: true });
                // Deterministic alphabetical sort
                entries.sort((a, b) => a.name.localeCompare(b.name));
                for (const entry of entries) {
                    if (entry.name.startsWith(".") ||
                        entry.name === "node_modules" ||
                        entry.name === "dist" ||
                        entry.name === "__pycache__") {
                        continue;
                    }
                    if (entry.isDirectory()) {
                        lines.push(`${prefix}📁 ${entry.name}/`);
                        walk(path.join(current, entry.name), currentDepth + 1, `${prefix}  `);
                    }
                    else {
                        lines.push(`${prefix}📄 ${entry.name}`);
                    }
                }
            }
            catch {
                // Safe fallback for unreadable paths
            }
        };
        walk(dir, 0);
        return lines.join("\n");
    }
    static clearCache() {
        this.cache.clear();
    }
}
//# sourceMappingURL=RepositoryMapService.js.map