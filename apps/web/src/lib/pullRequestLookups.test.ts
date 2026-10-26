import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../environmentApi", () => ({
  ensureEnvironmentApi: vi.fn(),
}));

import {
  EnvironmentId,
  ProjectId,
  type PullRequestLookupInput,
  type PullRequestLookupResult,
  type PullRequestState,
} from "@threadlines/contracts";

import { ensureEnvironmentApi } from "../environmentApi";
import { pullRequestLookupQueryOptions } from "./pullRequestLookups";

const ENVIRONMENT = EnvironmentId.make("environment-a");
const PROJECT = ProjectId.make("project-a");
const STATES: Record<number, PullRequestState> = { 1: "open", 2: "merged", 3: "closed" };

const lookupRequest = (number: number) => ({
  key: `pr-${number}`,
  environmentId: ENVIRONMENT,
  projectId: PROJECT,
  repository: "owner/repo",
  item: { number },
});

describe("pull request lookups", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-25T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks the host again only about answers that can still move", async () => {
    const asked: number[] = [];
    const lookup = vi.fn(
      async (input: PullRequestLookupInput): Promise<PullRequestLookupResult> => {
        const answers = input.items.map((item) => {
          const number = "number" in item ? item.number : 0;
          asked.push(number);
          return {
            item,
            answeredAt: new Date().toISOString(),
            pullRequest: {
              number,
              title: `Pull request ${number}`,
              url: `https://github.com/owner/repo/pull/${number}`,
              headBranch: `branch-${number}`,
              state: STATES[number] ?? "open",
              isDraft: false,
              additions: 1,
              deletions: 1,
              updatedAt: new Date().toISOString(),
              autoMergeEnabled: false,
            },
          };
        });
        return { supported: true, answers };
      },
    );
    vi.mocked(ensureEnvironmentApi).mockReturnValue({ pullRequests: { lookup } } as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // A surface mounting reads each row's answer, fetching only what is stale.
    const mount = () =>
      Promise.all(
        [1, 2, 3].map((number) =>
          client.fetchQuery(pullRequestLookupQueryOptions(lookupRequest(number))),
        ),
      );

    await mount();
    expect(asked.toSorted()).toEqual([1, 2, 3]);

    // A minute later: only the open one is asked about again.
    asked.length = 0;
    vi.setSystemTime(new Date("2026-10-25T12:01:00.000Z"));
    await mount();
    expect(asked).toEqual([1]);

    // Past the settled poll interval the closed one is due too; the merged one never is.
    asked.length = 0;
    vi.setSystemTime(new Date("2026-10-25T12:12:00.000Z"));
    await mount();
    expect(asked.toSorted()).toEqual([1, 3]);
  });
});
