import type { ThreadEffectiveCwdSource } from "@threadlines/contracts";

/**
 * Working directory a thread's workspace surfaces (source control, file
 * viewer, terminal, open-in-editor) operate in.
 *
 * The provider session's observed cwd wins when it moved away from the
 * configured checkout (the agent entered a git worktree mid-session, or
 * edited files in one) so those surfaces show what the agent is actually
 * doing. Otherwise the thread's configured worktree applies, then the
 * project root.
 */
export function resolveThreadWorkingCwd(input: {
  projectCwd: string;
  worktreePath?: string | null | undefined;
  effectiveCwd?: string | null | undefined;
}): string;
/**
 * Sidebar-style callers resolve the project lazily, so the root can still be
 * missing; the observed cwd and worktree remain usable on their own.
 */
export function resolveThreadWorkingCwd(input: {
  projectCwd: string | null | undefined;
  worktreePath?: string | null | undefined;
  effectiveCwd?: string | null | undefined;
}): string | null;
export function resolveThreadWorkingCwd(input: {
  projectCwd: string | null | undefined;
  worktreePath?: string | null | undefined;
  effectiveCwd?: string | null | undefined;
}): string | null {
  return input.effectiveCwd ?? input.worktreePath ?? input.projectCwd ?? null;
}

/**
 * What an effective cwd and its source mean for the thread, for every reader
 * of one: the server's projections of `thread.effective-cwd-set` and the
 * client's copy of a server's threads. A legacy `subagent` value (a checkout
 * older servers guessed from an isolated subagent, which never moved the
 * thread's own agent) reads as no move.
 */
export function effectiveCwdOf(payload: {
  readonly effectiveCwd: string | null;
  readonly effectiveCwdSource?: ThreadEffectiveCwdSource | null | undefined;
}): {
  readonly effectiveCwd: string | null;
  readonly effectiveCwdSource: ThreadEffectiveCwdSource | null;
} {
  if (payload.effectiveCwdSource === "subagent") {
    return { effectiveCwd: null, effectiveCwdSource: null };
  }
  return {
    effectiveCwd: payload.effectiveCwd,
    effectiveCwdSource:
      payload.effectiveCwdSource ?? (payload.effectiveCwd === null ? null : "session"),
  };
}

/** Compact label for an observed working directory (its basename). */
export function threadWorkingCwdLabel(cwd: string): string {
  let end = cwd.length;
  while (end > 0 && (cwd[end - 1] === "/" || cwd[end - 1] === "\\")) {
    end -= 1;
  }
  const trimmed = cwd.slice(0, end);
  const segments = trimmed.split(/[/\\]/);
  return segments.at(-1) || trimmed;
}
