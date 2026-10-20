import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChildRequestBatchId,
  ChildRequestId,
  ComputerLinkId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EMPTY_AGENT_REQUEST_STATE,
  EMPTY_CHILD_REQUEST_STATE,
  EnvironmentId,
  MessageId,
  type OrchestrationChildRequest,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type PeerWatchEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ComputerLinkClient, type PeerClient } from "./ComputerLinkClient.ts";
import { ComputerLinkRepository, type ComputerLinkRow } from "./ComputerLinkRepository.ts";
import { RemoteChildReactor, RemoteChildReactorLive } from "./RemoteChildReactor.ts";

const AT = "2026-10-20T10:00:00.000Z";
const MAC_MINI = EnvironmentId.make("env-mac-mini");
const PARENT = ThreadId.make("parent");
const REMOTE_CHILD = ThreadId.make("remote-child");
const REQUEST = ChildRequestId.make("request-1");

const LINK: ComputerLinkRow = {
  linkId: ComputerLinkId.make("link-1"),
  remoteEnvironmentId: MAC_MINI,
  remoteLabel: "Mac mini",
  remotePlatform: "macOS",
  relayOrigin: "http://relay.test",
  hostId: "host-1",
  deviceId: "device-1",
  hostPublicKey: "key",
  directRoutes: [],
  state: "active",
  createdAt: AT,
  lastConnectedAt: AT,
  lastError: null,
};

const remoteRequest = (
  patch: Partial<OrchestrationChildRequest> = {},
): OrchestrationChildRequest => ({
  requestId: REQUEST,
  batchId: ChildRequestBatchId.make("batch-1"),
  kind: "start",
  from: { participantId: null },
  callerTurnId: TurnId.make("parent-turn"),
  deliveryEpoch: 0,
  status: "running",
  childThreadId: REMOTE_CHILD,
  childMessageId: MessageId.make("child-message"),
  remote: {
    environmentId: MAC_MINI,
    label: "Mac mini",
    threadId: REMOTE_CHILD,
    status: "accepted",
    cancelRequested: false,
  },
  createdAt: AT,
  ...patch,
});

const parentThread = (
  patch: Partial<OrchestrationThread["childRequests"]>,
): OrchestrationThread => ({
  id: PARENT,
  projectId: ProjectId.make("project-1"),
  title: "Ship the release",
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
  childRequests: { ...EMPTY_CHILD_REQUEST_STATE, ...patch },
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
});

const wallClockSleep = (durationMs: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));

/** The parent's computer, with the linked computer behind a fake peer client. */
const makeWorld = (input: {
  readonly parent: OrchestrationThread;
  readonly watch: ReadonlyArray<PeerWatchEvent>;
}) =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];
    let parent = input.parent;
    const calls: Array<{ readonly method: string; readonly payload: unknown }> = [];
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const watchOpen = yield* Deferred.make<void>();
    const record =
      <A>(method: string, answer: A) =>
      (payload: unknown) =>
        Effect.sync(() => {
          calls.push({ method, payload });
          return answer;
        });
    const peer = {
      "peer.watch": () =>
        Stream.fromEffect(Deferred.await(watchOpen)).pipe(
          Stream.flatMap(() => Stream.fromIterable(input.watch)),
        ),
      "peer.report.ack": record("peer.report.ack", undefined),
      "peer.request.cancel": record("peer.request.cancel", { status: "cancelled" as const }),
      "peer.thread.stop": record("peer.thread.stop", { status: "stopped" as const }),
      "peer.request.start": record("peer.request.start", {
        status: "started" as const,
        threadId: REMOTE_CHILD,
      }),
    } as unknown as PeerClient;

    const layer = RemoteChildReactorLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(OrchestrationEngineService)({
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command);
                // The one decision whose effect the reactor reads back.
                if (command.type === "thread.remote-cancels.delivered") {
                  parent = {
                    ...parent,
                    childRequests: {
                      ...parent.childRequests,
                      remoteCancels: (parent.childRequests.remoteCancels ?? []).filter(
                        (cancel) => !command.requestIds.includes(cancel.requestId),
                      ),
                    },
                  };
                }
                return { sequence: dispatched.length };
              }),
            subscribeDomainEvents: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
          }),
          Layer.mock(ProjectionSnapshotQuery)({
            getThreadDetailById: (threadId) =>
              Effect.sync(() => (threadId === PARENT ? Option.some(parent) : Option.none())),
          }),
          Layer.mock(ComputerLinkClient)({
            withPeer: (_environmentId, use) => use(peer),
            peerStream: (_environmentId, use) => use(peer),
          }),
          Layer.mock(ComputerLinkRepository)({
            list: Effect.succeed([LINK]),
            getByEnvironment: () => Effect.succeed(Option.some(LINK)),
          }),
          Layer.mock(ServerEnvironment)({
            getDescriptor: Effect.succeed({
              environmentId: EnvironmentId.make("env-windows"),
              label: "Windows PC",
              platform: { os: "windows", arch: "x64" },
              serverVersion: "0.0.0",
              capabilities: { repositoryIdentity: true },
            }),
          }),
        ),
      ),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "remote-child-test-" })),
    );
    const context = yield* Layer.build(layer);
    const reactor = Context.get(context, RemoteChildReactor);
    yield* reactor.start();
    // The parent's request becomes known to the reactor the way a live one
    // does, then the linked computer's watch answers.
    for (const request of input.parent.childRequests.open) {
      yield* PubSub.publish(events, {
        sequence: 1,
        eventId: "event-1",
        aggregateKind: "thread",
        aggregateId: PARENT,
        occurredAt: AT,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.child-request-submitted",
        payload: { threadId: PARENT, request, createdAt: AT },
      } as unknown as OrchestrationEvent);
    }
    for (const cancel of input.parent.childRequests.remoteCancels ?? []) {
      yield* PubSub.publish(events, {
        sequence: 2,
        eventId: "event-2",
        aggregateKind: "thread",
        aggregateId: PARENT,
        occurredAt: AT,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.remote-cancel-queued",
        payload: { threadId: PARENT, cancel, createdAt: AT },
      } as unknown as OrchestrationEvent);
    }
    yield* wallClockSleep(50);
    yield* Deferred.succeed(watchOpen, undefined);
    yield* wallClockSleep(150);
    return { dispatched, calls };
  });

const report = (patch: Partial<Extract<PeerWatchEvent, { type: "report" }>>): PeerWatchEvent => ({
  type: "report",
  reportId: `${REQUEST}:report`,
  requestId: REQUEST,
  threadId: REMOTE_CHILD,
  outcome: "answered",
  text: "Changelog written.",
  turnId: "remote-turn-1",
  settledAt: AT,
  ...patch,
});

it.layer(NodeServices.layer)("RemoteChildReactor", (it) => {
  it.effect(
    "settles the parent with a linked computer's refusal, as a plain reply, then acks it",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld({
          parent: parentThread({ open: [remoteRequest({ status: "starting" })] }),
          watch: [
            report({ outcome: "denied", text: "Mac mini didn't allow it.", turnId: null }),
            { type: "synced" },
          ],
        });
        const settle = world.dispatched.find(
          (command) => command.type === "thread.child-request.settle",
        );
        assert.deepInclude(settle, {
          requestId: REQUEST,
          outcome: "declined",
          reply: {
            messageId: MessageId.make(`child-report:${REQUEST}`),
            text: "Mac mini didn't allow it.",
            turnId: null,
          },
        });
        assert.deepEqual(
          world.calls
            .filter((call) => call.method === "peer.report.ack")
            .map((call) => call.payload),
          [{ reportId: `${REQUEST}:report` }],
        );
      }),
  );

  it.effect("acks a report it already recorded before a restart, without recording it twice", () =>
    Effect.gen(function* () {
      // The request settled before the restart; only the ack was lost.
      const world = yield* makeWorld({
        parent: parentThread({ open: [] }),
        watch: [report({}), { type: "synced" }],
      });
      assert.isFalse(
        world.dispatched.some((command) => command.type === "thread.child-request.settle"),
      );
      assert.deepEqual(
        world.calls.filter((call) => call.method === "peer.report.ack").map((call) => call.payload),
        [{ reportId: `${REQUEST}:report` }],
      );
    }),
  );

  it.effect("sends a stop owed to a linked computer, then takes it out of the outbox", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld({
        parent: parentThread({
          open: [],
          remoteCancels: [
            {
              requestId: REQUEST,
              environmentId: MAC_MINI,
              threadId: REMOTE_CHILD,
              cancelRequest: true,
              stopThread: true,
              createdAt: AT,
            },
          ],
        }),
        watch: [{ type: "synced" }],
      });
      assert.deepEqual(
        world.calls
          .filter(
            (call) => call.method === "peer.request.cancel" || call.method === "peer.thread.stop",
          )
          .map((call) => call.method),
        ["peer.request.cancel", "peer.thread.stop"],
      );
      assert.deepInclude(
        world.dispatched.find((command) => command.type === "thread.remote-cancels.delivered"),
        { threadId: PARENT, requestIds: [REQUEST] },
      );
    }),
  );

  it.effect("sends a start still owed, and records the thread the linked computer made", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld({
        parent: parentThread({
          open: [
            remoteRequest({
              status: "starting",
              remote: {
                environmentId: MAC_MINI,
                label: "Mac mini",
                threadId: null,
                status: "sending",
                cancelRequested: false,
              },
              launch: {
                title: "Write the changelog",
                prompt: "Write the changelog.",
                modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
                runtimeMode: "auto",
                interactionMode: "default",
                reportBack: true,
                runSetup: true,
                workspace: { kind: "remote", projectKey: "github.com/x/y", checkout: "worktree" },
                target: { environmentId: MAC_MINI, label: "Mac mini" },
              },
            }),
          ],
        }),
        watch: [{ type: "synced" }],
      });
      const start = world.calls.find((call) => call.method === "peer.request.start");
      assert.deepInclude(start?.payload as object, {
        requestId: REQUEST,
        projectKey: "github.com/x/y",
        title: "Write the changelog",
        agent: { instanceId: "codex", model: "gpt-6" },
      });
      assert.deepInclude(
        world.dispatched.find((command) => command.type === "thread.child-request.update"),
        {
          requestId: REQUEST,
          status: "queued",
          remote: {
            environmentId: MAC_MINI,
            label: "Mac mini",
            threadId: REMOTE_CHILD,
            status: "accepted",
            cancelRequested: false,
          },
        },
      );
      assert.isTrue(
        world.dispatched.some((command) => command.type === "thread.remote-child.update"),
      );
    }),
  );
});
