import { scopeProjectRef, scopeThreadRef } from "@threadlines/client-runtime";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestListState,
  ThreadId,
} from "@threadlines/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ExternalLinkIcon,
  GitBranchPlusIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  MessagesSquareIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { openExternalUrl } from "../../lib/externalLinks";
import {
  PULL_REQUEST_PAGE_REFETCH_INTERVAL_MS,
  refreshPullRequestList,
  usePullRequestLists,
  type PullRequestEnvironmentFailure,
} from "../../lib/pullRequestsReactQuery";
import { cn, newThreadId } from "../../lib/utils";
import {
  selectSidebarThreadsAcrossEnvironments,
  selectWorkspaceProjectsAcrossEnvironments,
  useStore,
} from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";
import { DesktopPageTitlebar } from "../DesktopPageTitlebar";
import { PullRequestThreadDialog } from "../PullRequestThreadDialog";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { PageTabButton } from "../ui/page-tabs";
import { Skeleton } from "../ui/skeleton";
import { TooltipWrapper } from "../ui/tooltip";
import {
  groupPullRequests,
  hasGitHubProject,
  linkThreadsToPullRequests,
  matchesPullRequestQuery,
  pullRequestEntryKey,
  requiresGitHubSignIn,
  resolveNeedsYouReason,
  resolvePullRequestListSpan,
  type PullRequestEntry,
  type PullRequestProjectFailure,
} from "./pullRequests.logic";

const STATE_TABS = [
  { value: "open", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
] as const satisfies readonly { value: PullRequestListState; label: string }[];

const LIST_PANEL_ID = "pull-requests-list";

const EMPTY_LIST_COPY: Record<PullRequestListState, string> = {
  open: "No open pull requests.",
  merged: "Nothing merged recently.",
  closed: "Nothing closed recently.",
};

const GROUP_LABEL_CLASS =
  "mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/55 select-none";

const META_SEPARATOR_CLASS = "shrink-0 text-muted-foreground/30";

/**
 * Hidden until the row is hovered or holds focus; touch has no hover. Spans the
 * row's full height on the hovered fill and fades in from the left, so the
 * time and diff stat underneath disappear instead of peeking out around the
 * buttons.
 */
const ROW_ACTIONS_CLASS =
  // `--muted` is translucent, so the hovered fill is rebuilt here on an opaque
  // page background rather than stacked on top of the row's own tint.
  "absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-r-md bg-background pr-2 pl-8 opacity-0 transition-opacity before:pointer-events-none before:absolute before:inset-0 before:rounded-r-md before:bg-muted [mask-image:linear-gradient(to_right,transparent,black_24px)] group-hover/pr-row:opacity-100 group-focus-within/pr-row:opacity-100 pointer-coarse:opacity-100";

interface PullRequestGlyph {
  readonly Icon: typeof GitPullRequestIcon;
  readonly className: string;
  readonly label: string;
}

/** Colours copied from the thread status indicators so one state reads alike everywhere. */
function resolveGlyph(entry: PullRequestEntry): PullRequestGlyph {
  if (entry.state === "merged") {
    return {
      Icon: GitMergeIcon,
      className: "text-violet-600 dark:text-violet-300/90",
      label: "Merged",
    };
  }
  if (entry.state === "closed") {
    return {
      Icon: GitPullRequestClosedIcon,
      className: "text-zinc-500 dark:text-zinc-400/80",
      label: "Closed",
    };
  }
  if (entry.isDraft) {
    return { Icon: GitPullRequestDraftIcon, className: "text-muted-foreground/60", label: "Draft" };
  }
  return {
    Icon: GitPullRequestIcon,
    className: "text-emerald-600 dark:text-emerald-300/90",
    label: "Open",
  };
}

interface PullRequestThreadDialogTarget {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly cwd: string | null;
  readonly url: string;
}

/**
 * The pull requests destination: every GitHub project in the workspace, in one
 * list, grouped by what the signed-in user still has to do about it.
 */
export function PullRequestsView({
  state,
  onStateChange,
}: {
  readonly state: PullRequestListState;
  readonly onStateChange: (state: PullRequestListState) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { handleNewThread } = useNewThreadHandler();
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const projects = useStore(useShallow(selectWorkspaceProjectsAcrossEnvironments));
  const [query, setQuery] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [dialogTarget, setDialogTarget] = useState<PullRequestThreadDialogTarget | null>(null);

  const snapshot = usePullRequestLists({
    state,
    refetchIntervalMs: PULL_REQUEST_PAGE_REFETCH_INTERVAL_MS,
  });

  const visibleEntries = useMemo(
    () => snapshot.entries.filter((entry) => matchesPullRequestQuery(entry, query)),
    [query, snapshot.entries],
  );
  const groups = useMemo(
    () => groupPullRequests({ entries: visibleEntries, viewer: snapshot.viewer, state }),
    [snapshot.viewer, state, visibleEntries],
  );
  const threadsByEntryKey = useMemo(
    () => linkThreadsToPullRequests(visibleEntries, threads, projects),
    [projects, threads, visibleEntries],
  );
  const span = useMemo(() => resolvePullRequestListSpan(visibleEntries), [visibleEntries]);

  const environments = snapshot.environments;
  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    void Promise.allSettled(
      environments.map((environment) =>
        refreshPullRequestList(queryClient, {
          environmentId: environment.environmentId,
          state,
        }),
      ),
    ).finally(() => {
      setIsRefreshing(false);
    });
  }, [environments, queryClient, state]);

  const handleOpenThread = useCallback(
    (thread: SidebarThreadSummary) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    },
    [navigate],
  );

  const handleReviewInThread = useCallback(
    (entry: PullRequestEntry) => {
      const project = projects.find(
        (candidate) =>
          candidate.environmentId === entry.environmentId && candidate.id === entry.projectId,
      );
      setDialogTarget({
        key: pullRequestEntryKey(entry),
        environmentId: entry.environmentId,
        projectId: entry.projectId,
        threadId: newThreadId(),
        cwd: project?.cwd ?? null,
        url: entry.url,
      });
    },
    [projects],
  );

  const isSearching = query.trim().length > 0;
  const showSignIn = requiresGitHubSignIn({
    entries: snapshot.entries,
    failures: snapshot.failures,
  });

  const body = (() => {
    if (snapshot.environments.length === 0) {
      return <PullRequestsEmpty description="Pull requests need a newer Threadlines server." />;
    }
    if (snapshot.isPending) {
      return <PullRequestsLoadingSkeleton />;
    }
    if (showSignIn) {
      return (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Sign in to GitHub CLI</EmptyTitle>
            <EmptyDescription>
              Threadlines reads pull requests through gh on the server.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigate({ to: "/settings/source-control" });
              }}
            >
              Open Source Control settings
            </Button>
          </EmptyContent>
        </Empty>
      );
    }
    if (
      snapshot.entries.length === 0 &&
      snapshot.failures.length === 0 &&
      !hasGitHubProject(projects)
    ) {
      return (
        <PullRequestsEmpty description="Add a project with a GitHub remote to see its pull requests." />
      );
    }
    if (visibleEntries.length === 0) {
      return (
        <PullRequestsEmpty
          description={isSearching ? "No pull requests match." : EMPTY_LIST_COPY[state]}
        />
      );
    }

    return groups.map((group) => (
      <section key={group.id} className="mt-8 first:mt-6">
        {group.label ? (
          <h2 className={GROUP_LABEL_CLASS}>
            {group.label} · {group.entries.length}
          </h2>
        ) : null}
        <div className="flex flex-col divide-y divide-border/50">
          {group.entries.map((entry) => (
            <PullRequestRow
              key={pullRequestEntryKey(entry)}
              entry={entry}
              linkedThread={threadsByEntryKey.get(pullRequestEntryKey(entry))?.[0] ?? null}
              showRepository={span.multipleRepositories}
              showEnvironment={span.multipleEnvironments}
              onOpenThread={handleOpenThread}
              onReviewInThread={handleReviewInThread}
            />
          ))}
        </div>
      </section>
    ));
  })();

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col" data-testid="pull-requests-view">
      <DesktopPageTitlebar label="Pull requests" />
      {/* The pane-wide element scrolls so the scrollbar hugs the pane's edge;
          the reading column centers inside it. Wider than a chat list because
          each row carries a meta line as well as a title. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 py-8">
          <h1 className="mb-1 text-lg font-medium tracking-tight">Pull requests</h1>
          <p className="text-sm text-muted-foreground/70">
            Across every project with a GitHub remote.
          </p>

          {/* Nothing to filter, search or refresh when no server can answer at all. */}
          {snapshot.environments.length > 0 ? (
            <>
              {/* The same strip the settings pages use: text on a hairline, the
                  active tab underlined, the refresh control in the strip's
                  trailing slot. */}
              <div className="mt-6 flex items-end justify-between gap-3 border-b border-border">
                <div
                  role="tablist"
                  aria-label="Pull request state"
                  className="flex items-center gap-5"
                >
                  {STATE_TABS.map((tab) => (
                    <PageTabButton
                      key={tab.value}
                      label={tab.label}
                      active={state === tab.value}
                      panelId={LIST_PANEL_ID}
                      onClick={() => onStateChange(tab.value)}
                    />
                  ))}
                </div>
                <Button
                  className="mb-1"
                  variant="ghost"
                  size="icon-sm"
                  tooltip="Refresh"
                  aria-label="Refresh"
                  data-testid="pull-requests-refresh"
                  onClick={handleRefresh}
                >
                  <RefreshCwIcon
                    className={cn(
                      "size-3.5",
                      (isRefreshing || snapshot.isFetching) &&
                        "animate-spin motion-reduce:animate-none",
                    )}
                  />
                </Button>
              </div>
              <Input
                className="mt-4"
                size="sm"
                placeholder="Search title, #number, author, branch, label"
                spellCheck={false}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </>
          ) : null}

          <PullRequestsNotice
            failures={snapshot.failures}
            environmentFailures={snapshot.environmentFailures}
            hidden={showSignIn}
            onRetry={handleRefresh}
          />

          <div id={LIST_PANEL_ID} role="tabpanel">
            {body}
          </div>
        </div>
      </div>

      {dialogTarget ? (
        <PullRequestThreadDialog
          key={dialogTarget.key}
          open
          environmentId={dialogTarget.environmentId}
          threadId={dialogTarget.threadId}
          cwd={dialogTarget.cwd}
          initialReference={dialogTarget.url}
          onOpenChange={(open) => {
            if (!open) {
              setDialogTarget(null);
            }
          }}
          onPrepared={async ({ branch, worktreePath }) => {
            await handleNewThread(
              scopeProjectRef(dialogTarget.environmentId, dialogTarget.projectId),
              {
                branch,
                worktreePath,
                envMode: worktreePath ? "worktree" : "local",
              },
            );
          }}
        />
      ) : null}
    </div>
  );
}

function PullRequestsEmpty({ description }: { readonly description: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

const SKELETON_ROW_WIDTHS = ["w-64", "w-48", "w-72"] as const;

function PullRequestsLoadingSkeleton() {
  return (
    <div
      className="mt-6 flex flex-col divide-y divide-border/50"
      role="status"
      aria-label="Loading pull requests"
    >
      {SKELETON_ROW_WIDTHS.map((width) => (
        <div key={width} className="flex items-start gap-2.5 px-2 py-2.5">
          <Skeleton className="mt-0.5 size-4 shrink-0 rounded-sm" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className={cn("h-3 rounded-full", width)} />
            <Skeleton className="h-2.5 w-40 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * One muted line for the projects and computers the listing could not read.
 * Named counts up front, the details behind the line, and a way to try again.
 */
function PullRequestsNotice({
  failures,
  environmentFailures,
  hidden,
  onRetry,
}: {
  readonly failures: readonly PullRequestProjectFailure[];
  readonly environmentFailures: readonly PullRequestEnvironmentFailure[];
  readonly hidden: boolean;
  readonly onRetry: () => void;
}) {
  if (hidden || (failures.length === 0 && environmentFailures.length === 0)) {
    return null;
  }

  const summary = [
    failures.length > 0
      ? `Couldn't load ${failures.length} project${failures.length === 1 ? "" : "s"}`
      : null,
    environmentFailures.length > 0
      ? `Couldn't reach ${environmentFailures.length} computer${environmentFailures.length === 1 ? "" : "s"}`
      : null,
  ]
    .filter((part) => part !== null)
    .join(", ");

  return (
    <div
      className="mt-4 flex items-center gap-2 text-xs text-muted-foreground/60"
      data-testid="pull-requests-notice"
    >
      <TooltipWrapper
        tooltip={
          <div className="flex max-w-xs flex-col gap-1">
            {failures.map((failure) => (
              <p key={`${failure.environmentId}:${failure.projectId}`}>
                {failure.projectTitle}: {failure.detail}
              </p>
            ))}
            {environmentFailures.map((failure) => (
              <p key={failure.environmentId}>
                {failure.label}: {failure.message}
              </p>
            ))}
          </div>
        }
      >
        <span className="cursor-default underline decoration-dotted underline-offset-2">
          {summary}
        </span>
      </TooltipWrapper>
      <button
        type="button"
        className="cursor-pointer rounded-sm text-muted-foreground/70 transition-colors hover:text-foreground focus-ring"
        onClick={onRetry}
      >
        Retry
      </button>
    </div>
  );
}

function PullRequestRow({
  entry,
  linkedThread,
  showRepository,
  showEnvironment,
  onOpenThread,
  onReviewInThread,
}: {
  readonly entry: PullRequestEntry;
  readonly linkedThread: SidebarThreadSummary | null;
  readonly showRepository: boolean;
  readonly showEnvironment: boolean;
  readonly onOpenThread: (thread: SidebarThreadSummary) => void;
  readonly onReviewInThread: (entry: PullRequestEntry) => void;
}) {
  const { Icon: GlyphIcon, className: glyphClassName, label: glyphLabel } = resolveGlyph(entry);
  const reason = resolveNeedsYouReason(entry);
  const visibleLabels = entry.labels.slice(0, 2);
  const hiddenLabelCount = entry.labels.length - visibleLabels.length;
  // A fixed, ordered set of optional slots, so the absent ones simply drop out
  // and the separators still land between what is left.
  const meta: readonly { key: string; className: string; text: string }[] = [
    { key: "number", className: "shrink-0 font-mono", text: `#${entry.number}` },
    ...(showRepository
      ? [{ key: "repository", className: "truncate", text: entry.repository }]
      : []),
    ...(entry.author ? [{ key: "author", className: "truncate", text: entry.author.login }] : []),
    ...(showEnvironment
      ? [{ key: "environment", className: "truncate", text: entry.environmentLabel }]
      : []),
    ...(reason
      ? [
          {
            key: "reason",
            className: cn(
              "shrink-0",
              reason === "Approved"
                ? "text-emerald-600 dark:text-emerald-300/90"
                : "text-amber-600/90 dark:text-amber-400/80",
            ),
            text: reason,
          },
        ]
      : []),
  ];

  return (
    // The fill answers to the wrapper, not to the button: the hover actions are
    // siblings (a button inside a button is invalid), and reaching for one must
    // not drop the row's highlight out from under the cursor.
    <div className="group/pr-row relative -mx-2 rounded-md transition-colors hover:bg-muted focus-within:bg-muted">
      <button
        type="button"
        className="grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 rounded-md px-2 py-2.5 text-left select-none focus-ring"
        data-testid="pull-requests-row"
        onClick={() => {
          if (linkedThread) {
            onOpenThread(linkedThread);
            return;
          }
          openExternalUrl(entry.url);
        }}
      >
        {/* The glyph is the only place the row states open/draft/merged/closed,
            so the word rides along for anyone who cannot see the colour. */}
        <span className={cn("mt-0.5 shrink-0", glyphClassName)}>
          <GlyphIcon aria-hidden className="size-4" />
          <span className="sr-only">{glyphLabel}</span>
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex w-full min-w-0 items-baseline gap-3">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90">
              {entry.title}
            </span>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground/50">
              {formatRelativeTimeLabel(entry.updatedAt)}
            </span>
          </span>
          <span className="flex w-full min-w-0 items-center gap-2 text-xs text-muted-foreground/55">
            <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap">
              {meta.map((item, index) => (
                <span key={item.key} className="flex min-w-0 items-center gap-1.5">
                  {index > 0 ? <span className={META_SEPARATOR_CLASS}>·</span> : null}
                  <span className={item.className}>{item.text}</span>
                </span>
              ))}
              {visibleLabels.map((label) => (
                <span key={label.name} className="flex shrink-0 items-center gap-1">
                  <span
                    aria-hidden
                    className="size-1.5 rounded-full bg-muted-foreground/40"
                    style={label.color ? { backgroundColor: `#${label.color}` } : undefined}
                  />
                  {label.name}
                </span>
              ))}
              {hiddenLabelCount > 0 ? <span className="shrink-0">+{hiddenLabelCount}</span> : null}
            </span>
            {linkedThread ? (
              <span className="flex min-w-0 max-w-[40%] shrink items-center gap-1 text-muted-foreground/55">
                <MessagesSquareIcon aria-hidden className="size-3 shrink-0" />
                <span className="truncate">{linkedThread.title}</span>
              </span>
            ) : null}
            {entry.additions > 0 || entry.deletions > 0 ? (
              <span className="shrink-0 font-mono text-xs">
                <DiffStatLabel additions={entry.additions} deletions={entry.deletions} />
              </span>
            ) : null}
          </span>
        </span>
      </button>
      <span className={ROW_ACTIONS_CLASS}>
        <Button
          variant="ghost"
          size="icon-xs"
          className="relative"
          tooltip="Open on GitHub"
          aria-label="Open on GitHub"
          onClick={() => openExternalUrl(entry.url)}
        >
          <ExternalLinkIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="relative"
          tooltip="Review in a thread"
          aria-label="Review in a thread"
          onClick={() => onReviewInThread(entry)}
        >
          <GitBranchPlusIcon />
        </Button>
      </span>
    </div>
  );
}
