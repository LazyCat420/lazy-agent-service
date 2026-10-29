import { resolve, relative } from "node:path";
import { existsSync } from "node:fs";
import { TOOLS_SERVICE_URL } from "../../../config.js";
import ToolOrchestratorService from "../ToolOrchestratorService.js";
import { getErrorMessage } from "../../utils/ErrorHelpers.js";
export class GitWorktreeHelper {
    static getDefaultWorkspaceRoot(overrideRoot) {
        return (overrideRoot ||
            ToolOrchestratorService.getWorkspaceRoot() ||
            resolve(process.env.HOME || "/home"));
    }
    /**
     * Derive the git repository path from a sub-agent's file list.
     *
     * If files live under a git subdirectory of the workspace root
     * (e.g. /workspace/projectA/.git exists), return that subdirectory
     * as the repository path so worktrees branch from it.
     *
     * Falls back to workspaceRoot if no git repository is found.
     */
    static resolveRepositoryPath(workspaceRoot, files) {
        if (!files?.length)
            return workspaceRoot;
        // Check if workspace root itself is a git repository
        if (existsSync(resolve(workspaceRoot, ".git")))
            return workspaceRoot;
        // Take the first file, get its path relative to workspace root,
        // extract the first directory segment (the project dir)
        const firstFile = resolve(files[0]);
        const relativePath = relative(workspaceRoot, firstFile);
        const firstSegment = relativePath.split("/")[0];
        if (!firstSegment)
            return workspaceRoot;
        const candidate = resolve(workspaceRoot, firstSegment);
        if (existsSync(resolve(candidate, ".git"))) {
            return candidate;
        }
        return workspaceRoot;
    }
    static async toolsApiPost(path, body) {
        try {
            const response = await fetch(`${TOOLS_SERVICE_URL}${path}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                const errorData = (await response.json().catch(() => ({})));
                const errorMessage = typeof errorData.error === "string"
                    ? errorData.error
                    : `API returned ${response.status}`;
                return { error: errorMessage };
            }
            return (await response.json());
        }
        catch (error) {
            return {
                error: `Failed to reach tools-api: ${getErrorMessage(error)}`,
            };
        }
    }
    static async createWorktree(repositoryPath, branchName) {
        return GitWorktreeHelper.toolsApiPost("/agentic/git/worktree/create", {
            path: repositoryPath,
            branch: branchName,
        });
    }
    static async removeWorktree(repositoryPath, worktreePath) {
        return GitWorktreeHelper.toolsApiPost("/agentic/git/worktree/remove", {
            path: repositoryPath,
            worktreePath,
        });
    }
    static async getWorktreeDiff(repositoryPath, branchName) {
        return GitWorktreeHelper.toolsApiPost("/agentic/git/worktree/diff", {
            path: repositoryPath,
            branch: branchName,
        });
    }
    static async mergeWorktree(repositoryPath, branchName, message) {
        return GitWorktreeHelper.toolsApiPost("/agentic/git/worktree/merge", {
            path: repositoryPath,
            branch: branchName,
            message,
        });
    }
    static async cleanupWorktrees(repositoryPath) {
        return GitWorktreeHelper.toolsApiPost("/agentic/git/worktree/cleanup", {
            path: repositoryPath,
        });
    }
}
//# sourceMappingURL=GitWorktreeHelper.js.map