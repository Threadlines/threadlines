import type { ContextMenuItem, EnvironmentId, ScopedThreadRef } from "@threadlines/contracts";
import { useIsMutating } from "@tanstack/react-query";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

import { useTouchHoldMenu } from "../../hooks/useTouchHoldMenu";
import { checkoutChangingGitMutationFilters } from "../../lib/gitReactQuery";
import { useGitStatus } from "../../lib/gitStatusState";
import { readLocalApi } from "../../localApi";
import type { WorkingTreeChanges } from "../ChatView.logic";
import { GitPullDialogs, isSameGitPullTarget, useGitPull } from "../source-control/GitPullFlow";
import { useParentRepositoryApproval } from "../source-control/parentRepositoryApproval";
import {
  formatCommitCount,
  type SourceControlPullKind,
} from "../source-control/SourceControlPanel.logic";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Reads the change count out loud, naming what clicking it does. */
export function formatSourceChangesLabel(input: {
  readonly workingTreeChanges: WorkingTreeChanges | null;
  readonly remoteBehindCount: number | null;
}): string {
  const parts: string[] = [];
  const changes = input.workingTreeChanges;
  if (changes) {
    parts.push(
      changes.insertions > 0 || changes.deletions > 0
        ? `Uncommitted changes: ${changes.insertions} added, ${changes.deletions} removed.`
        : `Uncommitted changes in ${formatFileCount(changes.fileCount)}.`,
    );
  }
  if (input.remoteBehindCount !== null) {
    parts.push(`${formatCommitCount(input.remoteBehindCount)} behind the remote.`);
  }
  parts.push("Open the Source tab.");
  return parts.join(" ");
}

function formatFileCount(count: number): string {
  if (count === 0) return "the working tree";
  return count === 1 ? "1 file" : `${count} files`;
}

export type HeaderSourceMenuAction = "pull" | "open-source-tab";

/**
 * The right-click menu on the behind count: pull here, or open the Source
 * tab. The pull reads as the Source tab's button does, and says why when it
 * can't run, since a native menu has no tooltip to explain a grayed item.
 */
export function buildHeaderSourceMenuItems(input: {
  readonly behindCount: number;
  readonly pullKind: SourceControlPullKind;
  readonly pullDisabledReason: string | null;
}): ContextMenuItem<HeaderSourceMenuAction>[] {
  const commits = formatCommitCount(input.behindCount);
  const pullLabel =
    input.pullDisabledReason !== null
      ? `Can't pull: ${input.pullDisabledReason.replace(/\.$/u, "")}`
      : input.pullKind === "stash_and_pull"
        ? `Stash & pull ${commits}…`
        : input.pullKind === "resolve_divergence"
          ? "Resolve diverged branch"
          : `Pull ${commits}`;
  return [
    { id: "pull", label: pullLabel, disabled: input.pullDisabledReason !== null },
    { id: "open-source-tab", label: "Open Source tab", separatorBefore: true },
  ];
}

/**
 * The chat header's change count: uncommitted lines and how far the branch is
 * behind its remote. Clicking opens the Source tab; right-clicking (or holding
 * on a touch screen) offers to pull without opening it. It stays mounted while
 * the thread has source control so a pull's follow-up questions outlive the
 * count, which goes away once the branch catches up.
 */
export function HeaderSourceChanges({
  environmentId,
  cwd,
  threadRef,
  workingTreeChanges,
  remoteBehindCount,
  onOpenSourceTab,
}: {
  readonly environmentId: EnvironmentId;
  /** The checkout the counts are read from, which is also where a pull runs. */
  readonly cwd: string;
  readonly threadRef: ScopedThreadRef | null;
  readonly workingTreeChanges: WorkingTreeChanges | null;
  readonly remoteBehindCount: number | null;
  readonly onOpenSourceTab: () => void;
}) {
  const target = useMemo(() => ({ environmentId, cwd }), [cwd, environmentId]);
  const status = useGitStatus(target).data;
  const isBusy =
    useIsMutating(
      useMemo(() => checkoutChangingGitMutationFilters(environmentId, cwd), [cwd, environmentId]),
    ) > 0;
  const threadToastData = useMemo(() => (threadRef ? { threadRef } : undefined), [threadRef]);
  const parentRepositoryApproval = useParentRepositoryApproval({ environmentId, cwd, status });
  const pull = useGitPull({
    target,
    status,
    isBusy,
    // A repository found above the project folder is changed only after the
    // user agrees to it, which the Source tab asks.
    repositorySafetyReason: parentRepositoryApproval.confirmationRequired
      ? "Confirm the parent repository in the Source tab first."
      : null,
    threadToastData,
  });

  // The menu stays open while the user decides; read the checkout as it is
  // when they pick, not as it was when the menu opened. A pick made after the
  // header moved to another checkout, or went away, does nothing.
  const latest = useRef({ pull, remoteBehindCount, onOpenSourceTab, mounted: false });
  useLayoutEffect(() => {
    latest.current = { pull, remoteBehindCount, onOpenSourceTab, mounted: true };
  });
  useLayoutEffect(
    () => () => {
      latest.current.mounted = false;
    },
    [],
  );
  const openMenu = useCallback((position: { readonly x: number; readonly y: number }) => {
    const api = readLocalApi();
    const { pull: opened, remoteBehindCount: behindCount } = latest.current;
    if (!api || behindCount === null) {
      return;
    }
    void api.contextMenu
      .show(
        buildHeaderSourceMenuItems({
          behindCount,
          pullKind: opened.kind,
          pullDisabledReason: opened.disabledReason,
        }),
        position,
      )
      .then((clicked) => {
        const current = latest.current;
        if (!current.mounted || !isSameGitPullTarget(current.pull.target, opened.target)) {
          return;
        }
        if (clicked === "pull") {
          if (current.pull.disabledReason === null) {
            current.pull.run();
          }
        } else if (clicked === "open-source-tab") {
          current.onOpenSourceTab();
        }
      });
  }, []);
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      // The keyboard's menu key reports no pointer: open below the button.
      if (event.clientX === 0 && event.clientY === 0) {
        const rect = event.currentTarget.getBoundingClientRect();
        openMenu({ x: rect.left, y: rect.bottom });
        return;
      }
      openMenu({ x: event.clientX, y: event.clientY });
    },
    [openMenu],
  );
  const touchHold = useTouchHoldMenu<HTMLButtonElement>({
    open: openMenu,
    onContextMenu: handleContextMenu,
  });

  const dialogs = (
    <GitPullDialogs
      pull={pull}
      stashRecoveryAction={{ label: "Open Source tab", run: onOpenSourceTab }}
    />
  );
  if (workingTreeChanges === null && remoteBehindCount === null) {
    return dialogs;
  }
  return (
    <>
      {/* Hidden on a narrow header, where the room goes to the title; the
          Source tab still lists every count. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="shrink-0 gap-1 px-1.5 font-mono text-[10.5px] @max-xl/header-actions:hidden"
              onClick={onOpenSourceTab}
              aria-label={formatSourceChangesLabel({ workingTreeChanges, remoteBehindCount })}
              data-header-source-changes="true"
              // Only a branch with something to pull has a menu; elsewhere a
              // right-click is left alone.
              {...(remoteBehindCount !== null ? touchHold : {})}
            />
          }
        >
          {workingTreeChanges ? (
            workingTreeChanges.insertions > 0 || workingTreeChanges.deletions > 0 ? (
              <>
                <span className="text-success">+{workingTreeChanges.insertions}</span>
                <span className="text-destructive">−{workingTreeChanges.deletions}</span>
              </>
            ) : (
              <span className="font-sans text-[11px] text-muted-foreground">
                {formatFileCount(workingTreeChanges.fileCount)}
              </span>
            )
          ) : null}
          {/* Deliberately hue-less: the arrow is the signal, and a third
              color beside the green/red counts would crowd them. */}
          {remoteBehindCount !== null ? (
            <span className="text-muted-foreground">↓{remoteBehindCount}</span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {workingTreeChanges ? "Uncommitted changes. " : null}Open the Source tab.
          {remoteBehindCount !== null ? (
            <div className="text-muted-foreground">
              {formatCommitCount(remoteBehindCount)} behind the remote. Right-click to pull.
            </div>
          ) : null}
        </TooltipPopup>
      </Tooltip>
      {dialogs}
    </>
  );
}
