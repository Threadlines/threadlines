import { EnvironmentId, ProjectId, type PullRequestDetail } from "@threadlines/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../environmentApi", () => ({
  ensureEnvironmentApi: vi.fn(),
}));

import {
  PULL_REQUEST_ON_SCREEN_POLL_INTERVAL_MS,
  pullRequestDetailQueryOptions,
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
