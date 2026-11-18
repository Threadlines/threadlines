import {
  type OrchestrationThread,
  ProviderDriverKind,
  TextGenerationError,
  ThreadId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import {
  makeThreadContextSeedBuilder,
  type ThreadHandoffSummarize,
} from "./ThreadContextSeedBuilder.ts";

const THREAD_ID = ThreadId.make("thread-1");
const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const unusedProjectionQueryMethod = () => Effect.die("unused projection snapshot query method");

interface FakeMessage {
  readonly id?: string | undefined;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly createdAt: string;
}

interface FakeActivity {
  readonly tone: string;
  readonly summary: string;
  readonly createdAt: string;
}

function fakeThread(messages: FakeMessage[], activities: FakeActivity[]): OrchestrationThread {
  return { messages, activities } as unknown as OrchestrationThread;
}

function fakeSnapshotQuery(thread: OrchestrationThread | null): ProjectionSnapshotQueryShape {
  return {
    getProjectCatalog: unusedProjectionQueryMethod,
    getCommandReadModel: unusedProjectionQueryMethod,
    getSnapshot: unusedProjectionQueryMethod,
    listRunningWorkflowRuns: () => Effect.succeed([]),
    listArchivedThreadsLiveState: () => Effect.succeed([]),
    getShellSnapshot: unusedProjectionQueryMethod,
    getArchivedShellSnapshot: unusedProjectionQueryMethod,
    getSnapshotSequence: unusedProjectionQueryMethod,
    getCounts: unusedProjectionQueryMethod,
    getActiveProjectByWorkspaceRoot: unusedProjectionQueryMethod,
    isProjectPhoneAlertsMuted: () => Effect.succeed(false),
    getProjectShellById: unusedProjectionQueryMethod,
    getFirstActiveThreadIdByProjectId: unusedProjectionQueryMethod,
    getThreadCheckpointContext: unusedProjectionQueryMethod,
    getFullThreadDiffContext: unusedProjectionQueryMethod,
    listThreadDiffStatBaselines: unusedProjectionQueryMethod,
    listThreadTurnOverlapsSince: unusedProjectionQueryMethod,
    listThreadIdsWithOpenAgentRequests: unusedProjectionQueryMethod,
    listClaimedSettingsChanges: unusedProjectionQueryMethod,
    listSecretRequests: unusedProjectionQueryMethod,
    listThreadShells: () => Effect.succeed([]),
    getThreadShellById: unusedProjectionQueryMethod,
    getTurnActivities: () => Effect.succeed([]),
    getThreadMessage: () => Effect.succeed(Option.none()),
    hasAssistantMessageForTurn: () => Effect.succeed(false),
    getThreadDetailById: () =>
      Effect.succeed(thread === null ? Option.none() : Option.some(thread)),
  };
}

function failingSnapshotQuery(): ProjectionSnapshotQueryShape {
  return {
    getProjectCatalog: unusedProjectionQueryMethod,
    getCommandReadModel: unusedProjectionQueryMethod,
    getSnapshot: unusedProjectionQueryMethod,
    listRunningWorkflowRuns: () => Effect.succeed([]),
    listArchivedThreadsLiveState: () => Effect.succeed([]),
    getShellSnapshot: unusedProjectionQueryMethod,
    getArchivedShellSnapshot: unusedProjectionQueryMethod,
    getSnapshotSequence: unusedProjectionQueryMethod,
    getCounts: unusedProjectionQueryMethod,
    getActiveProjectByWorkspaceRoot: unusedProjectionQueryMethod,
    isProjectPhoneAlertsMuted: () => Effect.succeed(false),
    getProjectShellById: unusedProjectionQueryMethod,
    getFirstActiveThreadIdByProjectId: unusedProjectionQueryMethod,
    getThreadCheckpointContext: unusedProjectionQueryMethod,
    getFullThreadDiffContext: unusedProjectionQueryMethod,
    listThreadDiffStatBaselines: unusedProjectionQueryMethod,
    listThreadTurnOverlapsSince: unusedProjectionQueryMethod,
    listThreadIdsWithOpenAgentRequests: unusedProjectionQueryMethod,
    listClaimedSettingsChanges: unusedProjectionQueryMethod,
    listSecretRequests: unusedProjectionQueryMethod,
    listThreadShells: () => Effect.succeed([]),
    getThreadShellById: unusedProjectionQueryMethod,
    getTurnActivities: () => Effect.succeed([]),
    getThreadMessage: () => Effect.succeed(Option.none()),
    hasAssistantMessageForTurn: () => Effect.succeed(false),
    getThreadDetailById: () =>
      Effect.fail(
        new PersistenceSqlError({
          operation: "test.getThreadDetailById",
          detail: "read model unavailable",
        }),
      ),
  };
}

function build(input: {
  readonly thread: OrchestrationThread | null;
  readonly cwd?: string;
  readonly summarize?: ThreadHandoffSummarize;
  readonly budget?: { maxChars: number; recencyWindow: number };
  readonly excludeMessageId?: string;
  readonly snapshotQuery?: ProjectionSnapshotQueryShape;
}) {
  const builder = makeThreadContextSeedBuilder({
    snapshotQuery: input.snapshotQuery ?? fakeSnapshotQuery(input.thread),
    ...(input.summarize ? { summarize: input.summarize } : {}),
  });
  return Effect.runPromise(
    builder.build({
      threadId: THREAD_ID,
      fromProvider: CODEX,
      toProvider: CLAUDE,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.budget ? { budget: input.budget } : {}),
      ...(input.excludeMessageId ? { excludeMessageId: input.excludeMessageId } : {}),
    }),
  );
}

describe("ThreadContextSeedBuilder", () => {
  it("interleaves messages and tool activities oldest-first", async () => {
    const thread = fakeThread(
      [
        { role: "user", text: "add login", createdAt: "2026-01-01T00:00:00Z" },
        { role: "assistant", text: "done", createdAt: "2026-01-01T00:00:03Z" },
      ],
      [{ tone: "tool", summary: "Edited Login.tsx", createdAt: "2026-01-01T00:00:02Z" }],
    );
    const seed = await build({ thread, cwd: "/tmp/ws" });
    expect(Option.isSome(seed)).toBe(true);
    const value = Option.getOrThrow(seed);
    expect(value.fromProvider).toBe("codex");
    expect(value.entries.map((entry) => entry.text)).toEqual([
      "add login",
      "Edited Login.tsx",
      "done",
    ]);
    expect(value.entries[1]?.kind).toBe("tool");
    expect(value.workspacePointer).toContain("/tmp/ws");
    expect(value.olderSummary).toBeUndefined();
  });

  it("skips non-tool activities and empty text", async () => {
    const thread = fakeThread(
      [
        { role: "assistant", text: "  ", createdAt: "2026-01-01T00:00:01Z" },
        { role: "user", text: "real message", createdAt: "2026-01-01T00:00:00Z" },
      ],
      [
        { tone: "thinking", summary: "pondering", createdAt: "2026-01-01T00:00:02Z" },
        { tone: "error", summary: "tests failed", createdAt: "2026-01-01T00:00:03Z" },
      ],
    );
    const seed = await build({ thread });
    const value = Option.getOrThrow(seed);
    expect(value.entries).toHaveLength(1);
    expect(value.entries[0]?.text).toBe("real message");
  });

  it("returns None when there is no transcript and no workspace pointer", async () => {
    const seed = await build({ thread: fakeThread([], []) });
    expect(Option.isNone(seed)).toBe(true);
  });

  it("excludes the current user message from a handoff seed", async () => {
    const thread = fakeThread(
      [
        {
          id: "old-message",
          role: "user",
          text: "previous context",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "current-message",
          role: "user",
          text: "switch providers now",
          createdAt: "2026-01-01T00:00:01Z",
        },
      ],
      [],
    );
    const seed = await build({ thread, excludeMessageId: "current-message" });
    const value = Option.getOrThrow(seed);
    expect(value.entries.map((entry) => entry.text)).toEqual(["previous context"]);
  });

  it("holds only messages an agent was given: never a queued or not-sent message", async () => {
    const thread = {
      ...fakeThread(
        [
          { id: "ran", role: "user", text: "passed on, ran", createdAt: "2026-01-01T00:00:00Z" },
          // A room hand-off that ran, later cancelled with its agent: it was given.
          {
            id: "hand-off",
            role: "user",
            text: "hand-off that ran",
            requestOutcome: "cancelled",
            createdAt: "2026-01-01T00:00:01Z",
          } as FakeMessage,
          { id: "queued", role: "user", text: "still waiting", createdAt: "2026-01-01T00:00:02Z" },
          {
            id: "refused",
            role: "user",
            text: "refused at its ceiling",
            notSent: true,
            createdAt: "2026-01-01T00:00:03Z",
          } as FakeMessage,
          // An outside agent's message whose turn never ran.
          {
            id: "outside-refused",
            role: "user",
            text: "outside, never ran",
            fromOutside: { connectionId: "connection-1", name: "Claude Code" },
            notSent: true,
            createdAt: "2026-01-01T00:00:03.5Z",
          } as FakeMessage,
          { id: "current", role: "user", text: "switch now", createdAt: "2026-01-01T00:00:04Z" },
        ],
        [],
      ),
      queuedFollowUps: [{ messageId: "queued" }],
    } as unknown as OrchestrationThread;
    const seed = await build({ thread, excludeMessageId: "current" });
    expect(Option.getOrThrow(seed).entries.map((entry) => entry.text)).toEqual([
      "passed on, ran",
      "hand-off that ran",
    ]);
  });

  it("returns a workspace-only seed when the thread detail read fails", async () => {
    const seed = await build({
      thread: null,
      cwd: "/tmp/ws",
      snapshotQuery: failingSnapshotQuery(),
    });
    expect(Option.isSome(seed)).toBe(true);
    const value = Option.getOrThrow(seed);
    expect(value.entries).toEqual([]);
    expect(value.workspacePointer).toContain("/tmp/ws");
  });

  it("falls back to a truncation marker for over-budget history without a summarizer", async () => {
    const messages: FakeMessage[] = Array.from({ length: 8 }, (_, i) => ({
      role: "user" as const,
      text: `message number ${i} ${"x".repeat(60)}`,
      createdAt: `2026-01-01T00:00:0${i}Z`,
    }));
    const seed = await build({
      thread: fakeThread(messages, []),
      budget: { maxChars: 120, recencyWindow: 2 },
    });
    const value = Option.getOrThrow(seed);
    expect(value.olderSummary).toMatch(/earlier messages? omitted/);
    // recency floor keeps the most recent entries verbatim
    expect(value.entries.at(-1)?.text).toContain("message number 7");
  });

  it("uses the injected summarizer for the older prefix", async () => {
    const messages: FakeMessage[] = Array.from({ length: 8 }, (_, i) => ({
      role: "user" as const,
      text: `message number ${i} ${"x".repeat(60)}`,
      createdAt: `2026-01-01T00:00:0${i}Z`,
    }));
    const summarize: ThreadHandoffSummarize = () => Effect.succeed("COMPACTED PREFIX");
    const seed = await build({
      thread: fakeThread(messages, []),
      budget: { maxChars: 120, recencyWindow: 2 },
      summarize,
    });
    expect(Option.getOrThrow(seed).olderSummary).toBe("COMPACTED PREFIX");
  });

  it("falls back to a truncation marker when the summarizer fails", async () => {
    const messages: FakeMessage[] = Array.from({ length: 8 }, (_, i) => ({
      role: "user" as const,
      text: `message number ${i} ${"x".repeat(60)}`,
      createdAt: `2026-01-01T00:00:0${i}Z`,
    }));
    const summarize: ThreadHandoffSummarize = () =>
      Effect.fail(
        new TextGenerationError({ operation: "handoffSummary", detail: "model timeout" }),
      );
    const seed = await build({
      thread: fakeThread(messages, []),
      budget: { maxChars: 120, recencyWindow: 2 },
      summarize,
    });
    expect(Option.getOrThrow(seed).olderSummary).toMatch(/earlier messages? omitted/);
  });
});
