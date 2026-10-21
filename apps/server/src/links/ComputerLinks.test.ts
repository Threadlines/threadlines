import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  ComputerLinkError,
  ComputerLinkId,
  type ComputerLinkInvite,
  EnvironmentId,
  type PeerDescriptor,
  PeerRpcError,
  PeerRpcGroup,
  type PeerUnlinkInput,
  RelayHostId,
  RelayInviteId,
} from "@threadlines/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { RpcTest } from "effect/unstable/rpc";

import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import {
  RelayDeviceRepository,
  RelayDeviceRepositoryLive,
} from "../relay/RelayDeviceRepository.ts";
import { RelayHost } from "../relay/RelayHost.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  ComputerLinkClient,
  ComputerLinkClientLive,
  computerLinkSecretName,
  ComputerLinkUnavailableError,
} from "./ComputerLinkClient.ts";
import {
  ComputerLinkRepository,
  ComputerLinkRepositoryLive,
  type ComputerLinkRow,
} from "./ComputerLinkRepository.ts";
import { ComputerLinks, ComputerLinksLive, UNLINK_RETRY_EVERY } from "./ComputerLinks.ts";
import { LinkRequests, PEER_LINK_REMOVED, peerLinkOf } from "./LinkRequests.ts";
import { makePeerRpcLayer } from "./peerRoute.ts";

const AT = "2026-10-21T10:00:00.000Z";
const MAC = EnvironmentId.make("env-mac");

const outboundLink = (
  id: string,
  remoteEnvironmentId: EnvironmentId,
  remoteLabel: string,
): ComputerLinkRow => ({
  linkId: ComputerLinkId.make(id),
  remoteEnvironmentId,
  remoteLabel,
  remotePlatform: null,
  relayOrigin: "http://relay.test",
  hostId: `host-${id}`,
  deviceId: `device-${id}`,
  hostPublicKey: "key",
  directRoutes: [],
  state: "active",
  createdAt: AT,
  lastConnectedAt: null,
  lastError: null,
});

/** How another computer answers this one's unlink. */
type Answer = "unreachable" | "unlinks" | "already_removed";

/** Real time: the work under test is forked, and these suites run on the test clock. */
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

/**
 * This computer ("Mac"): its real links, devices and keys on one database,
 * and the real link client, except that an unlink reaches the other computers
 * as `answers` says (each records what it was told).
 */
const makeComputer = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const base = Layer.mergeAll(
    ComputerLinkRepositoryLive,
    RelayDeviceRepositoryLive,
    ServerSecretStoreLive,
  ).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "computer-links-test-" })),
    Layer.provideMerge(
      Layer.mock(ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId: MAC,
          label: "Mac",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: true },
        }),
      }),
    ),
  );
  const context = yield* Layer.buildWithScope(base, scope);
  const realClient = Context.get(
    yield* Layer.buildWithScope(
      ComputerLinkClientLive.pipe(Layer.provide(Layer.succeedContext(context))),
      scope,
    ),
    ComputerLinkClient,
  );

  const answers = new Map<string, Answer>();
  /** Whether a computer, asked over this computer's own link, still takes it. */
  const takesLinkBack = new Map<string, boolean>([["takes", true]]);
  const told: Array<{ readonly linkId: string; readonly input: PeerUnlinkInput }> = [];
  const dropped: Array<{ readonly deviceId: string; readonly stopRunning: boolean }> = [];
  const revoked: Array<string> = [];
  /** Links whose unlink still owes stops. */
  const owed = new Set<string>();
  /** What the next drains do: wait for a signal first, or fall short. */
  const dropPlan: Array<{ readonly wait?: Deferred.Deferred<void>; readonly fail?: string }> = [];
  /** Per link, whether the other computer still takes it (else per computer, takesLinkBack). */
  const takesLink = new Map<string, boolean>();
  /** The next unlinks the other computer hears wait for these first. */
  const unlinkHolds: Array<Deferred.Deferred<void>> = [];

  /** Another computer, asked over this computer's link: it answers, or refuses the link. */
  const describeAs = (environmentId: string) =>
    takesLinkBack.get(environmentId) === true
      ? Effect.succeed({} as PeerDescriptor)
      : Effect.fail(
          new ComputerLinkUnavailableError({
            environmentId,
            detail: "It removed this computer's link.",
            revoked: true,
          }),
        );
  const client = {
    ...realClient,
    describe: (environmentId: EnvironmentId) => describeAs(environmentId),
    describeOver: (linkId: ComputerLinkId) =>
      Context.get(context, ComputerLinkRepository)
        .get(linkId)
        .pipe(
          Effect.orDie,
          Effect.flatMap((found) => {
            const answer = takesLink.get(linkId);
            return answer === undefined
              ? describeAs(Option.getOrThrow(found).remoteEnvironmentId)
              : describeAs(answer ? "takes" : "refuses");
          }),
        ),
    unlinkPeer: (linkId: ComputerLinkId, input: PeerUnlinkInput) =>
      Effect.suspend((): Effect.Effect<void, PeerRpcError | ComputerLinkUnavailableError> => {
        told.push({ linkId, input });
        const hold = unlinkHolds.shift();
        return hold === undefined
          ? answer(linkId)
          : Deferred.await(hold).pipe(Effect.andThen(answer(linkId)));
      }),
  };
  /** How another computer answers this one's unlink of a link. */
  function answer(
    linkId: ComputerLinkId,
  ): Effect.Effect<void, PeerRpcError | ComputerLinkUnavailableError> {
    switch (answers.get(linkId) ?? "unreachable") {
      case "unlinks":
        return Effect.void;
      case "already_removed":
        return Effect.fail(new PeerRpcError({ detail: PEER_LINK_REMOVED }));
      case "unreachable":
        return Effect.fail(
          new ComputerLinkUnavailableError({
            environmentId: "",
            detail: "The other computer didn't answer in time.",
            revoked: false,
          }),
        );
    }
  }
  const services = Layer.mergeAll(
    Layer.succeedContext(context),
    Layer.succeed(ComputerLinkClient, client),
    Layer.mock(RelayHost)({ admitDirect: () => null }),
    Layer.mock(SessionCredentialService)({
      cookieName: "threadlines_session",
      streamChanges: Stream.never,
      revoke: (sessionId) =>
        Effect.sync(() => {
          revoked.push(sessionId);
          return true;
        }),
    }),
    Layer.mock(LinkRequests)({
      pending: Effect.succeed([]),
      pendingChanges: Stream.empty,
      dropLink: (deviceId, options) =>
        Effect.gen(function* () {
          const step = dropPlan.shift();
          if (step?.wait !== undefined) yield* Deferred.await(step.wait);
          dropped.push({ deviceId, stopRunning: options?.stopRunning === true });
          if (step?.fail !== undefined) {
            return yield* new ComputerLinkError({ detail: step.fail });
          }
        }),
      oweDrain: (deviceId) =>
        Effect.sync(() => {
          owed.add(deviceId);
          return 0;
        }),
      drainDone: (deviceId) => Effect.sync(() => void owed.delete(deviceId)),
    }),
  );
  /** Starts this computer's link service; booting again is a restart. */
  const boot = Effect.map(
    Layer.buildWithScope(ComputerLinksLive.pipe(Layer.provide(services)), scope),
    (built) => Context.get(built, ComputerLinks),
  );

  const repo = Context.get(context, ComputerLinkRepository);
  const secrets = Context.get(context, ServerSecretStore);
  const devices = Context.get(context, RelayDeviceRepository);

  /** A link to another computer, with its keys, as linking leaves it. */
  const addLink = (row: ComputerLinkRow) =>
    Effect.gen(function* () {
      yield* repo.insert(row);
      yield* secrets.set(computerLinkSecretName(row.linkId), new TextEncoder().encode("keys"));
    });
  const hasLink = (linkId: ComputerLinkId) => Effect.map(repo.get(linkId), Option.isSome);
  /** Another computer's link to this one (its device here), as linking leaves it. */
  const addInboundLink = (input: {
    readonly deviceId: string;
    readonly environmentId: EnvironmentId;
    readonly pinned?: boolean;
    readonly createdAt?: string;
  }) =>
    Effect.gen(function* () {
      const sessionId = AuthSessionId.make(`session-${input.deviceId}`);
      yield* devices.insertApproving({
        deviceId: input.deviceId,
        requestId: `pairing-${input.deviceId}`,
        relayOrigin: "http://relay.test",
        label: input.deviceId,
        kind: "computer",
        platform: null,
        devicePublicKey: "key",
        grant: "peer",
        linkEnvironmentId: input.pinned === false ? null : input.environmentId,
        now: input.createdAt ?? AT,
      });
      yield* devices.transition({
        deviceId: input.deviceId,
        from: ["approving"],
        to: "active",
        now: AT,
      });
      yield* devices.setSession({ deviceId: input.deviceId, sessionId, now: AT });
      if (input.pinned === false) {
        yield* devices.touchLink({
          deviceId: input.deviceId,
          environmentId: input.environmentId,
          now: AT,
        });
      }
      return sessionId;
    });
  const hasKeys = (linkId: ComputerLinkId) =>
    Effect.map(secrets.get(computerLinkSecretName(linkId)), (bytes) => bytes !== null);

  return {
    context,
    services,
    client,
    repo,
    devices,
    answers,
    takesLinkBack,
    told,
    dropped,
    revoked,
    owed,
    dropPlan,
    takesLink,
    unlinkHolds,
    boot,
    addLink,
    addInboundLink,
    hasLink,
    hasKeys,
  };
});

it.layer(NodeServices.layer)("ComputerLinks unlink", (it) => {
  it.effect(
    "an unlink the other computer can't hear yet stays pending, and finishes once it answers or turns out to have removed the link",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        const links = yield* computer.boot;
        const windows = outboundLink(
          "link-windows",
          EnvironmentId.make("env-windows"),
          "Windows PC",
        );
        const linux = outboundLink("link-linux", EnvironmentId.make("env-linux"), "Linux box");
        yield* computer.addLink(windows);
        yield* computer.addLink(linux);

        for (const row of [windows, linux]) {
          const result = yield* links.remove({ direction: "outbound", linkId: row.linkId });
          assert.equal(result.otherComputer, "pending");
          // Kept, with its keys, to tell the other computer later.
          assert.equal(Option.getOrThrow(yield* computer.repo.get(row.linkId)).state, "unlinking");
          assert.isTrue(yield* computer.hasKeys(row.linkId));
        }
        const listed = (yield* links.snapshot).outbound.find(
          (link) => link.linkId === windows.linkId,
        );
        assert.equal(listed?.state, "unlinking");
        assert.equal(listed?.connection, "offline");
        // Nothing new goes over it: the outbox hears it was unlinked, and
        // settles what it still had open there.
        const refused = yield* Effect.flip(
          computer.client.withPeer(windows.remoteEnvironmentId, () => Effect.void),
        );
        assert.equal(refused._tag, "ComputerLinkUnavailableError");
        if (refused._tag === "ComputerLinkUnavailableError") {
          assert.isTrue(refused.revoked);
          assert.equal(refused.detail, "This computer unlinked Windows PC.");
        }

        // Windows PC answers next time; Linux box had already removed the link.
        computer.answers.set(windows.linkId, "unlinks");
        computer.answers.set(linux.linkId, "already_removed");
        yield* TestClock.adjust(UNLINK_RETRY_EVERY);
        yield* eventually(
          Effect.map(
            Effect.all([computer.hasLink(windows.linkId), computer.hasLink(linux.linkId)]),
            ([a, b]) => !a && !b,
          ),
          "both unlinks finish",
        );
        assert.isFalse(yield* computer.hasKeys(windows.linkId));
        assert.isFalse(yield* computer.hasKeys(linux.linkId));
        assert.deepEqual((yield* links.snapshot).outbound, []);
        // Every try asked for the whole unlink: stop its work there, and
        // forget that computer's own link back.
        assert.isTrue(
          computer.told.every(
            (call) => call.input.stopRunning === true && call.input.reverse === true,
          ),
        );
      }),
  );

  it.effect(
    "an unlink is confirmed at once when the other computer hears it, or when its halves are already gone",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        const links = yield* computer.boot;
        const heard = outboundLink("link-heard", EnvironmentId.make("env-a"), "A");
        const appRemoved = outboundLink("link-app-removed", EnvironmentId.make("env-b"), "B");
        const removedThere = {
          ...outboundLink("link-revoked", EnvironmentId.make("env-c"), "C"),
          state: "revoked" as const,
        };
        for (const row of [heard, appRemoved, removedThere]) yield* computer.addLink(row);
        computer.answers.set(heard.linkId, "unlinks");

        const results = [
          yield* links.remove({ direction: "outbound", linkId: heard.linkId }),
          yield* links.remove({
            direction: "outbound",
            linkId: appRemoved.linkId,
            otherHalfRemoved: true,
          }),
          yield* links.remove({ direction: "outbound", linkId: removedThere.linkId }),
        ];
        assert.deepEqual(
          results.map((result) => result.otherComputer),
          ["confirmed", "confirmed", "confirmed"],
        );
        for (const row of [heard, appRemoved, removedThere]) {
          assert.isFalse(yield* computer.hasLink(row.linkId));
          assert.isFalse(yield* computer.hasKeys(row.linkId));
        }
        // Only the one whose other half was still there was told.
        assert.deepEqual(
          computer.told.map((call) => call.linkId),
          [heard.linkId],
        );
      }),
  );

  it.effect("a link an earlier run left unlinking is finished when the server starts", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      const windows = {
        ...outboundLink("link-windows", EnvironmentId.make("env-windows"), "Windows PC"),
        state: "unlinking" as const,
      };
      yield* computer.addLink(windows);
      computer.answers.set(windows.linkId, "unlinks");
      yield* computer.boot;
      yield* eventually(
        Effect.map(computer.hasLink(windows.linkId), (has) => !has),
        "the unlink finishes",
      );
    }),
  );

  it.effect(
    "peer.unlink with reverse stops what the link started, and drops the link back only once that computer refuses it",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        const links = yield* computer.boot;
        // Windows PC links to this computer (its device here), and this
        // computer links back to it; a link to another computer stays.
        const windowsId = EnvironmentId.make("env-windows");
        const session = yield* computer.addInboundLink({
          deviceId: "device-windows",
          environmentId: windowsId,
        });
        const back = outboundLink("link-back", windowsId, "Windows PC");
        // A newer link back, made since: Windows PC takes that one.
        const replacement = {
          ...outboundLink("link-back-new", windowsId, "Windows PC"),
          createdAt: "2026-10-21T11:00:00.000Z",
        };
        computer.takesLink.set(replacement.linkId, true);
        const linuxId = EnvironmentId.make("env-linux");
        const other = outboundLink("link-linux", linuxId, "Linux box");
        yield* computer.addLink(back);
        yield* computer.addLink(replacement);
        yield* computer.addLink(other);
        // Linux box still takes this computer's link: a peer naming it can't end that.
        computer.takesLinkBack.set(linuxId, true);
        // Settings tells this link's row by its session, never by its name.
        assert.equal((yield* links.snapshot).inbound[0]?.sessionId, session);

        const peer = yield* RpcTest.makeClient(PeerRpcGroup).pipe(
          Effect.provide(
            makePeerRpcLayer({ sessionId: session, deviceId: "device-windows" }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  computer.services,
                  Layer.succeed(ComputerLinks, links),
                  Layer.mock(ProviderRegistry)({}),
                  Layer.mock(ServerSettingsService)({}),
                  Layer.mock(ProjectionSnapshotQuery)({}),
                  Layer.mock(RepositoryIdentityResolver)({}),
                ),
              ),
            ),
          ),
        );
        yield* peer["peer.unlink"]({ stopRunning: true, reverse: true });

        // Its access went off before the drain, and a second drain after its
        // session ended catches work that got past the first.
        assert.deepEqual(computer.dropped, [
          { deviceId: "device-windows", stopRunning: true },
          { deviceId: "device-windows", stopRunning: true },
        ]);
        const device = yield* computer.devices.getDevice("device-windows");
        assert.equal(Option.getOrThrow(device).linkAccess, "off");
        assert.deepEqual(computer.revoked, [session]);
        // The last pass found nothing at work: nothing more is owed.
        assert.equal(computer.owed.size, 0);
        // Windows PC refuses this computer's link back: it goes, keys and all.
        yield* eventually(
          Effect.map(computer.hasLink(back.linkId), (has) => !has),
          "the link back to Windows PC is dropped",
        );
        assert.isFalse(yield* computer.hasKeys(back.linkId));
        // Each link back is judged by its own answer: the one it takes stays.
        assert.isTrue(yield* computer.hasLink(replacement.linkId));
        assert.isTrue(yield* computer.hasLink(other.linkId));
        // Windows PC's side is gone already: nothing was sent back.
        assert.deepEqual(computer.told, []);

        // A peer claiming to be Linux box can't make this computer drop its
        // link there: Linux box still takes it.
        yield* computer.devices.touchLink({
          deviceId: "device-windows",
          environmentId: linuxId,
          now: AT,
        });
        yield* links
          .unlinkedByPeer({
            deviceId: "device-windows",
            sessionId: session,
            stopRunning: false,
            reverseTo: linuxId,
          })
          .pipe(Effect.ignore, Effect.forkChild);
        yield* wallClockSleep(100);
        yield* TestClock.adjust(Duration.seconds(5));
        yield* wallClockSleep(100);
        assert.isTrue(yield* computer.hasLink(other.linkId));
      }),
  );

  it.effect(
    "an unlink a peer asks for finishes though its call is cut off, and stops it couldn't finish stay owed",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        const links = yield* computer.boot;
        const session = yield* computer.addInboundLink({
          deviceId: "device-windows",
          environmentId: EnvironmentId.make("env-windows"),
        });
        const release = yield* Deferred.make<void>();
        computer.dropPlan.push(
          { wait: release },
          { fail: "Mac couldn't stop everything the link started. Try again." },
        );
        const call = yield* links
          .unlinkedByPeer({
            deviceId: "device-windows",
            sessionId: session,
            stopRunning: true,
            reverseTo: null,
          })
          .pipe(Effect.forkChild);
        yield* wallClockSleep(20);
        // Ending its session closes the connection the call came over.
        yield* Fiber.interrupt(call);
        yield* Deferred.succeed(release, undefined);
        yield* eventually(
          Effect.sync(() => computer.dropped.length === 2),
          "both passes run all the same",
        );
        assert.deepEqual(computer.revoked, [session]);
        // The last pass fell short: the stops stay owed, to be tried again.
        assert.isTrue(computer.owed.has("device-windows"));
      }),
  );

  it.effect(
    "a settings change waits for an unlink in progress, never turning the link back on mid-way",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        const links = yield* computer.boot;
        yield* computer.addInboundLink({
          deviceId: "device-windows",
          environmentId: EnvironmentId.make("env-windows"),
        });
        const release = yield* Deferred.make<void>();
        computer.dropPlan.push({ wait: release });
        const unlinking = yield* Effect.forkChild(
          links.remove({ direction: "inbound", deviceId: "device-windows", stopRunning: true }),
        );
        yield* wallClockSleep(20);
        const changing = yield* Effect.forkChild(
          links.setAccess({ deviceId: "device-windows", access: "allowed" }),
        );
        yield* wallClockSleep(50);
        // The unlink turned it off and is stopping what it started: it stays off.
        const during = Option.getOrThrow(yield* computer.devices.getDevice("device-windows"));
        assert.equal(during.linkAccess, "off");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(unlinking);
        yield* Fiber.join(changing).pipe(Effect.ignore);
      }),
  );

  it.effect(
    "a computer's link, once used, ends its older links here, and a newer one only once abandoned",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        const links = yield* computer.boot;
        const windowsId = EnvironmentId.make("env-windows");
        yield* computer.addInboundLink({
          deviceId: "device-old",
          environmentId: windowsId,
          createdAt: "1969-12-31T22:00:00.000Z",
        });
        // An older link that only says it is Windows PC.
        yield* computer.addInboundLink({
          deviceId: "device-says-windows",
          environmentId: windowsId,
          pinned: false,
          createdAt: "1969-12-31T22:30:00.000Z",
        });
        yield* computer.addInboundLink({
          deviceId: "device-linux",
          environmentId: EnvironmentId.make("env-linux"),
          createdAt: "1969-12-31T21:00:00.000Z",
        });
        yield* computer.addInboundLink({
          deviceId: "device-current",
          environmentId: windowsId,
          createdAt: "1969-12-31T23:00:00.000Z",
        });
        // Made after it, never used, long ago: Windows PC stopped while making it.
        yield* computer.addInboundLink({
          deviceId: "device-abandoned",
          environmentId: windowsId,
          createdAt: "1969-12-31T23:30:00.000Z",
        });
        // Being made right now: newer than the one in use.
        yield* computer.addInboundLink({
          deviceId: "device-newest",
          environmentId: windowsId,
          createdAt: "1969-12-31T23:55:00.000Z",
        });
        // On the test clock it is now 1970-01-01T00:00:00Z.
        const linkOf = (deviceId: string) =>
          Effect.map(computer.devices.getDevice(deviceId), (row) =>
            peerLinkOf(Option.getOrThrow(row)),
          );

        // A link whose computer isn't confirmed proves nothing: it ends nothing.
        yield* links.linkInUse(yield* linkOf("device-says-windows"));
        assert.deepEqual(computer.revoked, []);

        yield* links.linkInUse(yield* linkOf("device-current"));
        assert.deepEqual(computer.revoked, [
          AuthSessionId.make("session-device-old"),
          AuthSessionId.make("session-device-says-windows"),
          AuthSessionId.make("session-device-abandoned"),
        ]);
        // Ended as a removal, not an unlink: what they started isn't stopped.
        assert.deepEqual(computer.dropped, [
          { deviceId: "device-old", stopRunning: false },
          { deviceId: "device-says-windows", stopRunning: false },
          { deviceId: "device-abandoned", stopRunning: false },
        ]);
      }),
  );

  it.effect("a new link waits for an earlier unlink of that computer to finish", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      const links = yield* computer.boot;
      const old = {
        ...outboundLink("link-old", EnvironmentId.make("env-windows"), "Windows PC"),
        state: "unlinking" as const,
      };
      yield* computer.addLink(old);
      const invite: ComputerLinkInvite = {
        hostId: RelayHostId.make("8911ad8a-f546-45e5-a2e8-7a6a8adfc65c"),
        relayOrigin: "http://127.0.0.1:1",
        inviteId: RelayInviteId.make("invite-1"),
        inviteSecret: "secret",
        hostPublicKey: "key",
        directOrigins: [],
        environmentId: old.remoteEnvironmentId,
        label: "Windows PC",
        expiresAt: AT,
      };
      const waiting = yield* Effect.flip(links.accept(invite));
      assert.equal(
        waiting.detail,
        "Couldn't reach Windows PC to finish unlinking it first. Try again.",
      );
      // Nothing was claimed, and the unlink is still pending.
      assert.equal(Option.getOrThrow(yield* computer.repo.get(old.linkId)).state, "unlinking");

      // It hears the unlink this time: the old link goes, then the invite is claimed.
      computer.answers.set(old.linkId, "unlinks");
      const claimed = yield* Effect.flip(links.accept(invite));
      assert.isFalse(yield* computer.hasLink(old.linkId));
      assert.notEqual(claimed.detail, waiting.detail);
    }),
  );

  it.effect(
    "changes to this computer's links to one computer wait for each other: linking, linking again, unlinking",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        const links = yield* computer.boot;
        const windowsId = EnvironmentId.make("env-windows");
        const old = {
          ...outboundLink("link-old", windowsId, "Windows PC"),
          state: "unlinking" as const,
        };
        const current = outboundLink("link-current", windowsId, "Windows PC");
        yield* computer.addLink(old);
        yield* computer.addLink(current);
        const invite: ComputerLinkInvite = {
          hostId: RelayHostId.make("8911ad8a-f546-45e5-a2e8-7a6a8adfc65c"),
          relayOrigin: "http://127.0.0.1:1",
          inviteId: RelayInviteId.make("invite-1"),
          inviteSecret: "secret",
          hostPublicKey: "key",
          directOrigins: [],
          environmentId: windowsId,
          label: "Windows PC",
          expiresAt: AT,
        };
        // The startup retry of the earlier unlink has had its turn.
        yield* wallClockSleep(50);
        const before = computer.told.length;
        // The first link being made waits on Windows PC hearing the earlier unlink.
        const heard = yield* Deferred.make<void>();
        computer.unlinkHolds.push(heard);
        const first = yield* Effect.forkChild(Effect.flip(links.accept(invite)));
        yield* wallClockSleep(50);
        const second = yield* Effect.forkChild(Effect.flip(links.accept(invite)));
        const unlink = yield* Effect.forkChild(
          links.remove({ direction: "outbound", linkId: current.linkId }),
        );
        yield* wallClockSleep(100);
        // Neither the second link nor the unlink has started meanwhile.
        assert.deepEqual(
          computer.told.slice(before).map((call) => call.linkId),
          [old.linkId],
        );
        assert.isTrue(yield* computer.hasLink(current.linkId));

        yield* Deferred.succeed(heard, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        const removed = yield* Fiber.join(unlink);
        // The unlink told Windows PC itself: it found the link where it was.
        assert.equal(removed.otherComputer, "pending");
        assert.isTrue(computer.told.some((call) => call.linkId === current.linkId));
      }),
  );

  it.effect("a late write never brings back a link that is unlinking or was removed there", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer;
      const unlinking = {
        ...outboundLink("link-unlinking", EnvironmentId.make("env-a"), "A"),
        state: "unlinking" as const,
      };
      const removed = {
        ...outboundLink("link-removed", EnvironmentId.make("env-b"), "B"),
        state: "revoked" as const,
      };
      yield* computer.addLink(unlinking);
      yield* computer.addLink(removed);
      // A link's first connection failing late, or a reconnect landing late.
      yield* computer.repo.update({
        linkId: unlinking.linkId,
        state: "failed",
        lastError: "It didn't answer.",
      });
      yield* computer.repo.update({ linkId: removed.linkId, state: "active" });
      assert.equal(
        Option.getOrThrow(yield* computer.repo.get(unlinking.linkId)).state,
        "unlinking",
      );
      assert.equal(Option.getOrThrow(yield* computer.repo.get(removed.linkId)).state, "revoked");
    }),
  );
});
