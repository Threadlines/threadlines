import { EnvironmentId, ProjectId } from "@threadlines/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  resetPullRequestTabsForTests,
  usePullRequestTabsStore,
  type PullRequestTabTarget,
} from "./pullRequestTabsStore";

const ENVIRONMENT_ID = EnvironmentId.make("env-1");
const PROJECT_ID = ProjectId.make("project-1");

function target(number: number): PullRequestTabTarget {
  return {
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    repository: "threadlines/threadlines",
    number,
  };
}

const store = () => usePullRequestTabsStore.getState();
const numbers = () => store().tabs.map((tab) => tab.number);
const activeNumber = () => store().tabs.find((tab) => tab.id === store().activeId)?.number ?? null;

describe("pullRequestTabsStore", () => {
  beforeEach(() => {
    resetPullRequestTabsForTests();
  });

  it("opens a pull request once however often it is asked for", () => {
    store().open(target(1));
    store().open(target(2));
    store().open(target(1));

    expect(numbers()).toEqual([1, 2]);
    // The second press moves to the tab rather than adding one beside it.
    expect(activeNumber()).toBe(1);
  });

  it("closes the active tab onto its right neighbour, then the last, then nothing", () => {
    store().open(target(1));
    store().open(target(2));
    store().open(target(3));
    store().open(target(2));

    expect(store().close(store().activeId ?? "")?.number).toBe(3);
    expect(numbers()).toEqual([1, 3]);
    expect(activeNumber()).toBe(3);

    // Nothing to the right of the last tab, so the strip falls back to its end.
    expect(store().close(store().activeId ?? "")?.number).toBe(1);
    expect(activeNumber()).toBe(1);

    expect(store().close(store().activeId ?? "")).toBeNull();
    expect(numbers()).toEqual([]);
    expect(store().activeId).toBeNull();
  });

  it("leaves the active tab alone when a background one is closed", () => {
    const first = store().open(target(1));
    store().open(target(2));

    expect(store().close(first.id)?.number).toBe(2);
    expect(numbers()).toEqual([2]);
  });
});
