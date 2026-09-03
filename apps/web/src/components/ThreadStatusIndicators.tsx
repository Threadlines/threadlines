import { scopeProjectRef, scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import type { VcsStatusResult } from "@threadlines/contracts";
import { resolveThreadWorkingCwd } from "@threadlines/shared/threadCwd";
import { CloudIcon, TerminalIcon } from "lucide-react";
import { useMemo } from "react";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useGitStatus } from "../lib/gitStatusState";
import { selectThreadLastSeenAt } from "../lib/threadInboxSync";
import { cn } from "../lib/utils";
import { type AppState, selectProjectByRef, useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useUiStateStore } from "../uiStateStore";
import { resolveChangeRequestPresentation } from "../sourceControlPresentation";
import {
  pullRequestBadgeTone,
  pullRequestFromGitStatus,
  type PullRequestBadgeTone,
  type ThreadPullRequest,
} from "./pull-requests/pullRequests.logic";
import { resolveThreadStatusPill, type ThreadStatusPill } from "./Sidebar.logic";
import type { SidebarThreadSummary } from "../types";
import { LiveNode } from "./ui/threadline";
import { Tooltip, TooltipPopup, TooltipTrigger, TooltipWrapper } from "./ui/tooltip";

export interface PrStatusIndicator {
  label: string;
  colorClass: string;
  tooltip: string;
  url: string;
  number: number;
  /** State glyph from the shared table: merge, closed, draft or open. */
  Icon: PullRequestBadgeTone["Icon"];
}

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

/**
 * The badge for a thread's pull request: glyph and colour from the shared
 * state table, wording from the host's own terminology.
 */
export function prStatusIndicator(
  pr: ThreadPullRequest | null,
  provider: VcsStatusResult["sourceControlProvider"] | null | undefined,
): PrStatusIndicator | null {
  if (!pr) return null;
  const presentation = resolveChangeRequestPresentation(provider);
  const tone = pullRequestBadgeTone(pr.state, pr.isDraft);
  const word = pr.isDraft ? "draft" : pr.state;
  return {
    label: `${presentation.shortName} ${word}`,
    colorClass: tone.className,
    tooltip: `#${pr.number} ${presentation.shortName} ${word}: ${pr.title}`,
    url: pr.url,
    number: pr.number,
    Icon: tone.Icon,
  };
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

/**
 * The bare status dot, without a tooltip or label. Callers that supply their
 * own tooltip (the collapsed sidebar rail names the thread rather than the
 * status) use this instead of {@link ThreadStatusLabel}.
 */
export function ThreadStatusDot({
  status,
  className,
}: {
  status: ThreadStatusPill | null;
  className?: string;
}) {
  if (status === null) {
    return <span className={cn("size-[9px] rounded-full bg-muted-foreground/40", className)} />;
  }
  return status.pulse ? (
    <LiveNode
      className={cn("size-[9px]", className)}
      dotClassName={status.dotClass}
      haloClassName={status.dotClass}
    />
  ) : (
    <span className={cn("size-[9px] rounded-full", status.dotClass, className)} />
  );
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
      <TooltipWrapper tooltip={status.label}>
        <span
          className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
        >
          {status.pulse ? (
            <LiveNode
              className="size-[9px]"
              dotClassName={status.dotClass}
              haloClassName={status.dotClass}
            />
          ) : (
            <span className={`size-[9px] rounded-full ${status.dotClass}`} />
          )}
          <span className="sr-only">{status.label}</span>
        </span>
      </TooltipWrapper>
    );
  }

  return (
    <TooltipWrapper tooltip={status.label}>
      <span className={`inline-flex items-center text-[10px] ${status.colorClass}`}>
        {status.pulse ? (
          <LiveNode
            className="size-1.5"
            dotClassName={status.dotClass}
            haloClassName={status.dotClass}
          />
        ) : (
          <span className={`h-1.5 w-1.5 rounded-full ${status.dotClass}`} />
        )}
        <span className="sr-only">{status.label}</span>
      </span>
    </TooltipWrapper>
  );
}

/**
 * Non-interactive leading status icons for a thread row in compact contexts
 * like the command palette. Shows the change request state icon (if present) and the
 * thread status dot, matching the sidebar's leading indicators.
 */
export function ThreadRowLeadingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const lastVisitedAt = useUiStateStore((state) =>
    selectThreadLastSeenAt(state, scopedThreadKey(threadRef), thread.lastSeenAt),
  );
  const threadProjectCwd = useStore(
    useMemo(
      () => (state: AppState) =>
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
  const pr = pullRequestFromGitStatus(thread.branch, gitStatus.data);
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
            <prStatus.Icon className="size-3" />
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
        <TooltipWrapper tooltip={terminalStatus.label}>
          <span
            role="img"
            aria-label={terminalStatus.label}
            className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
          >
            <TerminalIcon
              className={`size-3 ${terminalStatus.pulse ? "animate-status-pulse" : ""}`}
            />
          </span>
        </TooltipWrapper>
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
