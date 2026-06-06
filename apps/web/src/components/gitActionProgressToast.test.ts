import type { GitActionProgressEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  applyGitActionProgressEvent,
  createGitActionProgress,
  formatGitActionElapsedDescription,
  getGitActionProgressView,
  resolveGitActionProgressDescription,
} from "./gitActionProgressToast";

function progressEvent(event: Record<string, unknown>): GitActionProgressEvent {
  return {
    actionId: "action-1",
    cwd: "/repo/project",
    action: "commit_push",
    ...event,
  } as GitActionProgressEvent;
}

describe("git action progress toast", () => {
  it("formats elapsed descriptions", () => {
    expect(formatGitActionElapsedDescription(null, 1_000)).toBeUndefined();
    expect(formatGitActionElapsedDescription(1_000, 8_900)).toBe("Running for 7s");
    expect(formatGitActionElapsedDescription(1_000, 71_000)).toBe("Running for 1m 10s");
  });

  it("applies streamed phase, hook, and output events", () => {
    const progress = createGitActionProgress({
      toastId: "toast-1" as never,
      toastData: undefined,
      actionId: "action-1",
      initialTitle: "Generating commit message...",
    });

    expect(
      applyGitActionProgressEvent(
        progress,
        progressEvent({ kind: "phase_started", phase: "commit", label: "Committing..." }),
        { cwd: "/repo/project", nowMs: 1_000 },
      ),
    ).toBe(true);
    expect(getGitActionProgressView(progress)).toMatchObject({
      title: "Committing...",
      hookName: null,
    });
    expect(resolveGitActionProgressDescription(progress, 5_500)).toBe("Running for 4s");

    expect(
      applyGitActionProgressEvent(
        progress,
        progressEvent({ kind: "hook_started", hookName: "pre-commit" }),
        { cwd: "/repo/project", nowMs: 6_000 },
      ),
    ).toBe(true);
    expect(getGitActionProgressView(progress).title).toBe("Running pre-commit...");

    expect(
      applyGitActionProgressEvent(
        progress,
        progressEvent({
          kind: "hook_output",
          hookName: "pre-commit",
          stream: "stdout",
          text: "bun lint",
        }),
        { cwd: "/repo/project", nowMs: 7_000 },
      ),
    ).toBe(true);
    expect(getGitActionProgressView(progress).description).toBe("bun lint");

    expect(
      applyGitActionProgressEvent(
        progress,
        progressEvent({
          kind: "hook_finished",
          hookName: "pre-commit",
          exitCode: 0,
          durationMs: 1_200,
        }),
        { cwd: "/repo/project", nowMs: 8_000 },
      ),
    ).toBe(true);
    expect(getGitActionProgressView(progress)).toMatchObject({
      title: "Committing...",
      hookName: null,
    });
  });

  it("ignores unrelated and terminal events", () => {
    const progress = createGitActionProgress({
      toastId: "toast-1" as never,
      toastData: undefined,
      actionId: "action-1",
      initialTitle: "Pushing...",
    });

    expect(
      applyGitActionProgressEvent(
        progress,
        {
          ...progressEvent({ kind: "phase_started", phase: "push", label: "Pushing..." }),
          actionId: "action-2",
        },
        { cwd: "/repo/project", nowMs: 1_000 },
      ),
    ).toBe(false);
    expect(
      applyGitActionProgressEvent(
        progress,
        progressEvent({ kind: "phase_started", phase: "push", label: "Pushing..." }),
        { cwd: "/other/repo", nowMs: 1_000 },
      ),
    ).toBe(false);
    expect(
      applyGitActionProgressEvent(
        progress,
        progressEvent({ kind: "action_failed", phase: "push", message: "Push failed." }),
        { cwd: "/repo/project", nowMs: 1_000 },
      ),
    ).toBe(false);
    expect(getGitActionProgressView(progress).title).toBe("Pushing...");
  });
});
