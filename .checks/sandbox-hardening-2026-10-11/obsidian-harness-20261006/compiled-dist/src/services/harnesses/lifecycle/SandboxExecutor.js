import { execSync } from "node:child_process";
import logger from "../../../utils/logger.js";
import { SERVER_SENT_EVENT_TYPES, STATUS_MESSAGES, } from "@rodrigo-barraza/utilities-library/taxonomy";
/**
 * SandboxExecutor — git-based filesystem checkpointing and rollback.
 *
 * Based on SWE-agent (NeurIPS 2024) and ceLLMate (arXiv 2025):
 * before executing a batch of destructive tool calls (file writes,
 * shell commands), create a git stash checkpoint. If the subsequent
 * validation fails or the harness decides to backtrack (e.g., ToT
 * branch rejection), restore the filesystem to the checkpoint state.
 *
 * This module complements the conversation-level backtracking in
 * TreeOfThoughtsStrategy (which restores `currentMessages` from
 * `preExecutionSnapshot`) by also restoring the *filesystem* state.
 * Without this, ToT backtracking only undoes the conversation context
 * while leaving the actual code changes in place — a critical gap.
 *
 * Implementation uses `git stash create` (not `git stash push`) to
 * create a stash commit object without modifying the stash reflog.
 * This avoids polluting the user's stash list with internal
 * checkpoint entries. Restore uses `git checkout <ref> -- .` to
 * surgically replace the working tree without affecting HEAD.
 *
 * Safety:
 *   - Operates only when `enableSandbox` is true in AgenticOptions
 *   - Verifies the directory is a git repo before any operation
 *   - All git commands use `--no-optional-locks` to avoid conflicts
 *   - Fails open (logs warning, doesn't block execution)
 */
const COMMAND_TIMEOUT_MILLISECONDS = 15_000;
/**
 * Create a filesystem checkpoint before destructive tool execution.
 * Returns the stash ref (SHA) on success, or null if checkpointing
 * failed or is not applicable.
 */
export function createSandboxCheckpoint(workspaceRoot, emit) {
    if (!workspaceRoot)
        return null;
    try {
        if (!isGitRepository(workspaceRoot)) {
            logger.info(`[SandboxExecutor] Skipping checkpoint — "${workspaceRoot}" is not a git repo`);
            return null;
        }
        // Stage all changes (including untracked files) so git stash create captures them
        execSync("git add -A", {
            cwd: workspaceRoot,
            timeout: COMMAND_TIMEOUT_MILLISECONDS,
            stdio: "pipe",
        });
        const stashReference = execSync("git stash create", {
            cwd: workspaceRoot,
            timeout: COMMAND_TIMEOUT_MILLISECONDS,
            encoding: "utf-8",
            stdio: "pipe",
        }).trim();
        // git stash create returns empty string if there's nothing to stash (clean working tree)
        if (!stashReference) {
            logger.info(`[SandboxExecutor] Clean working tree — no checkpoint needed`);
            return null;
        }
        emit({
            type: SERVER_SENT_EVENT_TYPES.STATUS,
            message: STATUS_MESSAGES.SANDBOX_CHECKPOINT_CREATED,
            stashReference,
        });
        logger.info(`[SandboxExecutor] Created checkpoint: ${stashReference.slice(0, 12)}`);
        return stashReference;
    }
    catch (checkpointError) {
        logger.warn(`[SandboxExecutor] Checkpoint creation failed: ${checkpointError instanceof Error ? checkpointError.message : String(checkpointError)}. Proceeding without sandbox.`);
        return null;
    }
}
/**
 * Restore the filesystem to a previous checkpoint.
 * Used when validation fails or a ToT branch is rejected.
 *
 * Returns true if the restore was successful.
 */
export function restoreSandboxCheckpoint(workspaceRoot, stashReference, emit) {
    if (!workspaceRoot || !stashReference)
        return false;
    try {
        // Reset to the stash ref, restoring all files to their checkpoint state.
        // This does NOT affect HEAD or any branches — it only changes the working tree.
        execSync(`git checkout ${stashReference} -- .`, {
            cwd: workspaceRoot,
            timeout: COMMAND_TIMEOUT_MILLISECONDS,
            stdio: "pipe",
        });
        emit({
            type: SERVER_SENT_EVENT_TYPES.STATUS,
            message: STATUS_MESSAGES.SANDBOX_RESTORED,
            stashReference,
        });
        logger.info(`[SandboxExecutor] Restored checkpoint: ${stashReference.slice(0, 12)}`);
        return true;
    }
    catch (restoreError) {
        logger.error(`[SandboxExecutor] Checkpoint restore FAILED for ${stashReference.slice(0, 12)}: ` +
            `${restoreError instanceof Error ? restoreError.message : String(restoreError)}. ` +
            `Filesystem may be in an inconsistent state.`);
        return false;
    }
}
/**
 * Check whether the given directory is inside a git repository.
 */
function isGitRepository(directoryPath) {
    try {
        execSync("git rev-parse --is-inside-work-tree", {
            cwd: directoryPath,
            timeout: 5_000,
            stdio: "pipe",
        });
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=SandboxExecutor.js.map