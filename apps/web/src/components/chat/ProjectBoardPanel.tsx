/**
 * The Threads tab: a project's threads on every computer in view, grouped by
 * what needs the user (docs/design/lead-chat.md, "Threads panel"). The
 * grouping is projectBoard.logic's; the filing, statuses and pull requests are
 * the sidebar's own (useInboxThreads), so a thread reads the same here as in
 * its sidebar row.
 */
import { scopedThreadKey, scopeProjectRef, scopeThreadRef } from "@threadlines/client-runtime";
import type { EnvironmentId, ProjectId, ScopedThreadRef, ThreadId } from "@threadlines/contracts";
import { CheckIcon, ChevronDownIcon, CrownIcon } from "lucide-react";
import React, { memo, useCallback, useMemo, useState } from "react";

import { type InboxEntry, useInboxThreads } from "../../hooks/useInboxThreads";
import { useOpenThreadPullRequest } from "../../hooks/useOpenThreadPullRequest";
import { useThreadMenu } from "../../hooks/useThreadMenu";
import { useTouchHoldMenu } from "../../hooks/useTouchHoldMenu";
import { projectLeadRef } from "../../leadChat";
import { cn } from "../../lib/utils";
import { selectProjectByRef, useStore } from "../../store";
import {
  findThreadOpenPullRequestEntry,
  resolveNeedsYouReason,
  type ThreadPullRequest,
} from "../pull-requests/pullRequests.logic";
import { RelativeTimeLabel } from "../RelativeTimeLabel";
import {
  ThreadEnvironmentBadge,
  ThreadProviderGlyph,
  ThreadPullRequestBadge,
  ThreadStatusText,
  threadPullRequestList,
} from "../sidebar/InboxRows";
import {
  deriveProjectBoard,
  foldProjectBoardGroup,
  formatProjectBoardCounts,
  type ProjectBoardGroup,
  type ProjectBoardGroupId,
  type ProjectBoardRow,
  type ProjectBoardThreadInput,
} from "./projectBoard.logic";

interface BoardThread extends ProjectBoardThreadInput {
  readonly entry: InboxEntry;
  /** Every pull request it has, for the row's badge. */
  readonly threadPullRequests: readonly ThreadPullRequest[];
}

const NO_PULL_REQUESTS: readonly ThreadPullRequest[] = [];

/** The board's threads: the project's inbox entries, with what their pull requests wait on. */
function useProjectBoard(environmentId: EnvironmentId, projectId: ProjectId) {
  const inbox = useInboxThreads();
  const {
    entries,
    linkedPullRequestsByThreadKey,
    nowIso,
    openPullRequests,
    projects,
    pullRequestByThreadKey,
    resolveProjectKeyForRef,
  } = inbox;
  return useMemo(() => {
    // The logical project, so copies of it on other computers are on the board too.
    const projectKey = resolveProjectKeyForRef(scopeProjectRef(environmentId, projectId));
    const threads = entries.flatMap((entry): BoardThread[] => {
      if (entry.projectKey !== projectKey) return [];
      const { thread } = entry;
      const pullRequests = threadPullRequestList(
        pullRequestByThreadKey.get(entry.threadKey) ?? null,
        linkedPullRequestsByThreadKey.get(entry.threadKey) ?? NO_PULL_REQUESTS,
      );
      return [
        {
          key: entry.threadKey,
          entry,
          threadPullRequests: pullRequests,
          statusLabel: entry.status?.label ?? null,
          isDone: entry.isDone,
          doneAt: entry.doneAt,
          activityAt: thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
          pullRequests: pullRequests.map((pullRequest) => {
            // Review and checks live on the open listing's row, not the thread's reading.
            const listed =
              pullRequest.state === "open"
                ? findThreadOpenPullRequestEntry({
                    thread,
                    number: pullRequest.number,
                    projects,
                    openEntries: openPullRequests.entries,
                  })
                : undefined;
            return {
              state: pullRequest.state,
              isDraft: pullRequest.isDraft,
              autoMergeEnabled: pullRequest.autoMergeEnabled,
              reviewReason: listed === undefined ? null : resolveNeedsYouReason(listed),
            };
          }),
        },
      ];
    });
    return deriveProjectBoard(threads, Date.parse(nowIso));
  }, [
    entries,
    environmentId,
    linkedPullRequestsByThreadKey,
    nowIso,
    openPullRequests.entries,
    projectId,
    projects,
    pullRequestByThreadKey,
    resolveProjectKeyForRef,
  ]);
}

export const ProjectBoardPanel = memo(function ProjectBoardPanel({
  environmentId,
  threadId,
  projectId,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  /** The thread open in the chat beside the panel. */
  threadId: ThreadId;
  projectId: ProjectId;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const { groups, counts } = useProjectBoard(environmentId, projectId);
  const leadThreadId = useStore((state) => {
    const project = selectProjectByRef(state, scopeProjectRef(environmentId, projectId));
    return project === undefined ? null : (projectLeadRef(state, project)?.threadId ?? null);
  });
  const activeThreadKey = scopedThreadKey(scopeThreadRef(environmentId, threadId));
  const [doneOpen, setDoneOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<ProjectBoardGroupId>>(
    () => new Set(),
  );
  const threadMenu = useThreadMenu();
  const openPrLink = useOpenThreadPullRequest();
  const openRowMenu = useCallback(
    (entry: InboxEntry, position: { readonly x: number; readonly y: number }) => {
      void threadMenu.open(
        {
          threadRef: scopeThreadRef(entry.thread.environmentId, entry.thread.id),
          inbox: { isDone: entry.isDone, canMarkDone: entry.canMarkDone },
        },
        position,
      );
    },
    [threadMenu],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-project-board="true">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-2.5 pb-1.5">
        <span
          data-testid="project-board-counts"
          className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground"
        >
          {formatProjectBoardCounts(counts)}
        </span>
        {leadThreadId !== null && leadThreadId !== threadId ? (
          <button
            type="button"
            data-testid="project-board-lead-link"
            className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-sm text-[12px] text-muted-foreground transition-colors hover:text-foreground focus-ring"
            onClick={() => onOpenThread(scopeThreadRef(environmentId, leadThreadId))}
          >
            <CrownIcon aria-hidden="true" className="size-3" />
            Lead chat
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {groups.length === 0 ? (
          <p className="px-3 py-1.5 text-[12px] text-muted-foreground">
            No threads in this project yet.
          </p>
        ) : (
          groups.map((group) => (
            <BoardGroup
              key={group.id}
              group={group}
              open={group.id !== "done" || doneOpen}
              expanded={expandedGroups.has(group.id)}
              activeThreadKey={activeThreadKey}
              onToggle={group.id === "done" ? () => setDoneOpen((open) => !open) : null}
              onExpand={() => setExpandedGroups((previous) => new Set(previous).add(group.id))}
              onOpenThread={onOpenThread}
              onOpenMenu={openRowMenu}
              openPrLink={openPrLink}
            />
          ))
        )}
      </div>
    </div>
  );
});

/**
 * One group: its name and count over a hairline, then its rows. Done is the
 * one that folds shut, like the sidebar's Wrapped shelf, so its whole header
 * is the control.
 */
function BoardGroup({
  group,
  open,
  expanded,
  activeThreadKey,
  onToggle,
  onExpand,
  onOpenThread,
  onOpenMenu,
  openPrLink,
}: {
  group: ProjectBoardGroup<BoardThread>;
  open: boolean;
  expanded: boolean;
  activeThreadKey: string;
  onToggle: (() => void) | null;
  onExpand: () => void;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
  onOpenMenu: (entry: InboxEntry, position: { readonly x: number; readonly y: number }) => void;
  openPrLink: ReturnType<typeof useOpenThreadPullRequest>;
}) {
  const { shown, hiddenCount } = foldProjectBoardGroup(group.rows, expanded);
  const headerText = (
    <>
      <span className="shrink-0 text-[11px] font-medium text-muted-foreground transition-colors group-hover/board-header:text-foreground">
        {group.label} ({group.rows.length})
      </span>
      <span aria-hidden="true" className="h-px min-w-3 flex-1 bg-border/60" />
    </>
  );
  return (
    <section data-project-board-group={group.id}>
      {onToggle !== null ? (
        <button
          type="button"
          aria-expanded={open}
          data-testid={`project-board-toggle-${group.id}`}
          className="group/board-header flex w-full cursor-pointer items-center gap-2 px-3 pt-2.5 pb-1 text-left select-none focus-ring"
          onClick={onToggle}
        >
          {headerText}
          <ChevronDownIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-150 group-hover/board-header:text-foreground",
              !open && "-rotate-90",
            )}
          />
        </button>
      ) : (
        <h3 className="flex items-center gap-2 px-3 pt-2.5 pb-1">{headerText}</h3>
      )}
      {open ? (
        <ul>
          {shown.map((row) => (
            <BoardRow
              key={row.thread.key}
              row={row}
              isActive={row.thread.key === activeThreadKey}
              onOpenThread={onOpenThread}
              onOpenMenu={onOpenMenu}
              openPrLink={openPrLink}
            />
          ))}
          {hiddenCount > 0 ? (
            <li>
              <button
                type="button"
                data-testid={`project-board-show-more-${group.id}`}
                className="w-full cursor-pointer px-3 pt-1 pb-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-ring"
                onClick={onExpand}
              >
                Show {hiddenCount} more…
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * One thread on one line, like a family's child rows in the sidebar: the
 * status dot (a grey check once wrapped), the title, its pull request, the
 * state word and clock, the computer when it is not this one, and the agent.
 */
const BoardRow = memo(function BoardRow({
  row,
  isActive,
  onOpenThread,
  onOpenMenu,
  openPrLink,
}: {
  row: ProjectBoardRow<BoardThread>;
  isActive: boolean;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
  onOpenMenu: (entry: InboxEntry, position: { readonly x: number; readonly y: number }) => void;
  openPrLink: ReturnType<typeof useOpenThreadPullRequest>;
}) {
  const { entry } = row.thread;
  const { thread } = entry;
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  // A wrapped row says so, whatever status it last had; one kept on the board
  // by its pull request shows the pull request's word instead.
  const wrapped = entry.isDone && row.pullRequestWord === null;
  const status = wrapped ? null : entry.status;
  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      onOpenMenu(entry, { x: event.clientX, y: event.clientY });
    },
    [entry, onOpenMenu],
  );
  const touchHold = useTouchHoldMenu<HTMLDivElement>({
    open: useCallback((position) => onOpenMenu(entry, position), [entry, onOpenMenu]),
    onContextMenu: handleContextMenu,
  });
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        data-testid={`project-board-row-${thread.id}`}
        data-active={isActive ? "true" : undefined}
        className={cn(
          "flex min-w-0 cursor-pointer items-center gap-1.5 px-3 py-[5px] outline-hidden select-none focus-ring focus-visible:ring-inset pointer-coarse:py-2",
          isActive ? "bg-foreground/[0.06]" : "hover:bg-foreground/[0.04]",
        )}
        onClick={() => onOpenThread(threadRef)}
        onKeyDown={(event) => {
          // The pull request badge inside answers its own keys.
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onOpenThread(threadRef);
        }}
        {...touchHold}
      >
        {wrapped ? (
          <CheckIcon aria-label="Wrapped" className="size-2.5 shrink-0 text-muted-foreground/50" />
        ) : (
          <span
            aria-label={status?.label ?? "Idle"}
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              status?.dotClass ?? "bg-muted-foreground/45",
            )}
          />
        )}
        {entry.isLead ? (
          <CrownIcon aria-label="Lead chat" className="size-2.5 shrink-0 text-muted-foreground" />
        ) : null}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs leading-4",
            wrapped ? "text-muted-foreground" : "text-foreground/90",
          )}
        >
          {thread.title}
        </span>
        <ThreadPullRequestBadge
          pullRequests={row.thread.threadPullRequests}
          provider={null}
          threadRef={threadRef}
          openPrLink={openPrLink}
        />
        {row.pullRequestWord !== null ? (
          <span className="shrink-0 font-mono text-[11px] leading-none text-muted-foreground tabular-nums">
            {row.pullRequestWord}
            {" · "}
            <RelativeTimeLabel
              at={thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt}
              compact
            />
          </span>
        ) : (
          <ThreadStatusText
            thread={thread}
            status={status}
            restingClassName="text-muted-foreground"
            {...(wrapped
              ? { resting: entry.doneAt ? <RelativeTimeLabel at={entry.doneAt} compact /> : null }
              : {})}
          />
        )}
        <ThreadEnvironmentBadge thread={thread} />
        <ThreadProviderGlyph thread={thread} />
      </div>
    </li>
  );
});
