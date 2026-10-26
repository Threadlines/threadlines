import { EnvironmentId, type PullRequestObservation } from "@threadlines/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  readPullRequestRecord,
  receivePullRequestRecord,
  usePullRequestRecordsStore,
} from "./pullRequestRecordsStore";

const ENVIRONMENT = EnvironmentId.make("environment-a");

const record = (overrides: Partial<PullRequestObservation>): PullRequestObservation => ({
  provider: "github",
  repository: "Owner/Repo",
  number: 42,
  sequence: 1,
  observedAt: "2026-10-26T10:00:00.000Z",
  title: "Fix it",
  url: "https://github.com/Owner/Repo/pull/42",
  headBranch: "fix-it",
  state: "open",
  ...overrides,
});

describe("receivePullRequestRecord", () => {
  beforeEach(() => {
    usePullRequestRecordsStore.setState({ byEnvironmentId: {} });
  });

  it("keeps the newer read, even from a computer that restarted its count", () => {
    receivePullRequestRecord(ENVIRONMENT, record({ sequence: 900, state: "open" }));
    // After a restart the computer counts from 1 again; its read is still newer.
    const merged = receivePullRequestRecord(
      ENVIRONMENT,
      record({ sequence: 1, observedAt: "2026-10-26T10:05:00.000Z", state: "merged" }),
    );
    expect(merged).toMatchObject({ kept: true, previous: { state: "open" } });
    // An older read arriving late is turned away.
    const late = receivePullRequestRecord(
      ENVIRONMENT,
      record({ sequence: 2, observedAt: "2026-10-26T09:00:00.000Z", state: "open" }),
    );
    expect(late.kept).toBe(false);
    expect(readPullRequestRecord(ENVIRONMENT, "owner/repo", 42)?.state).toBe("merged");
  });
});
