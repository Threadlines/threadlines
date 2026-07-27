import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@threadlines/contracts";
import type { Thread } from "../types";
import { getLatestThreadForProject, selectActiveAndRecentThreads, sortThreads } from "./threadSort";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: LOCAL_ENVIRONMENT_ID,
    codexThreadId: null,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    effectiveCwd: null,
    goal: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("sortThreads", () => {
  it("sorts threads by the latest user message in recency mode", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: ThreadId.make("thread-1"),
          updatedAt: "2026-03-09T10:10:00.000Z",
          messages: [
            {
              id: "message-1" as never,
              role: "user",
              text: "older",
              createdAt: "2026-03-09T10:01:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:01:00.000Z",
            },
          ],
        }),
        makeThread({
          id: ThreadId.make("thread-2"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
          messages: [
            {
              id: "message-2" as never,
              role: "user",
              text: "newer",
              createdAt: "2026-03-09T10:06:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:06:00.000Z",
            },
          ],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-2"),
      ThreadId.make("thread-1"),
    ]);
  });

  it("falls back to thread timestamps when there is no user message", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: ThreadId.make("thread-1"),
          updatedAt: "2026-03-09T10:01:00.000Z",
          messages: [
            {
              id: "message-1" as never,
              role: "assistant",
              text: "assistant only",
              createdAt: "2026-03-09T10:02:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:02:00.000Z",
            },
          ],
        }),
        makeThread({
          id: ThreadId.make("thread-2"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-2"),
      ThreadId.make("thread-1"),
    ]);
  });

  it("falls back to id ordering when threads have no sortable timestamps", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: ThreadId.make("thread-1"),
          createdAt: "" as never,
          updatedAt: undefined,
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-2"),
          createdAt: "" as never,
          updatedAt: undefined,
          messages: [],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-2"),
      ThreadId.make("thread-1"),
    ]);
  });

  it("can sort threads by createdAt when configured", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: ThreadId.make("thread-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-2"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:10:00.000Z",
        }),
      ],
      "created_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-1"),
      ThreadId.make("thread-2"),
    ]);
  });

  it("keeps pinned threads ahead of unpinned threads", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: ThreadId.make("thread-recent-unpinned"),
          updatedAt: "2026-03-09T10:10:00.000Z",
          messages: [
            {
              id: "message-recent-unpinned" as never,
              role: "user",
              text: "recent",
              createdAt: "2026-03-09T10:10:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:10:00.000Z",
            },
          ],
        }),
        makeThread({
          id: ThreadId.make("thread-older-pinned"),
          updatedAt: "2026-03-09T10:00:00.000Z",
          messages: [
            {
              id: "message-older-pinned" as never,
              role: "user",
              text: "older",
              createdAt: "2026-03-09T10:00:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:00:00.000Z",
            },
          ],
          pinnedAt: "2026-03-09T10:11:00.000Z",
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-older-pinned"),
      ThreadId.make("thread-recent-unpinned"),
    ]);
  });

  it("returns the latest active thread for a project", () => {
    const latestThread = getLatestThreadForProject(
      [
        makeThread({
          id: ThreadId.make("thread-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:01:00.000Z",
          archivedAt: null,
        }),
        makeThread({
          id: ThreadId.make("thread-2"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:10:00.000Z",
          archivedAt: "2026-03-10T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-3"),
          createdAt: "2026-03-09T10:06:00.000Z",
          updatedAt: "2026-03-09T10:06:00.000Z",
          archivedAt: null,
        }),
      ],
      PROJECT_ID,
      "updated_at",
    );

    expect(latestThread?.id).toBe(ThreadId.make("thread-3"));
  });
});

describe("selectActiveAndRecentThreads", () => {
  it("shows every in-flight thread before filling the limit by true recency", () => {
    const session = {
      provider: ProviderDriverKind.make("codex"),
      status: "running" as const,
      orchestrationStatus: "running" as const,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
    };
    const makeTimestampedThread = (
      id: string,
      latestUserMessageAt: string,
      overrides: Partial<Thread> = {},
    ) =>
      makeThread({
        id: ThreadId.make(id),
        updatedAt: latestUserMessageAt,
        messages: [
          {
            id: `message-${id}` as never,
            role: "user",
            text: id,
            createdAt: latestUserMessageAt,
            streaming: false,
            completedAt: latestUserMessageAt,
          },
        ],
        ...overrides,
      });

    const threads = [
      makeTimestampedThread("pinned-1", "2026-03-09T09:01:00.000Z", {
        pinnedAt: "2026-03-09T10:11:00.000Z",
      }),
      makeTimestampedThread("pinned-2", "2026-03-09T09:02:00.000Z", {
        pinnedAt: "2026-03-09T10:11:00.000Z",
      }),
      makeTimestampedThread("pinned-3", "2026-03-09T09:03:00.000Z", {
        pinnedAt: "2026-03-09T10:11:00.000Z",
      }),
      makeTimestampedThread("pinned-4", "2026-03-09T09:04:00.000Z", {
        pinnedAt: "2026-03-09T10:11:00.000Z",
      }),
      makeTimestampedThread("running-newer", "2026-03-09T10:10:00.000Z", { session }),
      makeTimestampedThread("running-older", "2026-03-09T09:00:00.000Z", { session }),
      makeTimestampedThread("recent-unpinned", "2026-03-09T10:05:00.000Z"),
    ];
    const selected = selectActiveAndRecentThreads(threads, 5);

    expect(selected.map((thread) => thread.id)).toEqual([
      ThreadId.make("running-newer"),
      ThreadId.make("running-older"),
      ThreadId.make("recent-unpinned"),
      ThreadId.make("pinned-4"),
      ThreadId.make("pinned-3"),
    ]);
    expect(selectActiveAndRecentThreads(threads, 1).map((thread) => thread.id)).toEqual([
      ThreadId.make("running-newer"),
      ThreadId.make("running-older"),
    ]);
  });

  it("excludes archived threads and respects an empty limit", () => {
    const archived = makeThread({
      id: ThreadId.make("archived"),
      archivedAt: "2026-03-09T10:00:00.000Z",
    });

    expect(selectActiveAndRecentThreads([archived], 5)).toEqual([]);
    expect(selectActiveAndRecentThreads([makeThread()], 0)).toEqual([]);
  });
});
