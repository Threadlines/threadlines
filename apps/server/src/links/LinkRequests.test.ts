import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChildRequestId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EMPTY_AGENT_REQUEST_STATE,
  EMPTY_CHILD_REQUEST_STATE,
  EnvironmentId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type PeerStartInput,
  type PeerWatchEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import type { ChildBootstrapInput } from "../orchestration/Services/ThreadBootstrap.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadBootstrap } from "../orchestration/Services/ThreadBootstrap.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurn,
} from "../persistence/Services/ProjectionTurns.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { RelayDeviceRepositoryLive } from "../relay/RelayDeviceRepository.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { linkMessageId, linkThreadId } from "./linkIds.ts";
import { LinkRequestRepository, LinkRequestRepositoryLive } from "./LinkRequestRepository.ts";
import { LinkRequests, LinkRequestsLive, type PeerLink } from "./LinkRequests.ts";

const AT = "2026-10-20T10:00:00.000Z";
const PROJECT = ProjectId.make("project-1");
const PROJECT_KEY = "github.com/threadlines/threadlines";
const DEVICE = "device-windows";
const WINDOWS = EnvironmentId.make("env-windows");
const PARENT = ThreadId.make("windows-parent");

const link = (patch: Partial<PeerLink> = {}): PeerLink => ({
  deviceId: DEVICE,
  label: "Windows PC",
  environmentId: WINDOWS,
  access: "allowed",
  maxRuntimeMode: "auto",
  ...patch,
});

const startInput = (requestId: string): PeerStartInput => ({
  requestId: ChildRequestId.make(requestId),
  parent: {
    environmentId: WINDOWS,
    environmentLabel: "Windows PC",
    threadId: PARENT,
    threadTitle: "Ship the release",
    handle: "Codex",
  },
  projectKey: PROJECT_KEY,
  workspace: { kind: "worktree" },
  title: "Write the changelog",
  prompt: "Write the changelog from the merged PRs.",
  agent: { instanceId: "codex", model: "gpt-6-astra" },
  runtimeMode: "full-access",
  interactionMode: "default",
  reportBack: true,
});

const PROVIDER = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated", type: "chatgpt", label: "ChatGPT Pro Subscription" },
  models: [{ slug: "gpt-6-astra", name: "GPT-6 Astra", isCustom: false }],
} as unknown as ServerProvider;

const thread = (id: ThreadId, patch: Partial<OrchestrationThread> = {}): OrchestrationThread => ({
  id,
  projectId: PROJECT,
  title: "Write the changelog",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
  runtimeMode: "auto",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  branch: null,
  worktreePath: null,
  effectiveCwd: null,
  goal: null,
  latestTurn: null,
  createdAt: AT,
  updatedAt: AT,
  archivedAt: null,
  pinnedAt: null,
  pullRequestAutoFix: false,
  pullRequestAutoMerge: null,
  linkedPullRequests: [],
  agentRequests: EMPTY_AGENT_REQUEST_STATE,
  parentThreadId: null,
  parentTurnId: null,
  attachedToParent: false,
  parentAttachmentEpoch: 0,
  handedBackAt: null,
  handedBackTurnId: null,
  archivedWithParentAt: null,
  childRequests: EMPTY_CHILD_REQUEST_STATE,
  participants: [],
  doneOverride: null,
  lastSeenAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  diffStatBaselineTurnCount: 0,
  session: null,
  remoteOrigin: {
    linkDeviceId: DEVICE,
    environmentId: WINDOWS,
    environmentLabel: "Windows PC",
    threadId: PARENT,
    threadTitle: "Ship the release",
  },
  ...patch,
});

/** The child's computer, with the orchestration around the ledger faked. */
const makeWorld = Effect.gen(function* () {
  const threads = new Map<string, OrchestrationThread>();
  const turns: Array<ProjectionTurn> = [];
  const dispatched: Array<OrchestrationCommand> = [];
  const started: Array<ChildBootstrapInput> = [];
  const events = yield* PubSub.unbounded<OrchestrationEvent>();

  const layer = LinkRequestsLive.pipe(
    Layer.provideMerge(LinkRequestRepositoryLive),
    Layer.provide(RelayDeviceRepositoryLive),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: dispatched.length };
            }),
          subscribeDomainEvents: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadDetailById: (threadId) =>
            Effect.succeed(Option.fromNullishOr(threads.get(threadId))),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getProjectCatalog: () =>
            Effect.succeed({
              snapshotSequence: 1,
              updatedAt: AT,
              projects: [
                {
                  id: PROJECT,
                  kind: "workspace",
                  title: "threadlines",
                  workspaceRoot: "/repo",
                  createdAt: AT,
                  updatedAt: AT,
                  deletedAt: null,
                },
              ],
            }),
        }),
        Layer.mock(ThreadBootstrap)({
          startChild: (input) =>
            Effect.sync(() => {
              started.push(input);
              return { sequence: started.length };
            }),
        }),
        Layer.mock(ProjectionTurnRepository)({
          listByThreadId: ({ threadId }) =>
            Effect.succeed(turns.filter((turn) => turn.threadId === threadId)),
        }),
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([PROVIDER]) }),
        Layer.mock(RepositoryIdentityResolver)({
          resolve: () =>
            Effect.succeed({
              canonicalKey: PROJECT_KEY,
              locator: { source: "git-remote", remoteName: "origin", remoteUrl: "x" },
            }),
        }),
        Layer.mock(GitVcsDriver)({
          execute: () =>
            Effect.succeed({
              exitCode: 1 as never,
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
        Layer.mock(ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("env-mac-mini"),
            label: "Mac mini",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: true },
          }),
        }),
        ServerSettingsService.layerTest(),
      ),
    ),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "link-requests-test-" })),
  );
  const context = yield* Layer.build(layer);
  const service = Context.get(context, LinkRequests);
  const ledger = Context.get(context, LinkRequestRepository);
  return { service, ledger, threads, turns, dispatched, started, events };
});

/** Real time: these suites run on the test clock, and the work under test is forked. */
const wallClockSleep = (durationMs: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));

/** Everything a watch replays on connect, up to `synced`. */
const replay = (watch: Stream.Stream<PeerWatchEvent>) =>
  watch.pipe(
    Stream.takeUntil((event) => event.type === "synced"),
    Stream.runCollect,
  );

it.layer(NodeServices.layer)("LinkRequests", (it) => {
  it.effect("records a start once: a retry gets the same thread and starts nothing more", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const first = yield* world.service.start(link(), startInput("request-1"));
      const second = yield* world.service.start(link(), startInput("request-1"));
      yield* wallClockSleep(50);

      assert.equal(first.status, "started");
      assert.deepEqual(second, first);
      assert.equal(first.threadId, linkThreadId(DEVICE, "request-1"));
      assert.equal(world.started.length, 1);
      // The thread carries where it came from, so it gets no agent tools.
      assert.deepEqual(world.started[0]?.lineage, {
        kind: "remote",
        remoteOrigin: thread(first.threadId!).remoteOrigin!,
      });
      // Never more access than the link allows.
      assert.equal(world.started[0]?.launch.runtimeMode, "auto");
    }),
  );

  it.effect("refuses a start that comes after its cancel, and a late Allow finds nothing", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      // The cancel overtook its start.
      const cancelled = yield* world.service.cancel(link(), ChildRequestId.make("request-1"));
      const late = yield* world.service.start(link(), startInput("request-1"));
      assert.equal(cancelled.status, "cancelled");
      assert.equal(late.status, "cancelled");

      // Waiting for this computer's user, then cancelled: Allow is refused.
      const waiting = yield* world.service.start(link({ access: "ask" }), startInput("request-2"));
      assert.equal(waiting.status, "awaiting_approval");
      assert.equal((yield* world.service.pending).length, 1);
      yield* world.service.cancel(link(), ChildRequestId.make("request-2"));
      const allow = yield* Effect.flip(
        world.service.respond({
          deviceId: DEVICE,
          requestId: ChildRequestId.make("request-2"),
          allow: true,
        }),
      );
      assert.include(allow.detail, "no longer waiting");
      yield* wallClockSleep(50);
      assert.equal(world.started.length, 0);
    }),
  );

  it.effect("refuses everything from a link that is off", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const refused = yield* world.service.start(link({ access: "off" }), startInput("request-1"));
      assert.equal(refused.status, "refused");
      const reports = yield* replay(world.service.watch(link()));
      assert.deepEqual(
        reports.flatMap((event) => (event.type === "report" ? [event.outcome] : [])),
        ["denied"],
      );
    }),
  );

  it.effect("answers a send with the turn its own message started, not another", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const childId = linkThreadId(DEVICE, "request-1");
      yield* world.service.start(link(), startInput("request-1"));
      world.threads.set(childId, thread(childId));
      const sent = yield* world.service.send(link(), {
        requestId: ChildRequestId.make("send-1"),
        threadId: childId,
        text: "Add the security fixes too.",
      });
      assert.equal(sent.status, "queued");
      const sendMessage = linkMessageId(DEVICE, "send-1");
      const answering = TurnId.make("turn-send");
      const child = thread(childId, {
        messages: [
          {
            id: MessageId.make("answer"),
            role: "assistant",
            text: "Added the two security fixes.",
            turnId: answering,
            streaming: false,
            createdAt: AT,
            updatedAt: AT,
          },
        ],
      });
      yield* world.service.onTurnEnd({
        child,
        end: { turnId: answering, outcome: "completed" },
        pendingMessageId: sendMessage,
        createdAt: AT,
      });
      const send = yield* world.ledger.get(DEVICE, ChildRequestId.make("send-1"));
      const start = yield* world.ledger.get(DEVICE, ChildRequestId.make("request-1"));
      assert.equal(Option.getOrThrow(send).status, "answered");
      assert.equal(Option.getOrThrow(send).reportText, "Added the two security fixes.");
      assert.notEqual(Option.getOrThrow(start).status, "answered");
    }),
  );

  it.effect(
    "after a restart: a cut-off turn is reported as interrupted, a finished one as answered, until acked",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const cutOffId = linkThreadId(DEVICE, "request-1");
        const finishedId = linkThreadId(DEVICE, "request-2");
        for (const requestId of ["request-1", "request-2"]) {
          yield* world.ledger.insert({
            linkDeviceId: DEVICE,
            requestId: ChildRequestId.make(requestId),
            status: "running",
            payload: { kind: "start", input: startInput(requestId) },
            threadId: linkThreadId(DEVICE, requestId),
            messageId: linkMessageId(DEVICE, requestId),
            now: AT,
          });
        }
        const finishedTurn = TurnId.make("turn-finished");
        world.threads.set(cutOffId, thread(cutOffId));
        world.threads.set(
          finishedId,
          thread(finishedId, {
            messages: [
              {
                id: MessageId.make("final"),
                role: "assistant",
                text: "Changelog written.",
                turnId: finishedTurn,
                streaming: false,
                createdAt: AT,
                updatedAt: AT,
              },
            ],
          }),
        );
        world.turns.push({
          threadId: finishedId,
          turnId: finishedTurn,
          pendingMessageId: linkMessageId(DEVICE, "request-2"),
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: MessageId.make("final"),
          state: "completed",
          requestedAt: AT,
          startedAt: AT,
          completedAt: AT,
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
          checkpointThreadDiffStat: null,
          checkpointCompletedAt: null,
        });

        const reactor = yield* Effect.forkChild(Effect.scoped(world.service.startReactor()));
        yield* wallClockSleep(100);
        yield* Fiber.interrupt(reactor);

        const reports = yield* replay(world.service.watch(link()));
        const byRequest = new Map(
          reports.flatMap((event) => (event.type === "report" ? [[event.requestId, event]] : [])),
        );
        assert.equal(byRequest.get(ChildRequestId.make("request-1"))?.outcome, "failed");
        assert.include(
          byRequest.get(ChildRequestId.make("request-1"))?.text ?? "",
          "interrupted by a restart on Mac mini",
        );
        assert.equal(byRequest.get(ChildRequestId.make("request-2"))?.outcome, "answered");
        assert.equal(byRequest.get(ChildRequestId.make("request-2"))?.text, "Changelog written.");

        // Acked reports are not offered again.
        for (const event of byRequest.values()) {
          if (event.type === "report") yield* world.service.ack(link(), event.reportId);
        }
        const after = yield* replay(world.service.watch(link()));
        assert.deepEqual(
          after.map((event) => event.type),
          ["synced"],
        );
      }),
  );
});
