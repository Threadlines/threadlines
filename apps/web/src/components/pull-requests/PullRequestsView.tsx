import { scopeProjectRef, scopeThreadRef } from "@threadlines/client-runtime";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestListState,
  SourceControlProviderKind,
  ThreadId,
} from "@threadlines/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ExternalLinkIcon,
  GitBranchPlusIcon,
  MessagesSquareIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { openExternalUrl } from "../../lib/externalLinks";
import {
  PULL_REQUEST_PAGE_REFETCH_INTERVAL_MS,
  refreshPullRequestList,
  useLoadedPullRequestEntries,
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
import { PageTitlebar } from "../PageTitlebar";
import { PullRequestThreadDialog } from "../PullRequestThreadDialog";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { PageTabButton, pageTabId } from "../ui/page-tabs";
import { Skeleton } from "../ui/skeleton";
import { TooltipWrapper } from "../ui/tooltip";
import { LazyPullRequestDetailPanel } from "./LazyPullRequestDetailPanel";
import type { PullRequestCheckoutRequest } from "./PullRequestDetailPanel";
import {
  PullRequestFilterChipsRow,
  PullRequestFiltersButton,
  PullRequestSortMenu,
} from "./PullRequestFilters";
import { PullRequestTabStrip, pullRequestTabButtonId } from "./PullRequestTabStrip";
import {
  pullRequestTabId,
  usePullRequestTabsStore,
  type PullRequestTab,
  type PullRequestTabStatus,
  type PullRequestTabTarget,
} from "./pullRequestTabsStore";
import {
  PullRequestActorAvatar,
  PullRequestChecksGlyph,
  PullRequestLabelPill,
  pullRequestChecksTone,
  pullRequestHostName,
} from "./pullRequestPresentation";
import {
  formatPullRequestSelection,
  groupPullRequests,
  hasPullRequestProject,
  linkThreadsToPullRequests,
  matchesPullRequestQuery,
  matchesPullRequestSelection,
  narrowPullRequests,
  projectRepository,
  pullRequestBadgeTone,
  pullRequestConflictLabel,
  pullRequestEntryKey,
  pullRequestFilterChips,
  pullRequestProjectFacets,
  requiresHostSignIn,
  resolveNeedsYouReason,
  resolvePullRequestListSpan,
  resolveSignInHost,
  type PullRequestEntry,
  type PullRequestFilters,
  type PullRequestProjectFailure,
  type PullRequestSelection,
  type PullRequestSort,
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

/**
 * What the sign-in page says per host, since each one is signed in with its own
 * tool on the server. A workspace whose failures span several hosts, or whose
 * host we could not name, gets the general line.
 */
const SIGN_IN_COPY: Record<SourceControlProviderKind | "mixed", { title: string; body: string }> = {
  github: {
    title: "Sign in to GitHub CLI",
    body: "Threadlines reads pull requests through gh on the server.",
  },
  gitlab: {
    title: "Sign in to GitLab CLI",
    body: "Threadlines reads merge requests through glab on the server.",
  },
  bitbucket: {
    title: "Add your Bitbucket token",
    body: "Threadlines reads pull requests with THREADLINES_BITBUCKET_EMAIL and THREADLINES_BITBUCKET_API_TOKEN on the server.",
  },
  "azure-devops": {
    title: "Sign in to Azure CLI",
    body: "Threadlines reads pull requests through az on the server.",
  },
  unknown: {
    title: "Sign in to your source control tool",
    body: "Threadlines reads pull requests through each host's own tool on the server.",
  },
  mixed: {
    title: "Sign in to your source control tools",
    body: "Threadlines reads pull requests through each host's own tool on the server.",
  },
};

const GROUP_LABEL_CLASS =
  "mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/55 select-none";

const META_SEPARATOR_CLASS = "shrink-0 text-muted-foreground/30";

/**
 * Hidden until the row is hovered or holds focus. Spans the row's full height
 * on the hovered fill and fades in from the left, so the time and diff stat
 * underneath disappear instead of peeking out around the buttons. Touch has no
 * hover, and showing them always would hide the time on every row, so there
 * they are left out: the detail carries both actions in its header.
 */
const ROW_ACTIONS_CLASS =
  // `--muted` is translucent, so the hovered fill is rebuilt here on an opaque
  // page background rather than stacked on top of the row's own tint.
  "absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-r-md bg-background pr-2 pl-8 opacity-0 transition-opacity before:pointer-events-none before:absolute before:inset-0 before:rounded-r-md before:bg-muted [mask-image:linear-gradient(to_right,transparent,black_24px)] group-hover/pr-row:opacity-100 group-focus-within/pr-row:opacity-100 pointer-coarse:hidden";

interface PullRequestThreadDialogTarget {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly cwd: string | null;
  readonly url: string;
  /** The hand-off the new draft opens with, when the checkout came from one. */
  readonly initialPrompt: string | null;
  /** The way in the header asked for, so the dialog opens on that button. */
  readonly mode: "local" | "worktree" | null;
}

/** The detail beside the list, which the tab strip above it names. */
const DETAIL_PANEL_ID = "pull-requests-detail";

/**
 * The pull requests destination: every project in the workspace on a host we can read, in one
 * list, grouped by what the signed-in user still has to do about it.
 */
export function PullRequestsView({
  state,
  selection,
  filters,
  sort,
  onStateChange,
  onSelectionChange,
  onFiltersChange,
  onSortChange,
}: {
  readonly state: PullRequestListState;
  /** The row the detail column is showing, straight off the route. */
  readonly selection: PullRequestSelection | null;
  readonly filters: PullRequestFilters;
  readonly sort: PullRequestSort;
  readonly onStateChange: (state: PullRequestListState) => void;
  readonly onSelectionChange: (selection: PullRequestSelection | null) => void;
  readonly onFiltersChange: (filters: PullRequestFilters) => void;
  readonly onSortChange: (sort: PullRequestSort) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { handleNewThread } = useNewThreadHandler();
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const projects = useStore(useShallow(selectWorkspaceProjectsAcrossEnvironments));
  const [query, setQuery] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [dialogTarget, setDialogTarget] = useState<PullRequestThreadDialogTarget | null>(null);
  // The pull requests open at once. The route's `pr` says which of them is on
  // screen; the store only holds the set and the order they were opened in.
  const tabs = usePullRequestTabsStore((store) => store.tabs);
  const openTab = usePullRequestTabsStore((store) => store.open);
  const closeTab = usePullRequestTabsStore((store) => store.close);
  const markTabStatus = usePullRequestTabsStore((store) => store.markStatus);

  const snapshot = usePullRequestLists({
    state,
    refetchIntervalMs: PULL_REQUEST_PAGE_REFETCH_INTERVAL_MS,
  });

  // Search first, because it is what the user is typing at; then the filters,
  // which are the standing rules; then the groups, which read what is left.
  const visibleEntries = useMemo(
    () =>
      narrowPullRequests(
        snapshot.entries.filter((entry) => matchesPullRequestQuery(entry, query)),
        filters,
      ),
    [filters, query, snapshot.entries],
  );
  const groups = useMemo(
    () =>
      groupPullRequests({
        entries: visibleEntries,
        viewer: snapshot.viewer,
        state,
        sort,
        involvement: filters.involvement,
      }),
    [filters.involvement, snapshot.viewer, sort, state, visibleEntries],
  );
  // The chosen project is a key in the URL; only the rows know what it is called.
  const projectLabel = useMemo(
    () =>
      filters.project === ""
        ? undefined
        : pullRequestProjectFacets(snapshot.entries).find(
            (project) => project.key === filters.project,
          )?.label,
    [filters.project, snapshot.entries],
  );
  // Over every row, not just the visible ones: the selected pull request keeps
  // naming its thread while a search hides the row it came from.
  const threadsByEntryKey = useMemo(
    () => linkThreadsToPullRequests(snapshot.entries, threads, projects),
    [projects, snapshot.entries, threads],
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
    (entry: PullRequestEntry, request?: PullRequestCheckoutRequest) => {
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
        initialPrompt: request?.initialPrompt ?? null,
        mode: request?.mode ?? null,
      });
    },
    [projects],
  );

  // Which pull request the URL is on, and which row a press of the user's own
  // put it on. Only the second moves the cursor: a link opened straight onto a
  // selection, a step back through history, or a move along the tab strip
  // should leave focus where it is.
  const selectionKey = selection ? formatPullRequestSelection(selection) : null;
  const [pressedKey, setPressedKey] = useState<string | null>(null);
  const rowToRefocus = useRef<HTMLElement | null>(null);

  // One pull request shown. The repository rides along in the selection itself,
  // because the panel addresses a pull request by repository as well as by
  // number and two repositories can hold the same one.
  const showPullRequest = useCallback(
    (target: PullRequestTabTarget) => {
      onSelectionChange({
        environmentId: target.environmentId,
        projectId: target.projectId,
        repository: target.repository,
        number: target.number,
      });
    },
    [onSelectionChange],
  );
  // A tab moves the detail and nothing else: the arrow keys walk the strip, and
  // handing the cursor to the new title would end that walk on its first step.
  const handleSelectTab = useCallback(
    (tab: PullRequestTab) => {
      setPressedKey(null);
      showPullRequest(tab);
    },
    [showPullRequest],
  );
  // A row press replaces the list with the detail, so the cursor follows it.
  const handleSelect = useCallback(
    (entry: PullRequestEntry) => {
      openTab({
        environmentId: entry.environmentId,
        projectId: entry.projectId,
        repository: entry.repository,
        number: entry.number,
        state: entry.state,
        isDraft: entry.isDraft,
      });
      setPressedKey(formatPullRequestSelection(entry));
      showPullRequest(entry);
    },
    [openTab, showPullRequest],
  );
  const closeSelection = useCallback(() => {
    // Read while the row still wears the mark, since the mark goes with the
    // selection; below the two-column width the list is not even on screen
    // until the detail has gone, so the focus itself waits for the render.
    rowToRefocus.current = document.querySelector<HTMLElement>(
      '[data-testid="pull-requests-row"][aria-current="true"]',
    );
    setPressedKey(null);
    onSelectionChange(null);
  }, [onSelectionChange]);

  useEffect(() => {
    if (selection !== null) return;
    const row = rowToRefocus.current;
    rowToRefocus.current = null;
    row?.focus();
  }, [selection]);

  // The row the URL names, so the detail column can address it and the row it
  // came from can mark itself. A selection whose row is not in this listing
  // (another tab, a search that filters it out) still opens: the reference is
  // enough, and dropping it would make Escape the only way back.
  const selectedEntry = useMemo(
    () =>
      selection
        ? (snapshot.entries.find((entry) => matchesPullRequestSelection(selection, entry)) ?? null)
        : null,
    [selection, snapshot.entries],
  );
  // The panel addresses a pull request by repository as well as number. The URL
  // carries it, but a link written before it did carries only the project, and
  // then the listing's own row answers for it, and only after that the
  // project's remote: a project reads more than one repository now, so guessing
  // would open whatever else wears that number.
  const selectedReference = useMemo(() => {
    if (!selection) return null;
    const project = projects.find(
      (candidate) =>
        candidate.environmentId === selection.environmentId && candidate.id === selection.projectId,
    );
    const repository =
      selection.repository ??
      selectedEntry?.repository ??
      (project ? projectRepository(project) : null);
    return repository
      ? { projectId: selection.projectId, repository, number: selection.number }
      : null;
  }, [projects, selectedEntry, selection]);
  const selectedThread = selectedEntry
    ? (threadsByEntryKey.get(pullRequestEntryKey(selectedEntry))?.[0] ?? null)
    : null;
  // An authored row is on a repository nothing here points at, so there is no
  // branch to check out and no thread for the panel to offer or hand off to.
  const checkoutableEntry =
    selectedEntry && selectedEntry.origin !== "authored" ? selectedEntry : null;

  // The route is the source of truth for what is shown, so a pull request it
  // names that the strip does not carry joins it: a link opened straight onto
  // one, a step back through history, or the row press that just happened.
  useEffect(() => {
    if (!selection || !selectedReference) return;
    openTab({
      environmentId: selection.environmentId,
      projectId: selection.projectId,
      repository: selectedReference.repository,
      number: selection.number,
    });
  }, [openTab, selectedReference, selection]);

  // Each tab wears the state of the row it stands for, read from every listing
  // the page has loaded rather than only the one on screen: a merged pull
  // request is not in the open list, and drawing it open would be a lie. A row
  // no loaded listing carries keeps the state it was last seen with.
  const loadedEntries = useLoadedPullRequestEntries();
  const tabStatuses = useMemo(() => {
    const byId = new Map<string, PullRequestTabStatus>();
    for (const entry of [...loadedEntries, ...snapshot.entries]) {
      byId.set(pullRequestTabId(entry), { state: entry.state, isDraft: entry.isDraft });
    }
    return byId;
  }, [loadedEntries, snapshot.entries]);
  useEffect(() => {
    markTabStatus(tabStatuses);
  }, [markTabStatus, tabStatuses]);
  const tabViews = useMemo<readonly PullRequestTab[]>(
    () => tabs.map((tab) => ({ ...tab, ...tabStatuses.get(tab.id) })),
    [tabStatuses, tabs],
  );
  const activeTabId =
    selection && selectedReference
      ? pullRequestTabId({
          environmentId: selection.environmentId,
          projectId: selection.projectId,
          repository: selectedReference.repository,
          number: selection.number,
        })
      : null;
  const handleCloseTab = useCallback(
    (tab: PullRequestTab) => {
      const wasShowing = tab.id === activeTabId;
      const next = closeTab(tab.id);
      // Closing a tab the detail was not showing changes only the strip. The
      // strip and the detail otherwise move together: whatever is active after
      // the close is what the route goes to, and an empty strip gives the list
      // its full width back.
      if (!wasShowing) return;
      if (next) {
        handleSelectTab(next);
        return;
      }
      closeSelection();
    },
    [activeTabId, closeSelection, closeTab, handleSelectTab],
  );

  // Escape steps back to the list, but only when nothing else owns the key: a
  // dialog on top of the page is closing itself first.
  useEffect(() => {
    if (!selection) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      if (document.querySelector('[role="dialog"], [role="alertdialog"]') !== null) {
        return;
      }
      closeSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeSelection, selection]);

  // An empty list reads differently when the user narrowed it themselves.
  const isNarrowed = query.trim().length > 0 || pullRequestFilterChips(filters).length > 0;
  const showSignIn = requiresHostSignIn({
    entries: snapshot.entries,
    failures: snapshot.failures,
  });
  const signInCopy =
    SIGN_IN_COPY[resolveSignInHost({ failures: snapshot.failures, projects }) ?? "mixed"];

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
            <EmptyTitle>{signInCopy.title}</EmptyTitle>
            <EmptyDescription>{signInCopy.body}</EmptyDescription>
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
      !hasPullRequestProject(projects)
    ) {
      return (
        <PullRequestsEmpty description="Add a project on GitHub, GitLab, Bitbucket or Azure DevOps to see its pull requests." />
      );
    }
    if (visibleEntries.length === 0) {
      return (
        <PullRequestsEmpty
          description={isNarrowed ? "No pull requests match." : EMPTY_LIST_COPY[state]}
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
              selected={selection !== null && matchesPullRequestSelection(selection, entry)}
              onSelect={handleSelect}
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
      <PageTitlebar label="Pull requests" />
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* The pane-wide element scrolls so the scrollbar hugs the pane's edge;
            the reading column centers inside it. Wider than a chat list because
            each row carries a meta line as well as a title. With a pull request
            open the list gives up the middle of the page and becomes a fixed
            column beside it; narrow windows have no room for both, so there the
            detail stands in for the list until it is closed. */}
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-y-auto",
            selectedReference &&
              "hidden lg:block lg:w-[400px] lg:flex-none lg:border-r lg:border-border",
          )}
        >
          <div
            className={cn(
              // A container, so the rows can drop their least useful facts by
              // the width they actually have: a phone, or the column beside
              // an open pull request, not the window.
              "@container mx-auto flex min-h-full w-full flex-col py-8",
              selectedReference ? "px-4" : "max-w-3xl px-6",
            )}
          >
            <h1 className="mb-1 text-lg font-medium tracking-tight">Pull requests</h1>
            <p className="text-sm text-muted-foreground/70">
              Across every project with a remote we can read.
            </p>

            {/* Nothing to filter, search or refresh when no server can answer at all. */}
            {snapshot.environments.length > 0 ? (
              <>
                {/* The same strip the settings pages use: text on a hairline,
                  the active tab underlined. */}
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
                </div>
                {/* Search, then the two menus that stand for everything else the
                    list can be told, then the way to read it all again. */}
                <div className="mt-4 flex items-center gap-2">
                  <Input
                    className="min-w-0 flex-1"
                    size="sm"
                    type="search"
                    // The field is narrow on a phone, so the placeholder says
                    // what it is rather than everything it reads; the label
                    // spells the rest out for anyone who cannot see it.
                    aria-label="Search pull requests by title, number, author, branch or label"
                    placeholder="Search pull requests"
                    spellCheck={false}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <PullRequestSortMenu sort={sort} onSortChange={onSortChange} />
                  <PullRequestFiltersButton filters={filters} onFiltersChange={onFiltersChange} />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0"
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
                <PullRequestFilterChipsRow
                  filters={filters}
                  {...(projectLabel === undefined ? {} : { projectLabel })}
                  onFiltersChange={onFiltersChange}
                />
              </>
            ) : null}

            <PullRequestsNotice
              failures={snapshot.failures}
              environmentFailures={snapshot.environmentFailures}
              hidden={showSignIn}
              onRetry={handleRefresh}
            />

            <div
              id={LIST_PANEL_ID}
              role="tabpanel"
              aria-labelledby={pageTabId(
                LIST_PANEL_ID,
                STATE_TABS.find((tab) => tab.value === state)?.label ?? STATE_TABS[0].label,
              )}
            >
              {body}
            </div>
          </div>
        </div>

        {selectedReference && selection ? (
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            data-testid="pull-requests-detail-column"
          >
            {/* Several pull requests stay open at once, and the strip is where
                the rest of them wait. It sits above the header, so on a phone
                the back arrow still steps out to the list with the strip kept. */}
            <PullRequestTabStrip
              tabs={tabViews}
              activeId={activeTabId}
              panelId={DETAIL_PANEL_ID}
              onSelect={handleSelectTab}
              onClose={handleCloseTab}
            />
            <div
              id={DETAIL_PANEL_ID}
              role="tabpanel"
              className="min-h-0 min-w-0 flex-1"
              {...(activeTabId ? { "aria-labelledby": pullRequestTabButtonId(activeTabId) } : {})}
            >
              <LazyPullRequestDetailPanel
                key={activeTabId ?? selectionKey}
                environmentId={selection.environmentId}
                reference={selectedReference}
                context="page"
                linkedThread={selectedThread}
                autoFocusTitle={pressedKey !== null && pressedKey === selectionKey}
                onClose={closeSelection}
                {...(checkoutableEntry
                  ? {
                      onReviewInThread: (request?: PullRequestCheckoutRequest) =>
                        handleReviewInThread(checkoutableEntry, request),
                    }
                  : {})}
              />
            </div>
          </div>
        ) : null}
      </div>

      {dialogTarget ? (
        <PullRequestThreadDialog
          key={dialogTarget.key}
          open
          environmentId={dialogTarget.environmentId}
          threadId={dialogTarget.threadId}
          cwd={dialogTarget.cwd}
          initialReference={dialogTarget.url}
          {...(dialogTarget.mode ? { defaultMode: dialogTarget.mode } : {})}
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
                ...(dialogTarget.initialPrompt
                  ? { initialPrompt: dialogTarget.initialPrompt }
                  : {}),
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

/** Title and meta widths for the placeholder rows, uneven the way real rows are. */
const SKELETON_ROWS = [
  { title: "w-3/5", meta: "w-40" },
  { title: "w-2/5", meta: "w-32" },
  { title: "w-4/5", meta: "w-48" },
  { title: "w-1/2", meta: "w-36" },
  { title: "w-3/4", meta: "w-44" },
] as const;

/**
 * The list before it is read, laid out as one group of rows: the same glyph,
 * title, time and meta line at the same heights, so the rows arrive in place
 * rather than pushing the page around.
 */
function PullRequestsLoadingSkeleton() {
  return (
    <section className="mt-6" role="status" aria-label="Loading pull requests">
      <Skeleton className="mb-2 h-2.5 w-20 rounded-full" />
      <div className="flex flex-col divide-y divide-border/50">
        {SKELETON_ROWS.map((row) => (
          <div
            key={row.title}
            className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 px-2 py-2.5"
          >
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
              <Skeleton className="size-3.5 rounded-full" />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex h-5 items-center justify-between gap-3">
                <Skeleton className={cn("h-3.5 rounded-full", row.title)} />
                <Skeleton className="h-3 w-8 shrink-0 rounded-full" />
              </div>
              <div className="flex h-4 items-center">
                <Skeleton className={cn("h-2.5 rounded-full", row.meta)} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
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
  // The details open on click as well as on hover, so a keyboard or a touch
  // reader can get at why a project did not load.
  const [expanded, setExpanded] = useState(false);
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

  const details = [
    ...failures.map((failure) => ({
      key: `${failure.environmentId}:${failure.projectId}`,
      text: `${failure.projectTitle}: ${failure.detail}`,
    })),
    ...environmentFailures.map((failure) => ({
      key: failure.environmentId,
      text: `${failure.label}: ${failure.message}`,
    })),
  ];

  return (
    <div className="mt-4 text-xs text-muted-foreground/60" data-testid="pull-requests-notice">
      <div className="flex items-center gap-2">
        <TooltipWrapper
          tooltip={
            <div className="flex max-w-xs flex-col gap-1">
              {details.map((detail) => (
                <p key={detail.key}>{detail.text}</p>
              ))}
            </div>
          }
        >
          <button
            type="button"
            className="cursor-pointer rounded-sm underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground focus-ring"
            aria-expanded={expanded}
            onClick={() => setExpanded((previous) => !previous)}
          >
            {summary}
          </button>
        </TooltipWrapper>
        <button
          type="button"
          className="cursor-pointer rounded-sm text-muted-foreground/70 transition-colors hover:text-foreground focus-ring"
          onClick={onRetry}
        >
          Retry
        </button>
      </div>
      {expanded ? (
        <ul className="mt-1 flex flex-col gap-0.5 pl-3">
          {details.map((detail) => (
            <li key={detail.key} className="break-words">
              {detail.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A sentence's worth of words joined into the middle of a longer one. */
function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function PullRequestRow({
  entry,
  linkedThread,
  showRepository,
  showEnvironment,
  selected,
  onSelect,
  onOpenThread,
  onReviewInThread,
}: {
  readonly entry: PullRequestEntry;
  readonly linkedThread: SidebarThreadSummary | null;
  readonly showRepository: boolean;
  readonly showEnvironment: boolean;
  readonly selected: boolean;
  readonly onSelect: (entry: PullRequestEntry) => void;
  readonly onOpenThread: (thread: SidebarThreadSummary) => void;
  readonly onReviewInThread: (entry: PullRequestEntry) => void;
}) {
  const {
    Icon: GlyphIcon,
    className: glyphClassName,
    label: glyphLabel,
  } = pullRequestBadgeTone(entry.state, entry.isDraft);
  // A branch that no longer merges is the one thing about an open row worth
  // more than its state, so it takes the glyph's place.
  const conflictLabel = pullRequestConflictLabel(entry);
  // Everything the row states in a glyph belongs in the name of the button that
  // opens it, since a glyph in a sibling is not part of that name: the state
  // word, then the conflict, then how the checks went.
  const checksLabel = pullRequestChecksTone(entry.checksState)?.label ?? null;
  const rowLabel = `${[
    `${glyphLabel} pull request #${entry.number}`,
    ...(conflictLabel ? [lowerFirst(conflictLabel)] : []),
    ...(checksLabel ? [lowerFirst(checksLabel)] : []),
  ].join(", ")}: ${entry.title}`;
  const reason = resolveNeedsYouReason(entry);
  const openOnHostLabel = `Open on ${pullRequestHostName(entry.provider)}`;
  // Nothing here is checked out, so there is no thread to open and no branch to
  // check out into one; the repository is the only thing that places the row.
  const isAuthoredElsewhere = entry.origin === "authored";
  const namesRepository = showRepository || isAuthoredElsewhere;
  const visibleLabels = entry.labels.slice(0, 2);
  const hiddenLabelCount = entry.labels.length - visibleLabels.length;
  // A fixed, ordered set of optional slots, so the absent ones simply drop out
  // and the separators still land between what is left. A slot either keeps
  // its width whole or gives it up, and the one that gives it up truncates its
  // own text; a whole-width slot in a shrinking wrapper would otherwise paint
  // over the next slot's separator.
  const meta: readonly {
    key: string;
    fit: "whole" | "truncate";
    className?: string;
    /** Dropped, separator and all, when the list is narrower than `lg` (32rem): a
     *  phone, or the column beside an open pull request. */
    hideOnPhone?: boolean;
    content: ReactNode;
  }[] = [
    { key: "number", fit: "whole", className: "font-mono", content: `#${entry.number}` },
    ...(namesRepository
      ? [
          {
            key: "repository",
            fit: "truncate" as const,
            // A phone-width row has room for the number, the author and the
            // glyph; the repository only stays where it is the row's one
            // anchor (a pull request from outside the workspace).
            hideOnPhone: !isAuthoredElsewhere,
            content: <span className="truncate">{entry.repository}</span>,
          },
        ]
      : []),
    ...(entry.author
      ? [
          {
            key: "author",
            fit: "truncate" as const,
            content: (
              <>
                <PullRequestActorAvatar actor={entry.author} />
                <span className="truncate">{entry.author.login}</span>
              </>
            ),
          },
        ]
      : []),
    ...(showEnvironment
      ? [
          {
            key: "environment",
            fit: "truncate" as const,
            content: <span className="truncate">{entry.environmentLabel}</span>,
          },
        ]
      : []),
    // The checks say for themselves that they failed, in a glyph at the end of
    // the line; the rest of the reasons are review words with no glyph.
    ...(reason && reason !== "Checks failing"
      ? [
          {
            key: "reason",
            fit: "whole" as const,
            className:
              reason === "Approved"
                ? "text-emerald-600 dark:text-emerald-300/90"
                : "text-amber-600/90 dark:text-amber-400/80",
            content: reason,
          },
        ]
      : []),
    ...(visibleLabels.length > 0
      ? [
          {
            key: "labels",
            fit: "truncate" as const,
            // Pills truncated to a letter each say nothing; below md they go.
            hideOnPhone: true,
            content: (
              <>
                {visibleLabels.map((label) => (
                  <PullRequestLabelPill key={label.name} name={label.name} color={label.color} />
                ))}
                {hiddenLabelCount > 0 ? (
                  <span className="shrink-0">+{hiddenLabelCount}</span>
                ) : null}
              </>
            ),
          },
        ]
      : []),
    ...(entry.checksState === undefined
      ? []
      : [
          {
            key: "checks",
            fit: "whole" as const,
            content: <PullRequestChecksGlyph state={entry.checksState} />,
          },
        ]),
  ];

  return (
    // The fill answers to the wrapper, not to any one control: reaching for the
    // hover actions or the thread chip must not drop the row's highlight out
    // from under the cursor.
    <div
      className={cn(
        "group/pr-row relative -mx-2 rounded-md transition-colors hover:bg-muted focus-within:bg-muted",
        selected && "bg-muted",
      )}
    >
      {/* The row's own click sits under the content rather than around it,
          because the thread chip is a control of its own and a button inside a
          button is invalid. The content ignores the pointer, so every click
          that is not on the chip lands here. */}
      <button
        type="button"
        className="absolute inset-0 z-0 w-full cursor-pointer rounded-md focus-ring"
        data-testid="pull-requests-row"
        aria-current={selected ? "true" : undefined}
        aria-label={rowLabel}
        onClick={() => onSelect(entry)}
      />
      <div className="pointer-events-none relative grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 px-2 py-2.5 select-none">
        {/* The glyph is the only place the row states open/draft/merged/closed,
            so the word rides along in the row's own label for anyone who
            cannot see the colour. A conflict has no word of its own there, so
            it carries one itself. */}
        {conflictLabel ? (
          <TooltipWrapper tooltip={conflictLabel}>
            <span className="pointer-events-auto mt-0.5 shrink-0 text-destructive">
              <TriangleAlertIcon aria-hidden className="size-4" />
              <span className="sr-only">{conflictLabel}</span>
            </span>
          </TooltipWrapper>
        ) : (
          <span className={cn("mt-0.5 shrink-0", glyphClassName)}>
            <GlyphIcon aria-hidden className="size-4" />
          </span>
        )}
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
                <span
                  key={item.key}
                  className={cn(
                    "flex items-center gap-1.5",
                    item.fit === "whole" ? "shrink-0" : "min-w-0",
                    item.hideOnPhone && "@max-lg:hidden",
                  )}
                >
                  {index > 0 ? <span className={META_SEPARATOR_CLASS}>·</span> : null}
                  <span className={cn("flex min-w-0 items-center gap-1.5", item.className)}>
                    {item.content}
                  </span>
                </span>
              ))}
            </span>
            {linkedThread ? (
              <button
                type="button"
                className="pointer-events-auto flex min-w-0 max-w-[40%] shrink cursor-pointer items-center gap-1 rounded-sm text-muted-foreground/55 transition-colors hover:text-foreground focus-ring"
                aria-label={`Open thread ${linkedThread.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenThread(linkedThread);
                }}
              >
                <MessagesSquareIcon aria-hidden className="size-3 shrink-0" />
                <span className="truncate">{linkedThread.title}</span>
              </button>
            ) : null}
            {entry.additions > 0 || entry.deletions > 0 ? (
              <span className="shrink-0 font-mono text-xs">
                <DiffStatLabel additions={entry.additions} deletions={entry.deletions} />
              </span>
            ) : null}
          </span>
        </span>
      </div>
      <span className={ROW_ACTIONS_CLASS}>
        <Button
          variant="ghost"
          size="icon-xs"
          className="relative"
          tooltip={openOnHostLabel}
          aria-label={openOnHostLabel}
          onClick={() => openExternalUrl(entry.url)}
        >
          <ExternalLinkIcon />
        </Button>
        {isAuthoredElsewhere ? null : (
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
        )}
      </span>
    </div>
  );
}
