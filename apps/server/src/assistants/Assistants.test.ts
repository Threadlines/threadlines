// @effect-diagnostics nodeBuiltinImport:off
import * as Crypto from "node:crypto";

import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  OutsideAgentRequestId,
  type RelayAssistantHostFrame,
  type RelayAssistantRequestFrame,
  type RelayAssistantResponseFrame,
  type RelayAssistantSignIn,
} from "@threadlines/contracts";
import {
  formatAssistantCredential,
  parseAssistantCredential,
  randomAssistantSecret,
} from "@threadlines/shared/assistantCredentials";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type * as NetAddress from "effect/net/NetAddress";
import { Socket } from "effect/socket";

import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { ConnectToolkit, listedToolsFor } from "../outsideAgents/connectTools.ts";
import { OutsideAgentConnections } from "../outsideAgents/OutsideAgentConnections.ts";
import { OutsideAgentConnectionRepositoryLive } from "../outsideAgents/OutsideAgentConnectionRepository.ts";
import { OutsideAgentConnectionsLive } from "../outsideAgents/OutsideAgentConnectionsLive.ts";
import { OutsideAgentSignIn } from "../outsideAgents/OutsideAgentSignIn.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RelayHostLink } from "../relay/RelayHostLink.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import { makeAssistantMcp } from "./AssistantMcp.ts";
import {
  AssistantRelay,
  type AssistantRelayEvent,
  type AssistantRelayShape,
} from "./AssistantRelay.ts";
import { type AssistantHttpResponse, Assistants } from "./Assistants.ts";
import { makeAssistantRelay, makeAssistantRelayWith } from "./AssistantRelayLive.ts";
import { AssistantsLive } from "./AssistantsLive.ts";

const HOST = "8911ad8a-f546-45e5-a2e8-7a6a8adfc65c";
const ORIGIN = "https://connect.threadlines.dev";
const RESOURCE = `${ORIGIN}/mcp`;
const CLIENT_ID = "https://grok.example/oauth/client.json";
const REDIRECT = "https://grok.example/oauth/callback";
const SEE = { access: "see", maxRuntimeMode: "approval-required", projectIds: null } as const;

const pkce = () => {
  const verifier = Crypto.randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: Crypto.createHash("sha256").update(verifier).digest("base64url"),
  };
};

/**
 * The relay as the door sees it: frames go in through `events`, and what the
 * door sends is kept. A request's response resolves its waiter.
 */
const makeFakeRelay = Effect.gen(function* () {
  const events = yield* Queue.unbounded<AssistantRelayEvent>();
  const sent: Array<RelayAssistantHostFrame> = [];
  const answers = new Map<string, Deferred.Deferred<RelayAssistantResponseFrame>>();
  const revoked: Array<string> = [];
  const state = { wanted: false };
  const relay: AssistantRelayShape = {
    available: true,
    hostId: Effect.succeed(HOST),
    info: () => Effect.succeed({ address: RESOURCE, enabled: true }),
    createCode: Effect.succeed({ code: "K4D82PQX", expiresAt: "2099-01-01T00:00:00.000Z" }),
    cancelCode: Effect.void,
    routeTag: () => Effect.sync(() => ({ hostId: HOST, routeTag: randomAssistantSecret() })),
    revoke: ({ connectionIds }) =>
      Effect.sync(() => {
        revoked.push(...connectionIds);
      }),
    setWanted: (wanted) =>
      Effect.sync(() => {
        state.wanted = wanted;
      }),
    events: Stream.fromQueue(events),
    send: (frame) =>
      Effect.gen(function* () {
        sent.push(frame);
        if (frame.type === "response") {
          const waiter = answers.get(frame.id);
          if (waiter !== undefined) yield* Deferred.succeed(waiter, frame);
        }
        return true;
      }),
  };
  let nextId = 0;
  /** A request frame through the socket, and the door's response to it. */
  const ask = (frame: Omit<RelayAssistantRequestFrame, "type" | "id">) =>
    Effect.gen(function* () {
      nextId += 1;
      const id = `request-${nextId}`;
      const answer = yield* Deferred.make<RelayAssistantResponseFrame>();
      answers.set(id, answer);
      Queue.offerUnsafe(events, { type: "frame", frame: { type: "request", id, ...frame } });
      const response = yield* Deferred.await(answer);
      return {
        status: response.status,
        headers: response.headers,
        body:
          response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : null,
      };
    });
  const push = (event: AssistantRelayEvent) => Effect.sync(() => Queue.offerUnsafe(events, event));
  return { relay, sent, revoked, state, ask, push };
});
type FakeRelay = Effect.Success<typeof makeFakeRelay>;

/** The door and the outside-agent services over an in-memory database and the fake relay. */
const startDoor = Effect.gen(function* () {
  const fake = yield* makeFakeRelay;
  const services = yield* Layer.build(
    OutsideAgentConnectionsLive.pipe(
      Layer.provideMerge(
        AssistantsLive.pipe(
          Layer.provide(Layer.succeed(AssistantRelay, fake.relay)),
          Layer.provide(OutsideAgentConnectionRepositoryLive),
        ),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provide(ServerSecretStoreLive),
      Layer.provide(
        Layer.succeed(AnalyticsService, { record: () => Effect.void, flush: Effect.void }),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "assistants-test-" })),
    ),
  );
  return {
    fake,
    assistants: Context.get(services, Assistants),
    signIn: Context.get(services, OutsideAgentSignIn),
    connections: Context.get(services, OutsideAgentConnections),
  };
});
type Door = Effect.Success<typeof startDoor>;

/** Credentials carry Unix seconds of ten digits: the test clock starts on a real day. */
const START = Date.parse("2026-10-30T09:00:00.000Z");

const withDoor = <A, E>(test: (door: Door) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    return yield* test(yield* startDoor);
  }).pipe(Effect.provide(Layer.fresh(NodeServices.layer)), Effect.scoped);

/** Runs `read` until `done` holds of it, letting the door's fibers run in between. */
const until = <A, E>(read: Effect.Effect<A, E>, done: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const value = yield* read;
      if (done(value)) return value;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error("never happened"));
  });

const signInFrame = (signInId: string, patch: Partial<RelayAssistantSignIn> = {}) =>
  Effect.map(Clock.currentTimeMillis, (now) => ({
    type: "signin" as const,
    signIn: {
      signInId,
      clientId: CLIENT_ID,
      clientName: "Grok Bot",
      identity: { kind: "cimd" as const, host: "grok.example", known: true },
      redirectUri: REDIRECT,
      scopes: ["threads:read" as const, "threads:start" as const],
      codeChallenge: patch.codeChallenge ?? pkce().challenge,
      resource: RESOURCE,
      issuer: ORIGIN,
      place: { city: "Austin", country: "US" },
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 10 * 60_000).toISOString(),
      ...patch,
    },
  }));

/** An assistant's page typed the code, and the user allowed it: the authorization code the page got. */
const allowSignIn = (door: Door, signInId: string, challenge: string) =>
  Effect.gen(function* () {
    yield* door.fake.push({
      type: "frame",
      frame: yield* signInFrame(signInId, { codeChallenge: challenge }),
    });
    yield* until(door.assistants.state, (state) =>
      state.signIns.some((waiting) => waiting.requestId === signInId),
    );
    yield* door.signIn.approve({ requestId: OutsideAgentRequestId.make(signInId), ...SEE });
    const decision = door.fake.sent.find(
      (frame) => frame.type === "signin.decision" && frame.signInId === signInId,
    );
    if (decision?.type !== "signin.decision" || decision.decision !== "allow") {
      return yield* Effect.die(new Error("no allow decision"));
    }
    return decision.authorizationCode;
  });

const exchange = (fake: FakeRelay, code: string, params: Record<string, string>) =>
  fake.ask({
    route: "token",
    credential: code,
    resource: RESOURCE,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      ...params,
    }).toString(),
  });

const refresh = (fake: FakeRelay, refreshToken: string) =>
  fake.ask({
    route: "token",
    credential: refreshToken,
    resource: RESOURCE,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  });

/** A full sign-in: its tokens and connection id. */
const connect = (door: Door, signInId: string) =>
  Effect.gen(function* () {
    const { verifier, challenge } = pkce();
    const code = yield* allowSignIn(door, signInId, challenge);
    const answer = yield* exchange(door.fake, code, {
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(answer.status).toBe(200);
    const body = answer.body as Record<string, string>;
    const parsed = parseAssistantCredential(body.access_token ?? "");
    if (parsed === null) return yield* Effect.die(new Error("no access token"));
    return {
      accessToken: body.access_token!,
      refreshToken: body.refresh_token!,
      connectionId: parsed.route.connectionId,
    };
  });

const authenticate = (door: Door, credential: string) =>
  door.assistants.authenticate({ credential, resource: RESOURCE });

describe("assistants: sign-in", () => {
  it.effect("shows a sign-in from the relay, and Allow's code exchanges once, with PKCE", () =>
    withDoor((door) =>
      Effect.gen(function* () {
        yield* door.fake.push({ type: "frame", frame: yield* signInFrame("sign-in-1") });
        const snapshot = yield* until(
          Stream.runHead(door.signIn.changes).pipe(Effect.map(Option.getOrThrow)),
          (value) => value.assistants.signIns.length === 1,
        );
        expect(snapshot.assistants.signIns[0]).toMatchObject({
          requestId: "sign-in-1",
          name: "Grok Bot",
          identity: { host: "grok.example", verified: true, known: true },
          place: "Austin, US",
          requestedAccess: "start",
          replaces: null,
        });
        // The socket stays open while a sign-in waits.
        expect(door.fake.state.wanted).toBe(true);

        // A wrong redirect is refused, and uses the code up.
        const first = pkce();
        const firstCode = yield* allowSignIn(door, "sign-in-2", first.challenge);
        const wrongRedirect = yield* exchange(door.fake, firstCode, {
          code_verifier: first.verifier,
          redirect_uri: "https://evil.example/callback",
        });
        expect(wrongRedirect).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
        expect(wrongRedirect.headers["cache-control"]).toBe("no-store");
        const afterRefusal = yield* exchange(door.fake, firstCode, {
          code_verifier: first.verifier,
        });
        expect(afterRefusal.body).toMatchObject({ error: "invalid_grant" });

        // A verifier that doesn't match the challenge is refused.
        const second = pkce();
        const secondCode = yield* allowSignIn(door, "sign-in-3", second.challenge);
        const wrongVerifier = yield* exchange(door.fake, secondCode, {
          code_verifier: pkce().verifier,
        });
        expect(wrongVerifier.body).toMatchObject({ error: "invalid_grant" });

        // The right one works once.
        const third = pkce();
        const thirdCode = yield* allowSignIn(door, "sign-in-4", third.challenge);
        const issued = yield* exchange(door.fake, thirdCode, { code_verifier: third.verifier });
        expect(issued.status).toBe(200);
        expect(issued.body).toMatchObject({
          token_type: "Bearer",
          expires_in: 3600,
          scope: "threads:read",
        });
        expect(
          (yield* exchange(door.fake, thirdCode, { code_verifier: third.verifier })).body,
        ).toMatchObject({ error: "invalid_grant" });
        const listed = yield* until(
          Stream.runHead(door.signIn.changes).pipe(Effect.map(Option.getOrThrow)),
          (value) => value.connections.length === 1,
        );
        expect(listed.connections[0]).toMatchObject({
          kind: "assistant",
          signIn: "oauth",
          identity: { host: "grok.example", verified: true, known: true },
          access: "see",
        });
      }),
    ),
  );

  it.effect("stays on the relay until an approved code is traded or can't be", () =>
    withDoor((door) =>
      Effect.gen(function* () {
        const first = pkce();
        const firstCode = yield* allowSignIn(door, "sign-in-1", first.challenge);
        // Nothing waits and nothing is connected yet, but the assistant's
        // token request is still to come through the relay.
        expect(door.fake.state.wanted).toBe(true);
        const issued = yield* exchange(door.fake, firstCode, { code_verifier: first.verifier });
        expect(issued.status).toBe(200);
        expect(door.fake.state.wanted).toBe(true);

        yield* door.signIn.remove({
          connectionId: (yield* until(
            Stream.runHead(door.signIn.changes).pipe(Effect.map(Option.getOrThrow)),
            (value) => value.connections.length === 1,
          )).connections[0]!.connectionId,
        });
        const second = pkce();
        yield* allowSignIn(door, "sign-in-2", second.challenge);
        expect(door.fake.state.wanted).toBe(true);
        yield* TestClock.adjust("61 seconds");
        yield* until(
          Effect.sync(() => door.fake.state.wanted),
          (wanted) => !wanted,
        );
      }),
    ),
  );

  it.effect("Deny answers deny; Deny all denies the waiting and, for a while, new ones", () =>
    withDoor((door) =>
      Effect.gen(function* () {
        const decisionFor = (signInId: string) =>
          door.fake.sent.find(
            (frame) => frame.type === "signin.decision" && frame.signInId === signInId,
          );
        yield* door.fake.push({ type: "frame", frame: yield* signInFrame("denied") });
        yield* until(door.assistants.state, (state) => state.signIns.length === 1);
        yield* door.signIn.deny({ requestId: OutsideAgentRequestId.make("denied") });
        expect(decisionFor("denied")).toMatchObject({ decision: "deny" });
        expect((yield* door.assistants.state).signIns).toHaveLength(0);

        yield* door.fake.push({ type: "frame", frame: yield* signInFrame("waiting") });
        yield* until(door.assistants.state, (state) => state.signIns.length === 1);
        yield* door.signIn.denyAll;
        expect(decisionFor("waiting")).toMatchObject({ decision: "deny" });
        yield* door.fake.push({ type: "frame", frame: yield* signInFrame("during-quiet") });
        yield* until(
          Effect.sync(() => decisionFor("during-quiet")),
          (found) => found !== undefined,
        );
        expect(decisionFor("during-quiet")).toMatchObject({ decision: "deny" });
        expect((yield* door.assistants.state).signIns).toHaveLength(0);

        yield* door.signIn.resumeRequests;
        yield* door.fake.push({ type: "frame", frame: yield* signInFrame("after-quiet") });
        yield* until(door.assistants.state, (state) => state.signIns.length === 1);
      }),
    ),
  );
});

describe("assistants: credentials", () => {
  it.effect(
    "refresh rotates; the previous generation gets the same successor until both limits pass",
    () =>
      withDoor((door) =>
        Effect.gen(function* () {
          const first = yield* connect(door, "sign-in");
          expect(yield* authenticate(door, first.accessToken)).toMatchObject({
            connectionId: first.connectionId,
          });
          const rotated = yield* refresh(door.fake, first.refreshToken);
          expect(rotated.status).toBe(200);
          const next = rotated.body as Record<string, string>;
          expect(parseAssistantCredential(next.refresh_token!)).toMatchObject({ generation: 1 });

          // A lost reply: the old token again gets the same successor, even much later while it's unused.
          expect((yield* refresh(door.fake, first.refreshToken)).body).toMatchObject({
            refresh_token: next.refresh_token,
          });
          yield* TestClock.adjust("11 minutes");
          expect((yield* refresh(door.fake, first.refreshToken)).body).toMatchObject({
            refresh_token: next.refresh_token,
          });

          // Once the successor is used and the 10 minutes are past, the old one is a theft signal.
          expect(yield* authenticate(door, next.access_token!)).not.toBeNull();
          const reused = yield* refresh(door.fake, first.refreshToken);
          expect(reused.body).toMatchObject({ error: "invalid_grant" });
          expect(yield* authenticate(door, next.access_token!)).toBeNull();
          yield* until(
            Effect.sync(() => door.fake.revoked),
            (revoked) => revoked.includes(first.connectionId),
          );
        }),
      ),
  );

  it.effect(
    "two refreshes race: the loser gets the winner's successor and the connection stays",
    () =>
      withDoor((door) =>
        Effect.gen(function* () {
          const first = yield* connect(door, "sign-in");
          const winner = (yield* refresh(door.fake, first.refreshToken)).body as Record<
            string,
            string
          >;
          // The winner uses its new access token before the loser arrives.
          expect(yield* authenticate(door, winner.access_token!)).not.toBeNull();
          const loser = yield* refresh(door.fake, first.refreshToken);
          expect(loser.body).toMatchObject({ refresh_token: winner.refresh_token });
          expect(yield* authenticate(door, winner.access_token!)).not.toBeNull();

          // Access tokens live an hour.
          yield* TestClock.adjust("61 minutes");
          expect(yield* authenticate(door, winner.access_token!)).toBeNull();

          // An older generation than the previous one removes the connection.
          const second = (yield* refresh(door.fake, winner.refresh_token!)).body as Record<
            string,
            string
          >;
          expect(parseAssistantCredential(second.refresh_token!)).toMatchObject({ generation: 2 });
          expect((yield* refresh(door.fake, first.refreshToken)).body).toMatchObject({
            error: "invalid_grant",
          });
          expect((yield* refresh(door.fake, second.refresh_token!)).body).toMatchObject({
            error: "invalid_grant",
          });
          yield* until(
            Effect.sync(() => door.fake.revoked),
            (revoked) => revoked.includes(first.connectionId),
          );
        }),
      ),
  );

  it.effect(
    "a key works by its hash; after Remove its next call is refused and the relay is told",
    () =>
      withDoor((door) =>
        Effect.gen(function* () {
          const made = yield* door.signIn.createKey({ name: "Muse", ...SEE });
          expect(made.address).toBe(RESOURCE);
          expect(made.connection).toMatchObject({
            kind: "assistant",
            signIn: "key",
            identity: null,
          });
          expect(yield* authenticate(door, made.key)).toMatchObject({ name: "Muse" });
          const parsed = parseAssistantCredential(made.key);
          if (parsed?.kind !== "key") return yield* Effect.die(new Error("not a key"));
          const forged = formatAssistantCredential({ ...parsed, secret: randomAssistantSecret() });
          expect(yield* authenticate(door, forged)).toBeNull();
          // Bound to the resource it was made for.
          expect(
            yield* door.assistants.authenticate({
              credential: made.key,
              resource: "https://elsewhere.example/mcp",
            }),
          ).toBeNull();

          yield* door.signIn.remove({ connectionId: made.connection.connectionId });
          expect(yield* authenticate(door, made.key)).toBeNull();
          yield* until(
            Effect.sync(() => door.fake.revoked),
            (revoked) => revoked.includes(made.connection.connectionId),
          );
        }),
      ),
  );

  it.effect("the local door and the assistants door refuse each other's credentials", () =>
    withDoor((door) =>
      Effect.gen(function* () {
        const assistant = yield* connect(door, "sign-in");
        expect(
          yield* door.connections.authenticate({
            token: assistant.accessToken,
            resource: "http://127.0.0.1:3773/mcp/connect",
          }),
        ).toBeNull();
        expect(
          yield* door.connections.authenticate({
            token: assistant.accessToken,
            resource: RESOURCE,
          }),
        ).toBeNull();
        // A local agent's token, in its own format, naming the assistant's connection.
        expect(
          yield* authenticate(door, `tlc1.${assistant.connectionId}.1.${randomAssistantSecret()}`),
        ).toBeNull();
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// AssistantMcp
// ---------------------------------------------------------------------------

const CALLERS = {
  "see-token": { connectionId: "see", name: "Grok Bot" },
  "start-token": { connectionId: "start", name: "Claude Duet" },
} as const;

/** The handler over two callers (one may see, one may start) and tools that answer at once. */
const makeMcp = (options: { readonly fits?: (response: AssistantHttpResponse) => boolean } = {}) =>
  makeAssistantMcp({
    authenticate: ({ credential }) =>
      Effect.succeed(
        credential in CALLERS ? (CALLERS[credential as keyof typeof CALLERS] as never) : null,
      ),
    listed: (caller) =>
      Effect.succeed(listedToolsFor(caller.connectionId === "see" ? "see" : "start")),
    tools: Object.values(ConnectToolkit.tools).map((tool) => ({
      tool,
      ...(tool.name === "thread_start" ? { required: ["requestId"] } : {}),
      run: (caller) =>
        Effect.succeed(
          tool.name === "projects"
            ? {
                outcome: "ok",
                projects: [
                  { projectId: "app", name: `app for ${caller.name}`, folder: "/repos/app" },
                ],
              }
            : { outcome: "not_allowed", detail: "Not in this test." },
        ),
    })),
    serverInfo: { name: "threadlines", title: "Threadlines", version: "0.0.0-test" },
    fits: options.fits ?? (() => true),
  });

const rpc = (
  handler: ReturnType<typeof makeMcp>,
  message: unknown,
  headers: Record<string, string> = {},
  credential = "see-token",
) =>
  Effect.map(
    handler({
      credential,
      resource: RESOURCE,
      headers: { "content-type": "application/json", ...headers },
      body: typeof message === "string" ? message : JSON.stringify(message),
    }),
    (response) => ({
      status: response.status,
      headers: response.headers,
      body:
        response.body.length > 0
          ? (JSON.parse(response.body) as {
              readonly result?: Record<string, unknown>;
              readonly error?: { readonly code: number; readonly data?: unknown };
            })
          : null,
    }),
  );

const MODERN = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
const modernHeaders = (method: string, name?: string) => ({
  "mcp-protocol-version": "2026-07-28",
  "mcp-method": method,
  ...(name !== undefined ? { "mcp-name": name } : {}),
});

describe("AssistantMcp", () => {
  it.effect("2025-06-18: initialize, a notification, then tools/call under any session id", () =>
    Effect.gen(function* () {
      const handler = makeMcp();
      const opened = yield* rpc(handler, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      });
      expect(opened.body?.result).toMatchObject({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "threadlines" },
      });
      expect(opened.headers["mcp-session-id"]).toMatch(/.+/u);
      const initialized = yield* rpc(handler, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      expect(initialized).toMatchObject({ status: 202, body: null });
      const called = yield* rpc(
        handler,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "projects", arguments: {} },
        },
        { "mcp-session-id": "one-it-never-gave" },
      );
      expect(called.body?.result).toMatchObject({
        isError: false,
        structuredContent: { outcome: "ok", projects: [{ name: "app for Grok Bot" }] },
      });
    }),
  );

  it.effect("an initialize offering a newer version than it speaks gets 2025-06-18", () =>
    Effect.gen(function* () {
      const opened = yield* rpc(makeMcp(), {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      });
      expect(opened.status).toBe(200);
      expect(opened.body?.result).toMatchObject({ protocolVersion: "2025-06-18" });
    }),
  );

  it.effect(
    "2026-07-28: server/discover, and UnsupportedProtocolVersion for an unknown _meta version",
    () =>
      Effect.gen(function* () {
        const handler = makeMcp();
        const discovered = yield* rpc(
          handler,
          { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: MODERN } },
          modernHeaders("server/discover"),
        );
        expect(discovered.body?.result).toMatchObject({
          resultType: "complete",
          supportedVersions: ["2026-07-28", "2025-06-18"],
          capabilities: { tools: {} },
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "threadlines" } },
        });
        const unknown = yield* rpc(
          handler,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2027-01-01" } },
          },
          { ...modernHeaders("tools/list"), "mcp-protocol-version": "2027-01-01" },
        );
        expect(unknown.status).toBe(400);
        expect(unknown.body?.error).toMatchObject({
          code: -32022,
          data: { supported: ["2026-07-28", "2025-06-18"], requested: "2027-01-01" },
        });
        const called = yield* rpc(
          handler,
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "projects", arguments: {}, _meta: MODERN },
          },
          modernHeaders("tools/call", "projects"),
        );
        expect(called.body?.result).toMatchObject({ resultType: "complete", isError: false });
      }),
  );

  it.effect("refuses headers that don't match the body, and batches", () =>
    Effect.gen(function* () {
      const handler = makeMcp();
      const call = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "projects", arguments: {}, _meta: MODERN },
      };
      const wrongMethod = yield* rpc(handler, call, modernHeaders("tools/list", "projects"));
      expect(wrongMethod.status).toBe(400);
      expect(wrongMethod.body?.error).toMatchObject({ code: -32020 });
      const wrongName = yield* rpc(handler, call, modernHeaders("tools/call", "thread_start"));
      expect(wrongName.body?.error).toMatchObject({ code: -32020 });
      const noVersionHeader = yield* rpc(handler, call, {
        "mcp-method": "tools/call",
        "mcp-name": "projects",
      });
      expect(noVersionHeader.body?.error).toMatchObject({ code: -32020 });
      // A name sent in the header's base64 form is decoded before it's compared.
      const encoded = yield* rpc(
        handler,
        call,
        modernHeaders("tools/call", `=?base64?${Buffer.from("projects").toString("base64")}?=`),
      );
      expect(encoded.body?.result).toMatchObject({ isError: false });

      const batch = yield* rpc(handler, [call, call]);
      expect(batch.status).toBe(400);
      expect(batch.body?.error).toMatchObject({ code: -32600 });
    }),
  );

  it.effect("lists what the grant allows, in a fixed order, with this door's requirements", () =>
    Effect.gen(function* () {
      const handler = makeMcp();
      const names = (body: { readonly result?: Record<string, unknown> } | null) =>
        ((body?.result?.tools ?? []) as Array<{ readonly name: string }>).map((tool) => tool.name);
      const see = yield* rpc(handler, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(names(see.body)).toEqual([
        "projects",
        "agents",
        "threads_list",
        "thread_read",
        "thread_wait",
        "inbox",
        "thread_changes",
      ]);
      const start = yield* rpc(
        handler,
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: MODERN } },
        modernHeaders("tools/list"),
        "start-token",
      );
      expect(names(start.body)).toEqual([
        "projects",
        "agents",
        "threads_list",
        "thread_read",
        "thread_wait",
        "inbox",
        "thread_changes",
        "thread_start",
        "thread_send",
        "thread_stop",
      ]);
      expect(start.body?.result).toMatchObject({
        ttlMs: 300_000,
        cacheScope: "private",
        resultType: "complete",
      });
      const tools = start.body?.result?.tools as ReadonlyArray<{
        readonly name: string;
        readonly title?: unknown;
        readonly inputSchema: {
          readonly type?: unknown;
          readonly required?: ReadonlyArray<string>;
        };
        readonly annotations?: unknown;
      }>;
      for (const tool of tools) {
        expect(tool.inputSchema.type, tool.name).toBe("object");
        expect(typeof tool.title, tool.name).toBe("string");
        expect(tool.annotations, tool.name).toMatchObject({ destructiveHint: false });
      }
      for (const name of ["inbox", "thread_changes"]) {
        expect(tools.find((tool) => tool.name === name)?.annotations, name).toMatchObject({
          readOnlyHint: true,
        });
      }
      expect(tools.find((tool) => tool.name === "thread_start")?.inputSchema.required).toContain(
        "requestId",
      );
    }),
  );

  it.effect(
    "answers 401 pointing at the resource metadata, and a too-large result as a tool error",
    () =>
      Effect.gen(function* () {
        const refused = yield* rpc(
          makeMcp(),
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          {},
          "tlaa1.junk",
        );
        expect(refused.status).toBe(401);
        expect(refused.headers["www-authenticate"]).toBe(
          `Bearer error="invalid_token", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
        );
        const small = makeMcp({ fits: (response) => response.body.length < 100 });
        const tooLarge = yield* rpc(small, {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "projects", arguments: {} },
        });
        expect(tooLarge.body?.result).toMatchObject({ isError: true });
        expect(JSON.stringify(tooLarge.body?.result)).toContain("too large");
      }),
  );
});

describe("the assistant socket", () => {
  it.live(
    "authenticates with the host secret, skips frames it doesn't know, answers, and reconnects",
    () =>
      Effect.gen(function* () {
        const relaySide = {
          sockets: 0,
          protocols: [] as Array<string>,
          received: [] as Array<string>,
          write: null as
            | ((chunk: string | Socket.CloseEvent) => Effect.Effect<void, Socket.SocketError>)
            | null,
        };
        const server = yield* HttpRouter.serve(
          HttpRouter.add(
            "GET",
            "/v2/hosts/:hostId/assistants/socket",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              relaySide.protocols.push(request.headers["sec-websocket-protocol"] ?? "");
              const socket = yield* request.upgrade;
              // Take the reader first: writes wait until one is taken.
              const reader = yield* socket.reader;
              const writer = yield* socket.writer;
              const running = yield* Effect.gen(function* () {
                while (true) {
                  for (const data of yield* reader.pull) {
                    relaySide.received.push(
                      typeof data === "string" ? data : new TextDecoder().decode(data),
                    );
                  }
                }
              }).pipe(Effect.ignore, Effect.forkChild);
              relaySide.sockets += 1;
              relaySide.write = writer.write;
              yield* Fiber.join(running);
              return HttpServerResponse.empty();
            }).pipe(Effect.scoped),
          ),
          { disableListenLog: true, disableLogger: true },
        ).pipe(
          Layer.provideMerge(
            NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
          ),
          Layer.build,
        );
        const port = (Context.get(server, HttpServer.HttpServer).address as NetAddress.InetAddress)
          .port;
        const relay = yield* makeAssistantRelay.pipe(
          Effect.provideService(RelayHostLink, {
            relayOrigin: `http://127.0.0.1:${port}`,
            credentials: Effect.succeed({ hostId: HOST, hostSecret: "host-secret-1" }),
            register: Effect.succeed({ hostId: HOST, hostSecret: "host-secret-1" }),
            forgetHost: () => Effect.void,
            keepOnline: () => Effect.void,
          }),
        );
        const seen: Array<AssistantRelayEvent> = [];
        yield* relay.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
          Effect.forkScoped,
        );
        const eventually = (done: () => boolean) =>
          Effect.gen(function* () {
            for (let waited = 0; waited < 5_000 && !done(); waited += 10) yield* Effect.sleep(10);
            expect(done()).toBe(true);
          });

        yield* relay.setWanted(true);
        yield* eventually(() => seen.some((event) => event.type === "open"));
        expect(relaySide.protocols[0]).toContain("threadlines-token.host-secret-1");

        yield* relaySide.write!(JSON.stringify({ type: "mystery", id: "x" }));
        yield* relaySide.write!(
          JSON.stringify({
            type: "request",
            id: "request-1",
            route: "mcp",
            credential: "tlak1.credential",
            resource: RESOURCE,
            headers: {},
            body: "{}",
          }),
        );
        yield* eventually(() => seen.some((event) => event.type === "frame"));
        expect(seen.filter((event) => event.type === "frame")).toMatchObject([
          { frame: { type: "request", id: "request-1" } },
        ]);
        expect(
          yield* relay.send({
            type: "response",
            id: "request-1",
            status: 200,
            headers: {},
            body: "",
          }),
        ).toBe(true);
        yield* eventually(() => relaySide.received.some((frame) => frame.includes("request-1")));

        // The relay drops the socket: it connects again on its own.
        yield* relaySide.write!(new Socket.CloseEvent(1001, "Relay restarting."));
        yield* eventually(() => seen.some((event) => event.type === "closed"));
        yield* eventually(() => relaySide.sockets === 2);
        yield* relay.setWanted(false);
      }).pipe(Effect.provide(Layer.fresh(NodeServices.layer)), Effect.scoped),
  );

  it.live("starts over when a socket goes quiet before anything came back", () =>
    Effect.gen(function* () {
      let sockets = 0;
      // A relay that takes the socket and then never sends a thing, pongs included.
      const server = yield* HttpRouter.serve(
        HttpRouter.add(
          "GET",
          "/v2/hosts/:hostId/assistants/socket",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const socket = yield* request.upgrade;
            const reader = yield* socket.reader;
            sockets += 1;
            yield* Effect.gen(function* () {
              while (true) yield* reader.pull;
            }).pipe(Effect.ignore);
            return HttpServerResponse.empty();
          }).pipe(Effect.scoped),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
        ),
        Layer.build,
      );
      const port = (Context.get(server, HttpServer.HttpServer).address as NetAddress.InetAddress)
        .port;
      const relay = yield* makeAssistantRelayWith({
        pingIntervalMs: 50,
        silenceTimeoutMs: 300,
      }).pipe(
        Effect.provideService(RelayHostLink, {
          relayOrigin: `http://127.0.0.1:${port}`,
          credentials: Effect.succeed({ hostId: HOST, hostSecret: "host-secret-1" }),
          register: Effect.succeed({ hostId: HOST, hostSecret: "host-secret-1" }),
          forgetHost: () => Effect.void,
          keepOnline: () => Effect.void,
        }),
      );
      yield* relay.setWanted(true);
      for (let waited = 0; waited < 5_000 && sockets < 2; waited += 10) yield* Effect.sleep(10);
      expect(sockets).toBeGreaterThanOrEqual(2);
      yield* relay.setWanted(false);
    }).pipe(Effect.provide(Layer.fresh(NodeServices.layer)), Effect.scoped),
  );
});
