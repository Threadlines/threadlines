import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@threadlines/client-runtime";
import type { ScopedProjectRef } from "@threadlines/contracts";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  canMarkThreadDone,
  fileInboxThreads,
  freshThreadDoneOverride,
  resolveDoneTimestamp,
  resolveSeenThreadStatus,
  type ThreadStatusPill,
} from "../components/Sidebar.logic";
import {
  resolveLinkedThreadPullRequests,
  resolveThreadPullRequest,
  resolveThreadPullRequestsSettledAt,
  threadPullRequestLookupRequests,
  type ThreadPullRequest,
} from "../components/pull-requests/pullRequests.logic";
import {
  PULL_REQUEST_COUNT_REFETCH_INTERVAL_MS,
  PULL_REQUEST_SETTLED_REFETCH_INTERVAL_MS,
  usePullRequestLists,
  type PullRequestListSnapshot,
} from "../lib/pullRequestsReactQuery";
import { usePullRequestLookups } from "../lib/pullRequestLookups";
import { derivePhysicalProjectKey, selectProjectGroupingSettings } from "../logicalProject";
import {
  buildPhysicalToLogicalProjectKeyMap,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import type { Project, SidebarThreadSummary } from "../types";
import { useUiStateStore } from "../uiStateStore";
import { useRelativeTimeTick } from "./useRelativeTimeTick";
import { useSettings } from "./useSettings";
import { useSidebarProjectSnapshots } from "./useSidebarProjectSnapshots";

// The queued-turn grace window is measured in minutes, so a coarse clock is
// enough to keep "can this be marked done" honest without re-rendering often.
const INBOX_CLOCK_INTERVAL_MS = 30_000;

/** One inbox row's thread, filed and labelled the way the sidebar draws it. */
export interface InboxEntry {
  thread: SidebarThreadSummary;
  threadKey: string;
  status: ThreadStatusPill | null;
  lastVisitedAt: string | undefined;
  projectKey: string;
  projectLabel: string | null;
  isDone: boolean;
  canMarkDone: boolean;
  doneAt: string | null;
  /** See FiledInboxThread.seenAt. */
  seenAt: string | undefined;
  /** When its work last moved; see InboxFamilyExit. */
  settledAt: string | null;
  /** When its answer last reached its parent; see InboxFamilyExit. */
  deliveredAt: string | null;
  /** Wrapped by the user's own word rather than a wrap-up rule. */
  wrappedByUser: boolean;
}

/** A general chat with its seen-aware status, and when the user last saw it. */
export interface InboxGeneralChatEntry {
  readonly threadKey: string;
  readonly thread: SidebarThreadSummary;
  readonly status: ThreadStatusPill | null;
  readonly lastVisitedAt: string | undefined;
}

export interface InboxThreads {
  readonly projects: Project[];
  readonly sidebarThreads: SidebarThreadSummary[];
  readonly sidebarProjects: SidebarProjectSnapshot[];
  readonly sidebarProjectByKey: ReadonlyMap<string, SidebarProjectSnapshot>;
  readonly resolveProjectKeyForRef: (projectRef: ScopedProjectRef) => string;
  readonly resolveThreadProjectKey: (thread: SidebarThreadSummary) => string;
  readonly generalChatProjectKeys: ReadonlySet<string>;
  /** Open threads outside the general chats: the inbox's rows, Active and Wrapped. */
  readonly inboxThreads: SidebarThreadSummary[];
  readonly openPullRequests: PullRequestListSnapshot;
  /** Each inbox thread's own pull request, from its branch; see `resolveThreadPullRequest`. */
  readonly pullRequestByThreadKey: ReadonlyMap<string, ThreadPullRequest>;
  /** The pull requests each inbox thread's agent opened on other branches, where it has any. */
  readonly linkedPullRequestsByThreadKey: ReadonlyMap<string, readonly ThreadPullRequest[]>;
  readonly nowIso: string;
  readonly entries: InboxEntry[];
  readonly generalChatEntries: InboxGeneralChatEntry[];
}

/**
 * The inbox: every open thread with the status its row shows and whether it
 * sits under Active or Wrapped, plus the general chats beside it.
 *
 * The sidebar draws it, and the desktop app counts its unread finished work on
 * the Dock and taskbar. Both read it from here so the badge can never name a
 * thread the sidebar has filed away. Each caller runs its own copy; the pull
 * request listings are shared queries, so a second caller costs no requests.
 */
export function useInboxThreads(): InboxThreads {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const sidebarThreads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  // One listing for the whole sidebar: the Pull Requests row's count and every
  // thread row's badge read the same answer, so a poll costs one request.
  const openPullRequests = usePullRequestLists({
    state: "open",
    refetchIntervalMs: PULL_REQUEST_COUNT_REFETCH_INTERVAL_MS,
  });
  // What has landed. A merged or closed pull request files its thread under
  // Wrapped, and it is the only thing that knows: the open listing simply
  // stops carrying the row. A branch does not un-merge, so these poll slowly.
  const mergedPullRequests = usePullRequestLists({
    state: "merged",
    refetchIntervalMs: PULL_REQUEST_SETTLED_REFETCH_INTERVAL_MS,
  });
  const closedPullRequests = usePullRequestLists({
    state: "closed",
    refetchIntervalMs: PULL_REQUEST_SETTLED_REFETCH_INTERVAL_MS,
  });
  const seenThreadOverlays = useUiStateStore((store) => store.seenThreadOverlays);
  const threadSeedVisitedAtById = useUiStateStore((store) => store.threadSeedVisitedAtById);
  const doneThreadOverlays = useUiStateStore((store) => store.doneThreadOverlays);
  const threadWrapUpOnPullRequestSettledById = useUiStateStore(
    (store) => store.threadWrapUpOnPullRequestSettledById,
  );
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const wrapUpOnPullRequestSettled = useSettings((s) => s.wrapUpThreadsOnPullRequestSettled);
  const wrapUpChildThreadsOnFinish = useSettings((s) => s.wrapUpChildThreadsOnFinish);
  const wrapUpIdleThreads = useSettings((s) => s.wrapUpIdleThreads);
  const nowMs = useRelativeTimeTick(INBOX_CLOCK_INTERVAL_MS);
  const nowIso = useMemo(() => new Date(nowMs).toISOString(), [nowMs]);

  const physicalToLogicalKey = useMemo(
    () =>
      buildPhysicalToLogicalProjectKeyMap({
        projects,
        settings: projectGroupingSettings,
      }),
    [projects, projectGroupingSettings],
  );
  const projectPhysicalKeyByScopedRef = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          derivePhysicalProjectKey(project),
        ]),
      ),
    [projects],
  );
  const sidebarProjects = useSidebarProjectSnapshots();
  const sidebarProjectByKey = useMemo(
    () => new Map(sidebarProjects.map((project) => [project.projectKey, project] as const)),
    [sidebarProjects],
  );

  const resolveProjectKeyForRef = useCallback(
    (projectRef: ScopedProjectRef) => {
      const scopedRef = scopedProjectKey(projectRef);
      const physicalKey = projectPhysicalKeyByScopedRef.get(scopedRef) ?? scopedRef;
      return physicalToLogicalKey.get(physicalKey) ?? physicalKey;
    },
    [physicalToLogicalKey, projectPhysicalKeyByScopedRef],
  );
  const resolveThreadProjectKey = useCallback(
    (thread: SidebarThreadSummary) =>
      resolveProjectKeyForRef(scopeProjectRef(thread.environmentId, thread.projectId)),
    [resolveProjectKeyForRef],
  );

  // General chats belong to no project and have their own page; they never
  // join the inbox, which is the list of project work.
  const generalChatProjectKeys = useMemo(
    () =>
      new Set(
        sidebarProjects
          .filter((project) => project.kind === "general-chat")
          .map((project) => project.projectKey),
      ),
    [sidebarProjects],
  );
  // ...and get their own lines under the General Chats row instead.
  const generalChatThreads = useMemo(
    () =>
      sidebarThreads.filter(
        (thread) =>
          thread.archivedAt === null && generalChatProjectKeys.has(resolveThreadProjectKey(thread)),
      ),
    [generalChatProjectKeys, resolveThreadProjectKey, sidebarThreads],
  );
  const inboxThreads = useMemo(
    () =>
      sidebarThreads.filter(
        (thread) =>
          thread.archivedAt === null &&
          !generalChatProjectKeys.has(resolveThreadProjectKey(thread)),
      ),
    [generalChatProjectKeys, resolveThreadProjectKey, sidebarThreads],
  );

  // What the listings and lookups know about each inbox thread, built once for
  // the whole sidebar: the row badges read it, and so does the rule that files
  // a thread whose branch has landed. Rows still consult their own git status
  // for the branch they are standing on; this is the answer for the ones that
  // moved, and for every Wrapped row. The listings keep only the newest few
  // settled pull requests, so whatever the open one does not carry is looked
  // up on its own.
  const settledPullRequestEntries = useMemo(
    () => [...mergedPullRequests.entries, ...closedPullRequests.entries],
    [closedPullRequests.entries, mergedPullRequests.entries],
  );
  const pullRequestLookups = usePullRequestLookups(
    useMemo(
      () =>
        threadPullRequestLookupRequests({
          threads: inboxThreads,
          projects,
          openEntries: openPullRequests.entries,
        }),
      [inboxThreads, openPullRequests.entries, projects],
    ),
  );
  const pullRequestByThreadKey = useMemo(() => {
    const byThreadKey = new Map<string, ThreadPullRequest>();
    if (
      openPullRequests.entries.length === 0 &&
      settledPullRequestEntries.length === 0 &&
      pullRequestLookups.size === 0
    ) {
      return byThreadKey;
    }
    for (const thread of inboxThreads) {
      const pullRequest = resolveThreadPullRequest({
        thread,
        gitStatus: null,
        openEntries: openPullRequests.entries,
        settledEntries: settledPullRequestEntries,
        lookups: pullRequestLookups,
        projects,
      });
      if (pullRequest) {
        byThreadKey.set(
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          pullRequest,
        );
      }
    }
    return byThreadKey;
  }, [
    inboxThreads,
    openPullRequests.entries,
    projects,
    pullRequestLookups,
    settledPullRequestEntries,
  ]);
  // The pull requests each thread's agent opened on other branches, from the
  // same reads. A row's tag shows one pull request and counts the rest, and
  // the thread waits for all of them before a landing files it.
  const linkedPullRequestsByThreadKey = useMemo(() => {
    const byThreadKey = new Map<string, readonly ThreadPullRequest[]>();
    for (const thread of inboxThreads) {
      if ((thread.linkedPullRequests?.length ?? 0) === 0) {
        continue;
      }
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const linked = resolveLinkedThreadPullRequests({
        thread,
        ownNumber: pullRequestByThreadKey.get(threadKey)?.number ?? null,
        projects,
        openEntries: openPullRequests.entries,
        settledEntries: settledPullRequestEntries,
        lookups: pullRequestLookups,
      });
      if (linked.length > 0) {
        byThreadKey.set(threadKey, linked);
      }
    }
    return byThreadKey;
  }, [
    inboxThreads,
    openPullRequests.entries,
    projects,
    pullRequestByThreadKey,
    pullRequestLookups,
    settledPullRequestEntries,
  ]);

  const entries = useMemo<InboxEntry[]>(
    () =>
      fileInboxThreads({
        threads: inboxThreads,
        seenSources: { seenThreadOverlays, threadSeedVisitedAtById },
        doneOverlays: doneThreadOverlays,
        now: nowIso,
        wrapUpChildThreadsOnFinish,
        wrapUpIdleThreads,
        // The thread's own word wins over the app setting. It waits for every
        // pull request the thread has, its own and the ones its agent opened
        // elsewhere. A landing the host did not date is taken as now, which
        // files the thread the way it always did.
        pullRequestSettledAt: (thread, threadKey) =>
          (threadWrapUpOnPullRequestSettledById[threadKey] ?? wrapUpOnPullRequestSettled)
            ? resolveThreadPullRequestsSettledAt({
                own: pullRequestByThreadKey.get(threadKey),
                linked: linkedPullRequestsByThreadKey.get(threadKey) ?? [],
                now: nowIso,
              })
            : null,
      }).map(({ thread, threadKey, lastVisitedAt, seenAt, status, override, isDone }) => {
        const projectKey = resolveThreadProjectKey(thread);
        return {
          thread,
          threadKey,
          status,
          lastVisitedAt,
          projectKey,
          projectLabel: sidebarProjectByKey.get(projectKey)?.displayName ?? null,
          isDone,
          // A pinned row never offers the wrap-up check: the pin says "keep
          // this here", and a hover affordance that files it away contradicts
          // it. Unpinning brings the action back.
          canMarkDone:
            thread.pinnedAt === null &&
            canMarkThreadDone({ ...thread, lastVisitedAt }, { now: nowIso }),
          doneAt: isDone ? resolveDoneTimestamp(thread, override) : null,
          seenAt,
          settledAt: resolveDoneTimestamp(thread, null),
          deliveredAt: thread.handedBackAt ?? null,
          wrappedByUser: isDone && freshThreadDoneOverride(thread, override)?.state === "done",
        };
      }),
    [
      doneThreadOverlays,
      inboxThreads,
      linkedPullRequestsByThreadKey,
      nowIso,
      pullRequestByThreadKey,
      resolveThreadProjectKey,
      seenThreadOverlays,
      sidebarProjectByKey,
      wrapUpChildThreadsOnFinish,
      wrapUpIdleThreads,
      wrapUpOnPullRequestSettled,
      threadSeedVisitedAtById,
      threadWrapUpOnPullRequestSettledById,
    ],
  );

  // The general chats' statuses, read the same seen-aware way as the inbox's.
  const generalChatEntries = useMemo(
    () =>
      generalChatThreads.map((thread): InboxGeneralChatEntry => {
        const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
        const { lastVisitedAt, status } = resolveSeenThreadStatus(thread, threadKey, {
          seenThreadOverlays,
          threadSeedVisitedAtById,
        });
        return { threadKey, thread, status, lastVisitedAt };
      }),
    [generalChatThreads, seenThreadOverlays, threadSeedVisitedAtById],
  );

  return {
    projects,
    sidebarThreads,
    sidebarProjects,
    sidebarProjectByKey,
    resolveProjectKeyForRef,
    resolveThreadProjectKey,
    generalChatProjectKeys,
    inboxThreads,
    openPullRequests,
    pullRequestByThreadKey,
    linkedPullRequestsByThreadKey,
    nowIso,
    entries,
    generalChatEntries,
  };
}
