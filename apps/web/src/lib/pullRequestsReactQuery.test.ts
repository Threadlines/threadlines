import { EnvironmentId, ProjectId, type PullRequestDetail } from "@threadlines/contracts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vite-plus/test";

import { ensureEnvironmentApi } from "../environmentApi";

vi.mock("../environmentApi", () => ({
  ensureEnvironmentApi: vi.fn(),
}));

import {
  markPullRequestListSettled,
  orderPullRequestEnvironments,
  PULL_REQUEST_ON_SCREEN_POLL_INTERVAL_MS,
  pullRequestActionMutationOptions,
  pullRequestDetailQueryOptions,
  pullRequestDiffQueryOptions,
  pullRequestListQueryOptions,
  pullRequestQueryKeys,
  refreshPullRequest,
} from "./pullRequestsReactQuery";

const REFERENCE = { projectId: ProjectId.make("project-a"), repository: "owner/repo", number: 7 };

/** The pace a detail read is kept at, for a pull request in a given state. */
function pace(attended: boolean | undefined, state: PullRequestDetail["state"]) {
  const options = pullRequestDetailQueryOptions({
    environmentId: EnvironmentId.make("environment-a"),
    reference: REFERENCE,
    ...(attended === undefined ? {} : { attended }),
  });
  const refetchInterval = options.refetchInterval as (query: unknown) => number | false;
  // Checks long settled and nothing armed: nothing in motion.
  const data = {
    state,
    checks: [{ name: "build", status: "success" }],
    mergeability: "mergeable",
    updatedAt: "2026-01-01T00:00:00.000Z",
    autoMergeEnabled: false,
  } as unknown as PullRequestDetail;
  return refetchInterval({ state: { data, status: "success" } });
}

describe("the environments the page asks", () => {
  // The page seats a pull request two computers both list with whichever is
  // asked first, so an id that sorts first must not pull rows off this device.
  it("asks this device first, however the other computers' ids sort", () => {
    const here = { environmentId: EnvironmentId.make("zz-this-mac"), label: "MacBook" };
    const pc = { environmentId: EnvironmentId.make("aa-windows"), label: "DESKTOP" };
    const laptop = { environmentId: EnvironmentId.make("mm-laptop"), label: "Laptop" };

    expect(
      orderPullRequestEnvironments({ primary: here, others: [laptop, pc] }).map(
        (environment) => environment.label,
      ),
    ).toEqual(["MacBook", "DESKTOP", "Laptop"]);
  });
});

describe("pull request detail reads", () => {
  it("keep an open pull request current only while someone looks at it", () => {
    expect(pace(true, "open")).toBe(PULL_REQUEST_ON_SCREEN_POLL_INTERVAL_MS);
    expect(pace(false, "open")).toBe(false);
    // A merged one never changes again, looked at or not.
    expect(pace(true, "merged")).toBe(false);
    // A surface that does not say whether it is looked at reads nothing settled on a timer.
    expect(pace(undefined, "open")).toBe(false);
  });
});

describe("a listing after one of its pull requests settled", () => {
  it("reads past the server's cached listing once", async () => {
    const list = vi.fn(async () => ({ viewer: null, entries: [], errors: [] }));
    vi.mocked(ensureEnvironmentApi).mockReturnValue({ pullRequests: { list } } as never);
    const queryClient = new QueryClient();
    const merged = { environmentId: EnvironmentId.make("environment-a"), state: "merged" } as const;

    markPullRequestListSettled(queryClient, merged);
    await queryClient.fetchQuery(pullRequestListQueryOptions(merged));
    await queryClient.fetchQuery({ ...pullRequestListQueryOptions(merged), staleTime: 0 });

    expect(list.mock.calls).toEqual([[{ state: "merged", force: true }], [{ state: "merged" }]]);
  });
});

describe("refreshing a pull request", () => {
  it("goes past a read already on its way instead of joining it", async () => {
    let answerSlowRead: (detail: unknown) => void = () => undefined;
    const detail = vi.fn((input: { readonly force?: boolean }) =>
      input.force
        ? Promise.resolve({ state: "merged" })
        : new Promise((resolve) => {
            answerSlowRead = resolve;
          }),
    );
    const activity = vi.fn(async () => ({
      comments: [],
      commits: [],
      reviewThreads: [],
      reactions: [],
    }));
    vi.mocked(ensureEnvironmentApi).mockReturnValue({
      pullRequests: { detail, activity },
    } as never);
    const queryClient = new QueryClient();
    const input = { environmentId: EnvironmentId.make("environment-a"), reference: REFERENCE };

    void queryClient.fetchQuery(pullRequestDetailQueryOptions(input)).catch(() => undefined);
    const refreshed = refreshPullRequest(queryClient, input);
    // The read from before answers late; it no longer counts.
    answerSlowRead({ state: "open" });
    await refreshed;

    expect(detail).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }));
    expect(
      queryClient.getQueryData(pullRequestQueryKeys.detail(input.environmentId, REFERENCE)),
    ).toEqual({ state: "merged" });
  });

  it("reads again a patch whose first read it cut short", async () => {
    const detail = vi.fn(async () => ({ state: "open" }));
    const activity = vi.fn(async () => ({
      comments: [],
      commits: [],
      reviewThreads: [],
      reactions: [],
    }));
    const diff = vi.fn((input: { readonly force?: boolean }) =>
      input.force ? Promise.resolve({ files: [] }) : new Promise(() => undefined),
    );
    vi.mocked(ensureEnvironmentApi).mockReturnValue({
      pullRequests: { detail, activity, diff },
    } as never);
    const queryClient = new QueryClient();
    const input = { environmentId: EnvironmentId.make("environment-a"), reference: REFERENCE };

    // The Code tab's first read is still on its way.
    void queryClient.fetchQuery(pullRequestDiffQueryOptions(input)).catch(() => undefined);
    await refreshPullRequest(queryClient, input);

    expect(diff).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }));
    expect(
      queryClient.getQueryData(pullRequestQueryKeys.diff(input.environmentId, REFERENCE)),
    ).toEqual({ files: [] });
  });
});

describe("pull request action invalidation", () => {
  it("settles as soon as the pull request's own detail refreshes, without waiting on workspace listings", async () => {
    const environmentId = EnvironmentId.make("environment-a");
    let finishList = () => {};
    let listCalls = 0;
    const list = vi.fn(
      () =>
        new Promise((resolve) => {
          listCalls += 1;
          if (listCalls === 1) {
            resolve({ viewer: null, entries: [], errors: [] });
            return;
          }
          finishList = () => resolve({ viewer: null, entries: [], errors: [] });
        }),
    );
    const detail = vi.fn(async () => ({
      state: "open",
      autoMergeEnabled: true,
      checks: [],
      mergeability: "mergeable",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    const runAction = vi.fn(async () => ({ state: "open", isDraft: false }));
    vi.mocked(ensureEnvironmentApi).mockReturnValue({
      pullRequests: { list, detail, runAction },
    } as never);

    const queryClient = new QueryClient();
    const listOptions = pullRequestListQueryOptions({ environmentId, state: "open" });
    const detailOptions = pullRequestDetailQueryOptions({ environmentId, reference: REFERENCE });
    const listObserver = new QueryObserver(queryClient, listOptions);
    const detailObserver = new QueryObserver(queryClient, detailOptions);
    const unsubList = listObserver.subscribe(() => undefined);
    const unsubDetail = detailObserver.subscribe(() => undefined);
    await queryClient.fetchQuery(listOptions);
    await queryClient.fetchQuery(detailOptions);

    const options = pullRequestActionMutationOptions({
      environmentId,
      reference: REFERENCE,
      queryClient,
    });
    const result = await options.mutationFn!(
      { action: "enable-auto-merge", mergeMethod: "squash" },
      undefined as never,
    );
    expect(result).toEqual({ state: "open", isDraft: false });

    // `onSuccess` must resolve once `detail` refreshes, even while the active
    // `list` query is still fetching in the background.
    await options.onSuccess!(
      result,
      { action: "enable-auto-merge", mergeMethod: "squash" },
      undefined,
      undefined as never,
    );
    expect(detail).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(2);
    expect(
      queryClient.getQueryState(pullRequestQueryKeys.list(environmentId, "open"))?.fetchStatus,
    ).toBe("fetching");
    finishList();
    unsubDetail();
    unsubList();
    listObserver.destroy();
    detailObserver.destroy();
  });
});
