import type {
  EnvironmentId,
  ProjectId,
  PullRequestAction,
  PullRequestCommentUpdateKind,
  PullRequestListState,
  PullRequestMergeMethod,
  PullRequestReactionContent,
  PullRequestRef,
  PullRequestReviewCommentDraft,
  PullRequestReviewVerdict,
  PullRequestReviewerKind,
  PullRequestUpdateMethod,
} from "@threadlines/contracts";
import type { PullRequestDetail } from "@threadlines/contracts";
import {
  PULL_REQUEST_CHECKS_POLL_INTERVAL_MS,
  pullRequestChecksWait,
  shouldPollPullRequestDetail,
  type PullRequestChecksWait,
} from "@threadlines/shared/pullRequestPolling";
import {
  keepPreviousData,
  mutationOptions,
  queryOptions,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { resolveEnvironmentOptionLabel } from "~/components/BranchToolbar.logic";
import {
  mergePullRequestListResults,
  type PullRequestEntry,
  type PullRequestProjectFailure,
} from "~/components/pull-requests/pullRequests.logic";
import { ensureEnvironmentApi } from "~/environmentApi";
import { usePrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "~/environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "~/environments/runtime";

/** Matches the server's own listing cache, so a remount does not re-run `gh`. */
const PULL_REQUEST_STALE_TIME_MS = 30_000;

/** The page keeps the list current while it is on screen. */
export const PULL_REQUEST_PAGE_REFETCH_INTERVAL_MS = 60_000;

/** The sidebar count only has to be roughly right. */
export const PULL_REQUEST_COUNT_REFETCH_INTERVAL_MS = 300_000;

/**
 * Merged and closed listings only tell the sidebar which threads have
 * finished, and a branch does not un-merge, so they poll far more slowly than
 * the open one.
 */
export const PULL_REQUEST_SETTLED_REFETCH_INTERVAL_MS = 600_000;

/** The header and the conversation move at the same pace as the server's caches. */
const PULL_REQUEST_READ_STALE_TIME_MS = 15_000;

/** A patch is the same until someone pushes, and it is the costliest read. */
const PULL_REQUEST_DIFF_STALE_TIME_MS = 60_000;
const PULL_REQUEST_DIFF_GC_TIME_MS = 300_000;

export const pullRequestQueryKeys = {
  all: ["pull-requests"] as const,
  list: (environmentId: EnvironmentId, state: PullRequestListState) =>
    ["pull-requests", "list", environmentId, state] as const,
  detail: (environmentId: EnvironmentId, projectId: ProjectId, number: number) =>
    ["pull-requests", "detail", environmentId, projectId, number] as const,
  activity: (environmentId: EnvironmentId, projectId: ProjectId, number: number) =>
    ["pull-requests", "activity", environmentId, projectId, number] as const,
  diff: (environmentId: EnvironmentId, projectId: ProjectId, number: number) =>
    ["pull-requests", "diff", environmentId, projectId, number] as const,
  reviewerCandidates: (environmentId: EnvironmentId, projectId: ProjectId, number: number) =>
    ["pull-requests", "reviewer-candidates", environmentId, projectId, number] as const,
};

/** Everything the detail surface reads, addressed the same way on every key. */
export interface PullRequestReadInput {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  /** Drops the server's cached read as well as this one. Refresh only. */
  readonly force?: boolean;
  /**
   * The commit the head branch is known to have been pushed at. The server
   * reads again past a cached read of any other commit. Detail only.
   */
  readonly expectedHeadSha?: string | null;
}

function readPayload(input: PullRequestReadInput) {
  return { ...input.reference, ...(input.force ? { force: true as const } : {}) };
}

export function pullRequestDetailQueryOptions(input: PullRequestReadInput) {
  return queryOptions({
    queryKey: pullRequestQueryKeys.detail(
      input.environmentId,
      input.reference.projectId,
      input.reference.number,
    ),
    queryFn: () =>
      ensureEnvironmentApi(input.environmentId).pullRequests.detail({
        ...readPayload(input),
        ...(input.expectedHeadSha ? { expectedHeadSha: input.expectedHeadSha } : {}),
      }),
    staleTime: PULL_REQUEST_READ_STALE_TIME_MS,
    // Kept current while there is something to wait for, and read again on
    // coming back to the app then too. The rest of the time it is a document
    // the user reads, and the panel's own Refresh is the one thing that re-runs
    // `gh`. A first read that failed has nothing to show, so it is tried again
    // at the same pace rather than left blank until the surface remounts.
    refetchOnWindowFocus: (query) => detailWorthRereading(query.state),
    refetchInterval: (query) =>
      detailWorthRereading(query.state) ? PULL_REQUEST_CHECKS_POLL_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });
}

function detailWorthRereading(state: {
  readonly data: PullRequestDetail | undefined;
  readonly status: "pending" | "error" | "success";
}): boolean {
  return state.data === undefined
    ? state.status === "error"
    : shouldPollPullRequestDetail(state.data, Date.now());
}

/** One pull request's detail as a surface that shows its checks reads it. */
export interface PullRequestDetailRead {
  readonly detail: PullRequestDetail | undefined;
  /** The last read failed; `detail`, if any, is from before. */
  readonly error: Error | null;
  /**
   * What the checks in `detail` are still waiting on the host for, while the
   * follow-up reads last; null once they can be believed, or once the
   * follow-up reads run out and the read is shown for what it says.
   */
  readonly waitingFor: PullRequestChecksWait | null;
}

/**
 * When each follow-up read is due while a read's checks are waiting on the
 * host, from the moment the wait is first seen: at once, then quick while the
 * host is expected any moment, then spaced out. Two minutes in all, the time a
 * push is given to show its checks. Timed from that moment rather than from
 * each answer, so the pull request's own polling cannot keep pushing them back.
 */
const CHECKS_WAIT_FOLLOW_UP_AT_MS = [0, 2_000, 6_000, 14_000, 30_000, 60_000, 90_000, 120_000];

/** One wait on the host: which one, when it was first seen, and the follow-ups sent for it. */
interface ChecksWaitFollowUp {
  readonly key: string;
  readonly startedAt: number;
  readonly sent: number;
  readonly lastSentAt: number;
}

/**
 * A pull request that may not exist yet, read on the same key the Pull request
 * tab reads: one poll serves the tab, the composer's row and anything else on
 * screen. Idle until there is something to address, which is why the key it
 * would rest on names nothing real.
 *
 * With `pushedHead`, the commit the checkout last saw its branch pushed at, a
 * push is followed: a read that names another commit, or the new commit before
 * any of its checks, is read again on a fixed schedule, past the server's
 * cache for an older commit, until the host catches up or the schedule runs
 * out. Each pair of pushed and read commits gets one schedule, so a new push
 * starts another and a host that never catches up is not chased forever.
 */
export function usePullRequestDetail(input: {
  readonly environmentId: EnvironmentId | null;
  readonly reference: PullRequestRef | null;
  readonly pushedHead?: string | null;
}): PullRequestDetailRead {
  const queryClient = useQueryClient();
  const enabled = input.environmentId !== null && input.reference !== null;
  const pushedHead = input.pushedHead ?? null;
  const environmentId = input.environmentId ?? IDLE_ENVIRONMENT_ID;
  const reference = input.reference ?? IDLE_PULL_REQUEST_REF;
  const query = useQuery({
    ...pullRequestDetailQueryOptions({ environmentId, reference, expectedHeadSha: pushedHead }),
    enabled,
  });
  const detail = query.data;
  const fetching = query.fetchStatus === "fetching";
  const answeredAt = Math.max(query.dataUpdatedAt, query.errorUpdatedAt);
  const wait =
    enabled && detail !== undefined
      ? pullRequestChecksWait(detail, pushedHead, query.dataUpdatedAt)
      : null;
  const followUpKey = wait === null ? null : `${wait}:${pushedHead ?? ""}:${detail?.headSha ?? ""}`;
  const [followUp, setFollowUp] = useState<ChecksWaitFollowUp | null>(null);
  const episode = followUp !== null && followUp.key === followUpKey ? followUp : null;
  const sent = episode?.sent ?? 0;
  const startedAt = episode?.startedAt ?? null;
  // Still waiting while follow-ups are due, and while the last one is out
  // with no answer yet; after that the read is shown for what it says.
  const followingUp =
    followUpKey !== null &&
    (sent < CHECKS_WAIT_FOLLOW_UP_AT_MS.length ||
      (fetching && answeredAt < (episode?.lastSentAt ?? 0)));

  // One read at a time: a follow-up that joined a read already in flight,
  // perhaps one sent before the push, would spend itself on that read's
  // answer. Keyed on values, not the reference object, so a re-render does
  // not restart the wait.
  const { projectId, repository, number } = reference;
  useEffect(() => {
    if (followUpKey === null || fetching || sent >= CHECKS_WAIT_FOLLOW_UP_AT_MS.length) {
      return;
    }
    const dueAt = startedAt === null ? 0 : startedAt + (CHECKS_WAIT_FOLLOW_UP_AT_MS[sent] ?? 0);
    const timer = window.setTimeout(
      () => {
        const options = pullRequestDetailQueryOptions({
          environmentId,
          reference: { projectId, repository, number },
          expectedHeadSha: pushedHead,
        });
        // Another surface's read started in the meantime; this one waits for
        // it to answer and is armed again then.
        if (queryClient.getQueryState(options.queryKey)?.fetchStatus === "fetching") {
          return;
        }
        const now = Date.now();
        setFollowUp({
          key: followUpKey,
          startedAt: startedAt ?? now,
          sent: sent + 1,
          lastSentAt: now,
        });
        void queryClient.fetchQuery({ ...options, staleTime: 0 }).catch(() => undefined);
      },
      Math.max(0, dueAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [
    environmentId,
    projectId,
    repository,
    number,
    pushedHead,
    followUpKey,
    startedAt,
    sent,
    fetching,
    queryClient,
  ]);

  return {
    detail,
    error: query.error,
    waitingFor: followingUp ? wait : null,
  };
}

/** The key an idle read rests on. Never fetched, and names no real project. */
const IDLE_ENVIRONMENT_ID = "" as EnvironmentId;
const IDLE_PULL_REQUEST_REF = {
  projectId: "",
  repository: "",
  number: 0,
} as unknown as PullRequestRef;

export function pullRequestActivityQueryOptions(input: PullRequestReadInput) {
  return queryOptions({
    queryKey: pullRequestQueryKeys.activity(
      input.environmentId,
      input.reference.projectId,
      input.reference.number,
    ),
    queryFn: () =>
      ensureEnvironmentApi(input.environmentId).pullRequests.activity(readPayload(input)),
    staleTime: PULL_REQUEST_READ_STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });
}

export function pullRequestDiffQueryOptions(input: PullRequestReadInput) {
  return queryOptions({
    queryKey: pullRequestQueryKeys.diff(
      input.environmentId,
      input.reference.projectId,
      input.reference.number,
    ),
    queryFn: () => ensureEnvironmentApi(input.environmentId).pullRequests.diff(readPayload(input)),
    staleTime: PULL_REQUEST_DIFF_STALE_TIME_MS,
    gcTime: PULL_REQUEST_DIFF_GC_TIME_MS,
    refetchOnWindowFocus: false,
  });
}

/**
 * Re-reads one pull request past both caches, the panel's Refresh control.
 * Writes through the keys the panel already renders from, so the header and
 * the conversation update together rather than blinking through a loading state.
 */
export async function refreshPullRequest(
  queryClient: QueryClient,
  input: { readonly environmentId: EnvironmentId; readonly reference: PullRequestRef },
): Promise<void> {
  const forced = { ...input, force: true } as const;
  const diffOptions = pullRequestDiffQueryOptions(forced);
  await Promise.allSettled([
    queryClient.fetchQuery({ ...pullRequestDetailQueryOptions(forced), staleTime: 0 }),
    queryClient.fetchQuery({ ...pullRequestActivityQueryOptions(forced), staleTime: 0 }),
    // `gh pr diff` is the expensive read and the Code tab may never have been
    // opened, so the patch is only re-read when there is already one to replace.
    queryClient.getQueryData(diffOptions.queryKey) === undefined
      ? Promise.resolve()
      : queryClient.fetchQuery({ ...diffOptions, staleTime: 0 }),
  ]);
}

/** What every pull request write is addressed with. */
export interface PullRequestWriteInput {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly queryClient: QueryClient;
}

/**
 * The key and the invalidation every pull request write shares. Every read key
 * is filed under `all`, so one invalidation covers this pull request's detail
 * and conversation as well as the listings behind them; a merge moves the row
 * out of the open listing too, and this covers that without naming it.
 */
function pullRequestWriteBase(input: PullRequestWriteInput, name: string) {
  return {
    mutationKey: [
      "pull-requests",
      name,
      input.environmentId,
      input.reference.projectId,
      input.reference.number,
    ] as const,
    onSuccess: async () => {
      await input.queryClient.invalidateQueries({ queryKey: pullRequestQueryKeys.all });
    },
  };
}

/**
 * Posting a comment. The server drops its own caches for this pull request and
 * every listing, so the client follows: the conversation gains the comment and
 * the list's "updated" column stops lying.
 */
export function pullRequestCommentMutationOptions(input: PullRequestWriteInput) {
  return mutationOptions({
    ...pullRequestWriteBase(input, "comment"),
    mutationFn: (body: string) =>
      ensureEnvironmentApi(input.environmentId).pullRequests.comment({
        ...input.reference,
        body,
      }),
  });
}

/** Merging, closing, reopening, the draft switches, update branch and auto-merge. */
export function pullRequestActionMutationOptions(input: PullRequestWriteInput) {
  return mutationOptions({
    ...pullRequestWriteBase(input, "action"),
    mutationFn: (variables: {
      readonly action: PullRequestAction;
      readonly mergeMethod?: PullRequestMergeMethod;
      readonly updateMethod?: PullRequestUpdateMethod;
      readonly deleteBranch?: boolean;
    }) =>
      ensureEnvironmentApi(input.environmentId).pullRequests.runAction({
        ...input.reference,
        ...variables,
      }),
  });
}

/**
 * A whole review in one send: the verdict, its summary, and every line comment
 * that was held back while it was written. The Summary tab's verdict toggle
 * sends the same shape with no comments.
 */
export function pullRequestReviewMutationOptions(input: PullRequestWriteInput) {
  return mutationOptions({
    ...pullRequestWriteBase(input, "review"),
    mutationFn: (variables: {
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments?: readonly PullRequestReviewCommentDraft[];
    }) =>
      ensureEnvironmentApi(input.environmentId).pullRequests.submitReview({
        ...input.reference,
        verdict: variables.verdict,
        body: variables.body,
        comments: variables.comments ?? [],
      }),
  });
}

/** Replying inside a conversation on a diff line. */
export function pullRequestThreadReplyMutationOptions(input: PullRequestWriteInput) {
  return mutationOptions({
    ...pullRequestWriteBase(input, "thread-reply"),
    mutationFn: (variables: { readonly threadId: string; readonly body: string }) =>
      ensureEnvironmentApi(input.environmentId).pullRequests.replyToThread({
        ...input.reference,
        ...variables,
      }),
  });
}

/** Marking a conversation resolved, and taking that back. */
export function pullRequestThreadResolutionMutationOptions(input: PullRequestWriteInput) {
  return mutationOptions({
    ...pullRequestWriteBase(input, "thread-resolution"),
    mutationFn: (variables: { readonly threadId: string; readonly resolved: boolean }) =>
      ensureEnvironmentApi(input.environmentId).pullRequests.setThreadResolution({
        ...input.reference,
        ...variables,
      }),
  });
}

/** Adding or taking back one reaction. An absent subject is the description. */
export function pullRequestReactionMutationOptions(input: PullRequestWriteInput) {
  return mutationOptions({
    ...pullRequestWriteBase(input, "reaction"),
    mutationFn: (variables: {
      readonly subjectId?: string;
      readonly content: PullRequestReactionContent;
      readonly reacted: boolean;
    }) =>
      ensureEnvironmentApi(input.environmentId).pullRequests.setReaction({
        ...input.reference,
        ...variables,
      }),
  });
}

/** Rewriting the pull request's own title or description. */
export function pullRequestUpdateMutationOptions(input: PullRequestWriteInput) {
  return mutationOptions({
    ...pullRequestWriteBase(input, "update"),
    mutationFn: (variables: { readonly title?: string; readonly body?: string }) =>
      ensureEnvironmentApi(input.environmentId).pullRequests.update({
        ...input.reference,
        ...variables,
      }),
  });
}

/** Rewriting one remark the viewer wrote, in the conversation or on a line. */
export function pullRequestCommentUpdateMutationOptions(input: PullRequestWriteInput) {
  return mutationOptions({
    ...pullRequestWriteBase(input, "comment-update"),
    mutationFn: (variables: {
      readonly commentId: string;
      readonly kind: PullRequestCommentUpdateKind;
      readonly body: string;
    }) =>
      ensureEnvironmentApi(input.environmentId).pullRequests.updateComment({
        ...input.reference,
        ...variables,
      }),
  });
}

/** Asking someone for a review, and taking the ask back. */
export function pullRequestReviewerRequestMutationOptions(input: PullRequestWriteInput) {
  return mutationOptions({
    ...pullRequestWriteBase(input, "reviewer-request"),
    mutationFn: (variables: {
      readonly reviewers: readonly {
        readonly id: string;
        readonly kind: PullRequestReviewerKind;
      }[];
      readonly requested: boolean;
    }) =>
      ensureEnvironmentApi(input.environmentId).pullRequests.requestReviewers({
        ...input.reference,
        ...variables,
      }),
  });
}

/**
 * Everyone the viewer may ask for a review. On a large repository this is a
 * list of everyone with access, so it is only read once the picker opens.
 */
export function pullRequestReviewerCandidatesQueryOptions(input: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
}) {
  return queryOptions({
    queryKey: pullRequestQueryKeys.reviewerCandidates(
      input.environmentId,
      input.reference.projectId,
      input.reference.number,
    ),
    queryFn: () =>
      ensureEnvironmentApi(input.environmentId).pullRequests.reviewerCandidates(input.reference),
    staleTime: PULL_REQUEST_READ_STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });
}

/** An environment whose server can answer a pull request listing. */
export interface PullRequestEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function pullRequestListQueryOptions(input: {
  readonly environmentId: EnvironmentId;
  readonly state: PullRequestListState;
}) {
  return queryOptions({
    queryKey: pullRequestQueryKeys.list(input.environmentId, input.state),
    queryFn: () =>
      ensureEnvironmentApi(input.environmentId).pullRequests.list({ state: input.state }),
    staleTime: PULL_REQUEST_STALE_TIME_MS,
    // Coming back to the window is a good moment to re-read what is still in
    // flight. Merged and closed are history: the sidebar keeps them only to
    // file threads away, so paying for a `gh` run per project on every focus
    // would buy nothing.
    refetchOnWindowFocus: input.state === "open",
    // A refresh keeps the rows on screen: the list updates, it does not blink.
    placeholderData: keepPreviousData,
  });
}

/** Every listing a state can be read under, which is every tab the page has. */
const PULL_REQUEST_LIST_STATES = [
  "open",
  "merged",
  "closed",
] as const satisfies readonly PullRequestListState[];

/**
 * Every row the page has already read, whatever tab it was read under. The
 * Filters menu builds its author, label and project choices from these, so a
 * login the user has seen stays offerable after they switch tabs. Nothing is
 * fetched here: a state nobody has opened simply contributes no rows.
 */
export function useLoadedPullRequestEntries(): readonly PullRequestEntry[] {
  const environments = usePullRequestEnvironments();

  return useQueries({
    queries: environments.flatMap((environment) =>
      PULL_REQUEST_LIST_STATES.map((state) => ({
        ...pullRequestListQueryOptions({ environmentId: environment.environmentId, state }),
        enabled: false,
      })),
    ),
    // Merged per state across every environment, the same way the page reads
    // its own tab, so a pull request two computers both list is one row here
    // too and the Project filter does not offer it twice.
    combine: (results) =>
      PULL_REQUEST_LIST_STATES.flatMap(
        (state, stateIndex) =>
          mergePullRequestListResults({
            state,
            results: environments.map((environment, environmentIndex) => {
              const result =
                results[environmentIndex * PULL_REQUEST_LIST_STATES.length + stateIndex];
              return {
                environmentId: environment.environmentId,
                environmentLabel: environment.label,
                data: result && !result.isPlaceholderData ? result.data : undefined,
              };
            }),
          }).entries,
      ),
  });
}

/**
 * The refresh button. Writes through the same key the page and the sidebar
 * read, so one round trip updates both and the server drops its own cache
 * first rather than replaying the answer the user just rejected.
 */
export async function refreshPullRequestList(
  queryClient: QueryClient,
  input: { readonly environmentId: EnvironmentId; readonly state: PullRequestListState },
): Promise<void> {
  await queryClient.fetchQuery({
    ...pullRequestListQueryOptions(input),
    queryFn: () =>
      ensureEnvironmentApi(input.environmentId).pullRequests.list({
        state: input.state,
        force: true,
      }),
    staleTime: 0,
  });
}

/**
 * Every environment that can serve the page: this device plus each connected
 * saved computer whose server reports the capability. A server too old to know
 * about pull requests omits the key, and an absent capability is a no.
 */
export function usePullRequestEnvironments(): readonly PullRequestEnvironment[] {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const primarySupported = primaryDescriptor?.capabilities.pullRequests === true;
  const primaryLabel = primaryDescriptor?.label ?? null;
  const savedEnvironmentsById = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);

  return useMemo(() => {
    const environments: PullRequestEnvironment[] = [];
    const seen = new Set<EnvironmentId>();

    if (primaryEnvironmentId && primarySupported) {
      seen.add(primaryEnvironmentId);
      environments.push({
        environmentId: primaryEnvironmentId,
        label: resolveEnvironmentOptionLabel({
          isPrimary: true,
          environmentId: primaryEnvironmentId,
          runtimeLabel: primaryLabel,
        }),
      });
    }

    for (const environmentId of Object.keys(savedEnvironmentRuntimeById) as EnvironmentId[]) {
      if (seen.has(environmentId)) continue;
      const runtime = savedEnvironmentRuntimeById[environmentId];
      if (!runtime || runtime.connectionState !== "connected") continue;
      const descriptor = runtime.descriptor;
      if (!descriptor || descriptor.capabilities.pullRequests !== true) continue;
      seen.add(environmentId);
      environments.push({
        environmentId,
        label: resolveEnvironmentOptionLabel({
          isPrimary: false,
          environmentId,
          runtimeLabel: descriptor.label,
          savedLabel: savedEnvironmentsById[environmentId]?.label ?? null,
        }),
      });
    }

    return environments.toSorted((left, right) =>
      left.environmentId.localeCompare(right.environmentId),
    );
  }, [
    primaryEnvironmentId,
    primaryLabel,
    primarySupported,
    savedEnvironmentRuntimeById,
    savedEnvironmentsById,
  ]);
}

/** What one environment could not do, kept next to what the others returned. */
export interface PullRequestEnvironmentFailure {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly message: string;
}

export interface PullRequestListSnapshot {
  readonly environments: readonly PullRequestEnvironment[];
  readonly entries: readonly PullRequestEntry[];
  readonly failures: readonly PullRequestProjectFailure[];
  readonly environmentFailures: readonly PullRequestEnvironmentFailure[];
  readonly viewer: string | null;
  /** Nothing to show yet, not even a previous answer, and a read still going. */
  readonly isPending: boolean;
  /** Nothing to show, and every environment's read has failed. */
  readonly isUnavailable: boolean;
  readonly isFetching: boolean;
}

function describeListFailure(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim().length > 0) {
    return reason.message;
  }
  return "Unavailable";
}

/**
 * The page's and the sidebar's shared read. Every environment is asked in
 * parallel on the same keys, so whichever surface is mounted keeps the other
 * one warm, and one unreachable computer costs a notice rather than the list.
 */
export function usePullRequestLists(input: {
  readonly state: PullRequestListState;
  readonly refetchIntervalMs: number;
  readonly enabled?: boolean;
}): PullRequestListSnapshot {
  const environments = usePullRequestEnvironments();
  const enabled = input.enabled ?? true;
  const state = input.state;

  return useQueries({
    queries: environments.map((environment) => ({
      ...pullRequestListQueryOptions({ environmentId: environment.environmentId, state }),
      enabled,
      refetchInterval: input.refetchIntervalMs,
      // A background tab drives no decisions, and every poll spawns `gh`.
      refetchIntervalInBackground: false,
    })),
    combine: (results) => {
      // Placeholder data here is the previous tab's answer, held over while the
      // new one loads. Its rows are all filtered out by the state check, so
      // reading it would turn a tab switch into a flash of "nothing to show"
      // instead of the loading rows.
      const usableData = results.map((result) =>
        result.isPlaceholderData ? undefined : result.data,
      );
      const merged = mergePullRequestListResults({
        state,
        results: results.flatMap((_result, index) => {
          const environment = environments[index];
          return environment
            ? [
                {
                  environmentId: environment.environmentId,
                  environmentLabel: environment.label,
                  data: usableData[index],
                },
              ]
            : [];
        }),
      });
      // A failed read has no answer coming until it is asked again, so waiting
      // on it would keep the loading rows up for good.
      const hasNoAnswer = results.length > 0 && usableData.every((data) => data === undefined);
      const allFailed = results.every((result) => result.error !== null);

      return {
        environments,
        entries: merged.entries,
        failures: merged.failures,
        environmentFailures: results.flatMap((result, index) => {
          const environment = environments[index];
          return result.error && environment
            ? [
                {
                  environmentId: environment.environmentId,
                  label: environment.label,
                  message: describeListFailure(result.error),
                },
              ]
            : [];
        }),
        viewer: merged.viewer,
        isPending: hasNoAnswer && !allFailed,
        isUnavailable: hasNoAnswer && allFailed,
        isFetching: results.some((result) => result.isFetching),
      };
    },
  });
}
