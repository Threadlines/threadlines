/**
 * What the UI offers when a thread's folder is gone.
 *
 * A thread pinned to a git worktree stops working the moment that folder is
 * deleted — by the agent tidying up after merging its own branch, or by the
 * user in a terminal. Before this existed the failure surfaced as a provider
 * error blaming the CLI, with only a Retry that failed the same way, and the
 * source control panel offered to run `git init` on a path that wasn't there.
 *
 * Every surface that has to react (the composer notice, the source control
 * panel, the checkout picker) derives its state from here so they cannot
 * disagree about whether a checkout is missing or what can be done about it.
 *
 * The signal is the server's `pathMissing` flag on the VCS status, which is
 * deliberately distinct from `isRepo: false` ("the folder is there but holds no
 * repository"). Only the second is an invitation to initialize a repository.
 *
 * @module checkoutRecovery
 */

/** The subset of a VCS status this module reads. */
export interface CheckoutStatusLike {
  readonly isRepo: boolean;
  readonly pathMissing?: boolean | undefined;
}

export interface CheckoutRecoveryState {
  /** Absolute path of the folder that is gone. */
  readonly cwd: string;
  /** Folder name, for compact display where the full path won't fit. */
  readonly label: string;
  /** Project root the thread can move to, when there is one to move to. */
  readonly projectCwd: string | null;
  /** Branch the missing checkout held, when the thread recorded one. */
  readonly branch: string | null;
  /** Moving the thread to the project root is possible. */
  readonly canSwitchToProjectRoot: boolean;
  /**
   * The folder can be recreated exactly as it was. Requires the branch to still
   * exist in the repository: without it there is nothing to check out, and the
   * only way forward is the project root.
   */
  readonly canRecreateWorktree: boolean;
}

/** Trailing folder name of a path, tolerating either separator. */
export function checkoutFolderLabel(cwd: string): string {
  const trimmed = cwd.replace(/[/\\]+$/u, "");
  const segments = trimmed.split(/[/\\]/u);
  return segments.at(-1) || trimmed;
}

function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalize(left) === normalize(right);
}

/**
 * The recovery state for a thread's checkout, or null when nothing is wrong.
 *
 * Returns null while the status is still loading or absent: a checkout is only
 * treated as missing on a positive answer from the server, never on the absence
 * of one. That keeps a slow or disconnected status from spuriously telling the
 * user their folder was deleted.
 */
export function selectCheckoutRecovery(input: {
  readonly cwd: string | null | undefined;
  readonly projectCwd: string | null | undefined;
  readonly branch: string | null | undefined;
  readonly status: CheckoutStatusLike | null | undefined;
  /**
   * Whether {@link input.branch} still exists in the project repository.
   * Undefined means "not known yet", which withholds the recreate action rather
   * than offering one that would fail.
   */
  readonly branchExists?: boolean | undefined;
}): CheckoutRecoveryState | null {
  const cwd = input.cwd?.trim();
  if (!cwd || input.status?.pathMissing !== true) {
    return null;
  }
  const projectCwd = input.projectCwd?.trim() || null;
  const branch = input.branch?.trim() || null;
  // When the project root *is* the missing folder there is nowhere to fall back
  // to and nothing to recreate the worktree from; the problem is stated plainly
  // and both actions stay off.
  const hasSeparateProjectRoot = projectCwd !== null && !samePath(projectCwd, cwd);

  return {
    cwd,
    label: checkoutFolderLabel(cwd),
    projectCwd,
    branch,
    canSwitchToProjectRoot: hasSeparateProjectRoot,
    canRecreateWorktree: hasSeparateProjectRoot && branch !== null && input.branchExists === true,
  };
}

/**
 * Whether the checkout picker must stay on screen.
 *
 * The picker used to be hidden whenever the selected checkout had no usable git
 * status, which is exactly the situation where the user most needs it: with the
 * worktree deleted, the picker was the only way back to the project root and it
 * had disappeared. It now survives an invalid selection as long as the project
 * root is a repository, so there is always a way out.
 */
export function shouldShowCheckoutPicker(input: {
  readonly selectedStatus: CheckoutStatusLike | null | undefined;
  readonly projectRootStatus: CheckoutStatusLike | null | undefined;
}): boolean {
  // Default to visible while a status is pending so the toolbar does not flicker.
  if (!input.selectedStatus) {
    return true;
  }
  if (input.selectedStatus.isRepo) {
    return true;
  }
  if (input.selectedStatus.pathMissing === true) {
    return input.projectRootStatus ? input.projectRootStatus.isRepo : true;
  }
  return false;
}

/**
 * The checkout a new draft should start in.
 *
 * A draft inherits its checkout from the thread the user came from, which is
 * how one broken thread used to spread: start a new thread from a thread whose
 * worktree was deleted and the new one is born pointing at the same dead path,
 * with the same broken source control and the same missing picker. A checkout
 * already known to be gone is therefore not inherited — the draft falls back to
 * the project root, where it will work.
 *
 * Only inheritance is filtered. An explicitly requested path is the user's
 * choice and is passed through untouched.
 */
export function seedDraftWorktreePath(input: {
  /** Explicitly requested path; `undefined` means "inherit". */
  readonly requested: string | null | undefined;
  readonly inherited: string | null;
  readonly projectChanged: boolean;
  /** Known-missing test, from whatever status the client already holds. */
  readonly isCheckoutMissing: (cwd: string) => boolean;
}): string | null {
  if (input.requested !== undefined) {
    return input.requested ?? null;
  }
  if (input.projectChanged) {
    return null;
  }
  const inherited = input.inherited;
  if (inherited === null) {
    return null;
  }
  return input.isCheckoutMissing(inherited) ? null : inherited;
}
