/**
 * The assistants door on this computer: implements Assistants.ts (read its
 * notes first) over the relay (AssistantRelay) and the connection rows.
 *
 * - **The relay's door.** What the relay said last (`info`: the address to
 *   paste and whether the door is on) is the snapshot's `status` and
 *   `address`. It is asked again when the socket opens, when a code or a key
 *   is made (which register this computer first if it isn't), and when the
 *   snapshot is read and the answer is older than 10 minutes (30 seconds
 *   while the relay couldn't be reached). Reading the snapshot never
 *   registers this computer: until a code or a key does, the address is
 *   unknown.
 * - **The socket** is wanted while there is a live assistant connection, a
 *   code showing, or a sign-in waiting; the relay link keeps the computer's
 *   lease up for as long.
 * - **Sign-ins** (`signin` frames) wait for the user until the relay's
 *   expiry. Deny all's quiet period denies new ones at once. The user's
 *   decision goes back as a `signin.decision` frame and is kept until the
 *   sign-in's life ends, so a sign-in the relay sends again after a reconnect
 *   gets the same answer.
 * - **Requests** (`request` frames) are handled concurrently, at most
 *   RELAY_ASSISTANT_MAX_IN_FLIGHT at once, each answered with one `response`
 *   frame: `token` here, `mcp` by the handler AssistantMcpServer registers.
 * - **Removal** (Remove, replaced, 90 days unused, refresh reuse) marks the
 *   row for revocation at the relay in the same statement; the pending ones
 *   are sent until the relay takes them, across restarts.
 */
// @effect-diagnostics nodeBuiltinImport:off
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  ASSISTANT_ACCESS_TOKEN_TTL_SECONDS,
  ASSISTANT_AUTHORIZATION_CODE_TTL_MS,
  ASSISTANT_SIGN_IN_TTL_MS,
  type OutsideAgentAccess,
  type OutsideAgentAssistantSignIn,
  OutsideAgentConnectionId,
  OutsideAgentError,
  type OutsideAgentGrant,
  type OutsideAgentIdentity,
  OutsideAgentRequestId,
  RELAY_ASSISTANT_FRAME_MAX_BYTES,
  RELAY_ASSISTANT_MAX_IN_FLIGHT,
  type RelayAssistantDecisionFrame,
  type RelayAssistantInfo,
  type RelayAssistantPlace,
  type RelayAssistantRelayFrame,
  type RelayAssistantRequestFrame,
  type RelayAssistantSignIn,
} from "@threadlines/contracts";
import {
  type AssistantRoute,
  formatAssistantCredential,
  parseAssistantCredential,
  randomAssistantSecret,
} from "@threadlines/shared/assistantCredentials";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  SERVER_SIGNING_SECRET_BYTES,
  SERVER_SIGNING_SECRET_NAME,
} from "../auth/Layers/SessionCredentialService.ts";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { makeKeyedLock } from "../links/keyedLock.ts";
import {
  connectionOfRow,
  grantRefusal,
  normalizedGrant,
} from "../outsideAgents/connectionShapes.ts";
import { clientIdHash, pkceMatches, secretsMatch } from "../outsideAgents/credentials.ts";
import {
  OutsideAgentConnectionRepository,
  OutsideAgentConnectionRepositoryLive,
  type OutsideAgentConnectionRow,
  type OutsideAgentRemovedReason,
} from "../outsideAgents/OutsideAgentConnectionRepository.ts";
import {
  displayText,
  isOAuthFailure,
  type OAuthErrorCode,
  readTokenRequest,
  scopeForAccess,
  singleParam,
} from "../outsideAgents/oauthRequests.ts";
import { decideRefresh, makeAssistantSigner } from "./AssistantCredentials.ts";
import {
  AssistantRelay,
  type AssistantRelayError,
  type AssistantRelayEvent,
  assistantRelayOff,
} from "./AssistantRelay.ts";
import {
  type AssistantHttpRequest,
  type AssistantHttpResponse,
  type AssistantMcpHandler,
  Assistants,
  type AssistantsShape,
  AssistantUnavailable,
} from "./Assistants.ts";

/** Sign-ins waiting at once; more are denied (the relay limits each IP too). */
const MAX_WAITING = 5;
const UNUSED_LIMIT_MS = Duration.toMillis(Duration.days(90));
const TOUCH_EVERY_MS = 60_000;
const INFO_STALE_MS = 10 * 60_000;
const INFO_RETRY_MS = 30_000;
/** While someone read the snapshot this recently, an unreachable relay is asked again. */
const INFO_WATCHED_MS = 5 * 60_000;
const REVOKE_RETRY_DELAYS_MS = [30_000, 60_000, 5 * 60_000, 10 * 60_000] as const;
const IDLE_SWEEP_EVERY = Duration.hours(6);
const NAME_MAX = 60;
const UNNAMED = "Unnamed assistant";

const UNREACHABLE_DETAIL =
  "Threadlines couldn't reach the relay. Check this computer's connection and try again.";

interface WaitingSignIn {
  readonly requestId: OutsideAgentRequestId;
  readonly signIn: RelayAssistantSignIn;
  readonly name: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** Everything an authorization code's exchange checks and saves. */
interface IssuedCode {
  readonly route: AssistantRoute;
  readonly clientId: string;
  readonly clientName: string;
  readonly identity: OutsideAgentIdentity;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly grant: OutsideAgentGrant;
  readonly expiresAt: number;
}

const isoAt = (millis: number): string => DateTime.formatIso(DateTime.makeUnsafe(millis));
const millisOf = (iso: string): number => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

/** What an assistant asked for: `threads:read` alone is See threads; nothing asked is everything. */
const requestedAccessOf = (scopes: ReadonlyArray<string>): OutsideAgentAccess =>
  scopes.length === 0 || scopes.includes("threads:start") ? "start" : "see";

/** "Austin, US", as the dialog's browser line shows it; null when the relay didn't know. */
const placeOf = (place: RelayAssistantPlace | null): string | null => {
  if (place === null) return null;
  const parts = [place.city, place.country].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  const text = displayText(parts.join(", "), 80);
  return text.length > 0 ? text : null;
};

const identityOf = (signIn: RelayAssistantSignIn): OutsideAgentIdentity => ({
  host: signIn.identity.host,
  verified: signIn.identity.kind === "cimd",
  known: signIn.identity.known,
});

const tokenAnswer = (status: number, body: unknown): AssistantHttpResponse => ({
  status,
  headers: {
    "content-type": "application/json",
    "cache-control": "no-store",
    pragma: "no-cache",
  },
  body: JSON.stringify(body),
});

const tokenError = (error: OAuthErrorCode, description: string): AssistantHttpResponse =>
  tokenAnswer(error === "server_error" ? 500 : error === "invalid_client" ? 401 : 400, {
    error,
    error_description: description,
  });

const frameBytes = (frame: unknown) => Buffer.byteLength(JSON.stringify(frame), "utf8");

export const makeAssistants = Effect.gen(function* () {
  const relay = yield* AssistantRelay;
  const repository = yield* OutsideAgentConnectionRepository;
  const secretStore = yield* ServerSecretStore;
  const signer = makeAssistantSigner(
    yield* secretStore.getOrCreateRandom(SERVER_SIGNING_SECRET_NAME, SERVER_SIGNING_SECRET_BYTES),
  );
  const scope = yield* Effect.scope;
  const changed = yield* PubSub.sliding<void>(1);
  const notify = PubSub.publish(changed, undefined).pipe(Effect.asVoid);

  let info: RelayAssistantInfo | null = null;
  let status: "ready" | "off" | "unreachable" = relay.available ? "ready" : "off";
  let infoAt = 0;
  let refreshingInfo = false;
  let infoRetryScheduled = false;
  let lastStateReadAt = 0;
  let code: { readonly code: string; readonly expiresAt: number } | null = null;
  const signIns = new Map<string, WaitingSignIn>();
  const decided = new Map<
    string,
    { readonly frame: RelayAssistantDecisionFrame; readonly until: number }
  >();
  const codes = new Map<string, IssuedCode>();
  let quietUntil: number | null = null;
  let liveConnections = 0;
  let mcpHandler: AssistantMcpHandler | null = null;
  const inFlight = yield* Semaphore.make(RELAY_ASSISTANT_MAX_IN_FLIGHT);
  const refreshLock = makeKeyedLock();
  const revokeLock = yield* Semaphore.make(1);
  let revokeAttempt = 0;
  let revokeRetryScheduled = false;

  const storeFailure = new OutsideAgentError({
    detail: "Threadlines couldn't save that change. Try again.",
  });
  const relayFailure = (error: AssistantRelayError) =>
    new OutsideAgentError({
      detail: error.reason === "unreachable" ? UNREACHABLE_DETAIL : error.detail,
    });

  const forkInScope = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.ignore({ log: true }), Effect.forkIn(scope), Effect.asVoid);

  // ---------------------------------------------------------------------------
  // The socket, and whether it is wanted
  // ---------------------------------------------------------------------------

  const codeShowing = (now: number) => code !== null && code.expiresAt > now;

  const reconsiderSocket = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* relay.setWanted(
      relay.available && (liveConnections > 0 || codeShowing(now) || signIns.size > 0),
    );
  });

  const recountConnections = repository.countLive("assistant").pipe(
    Effect.tap((count) =>
      Effect.sync(() => {
        liveConnections = count;
      }),
    ),
    Effect.ignore({ log: true }),
    Effect.andThen(reconsiderSocket),
  );

  // ---------------------------------------------------------------------------
  // The relay's door: its address, and whether it is on
  // ---------------------------------------------------------------------------

  const applyInfo = (next: RelayAssistantInfo) =>
    Effect.gen(function* () {
      const nextStatus = next.enabled ? "ready" : "off";
      const same = info?.address === next.address && status === nextStatus;
      info = next;
      status = nextStatus;
      infoAt = yield* Clock.currentTimeMillis;
      if (!same) yield* notify;
    });

  const scheduleInfoRetry: Effect.Effect<void> = Effect.suspend(() => {
    if (infoRetryScheduled) return Effect.void;
    infoRetryScheduled = true;
    return Effect.sleep(INFO_RETRY_MS).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          infoRetryScheduled = false;
          return Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              status === "unreachable" &&
              (liveConnections > 0 || now - lastStateReadAt < INFO_WATCHED_MS)
                ? refreshInfo(false)
                : Effect.void,
            ),
          );
        }),
      ),
      forkInScope,
    );
  });

  /** Asks the relay about its door; `register` registers this computer first when it isn't. */
  const refreshInfo = (register: boolean): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!relay.available || refreshingInfo) return Effect.void;
      refreshingInfo = true;
      return relay.info({ register }).pipe(
        Effect.matchEffect({
          onSuccess: (next) =>
            next === null
              ? Clock.currentTimeMillis.pipe(
                  Effect.map((now) => {
                    // Not registered yet: nothing to ask until a code or a key registers it.
                    infoAt = now;
                  }),
                )
              : applyInfo(next),
          onFailure: (error) =>
            Effect.gen(function* () {
              infoAt = yield* Clock.currentTimeMillis;
              const nextStatus = error.reason === "off" ? "off" : "unreachable";
              if (status !== nextStatus) {
                status = nextStatus;
                yield* notify;
              }
              if (nextStatus === "unreachable") yield* scheduleInfoRetry;
            }),
        }),
        Effect.ensuring(
          Effect.sync(() => {
            refreshingInfo = false;
          }),
        ),
      );
    });

  // ---------------------------------------------------------------------------
  // Revocations at the relay
  // ---------------------------------------------------------------------------

  const scheduleRevokeRetry: Effect.Effect<void> = Effect.suspend(() => {
    if (revokeRetryScheduled) return Effect.void;
    revokeRetryScheduled = true;
    const delay =
      REVOKE_RETRY_DELAYS_MS[Math.min(revokeAttempt, REVOKE_RETRY_DELAYS_MS.length - 1)]!;
    revokeAttempt += 1;
    return Effect.sleep(delay).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          revokeRetryScheduled = false;
          return flushRevocations;
        }),
      ),
      forkInScope,
    );
  });

  /**
   * Tells the relay about every removed connection it hasn't heard of, 100 at
   * a time. Ones under a host this computer no longer has are dropped: that
   * host's routes are gone with it.
   */
  const flushRevocations: Effect.Effect<void> = revokeLock
    .withPermits(1)(
      Effect.gen(function* () {
        if (!relay.available) return;
        for (let round = 0; round < 50; round += 1) {
          const pending = yield* repository.pendingRevocations(100);
          if (pending.length === 0) {
            revokeAttempt = 0;
            return;
          }
          const hostId = yield* relay.hostId;
          if (hostId === null) return yield* scheduleRevokeRetry;
          yield* repository.clearRevocations(
            pending.filter((entry) => entry.hostId !== hostId).map((entry) => entry.connectionId),
          );
          const mine = pending
            .filter((entry) => entry.hostId === hostId)
            .map((entry) => entry.connectionId);
          if (mine.length === 0) continue;
          const sent = yield* relay.revoke({ hostId, connectionIds: mine }).pipe(Effect.result);
          if (sent._tag === "Failure") return yield* scheduleRevokeRetry;
          yield* repository.clearRevocations(mine);
        }
      }),
    )
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("assistants: couldn't send revocations to the relay", { cause }).pipe(
          Effect.andThen(scheduleRevokeRetry),
        ),
      ),
    );

  const connectionsChanged: AssistantsShape["connectionsChanged"] = Effect.gen(function* () {
    yield* recountConnections;
    yield* forkInScope(flushRevocations);
  });

  /** Removes a connection for `reason` (the relay is told) and says so. */
  const removeConnection = (
    connectionId: OutsideAgentConnectionId,
    reason: OutsideAgentRemovedReason,
    now: number,
  ) =>
    Effect.gen(function* () {
      const removed = yield* repository.markRemoved({ connectionId, reason, now: isoAt(now) });
      if (!removed) return;
      yield* notify;
      yield* connectionsChanged;
    });

  const sweepUnused = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const removed = yield* repository.removeUnusedSince({
      kind: "assistant",
      before: isoAt(now - UNUSED_LIMIT_MS),
      now: isoAt(now),
    });
    if (removed.length > 0) {
      yield* notify;
      yield* connectionsChanged;
    }
  }).pipe(Effect.ignore({ log: true }));

  // ---------------------------------------------------------------------------
  // The snapshot
  // ---------------------------------------------------------------------------

  const state: AssistantsShape["state"] = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    lastStateReadAt = now;
    const stale =
      infoAt === 0 || now - infoAt > (status === "unreachable" ? INFO_RETRY_MS : INFO_STALE_MS);
    // Only once registered: looking at Settings never registers this computer.
    if (relay.available && stale) yield* forkInScope(refreshInfo(false));
    const rows =
      signIns.size === 0 ? [] : yield* repository.listLive.pipe(Effect.orElseSucceed(() => []));
    const waiting: Array<OutsideAgentAssistantSignIn> = [];
    for (const entry of signIns.values()) {
      if (entry.expiresAt <= now) continue;
      const hash = clientIdHash(entry.signIn.clientId);
      const earlier = rows.find((row) => row.kind === "assistant" && row.clientIdHash === hash);
      waiting.push({
        requestId: entry.requestId,
        name: entry.name,
        identity: identityOf(entry.signIn),
        place: placeOf(entry.signIn.place),
        requestedAccess: requestedAccessOf(entry.signIn.scopes),
        replaces:
          earlier === undefined
            ? null
            : { connectionId: earlier.connectionId, name: earlier.clientName },
        createdAt: isoAt(entry.createdAt),
        expiresAt: isoAt(entry.expiresAt),
      });
    }
    waiting.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return {
      status: relay.available ? status : "off",
      address: info?.address ?? null,
      code:
        code !== null && code.expiresAt > now
          ? { code: code.code, expiresAt: isoAt(code.expiresAt) }
          : null,
      signIns: waiting,
    };
  });

  // ---------------------------------------------------------------------------
  // Codes
  // ---------------------------------------------------------------------------

  const createCode: AssistantsShape["createCode"] = Effect.gen(function* () {
    if (!relay.available) {
      return yield* new OutsideAgentError({
        detail: "Assistants are off: this computer's relay is turned off.",
      });
    }
    const made = yield* relay.createCode.pipe(Effect.mapError(relayFailure));
    const showing = { code: made.code, expiresAt: millisOf(made.expiresAt) };
    code = showing;
    yield* Effect.sleep(Math.max(0, showing.expiresAt - (yield* Clock.currentTimeMillis))).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          if (code !== showing) return Effect.void;
          code = null;
          return notify.pipe(Effect.andThen(reconsiderSocket));
        }),
      ),
      forkInScope,
    );
    yield* reconsiderSocket;
    yield* notify;
    yield* forkInScope(refreshInfo(false));
    return made;
  });

  const cancelCode: AssistantsShape["cancelCode"] = Effect.gen(function* () {
    if (code === null) return;
    code = null;
    yield* notify;
    yield* reconsiderSocket;
    yield* relay.cancelCode.pipe(
      Effect.mapError(
        (error) =>
          new OutsideAgentError({
            detail:
              error.reason === "unreachable"
                ? "Threadlines couldn't reach the relay to cancel the code. It stops working within 10 minutes anyway."
                : error.detail,
          }),
      ),
    );
  });

  // ---------------------------------------------------------------------------
  // Sign-ins
  // ---------------------------------------------------------------------------

  const sendDecision = (frame: RelayAssistantDecisionFrame, now: number) =>
    Effect.gen(function* () {
      decided.set(frame.signInId, { frame, until: now + ASSISTANT_SIGN_IN_TTL_MS });
      for (const [signInId, entry] of decided) if (entry.until <= now) decided.delete(signInId);
      return yield* relay.send(frame);
    });

  const scheduleSignInExpiry = (entry: WaitingSignIn, now: number) =>
    Effect.sleep(Math.max(0, entry.expiresAt - now)).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          if (signIns.get(entry.requestId) !== entry) return Effect.void;
          signIns.delete(entry.requestId);
          return notify.pipe(Effect.andThen(reconsiderSocket));
        }),
      ),
      forkInScope,
    );

  const onSignIn = (signIn: RelayAssistantSignIn) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const deny = () =>
        sendDecision({ type: "signin.decision", signInId: signIn.signInId, decision: "deny" }, now);
      const earlier = decided.get(signIn.signInId);
      if (earlier !== undefined && earlier.until > now) {
        // Sent again after a reconnect: the same answer.
        yield* relay.send(earlier.frame);
        return;
      }
      if (quietUntil !== null && quietUntil > now) return yield* deny();
      const requestId = OutsideAgentRequestId.make(signIn.signInId);
      const existing = signIns.get(requestId);
      const waitingNow = [...signIns.values()].filter((entry) => entry.expiresAt > now).length;
      if (existing === undefined && waitingNow >= MAX_WAITING) return yield* deny();
      const expiresAt = Math.min(millisOf(signIn.expiresAt), now + ASSISTANT_SIGN_IN_TTL_MS);
      if (expiresAt <= now) return;
      const entry: WaitingSignIn = {
        requestId,
        signIn,
        name: displayText(signIn.clientName, NAME_MAX) || UNNAMED,
        createdAt: existing?.createdAt ?? now,
        expiresAt,
      };
      signIns.set(requestId, entry);
      // The code did its job: the dialog takes its place.
      code = null;
      yield* scheduleSignInExpiry(entry, now);
      yield* reconsiderSocket;
      yield* notify;
    });

  const onSignInGone = (signInId: string) =>
    Effect.gen(function* () {
      decided.delete(signInId);
      if (!signIns.delete(signInId)) return;
      yield* notify;
      yield* reconsiderSocket;
    });

  const waitingEntry = (requestId: OutsideAgentRequestId, now: number) => {
    const entry = signIns.get(requestId);
    return entry !== undefined && entry.expiresAt > now ? entry : undefined;
  };

  const isWaiting: AssistantsShape["isWaiting"] = (requestId) =>
    Effect.map(Clock.currentTimeMillis, (now) => waitingEntry(requestId, now) !== undefined);

  const approve: AssistantsShape["approve"] = (input) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const gone = new OutsideAgentError({
        detail: "This sign-in is no longer waiting. Ask the assistant to sign in again.",
      });
      const entry = waitingEntry(input.requestId, now);
      if (entry === undefined) return yield* gone;
      const refusal = grantRefusal(input, requestedAccessOf(entry.signIn.scopes), "assistant");
      if (refusal !== null) return yield* new OutsideAgentError({ detail: refusal });
      const grant = normalizedGrant(input);
      const connectionId = OutsideAgentConnectionId.make(randomUUID());
      const tagged = yield* relay.routeTag(connectionId).pipe(
        Effect.mapError(
          (error) =>
            new OutsideAgentError({
              detail:
                error.reason === "unreachable"
                  ? "Threadlines couldn't reach the relay to finish this sign-in. Check this computer's connection, then Allow again."
                  : error.detail,
            }),
        ),
      );
      if (signIns.get(input.requestId) !== entry) return yield* gone;
      const route: AssistantRoute = {
        hostId: tagged.hostId,
        connectionId,
        routeTag: tagged.routeTag,
      };
      const authorizationCode = formatAssistantCredential({
        kind: "code",
        route,
        secret: randomAssistantSecret(),
      });
      for (const [issued, value] of codes) if (value.expiresAt <= now) codes.delete(issued);
      codes.set(authorizationCode, {
        route,
        clientId: entry.signIn.clientId,
        clientName: entry.name,
        identity: identityOf(entry.signIn),
        redirectUri: entry.signIn.redirectUri,
        codeChallenge: entry.signIn.codeChallenge,
        resource: entry.signIn.resource,
        grant,
        expiresAt: now + ASSISTANT_AUTHORIZATION_CODE_TTL_MS,
      });
      const sent = yield* sendDecision(
        {
          type: "signin.decision",
          signInId: entry.signIn.signInId,
          decision: "allow",
          authorizationCode,
        },
        now,
      );
      if (!sent) {
        codes.delete(authorizationCode);
        decided.delete(entry.signIn.signInId);
        return yield* new OutsideAgentError({
          detail:
            "Threadlines couldn't reach the relay to finish this sign-in. Check this computer's connection, then Allow again.",
        });
      }
      signIns.delete(input.requestId);
      yield* notify;
      yield* reconsiderSocket;
      return {
        connectionId,
        name: entry.name,
        kind: "assistant",
        signIn: "oauth",
        identity: identityOf(entry.signIn),
        ...grant,
        createdAt: isoAt(now),
        lastUsedAt: null,
      };
    });

  const deny: AssistantsShape["deny"] = (requestId) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const entry = waitingEntry(requestId, now);
      if (entry === undefined) return;
      signIns.delete(requestId);
      yield* sendDecision(
        { type: "signin.decision", signInId: entry.signIn.signInId, decision: "deny" },
        now,
      );
      yield* notify;
      yield* reconsiderSocket;
    });

  const setQuiet: AssistantsShape["setQuiet"] = (until) =>
    Effect.gen(function* () {
      quietUntil = until;
      if (until === null || signIns.size === 0) return;
      const now = yield* Clock.currentTimeMillis;
      const waiting = Array.from(signIns.values());
      signIns.clear();
      for (const entry of waiting) {
        yield* sendDecision(
          { type: "signin.decision", signInId: entry.signIn.signInId, decision: "deny" },
          now,
        );
      }
      yield* notify;
      yield* reconsiderSocket;
    });

  // ---------------------------------------------------------------------------
  // Keys
  // ---------------------------------------------------------------------------

  const createKey: AssistantsShape["createKey"] = (input) =>
    Effect.gen(function* () {
      const refusal = grantRefusal(input, null, "assistant");
      if (refusal !== null) return yield* new OutsideAgentError({ detail: refusal });
      if (!relay.available) {
        return yield* new OutsideAgentError({
          detail: "Assistants are off: this computer's relay is turned off.",
        });
      }
      const door = yield* relay.info({ register: true }).pipe(Effect.mapError(relayFailure));
      if (door !== null) yield* applyInfo(door);
      if (door === null || !door.enabled) {
        return yield* new OutsideAgentError({
          detail: "The relay isn't taking assistants right now. Try again later.",
        });
      }
      const connectionId = OutsideAgentConnectionId.make(randomUUID());
      const tagged = yield* relay.routeTag(connectionId).pipe(Effect.mapError(relayFailure));
      const secret = randomAssistantSecret();
      const route: AssistantRoute = {
        hostId: tagged.hostId,
        connectionId,
        routeTag: tagged.routeTag,
      };
      const now = yield* Clock.currentTimeMillis;
      const row: OutsideAgentConnectionRow = {
        connectionId,
        kind: "assistant",
        signIn: "key",
        // Its own: no later sign-in or key replaces it.
        clientIdHash: clientIdHash(`key:${connectionId}`),
        clientName: displayText(input.name, NAME_MAX) || UNNAMED,
        softwareId: null,
        redirectUri: "",
        resource: door.address,
        ...normalizedGrant(input),
        tokenGeneration: 0,
        identity: null,
        hostId: route.hostId,
        routeTag: route.routeTag,
        refresh: null,
        keyHash: signer.keyHash(secret),
        createdAt: isoAt(now),
        lastUsedAt: null,
        removedAt: null,
        removedReason: null,
      };
      yield* repository.insertReplacing(row).pipe(
        Effect.tapError((cause) => Effect.logWarning("assistants: couldn't save a key", { cause })),
        Effect.mapError(() => storeFailure),
      );
      yield* notify;
      yield* recountConnections;
      return {
        connection: connectionOfRow(row),
        key: formatAssistantCredential({ kind: "key", route, secret }),
        address: door.address,
      };
    });

  // ---------------------------------------------------------------------------
  // The token endpoint
  // ---------------------------------------------------------------------------

  const tokensFor = (
    row: OutsideAgentConnectionRow,
    route: AssistantRoute,
    generation: number,
    now: number,
  ) =>
    tokenAnswer(200, {
      access_token: signer.mintAccess({
        route,
        generation,
        expiresAtSeconds: Math.floor(now / 1000) + ASSISTANT_ACCESS_TOKEN_TTL_SECONDS,
        resource: row.resource,
      }),
      token_type: "Bearer",
      expires_in: ASSISTANT_ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: signer.mintRefresh({ route, generation, resource: row.resource }),
      scope: scopeForAccess(row.access),
    });

  const exchangeCode = (request: AssistantHttpRequest, params: URLSearchParams) =>
    Effect.gen(function* () {
      const tokenRequest = readTokenRequest(params);
      if (isOAuthFailure(tokenRequest)) {
        return tokenError(tokenRequest.error, tokenRequest.description);
      }
      if (!secretsMatch(tokenRequest.code, request.credential)) {
        return tokenError("invalid_request", "The code isn't the one the request was sent with.");
      }
      const now = yield* Clock.currentTimeMillis;
      // Gone at its first presentation, whatever comes of it.
      const issued = codes.get(tokenRequest.code);
      codes.delete(tokenRequest.code);
      if (issued === undefined || issued.expiresAt <= now) {
        return tokenError("invalid_grant", "The code is unknown, used or expired.");
      }
      if (tokenRequest.clientId !== issued.clientId) {
        return tokenError("invalid_grant", "The code was issued to another client.");
      }
      if (tokenRequest.redirectUri !== issued.redirectUri) {
        return tokenError(
          "invalid_grant",
          "The redirect_uri isn't the one the code was issued for.",
        );
      }
      if (!pkceMatches(tokenRequest.codeVerifier, issued.codeChallenge)) {
        return tokenError("invalid_grant", "The code_verifier doesn't match the code_challenge.");
      }
      if (
        (tokenRequest.resource !== null && tokenRequest.resource !== issued.resource) ||
        request.resource !== issued.resource
      ) {
        return tokenError("invalid_target", `The resource must be ${issued.resource}.`);
      }
      if ((yield* relay.hostId) !== issued.route.hostId) {
        return tokenError(
          "invalid_grant",
          "This computer's relay registration changed. Sign in again.",
        );
      }
      const row: OutsideAgentConnectionRow = {
        connectionId: OutsideAgentConnectionId.make(issued.route.connectionId),
        kind: "assistant",
        signIn: "oauth",
        clientIdHash: clientIdHash(issued.clientId),
        clientName: issued.clientName,
        softwareId: null,
        redirectUri: issued.redirectUri,
        resource: issued.resource,
        ...issued.grant,
        tokenGeneration: 0,
        identity: issued.identity,
        hostId: issued.route.hostId,
        routeTag: issued.route.routeTag,
        refresh: { generation: 0, rotatedAt: isoAt(now), seenGeneration: -1 },
        keyHash: null,
        createdAt: isoAt(now),
        lastUsedAt: null,
        removedAt: null,
        removedReason: null,
      };
      const saved = yield* repository.insertReplacing(row).pipe(Effect.result);
      if (saved._tag === "Failure") {
        yield* Effect.logWarning("assistants: couldn't save a connection", {
          cause: saved.failure,
        });
        return tokenError("server_error", "Threadlines couldn't save the connection.");
      }
      yield* notify;
      // The one it replaced is revoked at the relay.
      yield* connectionsChanged;
      return tokensFor(row, issued.route, 0, now);
    });

  /** A refresh token's connection, when everything about the token checks out. */
  const refreshRow = (presented: string) =>
    Effect.gen(function* () {
      const parsed = parseAssistantCredential(presented);
      if (parsed === null || parsed.kind !== "refresh") return null;
      const hostId = yield* relay.hostId;
      if (hostId === null || parsed.route.hostId !== hostId) return null;
      const row = Option.getOrNull(
        yield* repository.get(OutsideAgentConnectionId.make(parsed.route.connectionId)),
      );
      if (
        row === null ||
        row.kind !== "assistant" ||
        row.signIn !== "oauth" ||
        row.removedAt !== null ||
        row.refresh === null ||
        row.hostId !== parsed.route.hostId ||
        row.routeTag !== parsed.route.routeTag ||
        !signer.verify(parsed, row.resource)
      ) {
        return null;
      }
      return { row, parsed };
    });

  const refresh = (request: AssistantHttpRequest, params: URLSearchParams) =>
    Effect.gen(function* () {
      const presented = singleParam(params, "refresh_token");
      if (presented === null) return tokenError("invalid_request", "Send refresh_token once.");
      if (!secretsMatch(presented, request.credential)) {
        return tokenError(
          "invalid_request",
          "The refresh token isn't the one the request was sent with.",
        );
      }
      if (params.getAll("resource").length > 1 || params.getAll("client_id").length > 1) {
        return tokenError("invalid_request", "Send resource and client_id at most once.");
      }
      const found = yield* refreshRow(presented);
      const revoked = tokenError(
        "invalid_grant",
        "The refresh token is unknown or was revoked. Sign in to Threadlines again.",
      );
      if (found === null) return revoked;
      const { row, parsed } = found;
      const resource = params.get("resource");
      if ((resource !== null && resource !== row.resource) || request.resource !== row.resource) {
        return tokenError("invalid_target", `The resource must be ${row.resource}.`);
      }
      const clientId = params.get("client_id");
      if (clientId !== null && clientIdHash(clientId) !== row.clientIdHash) {
        return tokenError("invalid_grant", "The refresh token was issued to another client.");
      }
      const now = yield* Clock.currentTimeMillis;
      if (now - millisOf(row.lastUsedAt ?? row.createdAt) > UNUSED_LIMIT_MS) {
        yield* removeConnection(row.connectionId, "unused", now);
        return revoked;
      }
      // Read, decided and written in one transaction, one refresh per connection at a time.
      const decision = yield* refreshLock(row.connectionId)(
        repository.transaction(
          Effect.gen(function* () {
            const current = Option.getOrNull(yield* repository.get(row.connectionId));
            if (current === null || current.removedAt !== null || current.refresh === null) {
              return { kind: "gone" } as const;
            }
            const outcome = decideRefresh(
              {
                generation: current.refresh.generation,
                rotatedAtMs: millisOf(current.refresh.rotatedAt),
                seenGeneration: current.refresh.seenGeneration,
              },
              parsed.generation,
              now,
            );
            if (outcome.kind === "rotate") {
              yield* repository.setRefresh({
                connectionId: row.connectionId,
                generation: outcome.generation,
                rotatedAt: isoAt(now),
              });
            }
            if (outcome.kind === "reuse") {
              yield* repository.markRemoved({
                connectionId: row.connectionId,
                reason: "refresh-reuse",
                now: isoAt(now),
              });
            }
            return outcome;
          }),
        ),
      ).pipe(Effect.result);
      if (decision._tag === "Failure") {
        yield* Effect.logWarning("assistants: couldn't rotate a refresh token", {
          cause: decision.failure,
        });
        return tokenError("server_error", "Threadlines couldn't check the refresh token.");
      }
      switch (decision.success.kind) {
        case "gone":
        case "unknown":
          return revoked;
        case "reuse":
          yield* notify;
          yield* connectionsChanged;
          return tokenError(
            "invalid_grant",
            "This refresh token was used again after it was replaced, so Threadlines removed the connection to be safe. Sign in to Threadlines again.",
          );
        case "rotate":
        case "repeat":
          return tokensFor(row, parsed.route, decision.success.generation, now);
      }
    });

  const token = (request: AssistantHttpRequest) =>
    Effect.gen(function* () {
      const params = new URLSearchParams(request.body);
      const grantType = singleParam(params, "grant_type");
      if (grantType === "authorization_code") return yield* exchangeCode(request, params);
      if (grantType === "refresh_token") return yield* refresh(request, params);
      return grantType === null
        ? tokenError("invalid_request", "Send grant_type once.")
        : tokenError(
            "unsupported_grant_type",
            "Only the authorization_code and refresh_token grants are supported.",
          );
    }).pipe(
      Effect.catchTag("OutsideAgentConnectionRepositoryError", (cause) =>
        Effect.logWarning("assistants: couldn't read a connection", { cause }).pipe(
          Effect.as(tokenError("server_error", "Threadlines couldn't check the credential.")),
        ),
      ),
    );

  // ---------------------------------------------------------------------------
  // MCP credentials
  // ---------------------------------------------------------------------------

  const authenticate: AssistantsShape["authenticate"] = ({ credential, resource }) =>
    Effect.gen(function* () {
      const parsed = parseAssistantCredential(credential);
      if (parsed === null || (parsed.kind !== "access" && parsed.kind !== "key")) return null;
      const hostId = yield* relay.hostId;
      if (hostId === null || parsed.route.hostId !== hostId) return null;
      const row = Option.getOrNull(
        yield* repository.get(OutsideAgentConnectionId.make(parsed.route.connectionId)),
      );
      if (
        row === null ||
        row.kind !== "assistant" ||
        row.removedAt !== null ||
        row.hostId !== parsed.route.hostId ||
        row.routeTag !== parsed.route.routeTag ||
        row.resource !== resource
      ) {
        return null;
      }
      const now = yield* Clock.currentTimeMillis;
      if (parsed.kind === "access") {
        if (
          row.signIn !== "oauth" ||
          row.refresh === null ||
          parsed.generation > row.refresh.generation ||
          parsed.expiresAtSeconds * 1000 <= now ||
          !signer.verify(parsed, row.resource)
        ) {
          return null;
        }
      } else if (
        row.signIn !== "key" ||
        row.keyHash === null ||
        !signer.keyMatches(parsed.secret, row.keyHash)
      ) {
        return null;
      }
      if (now - millisOf(row.lastUsedAt ?? row.createdAt) > UNUSED_LIMIT_MS) {
        yield* removeConnection(row.connectionId, "unused", now);
        return null;
      }
      // The refresh rules count a generation as in use once its access token passed here.
      if (
        parsed.kind === "access" &&
        row.refresh !== null &&
        parsed.generation > row.refresh.seenGeneration
      ) {
        yield* repository.markSeen({
          connectionId: row.connectionId,
          generation: parsed.generation,
        });
      }
      if (row.lastUsedAt === null || now - millisOf(row.lastUsedAt) >= TOUCH_EVERY_MS) {
        yield* repository.touch({ connectionId: row.connectionId, now: isoAt(now) });
        yield* notify;
      }
      return { connectionId: row.connectionId, name: row.clientName };
    }).pipe(
      Effect.catchTag("OutsideAgentConnectionRepositoryError", (cause) =>
        Effect.logWarning("assistants: couldn't check a credential", { cause }).pipe(
          Effect.andThen(Effect.fail(new AssistantUnavailable())),
        ),
      ),
    );

  const serveMcp: AssistantsShape["serveMcp"] = (handler) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        mcpHandler = handler;
      }),
      () =>
        Effect.sync(() => {
          if (mcpHandler === handler) mcpHandler = null;
        }),
    ).pipe(Effect.asVoid);

  // ---------------------------------------------------------------------------
  // The relay's frames
  // ---------------------------------------------------------------------------

  const notReady: AssistantHttpResponse = {
    status: 503,
    headers: { "content-type": "application/json", "retry-after": "5" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Threadlines is still starting. Try again in a moment." },
    }),
  };

  const failed: AssistantHttpResponse = {
    status: 500,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Threadlines couldn't answer that request." },
    }),
  };

  const answer = (frame: RelayAssistantRequestFrame) =>
    Effect.gen(function* () {
      const request: AssistantHttpRequest = {
        credential: frame.credential,
        resource: frame.resource,
        headers: frame.headers,
        body: frame.body,
      };
      const response =
        frame.route === "token"
          ? yield* token(request)
          : mcpHandler === null
            ? notReady
            : yield* mcpHandler(request);
      const full = { type: "response" as const, id: frame.id, ...response };
      // AssistantMcp keeps tool results under the limit; this is the last line.
      return frameBytes(full) <= RELAY_ASSISTANT_FRAME_MAX_BYTES
        ? full
        : { type: "response" as const, id: frame.id, ...failed };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("assistants: a request failed", {
          route: frame.route,
          cause,
        }).pipe(Effect.as({ type: "response" as const, id: frame.id, ...failed })),
      ),
      Effect.flatMap(relay.send),
      Effect.asVoid,
    );

  const onFrame = (frame: RelayAssistantRelayFrame): Effect.Effect<void> => {
    switch (frame.type) {
      case "request":
        // Concurrent, bounded; each answers with one response frame.
        return inFlight.withPermits(1)(answer(frame)).pipe(Effect.forkIn(scope), Effect.asVoid);
      case "signin":
        return onSignIn(frame.signIn).pipe(Effect.asVoid);
      case "signin.gone":
        return onSignInGone(frame.signInId);
    }
  };

  const onEvent = (event: AssistantRelayEvent): Effect.Effect<void> => {
    switch (event.type) {
      case "open":
        return Effect.all([forkInScope(refreshInfo(false)), forkInScope(flushRevocations)], {
          discard: true,
        });
      case "closed":
        return Effect.void;
      case "frame":
        return onFrame(event.frame);
    }
  };

  yield* relay.events.pipe(
    Stream.runForEach((event) => onEvent(event).pipe(Effect.ignore({ log: true }))),
    Effect.forkIn(scope),
  );

  // Startup: what a restart left (connections, pending revocations), then
  // the unused sweep every few hours.
  yield* recountConnections;
  yield* forkInScope(
    Effect.gen(function* () {
      yield* sweepUnused;
      yield* flushRevocations;
      if ((yield* relay.hostId) !== null) yield* refreshInfo(false);
    }),
  );
  yield* sweepUnused.pipe(Effect.delay(IDLE_SWEEP_EVERY), Effect.forever, forkInScope);

  return Assistants.of({
    state,
    changes: Stream.fromPubSub(changed),
    isWaiting,
    approve,
    deny,
    setQuiet,
    createCode,
    cancelCode,
    createKey,
    connectionsChanged,
    authenticate,
    serveMcp,
  });
});

/** The door over AssistantRelay and the connection rows (OutsideAgentConnectionRepository). */
export const AssistantsLive = Layer.effect(Assistants, makeAssistants);

/** The door with this computer's relay turned off, over its own rows: for servers without a relay (tests). */
export const AssistantsWithoutRelayLive = AssistantsLive.pipe(
  Layer.provide(Layer.succeed(AssistantRelay, assistantRelayOff)),
  Layer.provide(OutsideAgentConnectionRepositoryLive),
);
