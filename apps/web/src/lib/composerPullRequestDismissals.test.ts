import { scopeThreadRef } from "@threadlines/client-runtime";
import { type DispatchResult, EnvironmentId, ThreadId } from "@threadlines/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { dispatchCommand } = vi.hoisted(() => ({ dispatchCommand: vi.fn() }));

vi.mock("../environmentApi", () => ({
  readEnvironmentApi: () => ({ orchestration: { dispatchCommand } }),
}));

import {
  __resetComposerPullRequestDismissalsForTests,
  isComposerPullRequestDismissed,
  readComposerPullRequestDismissalHolds,
  setComposerPullRequestDismissed,
  settleComposerPullRequestDismissals,
} from "./composerPullRequestDismissals";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const threadRef = scopeThreadRef(environmentId, threadId);
const NUMBER = 42;

/** Lets a settled dispatch run the handlers chained on it. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A dispatch the test answers itself, in whatever order it likes. */
function deferDispatch() {
  let resolve!: (result: DispatchResult) => void;
  let reject!: (error: Error) => void;
  dispatchCommand.mockImplementationOnce(
    () =>
      new Promise<DispatchResult>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      }),
  );
  // Writes go out from a queue, so each waits a tick for its request first.
  return {
    answer: async (sequence: number) => {
      await settle();
      resolve({ sequence });
      await settle();
    },
    refuse: async () => {
      await settle();
      reject(new Error("refused"));
      await settle();
    },
  };
}

/** What the composer shows for the row, given what the thread's shell says. */
function dismissed(serverDismissed: readonly number[]): boolean {
  return isComposerPullRequestDismissed({
    holds: readComposerPullRequestDismissalHolds(),
    threadRef,
    pullRequestNumber: NUMBER,
    serverDismissed,
  });
}

describe("composerPullRequestDismissals", () => {
  beforeEach(() => {
    dispatchCommand.mockReset();
    __resetComposerPullRequestDismissalsForTests();
  });

  it("lets the shell speak once it has caught up, even when it says otherwise", async () => {
    const close = deferDispatch();
    setComposerPullRequestDismissed(threadRef, NUMBER, true);
    expect(dismissed([])).toBe(true);
    await close.answer(10);
    expect(dismissed([])).toBe(true);

    // Reconnected after another device brought the row back: the snapshot is
    // past the write, so it wins over the click.
    settleComposerPullRequestDismissals({ environmentId, sequence: 12 });
    expect(dismissed([])).toBe(false);
  });

  it("keeps the latest click when an earlier one lands first", async () => {
    const show = deferDispatch();
    const close = deferDispatch();
    setComposerPullRequestDismissed(threadRef, NUMBER, false);
    setComposerPullRequestDismissed(threadRef, NUMBER, true);
    // The second write waits for the first, so a retried first write can
    // never land after it.
    await settle();
    expect(dispatchCommand).toHaveBeenCalledTimes(1);

    // The first click's write reaches the shell before the second's answer.
    await show.answer(10);
    expect(dispatchCommand).toHaveBeenCalledTimes(2);
    settleComposerPullRequestDismissals({ environmentId, threadId, sequence: 10 });
    expect(dismissed([])).toBe(true);

    await close.answer(11);
    expect(dismissed([])).toBe(true);
    settleComposerPullRequestDismissals({ environmentId, threadId, sequence: 11 });
    expect(dismissed([NUMBER])).toBe(true);
    expect(dismissed([])).toBe(false);
  });

  it("drops a click the server refuses", async () => {
    const close = deferDispatch();
    setComposerPullRequestDismissed(threadRef, NUMBER, true);
    expect(dismissed([])).toBe(true);
    await close.refuse();
    expect(dismissed([])).toBe(false);
  });
});
