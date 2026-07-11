import {
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderStartReviewInput,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";

import { ProviderValidationError } from "./Errors.ts";
import {
  formatProviderReviewRequest,
  startProviderReviewForThread,
} from "./ProviderReviewCoordinator.ts";

const THREAD_ID = ThreadId.make("thread-review");
const PROJECT_ID = ProjectId.make("project-review");
const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const NOW = "2026-07-09T00:00:00.000Z";
const MODEL_SELECTION = {
  instanceId: CODEX_INSTANCE_ID,
  model: "gpt-5.6-sol",
} as const;

function makeThreadShell(
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Review commit",
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    effectiveCwd: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    pinnedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function reviewInput(overrides: Partial<ProviderStartReviewInput> = {}): ProviderStartReviewInput {
  return {
    threadId: THREAD_ID,
    target: { type: "commit", sha: "abc123", title: "Fix the bug" },
    delivery: "inline",
    cwd: "/tmp/review-project",
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access",
    ...overrides,
  };
}

function codexInstanceInfo() {
  return {
    instanceId: CODEX_INSTANCE_ID,
    driverKind: CODEX_DRIVER,
    displayName: "Codex",
    enabled: true,
    continuationIdentity: {
      driverKind: CODEX_DRIVER,
      continuationKey: "codex:instance:codex",
    },
  } as const;
}

describe("startProviderReviewForThread", () => {
  it("materializes a new draft before starting its first provider review", async () => {
    let threadShell: OrchestrationThreadShell | undefined;
    const commands: OrchestrationCommand[] = [];
    const startReview = vi.fn(() =>
      Effect.sync(() => {
        if (threadShell?.session) {
          threadShell = makeThreadShell({
            ...threadShell,
            session: {
              ...threadShell.session,
              providerThreadId: "provider-thread-from-runtime",
            },
          });
        }
        return {
          threadId: THREAD_ID,
          turnId: TurnId.make("turn-review"),
          reviewThreadId: "codex-review-thread",
          delivery: "inline" as const,
        };
      }),
    );
    const input = reviewInput({
      bootstrap: {
        projectId: PROJECT_ID,
        title: "Review: Fix the bug",
        modelSelection: MODEL_SELECTION,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        createdAt: NOW,
      },
    });

    const result = await Effect.runPromise(
      startProviderReviewForThread(input, {
        projectionSnapshotQuery: {
          getThreadShellById: () =>
            Effect.succeed(threadShell ? Option.some(threadShell) : Option.none()),
        },
        orchestrationEngine: {
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              if (command.type === "thread.create") {
                threadShell = makeThreadShell({
                  title: command.title,
                  modelSelection: command.modelSelection,
                  runtimeMode: command.runtimeMode,
                  interactionMode: command.interactionMode,
                  branch: command.branch,
                  worktreePath: command.worktreePath,
                  createdAt: command.createdAt,
                  updatedAt: command.createdAt,
                });
              } else if (command.type === "thread.session.set" && threadShell) {
                threadShell = makeThreadShell({
                  ...threadShell,
                  session: command.session,
                  updatedAt: command.createdAt,
                });
              }
              return { sequence: commands.length };
            }),
        },
        providerService: {
          getCapabilities: () =>
            Effect.succeed({ sessionModelSwitch: "in-session", reviewStart: "supported" }),
          getInstanceInfo: () => Effect.succeed(codexInstanceInfo()),
          startReview,
        },
      }),
    );

    expect(result.turnId).toBe("turn-review");
    expect(commands.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.message.user.record",
      "thread.session.set",
      "thread.session.set",
    ]);
    const reviewMessage = commands.find((command) => command.type === "thread.message.user.record");
    expect(reviewMessage).toMatchObject({
      type: "thread.message.user.record",
      threadId: THREAD_ID,
      text: "Review commit abc123: Fix the bug",
    });
    expect(startReview).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      target: input.target,
      delivery: "inline",
      cwd: "/tmp/review-project",
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
    });
    expect(threadShell?.session).toMatchObject({
      status: "running",
      activeTurnId: "turn-review",
      providerInstanceId: CODEX_INSTANCE_ID,
      providerThreadId: "provider-thread-from-runtime",
    });
  });

  it("rejects an unsupported provider before creating a draft or starting a session", async () => {
    const commands: OrchestrationCommand[] = [];
    const startReview = vi.fn(() => Effect.die("must not start"));
    const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
    const claudeDriver = ProviderDriverKind.make("claudeAgent");
    const input = reviewInput({
      modelSelection: { instanceId: claudeInstanceId, model: "claude-sonnet-4-6" },
      bootstrap: {
        projectId: PROJECT_ID,
        title: "Review: Fix the bug",
        modelSelection: { instanceId: claudeInstanceId, model: "claude-sonnet-4-6" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        createdAt: NOW,
      },
    });

    const error = await Effect.runPromise(
      Effect.flip(
        startProviderReviewForThread(input, {
          projectionSnapshotQuery: {
            getThreadShellById: () => Effect.succeed(Option.none()),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                return { sequence: commands.length };
              }),
          },
          providerService: {
            getCapabilities: () =>
              Effect.succeed({ sessionModelSwitch: "unsupported", reviewStart: "unsupported" }),
            getInstanceInfo: () =>
              Effect.succeed({
                instanceId: claudeInstanceId,
                driverKind: claudeDriver,
                displayName: "Claude",
                enabled: true,
                continuationIdentity: {
                  driverKind: claudeDriver,
                  continuationKey: "claudeAgent:instance:claudeAgent",
                },
              }),
            startReview,
          },
        }),
      ),
    );

    expect(error.message).toContain("does not support native code reviews");
    expect(commands).toEqual([]);
    expect(startReview).not.toHaveBeenCalled();
  });

  it("keeps an existing Claude session authoritative over a pending Codex selection", async () => {
    const commands: OrchestrationCommand[] = [];
    const startReview = vi.fn(() => Effect.die("must not start"));
    const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
    const claudeDriver = ProviderDriverKind.make("claudeAgent");
    const getCapabilities = vi.fn(() =>
      Effect.succeed({
        sessionModelSwitch: "unsupported" as const,
        reviewStart: "unsupported" as const,
      }),
    );
    const threadShell = makeThreadShell({
      modelSelection: { instanceId: claudeInstanceId, model: "claude-sonnet-4-6" },
      session: {
        threadId: THREAD_ID,
        status: "ready",
        providerName: "claudeAgent",
        providerInstanceId: claudeInstanceId,
        providerSessionId: "session-claude",
        providerThreadId: "provider-thread-claude",
        runtimeMode: "full-access",
        activeTurnId: null,
        pendingBackgroundTaskCount: 0,
        lastError: null,
        updatedAt: NOW,
      },
    });

    const error = await Effect.runPromise(
      Effect.flip(
        startProviderReviewForThread(reviewInput(), {
          projectionSnapshotQuery: {
            getThreadShellById: () => Effect.succeed(Option.some(threadShell)),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                return { sequence: commands.length };
              }),
          },
          providerService: {
            getCapabilities,
            getInstanceInfo: () =>
              Effect.succeed({
                instanceId: claudeInstanceId,
                driverKind: claudeDriver,
                displayName: "Claude",
                enabled: true,
                continuationIdentity: {
                  driverKind: claudeDriver,
                  continuationKey: "claudeAgent:instance:claudeAgent",
                },
              }),
            startReview,
          },
        }),
      ),
    );

    expect(error.message).toContain("does not support native code reviews");
    expect(getCapabilities).toHaveBeenCalledWith(claudeInstanceId);
    expect(commands).toEqual([]);
    expect(startReview).not.toHaveBeenCalled();
  });

  it("rejects a review while the provider session is still starting", async () => {
    const commands: OrchestrationCommand[] = [];
    const startReview = vi.fn(() => Effect.die("must not start"));
    const threadShell = makeThreadShell({
      session: {
        threadId: THREAD_ID,
        status: "starting",
        providerName: "codex",
        providerInstanceId: CODEX_INSTANCE_ID,
        providerSessionId: "session-1",
        providerThreadId: "provider-thread-1",
        runtimeMode: "full-access",
        activeTurnId: null,
        pendingBackgroundTaskCount: 0,
        lastError: null,
        updatedAt: NOW,
      },
    });

    const error = await Effect.runPromise(
      Effect.flip(
        startProviderReviewForThread(reviewInput(), {
          projectionSnapshotQuery: {
            getThreadShellById: () => Effect.succeed(Option.some(threadShell)),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                return { sequence: commands.length };
              }),
          },
          providerService: {
            getCapabilities: () =>
              Effect.succeed({ sessionModelSwitch: "in-session", reviewStart: "supported" }),
            getInstanceInfo: () => Effect.succeed(codexInstanceInfo()),
            startReview,
          },
        }),
      ),
    );

    expect(error.message).toContain("current provider turn");
    expect(commands).toEqual([]);
    expect(startReview).not.toHaveBeenCalled();
  });

  it("rejects a review while provider background tasks are still running", async () => {
    const commands: OrchestrationCommand[] = [];
    const startReview = vi.fn(() => Effect.die("must not start"));
    const threadShell = makeThreadShell({
      session: {
        threadId: THREAD_ID,
        status: "ready",
        providerName: "codex",
        providerInstanceId: CODEX_INSTANCE_ID,
        providerSessionId: "session-1",
        providerThreadId: "provider-thread-1",
        runtimeMode: "full-access",
        activeTurnId: null,
        pendingBackgroundTaskCount: 1,
        lastError: null,
        updatedAt: NOW,
      },
    });

    const error = await Effect.runPromise(
      Effect.flip(
        startProviderReviewForThread(reviewInput(), {
          projectionSnapshotQuery: {
            getThreadShellById: () => Effect.succeed(Option.some(threadShell)),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                return { sequence: commands.length };
              }),
          },
          providerService: {
            getCapabilities: () =>
              Effect.succeed({ sessionModelSwitch: "in-session", reviewStart: "supported" }),
            getInstanceInfo: () => Effect.succeed(codexInstanceInfo()),
            startReview,
          },
        }),
      ),
    );

    expect(error.message).toContain("background tasks");
    expect(commands).toEqual([]);
    expect(startReview).not.toHaveBeenCalled();
  });

  it("persists an error session when provider review startup fails", async () => {
    const commands: OrchestrationCommand[] = [];
    const providerFailure = new ProviderValidationError({
      operation: "ProviderService.startReview",
      issue: "Codex rejected the review request.",
    });

    const error = await Effect.runPromise(
      Effect.flip(
        startProviderReviewForThread(reviewInput(), {
          projectionSnapshotQuery: {
            getThreadShellById: () => Effect.succeed(Option.some(makeThreadShell())),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                return { sequence: commands.length };
              }),
          },
          providerService: {
            getCapabilities: () =>
              Effect.succeed({ sessionModelSwitch: "in-session", reviewStart: "supported" }),
            getInstanceInfo: () => Effect.succeed(codexInstanceInfo()),
            startReview: () => Effect.fail(providerFailure),
          },
        }),
      ),
    );

    expect(error.message).toContain("Codex rejected the review request");
    expect(commands.map((command) => command.type)).toEqual([
      "thread.message.user.record",
      "thread.session.set",
      "thread.session.set",
    ]);
    const errorCommand = commands.at(-1);
    expect(errorCommand?.type).toBe("thread.session.set");
    if (errorCommand?.type === "thread.session.set") {
      expect(errorCommand.session.status).toBe("error");
      expect(errorCommand.session.activeTurnId).toBeNull();
      expect(errorCommand.session.lastError).toContain("Codex rejected the review request");
    }
  });
});

describe("formatProviderReviewRequest", () => {
  it("describes each native review target as visible user input", () => {
    expect(formatProviderReviewRequest({ type: "uncommittedChanges" })).toBe(
      "Review the current working tree changes",
    );
    expect(formatProviderReviewRequest({ type: "baseBranch", branch: "main" })).toBe(
      "Review changes against main",
    );
    expect(
      formatProviderReviewRequest({
        type: "commit",
        sha: "1234567890abcdef",
        title: "Prevent stale review state",
      }),
    ).toBe("Review commit 1234567890ab: Prevent stale review state");
    expect(
      formatProviderReviewRequest({
        type: "custom",
        instructions: "Review only the cancellation path",
      }),
    ).toBe("Review only the cancellation path");
  });
});
