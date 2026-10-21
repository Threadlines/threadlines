import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChildRequestId,
  CommandId,
  EnvironmentId,
  MessageId,
  type OrchestrationEvent,
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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { childRequestCommandId } from "../orchestration/childRequestIds.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ThreadBootstrapLive } from "../orchestration/Layers/ThreadBootstrap.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ThreadBootstrap,
  type ThreadBootstrapShape,
} from "../orchestration/Services/ThreadBootstrap.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import {
  RelayDeviceRepository,
  RelayDeviceRepositoryLive,
} from "../relay/RelayDeviceRepository.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { linkBootstrapKey, linkMessageId, linkThreadId } from "./linkIds.ts";
import {
  LinkRequestRepository,
  LinkRequestRepositoryError,
  LinkRequestRepositoryLive,
  type LinkRequestRepositoryShape,
} from "./LinkRequestRepository.ts";
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

/** Real time: these suites run on the test clock, and the work under test is forked. */
const wallClockSleep = (durationMs: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));

/** Waits (in real time) until `check` holds. */
const eventually = <E, R>(check: Effect.Effect<boolean, E, R>, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (yield* check) return;
      yield* wallClockSleep(20);
    }
    return yield* Effect.die(new Error(`Timed out waiting until ${what}.`));
  });

/** Everything a watch replays on connect, up to `synced`. */
const replay = (watch: Stream.Stream<PeerWatchEvent>) =>
  watch.pipe(
    Stream.takeUntil((event) => event.type === "synced"),
    Stream.runCollect,
  );

/**
 * The child's computer: the real orchestration engine, projections, thread
 * setup and ledger on one database. `boot` starts a LinkRequests process on
 * it; booting another one later is a restart, and `patch` swaps parts of a
 * process to stop it at a chosen point (a crash) or hold it there.
 */
const makeComputer = Effect.gen(function* () {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "link-requests-project-"));
  const orchestration = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );
  const bootstrapLayer = ThreadBootstrapLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(GitWorkflowService)({}),
        Layer.mock(VcsStatusBroadcaster)({}),
        Layer.mock(ProjectSetupScriptRunner)({}),
      ),
    ),
  );
  const base = Layer.mergeAll(
    bootstrapLayer,
    LinkRequestRepositoryLive,
    RelayDeviceRepositoryLive,
    ProjectionTurnRepositoryLive,
    ProjectionThreadRepositoryLive,
  ).pipe(
    Layer.provideMerge(orchestration),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(
      Layer.mock(RepositoryIdentityResolver)({
        resolve: () =>
          Effect.succeed({
            canonicalKey: PROJECT_KEY,
            locator: { source: "git-remote", remoteName: "origin", remoteUrl: "x" },
          }),
      }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "link-requests-test-" })),
  );
  const context = yield* Layer.build(base);
  const engine = Context.get(context, OrchestrationEngineService);
  const snapshots = Context.get(context, ProjectionSnapshotQuery);
  const ledger = Context.get(context, LinkRequestRepository);
  const devices = Context.get(context, RelayDeviceRepository);
  const realBootstrap = Context.get(context, ThreadBootstrap);

  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("project-create"),
    projectId: PROJECT,
    title: "threadlines",
    workspaceRoot,
    defaultModelSelection: null,
    createdAt: AT,
  });

  /** A linked computer's device row here, as pairing leaves it. */
  const addLink = (
    deviceId: string,
    access: "off" | "ask" | "allowed",
    state: "active" | "revoked" = "active",
  ) =>
    Effect.gen(function* () {
      yield* devices.insertApproving({
        deviceId,
        requestId: `pairing-${deviceId}`,
        relayOrigin: "http://relay.test",
        label: "Windows PC",
        kind: "computer",
        platform: null,
        devicePublicKey: "key",
        grant: "peer",
        now: AT,
      });
      yield* devices.transition({ deviceId, from: ["approving"], to: "active", now: AT });
      yield* devices.setLinkSettings({ deviceId, access, maxRuntimeMode: "auto", now: AT });
      if (state === "revoked") {
        yield* devices.transition({ deviceId, from: ["active"], to: "revoked", now: AT });
      }
    });

  const boot = (
    patch: {
      readonly ledger?: Partial<LinkRequestRepositoryShape>;
      readonly bootstrap?: Partial<ThreadBootstrapShape>;
    } = {},
  ) =>
    Effect.gen(function* () {
      const layer = LinkRequestsLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(LinkRequestRepository, { ...ledger, ...patch.ledger }),
            Layer.succeed(ThreadBootstrap, { ...realBootstrap, ...patch.bootstrap }),
            Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([PROVIDER]) }),
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
        Layer.provide(Layer.succeedContext(context)),
      );
      return Context.get(yield* Layer.build(layer), LinkRequests);
    });

  const thread = (threadId: ThreadId) =>
    snapshots.getThreadDetailById(threadId).pipe(Effect.map(Option.getOrUndefined));
  const request = (requestId: string) =>
    ledger.get(DEVICE, ChildRequestId.make(requestId)).pipe(Effect.map(Option.getOrThrow));
  const firstTurnCommitted = (requestId: string) =>
    engine
      .getCommandReceipt(
        childRequestCommandId(linkBootstrapKey(DEVICE, ChildRequestId.make(requestId)), "turn"),
      )
      .pipe(Effect.map(Option.isSome));
  const events = engine.readEvents(0).pipe(Stream.runCollect);

  return {
    engine,
    ledger,
    devices,
    bootstrap: realBootstrap,
    addLink,
    boot,
    thread,
    request,
    firstTurnCommitted,
    events,
  };
});

type Computer = Effect.Success<typeof makeComputer>;

/** A start from an allowed link, set up: its thread exists and its first turn was asked for. */
const startedChild = (computer: Computer, requestId: string) =>
  Effect.gen(function* () {
    const service = yield* computer.boot();
    const started = yield* service.start(link(), startInput(requestId));
    assert.equal(started.status, "started");
    yield* eventually(computer.firstTurnCommitted(requestId), "its first turn is committed");
    return { service, threadId: linkThreadId(DEVICE, requestId) };
  });

const stopRequestedFor = (events: ReadonlyArray<OrchestrationEvent>, threadId: ThreadId) =>
  events.some(
    (event) =>
      event.type === "thread.session-stop-requested" && event.payload.threadId === threadId,
  );

it.layer(NodeServices.layer)("LinkRequests", (it) => {
  it.effect("records a start once: a retry gets the same thread and starts nothing more", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* computer.addLink(DEVICE, "allowed");
      let setups = 0;
      const service = yield* computer.boot({
        bootstrap: {
          startChild: (input) =>
            Effect.suspend(() => {
              setups += 1;
              return computer.bootstrap.startChild(input);
            }),
        },
      });
      const first = yield* service.start(link(), startInput("request-1"));
      const second = yield* service.start(link(), startInput("request-1"));
      yield* eventually(computer.firstTurnCommitted("request-1"), "its first turn is committed");

      assert.equal(first.status, "started");
      assert.deepEqual(second, first);
      assert.equal(setups, 1);
      const child = yield* computer.thread(linkThreadId(DEVICE, "request-1"));
      // The thread carries where it came from, so it gets no agent tools.
      assert.equal(child?.remoteOrigin?.linkDeviceId, DEVICE);
      assert.equal(child?.remoteOrigin?.threadId, PARENT);
      // Never more access than the link allows.
      assert.equal(child?.runtimeMode, "auto");
    }),
  );

  it.effect("refuses a start that comes after its cancel, and a late Allow finds nothing", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* computer.addLink(DEVICE, "ask");
      const service = yield* computer.boot();
      // The cancel overtook its start.
      const cancelled = yield* service.cancel(link(), ChildRequestId.make("request-1"));
      const late = yield* service.start(link(), startInput("request-1"));
      assert.equal(cancelled.status, "cancelled");
      assert.equal(late.status, "cancelled");

      // Waiting for this computer's user, then cancelled: Allow is refused.
      const waiting = yield* service.start(link({ access: "ask" }), startInput("request-2"));
      assert.equal(waiting.status, "awaiting_approval");
      assert.equal((yield* service.pending).length, 1);
      yield* service.cancel(link(), ChildRequestId.make("request-2"));
      const allow = yield* Effect.flip(
        service.respond({
          deviceId: DEVICE,
          requestId: ChildRequestId.make("request-2"),
          allow: true,
        }),
      );
      assert.include(allow.detail, "no longer waiting");
      yield* wallClockSleep(100);
      assert.isUndefined(yield* computer.thread(linkThreadId(DEVICE, "request-1")));
      assert.isUndefined(yield* computer.thread(linkThreadId(DEVICE, "request-2")));
    }),
  );

  it.effect(
    "a start from a link that is off never runs, even if the process dies right after",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        yield* computer.addLink(DEVICE, "off");
        // Dies after recording it: nothing written after the insert lands.
        const dying = yield* computer.boot({
          ledger: {
            settle: () =>
              Effect.fail(new LinkRequestRepositoryError({ operation: "settle", cause: "died" })),
            progress: () =>
              Effect.fail(new LinkRequestRepositoryError({ operation: "progress", cause: "died" })),
          },
        });
        const refused = yield* dying.start(link({ access: "off" }), startInput("request-1"));
        assert.equal(refused.status, "refused");

        const restarted = yield* computer.boot();
        yield* restarted.startReactor();
        yield* wallClockSleep(200);
        assert.isUndefined(yield* computer.thread(linkThreadId(DEVICE, "request-1")));
        assert.isFalse(yield* computer.firstTurnCommitted("request-1"));

        const reports = yield* replay(restarted.watch(link()));
        const denied = reports.find((event) => event.type === "report");
        assert.equal(denied?.type === "report" ? denied.outcome : null, "denied");
        // It never got a thread, so the report names none.
        assert.equal(denied?.type === "report" ? denied.threadId : "missing", null);
        // Acked reports are not offered again.
        if (denied?.type === "report") yield* restarted.ack(link(), denied.reportId);
        const after = yield* replay(restarted.watch(link()));
        assert.deepEqual(
          after.map((event) => event.type),
          ["synced"],
        );
      }),
  );

  it.effect(
    "a recorded start whose link was turned off or removed before its setup resumed is ended, not run",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        const removed = "device-removed";
        yield* computer.addLink(DEVICE, "allowed");
        yield* computer.addLink(removed, "allowed");
        // Both were recorded as allowed; the process died before setting them up.
        for (const deviceId of [DEVICE, removed]) {
          yield* computer.ledger.insert({
            linkDeviceId: deviceId,
            requestId: ChildRequestId.make("request-1"),
            status: "received",
            payload: { kind: "start", input: startInput("request-1") },
            threadId: linkThreadId(deviceId, "request-1"),
            messageId: linkMessageId(deviceId, "request-1"),
            now: AT,
          });
        }
        // Meanwhile the user turned one link off and removed the other.
        yield* computer.devices.setLinkSettings({ deviceId: DEVICE, access: "off", now: AT });
        yield* computer.devices.transition({
          deviceId: removed,
          from: ["active"],
          to: "revoked",
          now: AT,
        });
        const service = yield* computer.boot();
        yield* service.startReactor();
        yield* wallClockSleep(200);
        assert.isUndefined(yield* computer.thread(linkThreadId(DEVICE, "request-1")));
        assert.isUndefined(yield* computer.thread(linkThreadId(removed, "request-1")));
        assert.equal((yield* computer.request("request-1")).status, "denied");
        const gone = yield* computer.ledger.get(removed, ChildRequestId.make("request-1"));
        assert.equal(Option.getOrThrow(gone).status, "cancelled");
      }),
  );

  it.effect(
    "a cancel with stopThread stops the thread its start runs in, though the asker never heard its id",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        yield* computer.addLink(DEVICE, "allowed");
        const { service, threadId } = yield* startedChild(computer, "request-1");
        // Its agent is at work.
        yield* computer.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("child-session-running"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "auto",
            activeTurnId: TurnId.make("child-turn-1"),
            lastError: null,
            updatedAt: AT,
          },
          createdAt: AT,
        });

        const cancelled = yield* service.cancel(link(), ChildRequestId.make("request-1"), {
          stopThread: true,
        });
        assert.equal(cancelled.status, "cancelled");
        assert.equal((yield* computer.request("request-1")).status, "cancelled");
        assert.isTrue(stopRequestedFor(yield* computer.events, threadId));
      }),
  );

  it.effect("a send cancelled while it is being delivered never reaches its thread", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* computer.addLink(DEVICE, "allowed");
      const { threadId } = yield* startedChild(computer, "request-1");
      // Held right after the send is recorded, before it is delivered.
      const recorded = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const service = yield* computer.boot({
        ledger: {
          insert: (input) =>
            computer.ledger
              .insert(input)
              .pipe(
                Effect.tap(() =>
                  input.payload.kind === "send"
                    ? Deferred.succeed(recorded, undefined).pipe(
                        Effect.andThen(Deferred.await(resume)),
                      )
                    : Effect.void,
                ),
              ),
        },
      });
      const sending = yield* Effect.forkChild(
        service.send(link(), {
          requestId: ChildRequestId.make("send-1"),
          threadId,
          text: "Add the security fixes too.",
        }),
      );
      yield* Deferred.await(recorded);
      const cancelling = yield* Effect.forkChild(
        service.cancel(link(), ChildRequestId.make("send-1")),
      );
      yield* wallClockSleep(50);
      yield* Deferred.succeed(resume, undefined);
      const sent = yield* Fiber.join(sending);
      const cancelled = yield* Fiber.join(cancelling);

      assert.equal(sent.status, "cancelled");
      assert.equal(cancelled.status, "cancelled");
      const child = yield* computer.thread(threadId);
      const messageId = linkMessageId(DEVICE, "send-1");
      assert.isFalse(child?.messages.some((message) => message.id === messageId));
      assert.isFalse(
        (child?.queuedFollowUps ?? []).some((queued) => queued.messageId === messageId),
      );
    }),
  );

  it.effect("a send recorded just before the process died is delivered after the restart", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* computer.addLink(DEVICE, "allowed");
      const { threadId } = yield* startedChild(computer, "request-1");
      // Dies (hangs forever) right after recording the send.
      const recorded = yield* Deferred.make<void>();
      const dying = yield* computer.boot({
        ledger: {
          insert: (input) =>
            computer.ledger
              .insert(input)
              .pipe(
                Effect.tap(() =>
                  input.payload.kind === "send"
                    ? Deferred.succeed(recorded, undefined).pipe(Effect.andThen(Effect.never))
                    : Effect.void,
                ),
              ),
        },
      });
      yield* Effect.forkDetach(
        dying.send(link(), {
          requestId: ChildRequestId.make("send-1"),
          threadId,
          text: "Add the security fixes too.",
        }),
      );
      yield* Deferred.await(recorded);

      const restarted = yield* computer.boot();
      yield* restarted.startReactor();
      const messageId = linkMessageId(DEVICE, "send-1");
      yield* eventually(
        Effect.map(computer.thread(threadId), (child) =>
          (child?.queuedFollowUps ?? []).some((queued) => queued.messageId === messageId),
        ),
        "the send waits in its thread",
      );
      assert.equal((yield* computer.request("send-1")).status, "queued");
    }),
  );

  it.effect(
    "a first turn committed just before the process died is reported after the restart, not left open",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        yield* computer.addLink(DEVICE, "allowed");
        // Dies right after its first turn is committed: the ledger never hears.
        const dying = yield* computer.boot({
          bootstrap: {
            startChild: (input) =>
              computer.bootstrap.startChild(input).pipe(Effect.andThen(Effect.never)),
          },
        });
        yield* dying.start(link(), startInput("request-1"));
        yield* eventually(computer.firstTurnCommitted("request-1"), "its first turn is committed");
        assert.equal((yield* computer.request("request-1")).status, "received");

        const restarted = yield* computer.boot();
        yield* restarted.startReactor();
        const reports = yield* replay(restarted.watch(link()));
        const report = reports.find((event) => event.type === "report");
        assert.equal(report?.type === "report" ? report.outcome : null, "failed");
        assert.include(
          report?.type === "report" ? report.text : "",
          "interrupted by a restart on Mac mini",
        );
        assert.equal(
          report?.type === "report" ? report.threadId : null,
          linkThreadId(DEVICE, "request-1"),
        );
      }),
  );

  it.effect("answers a send with the turn its own message started, not another", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      yield* computer.addLink(DEVICE, "allowed");
      const { service, threadId } = yield* startedChild(computer, "request-1");
      const sent = yield* service.send(link(), {
        requestId: ChildRequestId.make("send-1"),
        threadId,
        text: "Add the security fixes too.",
      });
      assert.equal(sent.status, "queued");
      const child = (yield* computer.thread(threadId))!;
      const answering = TurnId.make("turn-send");
      yield* service.onTurnEnd({
        child: {
          ...child,
          messages: [
            ...child.messages,
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
        },
        end: { turnId: answering, outcome: "completed" },
        pendingMessageId: linkMessageId(DEVICE, "send-1"),
        createdAt: AT,
      });
      const send = yield* computer.request("send-1");
      assert.equal(send.status, "answered");
      assert.equal(send.reportText, "Added the two security fixes.");
      assert.notEqual((yield* computer.request("request-1")).status, "answered");
    }),
  );
});
