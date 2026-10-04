import {
  type AuthClientMetadataDeviceType,
  type AuthSessionId,
  RELAY_CLOSE_CODE_REPLACED,
  RELAY_DEVICE_SESSION_SUBJECT,
  RELAY_INVITE_TTL_SECONDS,
  RELAY_HEARTBEAT_PING_FRAME,
  RELAY_HEARTBEAT_PONG_FRAME,
  RELAY_TOKEN_PROTOCOL_PREFIX,
  RELAY_WEBSOCKET_PROTOCOL,
  RelayAccessError,
  type RelayAccessSnapshot,
  RelayControlEvent,
  type RelayHostJoinRequest,
  type RelayHostStatus,
  type RelayInviteId,
  type RelayJoinRequest,
  type RelayOpenInvite,
  type RelayRespondToJoinRequestInput,
  type RelayRespondToJoinRequestResult,
  type RelaySubmitJoinInput,
  type RelaySubmitJoinResult,
  type RelayUsageToday,
} from "@threadlines/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  type Bytes,
  claimSecrets,
  decodePublicKey,
  fromBase64Url,
  generateStoredKeyPair,
  loadStoredKeyPair,
  type NoiseKeyPair,
  PAIRING_NONCE_BYTES,
  pairingCommitment,
  pairingMatchNumber,
  randomBytes,
  sha256,
  type StoredKeyPair,
  toBase64Url,
  utf8,
  verifyClaimProof,
} from "@threadlines/shared/relaySecure";
import { resolveTailscaleHttpsBaseUrl } from "@threadlines/tailscale";

import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { DESKTOP_BOOTSTRAP_SUBJECT } from "../auth/utils.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import {
  DEFAULT_RELAY_URL,
  RelayApiError,
  relayApi,
  relayOriginFrom,
  relaySocketUrl,
} from "./relayApi.ts";
import {
  RelayDeviceRepository,
  type RelayDeviceRow,
  type RelayPairingRow,
} from "./RelayDeviceRepository.ts";
import { computeDirectRoutes } from "./directRoutes.ts";
import { openLoopbackSocket, openRelayPipeSocket } from "./relayPipe.ts";
import { openSecurePipe, type SecureDuplex, type SecurePipeHandle } from "./securePipe.ts";

/** Sessions issued to relay devices carry this subject, so device lists can tell them apart. */
export const RELAY_DEVICE_SUBJECT = RELAY_DEVICE_SESSION_SUBJECT;
/** Relay devices keep access while used; one idle this long must pair again. */
export const RELAY_DEVICE_SESSION_TTL = Duration.days(90);

const HOST_SECRET_NAME = "relay-host-secret";
const HOST_KEY_NAME = "relay-host-e2e-key";
const PAIRING_RETENTION_MS = 60 * 60_000;
/** Matches the relay's own revocation tombstones. */
const REVOKED_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** How long after its invite expires a join on it may still be decided (the relay's request lifetime). */
const JOIN_GRACE_MS = 5 * 60_000;
const TAILSCALE_CACHE_MS = 5 * 60_000;
const RELAY_HANDSHAKE_TIMEOUT_MS = 15_000;
const DIRECT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DIRECT_MAX_PENDING = 32;
const DIRECT_MAX_PENDING_PER_ADDRESS = 4;
const LEASE_INTERVAL_MS = 60_000;
const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 45_000;
const SESSION_REFRESH_INTERVAL_MS = 6 * 60 * 60_000;
const TERMINAL_REQUEST_LINGER_MS = 60_000;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;

export interface RelayHostShape {
  /** Owner-facing state: open code, live requests, today's allowance. Current value first. */
  readonly snapshots: Stream.Stream<RelayAccessSnapshot>;
  readonly createInvite: Effect.Effect<RelayOpenInvite, RelayAccessError>;
  readonly cancelInvite: (inviteId: RelayInviteId) => Effect.Effect<void, RelayAccessError>;
  readonly respondToJoinRequest: (
    input: RelayRespondToJoinRequestInput,
  ) => Effect.Effect<RelayRespondToJoinRequestResult, RelayAccessError>;
  /** Joiner side: forwards a code join to the relay, describing this computer. */
  readonly submitJoin: (
    input: RelaySubmitJoinInput,
  ) => Effect.Effect<RelaySubmitJoinResult, RelayAccessError>;
  /** Starts the relay link once the HTTP server listens on `localOrigin`. Stops with the layer. */
  readonly start: (localOrigin: string) => Effect.Effect<void>;
  /**
   * Admits one unauthenticated direct connection from `remoteAddress`, or
   * returns null when too many are still handshaking. Release when done.
   */
  readonly admitDirect: (remoteAddress: string | null) => DirectAdmission | null;
  /** Serves a direct connection from a device; null when it can't connect. */
  readonly acceptDirect: (input: {
    readonly deviceId: string;
    readonly duplex: SecureDuplex;
    readonly admission: DirectAdmission;
  }) => Effect.Effect<SecurePipeHandle | null>;
  /** Where the device signed in as `sessionId` can reach this server directly; empty for others. */
  readonly directRoutes: (sessionId: AuthSessionId) => Effect.Effect<ReadonlyArray<string>>;
}

export interface DirectAdmission {
  readonly release: () => void;
}

export class RelayHost extends Context.Service<RelayHost, RelayHostShape>()(
  "threadlines/relay/RelayHost",
) {}

const decodeControlEvent = Schema.decodeUnknownOption(Schema.fromJsonString(RelayControlEvent));
const StoredKeyPairJson = Schema.fromJsonString(
  Schema.Struct({ privateKey: Schema.String, publicKey: Schema.String }),
);
const decodeStoredKeyPair = Schema.decodeUnknownOption(StoredKeyPairJson);
const encodeStoredKeyPair = Schema.encodeSync(StoredKeyPairJson);

function deviceTypeFor(kind: string): AuthClientMetadataDeviceType {
  if (kind === "phone") return "mobile";
  if (kind === "tablet") return "tablet";
  if (kind === "computer") return "desktop";
  return "unknown";
}

function platformName(os: string): string {
  switch (os) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return os;
  }
}

function toAccessError(error: unknown, fallback: string): RelayAccessError {
  if (error instanceof RelayAccessError) return error;
  if (error instanceof RelayApiError) {
    const code = error.code;
    return new RelayAccessError({
      detail: error.detail,
      ...(code === "invalid-code" ||
      code === "invalid-invite" ||
      code === "expired" ||
      code === "busy" ||
      code === "too-many-devices" ||
      code === "rate-limited"
        ? { code }
        : error.status === null || (error.status ?? 0) >= 500
          ? { code: "relay-unavailable" as const }
          : {}),
    });
  }
  return new RelayAccessError({ detail: fallback });
}

const make = Effect.gen(function* () {
  const repo = yield* RelayDeviceRepository;
  const sessions = yield* SessionCredentialService;
  const secrets = yield* ServerSecretStore;
  const environment = yield* ServerEnvironment;
  const config = yield* ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const relayUrl = yield* Config.string("THREADLINES_RELAY_URL").pipe(
    Config.withDefault(DEFAULT_RELAY_URL),
  );
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const runFork = Effect.runForkWith(context);

  let relayOrigin: string | null;
  try {
    relayOrigin = relayOriginFrom(relayUrl);
  } catch {
    relayOrigin = null;
  }

  const descriptor = yield* environment.getDescriptor;
  const hostLabel = descriptor.label;

  // ----- state ---------------------------------------------------------------

  let localOrigin: string | null = null;
  let status: RelayHostStatus = relayOrigin ? "idle" : "disabled";
  let statusError: string | undefined = relayOrigin ? undefined : "The relay address is not valid.";
  let invite: RelayOpenInvite | null = null;
  let inviteTimer: ReturnType<typeof setTimeout> | null = null;
  const requests = new Map<string, RelayHostJoinRequest>();
  const requestTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let usage: RelayUsageToday | null = null;
  let credentials: { readonly hostId: string; readonly hostSecret: string } | null = null;
  let control: WebSocket | null = null;
  let controlTimers: Array<ReturnType<typeof setInterval>> = [];
  let lastPongAt = 0;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Relay pipes by pipe id, direct connections by `direct:<n>`. */
  const pipes = new Map<
    string,
    {
      readonly deviceId: string;
      readonly sessionId: AuthSessionId;
      readonly handle: SecurePipeHandle;
    }
  >();
  let directCounter = 0;
  let pendingDirect = 0;
  const pendingDirectByAddress = new Map<string, number>();
  /** Numbers to compare, by request, once the server checked the joiner's commitment. */
  const matchNumbers = new Map<string, string>();
  /**
   * Invites this server made: the QR claim-proof key (never sent to the
   * relay), which request claimed it, and whether that claim was approved.
   * Joins on any other invite id (made up by a relay, or from before a
   * restart) are refused. Lost on restart, by design.
   */
  const localInvites = new Map<
    string,
    {
      readonly macKey: Bytes;
      readonly expiresAt: number;
      claimedBy: string | null;
      approved: boolean;
    }
  >();
  const pairingLock = yield* Semaphore.make(1);
  const hostKeyLock = yield* Semaphore.make(1);
  let hostKeyCache: { readonly stored: StoredKeyPair; readonly pair: NoiseKeyPair } | null = null;
  let tailscaleCache: { readonly value: string | null; readonly at: number } | null = null;

  const snapshotRef = yield* SubscriptionRef.make<RelayAccessSnapshot>(buildSnapshot());

  function buildSnapshot(): RelayAccessSnapshot {
    return {
      status,
      ...(statusError ? { error: statusError } : {}),
      hostLabel,
      invite,
      requests: [...requests.values()],
      usage,
    };
  }

  function publish(): void {
    runFork(SubscriptionRef.set(snapshotRef, buildSnapshot()));
  }

  function setStatus(next: RelayHostStatus, error?: string): void {
    status = next;
    statusError = error;
    publish();
  }

  const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());

  /** This server's end-to-end key, made once and kept in the secret store. */
  const hostKey = hostKeyLock
    .withPermits(1)(
      Effect.gen(function* () {
        if (hostKeyCache) return hostKeyCache;
        const existing = yield* secrets.get(HOST_KEY_NAME);
        let stored = existing
          ? Option.getOrNull(decodeStoredKeyPair(new TextDecoder().decode(existing)))
          : null;
        if (!stored) {
          stored = yield* Effect.promise(() => generateStoredKeyPair());
          yield* secrets.set(HOST_KEY_NAME, utf8(encodeStoredKeyPair(stored)));
        }
        const keyPair = stored;
        const pair = yield* Effect.tryPromise(() => loadStoredKeyPair(keyPair));
        hostKeyCache = { stored: keyPair, pair };
        return hostKeyCache;
      }),
    )
    .pipe(
      Effect.mapError(
        () =>
          new RelayAccessError({ detail: "This computer's encryption key couldn't be loaded." }),
      ),
    );

  // ----- registration ----------------------------------------------------------

  const loadCredentials = Effect.gen(function* () {
    if (credentials) return credentials;
    if (!relayOrigin) {
      return yield* new RelayAccessError({
        detail: "Device codes are off: the relay address is not valid.",
      });
    }
    const stored = yield* repo.getHost;
    const secretBytes = yield* secrets.get(HOST_SECRET_NAME);
    if (Option.isSome(stored) && stored.value.relayOrigin === relayOrigin && secretBytes) {
      credentials = {
        hostId: stored.value.hostId,
        hostSecret: new TextDecoder().decode(secretBytes),
      };
      return credentials;
    }
    return null;
  });

  const ensureRegistered = Effect.gen(function* () {
    const existing = yield* loadCredentials;
    if (existing) return existing;
    const origin = relayOrigin!;
    const registered = yield* relayApi
      .registerHost(origin, {
        label: hostLabel,
        environmentId: descriptor.environmentId,
      })
      .pipe(
        Effect.mapError((error) => {
          if (error.status !== 404) return error;
          setStatus("unsupported", "This relay doesn't support device codes yet.");
          return new RelayAccessError({ detail: "This relay doesn't support device codes yet." });
        }),
      );
    yield* secrets.set(HOST_SECRET_NAME, new TextEncoder().encode(registered.hostSecret));
    yield* repo.saveHost({ hostId: registered.hostId, relayOrigin: origin, createdAt: nowIso() });
    credentials = { hostId: registered.hostId, hostSecret: registered.hostSecret };
    return credentials;
  });

  // ----- control socket -----------------------------------------------------------

  const hasRelayWork = Effect.gen(function* () {
    if (invite || [...requests.values()].some((request) => request.state === "pending"))
      return true;
    const devices = yield* repo.listDevices;
    return devices.some((device) => device.state !== "revoked");
  });

  function clearControlTimers(): void {
    for (const timer of controlTimers) clearInterval(timer);
    controlTimers = [];
  }

  function dropControl(reason: string): void {
    clearControlTimers();
    const socket = control;
    control = null;
    if (socket && socket.readyState <= WebSocket.OPEN) {
      try {
        socket.close(1000, reason);
      } catch {
        // Already closing.
      }
    }
  }

  function scheduleReconnect(): void {
    if (reconnectTimer) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void runPromise(ensureControl).catch(() => undefined);
    }, delay);
  }

  function sendControl(message: unknown): void {
    if (control && control.readyState === WebSocket.OPEN) {
      control.send(JSON.stringify(message));
    }
  }

  /** Opens the control socket if there is anything for it to do. */
  const ensureControl: Effect.Effect<void> = Effect.gen(function* () {
    if (!localOrigin || !relayOrigin) return;
    if (control && control.readyState <= WebSocket.OPEN) return;
    if (!(yield* hasRelayWork)) {
      if (status !== "unsupported") setStatus("idle");
      return;
    }
    const creds = yield* loadCredentials;
    if (!creds) return;

    setStatus("connecting");
    const socket = new WebSocket(relaySocketUrl(relayOrigin, `/v2/hosts/${creds.hostId}/control`), [
      RELAY_WEBSOCKET_PROTOCOL,
      `${RELAY_TOKEN_PROTOCOL_PREFIX}${creds.hostSecret}`,
    ]);
    control = socket;

    socket.addEventListener("open", () => {
      if (control !== socket) return;
      reconnectAttempt = 0;
      lastPongAt = Date.now();
      setStatus("online");
      sendControl({ type: "lease", hostLabel });
      controlTimers.push(
        setInterval(() => sendControl({ type: "lease", hostLabel }), LEASE_INTERVAL_MS),
        setInterval(() => {
          if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
            // The network went quiet without a close: start over.
            dropControl("Relay heartbeat timed out.");
            setStatus("offline", "Lost the connection to the relay. Reconnecting.");
            scheduleReconnect();
            return;
          }
          if (control === socket && socket.readyState === WebSocket.OPEN) {
            socket.send(RELAY_HEARTBEAT_PING_FRAME);
          }
        }, PING_INTERVAL_MS),
      );
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (control !== socket || typeof event.data !== "string") return;
      if (event.data === RELAY_HEARTBEAT_PONG_FRAME) {
        lastPongAt = Date.now();
        return;
      }
      lastPongAt = Date.now();
      const decoded = decodeControlEvent(event.data);
      if (Option.isSome(decoded)) {
        void runPromise(handleControlEvent(decoded.value)).catch((error) => {
          void runPromise(
            Effect.logWarning("relay.control.event-failed", { error: String(error) }),
          );
        });
      }
    });
    const onGone = (event?: CloseEvent) => {
      if (control !== socket) return;
      clearControlTimers();
      control = null;
      if (event?.code === RELAY_CLOSE_CODE_REPLACED) {
        // Another process registered as this host took over; don't fight it.
        setStatus("offline", "Another Threadlines on this computer took over the relay link.");
        return;
      }
      if (event?.code === 1008 || event?.code === 4404) {
        setStatus("offline", "The relay no longer knows this computer.");
      } else {
        setStatus("offline", "Lost the connection to the relay. Reconnecting.");
      }
      scheduleReconnect();
    };
    socket.addEventListener("close", (event) => onGone(event));
    socket.addEventListener("error", () => onGone());
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("relay.control.connect-failed", { cause });
        if (status !== "unsupported") {
          setStatus("offline", "Couldn't reach the relay. Retrying.");
          scheduleReconnect();
        }
      }),
    ),
  );

  // ----- control events ------------------------------------------------------------

  function trackRequest(request: RelayJoinRequest): void {
    requests.set(request.requestId, {
      requestId: request.requestId,
      inviteId: request.inviteId,
      deviceId: request.deviceId,
      joiner: request.joiner,
      ...(matchNumbers.has(request.requestId)
        ? { matchNumber: matchNumbers.get(request.requestId)! }
        : {}),
      autoApprove: request.autoApprove,
      state: request.state,
      expiresAt: request.expiresAt,
    });
    const existing = requestTimers.get(request.requestId);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, Date.parse(request.expiresAt) - Date.now()) + 1_000;
    requestTimers.set(
      request.requestId,
      setTimeout(() => settleRequest(request.requestId, "expired"), delay),
    );
  }

  /** Records a terminal request state and drops it from the UI a little later. */
  function settleRequest(requestId: string, state: RelayHostJoinRequest["state"]): void {
    const current = requests.get(requestId);
    if (!current) return;
    const timer = requestTimers.get(requestId);
    if (timer) clearTimeout(timer);
    if (current.state === "pending" || current.state !== state) {
      requests.set(requestId, { ...current, state });
    }
    if (state === "approved" && invite?.inviteId === current.inviteId) {
      clearInvite();
    }
    requestTimers.set(
      requestId,
      setTimeout(() => {
        requests.delete(requestId);
        requestTimers.delete(requestId);
        publish();
      }, TERMINAL_REQUEST_LINGER_MS),
    );
    publish();
  }

  /** An invite this server made, while joins on it may still be decided; by this server's clock. */
  function liveInvite(inviteId: string) {
    const local = localInvites.get(inviteId);
    return local && local.expiresAt + JOIN_GRACE_MS >= Date.now() ? local : null;
  }

  function setMatchNumber(requestId: string, matchNumber: string): void {
    matchNumbers.set(requestId, matchNumber);
    const current = requests.get(requestId);
    if (current && current.matchNumber !== matchNumber) {
      requests.set(requestId, { ...current, matchNumber });
      publish();
    }
  }

  function clearInvite(): void {
    invite = null;
    if (inviteTimer) clearTimeout(inviteTimer);
    inviteTimer = null;
    publish();
  }

  const handleControlEvent = (event: RelayControlEvent) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "snapshot": {
          usage = event.usage;
          for (const request of event.requests) {
            trackRequest(request);
          }
          publish();
          yield* reconcile(event.devices);
          for (const request of event.requests) {
            yield* processRequest(request);
          }
          return;
        }
        case "join.requested": {
          trackRequest(event.request);
          publish();
          yield* processRequest(event.request);
          return;
        }
        case "request.revealed": {
          yield* pairingLock.withPermits(1)(revealLocked(event.requestId, event.deviceNonce));
          return;
        }
        case "request.updated": {
          if (event.state !== "pending") settleRequest(event.requestId, event.state);
          return;
        }
        case "usage": {
          usage = event.usage;
          publish();
          return;
        }
        case "device.connecting": {
          yield* handleDeviceConnecting(event.deviceId, event.pipeId);
          return;
        }
      }
    });

  // ----- pairing -----------------------------------------------------------------

  const refuse = (requestId: string, why: string) =>
    Effect.gen(function* () {
      yield* Effect.logWarning("relay.join.refused", { requestId, why });
      yield* deny(requestId).pipe(Effect.ignore);
    });

  /**
   * Checks a join the relay reported, against what this server made and
   * stored itself, never against an earlier relay report. QR claims must
   * carry a valid proof for an unused invite of this server's; code joins get
   * one try per invite, and their transcript is stored before the server's
   * nonce goes out. Runs for live events and snapshots alike.
   */
  const processRequest = (request: RelayJoinRequest) =>
    pairingLock
      .withPermits(1)(
        Effect.gen(function* () {
          if (request.state !== "pending") return;
          const devicePublicKey = yield* Effect.promise(() =>
            decodePublicKey(request.devicePublicKey),
          );
          if (!devicePublicKey) return yield* refuse(request.requestId, "invalid device key");
          // Only invites this server made, and only while a join on them can
          // still be live, get anything: otherwise a relay could make up
          // invites to win extra tries at the match number.
          const local = liveInvite(request.inviteId);
          if (!local) {
            return yield* refuse(request.requestId, "invite not made here, or expired");
          }

          if (request.autoApprove) {
            const proof = request.claimProof;
            if (
              !proof ||
              local.approved ||
              (local.claimedBy !== null && local.claimedBy !== request.requestId)
            ) {
              return yield* refuse(request.requestId, "invite already used");
            }
            const valid = yield* Effect.promise(() =>
              verifyClaimProof({
                macKey: local.macKey,
                inviteId: request.inviteId,
                joinId: request.joinId,
                devicePublicKey,
                proof,
              }),
            );
            if (!valid) return yield* refuse(request.requestId, "bad claim proof");
            local.claimedBy = request.requestId;
            const decision = yield* approveVerified(request.requestId, request.devicePublicKey);
            if (decision.state === "approved") local.approved = true;
            return;
          }

          if (!request.commitment) return yield* refuse(request.requestId, "missing commitment");
          const existing = yield* repo.getPairingByInvite(request.inviteId);
          const stored: RelayPairingRow = Option.isSome(existing)
            ? existing.value
            : yield* repo.insertPairing({
                requestId: request.requestId,
                inviteId: request.inviteId,
                joinId: request.joinId,
                deviceId: request.deviceId,
                devicePublicKey: request.devicePublicKey,
                commitment: request.commitment,
                hostNonce: toBase64Url(randomBytes(PAIRING_NONCE_BYTES)),
                createdAt: nowIso(),
              });
          if (stored.requestId !== request.requestId) {
            return yield* refuse(request.requestId, "invite already had its try");
          }
          if (
            stored.devicePublicKey !== request.devicePublicKey ||
            stored.commitment !== request.commitment ||
            stored.joinId !== request.joinId ||
            stored.deviceId !== request.deviceId ||
            (request.hostNonce !== undefined && request.hostNonce !== stored.hostNonce)
          ) {
            return yield* refuse(request.requestId, "request changed after it was recorded");
          }
          if (request.hostNonce === undefined) {
            const key = yield* hostKey;
            const creds = yield* ensureRegistered;
            yield* relayApi.setHostNonce(
              relayOrigin!,
              creds.hostId,
              creds.hostSecret,
              request.requestId,
              {
                hostNonce: stored.hostNonce,
                hostPublicKey: key.stored.publicKey,
              },
            );
          }
          if (stored.matchNumber) {
            setMatchNumber(request.requestId, stored.matchNumber);
          } else if (request.deviceNonce) {
            yield* revealLocked(request.requestId, request.deviceNonce);
          }
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("relay.join.check-failed", { requestId: request.requestId, cause }),
        ),
      );

  /** The joiner revealed its nonce: check its commitment, then work out the number. */
  const revealLocked = (requestId: string, deviceNonce: string) =>
    Effect.gen(function* () {
      const pairing = yield* repo.getPairing(requestId);
      if (Option.isNone(pairing)) return;
      const stored = pairing.value;
      if (!liveInvite(stored.inviteId)) {
        return yield* refuse(requestId, "revealed after its invite expired");
      }
      if (stored.deviceNonce !== null) {
        if (stored.deviceNonce !== deviceNonce) {
          return yield* refuse(requestId, "nonce changed after it was revealed");
        }
        if (stored.matchNumber) setMatchNumber(requestId, stored.matchNumber);
        return;
      }
      const nonce = fromBase64Url(deviceNonce);
      const devicePublicKey = fromBase64Url(stored.devicePublicKey);
      const hostNonce = fromBase64Url(stored.hostNonce);
      if (!nonce || nonce.length !== PAIRING_NONCE_BYTES || !devicePublicKey || !hostNonce) {
        return yield* refuse(requestId, "malformed nonce");
      }
      const commitment = yield* Effect.promise(() => pairingCommitment(devicePublicKey, nonce));
      if (commitment !== stored.commitment) {
        return yield* refuse(requestId, "nonce doesn't match the commitment");
      }
      const key = yield* hostKey;
      const matchNumber = yield* Effect.promise(() =>
        pairingMatchNumber({
          hostPublicKey: key.pair.publicKey,
          devicePublicKey,
          hostNonce,
          deviceNonce: nonce,
        }),
      );
      yield* repo.revealPairing({ requestId, deviceNonce, matchNumber });
      setMatchNumber(requestId, matchNumber);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("relay.join.reveal-failed", { requestId, cause }),
      ),
    );

  // ----- approval and revocation -------------------------------------------------

  /** The owner clicked Allow: only after both screens could show the same number. */
  const approve = (requestId: string) =>
    Effect.gen(function* () {
      const request = requests.get(requestId);
      if (!request || request.autoApprove) {
        return yield* new RelayAccessError({ detail: "That request is no longer waiting." });
      }
      const pairing = yield* repo.getPairing(requestId);
      if (
        Option.isNone(pairing) ||
        !pairing.value.matchNumber ||
        pairing.value.inviteId !== request.inviteId ||
        pairing.value.deviceId !== request.deviceId
      ) {
        return yield* new RelayAccessError({
          detail: "Wait until the number shows on both screens.",
        });
      }
      if (!liveInvite(pairing.value.inviteId)) {
        return yield* new RelayAccessError({
          detail: "That code ran out. Make a new one and try again.",
        });
      }
      return yield* approveVerified(requestId, pairing.value.devicePublicKey);
    });

  /** Approves a join whose device key this server already checked. */
  const approveVerified = (requestId: string, devicePublicKey: string) =>
    Effect.gen(function* () {
      const request = requests.get(requestId);
      if (!request) {
        return yield* new RelayAccessError({ detail: "That request is no longer waiting." });
      }
      const creds = yield* ensureRegistered;
      const row = yield* repo.insertApproving({
        deviceId: request.deviceId,
        requestId,
        relayOrigin: relayOrigin!,
        label: request.joiner.label,
        kind: request.joiner.kind,
        platform: request.joiner.platform ?? null,
        devicePublicKey,
        now: nowIso(),
      });
      if (row.state === "revoking" || row.state === "revoked") {
        return yield* new RelayAccessError({ detail: "That device's access was already removed." });
      }
      return yield* finishApproval(row, creds);
    });

  /**
   * Gives an approving row its session (a crash can leave it without one),
   * asks the relay to approve, then activates or rolls back the row. Safe to
   * retry, and safe to race with reconcile.
   */
  const finishApproval = (
    row: RelayDeviceRow,
    creds: { readonly hostId: string; readonly hostSecret: string },
  ) =>
    Effect.gen(function* () {
      if (row.sessionId === null) {
        const issued = yield* sessions.issue({
          ttl: RELAY_DEVICE_SESSION_TTL,
          subject: RELAY_DEVICE_SUBJECT,
          method: "bearer-session-token",
          role: "client",
          client: {
            label: row.label,
            deviceType: deviceTypeFor(row.kind),
            ...(row.platform ? { os: row.platform } : {}),
          },
        });
        yield* repo.setSession({
          deviceId: row.deviceId,
          sessionId: issued.sessionId,
          now: nowIso(),
        });
      }
      const decision = yield* relayApi.decide(
        relayOrigin!,
        creds.hostId,
        creds.hostSecret,
        row.requestId,
        "approve",
      );
      if (decision.state === "approved") {
        const activated = yield* repo.transition({
          deviceId: row.deviceId,
          from: ["approving"],
          to: "active",
          now: nowIso(),
        });
        const current = activated ? null : yield* repo.getDevice(row.deviceId);
        // Already active means another pass got there first; anything else was
        // removed while approving, so the relay has to forget it too.
        if (current !== null && !(Option.isSome(current) && current.value.state === "active")) {
          yield* revokeAtRelay(row.deviceId);
        }
      } else {
        yield* dropDevice(row.deviceId);
      }
      settleRequest(row.requestId, decision.state);
      return { requestId: decision.requestId, state: decision.state };
    });

  const deny = (requestId: string) =>
    Effect.gen(function* () {
      const creds = yield* ensureRegistered;
      const decision = yield* relayApi.decide(
        relayOrigin!,
        creds.hostId,
        creds.hostSecret,
        requestId,
        "deny",
      );
      settleRequest(requestId, decision.state);
      return { requestId: decision.requestId, state: decision.state };
    });

  /** Revokes the device's session (if any) and forgets the row. */
  const dropDevice = (deviceId: string) =>
    Effect.gen(function* () {
      const row = yield* repo.getDevice(deviceId);
      if (Option.isSome(row) && row.value.sessionId) {
        yield* sessions.revoke(row.value.sessionId).pipe(Effect.ignore);
      }
      yield* repo.deleteDevice(deviceId);
    });

  const revokeAtRelay = (deviceId: string) =>
    Effect.gen(function* () {
      yield* repo.transition({
        deviceId,
        from: ["approving", "active", "revoking"],
        to: "revoking",
        now: nowIso(),
      });
      closePipesFor(deviceId);
      const creds = yield* loadCredentials;
      if (!creds) return;
      yield* relayApi.revokeDevice(relayOrigin!, creds.hostId, creds.hostSecret, deviceId);
      yield* repo.transition({ deviceId, from: ["revoking"], to: "revoked", now: nowIso() });
    });

  /** Brings server rows and relay devices back into agreement. */
  const reconcile = (
    relayDevices: ReadonlyArray<{ readonly deviceId: string; readonly state: string }>,
  ) =>
    Effect.gen(function* () {
      const creds = yield* loadCredentials;
      if (!creds) return;
      const rows = yield* repo.listDevices;
      const rowsById = new Map(rows.map((row) => [row.deviceId, row]));
      // Rows this first pass settled; the second pass would only see them stale.
      const settled = new Set<string>();

      for (const relayDevice of relayDevices) {
        if (relayDevice.state !== "active") continue;
        const row = rowsById.get(relayDevice.deviceId);
        const usable =
          row !== undefined &&
          (row.state === "active" || row.state === "approving") &&
          row.sessionId !== null &&
          (yield* sessions
            .extendExpiry(row.sessionId, RELAY_DEVICE_SESSION_TTL)
            .pipe(Effect.orElseSucceed(() => false)));
        settled.add(relayDevice.deviceId);
        if (!usable) {
          yield* revokeAtRelay(relayDevice.deviceId).pipe(Effect.ignore);
        } else if (row.state === "approving") {
          yield* repo.transition({
            deviceId: row.deviceId,
            from: ["approving"],
            to: "active",
            now: nowIso(),
          });
        }
      }

      for (const row of rows) {
        if (settled.has(row.deviceId)) continue;
        if (row.state === "revoking") {
          yield* revokeAtRelay(row.deviceId).pipe(Effect.ignore);
        } else if (row.state === "approving") {
          yield* finishApproval(row, creds).pipe(Effect.ignore);
        }
        // Revoked rows stay as tombstones (pruned by age): a replayed join
        // for the same request then finds them and can't be approved again.
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("relay.reconcile.failed", { cause })));

  // ----- pipes ---------------------------------------------------------------------

  function closePipesFor(deviceId: string): void {
    for (const [pipeId, pipe] of pipes) {
      if (pipe.deviceId === deviceId) {
        pipes.delete(pipeId);
        pipe.handle.close("Access removed.");
      }
    }
  }

  const handleDeviceConnecting = (deviceId: string, pipeId: string) =>
    Effect.gen(function* () {
      const row = yield* repo.getDevice(deviceId);
      if (Option.isSome(row) && row.value.state === "approving") {
        sendControl({ type: "pipe.refuse", pipeId, reason: "not-yet" });
        return;
      }
      const sessionId =
        Option.isSome(row) && row.value.state === "active" ? row.value.sessionId : null;
      const usable =
        sessionId !== null &&
        (yield* sessions
          .extendExpiry(sessionId, RELAY_DEVICE_SESSION_TTL)
          .pipe(Effect.orElseSucceed(() => false)));
      const devicePublicKey =
        usable && Option.isSome(row)
          ? yield* Effect.promise(() => decodePublicKey(row.value.devicePublicKey))
          : null;
      if (
        !usable ||
        !sessionId ||
        !devicePublicKey ||
        !localOrigin ||
        !credentials ||
        !relayOrigin
      ) {
        sendControl({ type: "pipe.refuse", pipeId, reason: usable ? "not-yet" : "revoked" });
        if (!usable) yield* revokeAtRelay(deviceId).pipe(Effect.ignore);
        return;
      }

      const key = yield* hostKey;
      const creds = credentials;
      const origin = relayOrigin;
      const socket = yield* Effect.tryPromise(() =>
        openRelayPipeSocket({
          relayPipeUrl: relaySocketUrl(origin, `/v2/hosts/${creds.hostId}/pipes/${pipeId}`),
          hostSecret: creds.hostSecret,
        }),
      ).pipe(
        Effect.tapError(() =>
          Effect.sync(() => sendControl({ type: "pipe.refuse", pipeId, reason: "not-yet" })),
        ),
      );
      const handle = openSecurePipe({
        duplex: {
          send: (data) => socket.send(data),
          // Client sockets may only close with 1000 or 3000-4999.
          close: (code, reason) => socket.close(code >= 3000 ? code : 1000, reason),
        },
        via: "relay",
        hostKeyPair: key.pair,
        devicePublicKey,
        hostId: creds.hostId,
        deviceId,
        handshakeTimeoutMs: RELAY_HANDSHAKE_TIMEOUT_MS,
        openLocal: () => runPromise(openDeviceSession(sessionId)),
        onClosed: () => {
          pipes.delete(pipeId);
        },
      });
      socket.addEventListener("message", (event: MessageEvent) => handle.receive(event.data));
      socket.addEventListener("close", () => handle.closed());
      socket.addEventListener("error", () => handle.closed());
      pipes.set(pipeId, { deviceId, sessionId, handle });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("relay.pipe.open-failed", { deviceId, cause }),
      ),
    );

  /**
   * The loopback `/ws` for a device's session, opened only once the device
   * proved its key. The session must still be usable; each use extends it.
   */
  const openDeviceSession = (sessionId: AuthSessionId) =>
    Effect.gen(function* () {
      const usable = yield* sessions
        .extendExpiry(sessionId, RELAY_DEVICE_SESSION_TTL)
        .pipe(Effect.orElseSucceed(() => false));
      if (!usable || !localOrigin) {
        return yield* Effect.fail(new Error("This device's access ended."));
      }
      const token = yield* sessions.issueWebSocketToken(sessionId);
      const localUrl = new URL("/ws", localOrigin);
      localUrl.protocol = localUrl.protocol === "https:" ? "wss:" : "ws:";
      localUrl.searchParams.set("wsToken", token.token);
      return yield* Effect.tryPromise(() => openLoopbackSocket(localUrl.toString()));
    });

  const admitDirect: RelayHostShape["admitDirect"] = (remoteAddress) => {
    const address = remoteAddress ?? "unknown";
    const fromAddress = pendingDirectByAddress.get(address) ?? 0;
    if (pendingDirect >= DIRECT_MAX_PENDING || fromAddress >= DIRECT_MAX_PENDING_PER_ADDRESS) {
      return null;
    }
    pendingDirect += 1;
    pendingDirectByAddress.set(address, fromAddress + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        pendingDirect -= 1;
        const left = (pendingDirectByAddress.get(address) ?? 1) - 1;
        if (left <= 0) pendingDirectByAddress.delete(address);
        else pendingDirectByAddress.set(address, left);
      },
    };
  };

  const acceptDirect: RelayHostShape["acceptDirect"] = (input) =>
    Effect.gen(function* () {
      const row = yield* repo.getDevice(input.deviceId);
      const creds = yield* loadCredentials;
      const sessionId =
        Option.isSome(row) && row.value.state === "active" ? row.value.sessionId : null;
      const devicePublicKey =
        sessionId !== null && Option.isSome(row)
          ? yield* Effect.promise(() => decodePublicKey(row.value.devicePublicKey))
          : null;
      if (!sessionId || !devicePublicKey || !creds || !localOrigin) {
        input.admission.release();
        return null;
      }
      const key = yield* hostKey;
      directCounter += 1;
      const pipeId = `direct:${directCounter}`;
      const handle = openSecurePipe({
        duplex: input.duplex,
        via: "direct",
        hostKeyPair: key.pair,
        devicePublicKey,
        hostId: creds.hostId,
        deviceId: input.deviceId,
        handshakeTimeoutMs: DIRECT_HANDSHAKE_TIMEOUT_MS,
        openLocal: () => runPromise(openDeviceSession(sessionId)),
        onHandshake: () => input.admission.release(),
        onClosed: () => {
          input.admission.release();
          pipes.delete(pipeId);
        },
      });
      pipes.set(pipeId, { deviceId: input.deviceId, sessionId, handle });
      return handle;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("relay.direct.accept-failed", { deviceId: input.deviceId, cause }).pipe(
          Effect.andThen(Effect.sync(() => input.admission.release())),
          Effect.as(null),
        ),
      ),
    );

  const tailscaleHttpsBaseUrl = Effect.gen(function* () {
    if (!config.tailscaleServeEnabled) return null;
    if (tailscaleCache && Date.now() - tailscaleCache.at < TAILSCALE_CACHE_MS) {
      return tailscaleCache.value;
    }
    const value = yield* resolveTailscaleHttpsBaseUrl({
      servePort: config.tailscaleServePort,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.orElseSucceed(() => null),
    );
    tailscaleCache = { value, at: Date.now() };
    return value;
  });

  const directRoutes: RelayHostShape["directRoutes"] = (sessionId) =>
    Effect.gen(function* () {
      const row = yield* repo.getDeviceBySession(sessionId);
      if (Option.isNone(row) || row.value.state !== "active" || !localOrigin) return [];
      const port = Number(new URL(localOrigin).port);
      if (!Number.isInteger(port) || port <= 0) return [];
      return computeDirectRoutes({
        bindHost: config.host,
        port,
        deviceId: row.value.deviceId,
        tailscaleHttpsBaseUrl: yield* tailscaleHttpsBaseUrl,
      });
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  // ----- public API ---------------------------------------------------------------

  const createInvite: RelayHostShape["createInvite"] = Effect.gen(function* () {
    const creds = yield* ensureRegistered;
    const key = yield* hostKey;
    // The QR secret is made here; the relay only ever sees a hash of the
    // claim token derived from it, never the key claim proofs are made with.
    const inviteSecret = randomBytes(32);
    const { claimToken, macKey } = yield* Effect.promise(() => claimSecrets(inviteSecret));
    const claimTokenHash = toBase64Url(yield* Effect.promise(() => sha256(utf8(claimToken))));
    const created = yield* relayApi.createInvite(relayOrigin!, creds.hostId, creds.hostSecret, {
      hostLabel,
      claimTokenHash,
    });
    const now = Date.now();
    for (const [inviteId, local] of localInvites) {
      if (local.expiresAt + JOIN_GRACE_MS < now) localInvites.delete(inviteId);
    }
    // This server's own clock decides how long the invite counts here; the
    // relay's expiry is only for display (a relay could report any date).
    const relayExpiry = Date.parse(created.expiresAt);
    const ownExpiry = now + RELAY_INVITE_TTL_SECONDS * 1000;
    localInvites.set(created.inviteId, {
      macKey,
      expiresAt: Number.isFinite(relayExpiry) ? Math.min(relayExpiry, ownExpiry) : ownExpiry,
      claimedBy: null,
      approved: false,
    });
    invite = {
      inviteId: created.inviteId,
      hostId: creds.hostId as RelayOpenInvite["hostId"],
      relayOrigin: relayOrigin!,
      code: created.code,
      inviteSecret: toBase64Url(inviteSecret),
      hostPublicKey: key.stored.publicKey,
      expiresAt: created.expiresAt,
    };
    if (inviteTimer) clearTimeout(inviteTimer);
    const openInvite = invite;
    inviteTimer = setTimeout(
      () => {
        if (invite?.inviteId === openInvite.inviteId) clearInvite();
      },
      Math.max(0, Date.parse(created.expiresAt) - Date.now()),
    );
    publish();
    yield* ensureControl;
    return openInvite;
  }).pipe(Effect.mapError((error) => toAccessError(error, "Couldn't make a code.")));

  const cancelInvite: RelayHostShape["cancelInvite"] = (inviteId) =>
    Effect.gen(function* () {
      if (invite?.inviteId === inviteId) clearInvite();
      const creds = yield* loadCredentials;
      if (!creds) return;
      yield* relayApi.cancelInvite(relayOrigin!, creds.hostId, creds.hostSecret, inviteId);
    }).pipe(Effect.mapError((error) => toAccessError(error, "Couldn't cancel the code.")));

  const respondToJoinRequest: RelayHostShape["respondToJoinRequest"] = (input) =>
    (input.allow ? approve(input.requestId) : deny(input.requestId)).pipe(
      Effect.mapError((error) =>
        toAccessError(
          error,
          input.allow ? "Couldn't allow that device." : "Couldn't deny that device.",
        ),
      ),
    );

  const submitJoin: RelayHostShape["submitJoin"] = (input) =>
    Effect.gen(function* () {
      let origin: string;
      try {
        origin = relayOriginFrom(input.relayOrigin ?? relayUrl);
      } catch {
        return yield* new RelayAccessError({ detail: "The relay address is not valid." });
      }
      const result = yield* relayApi.join(origin, {
        joinId: input.joinId,
        code: input.code,
        deviceSecretHash: input.deviceSecretHash,
        requestSecretHash: input.requestSecretHash,
        devicePublicKey: input.devicePublicKey,
        commitment: input.commitment,
        joiner: {
          label: hostLabel,
          platform: platformName(descriptor.platform.os),
          kind: input.kind,
        },
      });
      return {
        relayOrigin: origin,
        hostId: result.hostId,
        hostEnvironmentId: result.hostEnvironmentId,
        requestId: result.requestId,
        deviceId: result.deviceId,
        hostLabel: result.hostLabel,
        expiresAt: result.expiresAt,
      } satisfies RelaySubmitJoinResult;
    }).pipe(Effect.mapError((error) => toAccessError(error, "Couldn't send the code.")));

  // Sessions revoked anywhere (Remove access, revoke-others, expiry cleanup)
  // also take the device off the relay.
  yield* sessions.streamChanges.pipe(
    Stream.runForEach((change) =>
      change.type === "clientRemoved"
        ? Effect.gen(function* () {
            const row = yield* repo.getDeviceBySession(change.sessionId);
            if (Option.isSome(row) && row.value.state !== "revoked") {
              yield* revokeAtRelay(row.value.deviceId);
            }
          }).pipe(Effect.catchCause((cause) => Effect.logWarning("relay.revoke.failed", { cause })))
        : Effect.void,
    ),
    Effect.forkScoped,
  );

  let sessionRefresh: ReturnType<typeof setInterval> | null = null;

  const prunePairings = Effect.suspend(() =>
    Effect.all([
      repo.prunePairings(
        DateTime.formatIso(DateTime.makeUnsafe(Date.now() - PAIRING_RETENTION_MS)),
      ),
      repo.pruneRevoked(DateTime.formatIso(DateTime.makeUnsafe(Date.now() - REVOKED_RETENTION_MS))),
    ]),
  ).pipe(Effect.ignore);

  const start: RelayHostShape["start"] = (origin) =>
    Effect.gen(function* () {
      localOrigin = origin;
      yield* cleanupLeftoverSessions;
      yield* prunePairings;
      yield* ensureControl;
      // Long-lived pipes keep their device's session from expiring; old
      // pairing transcripts are dropped once their invites are long gone.
      sessionRefresh ??= setInterval(() => {
        for (const pipe of pipes.values()) {
          void runPromise(sessions.extendExpiry(pipe.sessionId, RELAY_DEVICE_SESSION_TTL)).catch(
            () => undefined,
          );
        }
        void runPromise(prunePairings).catch(() => undefined);
      }, SESSION_REFRESH_INTERVAL_MS);
    });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (sessionRefresh) clearInterval(sessionRefresh);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (inviteTimer) clearTimeout(inviteTimer);
      for (const timer of requestTimers.values()) clearTimeout(timer);
      for (const pipe of pipes.values()) pipe.handle.close("Server stopping.");
      pipes.clear();
      localOrigin = null;
      dropControl("Server stopping.");
    }),
  );

  /**
   * The old phone-link bridge signed in with the desktop token as an owner
   * bearer session on every phone (re)join and never signed out. Nothing uses
   * those now, so they are revoked; so are relay-device sessions whose device
   * row is gone (a crash between issuing and recording).
   */
  const cleanupLeftoverSessions = Effect.gen(function* () {
    const active = yield* sessions.listActive();
    const rows = yield* repo.listDevices;
    const knownSessions = new Set(rows.map((row) => row.sessionId).filter(Boolean));
    for (const session of active) {
      const leakedBridge =
        session.subject === DESKTOP_BOOTSTRAP_SUBJECT && session.method === "bearer-session-token";
      const orphanDevice =
        session.subject === RELAY_DEVICE_SUBJECT && !knownSessions.has(session.sessionId);
      if (leakedBridge || orphanDevice) {
        yield* sessions.revoke(session.sessionId).pipe(Effect.ignore);
      }
    }
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("relay.cleanup.failed", { cause })));

  return RelayHost.of({
    snapshots: SubscriptionRef.changes(snapshotRef),
    createInvite,
    cancelInvite,
    respondToJoinRequest,
    submitJoin,
    start,
    admitDirect,
    acceptDirect,
    directRoutes,
  });
});

export const RelayHostLive = Layer.effect(RelayHost, make);
