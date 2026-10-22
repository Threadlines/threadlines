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
  resolveDoneTimestamp,
  resolveSeenThreadStatus,
  type ThreadStatusPill,
} from "../components/Sidebar.logic";
import {
  resolveThreadPullRequest,
  resolveThreadPullRequestsSettledAt,
  type PullRequestEntry,
  type ThreadPullRequest,
} from "../components/pull-requests/pullRequests.logic";
import type { SidebarGeneralChatEntry } from "../components/sidebar/SidebarGeneralChats";
import {
  PULL_REQUEST_COUNT_REFETCH_INTERVAL_MS,
  PULL_REQUEST_SETTLED_REFETCH_INTERVAL_MS,
  usePullRequestLists,
  type PullRequestListSnapshot,
} from "../lib/pullRequestsReactQuery";
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
}

/** A general chat with its seen-aware status, and when the user last saw it. */
export interface InboxGeneralChatEntry extends SidebarGeneralChatEntry {
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
  readonly settledPullRequestEntries: readonly PullRequestEntry[];
  readonly pullRequestByThreadKey: ReadonlyMap<string, ThreadPullRequest>;
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

  // What the listings know about each inbox thread, built once for the whole
  // sidebar: the row badges read it, and so does the rule that files a thread
  // whose branch has landed. Rows still consult their own git status for the
  // branch they are standing on; this is the answer for the ones that moved.
  const settledPullRequestEntries = useMemo(
    () => [...mergedPullRequests.entries, ...closedPullRequests.entries],
    [closedPullRequests.entries, mergedPullRequests.entries],
  );
  const pullRequestByThreadKey = useMemo(() => {
    const byThreadKey = new Map<string, ThreadPullRequest>();
    if (openPullRequests.entries.length === 0 && settledPullRequestEntries.length === 0) {
      return byThreadKey;
    }
    for (const thread of inboxThreads) {
      const pullRequest = resolveThreadPullRequest({
        thread,
        gitStatus: null,
        openEntries: openPullRequests.entries,
        settledEntries: settledPullRequestEntries,
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
  }, [inboxThreads, openPullRequests.entries, projects, settledPullRequestEntries]);

  const entries = useMemo<InboxEntry[]>(
    () =>
      fileInboxThreads({
        threads: inboxThreads,
        seenSources: { seenThreadOverlays, threadSeedVisitedAtById },
        doneOverlays: doneThreadOverlays,
        now: nowIso,
        wrapUpChildThreadsOnFinish,
        // The thread's own word wins over the app setting. It waits for every
        // pull request the thread has, its own and the ones its agent opened
        // elsewhere. A landing the host did not date is taken as now, which
        // files the thread the way it always did.
        pullRequestSettledAt: (thread, threadKey) =>
          (threadWrapUpOnPullRequestSettledById[threadKey] ?? wrapUpOnPullRequestSettled)
            ? resolveThreadPullRequestsSettledAt({
                thread,
                own: pullRequestByThreadKey.get(threadKey),
                projects,
                settledEntries: settledPullRequestEntries,
                now: nowIso,
              })
            : null,
      }).map(({ thread, threadKey, lastVisitedAt, status, override, isDone }) => {
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
        };
      }),
    [
      doneThreadOverlays,
      inboxThreads,
      nowIso,
      projects,
      pullRequestByThreadKey,
      resolveThreadProjectKey,
      settledPullRequestEntries,
      seenThreadOverlays,
      sidebarProjectByKey,
      wrapUpChildThreadsOnFinish,
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
    settledPullRequestEntries,
    pullRequestByThreadKey,
    nowIso,
    entries,
    generalChatEntries,
  };
}
