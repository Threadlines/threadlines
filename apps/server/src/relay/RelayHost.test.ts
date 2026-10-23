import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, type RelayHookDeliveryId, type RelayHookId } from "@threadlines/contracts";
import { hookDeliveryAad, sealHookDelivery } from "@threadlines/shared/relayHookSeal";
import { fromUtf8, utf8 } from "@threadlines/shared/relaySecure";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";
import { createServer } from "node:http";

import { AuthCoreLive } from "../auth/Layers/AuthControlPlane.ts";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RelayDeviceRepository, RelayDeviceRepositoryLive } from "./RelayDeviceRepository.ts";
import { RelayHooks } from "./RelayHooks.ts";
import {
  RelayHookStateRepository,
  RelayHookStateRepositoryLive,
} from "./RelayHookStateRepository.ts";
import { RelayHost, RelayHostLive } from "./RelayHost.ts";

const HOST_ID = "8911ad8a-f546-45e5-a2e8-7a6a8adfc65c";
const GONE_HOST_ID = "0c4f7a2e-5f39-4a43-9a52-1f6fb5c1d0a7";
const AT = "2026-10-20T10:00:00.000Z";
const USAGE = {
  messages: 0,
  awakeSeconds: 0,
  messageLimit: 1000,
  awakeSecondsLimit: 1000,
  limited: false,
  resetsAt: AT,
};

interface FakeHost {
  revision: number;
  publicKey: string | null;
  readonly hooks: Map<string, { active: boolean }>;
}

/**
 * Just enough of a relay for a host: registration, the control socket (an
 * empty snapshot, then whatever the test writes), approvals, and hooks with
 * the relay's revision rule. Records what the host sent.
 */
function makeFakeRelay(knownHosts: ReadonlyArray<string>) {
  const state = {
    hosts: new Map<string, FakeHost>(
      knownHosts.map((hostId) => [hostId, { revision: 0, publicKey: null, hooks: new Map() }]),
    ),
    registered: [] as string[],
    approved: [] as string[],
    controls: [] as string[],
    /** Every hook call's revision, in arrival order, failed ones included. */
    revisions: [] as number[],
    failPuts: false,
    fetchable: new Map<string, unknown>(),
    acked: [] as string[],
    write: null as
      | ((chunk: string | Socket.CloseEvent) => Effect.Effect<void, Socket.SocketError>)
      | null,
  };
  const unknownHost = HttpServerResponse.jsonUnsafe(
    { error: "This computer is not registered with the relay.", code: "unknown-host" },
    { status: 404 },
  );
  const hostRoute = <E, R>(
    handle: (
      host: FakeHost,
      hostId: string,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const host = state.hosts.get(params.hostId!);
      return host ? yield* handle(host, params.hostId!) : unknownHost;
    });
  const body = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return (yield* request.json) as Record<string, unknown>;
  });

  const layer = HttpRouter.serve(
    Layer.mergeAll(
      HttpRouter.add(
        "POST",
        "/v2/hosts",
        Effect.sync(() => {
          const hostId = crypto.randomUUID();
          state.hosts.set(hostId, { revision: 0, publicKey: null, hooks: new Map() });
          state.registered.push(hostId);
          return HttpServerResponse.jsonUnsafe({ hostId, hostSecret: `secret-${hostId}` });
        }),
      ),
      HttpRouter.add(
        "GET",
        "/v2/hosts/:hostId/control",
        hostRoute((_host, hostId) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const socket = yield* request.upgrade;
            const write = yield* socket.writer;
            // Writes go out once the socket runs.
            const running = yield* socket
              .runRaw((data) => {
                const message = JSON.parse(typeof data === "string" ? data : fromUtf8(data)) as {
                  type?: string;
                  deliveryIds?: string[];
                };
                if (message.type === "hook.ack") state.acked.push(...(message.deliveryIds ?? []));
              })
              .pipe(Effect.ignore, Effect.forkChild);
            state.controls.push(hostId);
            state.write = write;
            yield* write(
              JSON.stringify({ type: "snapshot", requests: [], devices: [], usage: USAGE }),
            );
            yield* Fiber.join(running);
            return HttpServerResponse.empty();
          }).pipe(Effect.scoped),
        ),
      ),
      HttpRouter.add(
        "POST",
        "/v2/hosts/:hostId/requests/:requestId/approve",
        Effect.gen(function* () {
          const params = yield* HttpRouter.params;
          state.approved.push(params.requestId!);
          return HttpServerResponse.jsonUnsafe({
            requestId: params.requestId,
            deviceId: "device-1",
            state: "approved",
          });
        }),
      ),
      HttpRouter.add(
        "POST",
        "/v2/hosts/:hostId/hooks",
        hostRoute((host) =>
          Effect.gen(function* () {
            const input = yield* body;
            const revision = input.revision as number;
            state.revisions.push(revision);
            if (revision <= host.revision) {
              return HttpServerResponse.jsonUnsafe(
                { error: "Stale.", code: "stale-revision" },
                { status: 409 },
              );
            }
            const hookId = crypto.randomUUID().replaceAll("-", "").slice(0, 22);
            host.revision = revision;
            host.publicKey = input.publicKey as string;
            host.hooks.set(hookId, { active: true });
            return HttpServerResponse.jsonUnsafe({ hookId, url: `https://relay.test/${hookId}` });
          }),
        ),
      ),
      HttpRouter.add(
        "PUT",
        "/v2/hosts/:hostId/hooks",
        hostRoute((host) =>
          Effect.gen(function* () {
            const input = yield* body;
            const revision = input.revision as number;
            state.revisions.push(revision);
            if (state.failPuts) {
              return HttpServerResponse.jsonUnsafe({ error: "Down." }, { status: 503 });
            }
            if (revision <= host.revision) {
              return HttpServerResponse.jsonUnsafe({ applied: false, revision: host.revision });
            }
            const named = new Set(
              (input.active as Array<{ hookId: string }>).map((hook) => hook.hookId),
            );
            for (const [hookId, hook] of host.hooks) hook.active = named.has(hookId);
            host.revision = revision;
            host.publicKey = input.publicKey as string;
            return HttpServerResponse.jsonUnsafe({ applied: true, revision });
          }),
        ),
      ),
      HttpRouter.add(
        "GET",
        "/v2/hosts/:hostId/hooks",
        hostRoute((host) =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ revision: host.revision })),
        ),
      ),
      HttpRouter.add(
        "GET",
        "/v2/hosts/:hostId/hooks/deliveries/:deliveryId",
        Effect.gen(function* () {
          const params = yield* HttpRouter.params;
          const delivery = state.fetchable.get(params.deliveryId!);
          return delivery
            ? HttpServerResponse.jsonUnsafe(delivery)
            : HttpServerResponse.jsonUnsafe({ error: "Not found." }, { status: 404 });
        }),
      ),
    ),
    { disableLogger: true, disableListenLog: true },
  ).pipe(Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port: 0 })));
  return { state, layer };
}

const wallClockSleep = (durationMs: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));

/** Fails a test that waits longer than `ms` on the wall clock (`it.effect` runs a test clock). */
const withinWallClock =
  (ms: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.raceFirst(
      effect,
      wallClockSleep(ms).pipe(Effect.andThen(Effect.die(new Error(`timed out after ${ms} ms`)))),
    );

/** Polls `check` on the wall clock (the relay link runs on real timers). */
const waitFor = (label: string, check: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (check()) return;
      yield* wallClockSleep(20);
    }
    assert.fail(`timed out waiting for ${label}`);
  });

/**
 * A relay host over in-memory storage, pointed at a fake relay. `prepare`
 * runs against the storage first (a previous process's leftovers).
 */
const startHost = <E>(
  knownHosts: ReadonlyArray<string>,
  prepare: (stored: Context.Context<never>, relayOrigin: string) => Effect.Effect<void, E> = () =>
    Effect.void,
) =>
  Effect.gen(function* () {
    const fake = makeFakeRelay(knownHosts);
    const relay = yield* Layer.build(fake.layer);
    const address = Context.get(relay, HttpServer.HttpServer).address;
    assert.isTrue(typeof address !== "string" && "port" in address);
    const relayOrigin = `http://127.0.0.1:${(address as { readonly port: number }).port}`;

    const storage = Layer.mergeAll(
      RelayDeviceRepositoryLive,
      RelayHookStateRepositoryLive,
      AuthCoreLive,
    ).pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerSecretStoreLive),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "relay-host-test-" })),
    );
    const stored = yield* Layer.build(storage);
    yield* prepare(stored as Context.Context<never>, relayOrigin);

    const host = yield* Layer.build(
      RelayHostLive.pipe(
        Layer.provide(
          Layer.mock(ServerEnvironment)({
            getDescriptor: Effect.succeed({
              environmentId: EnvironmentId.make("env-mac-mini"),
              label: "Mac mini",
              platform: { os: "darwin", arch: "arm64" },
              serverVersion: "0.0.0",
              capabilities: { repositoryIdentity: true },
            }),
          }),
        ),
        Layer.provide(Layer.succeedContext(stored)),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { THREADLINES_RELAY_URL: relayOrigin } }),
          ),
        ),
      ),
    );
    return {
      fake: fake.state,
      stored,
      relayHost: Context.get(host, RelayHost),
      hooks: Context.get(host, RelayHooks),
    };
  });

/** Credentials a previous process stored for `hostId`. */
const registeredAs = (hostId: string) => (stored: Context.Context<never>, relayOrigin: string) =>
  Effect.gen(function* () {
    yield* Context.get(
      stored as Context.Context<RelayDeviceRepository>,
      RelayDeviceRepository,
    ).saveHost({ hostId, relayOrigin, createdAt: AT });
    yield* Context.get(stored as Context.Context<ServerSecretStore>, ServerSecretStore).set(
      "relay-host-secret",
      utf8(`secret-${hostId}`),
    );
  });

it.layer(NodeServices.layer)("RelayHost", (it) => {
  it.effect(
    "gives a device approved before a crash the role its invite granted, never the joiner's say",
    () =>
      Effect.gen(function* () {
        const { fake, stored, relayHost } = yield* startHost([HOST_ID], (stored, relayOrigin) =>
          Effect.gen(function* () {
            yield* registeredAs(HOST_ID)(stored, relayOrigin);
            // The previous process recorded a computer link's claim with the
            // grant its invite carried, and stopped before issuing the
            // session. The joiner called itself a phone.
            yield* Context.get(
              stored as Context.Context<RelayDeviceRepository>,
              RelayDeviceRepository,
            ).insertApproving({
              deviceId: "device-1",
              requestId: "request-1",
              relayOrigin,
              label: "Windows PC",
              kind: "phone",
              platform: "Windows",
              devicePublicKey: "key",
              grant: "peer",
              now: AT,
            });
          }),
        );
        const repo = Context.get(stored, RelayDeviceRepository);
        const sessions = Context.get(stored, SessionCredentialService);
        yield* relayHost.start("http://127.0.0.1:1");

        let row = yield* repo.getDevice("device-1");
        for (
          let attempt = 0;
          attempt < 50 && Option.getOrThrow(row).state !== "active";
          attempt++
        ) {
          yield* wallClockSleep(20);
          row = yield* repo.getDevice("device-1");
        }
        const device = Option.getOrThrow(row);
        assert.equal(device.state, "active");
        assert.deepEqual(fake.approved, ["request-1"]);
        const session = (yield* sessions.listActive()).find(
          (entry) => entry.sessionId === device.sessionId,
        );
        assert.equal(session?.role, "peer");
      }),
  );

  it.effect("keeps a hook change until the relay applies it, across a disconnect", () =>
    Effect.gen(function* () {
      const { fake, relayHost, hooks } = yield* startHost([HOST_ID], registeredAs(HOST_ID));
      yield* relayHost.start("http://127.0.0.1:1");
      // No devices, no invite, no hooks: nothing keeps the relay link open.
      yield* wallClockSleep(100);
      assert.deepEqual(fake.controls, []);

      const minted = yield* hooks.mint({ keptHeaders: ["x-custom"] });
      assert.equal(minted.hostId, HOST_ID);
      // A wanted hook is relay work: the control socket opens for it.
      yield* waitFor("the control socket", () => fake.controls.length === 1);
      yield* hooks.setActive([{ hookId: minted.hookId, keptHeaders: ["x-custom"] }]);

      // Retire it while the relay can't take the change.
      fake.failPuts = true;
      yield* hooks.setActive([]);
      yield* waitFor("a refused state", () => fake.revisions.length >= 2);
      assert.isTrue(fake.hosts.get(HOST_ID)!.hooks.get(minted.hookId)!.active);

      // The change is sent again when the host reconnects.
      fake.failPuts = false;
      yield* fake.write!(new Socket.CloseEvent(1001, "Relay restarting."));
      yield* waitFor(
        "the retire",
        () => !fake.hosts.get(HOST_ID)!.hooks.get(minted.hookId)!.active,
      );
      assert.equal(fake.controls.length, 2);
      // Every call took a fresh, larger revision than the one before.
      assert.deepEqual(
        fake.revisions,
        [...fake.revisions].sort((left, right) => left - right),
      );
      assert.equal(new Set(fake.revisions).size, fake.revisions.length);
    }),
  );

  it.effect("opens deliveries for the pipeline and acks them, and one that can't open", () =>
    Effect.gen(function* () {
      const { fake, relayHost, hooks } = yield* startHost([HOST_ID], registeredAs(HOST_ID));
      yield* relayHost.start("http://127.0.0.1:1");
      const minted = yield* hooks.mint({ keptHeaders: [] });
      yield* waitFor("the control socket", () => fake.write !== null);
      const publicKey = fake.hosts.get(HOST_ID)!.publicKey!;

      const sealed = (deliveryId: string, text: string) =>
        Effect.promise(() =>
          sealHookDelivery({
            publicKey,
            aad: hookDeliveryAad(HOST_ID, minted.hookId, deliveryId),
            payload: {
              method: "POST",
              query: "",
              headers: { "x-github-event": "issues" },
              body: utf8(text),
              receivedAt: AT,
            },
          }),
        );
      const delivery = (deliveryId: string, envelope: string) => ({
        deliveryId: deliveryId as RelayHookDeliveryId,
        hookId: minted.hookId as RelayHookId,
        receivedAt: AT,
        sealed: envelope,
      });
      fake.fetchable.set("large", delivery("large", yield* sealed("large", "fetched")));
      for (const event of [
        { type: "hook.delivery", delivery: delivery("small", yield* sealed("small", "inline")) },
        { type: "hook.delivery", delivery: delivery("broken", "v1.AAAA.AAAA.AAAA") },
        {
          type: "hook.pending",
          deliveryId: "large",
          hookId: minted.hookId,
          receivedAt: AT,
          size: 1,
        },
      ]) {
        yield* fake.write!(JSON.stringify(event));
      }

      const received = yield* hooks.deliveries.pipe(Stream.take(2), Stream.runCollect);
      assert.deepEqual(
        received.map((opened) => [opened.deliveryId, fromUtf8(opened.payload.body)]),
        [
          ["small", "inline"],
          ["large", "fetched"],
        ],
      );
      assert.equal(received[0]!.payload.headers["x-github-event"], "issues");

      yield* hooks.ack(received.map((opened) => opened.deliveryId));
      yield* waitFor("the acks", () => fake.acked.length === 3);
      assert.deepEqual([...fake.acked].sort(), ["broken", "large", "small"]);
    }),
  );

  it.effect("registers again and says so when the relay no longer knows this computer", () =>
    Effect.gen(function* () {
      const { fake, stored, relayHost, hooks } = yield* startHost([], (stored, relayOrigin) =>
        Effect.gen(function* () {
          yield* registeredAs(GONE_HOST_ID)(stored, relayOrigin);
          // An event task's hook, minted under the identity the relay lost.
          yield* Context.get(
            stored as Context.Context<RelayHookStateRepository>,
            RelayHookStateRepository,
          ).save(
            {
              revision: 4,
              syncedRevision: 4,
              active: [{ hookId: "old-hook" as RelayHookId, keptHeaders: [] }],
              mintedHostId: GONE_HOST_ID,
              publicKey: null,
            },
            AT,
          );
        }),
      );
      yield* relayHost.start("http://127.0.0.1:1");

      const change = yield* hooks.changes.pipe(
        Stream.filter((entry) => entry.kind === "host-changed"),
        Stream.take(1),
        Stream.runCollect,
        withinWallClock(5_000),
      );
      const fresh = fake.registered[0]!;
      assert.deepEqual(change, [{ kind: "host-changed", hostId: fresh }]);
      assert.equal(yield* hooks.hostId, fresh);
      const host = yield* Context.get(stored, RelayDeviceRepository).getHost;
      assert.equal(Option.getOrThrow(host).hostId, fresh);
      // The old hooks went with the old identity; the pipeline mints new ones.
      const state = yield* Context.get(stored, RelayHookStateRepository).get;
      assert.deepEqual(state.active, []);
      assert.equal(fake.registered.length, 1);
    }),
  );
});
