import {
  ArchiveIcon,
  CheckIcon,
  CloudIcon,
  PinIcon,
  PinOffIcon,
  TerminalIcon,
  Undo2Icon,
} from "lucide-react";
import React, { memo, useCallback, useMemo } from "react";
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
import { formatElapsedDurationLabel, formatRelativeTimeLabel } from "../../timestampFormat";
import { resolveWorkingTreeDiffStat } from "../ChatView.logic";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import {
  ChangeRequestStatusIcon,
  prStatusIndicator,
  resolveThreadPr,
  terminalStatusFromRunningIds,
} from "../ThreadStatusIndicators";
import { inboxStatusWord, type ThreadStatusPill } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const ROW_ITEM_CLASS_NAME = "group/thread-row relative w-full";

const ROW_SURFACE_CLASS_NAME =
  "relative w-full cursor-pointer select-none text-left outline-hidden focus-ring focus-visible:ring-inset";

/** Hover and selection are colour shifts only — nothing moves under the cursor. */
function resolveRowSurfaceTone(input: { isActive: boolean; isSelected: boolean }): string {
  if (input.isSelected) {
    return "bg-primary/15 dark:bg-primary/22 hover:bg-primary/19 dark:hover:bg-primary/28";
  }
  if (input.isActive) {
    return "bg-sidebar-accent";
  }
  return "hover:bg-sidebar-accent/60";
}

/**
 * The hover cluster sits on top of the row's own text, so it carries the
 * sidebar surface with it: without an opaque backing "Done" prints over the
 * title it is meant to act on. Fades in with the cluster, so nothing shows
 * while the row rests.
 */
const ROW_ACTIONS_CLASS_NAME =
  "pointer-events-none absolute flex items-center gap-0.5 bg-sidebar pl-2 opacity-0 transition-opacity duration-150 group-hover/thread-row:pointer-events-auto group-hover/thread-row:opacity-100 group-focus-within/thread-row:pointer-events-auto group-focus-within/thread-row:opacity-100";

function formatDiffCount(count: number): string {
  return count >= 1_000 ? `${Math.round(count / 100) / 10}k` : `${count}`;
}

/**
 * The elapsed half of "working · 4m". Its own component so the second-by-second
 * tick re-renders one label instead of every row in the list.
 */
function ThreadElapsedLabel({ startedAt }: { startedAt: string }) {
  const nowMs = useRelativeTimeTick(1_000);
  return <>{formatElapsedDurationLabel(startedAt, nowMs)}</>;
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
  /**
   * Whether this row earns a second line. Decided by the list so the divider
   * rhythm and the row agree about which rows are tall.
   */
  isTwoLine: boolean;
  /** Hairlines separate stacked two-line rows; quiet rows use spacing alone. */
  showDivider: boolean;
  isActive: boolean;
  jumpLabel: string | null;
  /** False while the thread is moving or blocked: live work can't be waved away. */
  canMarkDone: boolean;
  orderedThreadKeys: readonly string[];
  appSettingsConfirmThreadArchive: boolean;
  renamingThreadKey: string | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  renamingInputRef: React.RefObject<HTMLInputElement | null>;
  renamingCommittedRef: React.RefObject<boolean>;
  confirmingArchiveThreadKey: string | null;
  setConfirmingArchiveThreadKey: React.Dispatch<React.SetStateAction<string | null>>;
  confirmArchiveButtonRefs: React.RefObject<Map<string, HTMLButtonElement>>;
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
  attemptTogglePinThread: (threadRef: ScopedThreadRef, shouldPin: boolean) => Promise<void>;
  attemptArchiveThread: (threadRef: ScopedThreadRef) => Promise<void>;
  markThreadDone: (threadKey: string) => void;
  openPrLink: (event: React.MouseEvent<HTMLElement>, prUrl: string) => void;
}

/**
 * One live thread in the inbox: two lines, ~46px, no card.
 *
 * Line one carries identity and state (dot, title, status); line two carries
 * where the work lives (project, branch) and what it has produced (diffstat,
 * provider). Hovering swaps the status for the row's actions — the meta and the
 * actions share the same corner, so the row never changes height.
 */
export const InboxThreadRow = memo(function InboxThreadRow(props: InboxThreadRowProps) {
  const {
    thread,
    status,
    projectLabel,
    isTwoLine,
    showDivider,
    isActive,
    jumpLabel,
    canMarkDone,
    orderedThreadKeys,
    appSettingsConfirmThreadArchive,
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    renamingInputRef,
    renamingCommittedRef,
    confirmingArchiveThreadKey,
    setConfirmingArchiveThreadKey,
    confirmArchiveButtonRefs,
    handleThreadClick,
    navigateToThread,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    commitRename,
    cancelRename,
    attemptTogglePinThread,
    attemptArchiveThread,
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
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemoteThread =
    primaryEnvironmentId !== null && thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = useSavedEnvironmentRuntimeStore(
    (s) => s.byId[thread.environmentId]?.descriptor?.label ?? null,
  );
  const remoteEnvSavedLabel = useSavedEnvironmentRegistryStore(
    (s) => s.byId[thread.environmentId]?.label ?? null,
  );
  const threadEnvironmentLabel = isRemoteThread
    ? (remoteEnvLabel ?? remoteEnvSavedLabel ?? "Remote")
    : null;
  const threadProjectCwd = useStore(
    useMemo(
      () => (state: import("../../store").AppState) =>
        selectProjectByRef(state, scopeProjectRef(thread.environmentId, thread.projectId))?.cwd ??
        null,
      [thread.environmentId, thread.projectId],
    ),
  );
  const gitCwd = resolveThreadWorkingCwd({
    projectCwd: threadProjectCwd,
    worktreePath: thread.worktreePath,
    effectiveCwd: thread.effectiveCwd,
  });
  const gitStatus = useGitStatus({
    environmentId: thread.environmentId,
    cwd: thread.branch != null ? gitCwd : null,
  });
  const diffStat = resolveWorkingTreeDiffStat(gitStatus.data ?? null);
  const pr = resolveThreadPr(thread.branch, gitStatus.data);
  const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const isThreadRunning =
    thread.session?.status === "running" && thread.session.activeTurnId != null;
  const archiveUnavailableReason =
    thread.session?.status === "connecting" || thread.session?.orchestrationStatus === "starting"
      ? "connecting"
      : isThreadRunning
        ? "running"
        : null;
  const isThreadArchiveDisabled = archiveUnavailableReason !== null;
  const isConfirmingArchive = confirmingArchiveThreadKey === threadKey && !isThreadArchiveDisabled;
  const isPinned = thread.pinnedAt !== null;
  const isRenaming = renamingThreadKey === threadKey;
  const statusWord = inboxStatusWord(status);
  const isInFlight = status?.label === "Working" || status?.label === "Starting";
  const inFlightStartedAt = thread.latestTurn?.startedAt ?? thread.latestTurn?.requestedAt ?? null;
  // A completion nobody has looked at yet keeps the title bright until the
  // thread is opened.
  const isUnseen = status?.label === "Completed";

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
  const stopPropagationOnPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
    },
    [],
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
  const handleTogglePinClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.detail > 0) {
        event.currentTarget.blur();
      }
      void attemptTogglePinThread(threadRef, !isPinned);
    },
    [attemptTogglePinThread, isPinned, threadRef],
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
    <li
      className={cn(ROW_ITEM_CLASS_NAME, showDivider && "border-t border-border")}
      data-thread-item
      onMouseLeave={handleMouseLeave}
      onBlurCapture={handleBlurCapture}
    >
      <div
        role="button"
        tabIndex={0}
        data-testid={`thread-row-${thread.id}`}
        data-active={isActive ? "true" : undefined}
        className={cn(
          ROW_SURFACE_CLASS_NAME,
          isTwoLine ? "px-3 pt-1.5 pb-2" : "px-3 py-1.5",
          resolveRowSurfaceTone({ isActive, isSelected }),
        )}
        onClick={handleRowClick}
        onKeyDown={handleRowKeyDown}
        onContextMenu={handleRowContextMenu}
      >
        <div className="flex min-w-0 items-center gap-[7px]">
          {status ? (
            <span
              aria-label={status.label}
              title={status.label}
              className={cn("size-[7px] shrink-0 rounded-full", status.dotClass)}
            />
          ) : isPinned ? (
            <span
              aria-label="Pinned thread"
              className="inline-flex shrink-0 items-center justify-center text-muted-foreground/50"
            >
              <PinIcon className="size-2.5" />
            </span>
          ) : null}
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
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-xs font-medium",
                      isUnseen ? "text-foreground" : "text-foreground/90",
                    )}
                    data-testid={`thread-title-${thread.id}`}
                  >
                    {thread.title}
                  </span>
                }
              />
              <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
                {thread.title}
              </TooltipPopup>
            </Tooltip>
          )}
          {!isTwoLine && projectLabel ? (
            <span className="shrink-0 truncate text-[11px] text-muted-foreground/45">
              {projectLabel}
            </span>
          ) : null}
          <span
            data-testid={`thread-meta-${thread.id}`}
            className={cn(
              "shrink-0 font-mono text-[11px] leading-none",
              isConfirmingArchive
                ? "opacity-0"
                : // Touch has no hover, so the actions sit permanently at the
                  // row's right edge and the meta reserves room beside them
                  // instead of fading out under them.
                  "transition-opacity duration-150 max-sm:mr-28 sm:group-hover/thread-row:opacity-0 sm:group-focus-within/thread-row:opacity-0",
              statusWord !== null || isInFlight
                ? (status?.colorClass ?? "text-muted-foreground/50")
                : "text-muted-foreground/50",
            )}
          >
            {jumpLabel ? (
              <span
                className="inline-flex h-4 items-center rounded-full border border-border/80 bg-background/90 px-1.5 text-[10px] font-medium tracking-tight text-foreground"
                title={jumpLabel}
              >
                {jumpLabel}
              </span>
            ) : statusWord !== null ? (
              statusWord
            ) : isInFlight ? (
              <>
                {status?.label === "Starting" ? "starting" : "working"}
                {inFlightStartedAt ? (
                  <>
                    {" · "}
                    <ThreadElapsedLabel startedAt={inFlightStartedAt} />
                  </>
                ) : null}
              </>
            ) : (
              formatRelativeTimeLabel(
                thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
              )
            )}
          </span>
        </div>
        {isTwoLine ? (
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-3.5 text-[11px] text-muted-foreground/45">
            {projectLabel ? (
              <>
                <span className="shrink-0 truncate text-muted-foreground/60">{projectLabel}</span>
                {thread.branch ? <span className="shrink-0">·</span> : null}
              </>
            ) : null}
            {thread.branch ? (
              <span className="min-w-0 truncate font-mono text-[10px]">{thread.branch}</span>
            ) : null}
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {terminalStatus ? (
                <span
                  role="img"
                  aria-label={terminalStatus.label}
                  title={terminalStatus.label}
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
              {isRemoteThread ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        aria-label={threadEnvironmentLabel ?? "Remote"}
                        className="inline-flex items-center justify-center"
                      />
                    }
                  >
                    <CloudIcon className="block size-3 text-muted-foreground/50" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">{threadEnvironmentLabel}</TooltipPopup>
                </Tooltip>
              ) : null}
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
              {diffStat ? (
                <span className="font-mono text-[10px] leading-none">
                  <span className="text-success">+{formatDiffCount(diffStat.insertions)}</span>
                  <span className="ps-1 text-destructive">
                    −{formatDiffCount(diffStat.deletions)}
                  </span>
                </span>
              ) : null}
              <ThreadProviderGlyph thread={thread} />
            </span>
          </div>
        ) : null}
        {isConfirmingArchive ? (
          <div
            className={cn(
              ROW_ACTIONS_CLASS_NAME,
              "top-1 right-1.5 pointer-events-auto opacity-100",
            )}
          >
            <button
              ref={handleConfirmArchiveRef}
              type="button"
              data-thread-selection-safe
              data-testid={`thread-archive-confirm-${thread.id}`}
              aria-label={`Confirm archive ${thread.title}`}
              className="inline-flex h-5 cursor-pointer items-center rounded-full bg-destructive/12 px-2 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/18 focus-ring"
              onPointerDown={stopPropagationOnPointerDown}
              onClick={handleConfirmArchiveClick}
            >
              Confirm
            </button>
          </div>
        ) : (
          <div
            className={cn(
              ROW_ACTIONS_CLASS_NAME,
              "top-1 right-1.5 max-sm:pointer-events-auto max-sm:opacity-100",
            )}
          >
            {canMarkDone ? (
              <button
                type="button"
                data-thread-selection-safe
                data-testid={`thread-done-${thread.id}`}
                aria-label={`Mark ${thread.title} done`}
                className="inline-flex h-5 cursor-pointer items-center gap-1 rounded-sm px-1.5 text-[11px] text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-ring"
                onPointerDown={stopPropagationOnPointerDown}
                onClick={handleMarkDoneClick}
              >
                <CheckIcon className="size-3" />
                Done
              </button>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    data-thread-selection-safe
                    data-testid={`thread-pin-${thread.id}`}
                    aria-label={`${isPinned ? "Unpin" : "Pin"} ${thread.title}`}
                    aria-pressed={isPinned}
                    className={cn(
                      "inline-flex size-5 cursor-pointer items-center justify-center transition-colors pointer-coarse:size-7 focus-ring",
                      isPinned
                        ? "text-primary-readable hover:text-primary"
                        : "text-muted-foreground/60 hover:text-foreground",
                    )}
                    onPointerDown={stopPropagationOnPointerDown}
                    onClick={handleTogglePinClick}
                  >
                    {isPinned ? (
                      <PinOffIcon className="size-3.5" />
                    ) : (
                      <PinIcon className="size-3.5" />
                    )}
                  </button>
                }
              />
              <TooltipPopup side="top">{isPinned ? "Unpin" : "Pin"}</TooltipPopup>
            </Tooltip>
            {!isThreadArchiveDisabled && appSettingsConfirmThreadArchive ? (
              <button
                type="button"
                data-thread-selection-safe
                data-testid={`thread-archive-${thread.id}`}
                aria-label={`Archive ${thread.title}`}
                className="inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground/60 transition-colors pointer-coarse:size-7 hover:text-foreground focus-ring"
                onPointerDown={stopPropagationOnPointerDown}
                onClick={handleStartArchiveConfirmation}
              >
                <ArchiveIcon className="size-3.5" />
              </button>
            ) : !isThreadArchiveDisabled ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      data-thread-selection-safe
                      data-testid={`thread-archive-${thread.id}`}
                      aria-label={`Archive ${thread.title}`}
                      className="inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground/60 transition-colors pointer-coarse:size-7 hover:text-foreground focus-ring"
                      onPointerDown={stopPropagationOnPointerDown}
                      onClick={handleArchiveImmediateClick}
                    >
                      <ArchiveIcon className="size-3.5" />
                    </button>
                  }
                />
                <TooltipPopup side="top">Archive</TooltipPopup>
              </Tooltip>
            ) : (
              <button
                type="button"
                data-thread-selection-safe
                data-testid={`thread-archive-${thread.id}`}
                aria-label={`Archive ${thread.title} unavailable while thread is ${archiveUnavailableReason}`}
                title={`Archive unavailable while thread is ${archiveUnavailableReason}`}
                disabled
                className="inline-flex size-5 cursor-default items-center justify-center text-muted-foreground/25"
              >
                <ArchiveIcon className="size-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
});

export interface InboxDoneRowProps {
  thread: SidebarThreadSummary;
  projectLabel: string | null;
  doneAt: string | null;
  isActive: boolean;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
  ) => Promise<void>;
  reopenThread: (threadKey: string) => void;
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
    navigateToThread,
    handleThreadContextMenu,
    reopenThread,
  } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);

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

  return (
    <li className={ROW_ITEM_CLASS_NAME} data-thread-item>
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
        <span
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          data-testid={`done-title-${thread.id}`}
        >
          {thread.title}
        </span>
        {projectLabel ? (
          <span className="shrink-0 truncate text-[11px] text-muted-foreground/45">
            {projectLabel}
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground/45 transition-opacity duration-150 group-hover/thread-row:opacity-0 group-focus-within/thread-row:opacity-0">
          {doneAt ? formatRelativeTimeLabel(doneAt) : null}
        </span>
        <div className={cn(ROW_ACTIONS_CLASS_NAME, "top-1/2 right-1.5 -translate-y-1/2")}>
          <button
            type="button"
            data-thread-selection-safe
            data-testid={`done-reopen-${thread.id}`}
            aria-label={`Reopen ${thread.title}`}
            className="inline-flex h-5 cursor-pointer items-center gap-1 rounded-sm px-1.5 text-[11px] text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-ring"
            onPointerDown={stopPropagationOnPointerDown}
            onClick={handleReopenClick}
          >
            <Undo2Icon className="size-3" />
            Reopen
          </button>
        </div>
      </div>
    </li>
  );
});
