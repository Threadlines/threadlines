import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type PullRequestActionInput,
  type PullRequestActivity,
  type PullRequestCheck,
  type PullRequestDetail,
  type PullRequestMergeMethod,
  PullRequestServiceError,
  type VcsStatusRemoteResult,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { GitManager, type GitManagerShape } from "../../git/GitManager.ts";
import {
  PullRequestService,
  type PullRequestServiceShape,
} from "../../pullRequest/PullRequestService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { PullRequestAutomationWatcher } from "../Services/PullRequestAutomationWatcher.ts";
import { makePullRequestAutomationWatcherLive } from "./PullRequestAutomationWatcher.ts";

const NOW_ISO = "2026-05-04T10:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-auto-fix");
const THREAD_ID = ThreadId.make("thread-auto-fix");
const REPOSITORY = "acme/widgets";
const PR_NUMBER = 42;

function project(overrides: Partial<OrchestrationProjectShell> = {}): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    kind: "workspace",
    title: "Widgets",
    workspaceRoot: "/repos/widgets",
    repositoryIdentity: {
      canonicalKey: "github|acme/widgets",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/acme/widgets.git",
      },
      displayName: REPOSITORY,
      provider: "github",
      owner: "acme",
      name: "widgets",
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

function thread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Fix the widget",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "fix-the-widget",
    worktreePath: null,
    effectiveCwd: null,
    goal: null,
    latestTurn: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    archivedAt: null,
    pinnedAt: null,
    pullRequestAutoFix: true,
    pullRequestAutoMerge: null,
    linkedPullRequests: [],
    participants: [],
    doneOverride: null,
    lastSeenAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    parentThreadId: null,
    parentTurnId: null,
    attachedToParent: false,
    handedBackAt: null,
    handedBackTurnId: null,
    awaitedChildThreadCount: 0,
    pendingChildApproval: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    cumulativeDiffStat: null,
    diffStatBaselineTurnCount: 0,
    ...overrides,
  };
}

const OPEN_PULL_REQUEST: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: {
    number: PR_NUMBER,
    title: "Fix the widget",
    url: `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}`,
    baseRef: "main",
    headRef: "fix-the-widget",
    state: "open",
  },
};

function detail(checks: readonly PullRequestCheck[]): PullRequestDetail {
  return {
    provider: "github",
    projectId: PROJECT_ID,
    projectTitle: "Widgets",
    workspaceRoot: "/repos/widgets",
    repository: REPOSITORY,
    number: PR_NUMBER,
    title: "Fix the widget",
    body: "",
    url: `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}`,
    author: { login: "will", isBot: false, avatarUrl: null },
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    headBranch: "fix-the-widget",
    baseBranch: "main",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    mergedAt: null,
    closedAt: null,
    viewerIsAuthor: true,
    reviewers: [],
    labels: [],
    checks,
    checksState: checks.some((check) => check.status === "failure") ? "failure" : "success",
    viewer: { canWrite: true, canReview: false, canManage: true },
    mergeMethods: ["squash"],
    capabilities: {
      diff: true,
      comment: true,
      actions: [],
      mergeMethods: ["squash"],
      updateMethods: ["merge"],
      reactions: true,
      review: { inlineComment: true, reply: true, resolve: true, verdicts: ["comment"] },
      reviewers: { request: true, listCandidates: true },
      edit: { pullRequest: true, comment: true },
    },
    baseComparison: "up-to-date",
    behindBy: 0,
    autoMergeEnabled: false,
    isStacked: false,
    defaultBranch: "main",
  };
}

const PASSING_CHECK: PullRequestCheck = {
  name: "typecheck",
  status: "success",
  description: null,
  url: "https://github.com/acme/widgets/runs/1",
};
const FAILING_CHECK: PullRequestCheck = { ...PASSING_CHECK, status: "failure" };
const PENDING_CHECK: PullRequestCheck = { ...PASSING_CHECK, status: "pending" };

const RUNNING_TURN = {
  turnId: TurnId.make("turn-1"),
  state: "running",
  requestedAt: NOW_ISO,
  startedAt: NOW_ISO,
  completedAt: null,
  assistantMessageId: null,
} as const;

/** A pull request GitHub would merge right now, once its checks allow. */
function mergeable(checks: readonly PullRequestCheck[]): PullRequestDetail {
  const base = detail(checks);
  return {
    ...base,
    checksState: checks.some((check) => check.status === "pending")
      ? "pending"
      : checks.some((check) => check.status === "failure")
        ? "failure"
        : "success",
    mergeGate: "clear",
    capabilities: { ...base.capabilities, actions: ["merge"] },
  };
}

function activity(
  comments: PullRequestActivity["comments"] = [],
  reviewThreads: PullRequestActivity["reviewThreads"] = [],
): PullRequestActivity {
  return { comments, commits: [], reviewThreads, reactions: [] };
}

function reviewerComment(id: string, body: string): PullRequestActivity["comments"][number] {
  return {
    id,
    kind: "issue-comment",
    author: { login: "dana", isBot: false, avatarUrl: null },
    body,
    createdAt: NOW_ISO,
    url: null,
    reviewState: null,
    reactions: [],
    viewerIsAuthor: false,
  };
}

/** Every read the watcher makes, scripted per sweep so a test can change one. */
interface HostScript {
  readonly remote: VcsStatusRemoteResult | null;
  readonly detail: PullRequestDetail;
  readonly activity: PullRequestActivity;
  /** What a merge, or arming one, does; an action the test did not expect fails it. */
  readonly merge?: () => Effect.Effect<{ state: "merged" | "open" }, PullRequestServiceError>;
  /** What the host reports once `merge` has run, where that differs from `detail`. */
  readonly detailAfterMerge?: PullRequestDetail;
}

/** The engine's word that one of the thread's pull request switches came on. */
function switchedOn(
  change: { readonly autoFix: true } | { readonly autoMerge: PullRequestMergeMethod },
  threadId = THREAD_ID,
): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.make("event-switched-on"),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: NOW_ISO,
    commandId: CommandId.make("command-switched-on"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.pull-request-automation-changed",
    payload: { threadId, ...change, updatedAt: NOW_ISO },
  };
}

/** Where a thread with a checkout of its own works, which is how a status read names it. */
function worktree(name: string): string {
  return `/repos/widgets-${name}`;
}

/** One of several threads, each in its own checkout so their reads can be told apart. */
function threadIn(
  name: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return thread({ id: ThreadId.make(name), worktreePath: worktree(name), ...overrides });
}

/** A read of the host that stays open until the test lets it go. */
function heldRead() {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

function makeSnapshotQuery(input: {
  readonly readThreads: () => readonly OrchestrationThreadShell[];
  readonly projects: readonly OrchestrationProjectShell[];
  /** Told of every read of the whole shell, which is what a sweep lists its threads from. */
  readonly onShellSnapshot: () => void;
}): ProjectionSnapshotQueryShape {
  const shellSnapshot = () => {
    input.onShellSnapshot();
    return {
      snapshotSequence: 1,
      projects: [...input.projects],
      threads: [...input.readThreads()],
      updatedAt: NOW_ISO,
    };
  };
  return {
    getProjectCatalog: () => Effect.die("unused"),
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.sync(shellSnapshot),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
    getProjectShellById: (projectId) =>
      Effect.sync(() =>
        Option.fromUndefinedOr(input.projects.find((project) => project.id === projectId)),
      ),
    getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
    getThreadCheckpointContext: () => Effect.succeed(Option.none()),
    getFullThreadDiffContext: () => Effect.succeed(Option.none()),
    listThreadDiffStatBaselines: () => Effect.succeed([]),
    listThreadTurnOverlapsSince: () => Effect.succeed([]),
    getThreadShellById: (threadId) =>
      Effect.sync(() =>
        Option.fromUndefinedOr(input.readThreads().find((thread) => thread.id === threadId)),
      ),
    getTurnActivities: () => Effect.succeed([]),
    getThreadDetailById: () => Effect.succeed(Option.none()),
  };
}

describe("PullRequestAutomationWatcher", () => {
  let runtime: ManagedRuntime.ManagedRuntime<PullRequestAutomationWatcher, unknown> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  async function createHarness(input: {
    readonly threads: readonly OrchestrationThreadShell[];
    readonly projects?: readonly OrchestrationProjectShell[];
    readonly script: HostScript;
    readonly sweepIntervalMs?: number;
    readonly inMotionIntervalMs?: number;
    /** Keeps the status read of one checkout open until the promise it answers settles. */
    readonly holdStatusRead?: (cwd: string) => Promise<void> | undefined;
    /** Runs as the watcher picks an event up, just before it acts on it. */
    readonly onEventHeard?: () => void;
  }) {
    let script = input.script;
    let threads = input.threads;
    let snapshotReads = 0;
    // The checkout of every status read, in order: one per look at a thread.
    const statusReads: string[] = [];
    const domainEvents = Effect.runSync(Queue.unbounded<OrchestrationEvent>());
    const dispatched: Array<Extract<OrchestrationCommand, { type: "thread.turn.start" }>> = [];
    // Everything else the watcher dispatches: switches turned off, timeline notes.
    const commands: OrchestrationCommand[] = [];
    const actions: PullRequestActionInput[] = [];

    const orchestrationEngine: OrchestrationEngineShape = {
      readEvents: () => Stream.empty,
      getCommandReceipt: () => Effect.succeed(Option.none()),
      dispatch: (command) => {
        if (
          command.type === "thread.pull-request-automation.set" ||
          command.type === "thread.activity.append"
        ) {
          return Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          });
        }
        if (command.type !== "thread.turn.start") {
          return Effect.die(`Unexpected command: ${command.type}`);
        }
        return Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        });
      },
      streamDomainEvents: Stream.fromQueue(domainEvents).pipe(
        Stream.tap(() => Effect.sync(() => input.onEventHeard?.())),
      ),
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    };

    const gitManager: GitManagerShape = {
      status: () => Effect.die("unused"),
      localStatus: () => Effect.die("unused"),
      remoteStatus: ({ cwd }) =>
        Effect.suspend(() => {
          statusReads.push(cwd);
          const held = input.holdStatusRead?.(cwd);
          return held === undefined ? Effect.void : Effect.promise(() => held);
        }).pipe(Effect.map(() => script.remote)),
      invalidateLocalStatus: () => Effect.void,
      invalidateRemoteStatus: () => Effect.void,
      invalidateStatus: () => Effect.void,
      resolvePullRequest: () => Effect.die("unused"),
      preparePullRequestThread: () => Effect.die("unused"),
      runStackedAction: () => Effect.die("unused"),
      generateCommitMessage: () => Effect.die("unused"),
    };

    const pullRequestService: PullRequestServiceShape = {
      list: () => Effect.die("unused"),
      // The host answers for the pull request that was asked for, as the
      // script says one looks.
      detail: ({ repository, number }) =>
        Effect.sync(() => ({
          ...script.detail,
          repository,
          number,
          url: `https://github.com/${repository}/pull/${number}`,
        })),
      activity: () => Effect.sync(() => script.activity),
      diff: () => Effect.die("unused"),
      comment: () => Effect.die("unused"),
      runAction: (action) =>
        Effect.suspend(() => {
          actions.push(action);
          if (!script.merge) {
            return Effect.die("unexpected merge");
          }
          const merged = script.merge();
          if (script.detailAfterMerge) {
            script = { ...script, detail: script.detailAfterMerge };
          }
          return merged.pipe(Effect.map((result) => ({ ...result, isDraft: false })));
        }),
      submitReview: () => Effect.die("unused"),
      replyToThread: () => Effect.die("unused"),
      setThreadResolution: () => Effect.die("unused"),
      setReaction: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      updateComment: () => Effect.die("unused"),
      reviewerCandidates: () => Effect.die("unused"),
      requestReviewers: () => Effect.die("unused"),
    };

    const layer = makePullRequestAutomationWatcherLive({
      sweepIntervalMs: input.sweepIntervalMs ?? 60_000,
      ...(input.inMotionIntervalMs === undefined
        ? {}
        : { inMotionIntervalMs: input.inMotionIntervalMs }),
    }).pipe(
      Layer.provideMerge(
        Layer.succeed(
          ProjectionSnapshotQuery,
          makeSnapshotQuery({
            readThreads: () => threads,
            onShellSnapshot: () => {
              snapshotReads += 1;
            },
            projects: input.projects ?? [project()],
          }),
        ),
      ),
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
      Layer.provideMerge(Layer.succeed(GitManager, gitManager)),
      Layer.provideMerge(Layer.succeed(PullRequestService, pullRequestService)),
    );
    runtime = ManagedRuntime.make(layer);
    const watcher = await runtime.runPromise(Effect.service(PullRequestAutomationWatcher));
    const sweep = () => runtime!.runPromise(watcher.sweepNow());
    const setScript = (next: HostScript) => {
      script = next;
    };
    const setThreads = (next: readonly OrchestrationThreadShell[]) => {
      threads = next;
    };
    /** Starts the watcher's own loops, as the server does, and answers how to stop them. */
    const start = async () => {
      const scope = await runtime!.runPromise(Scope.make("sequential"));
      await runtime!.runPromise(watcher.start().pipe(Scope.provide(scope)));
      return () => runtime!.runPromise(Scope.close(scope, Exit.void));
    };
    const emit = (event: OrchestrationEvent) => Effect.runSync(Queue.offer(domainEvents, event));
    return {
      actions,
      commands,
      dispatched,
      emit,
      setScript,
      setThreads,
      snapshotReads: () => snapshotReads,
      start,
      statusReads,
      sweep,
    };
  }

  it("records a baseline on first sight and starts nothing", async () => {
    const { dispatched, sweep } = await createHarness({
      threads: [thread()],
      script: {
        remote: OPEN_PULL_REQUEST,
        detail: detail([FAILING_CHECK]),
        activity: activity([reviewerComment("c1", "Already said this")]),
      },
    });

    expect(await sweep()).toBe(0);
    expect(dispatched).toEqual([]);
  });

  it("sends a check already failing to the agent as soon as the switch comes on", async () => {
    const { dispatched, emit, setThreads, snapshotReads, start } = await createHarness({
      threads: [thread({ pullRequestAutoFix: false })],
      script: {
        remote: OPEN_PULL_REQUEST,
        detail: detail([FAILING_CHECK]),
        activity: activity([reviewerComment("c1", "Already answered")]),
      },
    });
    const stop = await start();
    try {
      // Starting sweeps once and finds nothing armed; the next sweep is a minute away.
      await vi.waitFor(() => expect(snapshotReads()).toBe(1));
      setThreads([thread()]);
      emit(switchedOn({ autoFix: true }));
      await vi.waitFor(() => expect(dispatched).toHaveLength(1));
      // The failing check, but not a remark made before the switch came on.
      expect(dispatched[0]?.message.text).toContain("These checks failed:\n- typecheck");
      expect(dispatched[0]?.message.text).not.toContain("Already answered");
    } finally {
      await stop();
    }
  });

  it("answers a switch coming on with a look at that thread alone, ahead of the rest of a sweep", async () => {
    const others = [threadIn("a"), threadIn("b"), threadIn("c")];
    const { held, release } = heldRead();
    const { dispatched, emit, setThreads, start, statusReads } = await createHarness({
      threads: [...others, threadIn("late", { pullRequestAutoFix: false })],
      script: {
        remote: OPEN_PULL_REQUEST,
        detail: detail([FAILING_CHECK]),
        activity: activity(),
      },
      holdStatusRead: (cwd) => (cwd === worktree("a") ? held : undefined),
      // The sweep's look in flight is let go only as the switch is heard, so
      // the switch is waiting on it by the time the sweep could move on.
      onEventHeard: release,
    });
    const stop = await start();
    try {
      // Starting sweeps every armed thread, and this sweep is still on its first.
      await vi.waitFor(() => expect(statusReads).toEqual([worktree("a")]));
      setThreads([...others, threadIn("late")]);
      emit(switchedOn({ autoFix: true }, ThreadId.make("late")));
      await vi.waitFor(() => expect(statusReads).toHaveLength(4));
      // Its own thread next, read once; the others are not read again to get to it.
      expect(statusReads).toEqual([worktree("a"), worktree("late"), worktree("b"), worktree("c")]);
      expect(dispatched.map((command) => command.threadId)).toEqual([ThreadId.make("late")]);
    } finally {
      await stop();
    }
  });

  it("starts a turn when a passing check begins to fail", async () => {
    const { dispatched, setScript, sweep } = await createHarness({
      threads: [thread()],
      script: {
        remote: OPEN_PULL_REQUEST,
        detail: detail([PASSING_CHECK]),
        activity: activity(),
      },
    });

    await sweep();
    setScript({
      remote: OPEN_PULL_REQUEST,
      detail: detail([FAILING_CHECK]),
      activity: activity(),
    });

    expect(await sweep()).toBe(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.commandId).toContain(`pull-request-auto-fix:${THREAD_ID}:`);
    expect(dispatched[0]?.threadId).toBe(THREAD_ID);
    expect(dispatched[0]?.message.text).toBe(
      [
        `Pull request #${PR_NUMBER} on ${REPOSITORY} needs attention.`,
        "",
        "These checks failed:",
        "- typecheck (https://github.com/acme/widgets/runs/1)",
        "",
        "Fix what needs fixing, run the project's checks, commit on this branch, and push so the pull request updates.",
      ].join("\n"),
    );

    // The same failure is not news twice.
    expect(await sweep()).toBe(0);
    expect(dispatched).toHaveLength(1);
  });

  it("starts a turn for a new comment from someone else, once", async () => {
    const { dispatched, setScript, sweep } = await createHarness({
      threads: [thread()],
      script: { remote: OPEN_PULL_REQUEST, detail: detail([]), activity: activity() },
    });

    await sweep();
    setScript({
      remote: OPEN_PULL_REQUEST,
      detail: detail([]),
      activity: activity([reviewerComment("c1", "This leaks.")]),
    });

    expect(await sweep()).toBe(1);
    expect(dispatched[0]?.message.text).toContain("New review comments:");
    expect(dispatched[0]?.message.text).toContain("dana wrote:\n> This leaks.");

    expect(await sweep()).toBe(0);
    expect(dispatched).toHaveLength(1);
  });

  it("starts nothing for an archived or disarmed thread", async () => {
    const { dispatched, setScript, sweep } = await createHarness({
      threads: [
        thread({ id: ThreadId.make("archived"), archivedAt: NOW_ISO }),
        thread({ id: ThreadId.make("disarmed"), pullRequestAutoFix: false }),
      ],
      script: {
        remote: OPEN_PULL_REQUEST,
        detail: detail([PASSING_CHECK]),
        activity: activity(),
      },
    });

    await sweep();
    setScript({
      remote: OPEN_PULL_REQUEST,
      detail: detail([FAILING_CHECK]),
      activity: activity(),
    });

    expect(await sweep()).toBe(0);
    expect(dispatched).toEqual([]);
  });

  it("leaves a thread with nothing to watch alone until its rest is over or the thread changes", async () => {
    // Touched just now, so its rest is as short as it gets: one sweep interval.
    const settled = thread({ updatedAt: new Date().toISOString() });
    const { setThreads, statusReads, sweep } = await createHarness({
      threads: [settled],
      script: {
        remote: { ...OPEN_PULL_REQUEST, pr: { ...OPEN_PULL_REQUEST.pr!, state: "merged" } },
        detail: detail([PASSING_CHECK]),
        activity: activity(),
      },
      sweepIntervalMs: 300,
    });

    await sweep();
    await sweep();
    expect(statusReads).toHaveLength(1);

    // Its rest over, it is looked at again, in case the pull request was reopened.
    await new Promise((resolve) => setTimeout(resolve, 350));
    await sweep();
    expect(statusReads).toHaveLength(2);

    // A turn, a switch, a move to another branch: any change ends the rest at once.
    setThreads([{ ...settled, branch: "another-branch" }]);
    await sweep();
    expect(statusReads).toHaveLength(3);
  });

  it("waits out a busy thread without forgetting what it had already seen", async () => {
    const { dispatched, setScript, setThreads, sweep } = await createHarness({
      threads: [thread()],
      script: {
        remote: OPEN_PULL_REQUEST,
        detail: detail([PASSING_CHECK]),
        activity: activity(),
      },
    });

    await sweep();
    // The check fails while a turn is running, so this sweep does nothing --
    // and must not re-baseline the failure away.
    setThreads([
      thread({
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: NOW_ISO,
          startedAt: NOW_ISO,
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    ]);
    setScript({
      remote: OPEN_PULL_REQUEST,
      detail: detail([FAILING_CHECK]),
      activity: activity(),
    });
    expect(await sweep()).toBe(0);
    expect(dispatched).toEqual([]);

    setThreads([thread()]);
    expect(await sweep()).toBe(1);
  });

  it("does not start a turn on top of a message the user sent while the host was being read", async () => {
    const { dispatched, setScript, setThreads, sweep } = await createHarness({
      threads: [thread()],
      script: { remote: OPEN_PULL_REQUEST, detail: detail([PASSING_CHECK]), activity: activity() },
    });

    await sweep();
    setScript({
      remote: OPEN_PULL_REQUEST,
      // The user sends a message of their own while the watcher reads the host.
      get detail() {
        setThreads([thread({ latestTurn: RUNNING_TURN })]);
        return detail([FAILING_CHECK]);
      },
      activity: activity(),
    });
    expect(await sweep()).toBe(0);
    expect(dispatched).toEqual([]);

    // Once that turn is over, the failure is still news.
    setThreads([thread()]);
    setScript({ remote: OPEN_PULL_REQUEST, detail: detail([FAILING_CHECK]), activity: activity() });
    expect(await sweep()).toBe(1);
  });

  it("looks at each thread of a sweep as it stands by then, not as it was when the sweep began", async () => {
    // Waiting to merge with a check failing, which is given up on unless the thread is fixing it.
    const merging = threadIn("merging", {
      pullRequestAutoFix: false,
      pullRequestAutoMerge: "squash",
    });
    const { held, release } = heldRead();
    const { commands, setThreads, statusReads, sweep } = await createHarness({
      threads: [threadIn("a"), merging],
      script: {
        remote: OPEN_PULL_REQUEST,
        detail: mergeable([FAILING_CHECK]),
        activity: activity(),
      },
      holdStatusRead: (cwd) => (cwd === worktree("a") ? held : undefined),
    });

    const sweeping = sweep();
    await vi.waitFor(() => expect(statusReads).toEqual([worktree("a")]));
    // The fixing switch comes on while the sweep is still on the thread before.
    setThreads([threadIn("a"), { ...merging, pullRequestAutoFix: true }]);
    release();
    await sweeping;

    expect(statusReads).toEqual([worktree("a"), worktree("merging")]);
    expect(commands).toEqual([]);
  });

  it("looks again soon while checks run, so a failure reaches the agent before the next sweep", async () => {
    const { dispatched, setScript, snapshotReads, start } = await createHarness({
      threads: [thread()],
      script: {
        remote: OPEN_PULL_REQUEST,
        detail: { ...detail([PENDING_CHECK]), checksState: "pending" },
        activity: activity(),
      },
      inMotionIntervalMs: 10,
    });
    const stop = await start();
    try {
      await vi.waitFor(() => expect(snapshotReads()).toBeGreaterThan(1));
      // The next full sweep is a minute away; only the quicker look can see this.
      setScript({
        remote: OPEN_PULL_REQUEST,
        detail: detail([FAILING_CHECK]),
        activity: activity(),
      });
      await vi.waitFor(() => expect(dispatched).toHaveLength(1));
      expect(dispatched[0]?.message.text).toContain("These checks failed:\n- typecheck");

      // Settled checks go back to the slow pace: nothing is read in between.
      const reads = snapshotReads();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(snapshotReads()).toBe(reads);
    } finally {
      await stop();
    }
  });

  it("gives up the quicker look while the thread is busy", async () => {
    const { setThreads, snapshotReads, start } = await createHarness({
      threads: [thread()],
      script: {
        remote: OPEN_PULL_REQUEST,
        detail: { ...detail([PENDING_CHECK]), checksState: "pending" },
        activity: activity(),
      },
      inMotionIntervalMs: 10,
    });
    const stop = await start();
    try {
      await vi.waitFor(() => expect(snapshotReads()).toBeGreaterThan(1));
      // A turn that runs for hours, or waits on the user, must not keep the
      // quicker look reading all that time.
      setThreads([thread({ latestTurn: RUNNING_TURN })]);
      const reads = snapshotReads();
      await vi.waitFor(() => expect(snapshotReads()).toBeGreaterThan(reads));
      const settled = snapshotReads();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(snapshotReads()).toBe(settled);
    } finally {
      await stop();
    }
  });

  describe("merge queue failures", () => {
    const outOfQueue = { ...detail([PASSING_CHECK]), mergeQueue: { position: null } };
    const givenBack: HostScript = {
      remote: OPEN_PULL_REQUEST,
      detail: {
        ...outOfQueue,
        mergeQueue: {
          position: null,
          removal: {
            id: "RFMQE_1",
            removedAt: NOW_ISO,
            failedChecks: [{ ...FAILING_CHECK, name: "Browser Test" }],
          },
        },
      },
      activity: activity(),
      merge: () => Effect.succeed({ state: "open" }),
    };
    const ended = (requestedAt: string, state: "completed" | "interrupted" | "error") =>
      thread({
        latestTurn: {
          turnId: TurnId.make("turn-fix"),
          state,
          requestedAt,
          startedAt: requestedAt,
          completedAt: requestedAt,
          assistantMessageId: null,
        },
      });

    /** A harness whose pull request the queue has just given back, already sent to the agent. */
    async function handedToAgent() {
      const harness = await createHarness({
        threads: [thread()],
        script: { remote: OPEN_PULL_REQUEST, detail: outOfQueue, activity: activity() },
      });
      await harness.sweep();
      harness.setScript(givenBack);
      expect(await harness.sweep()).toBe(1);
      return { ...harness, requestedAt: harness.dispatched[0]?.createdAt ?? NOW_ISO };
    }

    it("sends the agent what failed, then queues it again once its turn is over", async () => {
      const { actions, commands, dispatched, requestedAt, setThreads, sweep } =
        await handedToAgent();
      expect(dispatched[0]?.message.text).toContain(
        "The merge queue took it out because these checks failed when it was merged with the latest main:\n- Browser Test",
      );

      // Before the turn is on record, and after one that failed, the agent
      // has not looked, so nothing is queued.
      await sweep();
      setThreads([ended(requestedAt, "error")]);
      await sweep();
      expect(actions).toEqual([]);

      setThreads([ended(requestedAt, "completed")]);
      await sweep();
      expect(actions).toEqual([
        {
          projectId: PROJECT_ID,
          repository: REPOSITORY,
          number: PR_NUMBER,
          action: "enable-auto-merge",
        },
      ]);
      expect(commands.at(-1)).toMatchObject({
        activity: { tone: "info", kind: "pull-request.auto-merge.requeued" },
      });

      // Once per removal: the same one is neither sent nor queued twice.
      expect(await sweep()).toBe(0);
      expect(actions).toHaveLength(1);
    });

    it("does not queue it again once the switch went off while the host was being read", async () => {
      const { actions, requestedAt, setScript, setThreads, sweep } = await handedToAgent();
      setThreads([ended(requestedAt, "completed")]);
      setScript({
        ...givenBack,
        // The user turns fixing off while the watcher reads the host.
        get detail() {
          setThreads([{ ...ended(requestedAt, "completed"), pullRequestAutoFix: false }]);
          return givenBack.detail;
        },
      });

      await sweep();
      expect(actions).toEqual([]);
    });
  });

  it("stops starting turns once the per-pull-request cap is reached", async () => {
    const { dispatched, setScript, sweep } = await createHarness({
      threads: [thread()],
      script: { remote: OPEN_PULL_REQUEST, detail: detail([]), activity: activity() },
    });

    await sweep();
    // A fresh comment each sweep: without the cap this would fire every time.
    for (let index = 1; index <= 5; index += 1) {
      setScript({
        remote: OPEN_PULL_REQUEST,
        detail: detail([]),
        activity: activity(
          Array.from({ length: index }, (_unused, position) =>
            reviewerComment(`c${position + 1}`, `Remark ${position + 1}`),
          ),
        ),
      });
      await sweep();
    }

    expect(dispatched).toHaveLength(3);
  });

  describe("merge when checks pass", () => {
    const armed = thread({ pullRequestAutoFix: false, pullRequestAutoMerge: "rebase" });

    it("waits for checks and pushes, then merges once and turns itself off", async () => {
      const { actions, commands, setScript, sweep } = await createHarness({
        threads: [armed],
        script: {
          remote: OPEN_PULL_REQUEST,
          detail: mergeable([PENDING_CHECK]),
          activity: activity(),
        },
      });

      await sweep();
      // Passing, but the thread still has a commit the host has not seen.
      setScript({
        remote: { ...OPEN_PULL_REQUEST, aheadCount: 1 },
        detail: mergeable([PASSING_CHECK]),
        activity: activity(),
      });
      await sweep();
      expect(actions).toEqual([]);

      setScript({
        remote: OPEN_PULL_REQUEST,
        detail: mergeable([PASSING_CHECK]),
        activity: activity(),
        merge: () => Effect.succeed({ state: "merged" }),
      });
      await sweep();

      // The repository no longer allows the chosen method, so its own first choice runs.
      expect(actions).toEqual([
        {
          projectId: PROJECT_ID,
          repository: REPOSITORY,
          number: PR_NUMBER,
          action: "merge",
          mergeMethod: "squash",
        },
      ]);
      expect(commands.map((command) => command.type)).toEqual([
        "thread.pull-request-automation.set",
        "thread.activity.append",
      ]);
      expect(commands[0]).toMatchObject({ threadId: THREAD_ID, autoMerge: null });
      expect(commands[1]).toMatchObject({
        activity: { tone: "info", kind: "pull-request.auto-merge.merged" },
      });
    });

    it("gives up on a failing check unless the thread is fixing it", async () => {
      const failing = mergeable([FAILING_CHECK]);
      const fixing = await createHarness({
        threads: [{ ...armed, pullRequestAutoFix: true }],
        script: { remote: OPEN_PULL_REQUEST, detail: failing, activity: activity() },
      });
      await fixing.sweep();
      expect(fixing.commands).toEqual([]);
      await runtime?.dispose();

      const { actions, commands, sweep } = await createHarness({
        threads: [armed],
        script: { remote: OPEN_PULL_REQUEST, detail: failing, activity: activity() },
      });
      await sweep();
      expect(actions).toEqual([]);
      expect(commands[0]).toMatchObject({ autoMerge: null });
      expect(commands[1]).toMatchObject({
        activity: {
          tone: "warning",
          kind: "pull-request.auto-merge.stopped",
          payload: { detail: "A check failed" },
        },
      });
    });

    it("reports a merge the host refused, and does not retry it", async () => {
      const { actions, commands, sweep } = await createHarness({
        threads: [armed],
        script: {
          remote: OPEN_PULL_REQUEST,
          detail: mergeable([PASSING_CHECK]),
          activity: activity(),
          merge: () =>
            Effect.fail(
              new PullRequestServiceError({
                operation: "runAction",
                detail: "Base branch was modified",
              }),
            ),
        },
      });

      await sweep();
      expect(actions).toHaveLength(1);
      expect(commands[0]).toMatchObject({ autoMerge: null });
      expect(commands[1]).toMatchObject({
        activity: {
          tone: "error",
          kind: "pull-request.auto-merge.failed",
          payload: { detail: "Base branch was modified" },
        },
      });
    });

    it("turns itself off quietly when the pull request closes some other way", async () => {
      const { actions, commands, sweep } = await createHarness({
        threads: [armed],
        script: {
          remote: { ...OPEN_PULL_REQUEST, pr: { ...OPEN_PULL_REQUEST.pr!, state: "merged" } },
          detail: mergeable([PASSING_CHECK]),
          activity: activity(),
        },
      });

      await sweep();
      expect(actions).toEqual([]);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        type: "thread.pull-request-automation.set",
        autoMerge: null,
      });
    });

    it("leaves alone a pull request the checkout found in another repository", async () => {
      // The agent ended its turn in another repository's folder, whose branch
      // has a pull request of its own under the same number.
      const { actions, commands, sweep } = await createHarness({
        threads: [armed],
        script: {
          remote: {
            ...OPEN_PULL_REQUEST,
            pr: {
              ...OPEN_PULL_REQUEST.pr!,
              url: `https://github.com/acme/gadgets/pull/${PR_NUMBER}`,
            },
          },
          detail: mergeable([PASSING_CHECK]),
          activity: activity(),
          merge: () => Effect.succeed({ state: "merged" }),
        },
      });

      expect(await sweep()).toBe(0);
      expect(actions).toEqual([]);
      expect(commands).toEqual([]);
    });

    it("does not merge once the switch went off while the host was being read", async () => {
      let untick = () => {};
      const { actions, commands, setThreads, sweep } = await createHarness({
        threads: [armed],
        script: {
          remote: OPEN_PULL_REQUEST,
          // The user takes the switch back while the watcher reads the host.
          get detail() {
            untick();
            return mergeable([PASSING_CHECK]);
          },
          activity: activity(),
          merge: () => Effect.succeed({ state: "merged" }),
        },
      });
      untick = () => setThreads([{ ...armed, pullRequestAutoMerge: null }]);

      await sweep();
      expect(actions).toEqual([]);
      expect(commands).toEqual([]);
    });

    it("merges a linked pull request by its own switch, and turns only that one off", async () => {
      const { actions, commands, setScript, sweep } = await createHarness({
        // Nothing armed for the thread's own branch; one linked pull request is.
        threads: [
          thread({
            pullRequestAutoFix: false,
            linkedPullRequests: [
              {
                number: 294,
                url: `https://github.com/${REPOSITORY}/pull/294`,
                autoMerge: "squash",
              },
            ],
            participants: [],
          }),
        ],
        // The thread has since moved onto the linked pull request's branch,
        // and its checkout holds a commit the host has not seen.
        script: {
          remote: { ...OPEN_PULL_REQUEST, aheadCount: 1 },
          detail: mergeable([PASSING_CHECK]),
          activity: activity(),
        },
      });

      await sweep();
      expect(actions).toEqual([]);

      setScript({
        remote: OPEN_PULL_REQUEST,
        detail: mergeable([PASSING_CHECK]),
        activity: activity(),
        merge: () => Effect.succeed({ state: "merged" }),
      });
      await sweep();
      expect(actions).toEqual([
        {
          projectId: PROJECT_ID,
          repository: REPOSITORY,
          number: 294,
          action: "merge",
          mergeMethod: "squash",
        },
      ]);
      expect(commands[0]).toMatchObject({
        type: "thread.pull-request-automation.set",
        pullRequestNumber: 294,
        autoMerge: null,
      });
      expect(commands[1]).toMatchObject({
        activity: {
          kind: "pull-request.auto-merge.merged",
          summary: "Merged #294 after its checks passed",
        },
      });
    });

    it("counts a place in the merge queue as handed over, not as a failed merge", async () => {
      // A base with a merge queue answers the merge by queueing the pull request.
      const waiting = { ...mergeable([PASSING_CHECK]), mergeQueue: { position: null } };
      const { actions, commands, sweep } = await createHarness({
        threads: [armed],
        script: {
          remote: OPEN_PULL_REQUEST,
          detail: waiting,
          detailAfterMerge: { ...waiting, mergeQueue: { position: 1 } },
          activity: activity(),
          merge: () => Effect.succeed({ state: "open" }),
        },
      });

      await sweep();
      expect(actions).toHaveLength(1);
      expect(commands[0]).toMatchObject({ autoMerge: null });
      expect(commands[1]).toMatchObject({
        activity: { tone: "info", kind: "pull-request.auto-merge.queued" },
      });
    });

    it("merges as soon as the switch comes on, not at the next interval", async () => {
      const { actions, emit, setThreads, snapshotReads, start } = await createHarness({
        threads: [{ ...armed, pullRequestAutoMerge: null }],
        script: {
          remote: OPEN_PULL_REQUEST,
          detail: mergeable([PASSING_CHECK]),
          activity: activity(),
          merge: () => Effect.succeed({ state: "merged" }),
        },
      });
      const stop = await start();
      try {
        // Starting sweeps once and finds nothing armed; the next sweep is a minute away.
        await vi.waitFor(() => expect(snapshotReads()).toBe(1));
        setThreads([armed]);
        emit(switchedOn({ autoMerge: "rebase" }));
        await vi.waitFor(() => expect(actions).toHaveLength(1));
      } finally {
        await stop();
      }
    });
  });
});
