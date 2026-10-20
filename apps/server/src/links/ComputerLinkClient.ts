/**
 * ComputerLinkClient: this server's connections to the computers it links to
 * (docs/design/fleet.md, "Server pieces (A side, outbound)").
 *
 * Each link is a `peer` device of the other computer's server. A connection
 * is the shared end-to-end encrypted channel (direct routes first, then the
 * relay) carrying an Effect RPC client for PeerRpcGroup. It is opened on
 * first use, kept while anything uses it (a watch stream holds it open while
 * requests or reports are owed), and closed after two idle minutes.
 * Reconnects back off up to a minute. A connection the other computer
 * refuses because it removed the link marks the link `revoked`.
 */
import {
  type ComputerLinkConnection,
  type ComputerLinkId,
  type EnvironmentId,
  type PeerDescriptor,
  PeerRpcGroup,
  type PeerRpcError,
  RELAY_CLOSE_CODE_ACCESS_REMOVED,
  RELAY_TOKEN_PROTOCOL_PREFIX,
  RELAY_WEBSOCKET_PROTOCOL,
} from "@threadlines/contracts";
import { relayDeviceSocketUrl } from "@threadlines/shared/relayJoin";
import {
  SECURE_CLOSE_CODE_NO_ROUTE,
  SECURE_OPEN_TIMEOUT_MS,
  type SecureRoute,
} from "@threadlines/shared/relaySecureSocket";
import type { StoredKeyPair } from "@threadlines/shared/relaySecure";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { RpcClientError } from "effect/unstable/rpc";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as Socket from "effect/unstable/socket/Socket";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { ComputerLinkRepository, type ComputerLinkRow } from "./ComputerLinkRepository.ts";
import { PeerSocket } from "./peerSocket.ts";

type PeerRpcs = typeof PeerRpcGroup extends RpcGroup.RpcGroup<infer Rpcs> ? Rpcs : never;
/** An RPC client for one linked computer's PeerRpcGroup. */
export type PeerClient = RpcClient.RpcClient<PeerRpcs, RpcClientError.RpcClientError>;

/** How long an unused connection stays open. */
export const LINK_IDLE_CLOSE_MS = 2 * 60_000;
/** How long a computer's description (agents, projects) is reused before asking again. */
export const LINK_DESCRIBE_TTL_MS = 5 * 60_000;
const IDLE_SWEEP_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;

/** The name a link's device keys are kept under in the server secret store. */
export const computerLinkSecretName = (linkId: string) => `computer-link-${linkId}`;

export const ComputerLinkSecrets = Schema.Struct({
  deviceSecret: Schema.String,
  deviceKey: Schema.Struct({ privateKey: Schema.String, publicKey: Schema.String }),
});
export type ComputerLinkSecrets = typeof ComputerLinkSecrets.Type;
const ComputerLinkSecretsJson = Schema.fromJsonString(ComputerLinkSecrets);
export const encodeComputerLinkSecrets = Schema.encodeSync(ComputerLinkSecretsJson);
const decodeComputerLinkSecrets = Schema.decodeUnknownOption(ComputerLinkSecretsJson);

/** The other computer can't be reached right now, or removed the link. */
export class ComputerLinkUnavailableError extends Data.TaggedError("ComputerLinkUnavailableError")<{
  readonly environmentId: string;
  readonly detail: string;
  readonly revoked: boolean;
}> {
  override get message(): string {
    return this.detail;
  }
}

export interface ComputerLinkLiveStatus {
  readonly linkId: ComputerLinkId;
  readonly environmentId: EnvironmentId;
  readonly connection: ComputerLinkConnection;
  readonly route: SecureRoute | null;
}

export interface ComputerLinkClientShape {
  /**
   * Runs `use` with a client for the linked computer, opening or reusing the
   * connection. Transport failures become ComputerLinkUnavailableError.
   */
  readonly withPeer: <A>(
    environmentId: EnvironmentId,
    use: (client: PeerClient) => Effect.Effect<A, PeerRpcError | RpcClientError.RpcClientError>,
  ) => Effect.Effect<A, PeerRpcError | ComputerLinkUnavailableError>;
  /** A stream from the linked computer; the connection stays open while it runs. */
  readonly peerStream: <A>(
    environmentId: EnvironmentId,
    use: (client: PeerClient) => Stream.Stream<A, PeerRpcError | RpcClientError.RpcClientError>,
  ) => Stream.Stream<A, PeerRpcError | ComputerLinkUnavailableError>;
  /** peer.describe, reused for five minutes unless `fresh`. */
  readonly describe: (
    environmentId: EnvironmentId,
    options?: { readonly fresh?: boolean },
  ) => Effect.Effect<PeerDescriptor, PeerRpcError | ComputerLinkUnavailableError>;
  /** The last description this server got, however old; null if none. */
  readonly cachedDescribe: (environmentId: EnvironmentId) => PeerDescriptor | null;
  /** Live connection state of every link; current value first. */
  readonly statuses: Stream.Stream<ReadonlyMap<string, ComputerLinkLiveStatus>>;
  readonly currentStatuses: Effect.Effect<ReadonlyMap<string, ComputerLinkLiveStatus>>;
  /** Closes and forgets a link's connection (it was removed or revoked). */
  readonly disconnect: (linkId: ComputerLinkId) => Effect.Effect<void>;
}

export class ComputerLinkClient extends Context.Service<
  ComputerLinkClient,
  ComputerLinkClientShape
>()("threadlines/links/ComputerLinkClient") {}

interface Connection {
  readonly linkId: ComputerLinkId;
  readonly environmentId: EnvironmentId;
  readonly scope: Scope.Closeable;
  readonly client: PeerClient;
  inUse: number;
  lastUsedAt: number;
}

const isRpcClientError = (error: unknown): error is RpcClientError.RpcClientError =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly _tag?: unknown })._tag === "RpcClientError";

const make = Effect.gen(function* () {
  const repo = yield* ComputerLinkRepository;
  const secrets = yield* ServerSecretStore;
  const environment = yield* ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  const connections = new Map<string, Connection>();
  const opening = new Map<string, Promise<Connection>>();
  const describeCache = new Map<string, { readonly at: number; readonly value: PeerDescriptor }>();
  const statusRef = yield* SubscriptionRef.make<ReadonlyMap<string, ComputerLinkLiveStatus>>(
    new Map(),
  );

  const setStatus = (
    row: Pick<ComputerLinkRow, "linkId" | "remoteEnvironmentId">,
    patch: {
      readonly connection: ComputerLinkConnection;
      readonly route?: SecureRoute | null;
    },
  ) =>
    SubscriptionRef.update(statusRef, (current) => {
      const previous = current.get(row.linkId);
      const next = new Map(current);
      next.set(row.linkId, {
        linkId: row.linkId,
        environmentId: row.remoteEnvironmentId,
        connection: patch.connection,
        route: patch.route !== undefined ? patch.route : (previous?.route ?? null),
      });
      return next;
    });

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const unavailable = (environmentId: string, detail: string, revoked = false) =>
    new ComputerLinkUnavailableError({ environmentId, detail, revoked });

  /** The link this server uses for a computer, if it has a usable one. */
  const linkFor = (environmentId: EnvironmentId) =>
    repo.getByEnvironment(environmentId).pipe(
      Effect.mapError(() => unavailable(environmentId, "This computer's links couldn't be read.")),
      Effect.flatMap((row) =>
        Option.isNone(row)
          ? Effect.fail(unavailable(environmentId, "That computer isn't linked to this one."))
          : row.value.state === "revoked"
            ? Effect.fail(
                unavailable(
                  environmentId,
                  `${row.value.remoteLabel} removed this computer's link. Link them again.`,
                  true,
                ),
              )
            : Effect.succeed(row.value),
      ),
    );

  const readSecrets = (linkId: string) =>
    secrets.get(computerLinkSecretName(linkId)).pipe(
      Effect.map((bytes) =>
        bytes === null
          ? Option.none<ComputerLinkSecrets>()
          : decodeComputerLinkSecrets(new TextDecoder().decode(bytes)),
      ),
      Effect.orElseSucceed(() => Option.none<ComputerLinkSecrets>()),
    );

  /** The other computer removed the link: no more tries until it is linked again. */
  const markRevoked = (row: ComputerLinkRow) =>
    Effect.gen(function* () {
      yield* repo
        .update({
          linkId: row.linkId,
          state: "revoked",
          lastError: `${row.remoteLabel} removed this computer's link.`,
        })
        .pipe(Effect.ignore);
      yield* closeConnection(row.linkId);
      yield* setStatus(row, { connection: "offline", route: null });
      yield* Effect.logInfo("links.revoked", { linkId: row.linkId });
    });

  /**
   * Whether the far end of a direct route answers "gone" (410) for this
   * device: a direct route can't carry a close code before the upgrade.
   */
  const directRoutesSayRevoked = (row: ComputerLinkRow) =>
    Effect.promise(async () => {
      for (const route of row.directRoutes) {
        try {
          const url = new URL(route);
          url.protocol = url.protocol === "wss:" ? "https:" : "http:";
          const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
          if (response.status === 410) return true;
        } catch {
          // Not reachable this way.
        }
      }
      return false;
    });

  const onSocketClose = (row: ComputerLinkRow, code: number) => {
    if (code === RELAY_CLOSE_CODE_ACCESS_REMOVED) {
      runFork(markRevoked(row));
      return;
    }
    if (code === SECURE_CLOSE_CODE_NO_ROUTE) {
      runFork(
        directRoutesSayRevoked(row).pipe(
          Effect.flatMap((revoked) => (revoked ? markRevoked(row) : Effect.void)),
        ),
      );
    }
  };

  const openConnection = (row: ComputerLinkRow) =>
    Effect.gen(function* () {
      const stored = yield* readSecrets(row.linkId);
      if (Option.isNone(stored)) {
        return yield* unavailable(
          row.remoteEnvironmentId,
          `This computer's keys for ${row.remoteLabel} are missing. Link them again.`,
        );
      }
      const linkSecrets = stored.value;
      const deviceKey: StoredKeyPair = linkSecrets.deviceKey;
      const resolveTarget = async () => {
        // The latest routes the other computer reported.
        const current = await Effect.runPromiseWith(context)(
          repo.get(row.linkId).pipe(Effect.orElseSucceed(() => Option.none())),
        );
        const latest = Option.getOrElse(current, () => row);
        return {
          hostId: latest.hostId,
          deviceId: latest.deviceId,
          hostPublicKey: latest.hostPublicKey,
          deviceKey,
          directRoutes: latest.directRoutes,
          relay: {
            url: relayDeviceSocketUrl({
              relayOrigin: latest.relayOrigin,
              hostId: latest.hostId,
              deviceId: latest.deviceId,
            }),
            protocols: [
              RELAY_WEBSOCKET_PROTOCOL,
              `${RELAY_TOKEN_PROTOCOL_PREFIX}${linkSecrets.deviceSecret}`,
            ],
          },
        };
      };
      const scope = yield* Scope.make();
      const socketLayer = Layer.effect(
        Socket.Socket,
        Socket.fromWebSocket(
          Effect.acquireRelease(
            Effect.sync(() => {
              runFork(setStatus(row, { connection: "connecting" }));
              const socket = new PeerSocket(`peer://${row.remoteEnvironmentId}`, {
                resolveTarget,
                onOpen: (route) => {
                  runFork(
                    Effect.gen(function* () {
                      yield* setStatus(row, { connection: "connected", route });
                      yield* repo
                        .update({
                          linkId: row.linkId,
                          state: "active",
                          lastConnectedAt: yield* nowIso,
                          lastError: null,
                        })
                        .pipe(Effect.ignore);
                    }),
                  );
                },
                onClose: (code, reason) => {
                  runFork(
                    Effect.gen(function* () {
                      yield* setStatus(row, { connection: "reconnecting", route: null });
                      if (code !== 1000 && reason.length > 0) {
                        yield* repo
                          .update({ linkId: row.linkId, lastError: reason.slice(0, 300) })
                          .pipe(Effect.ignore);
                      }
                    }),
                  );
                  onSocketClose(row, code);
                },
              });
              return socket as unknown as globalThis.WebSocket;
            }),
            (socket) => Effect.sync(() => socket.close(1000)),
          ),
          { openTimeout: Duration.millis(SECURE_OPEN_TIMEOUT_MS) },
        ),
      );
      const protocolLayer = Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({
          retryPolicy: Schedule.min([
            Schedule.exponential("1 second", 2),
            Schedule.spaced("1 minute"),
          ]),
        }),
      ).pipe(Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)));
      const built = yield* Layer.buildWithScope(protocolLayer, scope);
      const client: PeerClient = yield* RpcClient.make(PeerRpcGroup).pipe(
        Effect.provide(built),
        Scope.provide(scope),
      );
      const connection: Connection = {
        linkId: row.linkId,
        environmentId: row.remoteEnvironmentId,
        scope,
        client,
        inUse: 0,
        lastUsedAt: Date.now(),
      };
      connections.set(row.linkId, connection);
      return connection;
    });

  const closeConnection = (linkId: string) =>
    Effect.gen(function* () {
      const connection = connections.get(linkId);
      if (connection === undefined) return;
      connections.delete(linkId);
      yield* Scope.close(connection.scope, Exit.void);
    });

  const connectionFor = (environmentId: EnvironmentId) =>
    Effect.gen(function* () {
      const row = yield* linkFor(environmentId);
      const existing = connections.get(row.linkId);
      if (existing !== undefined) return existing;
      // One connection per link, even when two callers race to open it.
      let pending = opening.get(row.linkId);
      if (pending === undefined) {
        pending = Effect.runPromiseWith(context)(openConnection(row)).finally(() =>
          opening.delete(row.linkId),
        );
        opening.set(row.linkId, pending);
      }
      const opened = pending;
      return yield* Effect.tryPromise({
        try: () => opened,
        catch: (cause) =>
          cause instanceof ComputerLinkUnavailableError
            ? cause
            : unavailable(environmentId, `Couldn't connect to ${row.remoteLabel}.`),
      });
    });

  const toUnavailable =
    (environmentId: string) =>
    <E>(error: E): Exclude<E, RpcClientError.RpcClientError> | ComputerLinkUnavailableError =>
      isRpcClientError(error)
        ? unavailable(environmentId, "The other computer can't be reached right now.")
        : (error as Exclude<E, RpcClientError.RpcClientError>);

  const withPeer = <A>(
    environmentId: EnvironmentId,
    use: (client: PeerClient) => Effect.Effect<A, PeerRpcError | RpcClientError.RpcClientError>,
  ): Effect.Effect<A, PeerRpcError | ComputerLinkUnavailableError> =>
    Effect.gen(function* () {
      const connection = yield* connectionFor(environmentId);
      connection.inUse += 1;
      connection.lastUsedAt = Date.now();
      return yield* use(connection.client).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(REQUEST_TIMEOUT_MS),
          orElse: () =>
            Effect.fail(unavailable(environmentId, "The other computer didn't answer in time.")),
        }),
        Effect.mapError(toUnavailable(environmentId)),
        Effect.ensuring(
          Effect.sync(() => {
            connection.inUse -= 1;
            connection.lastUsedAt = Date.now();
          }),
        ),
      );
    });

  const peerStream = <A>(
    environmentId: EnvironmentId,
    use: (client: PeerClient) => Stream.Stream<A, PeerRpcError | RpcClientError.RpcClientError>,
  ): Stream.Stream<A, PeerRpcError | ComputerLinkUnavailableError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const connection = yield* connectionFor(environmentId);
        connection.inUse += 1;
        connection.lastUsedAt = Date.now();
        return use(connection.client).pipe(
          Stream.mapError(toUnavailable(environmentId)),
          Stream.ensuring(
            Effect.sync(() => {
              connection.inUse -= 1;
              connection.lastUsedAt = Date.now();
            }),
          ),
        );
      }),
    );

  const describe: ComputerLinkClientShape["describe"] = (environmentId, options) =>
    Effect.gen(function* () {
      const cached = describeCache.get(environmentId);
      if (options?.fresh !== true && cached && Date.now() - cached.at < LINK_DESCRIBE_TTL_MS) {
        return cached.value;
      }
      const row = yield* linkFor(environmentId);
      const value = yield* withPeer(environmentId, (client) =>
        client["peer.describe"]({
          caller: { environmentId: descriptor.environmentId, label: descriptor.label },
        }),
      );
      describeCache.set(environmentId, { at: Date.now(), value });
      // What the other computer says about itself is kept for next time.
      yield* repo
        .update({
          linkId: row.linkId,
          remoteLabel: value.label,
          remotePlatform: value.platform,
          ...(value.directRoutes.length > 0 ? { directRoutes: value.directRoutes } : {}),
        })
        .pipe(Effect.ignore);
      return value;
    });

  const cachedDescribe: ComputerLinkClientShape["cachedDescribe"] = (environmentId) =>
    describeCache.get(environmentId)?.value ?? null;

  const disconnect: ComputerLinkClientShape["disconnect"] = (linkId) =>
    Effect.gen(function* () {
      const connection = connections.get(linkId);
      if (connection !== undefined) describeCache.delete(connection.environmentId);
      yield* closeConnection(linkId);
      yield* SubscriptionRef.update(statusRef, (current) => {
        if (!current.has(linkId)) return current;
        const next = new Map(current);
        next.delete(linkId);
        return next;
      });
    });

  // Idle connections close; one in use (a call, a watch) never does.
  yield* Effect.gen(function* () {
    const now = Date.now();
    for (const connection of connections.values()) {
      if (connection.inUse <= 0 && now - connection.lastUsedAt > LINK_IDLE_CLOSE_MS) {
        yield* closeConnection(connection.linkId);
        const row = yield* repo
          .get(connection.linkId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isSome(row) && row.value.state !== "revoked") {
          yield* setStatus(row.value, { connection: "idle", route: null });
        }
      }
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("links.idle-sweep.failed", { cause })),
    Effect.repeat(Schedule.spaced(Duration.millis(IDLE_SWEEP_MS))),
    Effect.forkScoped,
  );

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...connections.keys()], closeConnection, { discard: true }),
  );

  return ComputerLinkClient.of({
    withPeer,
    peerStream,
    describe,
    cachedDescribe,
    statuses: SubscriptionRef.changes(statusRef),
    currentStatuses: SubscriptionRef.get(statusRef),
    disconnect,
  });
});

export const ComputerLinkClientLive = Layer.effect(ComputerLinkClient, make);
