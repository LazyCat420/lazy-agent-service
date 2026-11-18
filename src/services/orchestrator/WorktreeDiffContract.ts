import { z } from "zod";
import type { WorktreeDiff } from "../../types/orchestrator.ts";

/**
 * The part of tools-service's worktree diff (POST /agentic/git/worktree/diff, type WorktreeDiff in
 * its src/services/AgenticGitService.ts, pinned by tests/fixtures/worktree-diff-contract.json)
 * that a sub-agent's result reports. `branch`, `base`, `patch` and `patchTruncated` are not read.
 */
const ToolsServiceWorktreeDiffSchema = z.object({
  files: z.array(z.object({ path: z.string() })),
  stats: z.object({ additions: z.number(), deletions: z.number() }),
});

/** A sub-agent's diff from the tools-service body; null for a refusal or any other shape. */
export function toWorktreeDiff(body: unknown): WorktreeDiff | null {
  const parsed = ToolsServiceWorktreeDiffSchema.safeParse(body);
  if (!parsed.success) return null;
  const { files, stats } = parsed.data;
  return {
    hasChanges: files.length > 0,
    additions: stats.additions,
    deletions: stats.deletions,
    files: files.map((file) => file.path),
  };
}
