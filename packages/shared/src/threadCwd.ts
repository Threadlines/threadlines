/**
 * Working directory a thread's workspace surfaces (source control, file
 * viewer, terminal, open-in-editor) operate in.
 *
 * The provider session's observed cwd wins when it moved away from the
 * configured checkout — e.g. the agent created and entered a git worktree
 * mid-session — so those surfaces show what the agent is actually doing.
 * Otherwise the thread's configured worktree applies, then the project root.
 */
export function resolveThreadWorkingCwd(input: {
  projectCwd: string;
  worktreePath?: string | null | undefined;
  effectiveCwd?: string | null | undefined;
}): string {
  return input.effectiveCwd ?? input.worktreePath ?? input.projectCwd;
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
