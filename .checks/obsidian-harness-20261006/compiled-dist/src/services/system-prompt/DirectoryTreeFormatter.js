import logger from "../../utils/logger.js";
import { createAbortController } from "../../utils/AbortController.js";
import { getErrorMessage } from "../../utils/ErrorHelpers.js";
import { TOOLS_SERVICE_URL } from "../../../config.js";
import { DIRECTORY_CACHE_TTL_MS, DIRECTORY_FETCH_TIMEOUT_MS, } from "../../constants.js";
export class DirectoryTreeFormatter {
    workspaceRoot;
    _directoryCache = null;
    _directoryCacheTime = 0;
    _directoryCacheTTL;
    constructor(workspaceRoot) {
        this.workspaceRoot = workspaceRoot;
        this._directoryCacheTTL = DIRECTORY_CACHE_TTL_MS;
    }
    /**
     * Fetch project directory tree from tools-api.
     * Cached to avoid hammering the API.
     */
    async fetchDirectoryTree() {
        const now = Date.now();
        if (this._directoryCache &&
            now - this._directoryCacheTime < this._directoryCacheTTL) {
            return this._directoryCache;
        }
        try {
            const controller = createAbortController();
            const timeout = setTimeout(() => controller.abort(), DIRECTORY_FETCH_TIMEOUT_MS);
            const url = `${TOOLS_SERVICE_URL}/filesystem/list?path=${encodeURIComponent(this.workspaceRoot)}&depth=2`;
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            if (!response.ok) {
                logger.warn(`[SystemPromptAssembler] Directory fetch failed: ${response.status}`);
                return "";
            }
            const data = (await response.json());
            const tree = this._formatDirectoryTree(data);
            this._directoryCache = tree;
            this._directoryCacheTime = now;
            return tree;
        }
        catch (error) {
            logger.warn(`[SystemPromptAssembler] Directory fetch error: ${getErrorMessage(error)}`);
            return this._directoryCache || "";
        }
    }
    _formatDirectoryTree(data) {
        if (!data || !data.entries)
            return "";
        const lines = [];
        for (const entry of data.entries) {
            const prefix = entry.type === "directory" ? "📁" : "📄";
            const name = entry.name || entry.path;
            lines.push(`${prefix} ${name}`);
            // Include first-level children for directories
            if (entry.children && Array.isArray(entry.children)) {
                for (const child of entry.children.slice(0, 20)) {
                    const childPrefix = child.type === "directory" ? "📁" : "📄";
                    lines.push(`  ${childPrefix} ${child.name || child.path}`);
                }
                if (entry.children.length > 20) {
                    lines.push(`  ... and ${entry.children.length - 20} more`);
                }
            }
        }
        return lines.join("\n");
    }
}
//# sourceMappingURL=DirectoryTreeFormatter.js.map