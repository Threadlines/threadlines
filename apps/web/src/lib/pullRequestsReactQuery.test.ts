import { EnvironmentId, ProjectId, type PullRequestDetail } from "@threadlines/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vite-plus/test";

import { ensureEnvironmentApi } from "../environmentApi";

vi.mock("../environmentApi", () => ({
  ensureEnvironmentApi: vi.fn(),
}));

import {
  markPullRequestListSettled,
  PULL_REQUEST_ON_SCREEN_POLL_INTERVAL_MS,
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
