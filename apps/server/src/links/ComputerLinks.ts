/**
 * ComputerLinks: what the `links.*` client methods do (docs/design/fleet.md,
 * "Links RPC for clients"). It makes this computer's single-use link invites,
 * accepts another computer's invite as that computer's `peer` device, lists
 * both directions with their live state, and changes or removes them.
 *
 * Removing an outbound link unlinks (Rev 4 "Unlink"): the other computer is
 * told (`peer.unlink`), and only once it has its half done is the link
 * deleted here. One it can't reach stays `unlinking`, unusable, and is told
 * again at startup and every minute until it hears.
 */
import {
  type AuthSessionId,
  type ComputerLinkAccess,
  ComputerLinkError,
  ComputerLinkId,
  type ComputerLinkInvite,
  type ComputerLinksSnapshot,
  EnvironmentId,
  type InboundComputerLink,
  type LinksCreateInviteInput,
  type LinksRemoveInput,
  type LinksRemoveResult,
  type LinksRespondRequestInput,
  type LinksSetAccessInput,
  type OutboundComputerLink,
  type PeerRpcError,
  type PeerUnlinkInput,
  type RelayAccessError,
} from "@threadlines/contracts";
import {
  cancelRelayRequest,
  claimRelayInvite,
  getRelayRequestStatus,
  RelayInviteInvalidError,
  RelayRequestError,
} from "@threadlines/shared/relayJoin";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
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
  type ComputerLinkUnavailableError,
} from "./ComputerLinkClient.ts";
import {
  ComputerLinkRepository,
  type ComputerLinkRow,
  isUsableLink,
} from "./ComputerLinkRepository.ts";
import { LinkRequests, PEER_LINK_REMOVED, peerLinkOf } from "./LinkRequests.ts";

const APPROVAL_WAIT_MS = 30_000;
const APPROVAL_POLL_MS = 500;
/** How often links still unlinking tell the other computer again. */
export const UNLINK_RETRY_EVERY = Duration.seconds(60);
/** How long a refused connection takes to mark its link revoked. */
const REFUSAL_SETTLE = Duration.millis(1_500);

/**
 * An unlink as the other computer hears it: it stops what this computer's
 * link started there and forgets its own link back to this one.
 */
const UNLINK: PeerUnlinkInput = { stopRunning: true, reverse: true };

/** Whether a failed peer.unlink means the link is already gone there. */
const goneThere = (error: PeerRpcError | ComputerLinkUnavailableError) =>
  error._tag === "ComputerLinkUnavailableError"
    ? error.revoked
    : error.detail === PEER_LINK_REMOVED;

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
  /** See LinksRemoveResult: a half the other computer didn't confirm is never reported done. */
  readonly remove: (input: LinksRemoveInput) => Effect.Effect<LinksRemoveResult, ComputerLinkError>;
  readonly respondRequest: (
    input: LinksRespondRequestInput,
  ) => Effect.Effect<void, ComputerLinkError>;
  /**
   * `peer.unlink` from a computer linked to this one: its link here ends
   * (stopping what it started with `stopRunning`), and with `reverseTo` this
   * computer's own link back is dropped once that computer refuses it.
   */
  readonly unlinkedByPeer: (input: {
    readonly deviceId: string;
    readonly sessionId: AuthSessionId;
    readonly stopRunning: boolean;
    readonly reverseTo: EnvironmentId | null;
  }) => Effect.Effect<void, ComputerLinkError>;
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
    // A revoked or unlinking link carries nothing, so it reads offline (an
    // unlink's last call to the other computer isn't the link working).
    const unusable = !isUsableLink(row);
    return {
      linkId: row.linkId,
      remoteEnvironmentId: row.remoteEnvironmentId,
      remoteLabel: row.remoteLabel,
      remotePlatform: row.remotePlatform,
      state: row.state,
      connection: unusable ? "offline" : (live?.connection ?? "idle"),
      route: unusable ? null : (live?.route ?? null),
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
      sessionId: row.sessionId,
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
      // One still unlinking is finished first if that computer hears it now;
      // if not, it stays (with its keys) for the retrier, which is the only
      // way what it started there gets stopped. The new link is the newest,
      // so it is the one in use meanwhile.
      for (const old of yield* repo.list.pipe(Effect.orElseSucceed(() => []))) {
        if (old.remoteEnvironmentId !== invite.environmentId) continue;
        if (old.state === "unlinking" && !(yield* tellUnlinked(old))) continue;
        yield* client.forget(old.linkId).pipe(Effect.ignore);
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

  /** Tells the other computer about an unlink; true once its half is done (now or before). */
  const tellUnlinked = (row: ComputerLinkRow) =>
    client.unlinkPeer(row.linkId, UNLINK).pipe(
      Effect.as(true),
      Effect.catch((error) => Effect.succeed(goneThere(error))),
    );

  /** Deletes a link here, its other half done. */
  const forgetLink = (linkId: ComputerLinkId) =>
    client.forget(linkId).pipe(
      Effect.mapError(() => linkError("The link couldn't be removed.")),
      Effect.andThen(notify),
    );

  const removeOutbound = (input: Extract<LinksRemoveInput, { readonly direction: "outbound" }>) =>
    Effect.gen(function* () {
      const row = yield* repo.get(input.linkId).pipe(
        Effect.mapError(() => linkError("This computer's links couldn't be read.")),
        Effect.flatMap((found) =>
          Option.isSome(found)
            ? Effect.succeed(found.value)
            : Effect.fail(linkError("That link is already gone.")),
        ),
      );
      // Nothing to tell when the app already removed the other halves, or
      // the other computer removed this link first.
      if (
        input.otherHalfRemoved === true ||
        row.state === "revoked" ||
        (yield* tellUnlinked(row))
      ) {
        yield* forgetLink(row.linkId);
        return { otherComputer: "confirmed" } as const;
      }
      // It couldn't be reached: the link is kept, unusable, until it hears.
      yield* repo
        .update({ linkId: row.linkId, state: "unlinking", onlyFrom: ["active", "failed"] })
        .pipe(Effect.mapError(() => linkError("The link couldn't be removed.")));
      const now = yield* repo
        .get(row.linkId)
        .pipe(Effect.mapError(() => linkError("This computer's links couldn't be read.")));
      // Refused meanwhile (marked revoked as its connection closed): done there.
      if (Option.isNone(now) || now.value.state === "revoked") {
        yield* forgetLink(row.linkId);
        return { otherComputer: "confirmed" } as const;
      }
      yield* client.disconnect(row.linkId);
      yield* notify;
      return { otherComputer: "pending" } as const;
    });

  /**
   * Ends another computer's link to this one. With `stopRunning` (an
   * unlink) its access is turned off first, so nothing new starts, then what
   * it started is cancelled and stopped, and only then does its session end;
   * a second pass after that catches work that got past the first. When
   * something couldn't be stopped it fails and the link stays, so the unlink
   * is tried again rather than reported done.
   */
  const removeInbound = (link: {
    readonly deviceId: string;
    readonly sessionId: AuthSessionId | null;
    readonly stopRunning: boolean;
  }) =>
    Effect.gen(function* () {
      if (link.stopRunning) {
        yield* devices
          .setLinkSettings({ deviceId: link.deviceId, access: "off", now: yield* nowIso })
          .pipe(Effect.mapError(() => linkError("The link couldn't be turned off.")));
      }
      yield* linkRequests.dropLink(link.deviceId, { stopRunning: link.stopRunning });
      // Revoking the session takes it off the relay and closes its connection.
      if (link.sessionId !== null) {
        yield* sessions.revoke(link.sessionId).pipe(Effect.ignore);
      }
      if (link.stopRunning) {
        yield* linkRequests
          .dropLink(link.deviceId, { stopRunning: true })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("links.unlink.second-pass-failed", { detail: error.detail }),
            ),
          );
      }
      yield* notify;
    });

  const remove: ComputerLinksShape["remove"] = (input) =>
    Effect.gen(function* () {
      if (input.direction === "outbound") return yield* removeOutbound(input);
      const row = yield* inboundRow(input.deviceId);
      yield* removeInbound({
        deviceId: row.deviceId,
        sessionId: row.sessionId,
        stopRunning: input.stopRunning === true,
      });
      return { otherComputer: "not_asked" } as const;
    });

  const respondRequest: ComputerLinksShape["respondRequest"] = (input) =>
    linkRequests.respond(input);

  /**
   * The other computer unlinked both ways: this computer drops its own link
   * back, but only once that computer itself refuses it. The name it went by
   * is its own claim, so a linked computer could name any other; asking the
   * named computer over this computer's own link (keys pinned when it was
   * made) means only that computer can end it. A link it can't settle now is
   * refused at its next use anyway.
   */
  const dropLinksBackTo = (environmentId: EnvironmentId) =>
    Effect.gen(function* () {
      const isBack = (row: ComputerLinkRow) =>
        row.remoteEnvironmentId === environmentId && row.state !== "unlinking";
      if (!(yield* repo.list).some(isBack)) return;
      const refused = yield* client.describe(environmentId, { fresh: true }).pipe(
        Effect.as(false),
        Effect.catch((error) =>
          Effect.succeed(
            error._tag === "ComputerLinkUnavailableError"
              ? error.revoked
              : error.detail === PEER_LINK_REMOVED,
          ),
        ),
      );
      // A refusal can also arrive as the connection's close code, which marks
      // the link revoked a moment after the call failed.
      if (!refused) yield* Effect.sleep(REFUSAL_SETTLE);
      for (const row of yield* repo.list) {
        if (!isBack(row) || (!refused && row.state !== "revoked")) continue;
        yield* forgetLink(row.linkId);
        yield* Effect.logInfo("links.unlinked-by-peer", { linkId: row.linkId });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("links.unlinked-by-peer.failed", { cause: Cause.pretty(cause) }),
      ),
    );

  const serviceScope = yield* Effect.scope;

  const unlinkedByPeer: ComputerLinksShape["unlinkedByPeer"] = (input) =>
    Effect.gen(function* () {
      yield* removeInbound({
        deviceId: input.deviceId,
        sessionId: input.sessionId,
        stopRunning: input.stopRunning,
      });
      if (input.reverseTo !== null) {
        yield* dropLinksBackTo(input.reverseTo).pipe(Effect.forkIn(serviceScope));
      }
    });

  // Links removed while the other computer couldn't be reached: it is told
  // at startup and every minute, and the link goes once it has heard (or
  // turns out to have dropped it already).
  yield* Effect.gen(function* () {
    for (const row of yield* repo.list) {
      if (row.state !== "unlinking") continue;
      if (yield* tellUnlinked(row)) {
        yield* forgetLink(row.linkId);
        yield* Effect.logInfo("links.unlink.finished", { linkId: row.linkId });
      }
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("links.unlink.retry-failed", { cause: Cause.pretty(cause) }),
    ),
    Effect.repeat(Schedule.spaced(UNLINK_RETRY_EVERY)),
    Effect.forkScoped,
  );

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
    unlinkedByPeer,
  });
});

export const ComputerLinksLive = Layer.effect(ComputerLinks, make);
