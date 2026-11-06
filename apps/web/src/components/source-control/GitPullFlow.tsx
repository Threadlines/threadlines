import type {
  EnvironmentId,
  GitRemoteAuthFailure,
  ScopedThreadRef,
  VcsPullHistoryReconciliation,
  VcsPullResult,
  VcsStatusResult,
} from "@threadlines/contracts";
import { formatGitErrorMessage, gitRemoteAuthFailureFromError } from "@threadlines/shared/git";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { TriangleAlertIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { gitPullMutationOptions, gitQueryKeys } from "~/lib/gitReactQuery";
import { refreshGitStatus } from "~/lib/gitStatusState";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { failureNotice, toastManager } from "../ui/toast";
import { GitAuthRemediationDialog } from "./GitAuthRemediationDialog";
import {
  resolveSourceControlPullKind,
  sourceControlActionDisabledReason,
  type SourceControlPullKind,
} from "./SourceControlPanel.logic";

/** The checkout a pull runs in. */
export interface GitPullTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}

export function isSameGitPullTarget(a: GitPullTarget, b: GitPullTarget): boolean {
  return a.environmentId === b.environmentId && a.cwd === b.cwd;
}

/** Reads a checkout's status and commit graph again after a git action changed it. */
export function refreshGitCheckout(queryClient: QueryClient, target: GitPullTarget): void {
  const { environmentId, cwd } = target;
  if (!environmentId || !cwd) {
    return;
  }
  void refreshGitStatus({ environmentId, cwd }).catch(() => undefined);
  void queryClient.invalidateQueries({
    queryKey: gitQueryKeys.commitGraphPrefix(environmentId, cwd),
  });
}

type HistoryReconciliationRequiredResult = Extract<
  VcsPullResult,
  { readonly status: "requires_history_reconciliation" }
>;

interface PendingHistoryReconciliation extends GitPullTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly result: HistoryReconciliationRequiredResult;
}

/** A protected stash that Threadlines kept because putting it back went wrong. */
export interface PendingStashRecovery extends GitPullTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly title: string;
  readonly detail: string;
  readonly stashId: string;
  readonly recoveryRef: string | null;
  readonly conflictedPaths: readonly string[];
}

type PullOptions = {
  readonly historyReconciliation?: VcsPullHistoryReconciliation;
  readonly stashLocalChanges?: boolean;
};

export interface GitPullFlow {
  readonly target: GitPullTarget;
  readonly status: VcsStatusResult | null;
  readonly kind: SourceControlPullKind;
  /** Why pulling can't start now, or null when it can. */
  readonly disabledReason: string | null;
  readonly isPending: boolean;
  /** Pulls, asking first when local changes would be stashed around it. */
  readonly run: () => void;
  readonly execute: (options?: PullOptions) => void;
  readonly stashConfirmationOpen: boolean;
  readonly setStashConfirmationOpen: (open: boolean) => void;
  readonly historyReconciliation: PendingHistoryReconciliation | null;
  readonly dismissHistoryReconciliation: () => void;
  readonly stashRecovery: PendingStashRecovery | null;
  readonly showStashRecovery: (recovery: PendingStashRecovery | null) => void;
  readonly authFailure: GitRemoteAuthFailure | null;
  readonly dismissAuthFailure: () => void;
  /** Whether a request made for `target` still belongs to the checkout on screen. */
  readonly isCurrentTarget: (target: GitPullTarget) => boolean;
}

/**
 * Pulling a checkout, wherever it starts: the Source tab's Pull button and the
 * chat header's change count both run it, with the same toasts and the same
 * follow-up questions. Render `GitPullDialogs` beside whatever calls `run`.
 */
export function useGitPull(input: {
  readonly target: GitPullTarget;
  readonly status: VcsStatusResult | null;
  /** Another git action is under way in this checkout. */
  readonly isBusy: boolean;
  /** Set while the checkout must not be changed yet, and why. */
  readonly repositorySafetyReason: string | null;
  readonly threadToastData: { readonly threadRef: ScopedThreadRef } | undefined;
  /**
   * A stash-and-pull ran into a rewritten upstream: the caller's own stash
   * form, when it has one. The toast already says to stash by hand.
   */
  readonly onStashRequired?: () => void;
}): GitPullFlow {
  const { target, status, isBusy, repositorySafetyReason, threadToastData, onStashRequired } =
    input;
  const { environmentId, cwd } = target;
  const queryClient = useQueryClient();
  const pullMutation = useMutation(gitPullMutationOptions({ environmentId, cwd, queryClient }));
  const [stashConfirmationOpen, setStashConfirmationOpen] = useState(false);
  const [pendingHistoryReconciliation, setPendingHistoryReconciliation] =
    useState<PendingHistoryReconciliation | null>(null);
  const [pendingStashRecovery, setPendingStashRecovery] = useState<PendingStashRecovery | null>(
    null,
  );
  const [authFailure, setAuthFailure] = useState<GitRemoteAuthFailure | null>(null);
  // Questions belong to the checkout they were asked about: moving to another
  // one drops them, so coming back doesn't bring up a stale one.
  const [questionsTarget, setQuestionsTarget] = useState<GitPullTarget>(target);
  if (!isSameGitPullTarget(questionsTarget, target)) {
    setQuestionsTarget(target);
    setPendingHistoryReconciliation(null);
    setPendingStashRecovery(null);
    setStashConfirmationOpen(false);
  }
  // A pull settles after the user may have moved on; its answer only counts
  // for the checkout still on screen.
  const currentTargetRef = useRef<GitPullTarget>(target);
  useLayoutEffect(() => {
    currentTargetRef.current = target;
  }, [target]);

  const kind = resolveSourceControlPullKind(status);
  const disabledReason = sourceControlActionDisabledReason({
    status,
    action: "pull",
    isBusy: isBusy || pullMutation.isPending,
    repositorySafetyReason,
  });
  const isCurrentTarget = useCallback(
    (requestTarget: GitPullTarget) => isSameGitPullTarget(requestTarget, currentTargetRef.current),
    [],
  );

  const execute = useCallback(
    (options?: PullOptions) => {
      if (repositorySafetyReason !== null) {
        return;
      }
      const requestTarget: GitPullTarget = { environmentId, cwd };
      const promise = pullMutation.mutateAsync(options);
      void toastManager.promise<Awaited<ReturnType<typeof pullMutation.mutateAsync>>>(promise, {
        loading: {
          title: options?.historyReconciliation
            ? "Updating from rewritten upstream..."
            : options?.stashLocalChanges
              ? "Stashing, pulling, and restoring..."
              : kind === "resolve_divergence"
                ? "Checking branch history..."
                : "Pulling...",
          data: threadToastData,
        },
        success: (result) => {
          switch (result.status) {
            case "pulled":
              return {
                title: "Pulled",
                description: `Updated ${result.refName} from ${result.upstreamRef ?? "upstream"}.`,
                data: threadToastData,
              };
            case "skipped_up_to_date":
              return {
                title: "Already up to date",
                description: `${result.refName} is already synchronized.`,
                data: threadToastData,
              };
            case "requires_history_reconciliation":
              return options?.stashLocalChanges
                ? {
                    title: "Upstream history changed",
                    description:
                      "Stash your changes manually, then pull again to review the rewritten history.",
                    timeout: 0,
                    data: threadToastData,
                  }
                : {
                    title: "Branch history needs review",
                    description: `Review ${result.refName} against ${result.upstreamRef} before updating.`,
                    data: threadToastData,
                  };
            case "reconciled":
              return {
                title: "Updated from rewritten upstream",
                description: `Backed up ${result.refName} to ${result.recoveryRef}, then updated it from ${result.upstreamRef}.`,
                data: threadToastData,
              };
            case "pulled_with_restored_changes":
              return {
                title: "Updated and restored changes",
                description: result.stashDropped
                  ? `Updated ${result.refName} from ${result.upstreamRef} and restored your local changes.`
                  : `Updated ${result.refName} and restored your local changes. The protected stash was kept because the stash list changed.`,
                data: threadToastData,
              };
            case "pulled_with_restore_conflicts":
              return {
                title: "Updated; local changes need attention",
                description: `Your protected stash was kept. Resolve ${result.conflictedPaths.length} conflicted ${result.conflictedPaths.length === 1 ? "file" : "files"}.`,
                timeout: 0,
                data: threadToastData,
              };
            case "pulled_with_restore_failure":
              return {
                title: "Updated; protected changes need attention",
                description: result.detail,
                timeout: 0,
                data: threadToastData,
              };
            case "update_failed_with_protected_changes":
              return {
                title: "Update stopped; protected changes need attention",
                description: result.detail,
                timeout: 0,
                data: threadToastData,
              };
          }
        },
        error: (error) => {
          const remoteAuthFailure = gitRemoteAuthFailureFromError(error);
          if (remoteAuthFailure) {
            return failureNotice({
              title: "Couldn't pull the changes",
              reason: formatGitErrorMessage(error),
              timeout: 0,
              actionProps: {
                children: "Fix authentication...",
                onClick: () => setAuthFailure(remoteAuthFailure),
              },
              data: {
                ...threadToastData,
                actionVariant: "default" as const,
              },
            });
          }
          return failureNotice({
            title: "Couldn't pull the changes",
            reason: formatGitErrorMessage(error),
            ...(threadToastData ? { data: threadToastData } : {}),
          });
        },
      });
      void promise.then(
        (result) => {
          if (!isCurrentTarget(requestTarget)) {
            return;
          }
          if (result.status === "requires_history_reconciliation" && !options?.stashLocalChanges) {
            if (requestTarget.environmentId && requestTarget.cwd) {
              setPendingHistoryReconciliation({
                environmentId: requestTarget.environmentId,
                cwd: requestTarget.cwd,
                result,
              });
            }
          } else if (result.status === "requires_history_reconciliation") {
            setPendingHistoryReconciliation(null);
            onStashRequired?.();
          } else if (
            result.status === "pulled_with_restore_conflicts" ||
            result.status === "pulled_with_restore_failure" ||
            result.status === "update_failed_with_protected_changes"
          ) {
            if (requestTarget.environmentId && requestTarget.cwd) {
              setPendingStashRecovery({
                environmentId: requestTarget.environmentId,
                cwd: requestTarget.cwd,
                title:
                  result.status === "update_failed_with_protected_changes"
                    ? "Update stopped; protected changes remain"
                    : "Branch updated; local changes need attention",
                detail:
                  result.status === "pulled_with_restore_conflicts"
                    ? "Threadlines kept the protected stash because restoring it caused conflicts."
                    : result.detail,
                stashId: result.stashId,
                recoveryRef: result.recoveryRef,
                conflictedPaths:
                  result.status === "pulled_with_restore_failure" ? [] : result.conflictedPaths,
              });
            }
            setPendingHistoryReconciliation(null);
          } else {
            setPendingHistoryReconciliation(null);
          }
          refreshGitCheckout(queryClient, requestTarget);
        },
        () => {
          if (options?.historyReconciliation && isCurrentTarget(requestTarget)) {
            // A failed confirmation may mean HEAD or the upstream moved. Require a fresh probe
            // instead of leaving a stale destructive confirmation available for retry.
            setPendingHistoryReconciliation(null);
            refreshGitCheckout(queryClient, requestTarget);
          }
        },
      );
    },
    [
      cwd,
      environmentId,
      isCurrentTarget,
      kind,
      onStashRequired,
      pullMutation,
      queryClient,
      repositorySafetyReason,
      threadToastData,
    ],
  );

  const run = useCallback(() => {
    if (kind === "stash_and_pull") {
      setStashConfirmationOpen(true);
      return;
    }
    execute();
  }, [execute, kind]);

  const dismissHistoryReconciliation = useCallback(() => setPendingHistoryReconciliation(null), []);
  const dismissAuthFailure = useCallback(() => setAuthFailure(null), []);
  const historyReconciliation =
    pendingHistoryReconciliation && isSameGitPullTarget(pendingHistoryReconciliation, target)
      ? pendingHistoryReconciliation
      : null;
  const stashRecovery =
    pendingStashRecovery && isSameGitPullTarget(pendingStashRecovery, target)
      ? pendingStashRecovery
      : null;

  return {
    target,
    status,
    kind,
    disabledReason,
    isPending: pullMutation.isPending,
    run,
    execute,
    stashConfirmationOpen,
    setStashConfirmationOpen,
    historyReconciliation,
    dismissHistoryReconciliation,
    stashRecovery,
    showStashRecovery: setPendingStashRecovery,
    authFailure,
    dismissAuthFailure,
    isCurrentTarget,
  };
}

/**
 * The questions a pull can ask: stash local changes around it, back up a
 * branch whose upstream was rewritten, look after a stash that couldn't go
 * back, and sign in to the remote again.
 */
export function GitPullDialogs({
  pull,
  stashRecoveryAction,
  onOpenDiff,
}: {
  readonly pull: GitPullFlow;
  /** The stash recovery dialog's second button: where the stash can be looked after. */
  readonly stashRecoveryAction: { readonly label: string; readonly run: () => void };
  /** Opens a conflicted file's diff; without it the dialog only closes. */
  readonly onOpenDiff?: ((filePath: string) => void) | undefined;
}) {
  const { status, stashRecovery, historyReconciliation, authFailure, isPending, disabledReason } =
    pull;
  const changedFileCount = status?.workingTree.files.length ?? 0;
  const behindCount = status?.behindCount ?? 0;
  const firstConflict = stashRecovery?.conflictedPaths[0];
  return (
    <>
      <AlertDialog
        open={pull.stashConfirmationOpen}
        onOpenChange={(open) => {
          if (!isPending) {
            pull.setStashConfirmationOpen(open);
          }
        }}
      >
        <AlertDialogPopup className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Stash, pull, and restore?</AlertDialogTitle>
            <AlertDialogDescription>
              Threadlines will temporarily stash {changedFileCount} changed{" "}
              {changedFileCount === 1 ? "file" : "files"}, including untracked files, fast-forward{" "}
              <span className="font-mono">{status?.refName ?? "the current branch"}</span> by{" "}
              {behindCount} {behindCount === 1 ? "commit" : "commits"}, then restore your staged and
              unstaged changes. Nothing will be committed or pushed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" disabled={isPending} />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              disabled={isPending || disabledReason !== null}
              onClick={() => {
                pull.setStashConfirmationOpen(false);
                pull.execute({ stashLocalChanges: true });
              }}
            >
              Stash, pull &amp; restore
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <Dialog
        open={stashRecovery !== null}
        onOpenChange={(open) => {
          if (!open) {
            pull.showStashRecovery(null);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlertIcon className="size-4 text-amber-500" />
              {stashRecovery?.title ?? "Protected changes need attention"}
            </DialogTitle>
            <DialogDescription>{stashRecovery?.detail}</DialogDescription>
          </DialogHeader>
          {stashRecovery ? (
            <div className="divide-y divide-border border-t border-border px-6 text-sm">
              {stashRecovery.conflictedPaths.length > 0 ? (
                <div className="py-3">
                  <div className="mb-1 text-xs text-muted-foreground">Conflicted files</div>
                  {stashRecovery.conflictedPaths.map((filePath) => (
                    <div key={filePath} className="truncate font-mono text-xs">
                      {filePath}
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="py-3">
                <div className="text-xs text-muted-foreground">Protected stash</div>
                <div className="break-all font-mono text-xs">{stashRecovery.stashId}</div>
              </div>
              {stashRecovery.recoveryRef ? (
                <div className="py-3">
                  <div className="text-xs text-muted-foreground">Recovery ref</div>
                  <div className="break-all font-mono text-xs">{stashRecovery.recoveryRef}</div>
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                pull.showStashRecovery(null);
                stashRecoveryAction.run();
              }}
            >
              {stashRecoveryAction.label}
            </Button>
            {firstConflict !== undefined && onOpenDiff ? (
              <Button
                size="sm"
                onClick={() => {
                  pull.showStashRecovery(null);
                  onOpenDiff(firstConflict);
                }}
              >
                Review conflicts
              </Button>
            ) : (
              <Button size="sm" onClick={() => pull.showStashRecovery(null)}>
                Done
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <AlertDialog
        open={historyReconciliation !== null}
        onOpenChange={(open) => {
          if (!open && !isPending) {
            pull.dismissHistoryReconciliation();
          }
        }}
      >
        <AlertDialogPopup className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlertIcon className="size-4 text-amber-500" />
              Branch histories are unrelated
            </AlertDialogTitle>
            <AlertDialogDescription>
              {historyReconciliation ? (
                <span className="space-y-2">
                  <span className="block">
                    <span className="font-mono">{historyReconciliation.result.upstreamRef}</span> no
                    longer shares commit history with your local{" "}
                    <span className="font-mono">{historyReconciliation.result.refName}</span>. This
                    usually means the upstream branch was force-pushed or recreated.
                  </span>
                  {historyReconciliation.result.equivalentUpstreamCommitSha ? (
                    <span className="block">
                      Threadlines found your current file snapshot in the rewritten upstream at{" "}
                      <span className="font-mono">
                        {historyReconciliation.result.equivalentUpstreamCommitSha.slice(0, 12)}
                      </span>
                      . It can save your local HEAD under a recovery ref, then update the branch to
                      the rewritten upstream.
                    </span>
                  ) : (
                    <span className="block">
                      Threadlines could not match your current file snapshot in the rewritten
                      upstream. Continuing saves your current HEAD under a recovery ref, then
                      replaces the local branch with the upstream version.
                    </span>
                  )}
                  <span className="block">
                    The backup stays local and is never pushed automatically.
                  </span>
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" disabled={isPending} />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={isPending || historyReconciliation === null}
              onClick={() => {
                if (!historyReconciliation || !pull.isCurrentTarget(historyReconciliation)) {
                  return;
                }
                pull.execute({
                  historyReconciliation: {
                    refName: historyReconciliation.result.refName,
                    upstreamRef: historyReconciliation.result.upstreamRef,
                    expectedLocalSha: historyReconciliation.result.localSha,
                    expectedUpstreamSha: historyReconciliation.result.upstreamSha,
                  },
                });
              }}
            >
              Back up local &amp; use upstream
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <GitAuthRemediationDialog
        open={authFailure !== null}
        onOpenChange={(open) => {
          if (!open) {
            pull.dismissAuthFailure();
          }
        }}
        environmentId={pull.target.environmentId}
        gitCwd={pull.target.cwd}
        failure={authFailure}
        onResolved={pull.run}
      />
    </>
  );
}
