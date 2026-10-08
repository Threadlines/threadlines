import type { OrchestrationTurnEndState } from "@threadlines/contracts";

import { isGitRepository } from "../git/Utils.ts";

/**
 * Whether a thread's turns end with a git checkpoint: its checkout (the
 * thread's worktree, else its project's root) is a git repository. A turn
 * ends with its final capture, so a checkout without git (a general chat's
 * scratch folder, a project outside git) has its turns ended by ingestion
 * instead. Ingestion and the checkpoint reactor read this one answer, so each
 * turn is ended by exactly one of them.
 */
export function checkoutEndsTurnsWithCheckpoints(
  context: { readonly worktreePath: string | null; readonly workspaceRoot: string } | undefined,
): boolean {
  const cwd = context?.worktreePath ?? context?.workspaceRoot;
  return cwd !== undefined && isGitRepository(cwd);
}

/** How a turn ended, from the provider's word for it. */
export function turnEndStateFromRuntime(state: string | undefined): OrchestrationTurnEndState {
  switch (state) {
    case "failed":
      return "error";
    case "interrupted":
    case "cancelled":
      return "interrupted";
    default:
      return "completed";
  }
}
