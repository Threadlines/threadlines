import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  ComputerLinkId,
  EnvironmentId,
  PeerRpcError,
  PeerRpcGroup,
  type PeerUnlinkInput,
} from "@threadlines/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
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
import { LinkRequests, PEER_LINK_REMOVED } from "./LinkRequests.ts";
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
  const told: Array<{ readonly linkId: string; readonly input: PeerUnlinkInput }> = [];
  const dropped: Array<{ readonly deviceId: string; readonly stopRunning: boolean }> = [];
  const revoked: Array<string> = [];

  const client = {
    ...realClient,
    unlinkPeer: (linkId: ComputerLinkId, input: PeerUnlinkInput) =>
      Effect.suspend((): Effect.Effect<void, PeerRpcError | ComputerLinkUnavailableError> => {
        told.push({ linkId, input });
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
      }),
  };
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
        Effect.sync(() => {
          dropped.push({ deviceId, stopRunning: options?.stopRunning === true });
        }),
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
  const hasKeys = (linkId: ComputerLinkId) =>
    Effect.map(secrets.get(computerLinkSecretName(linkId)), (bytes) => bytes !== null);

  return {
    context,
    services,
    client,
    repo,
    devices,
    answers,
    told,
    dropped,
    revoked,
    boot,
    addLink,
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
    "peer.unlink with reverse stops what the link started and forgets this computer's own link back",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        const links = yield* computer.boot;
        // Windows PC links to this computer (its device here), and this
        // computer links back to it; a link to another computer stays.
        const windowsId = EnvironmentId.make("env-windows");
        const session = AuthSessionId.make("session-windows");
        yield* computer.devices.insertApproving({
          deviceId: "device-windows",
          requestId: "pairing-windows",
          relayOrigin: "http://relay.test",
          label: "Windows PC",
          kind: "computer",
          platform: null,
          devicePublicKey: "key",
          grant: "peer",
          now: AT,
        });
        yield* computer.devices.transition({
          deviceId: "device-windows",
          from: ["approving"],
          to: "active",
          now: AT,
        });
        yield* computer.devices.setSession({
          deviceId: "device-windows",
          sessionId: session,
          now: AT,
        });
        yield* computer.devices.touchLink({
          deviceId: "device-windows",
          environmentId: windowsId,
          now: AT,
        });
        const back = outboundLink("link-back", windowsId, "Windows PC");
        const other = outboundLink("link-linux", EnvironmentId.make("env-linux"), "Linux box");
        yield* computer.addLink(back);
        yield* computer.addLink(other);
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

        assert.deepEqual(computer.dropped, [{ deviceId: "device-windows", stopRunning: true }]);
        assert.isFalse(yield* computer.hasLink(back.linkId));
        assert.isFalse(yield* computer.hasKeys(back.linkId));
        assert.isTrue(yield* computer.hasLink(other.linkId));
        assert.deepEqual(computer.revoked, [session]);
        // Windows PC's side is gone already: nothing was sent back.
        assert.deepEqual(computer.told, []);
      }),
  );
});
