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
import * as Exit from "effect/Exit";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { childRequestCommandId } from "../orchestration/childRequestIds.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ThreadBootstrapLive } from "../orchestration/Layers/ThreadBootstrap.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  ThreadBootstrap,
  type ThreadBootstrapShape,
} from "../orchestration/Services/ThreadBootstrap.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurnRepositoryShape,
} from "../persistence/Services/ProjectionTurns.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
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
import { linkBootstrapKey, linkCommandId, linkMessageId, linkThreadId } from "./linkIds.ts";
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
  environmentPinned: false,
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
 * it; booting another one later is a restart of that process, and `patch`
 * swaps parts of it to stop it at a chosen point (a crash) or hold it there.
 * With `dbPath` the database is a file: a second computer made on it, after
 * the first one's scope closed, is a whole new server process.
 */
const makeComputer = (options: { readonly dbPath?: string } = {}) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
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
      Layer.provideMerge(
        options.dbPath === undefined
          ? SqlitePersistenceMemory
          : makeSqlitePersistenceLive(options.dbPath),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "link-requests-test-" })),
    );
    const context = yield* Layer.buildWithScope(base, scope);
    const engine = Context.get(context, OrchestrationEngineService);
    const snapshots = Context.get(context, ProjectionSnapshotQuery);
    const ledger = Context.get(context, LinkRequestRepository);
    const devices = Context.get(context, RelayDeviceRepository);
    const realBootstrap = Context.get(context, ThreadBootstrap);
    const turnsRepo = Context.get(context, ProjectionTurnRepository);

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
      pinnedTo: EnvironmentId | null = null,
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
          linkEnvironmentId: pinnedTo,
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
        readonly engine?: Partial<OrchestrationEngineShape>;
        readonly snapshots?: Partial<ProjectionSnapshotQueryShape>;
        readonly turns?: Partial<ProjectionTurnRepositoryShape>;
      } = {},
    ) =>
      Effect.gen(function* () {
        const layer = LinkRequestsLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(LinkRequestRepository, { ...ledger, ...patch.ledger }),
              Layer.succeed(ThreadBootstrap, { ...realBootstrap, ...patch.bootstrap }),
              Layer.succeed(OrchestrationEngineService, { ...engine, ...patch.engine }),
              Layer.succeed(ProjectionSnapshotQuery, { ...snapshots, ...patch.snapshots }),
              Layer.succeed(ProjectionTurnRepository, { ...turnsRepo, ...patch.turns }),
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
        return Context.get(yield* Layer.buildWithScope(layer, scope), LinkRequests);
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
      snapshots,
      turns: turnsRepo,

      addLink,
      boot,
      thread,
      request,
      firstTurnCommitted,
      events,
    };
  });

type Computer = Effect.Success<ReturnType<typeof makeComputer>>;

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
      const computer = yield* makeComputer();
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

  it.effect(
    "a link made for one computer refuses a start that says it comes from another, and keeps its id",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer();
        yield* computer.addLink(DEVICE, "allowed", "active", WINDOWS);
        const pinned = link({ environmentPinned: true });
        const service = yield* computer.boot();
        const linux = EnvironmentId.make("env-linux");
        const input = startInput("request-1");

        const posing = yield* service.start(pinned, {
          ...input,
          parent: { ...input.parent, environmentId: linux, environmentLabel: "Linux box" },
        });
        assert.deepEqual(posing, {
          status: "refused",
          reason: "This link was made for a different computer.",
        });
        // Nothing recorded, nothing started.
        assert.isTrue(
          Option.isNone(yield* computer.ledger.get(DEVICE, ChildRequestId.make("request-1"))),
        );
        // What it says about itself never replaces the computer it was made for.
        yield* computer.devices.touchLink({ deviceId: DEVICE, environmentId: linux, now: AT });
        const row = Option.getOrThrow(yield* computer.devices.getDevice(DEVICE));
        assert.equal(row.linkEnvironmentId, WINDOWS);
        assert.isTrue(row.linkEnvironmentPinned);

        // Its own computer's start goes ahead.
        const own = yield* service.start(pinned, startInput("request-2"));
        assert.equal(own.status, "started");

        // A link whose invite named no computer keeps the first one it said
        // it was, unconfirmed, and refuses any other after that.
        yield* computer.addLink("device-unpinned", "allowed");
        yield* computer.devices.touchLink({
          deviceId: "device-unpinned",
          environmentId: WINDOWS,
          now: AT,
        });
        yield* computer.devices.touchLink({
          deviceId: "device-unpinned",
          environmentId: linux,
          now: AT,
        });
        const unpinned = Option.getOrThrow(yield* computer.devices.getDevice("device-unpinned"));
        assert.equal(unpinned.linkEnvironmentId, WINDOWS);
        assert.isFalse(unpinned.linkEnvironmentPinned);
        const switched = yield* service.start(link({ deviceId: "device-unpinned" }), {
          ...input,
          requestId: ChildRequestId.make("request-3"),
          parent: { ...input.parent, environmentId: linux, environmentLabel: "Linux box" },
        });
        assert.equal(switched.status, "refused");
      }),
  );

  it.effect("refuses a start that comes after its cancel, and a late Allow finds nothing", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer();
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
        const computer = yield* makeComputer();
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
        const computer = yield* makeComputer();
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
        const computer = yield* makeComputer();
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
      const computer = yield* makeComputer();
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
      const computer = yield* makeComputer();
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
        const computer = yield* makeComputer();
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

  it.effect(
    "a send whose queue command lands after its cancel is held back from the provider by the gate",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer();
        yield* computer.addLink(DEVICE, "allowed");
        const { threadId } = yield* startedChild(computer, "request-1");
        // The engine takes the command at once and runs it later, whoever waits.
        const taken = yield* Deferred.make<void>();
        const land = yield* Deferred.make<void>();
        const service = yield* computer.boot({
          engine: {
            dispatch: (command) =>
              command.type !== "thread.remote-request.queue"
                ? computer.engine.dispatch(command)
                : Effect.gen(function* () {
                    const running = yield* Effect.forkDetach(
                      Deferred.await(land).pipe(Effect.andThen(computer.engine.dispatch(command))),
                    );
                    yield* Deferred.succeed(taken, undefined);
                    return yield* Fiber.join(running);
                  }),
          },
        });
        const sending = yield* Effect.forkChild(
          service.send(link(), {
            requestId: ChildRequestId.make("send-1"),
            threadId,
            text: "Add the security fixes too.",
          }),
        );
        yield* Deferred.await(taken);
        // The asking computer went away mid-call (its request is let go of),
        // then took the send back; only then does the queued command land.
        yield* Fiber.interrupt(sending);
        const cancelled = yield* service.cancel(link(), ChildRequestId.make("send-1"));
        assert.equal(cancelled.status, "cancelled");
        yield* Deferred.succeed(land, undefined);
        yield* eventually(
          Effect.map(
            computer.engine.getCommandReceipt(
              linkCommandId(DEVICE, ChildRequestId.make("send-1"), "queue"),
            ),
            Option.isSome,
          ),
          "the queued command lands",
        );

        // It sits in the queue, but the provider reactor's gate takes it back
        // unsent (ProviderCommandReactor's test covers that side).
        const messageId = linkMessageId(DEVICE, "send-1");
        const child = yield* computer.thread(threadId);
        assert.isTrue(
          (child?.queuedFollowUps ?? []).some((queued) => queued.messageId === messageId),
        );
        assert.equal(yield* service.messageVerdict({ threadId, messageId }), "taken-back");
      }),
  );

  it.effect("a send retried after its first call was cut off is delivered, not only answered", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer();
      yield* computer.addLink(DEVICE, "allowed");
      const { threadId } = yield* startedChild(computer, "request-1");
      // The first call is cut off right after it recorded the send.
      const recorded = yield* Deferred.make<void>();
      let cutOff = true;
      const service = yield* computer.boot({
        ledger: {
          insert: (input) =>
            computer.ledger
              .insert(input)
              .pipe(
                Effect.tap(() =>
                  input.payload.kind === "send" && cutOff
                    ? Deferred.succeed(recorded, undefined).pipe(Effect.andThen(Effect.never))
                    : Effect.void,
                ),
              ),
        },
      });
      const sendInput = {
        requestId: ChildRequestId.make("send-1"),
        threadId,
        text: "Add the security fixes too.",
      };
      const first = yield* Effect.forkChild(service.send(link(), sendInput));
      yield* Deferred.await(recorded);
      yield* Fiber.interrupt(first);
      cutOff = false;

      const retried = yield* service.send(link(), sendInput);
      assert.equal(retried.status, "queued");
      const messageId = linkMessageId(DEVICE, "send-1");
      const child = yield* computer.thread(threadId);
      assert.isTrue(
        (child?.queuedFollowUps ?? []).some((queued) => queued.messageId === messageId),
      );
      assert.equal((yield* computer.request("send-1")).status, "queued");
    }),
  );

  it.effect(
    "a cancel recorded just before the server died is cleaned up when it starts again",
    () =>
      Effect.gen(function* () {
        const dbPath = path.join(
          fs.mkdtempSync(path.join(os.tmpdir(), "link-requests-db-")),
          "state.sqlite",
        );
        const firstRun = yield* Scope.make();
        const first = yield* makeComputer({ dbPath }).pipe(Scope.provide(firstRun));
        yield* first.addLink(DEVICE, "allowed");
        const { service, threadId } = yield* startedChild(first, "request-1");
        const sent = yield* service.send(link(), {
          requestId: ChildRequestId.make("send-1"),
          threadId,
          text: "Add the security fixes too.",
        });
        assert.equal(sent.status, "queued");
        const messageId = linkMessageId(DEVICE, "send-1");

        // The cancel is recorded, then the server dies before it takes the message back.
        const reading = yield* Deferred.make<void>();
        const dying = yield* first.boot({
          snapshots: {
            getThreadDetailById: () =>
              Deferred.succeed(reading, undefined).pipe(Effect.andThen(Effect.never)),
          },
        });
        const cancelling = yield* Effect.forkChild(
          dying.cancel(link(), ChildRequestId.make("send-1")),
        );
        yield* Deferred.await(reading);
        yield* Fiber.interrupt(cancelling);
        assert.equal((yield* first.request("send-1")).status, "cancelled");
        yield* Scope.close(firstRun, Exit.void);

        // A new server process on the same database.
        const second = yield* makeComputer({ dbPath });
        assert.isTrue(
          ((yield* second.thread(threadId))?.queuedFollowUps ?? []).some(
            (queued) => queued.messageId === messageId,
          ),
        );
        const restarted = yield* second.boot();
        yield* restarted.startReactor();
        assert.isFalse(
          ((yield* second.thread(threadId))?.queuedFollowUps ?? []).some(
            (queued) => queued.messageId === messageId,
          ),
        );
        assert.isNull((yield* second.request("send-1")).cleanup);
      }),
  );

  it.effect("a cancel or stop whose thread can't be read fails, so the asker tries again", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer();
      yield* computer.addLink(DEVICE, "allowed");
      const { threadId } = yield* startedChild(computer, "request-1");
      const unreadable = yield* computer.boot({
        snapshots: {
          getThreadDetailById: () =>
            Effect.fail(
              new PersistenceSqlError({ operation: "getThreadDetailById", detail: "busy" }),
            ),
        },
      });
      const cancel = yield* Effect.flip(
        unreadable.cancel(link(), ChildRequestId.make("request-1"), { stopThread: true }),
      );
      assert.equal(cancel._tag, "PeerRpcError");
      // Still owed: a retry, or a restart, finishes it.
      assert.equal((yield* computer.request("request-1")).cleanup, "stop");
      const stop = yield* Effect.flip(unreadable.stopThread(link(), threadId));
      assert.equal(stop._tag, "PeerRpcError");
    }),
  );

  it.effect(
    "a cancel's clean-up that fails at startup is tried again until it lands, and its message can't run meanwhile",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer();
        yield* computer.addLink(DEVICE, "allowed");
        const { service, threadId } = yield* startedChild(computer, "request-1");
        yield* service.send(link(), {
          requestId: ChildRequestId.make("send-1"),
          threadId,
          text: "Add the security fixes too.",
        });
        const messageId = linkMessageId(DEVICE, "send-1");
        const isQueued = Effect.map(computer.thread(threadId), (child) =>
          (child?.queuedFollowUps ?? []).some((queued) => queued.messageId === messageId),
        );
        let unreadable = true;
        const reads = {
          getThreadDetailById: (id: ThreadId) =>
            unreadable
              ? Effect.fail(
                  new PersistenceSqlError({ operation: "getThreadDetailById", detail: "busy" }),
                )
              : computer.snapshots.getThreadDetailById(id),
        };
        const dying = yield* computer.boot({ snapshots: reads });
        yield* Effect.flip(dying.cancel(link(), ChildRequestId.make("send-1")));
        // Its clean-up didn't land, yet its message may not run.
        assert.isTrue(yield* isQueued);
        assert.equal(yield* dying.messageVerdict({ threadId, messageId }), "taken-back");

        const restarted = yield* computer.boot({ snapshots: reads });
        yield* restarted.startReactor();
        assert.isTrue(yield* isQueued);
        unreadable = false;
        yield* TestClock.adjust(Duration.seconds(2));
        yield* eventually(
          Effect.map(isQueued, (queued) => !queued),
          "the message is taken back",
        );
        assert.isNull((yield* computer.request("send-1")).cleanup);
      }),
  );

  it.effect(
    "restart recovery judges each request by its own turn, not by other work on its thread",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer();
        yield* computer.addLink(DEVICE, "allowed");
        // A start whose first turn was running when the process stopped, and
        // a send to the same thread, delivered and still waiting there.
        const { service, threadId } = yield* startedChild(computer, "request-1");
        yield* service.send(link(), {
          requestId: ChildRequestId.make("send-1"),
          threadId,
          text: "Add the security fixes too.",
        });
        const restarted = yield* computer.boot();
        // Since the restart the waiting send was started: live work, on the
        // same thread as the cut-off start.
        yield* computer.engine.dispatch({
          type: "thread.follow-up.send-queued",
          commandId: CommandId.make("provider-sends-it"),
          threadId,
          messageId: linkMessageId(DEVICE, "send-1"),
          createdAt: AT,
        });
        yield* restarted.startReactor();

        const start = yield* computer.request("request-1");
        assert.equal(start.status, "failed");
        assert.include(start.reportText ?? "", "interrupted by a restart on Mac mini");
        const send = yield* computer.request("send-1");
        assert.isNull(send.reportId);
      }),
  );

  it.effect("restart recovery classifies nothing until it knows where this process started", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer();
      yield* computer.addLink(DEVICE, "allowed");
      yield* startedChild(computer, "request-1");
      let unreadable = true;
      const restarted = yield* computer.boot({
        snapshots: {
          getSnapshotSequence: () =>
            unreadable
              ? Effect.fail(
                  new PersistenceSqlError({ operation: "getSnapshotSequence", detail: "busy" }),
                )
              : computer.snapshots.getSnapshotSequence(),
        },
      });
      yield* restarted.startReactor();
      yield* TestClock.adjust(Duration.seconds(2));
      yield* wallClockSleep(100);
      // Still unknown: nothing was judged.
      assert.equal((yield* computer.request("request-1")).status, "queued");
      unreadable = false;
      yield* TestClock.adjust(Duration.seconds(4));
      yield* eventually(
        Effect.map(computer.request("request-1"), (row) => row.status === "failed"),
        "the cut-off turn is reported",
      );
    }),
  );

  it.effect(
    "a start that reports nothing back, settled as soon as it is set up, is still taken back by a cancel",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer();
        yield* computer.addLink(DEVICE, "allowed");
        const service = yield* computer.boot();
        yield* service.start(link(), { ...startInput("request-1"), reportBack: false });
        yield* eventually(
          Effect.map(computer.request("request-1"), (row) => row.status === "answered"),
          "it is settled once set up",
        );
        const threadId = linkThreadId(DEVICE, "request-1");
        const firstMessage = linkMessageId(DEVICE, "request-1");
        assert.equal(yield* service.messageVerdict({ threadId, messageId: firstMessage }), "run");
        // Taken back while its provider is still starting: the report stays
        // as it was, but the turn must not run.
        const cancelled = yield* service.cancel(link(), ChildRequestId.make("request-1"));
        assert.equal(cancelled.status, "already_settled");
        assert.equal((yield* computer.request("request-1")).status, "answered");
        assert.equal(
          yield* service.messageVerdict({ threadId, messageId: firstMessage }),
          "taken-back",
        );
      }),
  );

  it.effect("a start cancelled after its first turn was asked for is taken back at the gate", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer();
      yield* computer.addLink(DEVICE, "allowed");
      const { service, threadId } = yield* startedChild(computer, "request-1");
      const firstMessage = linkMessageId(DEVICE, "request-1");
      assert.equal(yield* service.messageVerdict({ threadId, messageId: firstMessage }), "run");
      yield* service.cancel(link(), ChildRequestId.make("request-1"));
      // The provider reactor asks right before the turn goes (its own test
      // covers that side): this one never reaches the provider.
      assert.equal(
        yield* service.messageVerdict({ threadId, messageId: firstMessage }),
        "taken-back",
      );
    }),
  );

  it.effect("a restart's settling whose write fails is tried again until it is written", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer();
      yield* computer.addLink(DEVICE, "allowed");
      // A start whose first turn was running when the process stopped.
      yield* startedChild(computer, "request-1");
      let unwritable = true;
      const restarted = yield* computer.boot({
        ledger: {
          settle: (input) =>
            unwritable
              ? Effect.fail(new LinkRequestRepositoryError({ operation: "settle", cause: "busy" }))
              : computer.ledger.settle(input),
        },
      });
      yield* restarted.startReactor();
      assert.equal((yield* computer.request("request-1")).status, "queued");
      unwritable = false;
      yield* TestClock.adjust(Duration.seconds(2));
      yield* eventually(
        Effect.map(computer.request("request-1"), (row) => row.status === "failed"),
        "the cut-off turn is reported",
      );
      assert.include(
        (yield* computer.request("request-1")).reportText ?? "",
        "interrupted by a restart on Mac mini",
      );
    }),
  );

  it.effect(
    "a send delivered again after a restart and started at once is live work, not cut off",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer();
        yield* computer.addLink(DEVICE, "allowed");
        const { threadId } = yield* startedChild(computer, "request-1");
        // The process died right after recording the send.
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

        // After the restart its delivery lands and the thread, idle, starts it
        // at once (what the provider reactor does), before recovery looks.
        const restarted = yield* computer.boot({
          engine: {
            dispatch: (command) =>
              command.type !== "thread.remote-request.queue"
                ? computer.engine.dispatch(command)
                : computer.engine.dispatch(command).pipe(
                    Effect.tap(() =>
                      computer.engine.dispatch({
                        type: "thread.follow-up.send-queued",
                        commandId: CommandId.make("provider-sends-it"),
                        threadId: command.threadId,
                        messageId: command.messageId,
                        createdAt: command.createdAt,
                      }),
                    ),
                  ),
          },
        });
        yield* restarted.startReactor();
        yield* wallClockSleep(100);

        const send = yield* computer.request("send-1");
        assert.isNull(send.reportId);
        assert.notEqual(send.status, "failed");
      }),
  );

  it.effect("answers a send with the turn its own message started, not another", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer();
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
