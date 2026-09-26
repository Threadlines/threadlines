import type { PullRequestCheck } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  pullRequestArmedToMerge,
  pullRequestChecksInMotion,
  shouldPollPullRequestDetail,
} from "./pullRequestPolling.ts";

describe("pullRequestArmedToMerge", () => {
  it("counts a queue position as armed even once the instruction is gone", () => {
    expect(pullRequestArmedToMerge({ autoMergeEnabled: null, mergeQueue: { position: 2 } })).toBe(
      true,
    );
    expect(
      pullRequestArmedToMerge({ autoMergeEnabled: true, mergeQueue: { position: null } }),
    ).toBe(true);
    expect(pullRequestArmedToMerge({ autoMergeEnabled: false })).toBe(false);
  });
});

describe("shouldPollPullRequestDetail", () => {
  const now = Date.parse("2026-09-04T12:00:00.000Z");
  const check = (status: PullRequestCheck["status"]) => ({
    name: status,
    status,
    description: null,
    url: null,
  });
  const settled = {
    state: "open" as const,
    mergeability: "mergeable" as const,
    updatedAt: "2026-09-04T11:00:00.000Z",
    autoMergeEnabled: null,
  };

  it("polls while a check runs, and for a while after a push before any check exists", () => {
    expect(shouldPollPullRequestDetail({ ...settled, checks: [check("pending")] }, now)).toBe(true);
    expect(shouldPollPullRequestDetail({ ...settled, checks: [check("success")] }, now)).toBe(
      false,
    );
    expect(shouldPollPullRequestDetail({ ...settled, checks: [] }, now)).toBe(false);

    const justPushed = { ...settled, updatedAt: "2026-09-04T11:59:30.000Z" };
    expect(shouldPollPullRequestDetail({ ...justPushed, checks: [] }, now)).toBe(true);
    expect(
      shouldPollPullRequestDetail(
        { ...justPushed, mergeability: "unknown", checks: [check("success")] },
        now,
      ),
    ).toBe(true);
    // Checks that have arrived and settled end the watch early.
    expect(shouldPollPullRequestDetail({ ...justPushed, checks: [check("success")] }, now)).toBe(
      false,
    );
    expect(
      shouldPollPullRequestDetail({ ...justPushed, state: "merged" as const, checks: [] }, now),
    ).toBe(false);
  });

  it("keeps watching a pull request the host has taken into its merge queue", () => {
    const inQueue = { ...settled, checks: [check("success")] };
    const queued = { ...inQueue, mergeQueue: { position: 2 } };
    expect(shouldPollPullRequestDetail(queued, now)).toBe(true);
    expect(shouldPollPullRequestDetail({ ...inQueue, mergeQueue: { position: null } }, now)).toBe(
      false,
    );
    // The host landing it is not a check about to report: the server's
    // watcher keeps its quicker look for that.
    expect(pullRequestChecksInMotion(queued, now)).toBe(false);
  });

  it("keeps watching an armed pull request with nothing in its way", () => {
    // The host can take or merge it at any moment, and the composer's chip and
    // the sidebar badge are what say it happened.
    const armed = { ...settled, checks: [check("success")], autoMergeEnabled: true };
    expect(shouldPollPullRequestDetail({ ...armed, mergeGate: "clear" as const }, now)).toBe(true);
    expect(shouldPollPullRequestDetail(armed, now)).toBe(true);
    // Armed but blocked is a settled state: a review still owed does not
    // clear itself, and reading every twenty seconds would only find that out.
    expect(shouldPollPullRequestDetail({ ...armed, mergeGate: "blocked" as const }, now)).toBe(
      false,
    );
  });
});
