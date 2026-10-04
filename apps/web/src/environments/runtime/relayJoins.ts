import type {
  EnvironmentId,
  PersistedRelayLinkV2,
  RelayDeviceKind,
  RelayHostNonce,
  RelayRequestState,
} from "@threadlines/contracts";
import { EnvironmentId as EnvironmentIdSchema } from "@threadlines/contracts";
import { RELAY_RAW_CONTROL_PREFIX, RelayWatchEvent } from "@threadlines/contracts/relay";
import {
  claimProof,
  claimSecrets,
  decodePublicKey,
  fromBase64Url,
  generateStoredKeyPair,
  PAIRING_NONCE_BYTES,
  pairingCommitment,
  pairingMatchNumber,
  randomBytes,
  toBase64Url,
} from "@threadlines/shared/relaySecure";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import {
  cancelRelayRequest,
  configuredRelayOrigin,
  describeThisBrowser,
  generateRelaySecret,
  getRelayRequestStatus,
  postRelayCodeJoin,
  postRelayInviteClaim,
  postRelayReveal,
  type RelayInviteLink,
  relayDeviceSocketUrl,
  relayRequestWatchUrl,
  RelayRequestError,
  relaySecretHash,
} from "../../relayDevice";
import { relayWebSocketProtocols } from "../../relayTransport";
import {
  getSavedEnvironmentRecord,
  hasSavedEnvironmentRegistryHydrated,
  listSavedEnvironmentRecords,
  persistSavedEnvironmentRecord,
  removeSavedEnvironmentBearerToken,
  type SavedEnvironmentRecord,
  useSavedEnvironmentRegistryStore,
  waitForSavedEnvironmentRegistryHydration,
} from "./catalog";
import { readRelayDeviceCredentials, writeRelayDeviceCredentials } from "./relayCredentials";

/**
 * Joining side of "Connect a device". A join saves the computer straight away
 * as "waiting to be allowed" (a relay v2 record with `pendingRequest`, device
 * credentials in the secret store), so closing the app while the host decides
 * loses nothing: watchers resume on the next launch. When the host allows,
 * `pendingRequest` is dropped and the normal saved-environment sync connects.
 *
 * Code joins agree on a number before the host can allow: this device commits
 * to its key and a nonce, receives the computer's nonce and key, freezes them
 * in the record, then reveals its nonce. Both sides then show the same four
 * digits unless something in between changed what one of them saw. QR joins
 * take the computer's key straight from the QR code.
 */

export type RelayJoinOutcomeState = "waiting" | RelayRequestState | "failed";

export interface RelayJoinOutcome {
  readonly environmentId: EnvironmentId;
  readonly hostLabel: string;
  /** Code joins: set once both nonces are in. */
  readonly matchNumber?: string;
  readonly state: RelayJoinOutcomeState;
  readonly message?: string;
}

interface RelayJoinStore {
  readonly byEnvironmentId: Readonly<Record<string, RelayJoinOutcome>>;
  readonly set: (outcome: RelayJoinOutcome) => void;
  readonly dismiss: (environmentId: EnvironmentId) => void;
}

export const useRelayJoinStore = create<RelayJoinStore>()((set) => ({
  byEnvironmentId: {},
  set: (outcome) =>
    set((state) => ({
      byEnvironmentId: { ...state.byEnvironmentId, [outcome.environmentId]: outcome },
    })),
  dismiss: (environmentId) =>
    set((state) => {
      const next = { ...state.byEnvironmentId };
      delete next[environmentId];
      return { byEnvironmentId: next };
    }),
}));

/** The join result every path ends with, whoever sent it to the relay. */
export interface RelayJoinAccepted {
  readonly relayOrigin: string;
  readonly hostId: string;
  readonly hostEnvironmentId: string;
  readonly requestId: string;
  readonly deviceId: string;
  readonly hostLabel: string;
  readonly expiresAt: string;
}

/**
 * Sends a code join through this client's own server (desktop app, self-hosted
 * web). Implementations throw {@link RelayJoinError} with the relay's code.
 */
export type SubmitCodeJoinViaServer = (input: {
  readonly joinId: string;
  readonly code: string;
  readonly deviceSecretHash: string;
  readonly requestSecretHash: string;
  readonly devicePublicKey: string;
  readonly commitment: string;
  readonly kind: RelayDeviceKind;
}) => Promise<RelayJoinAccepted>;

export class RelayJoinError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null) {
    super(message);
    this.code = code;
  }
}

/** End-to-end encryption needs WebCrypto, which browsers only offer on secure pages. */
export function canJoinWithCode(): boolean {
  return globalThis.isSecureContext !== false && globalThis.crypto?.subtle !== undefined;
}

function relayLink(record: SavedEnvironmentRecord): PersistedRelayLinkV2 | null {
  const relay = record.relay;
  return relay && "version" in relay && relay.version === 2 ? relay : null;
}

/** True for computers saved by "Connect a device" that the host hasn't allowed yet. */
export function isPendingRelayJoin(record: SavedEnvironmentRecord): boolean {
  return relayLink(record)?.pendingRequest !== undefined;
}

/**
 * Saves the joined computer as pending. `replaceExisting` runs first when this
 * computer is already saved (for example over a same-network link), so the
 * new connection replaces the old one instead of fighting it.
 */
async function savePendingJoin(input: {
  readonly accepted: RelayJoinAccepted;
  readonly credentials: Parameters<typeof writeRelayDeviceCredentials>[1];
  readonly requestSecret: string;
  /** Code joins: this device's nonce, kept until the computer's arrives. */
  readonly deviceNonce?: string;
  /** QR joins: the computer's key from the QR code. */
  readonly hostPublicKey?: string;
  readonly replaceExisting: (environmentId: EnvironmentId) => Promise<void>;
  readonly selfEnvironmentId?: EnvironmentId | null;
}): Promise<EnvironmentId> {
  const { accepted } = input;
  const environmentId = EnvironmentIdSchema.make(accepted.hostEnvironmentId);
  if (input.selfEnvironmentId && environmentId === input.selfEnvironmentId) {
    // Typed this computer's own code: withdraw the request so the host's
    // dialog doesn't wait for an Allow that would make no sense.
    await cancelRelayRequest({
      relayOrigin: accepted.relayOrigin,
      hostId: accepted.hostId,
      requestId: accepted.requestId,
      requestSecret: input.requestSecret,
    }).catch(() => undefined);
    throw new RelayJoinError(
      "That code is for this computer. Type it on the other device instead.",
      "invalid-code",
    );
  }
  // The QR join page doesn't load the saved list at startup; the check below needs it.
  await waitForSavedEnvironmentRegistryHydration();
  if (getSavedEnvironmentRecord(environmentId)) {
    await input.replaceExisting(environmentId);
  }
  const relayHttpBase = `${new URL(accepted.relayOrigin).origin}/`;
  const record: SavedEnvironmentRecord = {
    environmentId,
    label: accepted.hostLabel,
    wsBaseUrl: relayDeviceSocketUrl(accepted),
    httpBaseUrl: relayHttpBase,
    createdAt: new Date().toISOString(),
    lastConnectedAt: null,
    relay: {
      version: 2,
      relayOrigin: accepted.relayOrigin,
      hostId: accepted.hostId,
      deviceId: accepted.deviceId,
      ...(input.hostPublicKey ? { hostPublicKey: input.hostPublicKey } : {}),
      pendingRequest: {
        requestId: accepted.requestId,
        requestSecret: input.requestSecret,
        expiresAt: accepted.expiresAt,
        ...(input.deviceNonce ? { deviceNonce: input.deviceNonce } : {}),
      },
    },
  };
  await persistSavedEnvironmentRecord(record);
  if (!(await writeRelayDeviceCredentials(environmentId, input.credentials))) {
    throw new RelayJoinError("This device couldn't store its key.", null);
  }
  useSavedEnvironmentRegistryStore.getState().upsert(record);
  useRelayJoinStore.getState().set({
    environmentId,
    hostLabel: accepted.hostLabel,
    state: "waiting",
  });
  watchPendingJoin(environmentId);
  return environmentId;
}

function isUnreachable(error: unknown): boolean {
  return (
    (error instanceof RelayRequestError && error.status === null) ||
    (error instanceof RelayJoinError && error.code === "relay-unavailable")
  );
}

/**
 * Retries a join once with the same ids when the relay couldn't be reached:
 * if the first attempt did land, the relay returns that same request instead
 * of answering "busy".
 */
async function withReplay<A>(send: () => Promise<A>): Promise<A> {
  try {
    return await send();
  } catch (error) {
    if (!isUnreachable(error)) throw error;
    return await send();
  }
}

export async function startCodeJoin(input: {
  readonly code: string;
  readonly viaServer: SubmitCodeJoinViaServer | null;
  readonly replaceExisting: (environmentId: EnvironmentId) => Promise<void>;
  /** This client's own computer, which must not join itself. */
  readonly selfEnvironmentId?: EnvironmentId | null;
}): Promise<EnvironmentId> {
  const code = input.code.replace(/\D/gu, "");
  if (code.length !== 6) {
    throw new RelayJoinError("Codes are 6 digits.", "invalid-code");
  }
  if (!canJoinWithCode()) {
    throw new RelayJoinError(
      "This page can't encrypt the connection. Open Threadlines from this computer's own app, or use Other ways to connect.",
      "insecure-context",
    );
  }
  const joinId = crypto.randomUUID();
  const deviceSecret = generateRelaySecret();
  const requestSecret = generateRelaySecret();
  const deviceSecretHash = await relaySecretHash(deviceSecret);
  const requestSecretHash = await relaySecretHash(requestSecret);
  const deviceKey = await generateStoredKeyPair();
  const deviceNonce = randomBytes(PAIRING_NONCE_BYTES);
  const commitment = await pairingCommitment(fromBase64Url(deviceKey.publicKey)!, deviceNonce);
  const viaServer = input.viaServer;
  const accepted = await withReplay<RelayJoinAccepted>(async () => {
    if (viaServer) {
      return viaServer({
        joinId,
        code,
        deviceSecretHash,
        requestSecretHash,
        devicePublicKey: deviceKey.publicKey,
        commitment,
        kind: "computer",
      });
    }
    const relayOrigin = configuredRelayOrigin();
    const result = await postRelayCodeJoin(relayOrigin, {
      joinId,
      code,
      deviceSecretHash,
      requestSecretHash,
      devicePublicKey: deviceKey.publicKey,
      commitment,
      joiner: describeThisBrowser(),
    });
    return { ...result, relayOrigin };
  });
  return savePendingJoin({
    accepted,
    credentials: { deviceSecret, deviceKey },
    requestSecret,
    deviceNonce: toBase64Url(deviceNonce),
    replaceExisting: input.replaceExisting,
    selfEnvironmentId: input.selfEnvironmentId ?? null,
  });
}

/** QR / link join. The host approves these on its own, so the wait is short. */
export async function startInviteClaim(input: {
  readonly invite: RelayInviteLink;
  readonly replaceExisting: (environmentId: EnvironmentId) => Promise<void>;
}): Promise<EnvironmentId> {
  const inviteSecret = fromBase64Url(input.invite.inviteSecret);
  const hostKey = await decodePublicKey(input.invite.hostPublicKey);
  if (!inviteSecret || !hostKey) {
    throw new RelayJoinError("That link is incomplete. Scan the code again.", "invalid-invite");
  }
  const joinId = crypto.randomUUID();
  const deviceSecret = generateRelaySecret();
  const requestSecret = generateRelaySecret();
  const deviceSecretHash = await relaySecretHash(deviceSecret);
  const requestSecretHash = await relaySecretHash(requestSecret);
  const deviceKey = await generateStoredKeyPair();
  const { claimToken, macKey } = await claimSecrets(inviteSecret);
  const proof = await claimProof({
    macKey,
    inviteId: input.invite.inviteId,
    joinId,
    devicePublicKey: fromBase64Url(deviceKey.publicKey)!,
  });
  const result = await withReplay(() =>
    postRelayInviteClaim(input.invite, {
      joinId,
      deviceSecretHash,
      requestSecretHash,
      devicePublicKey: deviceKey.publicKey,
      claimToken,
      claimProof: proof,
      joiner: describeThisBrowser(),
    }),
  );
  return savePendingJoin({
    accepted: { ...result, relayOrigin: input.invite.relayOrigin },
    credentials: { deviceSecret, deviceKey },
    requestSecret,
    hostPublicKey: input.invite.hostPublicKey,
    replaceExisting: input.replaceExisting,
  });
}

/** Gives up on a pending join: tells the relay (so the host's dialog updates) and forgets it. */
export async function cancelPendingRelayJoin(environmentId: EnvironmentId): Promise<void> {
  const record = getSavedEnvironmentRecord(environmentId);
  const link = record ? relayLink(record) : null;
  const pending = link?.pendingRequest;
  if (link && pending) {
    await cancelRelayRequest({
      relayOrigin: link.relayOrigin,
      hostId: link.hostId,
      requestId: pending.requestId,
      requestSecret: pending.requestSecret,
    }).catch(() => undefined);
  }
  stopWatching(environmentId);
  await forgetPendingRecord(environmentId);
  useRelayJoinStore.getState().dismiss(environmentId);
}

async function forgetPendingRecord(environmentId: EnvironmentId): Promise<void> {
  const record = getSavedEnvironmentRecord(environmentId);
  if (!record || !isPendingRelayJoin(record)) return;
  useSavedEnvironmentRegistryStore.getState().remove(environmentId);
  await removeSavedEnvironmentBearerToken(environmentId);
}

// ----- watchers ------------------------------------------------------------------

const decodeWatchEvent = Schema.decodeUnknownOption(Schema.fromJsonString(RelayWatchEvent));
const POLL_INTERVAL_MS = 3_000;
const watchers = new Map<string, () => void>();

function stopWatching(environmentId: EnvironmentId): void {
  watchers.get(environmentId)?.();
  watchers.delete(environmentId);
}

async function settle(
  environmentId: EnvironmentId,
  state: RelayRequestState | "failed",
  message?: string,
): Promise<void> {
  if (state === "pending") return;
  const record = getSavedEnvironmentRecord(environmentId);
  const link = record ? relayLink(record) : null;
  if (!record || !link?.pendingRequest) return;
  stopWatching(environmentId);
  const pending = link.pendingRequest;
  // An allowed join without the computer's key (or, for codes, without a
  // number both sides saw) can't be connected safely.
  const usable =
    state === "approved" &&
    link.hostPublicKey !== undefined &&
    (pending.deviceNonce === undefined || pending.matchNumber !== undefined);
  const finalState = state === "approved" && !usable ? "failed" : state;
  const outcome: RelayJoinOutcome = {
    environmentId,
    hostLabel: record.label,
    ...(pending.matchNumber ? { matchNumber: pending.matchNumber } : {}),
    state: finalState,
    ...(finalState === "failed"
      ? { message: message ?? "This device couldn't confirm it reached the right computer." }
      : {}),
  };
  if (finalState === "approved") {
    const { pendingRequest: _done, ...activeLink } = link;
    const activeRecord: SavedEnvironmentRecord = { ...record, relay: activeLink };
    try {
      await persistSavedEnvironmentRecord(activeRecord);
    } catch {
      // Still pending on disk: keep following it so the save is retried.
      setTimeout(() => watchPendingJoin(environmentId), POLL_INTERVAL_MS);
      return;
    }
    // The registry change wakes the saved-environment sync, which connects.
    useSavedEnvironmentRegistryStore.getState().upsert(activeRecord);
  } else {
    if (finalState === "failed") {
      await cancelRelayRequest({
        relayOrigin: link.relayOrigin,
        hostId: link.hostId,
        requestId: pending.requestId,
        requestSecret: pending.requestSecret,
      }).catch(() => undefined);
    }
    await forgetPendingRecord(environmentId);
  }
  useRelayJoinStore.getState().set(outcome);
}

/**
 * The computer's half of a code join's number. The first one seen is frozen
 * in the record before this device reveals its own nonce; a different one
 * later (a relay changing its story) ends the join.
 */
async function receiveHostNonce(
  environmentId: EnvironmentId,
  received: RelayHostNonce,
): Promise<"reveal" | "done" | "aborted"> {
  const record = getSavedEnvironmentRecord(environmentId);
  const link = record ? relayLink(record) : null;
  const pending = link?.pendingRequest;
  if (!record || !link || !pending?.deviceNonce) return "done";
  if (pending.hostNonce !== undefined) {
    if (pending.hostNonce !== received.hostNonce || link.hostPublicKey !== received.hostPublicKey) {
      await settle(
        environmentId,
        "failed",
        "The computer's answer changed partway. Try a new code.",
      );
      return "aborted";
    }
    return "reveal";
  }
  const hostPublicKey = await decodePublicKey(received.hostPublicKey);
  const hostNonce = fromBase64Url(received.hostNonce);
  const deviceNonce = fromBase64Url(pending.deviceNonce);
  const credentials = await readRelayDeviceCredentials(environmentId);
  const devicePublicKey = credentials ? fromBase64Url(credentials.deviceKey.publicKey) : null;
  if (
    !hostPublicKey ||
    !hostNonce ||
    hostNonce.length !== PAIRING_NONCE_BYTES ||
    !deviceNonce ||
    !devicePublicKey
  ) {
    await settle(
      environmentId,
      "failed",
      "The computer's answer didn't make sense. Try a new code.",
    );
    return "aborted";
  }
  const matchNumber = await pairingMatchNumber({
    hostPublicKey,
    devicePublicKey,
    hostNonce,
    deviceNonce,
  });
  const frozen: SavedEnvironmentRecord = {
    ...record,
    relay: {
      ...link,
      hostPublicKey: received.hostPublicKey,
      pendingRequest: { ...pending, hostNonce: received.hostNonce, matchNumber },
    },
  };
  await persistSavedEnvironmentRecord(frozen);
  useSavedEnvironmentRegistryStore.getState().upsert(frozen);
  useRelayJoinStore.getState().set({
    environmentId,
    hostLabel: record.label,
    matchNumber,
    state: "waiting",
  });
  return "reveal";
}

/**
 * Follows one pending join: a watch socket for instant answers, falling back
 * to polling if the socket can't stay up. Idempotent per computer.
 */
export function watchPendingJoin(environmentId: EnvironmentId): void {
  if (watchers.has(environmentId)) return;
  const record = getSavedEnvironmentRecord(environmentId);
  const link = record ? relayLink(record) : null;
  const pending = link?.pendingRequest;
  if (!record || !link || !pending) return;

  let stopped = false;
  let revealed = false;
  let socket: WebSocket | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const target = {
    relayOrigin: link.relayOrigin,
    hostId: link.hostId,
    requestId: pending.requestId,
  };

  // One at a time: two nonce events racing each other must not both pass the
  // "nothing frozen yet" check and overwrite each other.
  let nonceQueue: Promise<void> = Promise.resolve();
  const onHostNonce = (received: RelayHostNonce): Promise<void> => {
    nonceQueue = nonceQueue.then(async () => {
      if (stopped) return;
      // A failed save must not jam the queue, and with the watch socket still
      // open no new event may come: fall back to polling, which retries it.
      const next = await receiveHostNonce(environmentId, received).catch(() => {
        if (!stopped && pollTimer === null) {
          pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        }
        return "done" as const;
      });
      if (next !== "reveal" || revealed || !pending.deviceNonce) return;
      try {
        await postRelayReveal({
          ...target,
          requestSecret: pending.requestSecret,
          deviceNonce: pending.deviceNonce,
        });
        revealed = true;
      } catch {
        // With the watch socket still open no new event may come; polling
        // re-reads the status and tries the reveal again.
        if (!stopped && pollTimer === null) {
          pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        }
      }
    });
    return nonceQueue;
  };

  const poll = async () => {
    if (stopped) return;
    try {
      const status = await getRelayRequestStatus({
        ...target,
        requestSecret: pending.requestSecret,
      });
      if (status.state !== "pending") {
        await settle(environmentId, status.state);
        return;
      }
      if (status.hostNonce) await onHostNonce(status.hostNonce);
    } catch (error) {
      if ((error as { status?: unknown }).status === 403) {
        // The relay no longer knows this request: treat it as expired.
        await settle(environmentId, "expired");
        return;
      }
    }
    if (Date.parse(pending.expiresAt) + 60_000 < Date.now()) {
      await settle(environmentId, "expired");
      return;
    }
    if (!stopped) pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
  };

  try {
    socket = new WebSocket(relayRequestWatchUrl(target), [
      ...relayWebSocketProtocols(pending.requestSecret),
    ]);
    socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      const decoded = decodeWatchEvent(event.data.replace(RELAY_RAW_CONTROL_PREFIX, ""));
      if (Option.isNone(decoded)) return;
      if (decoded.value.type === "request.state") {
        void settle(environmentId, decoded.value.state);
      } else {
        void onHostNonce(decoded.value.hostNonce);
      }
    });
    socket.addEventListener("close", () => {
      if (!stopped) void poll();
    });
  } catch {
    void poll();
  }

  watchers.set(environmentId, () => {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    socket?.close();
  });
}

/** Resumes watchers for joins still waiting from a previous run. Returns a stop function. */
export function startRelayJoinWatchers(): () => void {
  const watchAll = () => {
    for (const record of listSavedEnvironmentRecords()) {
      if (isPendingRelayJoin(record)) {
        const link = relayLink(record)!;
        if (!useRelayJoinStore.getState().byEnvironmentId[record.environmentId]) {
          const matchNumber = link.pendingRequest!.matchNumber;
          useRelayJoinStore.getState().set({
            environmentId: record.environmentId,
            hostLabel: record.label,
            ...(matchNumber ? { matchNumber } : {}),
            state: "waiting",
          });
        }
        watchPendingJoin(record.environmentId);
      }
    }
  };
  let cancelled = false;
  if (hasSavedEnvironmentRegistryHydrated()) {
    watchAll();
  } else {
    void waitForSavedEnvironmentRegistryHydration().then(() => {
      if (!cancelled) watchAll();
    });
  }
  return () => {
    cancelled = true;
    for (const environmentId of watchers.keys()) {
      stopWatching(environmentId as EnvironmentId);
    }
  };
}
