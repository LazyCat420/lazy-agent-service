import { resolve, relative } from "node:path";
import { existsSync } from "node:fs";
import { TOOLS_SERVICE_URL } from "../../../config.ts";
import ToolOrchestratorService from "../ToolOrchestratorService.ts";
import type {
  ToolsApiResponse,
  WorktreeCreateResponse,
} from "../../types/orchestrator.ts";
import { getErrorMessage } from "../../utils/ErrorHelpers.ts";

export class GitWorktreeHelper {
  static getDefaultWorkspaceRoot(overrideRoot?: string): string {
    return (
      overrideRoot ||
      ToolOrchestratorService.getWorkspaceRoot() ||
      resolve(process.env.HOME || "/home")
    );
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
  static resolveRepositoryPath(workspaceRoot: string, files: string[]): string {
    if (!files?.length) return workspaceRoot;

    // Check if workspace root itself is a git repository
    if (existsSync(resolve(workspaceRoot, ".git"))) return workspaceRoot;

    // Take the first file, get its path relative to workspace root,
    // extract the first directory segment (the project dir)
    const firstFile = resolve(files[0]);
    const relativePath = relative(workspaceRoot, firstFile);
    const firstSegment = relativePath.split("/")[0];
    if (!firstSegment) return workspaceRoot;

    const candidate = resolve(workspaceRoot, firstSegment);
    if (existsSync(resolve(candidate, ".git"))) {
      return candidate;
    }

    return workspaceRoot;
  }

  static async toolsApiPost<T extends ToolsApiResponse>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    try {
      const response = await fetch(`${TOOLS_SERVICE_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        const errorMessage =
          typeof errorData.error === "string"
            ? errorData.error
            : `API returned ${response.status}`;
        return { error: errorMessage } as unknown as T;
      }
      return (await response.json()) as T;
    } catch (error: unknown) {
      return {
        error: `Failed to reach tools-api: ${getErrorMessage(error)}`,
      } as unknown as T;
    }
  }

  static async createWorktree(
    repositoryPath: string,
    branchName: string,
  ): Promise<WorktreeCreateResponse> {
    return GitWorktreeHelper.toolsApiPost<WorktreeCreateResponse>(
      "/agentic/git/worktree/create",
      {
        path: repositoryPath,
        branch: branchName,
      },
    );
  }

  static async removeWorktree(
    repositoryPath: string,
    worktreePath: string,
  ): Promise<ToolsApiResponse> {
    return GitWorktreeHelper.toolsApiPost<ToolsApiResponse>(
      "/agentic/git/worktree/remove",
      {
        path: repositoryPath,
        worktreePath,
      },
    );
  }

  /** The tools-service diff body as sent; `toWorktreeDiff` (WorktreeDiffContract.ts) reads it. */
  static async getWorktreeDiff(
    repositoryPath: string,
    branchName: string,
  ): Promise<ToolsApiResponse> {
    return GitWorktreeHelper.toolsApiPost<ToolsApiResponse>("/agentic/git/worktree/diff", {
      path: repositoryPath,
      branch: branchName,
    });
  }

  static async mergeWorktree(
    repositoryPath: string,
    branchName: string,
    message: string,
  ): Promise<ToolsApiResponse> {
    return GitWorktreeHelper.toolsApiPost<ToolsApiResponse>(
      "/agentic/git/worktree/merge",
      {
        path: repositoryPath,
        branch: branchName,
        message,
      },
    );
  }

  static async cleanupWorktrees(
    repositoryPath: string,
  ): Promise<ToolsApiResponse> {
    return GitWorktreeHelper.toolsApiPost<ToolsApiResponse>(
      "/agentic/git/worktree/cleanup",
      {
        path: repositoryPath,
      },
    );
  }
}
