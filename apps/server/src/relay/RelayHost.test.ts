import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@threadlines/contracts";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { createServer } from "node:http";

import { AuthCoreLive } from "../auth/Layers/AuthControlPlane.ts";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RelayDeviceRepository, RelayDeviceRepositoryLive } from "./RelayDeviceRepository.ts";
import { RelayHost, RelayHostLive } from "./RelayHost.ts";

const HOST_ID = "8911ad8a-f546-45e5-a2e8-7a6a8adfc65c";
const AT = "2026-10-20T10:00:00.000Z";

/**
 * Just enough of a relay for a host to reconnect and finish an approval: the
 * control socket (an empty snapshot) and the approve call, recorded.
 */
const fakeRelay = (approved: Array<string>) =>
  HttpRouter.serve(
    Layer.mergeAll(
      HttpRouter.add(
        "GET",
        `/v2/hosts/${HOST_ID}/control`,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const socket = yield* request.upgrade;
          const write = yield* socket.writer;
          // Writes go out once the socket runs.
          const running = yield* socket
            .runRaw(() => undefined)
            .pipe(Effect.ignore, Effect.forkChild);
          yield* write(
            JSON.stringify({
              type: "snapshot",
              requests: [],
              devices: [],
              usage: {
                messages: 0,
                awakeSeconds: 0,
                messageLimit: 1000,
                awakeSecondsLimit: 1000,
                limited: false,
                resetsAt: AT,
              },
            }),
          );
          yield* Fiber.join(running);
          return HttpServerResponse.empty();
        }).pipe(Effect.scoped),
      ),
      HttpRouter.add(
        "POST",
        `/v2/hosts/${HOST_ID}/requests/:requestId/approve`,
        Effect.gen(function* () {
          const params = yield* HttpRouter.params;
          approved.push(params.requestId!);
          return HttpServerResponse.jsonUnsafe({
            requestId: params.requestId,
            deviceId: "device-1",
            state: "approved",
          });
        }),
      ),
    ),
    { disableLogger: true, disableListenLog: true },
  ).pipe(Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port: 0 })));

const wallClockSleep = (durationMs: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));

it.layer(NodeServices.layer)("RelayHost", (it) => {
  it.effect(
    "gives a device approved before a crash the role its invite granted, never the joiner's say",
    () =>
      Effect.gen(function* () {
        const approved: Array<string> = [];
        const relay = yield* Layer.build(fakeRelay(approved));
        const address = Context.get(relay, HttpServer.HttpServer).address;
        assert.isTrue(typeof address !== "string" && "port" in address);
        const relayOrigin = `http://127.0.0.1:${(address as { readonly port: number }).port}`;

        const storage = Layer.mergeAll(RelayDeviceRepositoryLive, AuthCoreLive).pipe(
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provideMerge(ServerSecretStoreLive),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "relay-host-test-" })),
        );
        const stored = yield* Layer.build(storage);
        const repo = Context.get(stored, RelayDeviceRepository);
        const secrets = Context.get(stored, ServerSecretStore);
        const sessions = Context.get(stored, SessionCredentialService);

        // The previous process registered with the relay, recorded a computer
        // link's claim with the grant its invite carried, and stopped before
        // issuing the session. The joiner called itself a phone.
        yield* repo.saveHost({ hostId: HOST_ID, relayOrigin, createdAt: AT });
        yield* secrets.set("relay-host-secret", new TextEncoder().encode("host-secret"));
        yield* repo.insertApproving({
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
        yield* Context.get(host, RelayHost).start("http://127.0.0.1:1");

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
        assert.deepEqual(approved, ["request-1"]);
        const session = (yield* sessions.listActive()).find(
          (entry) => entry.sessionId === device.sessionId,
        );
        assert.equal(session?.role, "peer");
      }),
  );
});
