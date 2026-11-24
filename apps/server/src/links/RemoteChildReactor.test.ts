import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChildRequestBatchId,
  ChildRequestId,
  CommandId,
  ComputerLinkId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EnvironmentId,
  MessageId,
  type PeerDescriptor,
  type PeerStartResult,
  type PeerWatchEvent,
  type RemoteThreadFiling,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { childReportMessageId } from "../orchestration/childThreadDecisions.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "../persistence/Services/ProjectionThreads.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import {
  ComputerLinkClient,
  ComputerLinkUnavailableError,
  type PeerClient,
} from "./ComputerLinkClient.ts";
import { ComputerLinkRepository, type ComputerLinkRow } from "./ComputerLinkRepository.ts";
import { RemoteChildReactor, RemoteChildReactorLive } from "./RemoteChildReactor.ts";

const AT = "2026-10-20T10:00:00.000Z";
const MAC_MINI = EnvironmentId.make("env-mac-mini");
const PROJECT = ProjectId.make("project-1");
const PARENT = ThreadId.make("parent");
const REMOTE_CHILD = ThreadId.make("remote-child");
const REQUEST = ChildRequestId.make("request-1");
const CALLER_TURN = TurnId.make("parent-turn");
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };

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

/** Real time: these suites run on the test clock, and the work under test is forked. */
const wallClockSleep = (durationMs: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));

const eventually = <E, R>(check: Effect.Effect<boolean, E, R>, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (yield* check) return;
      yield* wallClockSleep(20);
    }
    return yield* Effect.die(new Error(`Timed out waiting until ${what}.`));
  });

const unreachable = new ComputerLinkUnavailableError({
  environmentId: MAC_MINI,
  detail: "The other computer didn't answer in time.",
  revoked: false,
});

/** How the linked computer answers, for one test. */
interface LinkedComputer {
  readonly start?: () => Effect.Effect<PeerStartResult, ComputerLinkUnavailableError>;
  /** Replayed every time a watch opens, which then stays open. */
  readonly watch?: ReadonlyArray<PeerWatchEvent>;
  /** It says how threads are filed and takes `peer.thread.wrap` (`PeerDescriptor.threadFiling`). */
  readonly threadFiling?: boolean;
  /** It enforces `PeerSendInput.ceiling` (`PeerDescriptor.enforcesRequestCeiling`). */
  readonly enforcesRequestCeiling?: boolean;
}

/**
 * The parent's computer: the real orchestration engine and projections, with
 * a parent whose agent asked Mac mini for a thread. `boot` starts a reactor
 * on it (booting after changes is a restart); the linked computer is a fake
 * peer that records every call.
 */
const makeComputer = Effect.gen(function* () {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remote-child-project-"));
  const base = ProjectionThreadRepositoryLive.pipe(
    Layer.provideMerge(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      ),
    ),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(
      Layer.mock(RepositoryIdentityResolver)({ resolve: () => Effect.succeed(null) }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "remote-child-test-" })),
  );
  const context = yield* Layer.build(base);
  const engine = Context.get(context, OrchestrationEngineService);
  const snapshots = Context.get(context, ProjectionSnapshotQuery);
  const threadRows = Context.get(context, ProjectionThreadRepository);

  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("project-create"),
    projectId: PROJECT,
    title: "threadlines",
    workspaceRoot,
    defaultModelSelection: null,
    createdAt: AT,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("parent-create"),
    threadId: PARENT,
    projectId: PROJECT,
    title: "Ship the release",
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    createdAt: AT,
  });
  yield* engine.dispatch({
    type: "thread.session.set",
    commandId: CommandId.make("parent-session"),
    threadId: PARENT,
    session: {
      threadId: PARENT,
      status: "running",
      providerName: "codex",
      providerInstanceId: MODEL.instanceId,
      runtimeMode: "full-access",
      activeTurnId: CALLER_TURN,
      lastError: null,
      updatedAt: AT,
    },
    createdAt: AT,
  });

  /** The parent's agent asks Mac mini for a thread. */
  const askForThread = engine.dispatch({
    type: "thread.child.start",
    commandId: CommandId.make("child-start"),
    threadId: PARENT,
    batchId: ChildRequestBatchId.make("batch-1"),
    from: { participantId: null },
    callerTurnId: CALLER_TURN,
    mode: "auto",
    children: [
      {
        requestId: REQUEST,
        childThreadId: REMOTE_CHILD,
        childMessageId: MessageId.make("child-message"),
        launch: {
          title: "Write the changelog",
          prompt: "Write the changelog.",
          modelSelection: MODEL,
          runtimeMode: "auto",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          reportBack: true,
          runSetup: true,
          workspace: { kind: "remote", projectKey: "github.com/x/y", checkout: "worktree" },
          target: { environmentId: MAC_MINI, label: "Mac mini" },
        },
      },
    ],
    createdAt: AT,
  });

  /** What an earlier process recorded of Mac mini's answer to the start. */
  const recordRemote = (
    status: "starting" | "running",
    remote: {
      readonly status: "accepted" | "awaiting_approval";
      readonly threadId: ThreadId | null;
    },
  ) =>
    engine.dispatch({
      type: "thread.child-request.update",
      commandId: CommandId.make(`remote-${remote.status}`),
      threadId: PARENT,
      requestId: REQUEST,
      status,
      remote: { environmentId: MAC_MINI, label: "Mac mini", ...remote },
      createdAt: AT,
    });

  const calls: Array<{ readonly method: string; readonly payload: unknown }> = [];

  /** Starts a reactor; `patch` swaps parts of its process to make them fail. */
  const boot = (
    linked: LinkedComputer = {},
    patch: {
      readonly threadRows?: Partial<ProjectionThreadRepositoryShape>;
      readonly engine?: Partial<OrchestrationEngineShape>;
    } = {},
  ) =>
    Effect.gen(function* () {
      const answer =
        <A>(method: string, reply: () => Effect.Effect<A, ComputerLinkUnavailableError>) =>
        (payload: unknown) =>
          Effect.suspend(() => {
            calls.push({ method, payload });
            return reply();
          });
      const peer = {
        "peer.watch": (payload: unknown) => {
          calls.push({ method: "peer.watch", payload });
          return Stream.concat(
            Stream.fromIterable(linked.watch ?? [{ type: "synced" }]),
            Stream.never,
          );
        },
        "peer.thread.wrap": answer("peer.thread.wrap", () =>
          Effect.succeed({ status: "ok" as const }),
        ),
        "peer.report.ack": answer("peer.report.ack", () => Effect.void),
        "peer.request.cancel": answer("peer.request.cancel", () =>
          Effect.succeed({ status: "cancelled" as const }),
        ),
        "peer.thread.stop": answer("peer.thread.stop", () =>
          Effect.succeed({ status: "stopped" as const }),
        ),
        "peer.request.start": answer(
          "peer.request.start",
          linked.start ??
            (() => Effect.succeed({ status: "started" as const, threadId: REMOTE_CHILD })),
        ),
        "peer.request.send": answer("peer.request.send", () =>
          Effect.succeed({ status: "queued" as const }),
        ),
      } as unknown as PeerClient;
      const layer = RemoteChildReactorLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProjectionThreadRepository, { ...threadRows, ...patch.threadRows }),
            Layer.succeed(OrchestrationEngineService, { ...engine, ...patch.engine }),
            Layer.mock(ComputerLinkClient)({
              withPeer: (_environmentId, use) => use(peer) as never,
              peerStream: (_environmentId, use) => use(peer) as never,
              cachedDescribe: () => null,
              describe: () =>
                Effect.succeed({
                  threadFiling: linked.threadFiling === true,
                  ...(linked.enforcesRequestCeiling === true
                    ? { enforcesRequestCeiling: true }
                    : {}),
                } as unknown as PeerDescriptor),
              noteRemoteLabel: () => undefined,
            }),
            Layer.mock(ComputerLinkRepository)({
              list: Effect.succeed([LINK]),
              getByEnvironment: () => Effect.succeed(Option.some(LINK)),
            }),
            ServerEnvironment.layerTest({
              environmentId: EnvironmentId.make("env-windows"),
              label: "Windows PC",
              platform: { os: "windows", arch: "x64" },
            }),
          ),
        ),
        Layer.provide(Layer.succeedContext(context)),
      );
      const reactor = Context.get(yield* Layer.build(layer), RemoteChildReactor);
      yield* reactor.start();
    });

  /** The parent as stored, archived or not. */
  const stored = threadRows
    .getById({ threadId: PARENT })
    .pipe(Effect.map((row) => Option.getOrThrow(row)));
  const callsTo = (method: string) => calls.filter((call) => call.method === method);

  return { engine, snapshots, threadRows, askForThread, recordRemote, boot, stored, callsTo };
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
  it.effect("sends a start still owed, and records the thread the linked computer made", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* computer.askForThread;
      yield* computer.boot();
      yield* eventually(
        Effect.map(
          computer.stored,
          (parent) => (parent.childRequests?.remoteChildren ?? []).length > 0,
        ),
        "the child is recorded",
      );
      assert.deepInclude(computer.callsTo("peer.request.start")[0]?.payload as object, {
        requestId: REQUEST,
        projectKey: "github.com/x/y",
        title: "Write the changelog",
        agent: { instanceId: "codex", model: "gpt-6-astra" },
      });
      const parent = yield* computer.stored;
      assert.deepEqual(parent.childRequests?.open[0]?.remote, {
        environmentId: MAC_MINI,
        label: "Mac mini",
        threadId: REMOTE_CHILD,
        status: "accepted",
      });
      assert.equal(parent.childRequests?.remoteChildren?.[0]?.threadId, REMOTE_CHILD);
    }),
  );

  it.effect("settles the parent with a linked computer's refusal, then acks it", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* computer.askForThread;
      yield* computer.recordRemote("starting", { status: "awaiting_approval", threadId: null });
      yield* computer.boot({
        watch: [
          report({
            outcome: "denied",
            text: "Mac mini didn't allow it.",
            turnId: null,
            threadId: null,
          }),
          { type: "synced" },
        ],
      });
      yield* eventually(
        Effect.map(computer.stored, (parent) => (parent.childRequests?.open ?? []).length === 0),
        "the request settles",
      );
      yield* eventually(
        Effect.sync(() => computer.callsTo("peer.report.ack").length > 0),
        "the report is acked",
      );
      const parent = yield* computer.stored;
      // Nothing ran there, so no thread is remembered.
      assert.deepEqual(parent.childRequests?.remoteChildren ?? [], []);
      const detail = Option.getOrThrow(yield* computer.snapshots.getThreadDetailById(PARENT));
      const replyId = childReportMessageId(REQUEST);
      const reply = [
        ...detail.messages.map((message) => ({ id: message.id, text: message.text })),
        ...(detail.queuedFollowUps ?? []).map((queued) => ({
          id: queued.messageId,
          text: queued.text,
        })),
      ].find((entry) => entry.id === replyId);
      assert.include(reply?.text ?? "", "Mac mini didn't allow it.");
      // The answer was written into the parent, and the ack says so.
      assert.deepEqual(computer.callsTo("peer.report.ack")[0]?.payload, {
        reportId: `${REQUEST}:report`,
        delivered: true,
      });
    }),
  );

  it.effect(
    "keeps hearing a child after its answer is in, and asks how it stands after a restart",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        yield* computer.askForThread;
        yield* computer.recordRemote("running", { status: "accepted", threadId: REMOTE_CHILD });
        const filing: RemoteThreadFiling = {
          handedBackAt: null,
          pinned: false,
          override: null,
          lastActivityAt: "2026-10-20T10:30:00.000Z",
          seenAt: "2026-10-20T10:31:00.000Z",
          unseen: false,
          waiting: false,
          archived: false,
        };
        // The report ends the request; then the user picks the thread up again
        // there, and that computer says so.
        yield* computer.boot({
          watch: [
            report({}),
            {
              type: "thread",
              threadId: REMOTE_CHILD,
              title: "Write the changelog",
              status: "working",
              updatedAt: "2026-10-20T10:30:00.000Z",
              filing,
            },
            { type: "synced" },
          ],
        });
        yield* eventually(
          Effect.map(
            computer.stored,
            (parent) => parent.childRequests?.remoteChildren?.[0]?.cachedStatus === "working",
          ),
          "the child's new work is recorded",
        );
        const [child] = (yield* computer.stored).childRequests?.remoteChildren ?? [];
        assert.deepEqual(child?.filing, filing);
        assert.lengthOf((yield* computer.stored).childRequests?.open ?? [], 0);

        // A restart asks that computer how the child it still shows stands.
        yield* computer.boot();
        yield* eventually(
          Effect.sync(() =>
            computer
              .callsTo("peer.watch")
              .some(
                (call) =>
                  (call.payload as { threads?: unknown }).threads !== undefined &&
                  JSON.stringify((call.payload as { threads: unknown }).threads) ===
                    JSON.stringify([REMOTE_CHILD]),
              ),
          ),
          "the watch asks about the child",
        );
      }),
  );

  it.effect("acks a report whose answer never reached the parent as not delivered", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* computer.askForThread;
      yield* computer.recordRemote("running", { status: "accepted", threadId: REMOTE_CHILD });
      // Nothing to say: no answer is written into the parent.
      yield* computer.boot({ watch: [report({ text: "" }), { type: "synced" }] });
      yield* eventually(
        Effect.sync(() => computer.callsTo("peer.report.ack").length > 0),
        "the report is acked",
      );
      assert.deepEqual(computer.callsTo("peer.report.ack")[0]?.payload, {
        reportId: `${REQUEST}:report`,
        delivered: false,
      });
    }),
  );

  it.effect("sends the user's Wrap up of a child there once, to a computer that takes it", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* computer.askForThread;
      yield* computer.recordRemote("running", { status: "accepted", threadId: REMOTE_CHILD });
      yield* computer.boot({ watch: [report({}), { type: "synced" }], threadFiling: true });
      yield* eventually(
        Effect.map(computer.stored, (parent) => (parent.childRequests?.open ?? []).length === 0),
        "the request settles",
      );
      const override = { state: "done" as const, at: "2026-10-20T11:00:00.000Z" };
      yield* computer.engine.dispatch({
        type: "thread.remote-child.done-override.set",
        commandId: CommandId.make("wrap-child"),
        threadId: PARENT,
        environmentId: MAC_MINI,
        childThreadId: REMOTE_CHILD,
        ...override,
      });
      yield* eventually(
        Effect.sync(() => computer.callsTo("peer.thread.wrap").length > 0),
        "the wrap goes to that computer",
      );
      assert.deepEqual(computer.callsTo("peer.thread.wrap")[0]?.payload, {
        threadId: REMOTE_CHILD,
        override,
      });
      assert.deepEqual(
        (yield* computer.stored).childRequests?.remoteChildren?.[0]?.override,
        override,
      );
      // Later news of the child doesn't send it again.
      yield* wallClockSleep(100);
      assert.lengthOf(computer.callsTo("peer.thread.wrap"), 1);
    }),
  );

  it.effect("acks a report it already recorded before a restart, without recording it again", () =>
    Effect.gen(function* () {
      // Nothing is open here: the request settled before the restart, only the ack was lost.
      const computer = yield* makeComputer;
      yield* computer.boot({ watch: [report({}), { type: "synced" }] });
      yield* eventually(
        Effect.sync(() => computer.callsTo("peer.report.ack").length > 0),
        "the report is acked",
      );
      const detail = Option.getOrThrow(yield* computer.snapshots.getThreadDetailById(PARENT));
      assert.isFalse(
        detail.messages.some((message) => message.id === childReportMessageId(REQUEST)),
      );
    }),
  );

  it.effect(
    "records the child from a report even when it never heard the start was allowed (it was offline)",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        yield* computer.askForThread;
        yield* computer.recordRemote("starting", { status: "awaiting_approval", threadId: null });
        // Allowed and finished on Mac mini while this computer was away.
        yield* computer.boot({ watch: [report({}), { type: "synced" }] });
        yield* eventually(
          Effect.map(computer.stored, (parent) => (parent.childRequests?.open ?? []).length === 0),
          "the request settles",
        );
        const parent = yield* computer.stored;
        assert.deepInclude(parent.childRequests?.remoteChildren?.[0], {
          environmentId: MAC_MINI,
          threadId: REMOTE_CHILD,
          cachedStatus: "idle",
        });
      }),
  );

  it.effect(
    "delivers the cancels an archived parent owes, also when it starts after the archive",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        yield* computer.askForThread;
        yield* computer.recordRemote("running", { status: "accepted", threadId: REMOTE_CHILD });
        // Archived while no reactor ran (the computer was restarting).
        yield* computer.engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive-parent"),
          threadId: PARENT,
        });
        assert.equal((yield* computer.stored).childRequests?.remoteCancels?.length, 1);

        yield* computer.boot();
        yield* eventually(
          Effect.map(
            computer.stored,
            (parent) => (parent.childRequests?.remoteCancels ?? []).length === 0,
          ),
          "the cancel is delivered and leaves the outbox",
        );
        assert.deepEqual(computer.callsTo("peer.request.cancel")[0]?.payload, {
          requestId: REQUEST,
          stopThread: true,
        });
      }),
  );

  it.effect(
    "Stop after a lost start reply still asks the linked computer to stop what the start began",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        yield* computer.askForThread;
        // Mac mini got the start, but its answer never arrived.
        yield* computer.boot({ start: () => Effect.fail(unreachable) });
        yield* eventually(
          Effect.sync(() => computer.callsTo("peer.request.start").length > 0),
          "the start is sent",
        );
        assert.isNull((yield* computer.stored).childRequests?.open[0]?.remote?.threadId);

        yield* computer.engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make("stop-parent"),
          threadId: PARENT,
          createdAt: AT,
        });
        yield* eventually(
          Effect.sync(() => computer.callsTo("peer.request.cancel").length > 0),
          "the cancel is sent",
        );
        assert.deepEqual(computer.callsTo("peer.request.cancel")[0]?.payload, {
          requestId: REQUEST,
          stopThread: true,
        });
      }),
  );
  it.effect("a report whose parent can't be read is not acked, so it is offered again", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* computer.askForThread;
      yield* computer.recordRemote("starting", { status: "awaiting_approval", threadId: null });
      yield* computer.boot(
        { watch: [report({}), { type: "synced" }] },
        {
          threadRows: {
            getById: () =>
              Effect.fail(new PersistenceSqlError({ operation: "getById", detail: "busy" })),
          },
        },
      );
      yield* wallClockSleep(200);
      assert.deepEqual(computer.callsTo("peer.report.ack"), []);
      assert.equal((yield* computer.stored).childRequests?.open.length, 1);
    }),
  );

  it.effect("records the child a report names in the same write that settles the request", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* computer.askForThread;
      yield* computer.recordRemote("running", { status: "accepted", threadId: REMOTE_CHILD });
      // A separate write recording the child would fail.
      yield* computer.boot(
        { watch: [report({}), { type: "synced" }] },
        {
          engine: {
            dispatch: (command) =>
              command.type === "thread.remote-child.update"
                ? Effect.fail(
                    new PersistenceSqlError({ operation: "dispatch", detail: "disk full" }),
                  )
                : computer.engine.dispatch(command),
          },
        },
      );
      yield* eventually(
        Effect.sync(() => computer.callsTo("peer.report.ack").length > 0),
        "the report is acked",
      );
      const parent = yield* computer.stored;
      assert.deepEqual(parent.childRequests?.open ?? [], []);
      assert.deepInclude(parent.childRequests?.remoteChildren?.[0], {
        threadId: REMOTE_CHILD,
        cachedStatus: "idle",
      });
    }),
  );

  it.effect(
    "a parent frozen for its move takes no answer and acks no report, while the cancels it owes still go",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        yield* computer.askForThread;
        yield* computer.recordRemote("running", { status: "accepted", threadId: REMOTE_CHILD });
        // The parent reads as frozen for its move (docs/design/fleet.md, Part
        // 3f, (g)), a request still open on it.
        const frozen = {
          move: {
            transferId: "transfer-1",
            target: { environmentId: EnvironmentId.make("env-other"), label: "Other" },
            agent: MODEL,
            phase: "exporting",
            cancelRequested: false,
            startedAt: AT,
          },
        };
        const asFrozen = {
          getById: (input: { readonly threadId: ThreadId }) =>
            computer.threadRows
              .getById(input)
              .pipe(Effect.map(Option.map((row) => ({ ...row, ...frozen }) as typeof row))),
        };
        yield* computer.boot({ watch: [report({}), { type: "synced" }] }, { threadRows: asFrozen });
        yield* eventually(
          Effect.sync(() => computer.callsTo("peer.watch").length > 0),
          "the watch opens",
        );
        yield* wallClockSleep(300);
        // Its answer would be refused there and lost: it stays with that computer.
        assert.deepEqual(computer.callsTo("peer.report.ack"), []);
        assert.lengthOf((yield* computer.stored).childRequests?.open ?? [], 1);

        // Stop (as the move's "Stop and move now" does) owes that computer a
        // cancel: it still goes out from a frozen parent.
        yield* computer.engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make("parent-stop"),
          threadId: PARENT,
          createdAt: AT,
        });
        yield* computer.boot({}, { threadRows: asFrozen });
        yield* eventually(
          Effect.sync(() => computer.callsTo("peer.request.cancel").length > 0),
          "the cancel goes out",
        );
        yield* eventually(
          Effect.map(
            computer.stored,
            (parent) => (parent.childRequests?.remoteCancels ?? []).length === 0,
          ),
          "the cancel is recorded as delivered",
        );
      }),
  );

  it.effect(
    "a parent that moved away acks a report about its thread there as not delivered, never again offered",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        yield* computer.askForThread;
        yield* computer.recordRemote("running", { status: "accepted", threadId: REMOTE_CHILD });
        // Its copy here is read-only: it moved to Mac mini (and may have taken
        // that thread back as its own there, docs/design/fleet.md, Part 3f, (g)).
        const movedAway = {
          move: {
            transferId: "transfer-1",
            target: { environmentId: MAC_MINI, label: "Mac mini" },
            agent: MODEL,
            phase: "exporting",
            cancelRequested: false,
            startedAt: AT,
            movedAway: { threadId: ThreadId.make("thread-there"), movedAt: AT },
          },
        };
        const asMoved = {
          getById: (input: { readonly threadId: ThreadId }) =>
            computer.threadRows
              .getById(input)
              .pipe(Effect.map(Option.map((row) => ({ ...row, ...movedAway }) as typeof row))),
        };
        yield* computer.boot({ watch: [report({}), { type: "synced" }] }, { threadRows: asMoved });
        yield* eventually(
          Effect.sync(() => computer.callsTo("peer.report.ack").length > 0),
          "the report is acked",
        );
        assert.deepEqual(computer.callsTo("peer.report.ack")[0]?.payload, {
          reportId: `${REQUEST}:report`,
          delivered: false,
        });
        // Nothing was written into the read-only copy.
        assert.lengthOf((yield* computer.stored).childRequests?.open ?? [], 1);
      }),
  );

  it.effect(
    "carries the sender's ceiling to an updated peer, and refuses a narrower sender to an older peer",
    () =>
      Effect.gen(function* () {
        const submitSend = (
          computer: Effect.Success<typeof makeComputer>,
          requestId: ChildRequestId,
          runtimeMode: "auto-accept-edits" | "full-access",
        ) =>
          Effect.gen(function* () {
            yield* computer.askForThread;
            yield* computer.recordRemote("running", {
              status: "accepted",
              threadId: REMOTE_CHILD,
            });
            yield* computer.engine.dispatch({
              type: "thread.remote-child.update",
              commandId: CommandId.make(`record-${requestId}`),
              threadId: PARENT,
              child: {
                environmentId: MAC_MINI,
                label: "Mac mini",
                threadId: REMOTE_CHILD,
                title: "Remote worker",
                handle: "Claude",
                attachmentEpoch: 0,
                cachedStatus: "idle",
                updatedAt: AT,
              },
              createdAt: AT,
            });
            yield* computer.engine.dispatch({
              type: "thread.runtime-mode.set",
              commandId: CommandId.make(`mode-${requestId}`),
              threadId: PARENT,
              runtimeMode,
              createdAt: AT,
            });
            yield* computer.engine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make(`session-${requestId}`),
              threadId: PARENT,
              session: {
                threadId: PARENT,
                status: "running",
                providerName: "claudeAgent",
                providerInstanceId: ProviderInstanceId.make("claudeAgent"),
                runtimeMode,
                activeTurnId: TurnId.make("turn-1"),
                lastError: null,
                updatedAt: AT,
              },
              createdAt: AT,
            });
            yield* computer.engine.dispatch({
              type: "thread.child.send",
              commandId: CommandId.make(`send-${requestId}`),
              threadId: PARENT,
              requestId,
              from: { participantId: null },
              callerTurnId: TurnId.make("turn-1"),
              childThreadId: REMOTE_CHILD,
              childMessageId: MessageId.make(`msg-${requestId}`),
              text: "Check the build.",
              createdAt: AT,
            });
          });

        // Narrow sender -> older peer (no enforcesRequestCeiling): refused and settled failed.
        const older = yield* makeComputer;
        yield* submitSend(older, ChildRequestId.make("req-older-narrow"), "auto-accept-edits");
        yield* older.boot({ enforcesRequestCeiling: false });
        yield* eventually(
          Effect.map(
            older.stored,
            (parent) =>
              !(parent.childRequests?.open ?? []).some(
                (entry) => entry.requestId === ChildRequestId.make("req-older-narrow"),
              ),
          ),
          "narrow send to older peer settles failed",
        );
        assert.deepEqual(older.callsTo("peer.request.send"), []);

        // Widest sender -> older peer: allowed, no ceiling can be broken.
        const widest = yield* makeComputer;
        yield* submitSend(widest, ChildRequestId.make("req-older-wide"), "full-access");
        yield* widest.boot({ enforcesRequestCeiling: false });
        yield* eventually(
          Effect.sync(() => widest.callsTo("peer.request.send").length === 1),
          "widest send to older peer goes through",
        );

        // Narrow sender -> updated peer: carries ceiling.
        const updated = yield* makeComputer;
        yield* submitSend(updated, ChildRequestId.make("req-updated-narrow"), "auto-accept-edits");
        yield* updated.boot({ enforcesRequestCeiling: true });
        yield* eventually(
          Effect.sync(() => updated.callsTo("peer.request.send").length === 1),
          "narrow send to updated peer goes through with ceiling",
        );
        assert.deepEqual(
          (updated.callsTo("peer.request.send")[0]?.payload as { readonly ceiling?: unknown })
            ?.ceiling,
          { runtimeMode: "auto-accept-edits", interactionMode: "default" },
        );
      }),
  );
});
