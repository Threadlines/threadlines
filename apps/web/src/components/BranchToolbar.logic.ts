import type {
  EnvironmentId,
  VcsRef,
  ProjectId,
  OrchestrationSessionStatus,
} from "@threadlines/contracts";
import { areFilesystemPathsEqual } from "@threadlines/shared/path";
import { threadWorkingCwdLabel } from "@threadlines/shared/threadCwd";
import * as Schema from "effect/Schema";
export {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
} from "@threadlines/shared/git";

export interface EnvironmentOption {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  label: string;
  isPrimary: boolean;
}

export const EnvMode = Schema.Literals(["local", "worktree"]);
export type EnvMode = typeof EnvMode.Type;

const GENERIC_LOCAL_ENVIRONMENT_LABELS = new Set(["local", "local environment"]);

function normalizeDisplayLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function resolveEnvironmentOptionLabel(input: {
  isPrimary: boolean;
  environmentId: EnvironmentId;
  runtimeLabel?: string | null;
  savedLabel?: string | null;
}): string {
  const runtimeLabel = normalizeDisplayLabel(input.runtimeLabel);
  const savedLabel = normalizeDisplayLabel(input.savedLabel);

  if (input.isPrimary) {
    const preferredLocalLabel = [runtimeLabel, savedLabel].find((label) => {
      if (!label) return false;
      return !GENERIC_LOCAL_ENVIRONMENT_LABELS.has(label.toLowerCase());
    });
    return preferredLocalLabel ?? "This device";
  }

  return runtimeLabel ?? savedLabel ?? input.environmentId;
}

export function resolveEnvModeLabel(mode: EnvMode): string {
  return mode === "worktree" ? "New worktree" : "Current checkout";
}

export function resolveCurrentWorkspaceLabel(activeWorktreePath: string | null): string {
  return activeWorktreePath ? "Current worktree" : resolveEnvModeLabel("local");
}

export function resolveLockedWorkspaceLabel(activeWorktreePath: string | null): string {
  return activeWorktreePath ? "Worktree" : "Local checkout";
}

export function resolveActiveWorktreePath(
  projectCwd: string | null,
  worktreePath: string | null,
): string | null {
  if (!projectCwd || !worktreePath) {
    return worktreePath;
  }
  return areFilesystemPathsEqual(projectCwd, worktreePath) ? null : worktreePath;
}

export function resolveEffectiveEnvMode(input: {
  activeWorktreePath: string | null;
  hasServerThread: boolean;
  draftThreadEnvMode: EnvMode | undefined;
}): EnvMode {
  const { activeWorktreePath, hasServerThread, draftThreadEnvMode } = input;
  if (!hasServerThread) {
    if (activeWorktreePath) {
      return "local";
    }
    return draftThreadEnvMode === "worktree" ? "worktree" : "local";
  }
  return activeWorktreePath ? "worktree" : "local";
}

export function resolveDraftEnvModeAfterBranchChange(input: {
  nextWorktreePath: string | null;
  currentWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
}): EnvMode {
  const { nextWorktreePath, currentWorktreePath, effectiveEnvMode } = input;
  if (nextWorktreePath) {
    return "worktree";
  }
  if (effectiveEnvMode === "worktree" && !currentWorktreePath) {
    return "worktree";
  }
  return "local";
}

export function resolveBranchToolbarValue(input: {
  envMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}): string | null {
  const { envMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  if (envMode === "worktree" && !activeWorktreePath) {
    return activeThreadBranch ?? currentGitBranch;
  }
  return currentGitBranch ?? activeThreadBranch;
}

export function resolveBranchSelectionTarget(input: {
  activeProjectCwd: string;
  activeWorktreePath: string | null;
  refName: Pick<VcsRef, "isDefault" | "worktreePath">;
}): {
  checkoutCwd: string;
  nextWorktreePath: string | null;
  reuseExistingWorktree: boolean;
} {
  const { activeProjectCwd, activeWorktreePath, refName } = input;

  if (refName.worktreePath) {
    const isPrimaryCheckout = areFilesystemPathsEqual(refName.worktreePath, activeProjectCwd);
    return {
      checkoutCwd: refName.worktreePath,
      nextWorktreePath: isPrimaryCheckout ? null : refName.worktreePath,
      reuseExistingWorktree: true,
    };
  }

  const nextWorktreePath =
    activeWorktreePath !== null && refName.isDefault ? null : activeWorktreePath;

  return {
    checkoutCwd: nextWorktreePath ?? activeProjectCwd,
    nextWorktreePath,
    reuseExistingWorktree: false,
  };
}

/**
 * Whether the thread has a turn the agent is actively working (or about to
 * start). Switching branches inside the checkout it is working in swaps files
 * underneath it, so those actions confirm first.
 */
export function hasActiveThreadTurn(
  session: { readonly orchestrationStatus: OrchestrationSessionStatus } | null | undefined,
): boolean {
  if (!session) {
    return false;
  }
  return session.orchestrationStatus === "running" || session.orchestrationStatus === "starting";
}

/**
 * Which checkout the picker lists refs from.
 *
 * Normally the thread's own. When that folder has been deleted, listing refs
 * there returns nothing, which left the picker on screen but empty: no project
 * root, no other worktrees, nothing to switch to. Falling back to the project
 * root keeps the valid alternatives listed so there is always a way out.
 */
export function resolveCheckoutPickerRefsCwd(input: {
  readonly selectedCwd: string | null;
  readonly projectCwd: string | null;
  readonly selectedCheckoutMissing: boolean;
}): string | null {
  if (input.selectedCheckoutMissing && input.projectCwd) {
    return input.projectCwd;
  }
  return input.selectedCwd;
}

/**
 * Marks the picker's current selection as a folder that is no longer there.
 *
 * Plain trailing text rather than a badge or colour: the picker's job here is
 * to say what is selected and let the user pick something else, and the
 * recovery actions live in the notice above the composer.
 */
export function annotateMissingCheckoutLabel(label: string, missing: boolean): string {
  return missing ? `${label} (missing)` : label;
}

/** How a checkout reads in prose: worktrees by name, the project root by role. */
export function resolveCheckoutDisplayLabel(
  checkoutCwd: string,
  activeProjectCwd: string | null,
): string {
  if (activeProjectCwd && areFilesystemPathsEqual(checkoutCwd, activeProjectCwd)) {
    return "the local checkout";
  }
  return threadWorkingCwdLabel(checkoutCwd);
}

export interface PendingCheckoutSwitch {
  /** Checkout the thread is queued to move into. */
  readonly targetCheckoutCwd: string;
  /** Checkout the live session is still running in. */
  readonly fromCheckoutCwd: string;
  /** Display label for the checkout the session is still in. */
  readonly fromLabel: string;
  /** Display label for the queued destination. */
  readonly toLabel: string;
  /**
   * The switch cannot apply on the next turn: the session owns running
   * background tasks, so the server keeps running turns where they are until
   * those finish.
   */
  readonly deferred: boolean;
}

/**
 * A checkout switch is never a live mutation: the thread's target checkout
 * moves immediately while the running session stays where it started. The
 * server cycles the session into the new checkout as soon as it is safe — the
 * session idle with no background tasks left — or at the latest when the next
 * turn is dispatched, so surface the queued switch until then.
 *
 * Returns null when nothing is queued (no live session, or it already runs in
 * the target checkout).
 */
export function resolvePendingCheckoutSwitch(input: {
  /** Checkout the live session was started in; null/undefined when unknown. */
  sessionCheckoutCwd: string | null | undefined;
  /** Orchestration status of the thread's session, if it has one. */
  sessionStatus: OrchestrationSessionStatus | null | undefined;
  /** Background tasks still running inside the live session's runtime. */
  pendingBackgroundTaskCount?: number | null | undefined;
  /** Project workspace root — the target checkout when no worktree is set. */
  activeProjectCwd: string | null;
  /** Thread's configured worktree, or null when it runs in the project root. */
  activeWorktreePath: string | null;
}): PendingCheckoutSwitch | null {
  const { sessionCheckoutCwd, sessionStatus, activeProjectCwd, activeWorktreePath } = input;
  if (!sessionCheckoutCwd || !sessionStatus || sessionStatus === "stopped") {
    return null;
  }
  const targetCheckoutCwd = activeWorktreePath ?? activeProjectCwd;
  if (!targetCheckoutCwd || areFilesystemPathsEqual(targetCheckoutCwd, sessionCheckoutCwd)) {
    return null;
  }
  return {
    targetCheckoutCwd,
    fromCheckoutCwd: sessionCheckoutCwd,
    fromLabel: resolveCheckoutDisplayLabel(sessionCheckoutCwd, activeProjectCwd),
    toLabel: resolveCheckoutDisplayLabel(targetCheckoutCwd, activeProjectCwd),
    deferred: (input.pendingBackgroundTaskCount ?? 0) > 0,
  };
}

/**
 * Chip copy leads with where the agent still is, because that is what the user
 * is about to be surprised by. The short form survives phone widths.
 */
export function checkoutSwitchChipText(pending: PendingCheckoutSwitch): {
  long: string;
  short: string;
} {
  if (pending.deferred) {
    return {
      long: `Agent still in ${pending.fromLabel} · waiting on a background task`,
      short: `In ${pending.fromLabel} · task running`,
    };
  }
  return {
    long: `Agent still in ${pending.fromLabel}`,
    short: `In ${pending.fromLabel}`,
  };
}

export function checkoutSwitchExplanation(pending: PendingCheckoutSwitch): string {
  return pending.deferred
    ? `A background task is still running inside this session, so it stays in ${pending.fromLabel}. The switch to ${pending.toLabel} applies on its own once that task finishes; until then your messages run in ${pending.fromLabel}.`
    : `This session is finishing in ${pending.fromLabel}. It moves to ${pending.toLabel} as soon as the current turn ends.`;
}

/**
 * Toast copy for the moment a branch pick queues a checkout switch behind a
 * busy session. Null when nothing ends up queued, or when the session is idle:
 * an idle session is cycled by the server right away, so there is nothing to
 * announce.
 */
export function queuedCheckoutSwitchToast(input: {
  session:
    | {
        readonly orchestrationStatus: OrchestrationSessionStatus;
        readonly checkoutCwd?: string | null | undefined;
        readonly pendingBackgroundTaskCount?: number | null | undefined;
      }
    | null
    | undefined;
  activeProjectCwd: string | null;
  nextWorktreePath: string | null;
}): { title: string; description: string } | null {
  const pending = resolvePendingCheckoutSwitch({
    sessionCheckoutCwd: input.session?.checkoutCwd,
    sessionStatus: input.session?.orchestrationStatus,
    pendingBackgroundTaskCount: input.session?.pendingBackgroundTaskCount,
    activeProjectCwd: input.activeProjectCwd,
    activeWorktreePath: resolveActiveWorktreePath(input.activeProjectCwd, input.nextWorktreePath),
  });
  if (!pending) {
    return null;
  }
  if (pending.deferred) {
    return {
      title: "Checkout switch queued",
      description: `A background task is still running in ${pending.fromLabel}. The agent moves to ${pending.toLabel} when it finishes.`,
    };
  }
  if (!hasActiveThreadTurn(input.session)) {
    return null;
  }
  return {
    title: "Checkout switch queued",
    description: `The agent moves to ${pending.toLabel} when the current turn finishes.`,
  };
}

export function shouldIncludeBranchPickerItem(input: {
  itemValue: string;
  normalizedQuery: string;
  createBranchItemValue: string | null;
  checkoutPullRequestItemValue: string | null;
}): boolean {
  const { itemValue, normalizedQuery, createBranchItemValue, checkoutPullRequestItemValue } = input;

  if (normalizedQuery.length === 0) {
    return true;
  }

  if (createBranchItemValue && itemValue === createBranchItemValue) {
    return true;
  }

  if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
    return true;
  }

  return itemValue.toLowerCase().includes(normalizedQuery);
}
