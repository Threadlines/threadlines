/**
 * ComputerLinks: what the `links.*` client methods do (docs/design/fleet.md,
 * "Links RPC for clients"). It makes this computer's single-use link invites,
 * accepts another computer's invite as that computer's `peer` device, lists
 * both directions with their live state, and changes or removes them.
 */
import {
  type ComputerLinkAccess,
  ComputerLinkError,
  ComputerLinkId,
  type ComputerLinkInvite,
  type ComputerLinksSnapshot,
  EnvironmentId,
  type InboundComputerLink,
  type LinksCreateInviteInput,
  type LinksRemoveInput,
  type LinksRespondRequestInput,
  type LinksSetAccessInput,
  type OutboundComputerLink,
  type RelayAccessError,
} from "@threadlines/contracts";
import {
  cancelRelayRequest,
  claimRelayInvite,
  getRelayRequestStatus,
  RelayInviteInvalidError,
  RelayRequestError,
} from "@threadlines/shared/relayJoin";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { directRouteAt } from "../relay/directRoutes.ts";
import { RelayDeviceRepository, type RelayDeviceRow } from "../relay/RelayDeviceRepository.ts";
import { RelayHost } from "../relay/RelayHost.ts";
import {
  ComputerLinkClient,
  computerLinkSecretName,
  type ComputerLinkLiveStatus,
} from "./ComputerLinkClient.ts";
import { ComputerLinkRepository, type ComputerLinkRow } from "./ComputerLinkRepository.ts";
import { LinkRequests } from "./LinkRequests.ts";
import { peerLinkOf } from "./peerRoute.ts";

const APPROVAL_WAIT_MS = 30_000;
const APPROVAL_POLL_MS = 500;

const PLATFORM_NAMES: Record<string, string> = {
  darwin: "macOS",
  windows: "Windows",
  linux: "Linux",
};

export interface ComputerLinksShape {
  /** An invite for `joinerEnvironmentId` only: its link here is recorded as that computer's. */
  readonly createInvite: (
    input: LinksCreateInviteInput,
  ) => Effect.Effect<ComputerLinkInvite, ComputerLinkError>;
  readonly accept: (
    invite: ComputerLinkInvite,
  ) => Effect.Effect<OutboundComputerLink, ComputerLinkError>;
  readonly snapshot: Effect.Effect<ComputerLinksSnapshot, ComputerLinkError>;
  /** The snapshot now, then again whenever something in it changes. */
  readonly changes: Stream.Stream<ComputerLinksSnapshot, ComputerLinkError>;
  readonly setAccess: (
    input: LinksSetAccessInput,
  ) => Effect.Effect<InboundComputerLink, ComputerLinkError>;
  readonly remove: (input: LinksRemoveInput) => Effect.Effect<void, ComputerLinkError>;
  readonly respondRequest: (
    input: LinksRespondRequestInput,
  ) => Effect.Effect<void, ComputerLinkError>;
}

export class ComputerLinks extends Context.Service<ComputerLinks, ComputerLinksShape>()(
  "threadlines/links/ComputerLinks",
) {}

const linkError = (detail: string) => new ComputerLinkError({ detail });

const make = Effect.gen(function* () {
  const repo = yield* ComputerLinkRepository;
  const client = yield* ComputerLinkClient;
  const relayHost = yield* RelayHost;
  const devices = yield* RelayDeviceRepository;
  const secrets = yield* ServerSecretStore;
  const sessions = yield* SessionCredentialService;
  const environment = yield* ServerEnvironment;
  const linkRequests = yield* LinkRequests;
  const descriptor = yield* environment.getDescriptor;
  const changed = yield* PubSub.sliding<void>(1);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const notify = PubSub.publish(changed, undefined).pipe(Effect.asVoid);

  const outboundOf = (
    row: ComputerLinkRow,
    statuses: ReadonlyMap<string, ComputerLinkLiveStatus>,
  ): OutboundComputerLink => {
    const live = statuses.get(row.linkId);
    return {
      linkId: row.linkId,
      remoteEnvironmentId: row.remoteEnvironmentId,
      remoteLabel: row.remoteLabel,
      remotePlatform: row.remotePlatform,
      state: row.state,
      connection: row.state === "revoked" ? "offline" : (live?.connection ?? "idle"),
      route: live?.route ?? null,
      createdAt: row.createdAt,
      lastConnectedAt: row.lastConnectedAt,
      lastError: row.lastError,
    };
  };

  const inboundOf = (row: RelayDeviceRow): InboundComputerLink => {
    const link = peerLinkOf(row);
    return {
      deviceId: row.deviceId,
      environmentId:
        row.linkEnvironmentId === null ? null : EnvironmentId.make(row.linkEnvironmentId),
      label: row.label,
      platform: row.platform,
      environmentPinned: row.linkEnvironmentPinned,
      access: link.access,
      maxRuntimeMode: link.maxRuntimeMode,
      createdAt: row.createdAt,
      lastUsedAt: row.linkLastUsedAt,
    };
  };

  const isInboundLink = (row: RelayDeviceRow) =>
    row.grant === "peer" && (row.state === "active" || row.state === "approving");

  const snapshot: ComputerLinksShape["snapshot"] = Effect.gen(function* () {
    const outbound = yield* repo.list;
    const statuses = yield* client.currentStatuses;
    const inbound = (yield* devices.listDevices).filter(isInboundLink);
    return {
      outbound: outbound.map((row) => outboundOf(row, statuses)),
      inbound: inbound.map(inboundOf),
      pending: yield* linkRequests.pending,
    };
  }).pipe(Effect.mapError(() => linkError("This computer's links couldn't be read.")));

  const changes: ComputerLinksShape["changes"] = Stream.concat(
    Stream.make(undefined),
    Stream.mergeAll(
      [
        client.statuses.pipe(Stream.map(() => undefined)),
        linkRequests.pendingChanges,
        Stream.fromPubSub(changed),
        sessions.streamChanges.pipe(Stream.map(() => undefined)),
      ],
      { concurrency: "unbounded" },
    ),
  ).pipe(
    Stream.debounce(Duration.millis(100)),
    Stream.mapEffect(() => snapshot),
  );

  const createInvite: ComputerLinksShape["createInvite"] = (input) =>
    Effect.gen(function* () {
      if (input.joinerEnvironmentId === descriptor.environmentId) {
        return yield* linkError("A computer can't link to itself.");
      }
      const made = yield* relayHost
        .createLinkInvite(input.joinerEnvironmentId)
        .pipe(Effect.mapError((error: RelayAccessError) => linkError(error.detail)));
      return {
        hostId: made.invite.hostId,
        relayOrigin: made.invite.relayOrigin,
        inviteId: made.invite.inviteId,
        inviteSecret: made.invite.inviteSecret,
        hostPublicKey: made.invite.hostPublicKey,
        directOrigins: [...made.directOrigins],
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        expiresAt: made.invite.expiresAt,
      } satisfies ComputerLinkInvite;
    });

  /** Waits for the other computer to approve this server's claim (it does so on its own). */
  const awaitApproval = (input: {
    readonly relayOrigin: string;
    readonly hostId: string;
    readonly requestId: string;
    readonly requestSecret: string;
  }) =>
    Effect.gen(function* () {
      const deadline = Date.now() + APPROVAL_WAIT_MS;
      while (Date.now() < deadline) {
        const status = yield* Effect.tryPromise({
          try: () => getRelayRequestStatus(input),
          catch: () => linkError("Couldn't reach the relay."),
        }).pipe(Effect.option);
        if (Option.isSome(status) && status.value.state !== "pending") {
          return status.value.state;
        }
        yield* Effect.sleep(Duration.millis(APPROVAL_POLL_MS));
      }
      return "expired" as const;
    });

  const accept: ComputerLinksShape["accept"] = (invite) =>
    Effect.gen(function* () {
      if (invite.environmentId === descriptor.environmentId) {
        return yield* linkError("That invite is for this computer.");
      }
      // Already linked and working: that link stands.
      const existing = yield* repo
        .getByEnvironment(invite.environmentId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(existing) && existing.value.state === "active") {
        const works = yield* client
          .describe(invite.environmentId, { fresh: true })
          .pipe(Effect.option);
        if (Option.isSome(works)) {
          const fresh = yield* repo
            .get(existing.value.linkId)
            .pipe(Effect.orElseSucceed(Option.none));
          return outboundOf(
            Option.getOrElse(fresh, () => existing.value),
            yield* client.currentStatuses,
          );
        }
      }
      const claim = yield* Effect.tryPromise({
        try: () =>
          claimRelayInvite({
            invite: {
              relayOrigin: invite.relayOrigin,
              hostId: invite.hostId,
              inviteId: invite.inviteId,
              inviteSecret: invite.inviteSecret,
              hostPublicKey: invite.hostPublicKey,
            },
            joiner: {
              label: descriptor.label,
              platform: PLATFORM_NAMES[descriptor.platform.os] ?? descriptor.platform.os,
              kind: "computer",
            },
          }),
        catch: (cause) =>
          linkError(
            cause instanceof RelayInviteInvalidError || cause instanceof RelayRequestError
              ? cause.message
              : "Couldn't reach the relay to link the computers.",
          ),
      });
      if (claim.accepted.hostEnvironmentId !== invite.environmentId) {
        return yield* linkError("The relay answered for a different computer.");
      }
      const linkId = ComputerLinkId.make(crypto.randomUUID());
      const secretName = computerLinkSecretName(linkId);
      yield* secrets
        .set(
          secretName,
          new TextEncoder().encode(
            JSON.stringify({
              deviceSecret: claim.credentials.deviceSecret,
              deviceKey: claim.credentials.deviceKey,
            }),
          ),
        )
        .pipe(Effect.mapError(() => linkError("This computer couldn't store the link's keys.")));
      const decided = yield* awaitApproval({
        relayOrigin: invite.relayOrigin,
        hostId: invite.hostId,
        requestId: claim.accepted.requestId,
        requestSecret: claim.requestSecret,
      });
      if (decided !== "approved") {
        yield* secrets.remove(secretName).pipe(Effect.ignore);
        yield* Effect.promise(() =>
          cancelRelayRequest({
            relayOrigin: invite.relayOrigin,
            hostId: invite.hostId,
            requestId: claim.accepted.requestId,
            requestSecret: claim.requestSecret,
          }).catch(() => undefined),
        );
        return yield* linkError(
          decided === "denied"
            ? `${invite.label} refused the link.`
            : `${invite.label} didn't accept the link in time. Try again.`,
        );
      }
      // Older links to that computer (removed there) give way to this one.
      for (const old of yield* repo.list.pipe(Effect.orElseSucceed(() => []))) {
        if (old.remoteEnvironmentId !== invite.environmentId) continue;
        yield* client.disconnect(old.linkId);
        yield* repo.remove(old.linkId).pipe(Effect.ignore);
        yield* secrets.remove(computerLinkSecretName(old.linkId)).pipe(Effect.ignore);
      }
      const row: ComputerLinkRow = {
        linkId,
        remoteEnvironmentId: invite.environmentId,
        remoteLabel: invite.label,
        remotePlatform: null,
        relayOrigin: invite.relayOrigin,
        hostId: invite.hostId,
        deviceId: claim.accepted.deviceId,
        hostPublicKey: invite.hostPublicKey,
        directRoutes: invite.directOrigins.map((origin) =>
          directRouteAt(origin, claim.accepted.deviceId),
        ),
        state: "active",
        createdAt: yield* nowIso,
        lastConnectedAt: null,
        lastError: null,
      };
      yield* repo
        .insert(row)
        .pipe(Effect.mapError(() => linkError("This computer couldn't save the link.")));
      yield* notify;
      // One connection to confirm it works end to end.
      const confirmed = yield* client
        .describe(invite.environmentId, { fresh: true })
        .pipe(Effect.result);
      if (confirmed._tag === "Failure") {
        yield* repo
          .update({ linkId, state: "failed", lastError: confirmed.failure.message.slice(0, 300) })
          .pipe(Effect.ignore);
      }
      yield* notify;
      const saved = yield* repo.get(linkId).pipe(Effect.orElseSucceed(Option.none));
      return outboundOf(
        Option.getOrElse(saved, () => row),
        yield* client.currentStatuses,
      );
    });

  const inboundRow = (deviceId: string) =>
    devices.getDevice(deviceId).pipe(
      Effect.mapError(() => linkError("This computer's links couldn't be read.")),
      Effect.flatMap((row) =>
        Option.isSome(row) && isInboundLink(row.value)
          ? Effect.succeed(row.value)
          : Effect.fail(linkError("That computer isn't linked to this one.")),
      ),
    );

  const setAccess: ComputerLinksShape["setAccess"] = (input) =>
    Effect.gen(function* () {
      yield* inboundRow(input.deviceId);
      yield* devices
        .setLinkSettings({
          deviceId: input.deviceId,
          ...(input.access !== undefined ? { access: input.access as ComputerLinkAccess } : {}),
          ...(input.maxRuntimeMode !== undefined ? { maxRuntimeMode: input.maxRuntimeMode } : {}),
          now: yield* nowIso,
        })
        .pipe(Effect.mapError(() => linkError("The link's settings couldn't be saved.")));
      yield* notify;
      return inboundOf(yield* inboundRow(input.deviceId));
    });

  const remove: ComputerLinksShape["remove"] = (input) =>
    Effect.gen(function* () {
      if (input.direction === "inbound") {
        const row = yield* inboundRow(input.deviceId);
        yield* linkRequests.dropLink(row.deviceId);
        // Revoking the session takes it off the relay and closes its connection.
        if (row.sessionId !== null) {
          yield* sessions.revoke(row.sessionId).pipe(Effect.ignore);
        }
        yield* notify;
        return;
      }
      const row = yield* repo.get(input.linkId).pipe(
        Effect.mapError(() => linkError("This computer's links couldn't be read.")),
        Effect.flatMap((found) =>
          Option.isSome(found)
            ? Effect.succeed(found.value)
            : Effect.fail(linkError("That link is already gone.")),
        ),
      );
      // Tell the other computer to drop this one's access there; best effort.
      if (row.state !== "revoked") {
        yield* client
          .withPeer(row.remoteEnvironmentId, (peer) => peer["peer.unlink"]({}))
          .pipe(Effect.timeout(Duration.seconds(5)), Effect.ignore);
      }
      yield* client.disconnect(row.linkId);
      yield* repo
        .remove(row.linkId)
        .pipe(Effect.mapError(() => linkError("The link couldn't be removed.")));
      yield* secrets.remove(computerLinkSecretName(row.linkId)).pipe(Effect.ignore);
      yield* notify;
    });

  const respondRequest: ComputerLinksShape["respondRequest"] = (input) =>
    linkRequests.respond(input);

  // A linked computer's session ended anywhere (Remove in the device list,
  // expiry): what it still had open here is cancelled.
  yield* sessions.streamChanges.pipe(
    Stream.runForEach((change) =>
      change.type === "clientRemoved"
        ? Effect.gen(function* () {
            const row = yield* devices.getDeviceBySession(change.sessionId);
            if (Option.isSome(row) && row.value.grant === "peer") {
              yield* linkRequests.dropLink(row.value.deviceId);
              yield* notify;
            }
          }).pipe(Effect.catchCause((cause) => Effect.logWarning("links.drop.failed", { cause })))
        : Effect.void,
    ),
    Effect.forkScoped,
  );

  return ComputerLinks.of({
    createInvite,
    accept,
    snapshot,
    changes,
    setAccess,
    remove,
    respondRequest,
  });
});

export const ComputerLinksLive = Layer.effect(ComputerLinks, make);
