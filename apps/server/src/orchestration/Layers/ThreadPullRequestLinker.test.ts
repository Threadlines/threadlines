import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type PullRequestDetail,
} from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessage,
  type ProjectionThreadMessageRepositoryShape,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
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
import { ThreadPullRequestLinker } from "../Services/ThreadPullRequestLinker.ts";
import { makeThreadPullRequestLinkerLive } from "./ThreadPullRequestLinker.ts";

const THREAD_STARTED_AT = "2026-09-24T01:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-threadlines");
const THREAD_ID = ThreadId.make("thread-linked-previews");
const MESSAGE_ID = MessageId.make("message-done");
const REPOSITORY = "Threadlines/threadlines";

const PROJECT: OrchestrationProjectShell = {
  id: PROJECT_ID,
  kind: "workspace",
  title: "Threadlines",
  workspaceRoot: "/repos/threadlines",
  repositoryIdentity: {
    canonicalKey: "github|threadlines/threadlines",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/Threadlines/threadlines.git",
    },
    displayName: REPOSITORY,
    provider: "github",
    owner: "Threadlines",
    name: "threadlines",
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: THREAD_STARTED_AT,
  updatedAt: THREAD_STARTED_AT,
};

const THREAD: OrchestrationThreadShell = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Improve linked file previews",
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "threadlines/improve-linked-file-previews",
  worktreePath: "/worktrees/improve-linked-file-previews",
  effectiveCwd: null,
  goal: null,
  latestTurn: null,
  createdAt: THREAD_STARTED_AT,
  updatedAt: THREAD_STARTED_AT,
  archivedAt: null,
  pinnedAt: null,
  pullRequestAutoFix: false,
  pullRequestAutoMerge: null,
  linkedPullRequests: [],
  doneOverride: null,
  lastSeenAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  cumulativeDiffStat: null,
  diffStatBaselineTurnCount: 0,
};

function pullRequest(
  number: number,
  overrides: Partial<Pick<PullRequestDetail, "createdAt" | "headBranch" | "viewerIsAuthor">>,
): PullRequestDetail {
  return {
    number,
    url: `https://github.com/${REPOSITORY}/pull/${number}`,
    createdAt: "2026-09-24T02:30:00.000Z",
    headBranch: `branch-${number}`,
    viewerIsAuthor: true,
    ...overrides,
  } as PullRequestDetail;
}

/** The host's answer for each number the agent might link. */
const HOST: ReadonlyMap<number, PullRequestDetail> = new Map([
  [294, pullRequest(294, { headBranch: "docs/lighter-pr-rules" })],
  // Already open before the thread started: talked about, not made here.
  [283, pullRequest(283, { createdAt: "2026-09-22T23:00:00.000Z" })],
  // The thread's own branch: found from the branch, never linked.
  [292, pullRequest(292, { headBranch: THREAD.branch! })],
  // Someone else's.
  [279, pullRequest(279, { viewerIsAuthor: false })],
]);

const MESSAGE_TEXT = [
  "Done. The new PR is [#294](https://github.com/Threadlines/threadlines/pull/294).",
  "It follows https://github.com/Threadlines/threadlines/pull/283 and leaves",
  "https://github.com/Threadlines/threadlines/pull/292 alone. Dependabot opened",
  "https://github.com/Threadlines/threadlines/pull/279, and the upstream fix is",
  "https://github.com/openai/codex/pull/9.",
].join("\n");

/** How a streamed assistant message ends: the final event carries no text. */
function finishedMessage(): OrchestrationEvent {
  return {
    sequence: 7,
    eventId: EventId.make("event-message-done"),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: "2026-09-24T02:31:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.message-sent",
    payload: {
      threadId: THREAD_ID,
      messageId: MESSAGE_ID,
      role: "assistant",
      text: "",
      turnId: null,
      streaming: false,
      createdAt: "2026-09-24T02:31:00.000Z",
      updatedAt: "2026-09-24T02:31:00.000Z",
    },
  };
}

describe("ThreadPullRequestLinker", () => {
  let runtime: ManagedRuntime.ManagedRuntime<ThreadPullRequestLinker, unknown> | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (runtime && scope) {
      await runtime.runPromise(Scope.close(scope, Exit.void));
    }
    await runtime?.dispose();
    runtime = null;
    scope = null;
  });

  /** A started linker whose host answers each read with `answer`. */
  async function startLinker(answer: (number: number) => Effect.Effect<PullRequestDetail>) {
    const domainEvents = Effect.runSync(Queue.unbounded<OrchestrationEvent>());
    const dispatched: OrchestrationCommand[] = [];
    const detailReads: number[] = [];

    const orchestrationEngine: OrchestrationEngineShape = {
      readEvents: () => Stream.empty,
      getCommandReceipt: () => Effect.succeed(Option.none()),
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.fromQueue(domainEvents),
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    };
    const snapshotQuery = {
      getThreadShellById: () => Effect.succeed(Option.some(THREAD)),
      getProjectShellById: () => Effect.succeed(Option.some(PROJECT)),
    } as unknown as ProjectionSnapshotQueryShape;
    const threadMessages = {
      getByMessageId: () =>
        Effect.succeed(
          Option.some({ messageId: MESSAGE_ID, text: MESSAGE_TEXT } as ProjectionThreadMessage),
        ),
    } as unknown as ProjectionThreadMessageRepositoryShape;
    const pullRequests = {
      detail: (input: { readonly number: number }) =>
        Effect.suspend(() => {
          detailReads.push(input.number);
          return answer(input.number);
        }),
    } as unknown as PullRequestServiceShape;

    runtime = ManagedRuntime.make(
      makeThreadPullRequestLinkerLive({ retryDelays: [Duration.millis(10)] }).pipe(
        Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
        Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
        Layer.provideMerge(Layer.succeed(ProjectionThreadMessageRepository, threadMessages)),
        Layer.provideMerge(Layer.succeed(PullRequestService, pullRequests)),
      ),
    );
    const linker = await runtime.runPromise(Effect.service(ThreadPullRequestLinker));
    scope = await runtime.runPromise(Scope.make("sequential"));
    await runtime.runPromise(linker.start().pipe(Scope.provide(scope)));
    return {
      dispatched,
      detailReads,
      linkCommands: () =>
        dispatched.filter((command) => command.type === "thread.pull-request.link"),
      finishMessage: () => Effect.runSync(Queue.offer(domainEvents, finishedMessage())),
    };
  }

  /** The host as the fixtures describe it. */
  const hostAnswer = (number: number) => {
    const found = HOST.get(number);
    return found ? Effect.succeed(found) : Effect.die(`unexpected read #${number}`);
  };

  it("links the pull request the agent opened on another branch, and only that one", async () => {
    const { detailReads, finishMessage, linkCommands } = await startLinker(hostAnswer);
    finishMessage();
    // The same message again: nothing turned away is read from the host twice.
    finishMessage();
    await vi.waitFor(() => expect(detailReads.length).toBeGreaterThanOrEqual(5));

    expect(linkCommands()).toEqual([
      expect.objectContaining({
        threadId: THREAD_ID,
        number: 294,
        url: "https://github.com/Threadlines/threadlines/pull/294",
        commandId: CommandId.make(`pull-request-link:${THREAD_ID}:294`),
      }),
      // The fake thread never records the link, so the repeat dispatches
      // again, under the same command id the engine dedupes on.
      expect.objectContaining({ number: 294 }),
    ]);
    expect(detailReads.toSorted()).toEqual([279, 283, 292, 294, 294]);
  });

  it("reads the message again when the host did not answer, and links it then", async () => {
    let failures = 1;
    const { finishMessage, linkCommands } = await startLinker((number) =>
      number === 294 && failures-- > 0 ? Effect.die("GitHub did not answer") : hostAnswer(number),
    );
    finishMessage();

    await vi.waitFor(() => expect(linkCommands()).toHaveLength(1));
    expect(linkCommands()[0]).toMatchObject({ number: 294 });
  });
});
