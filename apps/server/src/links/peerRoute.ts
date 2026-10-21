/**
 * `/peer`: where another computer's server, linked to this one, is served
 * (docs/design/fleet.md, "Separate endpoint"). The relay host splices a
 * linked computer's verified end-to-end connection to this socket with a
 * short-lived WebSocket token for its `peer` session; every other role is
 * refused here, and `peer` is refused everywhere else. Only PeerRpcGroup is
 * served, so what a link can do is that group, by construction.
 */
import {
  type AuthSessionId,
  EnvironmentId,
  PeerRpcError,
  PeerRpcGroup,
  type PeerDescriptor,
  type PeerCaller,
} from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { respondToAuthError } from "../auth/http.ts";
import { AuthError } from "../auth/Services/ServerAuth.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { listThreadAgents } from "../mcp/threadToolHandlers.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { RelayDeviceRepository } from "../relay/RelayDeviceRepository.ts";
import { RelayHost } from "../relay/RelayHost.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { isLoopbackHost } from "../startupAccess.ts";
import { ComputerLinks } from "./ComputerLinks.ts";
import { LinkRequests, PEER_LINK_REMOVED, peerLinkOf } from "./LinkRequests.ts";

const PLATFORM_NAMES: Record<string, string> = {
  darwin: "macOS",
  windows: "Windows",
  linux: "Linux",
};

/** PeerRpcGroup's handlers for one linked computer's session. */
export const makePeerRpcLayer = (input: {
  readonly sessionId: AuthSessionId;
  readonly deviceId: string;
}) =>
  PeerRpcGroup.toLayer(
    Effect.gen(function* () {
      const linkRequests = yield* LinkRequests;
      const computerLinks = yield* ComputerLinks;
      const devices = yield* RelayDeviceRepository;
      const relayHost = yield* RelayHost;
      const environment = yield* ServerEnvironment;
      const providers = yield* ProviderRegistry;
      const settings = yield* ServerSettingsService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const identities = yield* RepositoryIdentityResolver;

      const failed = (detail: string) => new PeerRpcError({ detail });

      /** The link as it is now: its access can change while it is connected. */
      const currentLink = devices.getDevice(input.deviceId).pipe(
        Effect.mapError(() => failed("This computer's links couldn't be read.")),
        Effect.flatMap((row) =>
          Option.isSome(row) && row.value.state === "active" && row.value.grant === "peer"
            ? Effect.succeed(peerLinkOf(row.value))
            : Effect.fail(failed(PEER_LINK_REMOVED)),
        ),
      );

      /** Unexpected trouble becomes a plain refusal for the asking computer. */
      const guarded = <A>(effect: Effect.Effect<A, PeerRpcError>) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.gen(function* () {
                  const failure = Cause.findErrorOption(cause);
                  if (Option.isSome(failure)) return yield* failure.value;
                  yield* Effect.logWarning("peer.request.failed", { cause: Cause.pretty(cause) });
                  return yield* failed("Something went wrong on this computer.");
                }),
          ),
        );

      const describe = (caller: PeerCaller) =>
        Effect.gen(function* () {
          const link = yield* currentLink;
          yield* devices
            .touchLink({
              deviceId: link.deviceId,
              environmentId: caller.environmentId,
              now: DateTime.formatIso(yield* DateTime.now),
            })
            .pipe(Effect.ignore);
          const descriptor = yield* environment.getDescriptor;
          const all = yield* providers.getProviders;
          const defaults = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
          const catalog = yield* snapshots
            .getProjectCatalog()
            .pipe(Effect.orElseSucceed(() => ({ projects: [] as const })));
          const projects: Array<PeerDescriptor["projects"][number]> = [];
          for (const project of catalog.projects) {
            if (project.deletedAt !== null || project.kind === "general-chat") continue;
            const identity = yield* identities.resolve(project.workspaceRoot);
            if (identity?.canonicalKey) {
              projects.push({ name: project.title, canonicalKey: identity.canonicalKey });
            }
          }
          const defaultAgent = defaults?.newThreadModelSelection ?? null;
          return {
            environmentId: descriptor.environmentId,
            label: descriptor.label,
            platform: PLATFORM_NAMES[descriptor.platform.os] ?? descriptor.platform.os,
            serverVersion: descriptor.serverVersion,
            directRoutes: yield* relayHost.directRoutes(input.sessionId),
            access: link.access,
            maxRuntimeMode: link.maxRuntimeMode,
            agents: listThreadAgents(all, { interactionMode: "default" }).agents,
            defaultAgent:
              defaultAgent === null
                ? null
                : { instanceId: defaultAgent.instanceId, model: defaultAgent.model },
            projects,
          } satisfies PeerDescriptor;
        });

      return PeerRpcGroup.of({
        "peer.describe": (payload) => guarded(describe(payload.caller)),
        "peer.request.start": (payload) =>
          guarded(Effect.flatMap(currentLink, (link) => linkRequests.start(link, payload))),
        "peer.request.send": (payload) =>
          guarded(Effect.flatMap(currentLink, (link) => linkRequests.send(link, payload))),
        "peer.request.cancel": (payload) =>
          guarded(
            Effect.flatMap(currentLink, (link) =>
              linkRequests.cancel(link, payload.requestId, {
                stopThread: payload.stopThread === true,
              }),
            ),
          ),
        "peer.thread.stop": (payload) =>
          guarded(
            Effect.flatMap(currentLink, (link) => linkRequests.stopThread(link, payload.threadId)),
          ),
        "peer.thread.read": (payload) =>
          guarded(Effect.flatMap(currentLink, (link) => linkRequests.readThread(link, payload))),
        "peer.thread.list": () =>
          guarded(Effect.flatMap(currentLink, (link) => linkRequests.listThreads(link))),
        "peer.watch": () =>
          Stream.unwrap(Effect.map(currentLink, (link) => linkRequests.watch(link))),
        "peer.report.ack": (payload) =>
          guarded(Effect.flatMap(currentLink, (link) => linkRequests.ack(link, payload.reportId))),
        // The other computer removed its link: what it still had open here is
        // cancelled (with `stopRunning`, its running threads stop too); with
        // `reverse` this computer's own link back to it goes as well. Then its
        // session here ends, which also takes it off the relay and closes this
        // connection. A failure leaves the session, so it asks again.
        "peer.unlink": (payload) =>
          guarded(
            Effect.gen(function* () {
              const link = yield* currentLink;
              yield* computerLinks
                .unlinkedByPeer({
                  deviceId: link.deviceId,
                  sessionId: input.sessionId,
                  stopRunning: payload.stopRunning === true,
                  reverseTo:
                    payload.reverse === true && link.environmentId !== null
                      ? EnvironmentId.make(link.environmentId)
                      : null,
                })
                .pipe(Effect.mapError((error) => failed(error.detail)));
            }),
          ),
      });
    }),
  );

export const peerRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return HttpRouter.add(
      "GET",
      "/peer",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        // The relay host opens this socket from this server itself, on the
        // address it listens on.
        const remote = Option.getOrNull(request.remoteAddress)?.replace(/^::ffff:/u, "") ?? null;
        if (
          remote !== null &&
          !isLoopbackHost(remote) &&
          (config.host === undefined || remote !== config.host)
        ) {
          return yield* new AuthError({
            message: "Linked computers connect through this server's own relay link.",
            status: 403,
          });
        }
        const serverAuth = yield* ServerAuth;
        const sessions = yield* SessionCredentialService;
        const devices = yield* RelayDeviceRepository;
        const session = yield* serverAuth.authenticatePeerUpgrade(request);
        const device = yield* devices
          .getDeviceBySession(session.sessionId)
          .pipe(
            Effect.mapError(
              (cause) => new AuthError({ message: "Unauthorized request.", status: 401, cause }),
            ),
          );
        if (
          Option.isNone(device) ||
          device.value.state !== "active" ||
          device.value.grant !== "peer"
        ) {
          return yield* new AuthError({ message: PEER_LINK_REMOVED, status: 401 });
        }
        const rpcEffect = yield* RpcServer.toHttpEffectWebsocket(PeerRpcGroup, {
          disableTracing: true,
        }).pipe(
          Effect.provide(
            makePeerRpcLayer({
              sessionId: session.sessionId,
              deviceId: device.value.deviceId,
            }).pipe(Layer.provideMerge(RpcSerialization.layerJson)),
          ),
        );
        // A link removed while connected is cut off at once, like a device's /ws.
        const closeWhenRevoked = sessions.awaitRevoked(session.sessionId).pipe(
          Effect.as(HttpServerResponse.empty({ status: 401 })),
          Effect.catchCause((cause) =>
            Effect.logWarning("peer.session.revocation-watch-failed", { cause }).pipe(
              Effect.andThen(Effect.never),
            ),
          ),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => Effect.raceFirst(rpcEffect, closeWhenRevoked),
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(Effect.scoped, Effect.catchTag("AuthError", respondToAuthError)),
    );
  }),
);
