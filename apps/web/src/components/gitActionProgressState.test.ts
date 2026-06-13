import { EnvironmentId, type GitActionProgressEvent } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import {
  dispatchGitActionProgressEvent,
  finishGitActionProgress,
  getGitActionProgressViewSnapshot,
  resetGitActionProgressStateForTests,
  startGitActionProgress,
} from "./gitActionProgressState";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const TARGET = { environmentId: ENVIRONMENT_ID, cwd: "/repo/project" } as const;
const OTHER_TARGET = { environmentId: ENVIRONMENT_ID, cwd: "/repo/other" } as const;
const NULL_TARGET = { environmentId: null, cwd: null } as const;

function progressEvent(event: Record<string, unknown>): GitActionProgressEvent {
  return {
    actionId: "action-1",
    cwd: "/repo/project",
    action: "commit_push",
    ...event,
  } as GitActionProgressEvent;
}

afterEach(() => {
  resetGitActionProgressStateForTests();
  resetAppAtomRegistryForTests();
  vi.useRealTimers();
});

describe("gitActionProgressState", () => {
  it("publishes the initial view for the started target only", () => {
    startGitActionProgress(TARGET, {
      actionId: "action-1",
      initialTitle: "Generating commit message...",
    });

    expect(getGitActionProgressViewSnapshot(TARGET)).toEqual({
      title: "Generating commit message...",
      description: undefined,
      hookName: null,
    });
    expect(getGitActionProgressViewSnapshot(OTHER_TARGET)).toBeNull();
    expect(getGitActionProgressViewSnapshot(NULL_TARGET)).toBeNull();
  });

  it("applies progress events and ticks elapsed time while active", () => {
    vi.useFakeTimers();
    startGitActionProgress(TARGET, {
      actionId: "action-1",
      initialTitle: "Generating commit message...",
    });

    dispatchGitActionProgressEvent(
      TARGET,
      progressEvent({ kind: "phase_started", phase: "commit", label: "Committing..." }),
    );
    expect(getGitActionProgressViewSnapshot(TARGET)?.title).toBe("Committing...");

    vi.advanceTimersByTime(2_000);
    expect(getGitActionProgressViewSnapshot(TARGET)?.description).toBe("Running for 2s");
  });

  it("ignores events from other actions or directories", () => {
    startGitActionProgress(TARGET, { actionId: "action-1", initialTitle: "Committing..." });

    dispatchGitActionProgressEvent(
      TARGET,
      progressEvent({
        kind: "phase_started",
        phase: "push",
        label: "Pushing...",
        actionId: "action-2",
      }),
    );
    dispatchGitActionProgressEvent(
      TARGET,
      progressEvent({
        kind: "phase_started",
        phase: "push",
        label: "Pushing...",
        cwd: "/repo/other",
      }),
    );

    expect(getGitActionProgressViewSnapshot(TARGET)?.title).toBe("Committing...");
  });

  it("clears the view only when the finishing action matches", () => {
    vi.useFakeTimers();
    startGitActionProgress(TARGET, { actionId: "action-1", initialTitle: "Committing..." });

    finishGitActionProgress(TARGET, "action-2");
    expect(getGitActionProgressViewSnapshot(TARGET)).not.toBeNull();

    finishGitActionProgress(TARGET, "action-1");
    expect(getGitActionProgressViewSnapshot(TARGET)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tracks targets independently", () => {
    startGitActionProgress(TARGET, { actionId: "action-1", initialTitle: "Committing..." });
    startGitActionProgress(OTHER_TARGET, { actionId: "action-2", initialTitle: "Pushing..." });

    finishGitActionProgress(TARGET, "action-1");

    expect(getGitActionProgressViewSnapshot(TARGET)).toBeNull();
    expect(getGitActionProgressViewSnapshot(OTHER_TARGET)?.title).toBe("Pushing...");
  });
});
