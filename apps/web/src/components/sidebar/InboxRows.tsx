import {
  ArchiveIcon,
  CheckIcon,
  CloudIcon,
  PinIcon,
  TerminalIcon,
  Undo2Icon,
  GitBranchIcon,
} from "lucide-react";
import React, { memo, useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ScopedThreadRef } from "@threadlines/contracts";
import { scopedThreadKey, scopeProjectRef, scopeThreadRef } from "@threadlines/client-runtime";
import { resolveThreadWorkingCwd } from "@threadlines/shared/threadCwd";
import type { SidebarThreadSummary } from "../../types";
import { cn } from "../../lib/utils";
import { useGitStatus } from "../../lib/gitStatusState";
import { selectProjectByRef, useStore } from "../../store";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { formatRelativeTimeLabel, formatWorkingDurationLabel } from "../../timestampFormat";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import {
  ChangeRequestStatusIcon,
  prStatusIndicator,
  resolveThreadPr,
  terminalStatusFromRunningIds,
} from "../ThreadStatusIndicators";
import { inboxStatusWord, type ThreadStatusPill } from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { ThreadHoverCard } from "./ThreadHoverCard";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const ROW_ITEM_CLASS_NAME = "group/thread-row relative w-full";

export const ROW_SURFACE_CLASS_NAME =
  "relative w-full cursor-pointer select-none text-left outline-hidden focus-ring focus-visible:ring-inset";

/** Hover and selection are colour shifts only — nothing moves under the cursor. */
export function resolveRowSurfaceTone(input: { isActive: boolean; isSelected: boolean }): string {
  if (input.isSelected) {
    return "bg-primary/15 dark:bg-primary/22 hover:bg-primary/19 dark:hover:bg-primary/28";
  }
  if (input.isActive) {
    return "bg-sidebar-accent";
  }
  return "hover:bg-sidebar-accent/60";
}

/**
 * The fill of a hovered row, as static classes: the floating actions only show
 * while their row is hovered (or holds focus), so their backdrop can restate
 * the row's hover tone and composite to the identical colour. Must stay in
 * lockstep with {@link resolveRowSurfaceTone}.
 */
function resolveRowHoverFillTone(input: { isActive: boolean; isSelected: boolean }): string {
  if (input.isSelected) {
    return "bg-primary/19 dark:bg-primary/28";
  }
  if (input.isActive) {
    return "bg-sidebar-accent";
  }
  return "bg-sidebar-accent/60";
}

/**
 * Actions float in beside the time rather than reserving space or covering it:
 * anchored just left of the meta text, painted over the row's flexible middle
 * content. Nothing shifts, the time and a live "working · 4m" stay put, and at
 * rest the row gives up no width. Touch has no hover, so there they simply sit
 * in flow beside the time.
 */
const ROW_ACTIONS_CLASS_NAME =
  "flex shrink-0 items-center gap-0.5 sm:pointer-events-none sm:absolute sm:top-1/2 sm:right-full sm:-translate-y-1/2 sm:pl-4 sm:pr-1 sm:opacity-0 sm:transition-opacity sm:duration-150 sm:[mask-image:linear-gradient(to_right,transparent,black_16px)] sm:group-hover/thread-row:pointer-events-auto sm:group-hover/thread-row:opacity-100 sm:group-focus-within/thread-row:pointer-events-auto sm:group-focus-within/thread-row:opacity-100";

/** The slot a row's first line gives to the time, and to the actions. */
const ROW_META_SLOT_CLASS_NAME =
  "relative ml-auto flex flex-none items-center gap-1.5 whitespace-nowrap";

/** `relative` lifts the buttons above their own backdrop layers. */
export const ROW_ACTION_BUTTON_CLASS_NAME =
  "relative inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors pointer-coarse:size-7 hover:text-foreground focus-ring";

/**
 * The floating container for a row's hover actions. The two backdrop layers
 * rebuild the hovered row's exact colour (opaque sidebar base + the row's own
 * hover fill), and the container's mask melts their leading edge so covered
 * text fades out instead of clipping against a seam.
 */
function RowFloatingActions(props: {
  isActive: boolean;
  isSelected: boolean;
  /** For click-initiated states (archive confirm) that must not fade away. */
  alwaysVisible?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        ROW_ACTIONS_CLASS_NAME,
        props.alwaysVisible === true && "sm:pointer-events-auto sm:opacity-100",
      )}
    >
      <span aria-hidden="true" className="absolute inset-0 hidden bg-sidebar sm:block" />
      <span
        aria-hidden="true"
        className={cn("absolute inset-0 hidden sm:block", resolveRowHoverFillTone(props))}
      />
      {props.children}
    </div>
  );
}

/**
 * The thread's own project. Grouped projects put threads from several checkouts
 * under one name, so the row asks for its own rather than the group's -- the
 * favicon, its monogram fallback, and the git status all depend on the right
 * one.
 */
function useThreadProject(thread: SidebarThreadSummary): { cwd: string; name: string } | null {
  return useStore(
    useShallow(
      useMemo(
        () => (state: import("../../store").AppState) => {
          const project = selectProjectByRef(
            state,
            scopeProjectRef(thread.environmentId, thread.projectId),
          );
          return project ? { cwd: project.cwd, name: project.name } : null;
        },
        [thread.environmentId, thread.projectId],
      ),
    ),
  );
}

/**
 * Which machine a thread is running on, when that is a question worth asking.
 *
 * The cloud alone marks anything not on this device: the row's meta strip is
 * contested space, and the machine's name lives one hover away in the tooltip
 * and the hover card, which use the same cloud glyph for the same fact.
 */
function ThreadEnvironmentBadge(props: { thread: SidebarThreadSummary }) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const runtimeLabel = useSavedEnvironmentRuntimeStore(
    (state) => state.byId[props.thread.environmentId]?.descriptor?.label ?? null,
  );
  const savedLabel = useSavedEnvironmentRegistryStore(
    (state) => state.byId[props.thread.environmentId]?.label ?? null,
  );
  if (primaryEnvironmentId === null || props.thread.environmentId === primaryEnvironmentId) {
    return null;
  }

  const label = runtimeLabel ?? savedLabel ?? "Remote";
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span aria-label={label} className="inline-flex items-center justify-center" />}
      >
        <CloudIcon className="block size-3 text-muted-foreground/50" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function formatDiffCount(count: number): string {
  return count >= 1_000 ? `${Math.round(count / 100) / 10}k` : `${count}`;
}

/**
 * The elapsed half of "working · 4m". Its own component so the second-by-second
 * tick re-renders one label instead of every row in the list.
 */
function ThreadElapsedLabel({ startedAt }: { startedAt: string }) {
  const nowMs = useRelativeTimeTick(1_000);
  return <>{formatWorkingDurationLabel(startedAt, nowMs)}</>;
}

function ThreadProviderGlyph({ thread }: { thread: SidebarThreadSummary }) {
  const provider = thread.session?.provider;
  const Icon = provider ? PROVIDER_ICON_BY_PROVIDER[provider] : undefined;
  if (!Icon) {
    return null;
  }
  return <Icon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground/45" />;
}

export interface InboxThreadRowProps {
  thread: SidebarThreadSummary;
  status: ThreadStatusPill | null;
  /** Null while the list is scoped to one project: the label is implied. */
  projectLabel: string | null;
  isActive: boolean;
  jumpLabel: string | null;
  /** False while the thread is moving or blocked: live work can't be waved away. */
  canMarkDone: boolean;
  orderedThreadKeys: readonly string[];
  renamingThreadKey: string | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  renamingInputRef: React.RefObject<HTMLInputElement | null>;
  renamingCommittedRef: React.RefObject<boolean>;
  handleThreadClick: (
    event: React.MouseEvent,
    threadRef: ScopedThreadRef,
    orderedThreadKeys: readonly string[],
  ) => void;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (
    threadRef: ScopedThreadRef,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelRename: () => void;
  markThreadDone: (threadKey: string) => void;
  openPrLink: (event: React.MouseEvent<HTMLElement>, prUrl: string) => void;
}

/**
 * One live thread in the inbox: two lines, ~46px, no card.
 *
 * Line one carries identity and state (dot, title, status); line two carries
 * where the work lives (project, branch) and what it has produced (diffstat,
 * provider). The row's actions float in beside the status on hover, covering
 * only the line's truncatable middle — never the status, and never blank
 * reserved width.
 */
export const InboxThreadRow = memo(function InboxThreadRow(props: InboxThreadRowProps) {
  const {
    thread,
    status,
    projectLabel,
    isActive,
    jumpLabel,
    canMarkDone,
    orderedThreadKeys,
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    renamingInputRef,
    renamingCommittedRef,
    handleThreadClick,
    navigateToThread,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    commitRename,
    cancelRename,
    markThreadDone,
    openPrLink,
  } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadKey, threadRef).runningTerminalIds,
  );
  const threadProject = useThreadProject(thread);
  const gitCwd = resolveThreadWorkingCwd({
    projectCwd: threadProject?.cwd ?? null,
    worktreePath: thread.worktreePath,
    effectiveCwd: thread.effectiveCwd,
  });
  // Only rows with a pinned branch ask: the git status feeds the change
  // request badge alone, and that badge never renders without a pinned branch.
  const gitStatus = useGitStatus({
    environmentId: thread.environmentId,
    cwd: thread.branch !== null ? gitCwd : null,
  });
  // The +/- is the thread's own running total, summed by the server across the
  // turns it has taken -- not the checkout's working tree, which several
  // threads can share and which would print the same numbers on each of them.
  // Nothing to report reads as nothing shown, so a thread that has not touched
  // a file yet stays quiet rather than claiming a clean tree.
  const diffStat = thread.cumulativeDiffStat;
  const showDiffStat = diffStat !== null && (diffStat.additions > 0 || diffStat.deletions > 0);
  // Both the branch name and the change request badge key off the branch the
  // thread pinned, never the checkout's current ref: a checkout is shared by
  // every thread in it, so its ref (and that ref's change request) says
  // nothing about this thread. The hover card is where the current ref gets
  // its say.
  const pr = resolveThreadPr(thread.branch, gitStatus.data);
  const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const isPinned = thread.pinnedAt !== null;
  const isRenaming = renamingThreadKey === threadKey;
  const statusWord = inboxStatusWord(status);
  const isInFlight = status?.label === "Working" || status?.label === "Starting";
  // A follow-up flips the pill to "Starting" before the new turn's row lands
  // in the projection, so for a beat `latestTurn` is still the previous,
  // finished turn -- its clock must not run under the new label. That is the
  // only stale window: once work is under way the pill and the timestamps
  // describe the same turn, and mid-turn session wobbles (tool waits,
  // reconnects) must not blank the timer, so "Working" trusts them as-is.
  const inFlightTurn =
    status?.label === "Starting" && thread.latestTurn?.state !== "running"
      ? null
      : thread.latestTurn;
  const inFlightStartedAt = inFlightTurn
    ? (inFlightTurn.startedAt ?? inFlightTurn.requestedAt)
    : null;
  // "Background" is a wait, not work: the turn has settled and a provider
  // task will start the thread back up on its own. Its clock anchors to the
  // turn's settle time -- the moment the waiting began. The pill only exists
  // while the latest turn is settled, so completedAt is always there.
  const isWaitingOnTasks = status?.label === "Background";
  const liveClockStartedAt = isInFlight
    ? inFlightStartedAt
    : isWaitingOnTasks
      ? (thread.latestTurn?.completedAt ?? null)
      : null;
  // A completion nobody has looked at yet keeps the title bright until the
  // thread is opened.
  const isUnseen = status?.label === "Completed";
  // Line one has one hard rule: the status slot on the right always fits
  // whole, and the left cluster yields to it in a fixed order. The branch goes
  // first and goes completely -- half a branch name is worse than none, and a
  // row that is *doing* something has more to say than which ref it is on.
  const hasStatusLabel = statusWord !== null || isInFlight || isWaitingOnTasks;
  const showBranch = thread.branch !== null && !hasStatusLabel;

  const handleRowClick = useCallback(
    (event: React.MouseEvent) => {
      handleThreadClick(event, threadRef, orderedThreadKeys);
    },
    [handleThreadClick, orderedThreadKeys, threadRef],
  );
  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      navigateToThread(threadRef);
    },
    [navigateToThread, threadRef],
  );
  const handleRowContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const hasSelection = useThreadSelectionStore.getState().hasSelection();
      if (hasSelection && isSelected) {
        void handleMultiSelectContextMenu({ x: event.clientX, y: event.clientY });
        return;
      }

      if (hasSelection) {
        clearSelection();
      }
      void handleThreadContextMenu(threadRef, { x: event.clientX, y: event.clientY });
    },
    [clearSelection, handleMultiSelectContextMenu, handleThreadContextMenu, isSelected, threadRef],
  );
  const handlePrClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!prStatus) return;
      openPrLink(event, prStatus.url);
    },
    [openPrLink, prStatus],
  );
  const handleRenameInputRef = useCallback(
    (element: HTMLInputElement | null) => {
      if (element && renamingInputRef.current !== element) {
        renamingInputRef.current = element;
        element.focus();
        element.select();
      }
    },
    [renamingInputRef],
  );
  const handleRenameInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setRenamingTitle(event.target.value);
    },
    [setRenamingTitle],
  );
  const handleRenameInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        renamingCommittedRef.current = true;
        void commitRename(threadRef, renamingTitle, thread.title);
      } else if (event.key === "Escape") {
        event.preventDefault();
        renamingCommittedRef.current = true;
        cancelRename();
      }
    },
    [cancelRename, commitRename, renamingCommittedRef, renamingTitle, thread.title, threadRef],
  );
  const handleRenameInputBlur = useCallback(() => {
    if (!renamingCommittedRef.current) {
      void commitRename(threadRef, renamingTitle, thread.title);
    }
  }, [commitRename, renamingCommittedRef, renamingTitle, thread.title, threadRef]);
  const handleRenameInputClick = useCallback((event: React.MouseEvent<HTMLInputElement>) => {
    event.stopPropagation();
  }, []);
  const stopPropagationOnPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
    },
    [],
  );
  const handleMarkDoneClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      markThreadDone(threadKey);
    },
    [markThreadDone, threadKey],
  );

  return (
    <li className={ROW_ITEM_CLASS_NAME} data-thread-item>
      <ThreadHoverCard thread={thread} status={status}>
        <div
          role="button"
          tabIndex={0}
          data-testid={`thread-row-${thread.id}`}
          data-active={isActive ? "true" : undefined}
          className={cn(
            ROW_SURFACE_CLASS_NAME,
            "px-3 pt-1.5 pb-2",
            resolveRowSurfaceTone({ isActive, isSelected }),
          )}
          onClick={handleRowClick}
          onKeyDown={handleRowKeyDown}
          onContextMenu={handleRowContextMenu}
        >
          {/* Line one: where the work lives, and what it is doing. */}
          <div
            data-testid={`thread-detail-${thread.id}`}
            className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground/45"
          >
            {status ? (
              <span
                aria-label={status.label}
                className={cn("size-[7px] shrink-0 rounded-full", status.dotClass)}
              />
            ) : null}
            {/* Pinned is persistent state, not activity: it stays visible even
                while the status dot occupies the leading slot. */}
            {isPinned ? (
              <span
                aria-label="Pinned thread"
                className="inline-flex shrink-0 items-center justify-center text-muted-foreground/50"
              >
                <PinIcon className="size-2.5" />
              </span>
            ) : null}
            {threadProject ? (
              <ProjectFavicon
                cwd={threadProject.cwd}
                environmentId={thread.environmentId}
                name={threadProject.name}
                className="size-3 shrink-0"
              />
            ) : null}
            {projectLabel ? (
              <span className="min-w-0 truncate text-muted-foreground/60">{projectLabel}</span>
            ) : null}
            {showBranch ? (
              <span className="flex min-w-0 items-center gap-1">
                <GitBranchIcon aria-hidden className="size-2.5 shrink-0 opacity-60" />
                <span className="min-w-0 truncate font-mono text-[10px]">{thread.branch}</span>
              </span>
            ) : null}
            <span className={ROW_META_SLOT_CLASS_NAME}>
              <span
                data-testid={`thread-meta-${thread.id}`}
                className={cn(
                  "shrink-0 font-mono text-[11px] leading-none tabular-nums",
                  hasStatusLabel
                    ? (status?.colorClass ?? "text-muted-foreground/50")
                    : "text-muted-foreground/50",
                )}
              >
                {jumpLabel ? (
                  <span className="inline-flex h-4 items-center rounded-full border border-border/80 bg-background/90 px-1.5 text-[10px] font-medium tracking-tight text-foreground">
                    {jumpLabel}
                  </span>
                ) : statusWord !== null ? (
                  statusWord
                ) : isInFlight || isWaitingOnTasks ? (
                  <>
                    {isWaitingOnTasks
                      ? "waiting"
                      : status?.label === "Starting"
                        ? "starting"
                        : "working"}
                    {liveClockStartedAt ? (
                      <>
                        {" · "}
                        <ThreadElapsedLabel startedAt={liveClockStartedAt} />
                      </>
                    ) : null}
                  </>
                ) : (
                  formatRelativeTimeLabel(
                    thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
                  )
                )}
              </span>
              {/* Wrap up is the only hover action; pin lives in the row's
                  context menu so a cursor sweeping the row can't hit it. The
                  wrapper only mounts alongside the button -- empty, it would
                  still paint its backdrop smear over the timestamp. */}
              {canMarkDone ? (
                <RowFloatingActions isActive={isActive} isSelected={isSelected}>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          data-thread-selection-safe
                          data-testid={`thread-done-${thread.id}`}
                          aria-label={`Wrap up ${thread.title}`}
                          className={ROW_ACTION_BUTTON_CLASS_NAME}
                          onPointerDown={stopPropagationOnPointerDown}
                          onClick={handleMarkDoneClick}
                        >
                          <CheckIcon className="size-3.5" />
                        </button>
                      }
                    />
                    <TooltipPopup side="top">Wrap up</TooltipPopup>
                  </Tooltip>
                </RowFloatingActions>
              ) : null}
            </span>
          </div>
          {/* Line two: which thread, and what it has produced. */}
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
            {isRenaming ? (
              <input
                ref={handleRenameInputRef}
                className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-base outline-none sm:text-xs"
                value={renamingTitle}
                onChange={handleRenameInputChange}
                onKeyDown={handleRenameInputKeyDown}
                onBlur={handleRenameInputBlur}
                onClick={handleRenameInputClick}
              />
            ) : (
              // No tooltip on the title: the hover card already carries the
              // full one, and two popups racing the same hover is the bug.
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs font-medium",
                  isUnseen ? "text-foreground" : "text-foreground/90",
                )}
                data-testid={`thread-title-${thread.id}`}
              >
                {thread.title}
              </span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {terminalStatus ? (
                <span
                  role="img"
                  aria-label={terminalStatus.label}
                  className={cn(
                    "inline-flex items-center justify-center",
                    terminalStatus.colorClass,
                  )}
                >
                  <TerminalIcon
                    className={cn("size-3", terminalStatus.pulse && "animate-status-pulse")}
                  />
                </span>
              ) : null}
              <ThreadEnvironmentBadge thread={thread} />
              {prStatus ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        data-thread-selection-safe
                        aria-label={prStatus.tooltip}
                        className={cn(
                          "inline-flex cursor-pointer items-center justify-center rounded-sm outline-hidden focus-ring",
                          prStatus.colorClass,
                        )}
                        onPointerDown={stopPropagationOnPointerDown}
                        onClick={handlePrClick}
                      >
                        <ChangeRequestStatusIcon className="size-3" />
                      </button>
                    }
                  />
                  <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
                </Tooltip>
              ) : null}
              {showDiffStat && diffStat ? (
                <span className="font-mono text-[10px] leading-none">
                  <span className="text-success">+{formatDiffCount(diffStat.additions)}</span>
                  <span className="ps-1 text-destructive">
                    −{formatDiffCount(diffStat.deletions)}
                  </span>
                </span>
              ) : null}
              <ThreadProviderGlyph thread={thread} />
            </span>
          </div>
        </div>
      </ThreadHoverCard>
    </li>
  );
});

export interface InboxDoneRowProps {
  thread: SidebarThreadSummary;
  projectLabel: string | null;
  doneAt: string | null;
  isActive: boolean;
  appSettingsConfirmThreadArchive: boolean;
  confirmingArchiveThreadKey: string | null;
  setConfirmingArchiveThreadKey: React.Dispatch<React.SetStateAction<string | null>>;
  confirmArchiveButtonRefs: React.RefObject<Map<string, HTMLButtonElement>>;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
  ) => Promise<void>;
  reopenThread: (threadKey: string) => void;
  attemptArchiveThread: (threadRef: ScopedThreadRef) => Promise<void>;
}

/**
 * A settled thread in the Done tail: one line, still readable. Flattening the
 * whole tail to one grey turns it into texture — the section header already
 * says done, so each row keeps its name and its project.
 */
export const InboxDoneRow = memo(function InboxDoneRow(props: InboxDoneRowProps) {
  const {
    thread,
    projectLabel,
    doneAt,
    isActive,
    appSettingsConfirmThreadArchive,
    confirmingArchiveThreadKey,
    setConfirmingArchiveThreadKey,
    confirmArchiveButtonRefs,
    navigateToThread,
    handleThreadContextMenu,
    reopenThread,
    attemptArchiveThread,
  } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const threadProject = useThreadProject(thread);
  // Wrapping a thread settles the conversation, not its terminals: a dev
  // server started there keeps running, and this is the icon that finds it.
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadKey, threadRef).runningTerminalIds,
  );
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);

  const handleClick = useCallback(() => {
    navigateToThread(threadRef);
  }, [navigateToThread, threadRef]);
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      navigateToThread(threadRef);
    },
    [navigateToThread, threadRef],
  );
  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      void handleThreadContextMenu(threadRef, { x: event.clientX, y: event.clientY });
    },
    [handleThreadContextMenu, threadRef],
  );
  const handleReopenClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      reopenThread(threadKey);
    },
    [reopenThread, threadKey],
  );
  const stopPropagationOnPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
    },
    [],
  );
  const clearConfirmingArchive = useCallback(() => {
    setConfirmingArchiveThreadKey((current) => (current === threadKey ? null : current));
  }, [setConfirmingArchiveThreadKey, threadKey]);
  const handleMouseLeave = useCallback(() => {
    clearConfirmingArchive();
  }, [clearConfirmingArchive]);
  const handleBlurCapture = useCallback(
    (event: React.FocusEvent<HTMLLIElement>) => {
      const currentTarget = event.currentTarget;
      requestAnimationFrame(() => {
        if (currentTarget.contains(document.activeElement)) {
          return;
        }
        clearConfirmingArchive();
      });
    },
    [clearConfirmingArchive],
  );
  const handleConfirmArchiveRef = useCallback(
    (element: HTMLButtonElement | null) => {
      if (element) {
        confirmArchiveButtonRefs.current.set(threadKey, element);
      } else {
        confirmArchiveButtonRefs.current.delete(threadKey);
      }
    },
    [confirmArchiveButtonRefs, threadKey],
  );
  const handleConfirmArchiveClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      clearConfirmingArchive();
      void attemptArchiveThread(threadRef);
    },
    [attemptArchiveThread, clearConfirmingArchive, threadRef],
  );
  const handleStartArchiveConfirmation = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setConfirmingArchiveThreadKey(threadKey);
      requestAnimationFrame(() => {
        confirmArchiveButtonRefs.current.get(threadKey)?.focus();
      });
    },
    [confirmArchiveButtonRefs, setConfirmingArchiveThreadKey, threadKey],
  );
  const handleArchiveImmediateClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      void attemptArchiveThread(threadRef);
    },
    [attemptArchiveThread, threadRef],
  );
  const isConfirmingArchive = confirmingArchiveThreadKey === threadKey;

  return (
    <li
      className={ROW_ITEM_CLASS_NAME}
      data-thread-item
      onMouseLeave={handleMouseLeave}
      onBlurCapture={handleBlurCapture}
    >
      {/* Same card the live rows carry: a wrapped thread's detail is no less
          worth a hover, and status={null} reads as its idle state. */}
      <ThreadHoverCard thread={thread} status={null}>
        <div
          role="button"
          tabIndex={0}
          data-testid={`done-row-${thread.id}`}
          className={cn(
            ROW_SURFACE_CLASS_NAME,
            "flex items-center gap-2 px-3 py-1.5",
            resolveRowSurfaceTone({ isActive, isSelected: false }),
          )}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onContextMenu={handleContextMenu}
        >
          {/* The project leads the row as an icon, not a name: a one-line row
              has one thing worth reading whole, and spelling out the project
              on every row cost the title half its width to repeat what a glyph
              says at a glance. The name still lives in the hover card, and in
              the accessible label here. */}
          {projectLabel && threadProject ? (
            <span
              role="img"
              aria-label={projectLabel}
              className="inline-flex shrink-0 items-center opacity-70"
            >
              <ProjectFavicon
                cwd={threadProject.cwd}
                environmentId={thread.environmentId}
                name={threadProject.name}
                className="size-3.5 shrink-0"
              />
            </span>
          ) : null}
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            data-testid={`done-title-${thread.id}`}
          >
            {thread.title}
          </span>
          <span className={ROW_META_SLOT_CLASS_NAME}>
            <ThreadEnvironmentBadge thread={thread} />
            {terminalStatus ? (
              <span
                role="img"
                aria-label={terminalStatus.label}
                className={cn("inline-flex items-center justify-center", terminalStatus.colorClass)}
              >
                <TerminalIcon
                  className={cn("size-3", terminalStatus.pulse && "animate-status-pulse")}
                />
              </span>
            ) : null}
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/45">
              {doneAt ? formatRelativeTimeLabel(doneAt) : null}
            </span>
            {isConfirmingArchive ? (
              <RowFloatingActions isActive={isActive} isSelected={false} alwaysVisible>
                <button
                  ref={handleConfirmArchiveRef}
                  type="button"
                  data-thread-selection-safe
                  data-testid={`thread-archive-confirm-${thread.id}`}
                  aria-label={`Confirm archive ${thread.title}`}
                  className="relative inline-flex h-5 cursor-pointer items-center rounded-full bg-destructive/12 px-2 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/18 focus-ring"
                  onPointerDown={stopPropagationOnPointerDown}
                  onClick={handleConfirmArchiveClick}
                >
                  Confirm
                </button>
              </RowFloatingActions>
            ) : (
              // A done thread is settled by definition, so archive is always
              // available here -- the "running" guard the live rows needed is
              // exactly the state that keeps a thread out of this list.
              <RowFloatingActions isActive={isActive} isSelected={false}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        data-thread-selection-safe
                        data-testid={`done-reopen-${thread.id}`}
                        aria-label={`Reopen ${thread.title}`}
                        className={ROW_ACTION_BUTTON_CLASS_NAME}
                        onPointerDown={stopPropagationOnPointerDown}
                        onClick={handleReopenClick}
                      >
                        <Undo2Icon className="size-3.5" />
                      </button>
                    }
                  />
                  <TooltipPopup side="top">Reopen</TooltipPopup>
                </Tooltip>
                {appSettingsConfirmThreadArchive ? (
                  <button
                    type="button"
                    data-thread-selection-safe
                    data-testid={`thread-archive-${thread.id}`}
                    aria-label={`Archive ${thread.title}`}
                    className={ROW_ACTION_BUTTON_CLASS_NAME}
                    onPointerDown={stopPropagationOnPointerDown}
                    onClick={handleStartArchiveConfirmation}
                  >
                    <ArchiveIcon className="size-3.5" />
                  </button>
                ) : (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          data-thread-selection-safe
                          data-testid={`thread-archive-${thread.id}`}
                          aria-label={`Archive ${thread.title}`}
                          className={ROW_ACTION_BUTTON_CLASS_NAME}
                          onPointerDown={stopPropagationOnPointerDown}
                          onClick={handleArchiveImmediateClick}
                        >
                          <ArchiveIcon className="size-3.5" />
                        </button>
                      }
                    />
                    <TooltipPopup side="top">Archive</TooltipPopup>
                  </Tooltip>
                )}
              </RowFloatingActions>
            )}
          </span>
        </div>
      </ThreadHoverCard>
    </li>
  );
});
