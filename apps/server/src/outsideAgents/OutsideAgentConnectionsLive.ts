/**
 * Outside agents' connections and sign-in (docs/design/outside-agents.md),
 * over one store: the `outside_agent_connections` rows, and in memory the
 * sign-ins waiting for the user, their authorization codes, Deny all's quiet
 * period and the rate limits.
 *
 * `OutsideAgentConnectionsLive` provides both services:
 * - OutsideAgentConnections, which `/mcp/connect` checks every call against
 *   (and whose `grant` both doors' tools read);
 * - OutsideAgentSignIn, behind the OAuth routes (`oauthHttp.ts`) and the
 *   owner-only `outsideAgents.*` RPCs.
 *
 * Assistants (docs/design/assistants.md) are in the same rows and the same
 * snapshot: their sign-ins, codes and keys are the Assistants service's,
 * which the snapshot, Approve, Deny, Deny all and Remove reach through here.
 */
// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";

import {
  OutsideAgentConnectionId,
  OutsideAgentError,
  type OutsideAgentGrant,
  type OutsideAgentPendingRequest,
  OutsideAgentRequestId,
  type OutsideAgentsSnapshot,
} from "@threadlines/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
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
import { Assistants } from "../assistants/Assistants.ts";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import { connectionOfRow, grantRefusal, normalizedGrant } from "./connectionShapes.ts";
import {
  clientIdHash,
  makeOutsideAgentSigner,
  pkceMatches,
  randomMatchCode,
  randomSecret,
  secretsMatch,
} from "./credentials.ts";
import {
  OutsideAgentConnectionRepository,
  OutsideAgentConnectionRepositoryLive,
} from "./OutsideAgentConnectionRepository.ts";
import {
  OutsideAgentConnections,
  type OutsideAgentConnectionsShape,
  outsideAgentResource,
  OUTSIDE_AGENT_MCP_PATH,
} from "./OutsideAgentConnections.ts";
import {
  type AuthorizeRequest,
  callbackWith,
  checkAuthorizeRequest,
  isOAuthFailure,
  type OAuthErrorCode,
  parseLoopbackRedirect,
  readRegistration,
  readTokenRequest,
  scopeForAccess,
} from "./oauthRequests.ts";
import {
  OutsideAgentSignIn,
  type OutsideAgentSignInShape,
  type SignInStatus,
  type TokenResult,
} from "./OutsideAgentSignIn.ts";

/** How long a sign-in waits for the user. */
const WAIT_FOR_USER = Duration.minutes(5);
/** How long a settled sign-in stays readable for its page after it was settled or expired. */
const KEEP_SETTLED = Duration.minutes(2);
/** An authorization code works once, within this long of the page receiving it. */
const CODE_LIFETIME = Duration.seconds(60);
/** Deny all turns new sign-ins away this long, unless the user takes requests again. */
const QUIET_PERIOD = Duration.minutes(10);
/** A connection unused this long is removed (`unused`); the agent signs in again. */
const UNUSED_LIMIT = Duration.days(90);
/** `last_used_at` moves at most this often. */
const TOUCH_EVERY = Duration.minutes(1);
const RATE_WINDOW = Duration.minutes(1);
const REGISTRATIONS_PER_MINUTE = 20;
const AUTHORIZATIONS_PER_MINUTE = 20;
const MAX_WAITING = 5;

type PendingOutcome =
  | { readonly kind: "waiting" }
  | {
      readonly kind: "approved";
      readonly grant: OutsideAgentGrant;
      readonly connectionId: OutsideAgentConnectionId;
      /** Its number among the user's decisions about this registration (see `latestDecision`). */
      readonly decision: number;
      /** Minted when the page first asks, so its 60 seconds start then. */
      code: string | null;
    }
  | { readonly kind: "denied" | "expired" | "replaced" };

interface PendingSignIn {
  readonly requestId: OutsideAgentRequestId;
  readonly pollSecret: string;
  readonly matchCode: string;
  readonly request: AuthorizeRequest;
  /** The issuer the answer names (`iss`): the origin the request came to. */
  readonly origin: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  outcome: PendingOutcome;
}

/** Everything an authorization code's exchange checks and saves, kept apart from its sign-in. */
interface AuthorizationCode {
  readonly request: AuthorizeRequest;
  readonly grant: OutsideAgentGrant;
  readonly connectionId: OutsideAgentConnectionId;
  readonly decision: number;
  readonly expiresAt: number;
}

const isoAt = (millis: number): string => DateTime.formatIso(DateTime.makeUnsafe(millis));
const millisOf = (iso: string): number => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

/**
 * Takes a slot in a one-minute window of at most `limit`; null when taken,
 * otherwise the seconds until one frees up.
 */
const takeSlot = (log: Array<number>, limit: number, now: number): number | null => {
  const windowMs = Duration.toMillis(RATE_WINDOW);
  while (log.length > 0 && (log[0] ?? 0) <= now - windowMs) log.shift();
  if (log.length >= limit) {
    return Math.max(1, Math.ceil(((log[0] ?? now) + windowMs - now) / 1000));
  }
  log.push(now);
  return null;
};

/**
 * Which agent signed in, for telemetry: a known family, never the name as
 * given (Claude Code's carries the server name the user chose).
 */
export const clientFamily = (name: string, softwareId: string | null): string => {
  const normalized = name.toLowerCase();
  if (softwareId === "threadlines-cli" || normalized.startsWith("threadlines")) {
    return "threadlines-command";
  }
  if (normalized.includes("claude")) return "claude-code";
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("gemini")) return "gemini-cli";
  if (normalized.includes("cursor")) return "cursor";
  return "other";
};

const storeFailure = new OutsideAgentError({
  detail: "Threadlines couldn't save that change. Try again.",
});

const makeOutsideAgents = Effect.gen(function* () {
  const repository = yield* OutsideAgentConnectionRepository;
  const config = yield* ServerConfig;
  const analytics = yield* AnalyticsService;
  const secretStore = yield* ServerSecretStore;
  const assistants = yield* Assistants;
  const signer = makeOutsideAgentSigner(
    yield* secretStore.getOrCreateRandom(SERVER_SIGNING_SECRET_NAME, SERVER_SIGNING_SECRET_BYTES),
  );
  const scope = yield* Effect.scope;
  // Only "something changed" matters; a subscriber behind by one change reads the latest.
  const changed = yield* PubSub.sliding<void>(1);
  const notify = PubSub.publish(changed, undefined).pipe(Effect.asVoid);
  const bootId = randomUUID();

  const pending = new Map<string, PendingSignIn>();
  const codes = new Map<string, AuthorizationCode>();
  let quietUntil: number | null = null;
  const registrations: Array<number> = [];
  const authorizations: Array<number> = [];

  /**
   * The user's newest decision about each registration (by client id hash):
   * every approval, and every Change or Remove of its connection, takes the
   * next number. Only the approval holding its registration's newest number
   * can be exchanged, so an older approval never comes back after a newer
   * one, or after the user changed or removed the connection.
   */
  const latestDecision = new Map<string, number>();
  let decisions = 0;
  const decide = (hash: string): number => {
    decisions += 1;
    latestDecision.set(hash, decisions);
    return decisions;
  };
  // Serializes the newest-decision check and the connection writes that go
  // with it: an exchange's check and save, a Change, a Remove.
  const decisionLock = yield* Semaphore.make(1);

  /** Whether a sign-in still waits for the user: past its 5 minutes it doesn't, whether or not its timer ran yet. */
  const isWaiting = (entry: PendingSignIn, now: number): boolean =>
    entry.outcome.kind === "waiting" && entry.expiresAt > now;

  /**
   * The one way a sign-in becomes expired, always announced. Everything else
   * only asks `isWaiting`, so no read can expire a sign-in silently and leave
   * an open approval dialog behind.
   */
  const expireIfDue = (entry: PendingSignIn, now: number) =>
    Effect.suspend(() => {
      if (entry.outcome.kind !== "waiting" || entry.expiresAt > now) return Effect.void;
      entry.outcome = { kind: "expired" };
      return notify;
    });

  const storeError =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.tapError((cause) =>
          Effect.logWarning(`outside agents: couldn't ${operation}`).pipe(
            Effect.annotateLogs({ cause }),
          ),
        ),
        Effect.mapError(() => storeFailure),
      );

  // ---------------------------------------------------------------------------
  // The Agents group
  // ---------------------------------------------------------------------------

  const snapshot: Effect.Effect<OutsideAgentsSnapshot, OutsideAgentError> = Effect.gen(
    function* () {
      const rows = yield* repository.listLive.pipe(storeError("read the connections"));
      const now = yield* Clock.currentTimeMillis;
      const waiting: Array<OutsideAgentPendingRequest> = [];
      for (const entry of pending.values()) {
        if (!isWaiting(entry, now)) continue;
        const hash = clientIdHash(entry.request.clientId);
        const earlier = rows.find((row) => row.kind === "local" && row.clientIdHash === hash);
        waiting.push({
          requestId: entry.requestId,
          name: entry.request.client.name,
          code: entry.matchCode,
          callbackPort: entry.request.callbackPort,
          requestedAccess: entry.request.requestedAccess,
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
        address: `http://127.0.0.1:${config.port}${OUTSIDE_AGENT_MCP_PATH}`,
        connections: rows.map(connectionOfRow),
        pending: waiting,
        quietUntil: quietUntil !== null && quietUntil > now ? isoAt(quietUntil) : null,
        assistants: yield* assistants.state,
      };
    },
  );

  // Subscribes before the first read, so a change can't fall between the two.
  // An assistant's change (a sign-in, a code, a connection used) counts too.
  const changes: OutsideAgentSignInShape["changes"] = Stream.unwrap(
    Effect.map(PubSub.subscribe(changed), (subscription) =>
      Stream.concat(
        Stream.make(undefined),
        Stream.merge(Stream.fromSubscription(subscription), assistants.changes),
      ).pipe(Stream.mapEffect(() => snapshot)),
    ),
  );

  /** Expires a sign-in when its 5 minutes are up, then forgets it once its page had time to read how it ended. */
  const scheduleExpiry = (entry: PendingSignIn) =>
    Effect.gen(function* () {
      yield* Effect.sleep(WAIT_FOR_USER);
      yield* expireIfDue(entry, yield* Clock.currentTimeMillis);
      yield* Effect.sleep(KEEP_SETTLED);
      if (pending.get(entry.requestId) === entry) pending.delete(entry.requestId);
    }).pipe(Effect.forkIn(scope), Effect.asVoid);

  const scheduleQuietEnd = Effect.sleep(QUIET_PERIOD).pipe(
    Effect.andThen(Clock.currentTimeMillis),
    Effect.flatMap((now) => {
      if (quietUntil === null || quietUntil > now) return Effect.void;
      quietUntil = null;
      return notify;
    }),
    Effect.forkIn(scope),
    Effect.asVoid,
  );

  const waitingEntry = (requestId: OutsideAgentRequestId, now: number) => {
    const entry = pending.get(requestId);
    return entry !== undefined && isWaiting(entry, now) ? entry : undefined;
  };

  const approve: OutsideAgentSignInShape["approve"] = (input) =>
    Effect.gen(function* () {
      if (yield* assistants.isWaiting(input.requestId)) return yield* assistants.approve(input);
      const now = yield* Clock.currentTimeMillis;
      const entry = waitingEntry(input.requestId, now);
      if (entry === undefined) {
        return yield* new OutsideAgentError({
          detail: "This sign-in is no longer waiting. Ask the agent to sign in again.",
        });
      }
      const refusal = grantRefusal(input, entry.request.requestedAccess);
      if (refusal !== null) return yield* new OutsideAgentError({ detail: refusal });
      const grant = normalizedGrant(input);
      const connectionId = OutsideAgentConnectionId.make(randomUUID());
      const decision = decide(clientIdHash(entry.request.clientId));
      entry.outcome = { kind: "approved", grant, connectionId, decision, code: null };
      yield* notify;
      return {
        connectionId,
        name: entry.request.client.name,
        kind: "local",
        signIn: "oauth",
        identity: null,
        ...grant,
        createdAt: isoAt(now),
        lastUsedAt: null,
      };
    });

  const deny: OutsideAgentSignInShape["deny"] = (input) =>
    Effect.gen(function* () {
      if (yield* assistants.isWaiting(input.requestId)) {
        return yield* assistants.deny(input.requestId);
      }
      const entry = waitingEntry(input.requestId, yield* Clock.currentTimeMillis);
      if (entry === undefined) return;
      entry.outcome = { kind: "denied" };
      yield* notify;
    });

  const denyAll: OutsideAgentSignInShape["denyAll"] = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const entry of pending.values()) {
      if (isWaiting(entry, now)) entry.outcome = { kind: "denied" };
    }
    quietUntil = now + Duration.toMillis(QUIET_PERIOD);
    // Assistants' sign-ins too: the waiting ones now, new ones until it ends.
    yield* assistants.setQuiet(quietUntil);
    yield* scheduleQuietEnd;
    yield* notify;
  });

  const resumeRequests: OutsideAgentSignInShape["resumeRequests"] = Effect.suspend(() => {
    if (quietUntil === null) return Effect.void;
    quietUntil = null;
    return assistants.setQuiet(null).pipe(Effect.andThen(notify));
  });

  const update: OutsideAgentSignInShape["update"] = (input) =>
    Effect.gen(function* () {
      const refusal = grantRefusal(input, null);
      if (refusal !== null) return yield* new OutsideAgentError({ detail: refusal });
      const row = yield* repository
        .setGrant({ connectionId: input.connectionId, grant: normalizedGrant(input) })
        .pipe(
          // The change outranks any approval of the same agent still waiting for its exchange.
          Effect.tap((changed) =>
            Option.isSome(changed)
              ? Effect.sync(() => decide(changed.value.clientIdHash))
              : Effect.void,
          ),
          decisionLock.withPermits(1),
          storeError("change a connection"),
        );
      if (Option.isNone(row)) {
        return yield* new OutsideAgentError({ detail: "That connection was removed." });
      }
      yield* notify;
      return connectionOfRow(row.value);
    });

  const remove: OutsideAgentSignInShape["remove"] = (input) =>
    Effect.gen(function* () {
      const removed = yield* Effect.gen(function* () {
        const row = yield* repository.get(input.connectionId);
        // The removal outranks any approval of the same agent still waiting for its exchange.
        if (Option.isSome(row)) decide(row.value.clientIdHash);
        const done = yield* repository.markRemoved({
          connectionId: input.connectionId,
          reason: "removed",
          now: isoAt(yield* Clock.currentTimeMillis),
        });
        return done ? Option.map(row, (found) => found.kind) : Option.none();
      }).pipe(decisionLock.withPermits(1), storeError("remove a connection"));
      if (Option.isNone(removed)) return;
      // An assistant's is refused at the relay too, even while this computer sleeps.
      if (removed.value === "assistant") yield* assistants.connectionsChanged;
      yield* notify;
    });

  // ---------------------------------------------------------------------------
  // OAuth
  // ---------------------------------------------------------------------------

  const register: OutsideAgentSignInShape["register"] = (body) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const retryAfterSeconds = takeSlot(registrations, REGISTRATIONS_PER_MINUTE, now);
      if (retryAfterSeconds !== null) return { kind: "limited", retryAfterSeconds } as const;
      const registration = readRegistration(yield* body);
      if (isOAuthFailure(registration)) return { kind: "refused", failure: registration } as const;
      const clientId = signer.signClientId({ ...registration, registrationId: randomSecret() });
      return {
        kind: "registered",
        clientId,
        clientName: registration.name,
        redirectUris: registration.redirectUris,
        softwareId: registration.softwareId,
        issuedAt: Math.floor(now / 1000),
      } as const;
    });

  const beginSignIn: OutsideAgentSignInShape["beginSignIn"] = ({ origin, params }) =>
    Effect.gen(function* () {
      const check = checkAuthorizeRequest({
        params,
        resource: outsideAgentResource(origin),
        readClientId: signer.readClientId,
      });
      if (check.kind === "page") return { kind: "invalid" } as const;
      if (check.kind === "redirect") {
        return {
          kind: "refused",
          redirect: callbackWith(check.redirectUri, {
            error: check.failure.error,
            error_description: check.failure.description,
            state: check.state,
            iss: origin,
          }),
        } as const;
      }
      const request = check.request;
      const answer = (error: OAuthErrorCode, description: string) =>
        callbackWith(request.redirectUri, {
          error,
          error_description: description,
          state: request.state,
          iss: origin,
        });

      const now = yield* Clock.currentTimeMillis;
      if (quietUntil !== null && quietUntil > now) {
        return {
          kind: "quiet",
          redirect: answer("access_denied", "Threadlines isn't taking new agent sign-ins now."),
        } as const;
      }
      const retryAfterSeconds = takeSlot(authorizations, AUTHORIZATIONS_PER_MINUTE, now);
      if (retryAfterSeconds !== null) {
        return {
          kind: "limited",
          retryAfterSeconds,
          redirect: answer("temporarily_unavailable", "Too many sign-ins this minute."),
        } as const;
      }
      let waiting = 0;
      for (const entry of pending.values()) {
        if (!isWaiting(entry, now)) continue;
        // The same agent signing in again from the same callback: the new flow wins.
        if (entry.request.flowKey === request.flowKey) entry.outcome = { kind: "replaced" };
        else waiting += 1;
      }
      if (waiting >= MAX_WAITING) {
        return {
          kind: "full",
          redirect: answer("temporarily_unavailable", "Too many agents are waiting for approval."),
        } as const;
      }
      const entry: PendingSignIn = {
        requestId: OutsideAgentRequestId.make(randomUUID()),
        pollSecret: randomSecret(),
        matchCode: randomMatchCode(),
        request,
        origin,
        createdAt: now,
        expiresAt: now + Duration.toMillis(WAIT_FOR_USER),
        outcome: { kind: "waiting" },
      };
      pending.set(entry.requestId, entry);
      yield* scheduleExpiry(entry);
      yield* notify;
      return {
        kind: "waiting",
        requestId: entry.requestId,
        pollSecret: entry.pollSecret,
        code: entry.matchCode,
        name: request.client.name,
        restartRedirect: answer("access_denied", "Threadlines restarted. Sign in again."),
      } as const;
    });

  const signInStatus: OutsideAgentSignInShape["signInStatus"] = (input) =>
    Effect.gen(function* () {
      const entry = pending.get(input.requestId);
      if (entry === undefined || !secretsMatch(entry.pollSecret, input.pollSecret)) {
        return { state: input.bootId === bootId ? "gone" : "restarted" } satisfies SignInStatus;
      }
      const now = yield* Clock.currentTimeMillis;
      yield* expireIfDue(entry, now);
      const { request, origin } = entry;
      const refusal = (description: string) =>
        callbackWith(request.redirectUri, {
          error: "access_denied",
          error_description: description,
          state: request.state,
          iss: origin,
        });
      const outcome = entry.outcome;
      switch (outcome.kind) {
        case "waiting":
        case "replaced":
          return { state: outcome.kind } satisfies SignInStatus;
        case "denied":
          return {
            state: "denied",
            redirect: refusal("The user didn't allow this agent in Threadlines."),
          } satisfies SignInStatus;
        case "expired":
          return {
            state: "expired",
            redirect: refusal("Nobody approved this sign-in in time."),
          } satisfies SignInStatus;
        case "approved": {
          if (outcome.code === null) {
            for (const [code, issued] of codes) if (issued.expiresAt <= now) codes.delete(code);
            outcome.code = randomSecret();
            codes.set(outcome.code, {
              request,
              grant: outcome.grant,
              connectionId: outcome.connectionId,
              decision: outcome.decision,
              expiresAt: now + Duration.toMillis(CODE_LIFETIME),
            });
          }
          return {
            state: "approved",
            redirect: callbackWith(request.redirectUri, {
              code: outcome.code,
              state: request.state,
              iss: origin,
            }),
          } satisfies SignInStatus;
        }
      }
    });

  const exchangeCode: OutsideAgentSignInShape["exchangeCode"] = (params) =>
    Effect.gen(function* () {
      const refuse = (error: OAuthErrorCode, description: string): TokenResult => ({
        kind: "refused",
        failure: { error, description },
      });
      const tokenRequest = readTokenRequest(params);
      if (isOAuthFailure(tokenRequest)) return { kind: "refused", failure: tokenRequest } as const;
      const now = yield* Clock.currentTimeMillis;
      // Gone at its first presentation, whatever comes of it.
      const issued = codes.get(tokenRequest.code);
      codes.delete(tokenRequest.code);
      if (issued === undefined || issued.expiresAt <= now) {
        return refuse("invalid_grant", "The code is unknown, used or expired.");
      }
      const { request, grant, connectionId } = issued;
      if (tokenRequest.clientId !== request.clientId) {
        return refuse("invalid_grant", "The code was issued to another client.");
      }
      if (parseLoopbackRedirect(tokenRequest.redirectUri)?.href !== request.redirectUri) {
        return refuse("invalid_grant", "The redirect_uri isn't the one the code was issued for.");
      }
      if (!pkceMatches(tokenRequest.codeVerifier, request.codeChallenge)) {
        return refuse("invalid_grant", "The code_verifier doesn't match the code_challenge.");
      }
      if (tokenRequest.resource !== null && tokenRequest.resource !== request.resource) {
        return refuse("invalid_target", `The resource must be ${request.resource}.`);
      }
      const hash = clientIdHash(request.clientId);
      // Checked and saved together, under the lock a Change or Remove takes:
      // only the newest decision about this agent becomes its connection.
      const saved = yield* Effect.gen(function* () {
        if (latestDecision.get(hash) !== issued.decision) return "superseded" as const;
        return yield* repository
          .insertReplacing({
            connectionId,
            kind: "local",
            signIn: "oauth",
            clientIdHash: hash,
            clientName: request.client.name,
            softwareId: request.client.softwareId,
            redirectUri: request.redirectUri,
            resource: request.resource,
            ...grant,
            tokenGeneration: 1,
            identity: null,
            hostId: null,
            routeTag: null,
            refresh: null,
            keyHash: null,
            createdAt: isoAt(now),
            lastUsedAt: null,
            removedAt: null,
            removedReason: null,
          })
          .pipe(
            Effect.as("saved" as const),
            Effect.catch((cause) =>
              Effect.logWarning("outside agents: couldn't save a connection").pipe(
                Effect.annotateLogs({ cause }),
                Effect.as("failed" as const),
              ),
            ),
          );
      }).pipe(decisionLock.withPermits(1));
      if (saved === "superseded") {
        return refuse(
          "invalid_grant",
          "A newer decision about this agent in Threadlines replaced this approval. Sign in again.",
        );
      }
      if (saved === "failed") {
        return refuse("server_error", "Threadlines couldn't save the connection.");
      }
      yield* notify;
      yield* analytics.record("outside_agent.connected", {
        clientName: clientFamily(request.client.name, request.client.softwareId),
        access: grant.access,
      });
      return {
        kind: "issued",
        accessToken: signer.mintToken({ connectionId, generation: 1, resource: request.resource }),
        scope: scopeForAccess(grant.access),
      } as const;
    });

  // ---------------------------------------------------------------------------
  // `/mcp/connect`
  // ---------------------------------------------------------------------------

  const authenticate: OutsideAgentConnectionsShape["authenticate"] = ({ token, resource }) =>
    Effect.gen(function* () {
      const named = signer.readToken(token, resource);
      if (named === null) return null;
      const row = Option.getOrNull(
        yield* repository.get(OutsideAgentConnectionId.make(named.connectionId)),
      );
      if (
        row === null ||
        row.kind !== "local" ||
        row.removedAt !== null ||
        row.tokenGeneration !== named.generation ||
        row.resource !== resource
      ) {
        return null;
      }
      const now = yield* Clock.currentTimeMillis;
      if (now - millisOf(row.lastUsedAt ?? row.createdAt) > Duration.toMillis(UNUSED_LIMIT)) {
        const removed = yield* repository.markRemoved({
          connectionId: row.connectionId,
          reason: "unused",
          now: isoAt(now),
        });
        if (removed) yield* notify;
        return null;
      }
      if (
        row.lastUsedAt === null ||
        now - millisOf(row.lastUsedAt) >= Duration.toMillis(TOUCH_EVERY)
      ) {
        yield* repository.touch({ connectionId: row.connectionId, now: isoAt(now) });
        yield* notify;
      }
      return { connectionId: row.connectionId, name: row.clientName };
    }).pipe(
      Effect.catchTag("OutsideAgentConnectionRepositoryError", (cause) =>
        Effect.logWarning("outside agents: couldn't check a connection").pipe(
          Effect.annotateLogs({ cause }),
          Effect.as(null),
        ),
      ),
    );

  const grant: OutsideAgentConnectionsShape["grant"] = (connectionId) =>
    repository.get(connectionId).pipe(
      Effect.map((found) => {
        const row = Option.getOrNull(found);
        if (row === null || row.removedAt !== null) return null;
        return {
          connectionId: row.connectionId,
          name: row.clientName,
          access: row.access,
          maxRuntimeMode: row.maxRuntimeMode,
          projectIds: row.projectIds,
        };
      }),
      Effect.catchTag("OutsideAgentConnectionRepositoryError", (cause) =>
        Effect.logWarning("outside agents: couldn't read a connection's grant").pipe(
          Effect.annotateLogs({ cause }),
          Effect.as(null),
        ),
      ),
    );

  return Context.make(OutsideAgentConnections, { authenticate, grant }).pipe(
    Context.add(
      OutsideAgentSignIn,
      OutsideAgentSignIn.of({
        register,
        beginSignIn,
        signInStatus,
        exchangeCode,
        bootId,
        changes,
        approve,
        deny,
        denyAll,
        resumeRequests,
        update,
        remove,
        assistantCode: assistants.createCode,
        assistantCodeCancel: assistants.cancelCode,
        createKey: assistants.createKey,
      }),
    ),
  );
});

/**
 * Both outside-agent services over the connection rows. Needs the database,
 * the server config (its port names the agents' address), telemetry, the
 * secret store (the signing key) and the assistants door (Assistants).
 */
export const OutsideAgentConnectionsLive = Layer.effectContext(makeOutsideAgents).pipe(
  Layer.provide(OutsideAgentConnectionRepositoryLive),
);
