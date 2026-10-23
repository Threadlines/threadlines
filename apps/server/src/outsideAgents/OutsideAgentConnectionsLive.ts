/**
 * Outside agents' connections and sign-in (docs/design/outside-agents.md),
 * over one store: the `outside_agent_connections` rows, and in memory the
 * sign-ins waiting for the user, their authorization codes, Deny all's quiet
 * period and the rate limits.
 *
 * `OutsideAgentConnectionsLive` provides both services:
 * - OutsideAgentConnections, which `/mcp/connect` checks every call against;
 * - OutsideAgentSignIn, behind the OAuth routes (`oauthHttp.ts`) and the
 *   owner-only `outsideAgents.*` RPCs.
 */
// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";

import {
  type OutsideAgentAccess,
  type OutsideAgentConnection,
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
import * as Stream from "effect/Stream";

import {
  SERVER_SIGNING_SECRET_BYTES,
  SERVER_SIGNING_SECRET_NAME,
} from "../auth/Layers/SessionCredentialService.ts";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
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
  type OutsideAgentConnectionRow,
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

const toConnection = (row: OutsideAgentConnectionRow): OutsideAgentConnection => ({
  connectionId: row.connectionId,
  name: row.clientName,
  access: row.access,
  maxRuntimeMode: row.maxRuntimeMode,
  projectIds: row.projectIds,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
});

const storeFailure = new OutsideAgentError({
  detail: "Threadlines couldn't save that change. Try again.",
});

const makeOutsideAgents = Effect.gen(function* () {
  const repository = yield* OutsideAgentConnectionRepository;
  const config = yield* ServerConfig;
  const analytics = yield* AnalyticsService;
  const secretStore = yield* ServerSecretStore;
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

  /** A waiting sign-in past its 5 minutes is expired, whether or not its timer ran yet. */
  const settleExpired = (entry: PendingSignIn, now: number): boolean => {
    if (entry.outcome.kind !== "waiting" || entry.expiresAt > now) return false;
    entry.outcome = { kind: "expired" };
    return true;
  };

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
        settleExpired(entry, now);
        if (entry.outcome.kind !== "waiting") continue;
        const hash = clientIdHash(entry.request.clientId);
        const earlier = rows.find((row) => row.clientIdHash === hash);
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
        connections: rows.map(toConnection),
        pending: waiting,
        quietUntil: quietUntil !== null && quietUntil > now ? isoAt(quietUntil) : null,
      };
    },
  );

  // Subscribes before the first read, so a change can't fall between the two.
  const changes: OutsideAgentSignInShape["changes"] = Stream.unwrap(
    Effect.map(PubSub.subscribe(changed), (subscription) =>
      Stream.concat(Stream.make(undefined), Stream.fromSubscription(subscription)).pipe(
        Stream.mapEffect(() => snapshot),
      ),
    ),
  );

  /** Expires a sign-in when its 5 minutes are up, then forgets it once its page had time to read how it ended. */
  const scheduleExpiry = (entry: PendingSignIn) =>
    Effect.gen(function* () {
      yield* Effect.sleep(WAIT_FOR_USER);
      if (settleExpired(entry, yield* Clock.currentTimeMillis)) yield* notify;
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
    if (entry !== undefined) settleExpired(entry, now);
    return entry?.outcome.kind === "waiting" ? entry : undefined;
  };

  /** Why a grant the user picked can't be given: more than the sign-in asked for, or no projects. */
  const grantRefusal = (grant: OutsideAgentGrant, requested: OutsideAgentAccess | null) => {
    if (requested === "see" && grant.access === "start") {
      return "This agent asked only to see threads, so it can't be allowed to start them.";
    }
    if (grant.projectIds !== null && grant.projectIds.length === 0) {
      return "Pick at least one project, or allow all of them.";
    }
    return null;
  };

  const normalizedGrant = (grant: OutsideAgentGrant): OutsideAgentGrant => ({
    access: grant.access,
    maxRuntimeMode: grant.maxRuntimeMode,
    projectIds: grant.projectIds === null ? null : [...new Set(grant.projectIds)],
  });

  const approve: OutsideAgentSignInShape["approve"] = (input) =>
    Effect.gen(function* () {
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
      entry.outcome = { kind: "approved", grant, connectionId, code: null };
      yield* notify;
      return {
        connectionId,
        name: entry.request.client.name,
        ...grant,
        createdAt: isoAt(now),
        lastUsedAt: null,
      };
    });

  const deny: OutsideAgentSignInShape["deny"] = (input) =>
    Effect.gen(function* () {
      const entry = waitingEntry(input.requestId, yield* Clock.currentTimeMillis);
      if (entry === undefined) return;
      entry.outcome = { kind: "denied" };
      yield* notify;
    });

  const denyAll: OutsideAgentSignInShape["denyAll"] = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const entry of pending.values()) {
      settleExpired(entry, now);
      if (entry.outcome.kind === "waiting") entry.outcome = { kind: "denied" };
    }
    quietUntil = now + Duration.toMillis(QUIET_PERIOD);
    yield* scheduleQuietEnd;
    yield* notify;
  });

  const resumeRequests: OutsideAgentSignInShape["resumeRequests"] = Effect.suspend(() => {
    if (quietUntil === null) return Effect.void;
    quietUntil = null;
    return notify;
  });

  const update: OutsideAgentSignInShape["update"] = (input) =>
    Effect.gen(function* () {
      const refusal = grantRefusal(input, null);
      if (refusal !== null) return yield* new OutsideAgentError({ detail: refusal });
      const row = yield* repository
        .setGrant({ connectionId: input.connectionId, grant: normalizedGrant(input) })
        .pipe(storeError("change a connection"));
      if (Option.isNone(row)) {
        return yield* new OutsideAgentError({ detail: "That connection was removed." });
      }
      yield* notify;
      return toConnection(row.value);
    });

  const remove: OutsideAgentSignInShape["remove"] = (input) =>
    Effect.gen(function* () {
      const removed = yield* repository
        .markRemoved({
          connectionId: input.connectionId,
          reason: "removed",
          now: isoAt(yield* Clock.currentTimeMillis),
        })
        .pipe(storeError("remove a connection"));
      if (removed) yield* notify;
    });

  // ---------------------------------------------------------------------------
  // OAuth
  // ---------------------------------------------------------------------------

  const register: OutsideAgentSignInShape["register"] = (body) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const retryAfterSeconds = takeSlot(registrations, REGISTRATIONS_PER_MINUTE, now);
      if (retryAfterSeconds !== null) return { kind: "limited", retryAfterSeconds } as const;
      const registration = readRegistration(body);
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
        settleExpired(entry, now);
        if (entry.outcome.kind !== "waiting") continue;
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
      if (settleExpired(entry, now)) yield* notify;
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
      const saved = yield* repository
        .insertReplacing({
          connectionId,
          clientIdHash: clientIdHash(request.clientId),
          clientName: request.client.name,
          softwareId: request.client.softwareId,
          redirectUri: request.redirectUri,
          resource: request.resource,
          ...grant,
          tokenGeneration: 1,
          createdAt: isoAt(now),
          lastUsedAt: null,
          removedAt: null,
          removedReason: null,
        })
        .pipe(
          Effect.as(true),
          Effect.catch((cause) =>
            Effect.logWarning("outside agents: couldn't save a connection").pipe(
              Effect.annotateLogs({ cause }),
              Effect.as(false),
            ),
          ),
        );
      if (!saved) return refuse("server_error", "Threadlines couldn't save the connection.");
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
      }),
    ),
  );
});

/**
 * Both outside-agent services over the connection rows. Needs the database,
 * the server config (its port names the agents' address), telemetry and the
 * secret store (the signing key).
 */
export const OutsideAgentConnectionsLive = Layer.effectContext(makeOutsideAgents).pipe(
  Layer.provide(OutsideAgentConnectionRepositoryLive),
);
