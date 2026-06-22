import { scopeProjectRef, scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import type { VcsStatusResult } from "@threadlines/contracts";
import { CloudIcon, GitPullRequestIcon, TerminalIcon } from "lucide-react";
import { useMemo } from "react";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useGitStatus } from "../lib/gitStatusState";
import { type AppState, selectProjectByRef, useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useUiStateStore } from "../uiStateStore";
import { resolveChangeRequestPresentation } from "../sourceControlPresentation";
import { resolveThreadStatusPill, type ThreadStatusPill } from "./Sidebar.logic";
import type { SidebarThreadSummary } from "../types";
import { LiveNode } from "./ui/threadline";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface PrStatusIndicator {
  label: string;
  colorClass: string;
  tooltip: string;
  url: string;
}

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

export type ThreadPr = VcsStatusResult["pr"];

export function prStatusIndicator(
  pr: ThreadPr,
  provider: VcsStatusResult["sourceControlProvider"] | null | undefined,
): PrStatusIndicator | null {
  if (!pr) return null;
  const presentation = resolveChangeRequestPresentation(provider);

  if (pr.state === "open") {
    return {
      label: `${presentation.shortName} open`,
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} ${presentation.shortName} open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: `${presentation.shortName} closed`,
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} ${presentation.shortName} closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: `${presentation.shortName} merged`,
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} ${presentation.shortName} merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

export function ChangeRequestStatusIcon({ className }: { className?: string }) {
  return <GitPullRequestIcon className={className} />;
}

export function resolveThreadPr(
  threadBranch: string | null,
  gitStatus: VcsStatusResult | null,
): ThreadPr | null {
  if (threadBranch === null || gitStatus === null || gitStatus.refName !== threadBranch) {
    return null;
  }

  return gitStatus.pr ?? null;
}

export function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

export function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: ThreadStatusPill;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <span
        title={status.label}
        className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
      >
        {status.pulse ? (
          <LiveNode className="size-[9px]" />
        ) : (
          <span className={`size-[9px] rounded-full ${status.dotClass}`} />
        )}
        <span className="sr-only">{status.label}</span>
      </span>
    );
  }

  return (
    <span
      title={status.label}
      className={`inline-flex items-center text-[10px] ${status.colorClass}`}
    >
      {status.pulse ? (
        <LiveNode className="size-1.5" />
      ) : (
        <span className={`h-1.5 w-1.5 rounded-full ${status.dotClass}`} />
      )}
      <span className="sr-only">{status.label}</span>
    </span>
  );
}

/**
 * A thread row's live node: a status-coloured dot that sits centered on the
 * project rail so the vertical line reads as one continuous threadline running
 * through every thread's node. Colour alone encodes the status; a soft halo
 * pings while work is in flight. Hovering the dot reveals the status label, so
 * dropping the inline text label loses no information.
 *
 * Presentation only — the caller positions it (absolutely, over the rail).
 */
export function ThreadStatusRailDot({ status }: { status: ThreadStatusPill }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={status.label}
            className={`pointer-events-auto flex items-center justify-center ${status.colorClass}`}
          />
        }
      >
        {status.pulse ? (
          <LiveNode className="size-2" />
        ) : (
          <span className={`size-2 rounded-full ${status.dotClass}`} />
        )}
      </TooltipTrigger>
      <TooltipPopup side="right">{status.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The node a thread row contributes to its project's rail. Every thread gets one
 * so the rail reads as a continuous threadline studded with nodes: idle threads
 * show a small muted dot, active threads a status-coloured dot that pulses while
 * work is in flight. Hovering an active node reveals the status label.
 *
 * Must be rendered as a sibling of the row button (not inside it) and centered
 * on the rail in the row's left gutter, so the button's own clipping never
 * shaves the dot or its halo off the line.
 */
export function ThreadRailNode({ status }: { status: ThreadStatusPill | null }) {
  return (
    <span className="pointer-events-none absolute top-1/2 left-[-4.5px] z-20 -translate-x-1/2 -translate-y-1/2">
      {status ? (
        <ThreadStatusRailDot status={status} />
      ) : (
        <span aria-hidden="true" className="block size-1.5 rounded-full bg-muted-foreground/35" />
      )}
    </span>
  );
}

/**
 * Non-interactive leading status icons for a thread row in compact contexts
 * like the command palette. Shows the change request state icon (if present) and the
 * thread status dot, matching the sidebar's leading indicators.
 */
export function ThreadRowLeadingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const lastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const threadProjectCwd = useStore(
    useMemo(
      () => (state: AppState) =>
        selectProjectByRef(state, scopeProjectRef(thread.environmentId, thread.projectId))?.cwd ??
        null,
      [thread.environmentId, thread.projectId],
    ),
  );
  const gitCwd = thread.worktreePath ?? threadProjectCwd;
  const gitStatus = useGitStatus({
    environmentId: thread.environmentId,
    cwd: thread.branch != null ? gitCwd : null,
  });
  const pr = resolveThreadPr(thread.branch, gitStatus.data);
  const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });

  if (!prStatus && !threadStatus) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {prStatus ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={prStatus.tooltip}
                className={`inline-flex items-center justify-center ${prStatus.colorClass}`}
              />
            }
          >
            <ChangeRequestStatusIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
        </Tooltip>
      ) : null}
      {threadStatus ? <ThreadStatusLabel status={threadStatus} /> : null}
    </span>
  );
}

/**
 * Non-interactive trailing status icons for a thread row in compact contexts
 * like the command palette. Shows a terminal-running indicator and a remote
 * environment indicator, matching the sidebar's trailing indicators.
 */
export function ThreadRowTrailingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadKey, threadRef).runningTerminalIds,
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemoteThread =
    primaryEnvironmentId !== null && thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = useSavedEnvironmentRuntimeStore(
    (state) => state.byId[thread.environmentId]?.descriptor?.label ?? null,
  );
  const remoteEnvSavedLabel = useSavedEnvironmentRegistryStore(
    (state) => state.byId[thread.environmentId]?.label ?? null,
  );
  const threadEnvironmentLabel = isRemoteThread
    ? (remoteEnvLabel ?? remoteEnvSavedLabel ?? "Remote")
    : null;
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);

  if (!terminalStatus && !isRemoteThread) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {terminalStatus ? (
        <span
          role="img"
          aria-label={terminalStatus.label}
          title={terminalStatus.label}
          className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
        >
          <TerminalIcon className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`} />
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
            <CloudIcon className="size-3 text-muted-foreground/60" />
          </TooltipTrigger>
          <TooltipPopup side="top">{threadEnvironmentLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
