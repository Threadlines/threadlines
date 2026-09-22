import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type PullRequestActivity,
  type PullRequestCheck,
  type PullRequestDetail,
  type VcsStatusRemoteResult,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vite-plus/test";

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
import { PullRequestAutoFixWatcher } from "../Services/PullRequestAutoFixWatcher.ts";
import { makePullRequestAutoFixWatcherLive } from "./PullRequestAutoFixWatcher.ts";

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
    doneOverride: null,
    lastSeenAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
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
}

function makeSnapshotQuery(input: {
  readonly readThreads: () => readonly OrchestrationThreadShell[];
  readonly projects: readonly OrchestrationProjectShell[];
}): ProjectionSnapshotQueryShape {
  const shellSnapshot = () => ({
    snapshotSequence: 1,
    projects: [...input.projects],
    threads: [...input.readThreads()],
    updatedAt: NOW_ISO,
  });
  return {
    getProjectCatalog: () => Effect.die("unused"),
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.sync(shellSnapshot),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
    getProjectShellById: () => Effect.succeed(Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
    getThreadCheckpointContext: () => Effect.succeed(Option.none()),
    getFullThreadDiffContext: () => Effect.succeed(Option.none()),
    listThreadDiffStatBaselines: () => Effect.succeed([]),
    listThreadTurnOverlapsSince: () => Effect.succeed([]),
    getThreadShellById: () => Effect.succeed(Option.none()),
    getThreadDetailById: () => Effect.succeed(Option.none()),
  };
}

describe("PullRequestAutoFixWatcher", () => {
  let runtime: ManagedRuntime.ManagedRuntime<PullRequestAutoFixWatcher, unknown> | null = null;

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
  }) {
    let script = input.script;
    let threads = input.threads;
    const dispatched: Array<Extract<OrchestrationCommand, { type: "thread.turn.start" }>> = [];

    const orchestrationEngine: OrchestrationEngineShape = {
      readEvents: () => Stream.empty,
      getCommandReceipt: () => Effect.succeed(Option.none()),
      dispatch: (command) => {
        if (command.type !== "thread.turn.start") {
          return Effect.die(`Unexpected command: ${command.type}`);
        }
        return Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        });
      },
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    };

    const gitManager: GitManagerShape = {
      status: () => Effect.die("unused"),
      localStatus: () => Effect.die("unused"),
      remoteStatus: () => Effect.sync(() => script.remote),
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
      detail: () => Effect.sync(() => script.detail),
      activity: () => Effect.sync(() => script.activity),
      diff: () => Effect.die("unused"),
      comment: () => Effect.die("unused"),
      runAction: () => Effect.die("unused"),
      submitReview: () => Effect.die("unused"),
      replyToThread: () => Effect.die("unused"),
      setThreadResolution: () => Effect.die("unused"),
      setReaction: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      updateComment: () => Effect.die("unused"),
      reviewerCandidates: () => Effect.die("unused"),
      requestReviewers: () => Effect.die("unused"),
    };

    const layer = makePullRequestAutoFixWatcherLive({ sweepIntervalMs: 60_000 }).pipe(
      Layer.provideMerge(
        Layer.succeed(
          ProjectionSnapshotQuery,
          makeSnapshotQuery({
            readThreads: () => threads,
            projects: input.projects ?? [project()],
          }),
        ),
      ),
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
      Layer.provideMerge(Layer.succeed(GitManager, gitManager)),
      Layer.provideMerge(Layer.succeed(PullRequestService, pullRequestService)),
    );
    runtime = ManagedRuntime.make(layer);
    const watcher = await runtime.runPromise(Effect.service(PullRequestAutoFixWatcher));
    const sweep = () => runtime!.runPromise(watcher.sweepNow());
    const setScript = (next: HostScript) => {
      script = next;
    };
    const setThreads = (next: readonly OrchestrationThreadShell[]) => {
      threads = next;
    };
    return { dispatched, setScript, setThreads, sweep };
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
});
