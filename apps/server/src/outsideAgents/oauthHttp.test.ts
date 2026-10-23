import * as Crypto from "node:crypto";
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  type OutsideAgentAccess,
  OutsideAgentRequestId,
  OutsideAgentsSnapshot,
  ProjectId,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { browserApiCorsLayer } from "../http.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import { outsideAgentSignInRouteLayer } from "./oauthHttp.ts";
import { OutsideAgentConnections } from "./OutsideAgentConnections.ts";
import { OutsideAgentConnectionsLive } from "./OutsideAgentConnectionsLive.ts";
import { OutsideAgentSignIn } from "./OutsideAgentSignIn.ts";

const CALLBACK = "http://127.0.0.1:5571/callback";

/**
 * The sign-in routes over real HTTP and an in-memory database, with the
 * server config naming the port they listen on (their Host check needs it).
 */
const startSignIn = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const port = (server.address as HttpServer.TcpAddress).port;
  const recorded: Array<{ readonly event: string; readonly properties: unknown }> = [];
  const config = Layer.effect(
    ServerConfig,
    Effect.map(Effect.service(ServerConfig), (base) => ({ ...base, port })),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "outside-agents-test-" })));
  const services = yield* Layer.build(
    OutsideAgentConnectionsLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provide(ServerSecretStoreLive),
      Layer.provide(
        Layer.succeed(AnalyticsService, {
          record: (event, properties) => Effect.sync(() => recorded.push({ event, properties })),
          flush: Effect.void,
        }),
      ),
      Layer.provideMerge(config),
    ),
  );
  yield* HttpRouter.serve(outsideAgentSignInRouteLayer.pipe(Layer.provide(browserApiCorsLayer)), {
    disableLogger: true,
    disableListenLog: true,
  }).pipe(Layer.provide(Layer.succeedContext(services)), Layer.build);
  const origin = `http://127.0.0.1:${port}`;
  return {
    port,
    origin,
    resource: `${origin}/mcp/connect`,
    recorded,
    signIn: Context.get(services, OutsideAgentSignIn),
    connections: Context.get(services, OutsideAgentConnections),
    sql: Context.get(services, SqlClient.SqlClient),
  };
});
type SignInServer = Effect.Success<typeof startSignIn>;

const call = (url: string, init?: RequestInit) =>
  Effect.promise(() => fetch(url, { redirect: "manual", ...init }));
const readJson = (response: Response) =>
  Effect.promise(() => response.json() as Promise<Record<string, unknown>>);

/** A request with headers `fetch` won't send as given (Host). */
const rawGet = (port: number, path: string, headers: Record<string, string>) =>
  Effect.promise(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = NodeHttp.request(
          { host: "127.0.0.1", port, path, method: "GET", headers },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        request.on("error", reject);
        request.end();
      }),
  );

const register = (server: SignInServer, body: Record<string, unknown>) =>
  Effect.gen(function* () {
    const response = yield* call(`${server.origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: yield* readJson(response) };
  });

const registerClient = (server: SignInServer, name = "Claude Code", redirect = CALLBACK) =>
  register(server, { client_name: name, redirect_uris: [redirect] }).pipe(
    Effect.map(({ body }) => String(body.client_id)),
  );

const pkce = () => {
  const verifier = Crypto.randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: Crypto.createHash("sha256").update(verifier).digest("base64url"),
  };
};

const authorizeUrl = (
  server: SignInServer,
  input: {
    readonly clientId: string;
    readonly challenge: string;
    readonly redirect?: string;
    readonly scope?: string;
    readonly extra?: Record<string, string>;
  },
) =>
  `${server.origin}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirect ?? CALLBACK,
    state: "agent-state",
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    resource: server.resource,
    scope: input.scope ?? "threads:read threads:start",
    ...input.extra,
  }).toString()}`;

/** The waiting page's status URL, as its script reads it. */
const statusUrlOf = (html: string) => {
  const config = /<script type="application\/json" id="sign-in-config">(.*?)<\/script>/su.exec(
    html,
  );
  assert.isNotNull(config);
  return String((JSON.parse(config?.[1] ?? "{}") as { status: string }).status);
};

/** Opens the authorize URL as the browser would; returns the waiting sign-in. */
const openSignIn = (server: SignInServer, url: string) =>
  Effect.gen(function* () {
    const response = yield* call(url);
    assert.equal(response.status, 200);
    const status = `${server.origin}${statusUrlOf(yield* Effect.promise(() => response.text()))}`;
    const requestId = OutsideAgentRequestId.make(new URL(status).searchParams.get("request") ?? "");
    return { status, requestId };
  });

const pollStatus = (status: string) =>
  call(status, { headers: { "sec-fetch-site": "same-origin" } }).pipe(Effect.flatMap(readJson));

const exchange = (server: SignInServer, params: Record<string, string>) =>
  Effect.gen(function* () {
    const response = yield* call(`${server.origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    return { status: response.status, body: yield* readJson(response) };
  });

/**
 * One agent's whole sign-in, approved with `access`: registration (unless a
 * client id is given), the page, the user's Allow, the code and the token.
 */
const signInAgent = (
  server: SignInServer,
  options: {
    readonly clientId?: string;
    readonly access?: OutsideAgentAccess;
    readonly name?: string;
    readonly redirect?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const clientId = options.clientId ?? (yield* registerClient(server, options.name));
    const { verifier, challenge } = pkce();
    const redirect = options.redirect ?? CALLBACK;
    const waiting = yield* openSignIn(
      server,
      authorizeUrl(server, { clientId, challenge, redirect }),
    );
    yield* server.signIn.approve({
      requestId: waiting.requestId,
      access: options.access ?? "start",
      maxRuntimeMode: "approval-required",
      projectIds: null,
    });
    const status = yield* pollStatus(waiting.status);
    assert.equal(status.state, "approved");
    const code = new URL(String(status.redirect)).searchParams.get("code") ?? "";
    const token = yield* exchange(server, {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource: server.resource,
    });
    assert.equal(token.status, 200);
    return { clientId, token: String(token.body.access_token), scope: token.body.scope };
  });

const encodeSnapshot = Schema.encodeUnknownEffect(OutsideAgentsSnapshot);
const latestSnapshot = (server: SignInServer) =>
  Stream.runHead(server.signIn.changes).pipe(
    Effect.map(Option.getOrThrow),
    // What the RPC sends: it must encode as the contract says.
    Effect.tap(encodeSnapshot),
  );

const withServer = <A, E>(test: (server: SignInServer) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* test(yield* startSignIn);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0 }),
        NodeServices.layer,
      ),
    ),
    Effect.scoped,
  );

describe("outside agents' OAuth", () => {
  it.effect("signs in through the MCP SDK client's own discovery, registration and exchange", () =>
    withServer((server) =>
      Effect.gen(function* () {
        const resourceMetadata = yield* call(
          `${server.origin}/.well-known/oauth-protected-resource/mcp/connect`,
        ).pipe(Effect.flatMap(readJson));
        assert.deepStrictEqual(resourceMetadata, {
          resource: server.resource,
          authorization_servers: [server.origin],
          bearer_methods_supported: ["header"],
          scopes_supported: ["threads:read", "threads:start"],
        });
        const serverMetadata = yield* call(
          `${server.origin}/.well-known/oauth-authorization-server`,
        ).pipe(Effect.flatMap(readJson));
        assert.deepStrictEqual(serverMetadata, {
          issuer: server.origin,
          authorization_endpoint: `${server.origin}/oauth/authorize`,
          token_endpoint: `${server.origin}/oauth/token`,
          registration_endpoint: `${server.origin}/oauth/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["threads:read", "threads:start"],
          authorization_response_iss_parameter_supported: true,
        });

        // What Claude Code does: the SDK's auth(), with a loopback callback.
        let client: OAuthClientInformationMixed | undefined;
        let tokens: OAuthTokens | undefined;
        let verifier = "";
        let opened: URL | undefined;
        const callback = "http://127.0.0.1:61234/callback";
        const provider: OAuthClientProvider = {
          get redirectUrl() {
            return callback;
          },
          get clientMetadata() {
            return {
              client_name: "Claude Code (threadlines)",
              redirect_uris: [callback],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            };
          },
          state: () => "sdk-state",
          clientInformation: () => client,
          saveClientInformation: (information) => {
            client = information;
          },
          tokens: () => tokens,
          saveTokens: (saved) => {
            tokens = saved;
          },
          redirectToAuthorization: (url) => {
            opened = url;
          },
          saveCodeVerifier: (saved) => {
            verifier = saved;
          },
          codeVerifier: () => verifier,
        };
        const serverUrl = server.resource;
        assert.equal(yield* Effect.promise(() => auth(provider, { serverUrl })), "REDIRECT");
        assert.isDefined(opened);
        const waiting = yield* openSignIn(server, String(opened));
        yield* server.signIn.approve({
          requestId: waiting.requestId,
          access: "start",
          maxRuntimeMode: "auto",
          projectIds: null,
        });
        const answer = new URL(String((yield* pollStatus(waiting.status)).redirect));
        assert.equal(answer.searchParams.get("state"), "sdk-state");
        assert.equal(answer.searchParams.get("iss"), server.origin);
        const code = answer.searchParams.get("code") ?? "";
        assert.equal(
          yield* Effect.promise(() => auth(provider, { serverUrl, authorizationCode: code })),
          "AUTHORIZED",
        );
        assert.equal(tokens?.scope, "threads:read threads:start");
        assert.isUndefined(tokens?.refresh_token);
        assert.isUndefined(tokens?.expires_in);
        const caller = yield* server.connections.authenticate({
          token: tokens?.access_token ?? "",
          resource: server.resource,
        });
        assert.equal(caller?.name, "Claude Code (threadlines)");
        assert.deepStrictEqual(server.recorded, [
          {
            event: "outside_agent.connected",
            properties: { clientName: "claude-code", access: "start" },
          },
        ]);
      }),
    ),
  );

  it.effect("refuses what didn't come from an agent on this computer", () =>
    withServer((server) =>
      Effect.gen(function* () {
        const elsewhere = yield* register(server, {
          client_name: "Somewhere",
          redirect_uris: ["https://example.com/callback"],
        });
        assert.equal(elsewhere.status, 400);
        assert.equal(elsewhere.body.error, "invalid_redirect_uri");

        // A DNS-rebinding page's Host, on any route.
        for (const path of ["/oauth/authorize", "/.well-known/oauth-authorization-server"]) {
          assert.equal(
            yield* rawGet(server.port, path, { host: `evil.example:${server.port}` }),
            421,
          );
        }

        // A link or script on a web page can't start a sign-in.
        const clientId = yield* registerClient(server);
        const fromPage = yield* call(
          authorizeUrl(server, { clientId, challenge: pkce().challenge }),
          {
            headers: { "sec-fetch-site": "cross-site" },
          },
        );
        assert.equal(fromPage.status, 403);
        assert.include(
          yield* Effect.promise(() => fromPage.text()),
          '<section data-state="cross-site">',
        );
        assert.lengthOf((yield* latestSnapshot(server)).pending, 0);

        // No CORS for another site's scripts.
        const preflight = yield* call(`${server.origin}/oauth/token`, {
          method: "OPTIONS",
          headers: { origin: "https://example.com", "access-control-request-method": "POST" },
        });
        assert.isNull(preflight.headers.get("access-control-allow-origin"));
      }),
    ),
  );

  it.effect("answers a refused request at its callback with state and iss", () =>
    withServer((server) =>
      Effect.gen(function* () {
        const clientId = yield* registerClient(server);
        const plain = yield* call(
          authorizeUrl(server, {
            clientId,
            challenge: pkce().challenge,
            extra: { code_challenge_method: "plain" },
          }),
        );
        assert.equal(plain.status, 302);
        const answer = new URL(plain.headers.get("location") ?? "");
        assert.equal(`${answer.origin}${answer.pathname}`, CALLBACK);
        assert.equal(answer.searchParams.get("error"), "invalid_request");
        assert.equal(answer.searchParams.get("state"), "agent-state");
        assert.equal(answer.searchParams.get("iss"), server.origin);

        const elsewhere = yield* call(
          authorizeUrl(server, {
            clientId,
            challenge: pkce().challenge,
            extra: { resource: "http://localhost:1/mcp/connect" },
          }),
        );
        assert.equal(
          new URL(elsewhere.headers.get("location") ?? "").searchParams.get("error"),
          "invalid_target",
        );

        // A callback the client never registered: nowhere safe to answer.
        const unregistered = yield* call(
          authorizeUrl(server, {
            clientId,
            challenge: pkce().challenge,
            redirect: "http://127.0.0.1:5571/other",
          }),
        );
        assert.equal(unregistered.status, 400);
        assert.isNull(unregistered.headers.get("location"));

        // The user's Deny reaches the agent the same way.
        const waiting = yield* openSignIn(
          server,
          authorizeUrl(server, { clientId, challenge: pkce().challenge }),
        );
        yield* server.signIn.deny({ requestId: waiting.requestId });
        const denied = yield* pollStatus(waiting.status);
        assert.equal(denied.state, "denied");
        const deniedAnswer = new URL(String(denied.redirect));
        assert.equal(deniedAnswer.searchParams.get("error"), "access_denied");
        assert.equal(deniedAnswer.searchParams.get("state"), "agent-state");
        assert.equal(deniedAnswer.searchParams.get("iss"), server.origin);
      }),
    ),
  );

  it.effect("takes a code once, in time, with its verifier, callback and resource", () =>
    withServer((server) =>
      Effect.gen(function* () {
        const clientId = yield* registerClient(server);
        const approvedCode = Effect.gen(function* () {
          const { verifier, challenge } = pkce();
          const waiting = yield* openSignIn(server, authorizeUrl(server, { clientId, challenge }));
          yield* server.signIn.approve({
            requestId: waiting.requestId,
            access: "see",
            maxRuntimeMode: "approval-required",
            projectIds: null,
          });
          const status = yield* pollStatus(waiting.status);
          const code = new URL(String(status.redirect)).searchParams.get("code") ?? "";
          return {
            verifier,
            params: {
              grant_type: "authorization_code",
              code,
              client_id: clientId,
              redirect_uri: CALLBACK,
              code_verifier: verifier,
            },
          };
        });

        const wrongVerifier = yield* approvedCode;
        const mismatch = yield* exchange(server, {
          ...wrongVerifier.params,
          code_verifier: pkce().verifier,
        });
        assert.equal(mismatch.body.error, "invalid_grant");
        // Spent by the failed try: the right verifier can't use it now.
        assert.equal((yield* exchange(server, wrongVerifier.params)).body.error, "invalid_grant");

        const once = yield* approvedCode;
        assert.equal((yield* exchange(server, once.params)).status, 200);
        assert.equal((yield* exchange(server, once.params)).body.error, "invalid_grant");

        const late = yield* approvedCode;
        yield* TestClock.adjust("61 seconds");
        assert.equal((yield* exchange(server, late.params)).body.error, "invalid_grant");

        const otherResource = yield* approvedCode;
        assert.equal(
          (yield* exchange(server, {
            ...otherResource.params,
            resource: `http://localhost:${server.port}/mcp/connect`,
          })).body.error,
          "invalid_target",
        );

        const otherCallback = yield* approvedCode;
        assert.equal(
          (yield* exchange(server, {
            ...otherCallback.params,
            redirect_uri: "http://127.0.0.1:5572/callback",
          })).body.error,
          "invalid_grant",
        );
      }),
    ),
  );

  it.effect("lets a kept registration sign in again from a new port, replacing its wait", () =>
    withServer((server) =>
      Effect.gen(function* () {
        const clientId = yield* registerClient(server);
        const first = yield* openSignIn(
          server,
          authorizeUrl(server, { clientId, challenge: pkce().challenge }),
        );
        const second = yield* openSignIn(
          server,
          authorizeUrl(server, {
            clientId,
            challenge: pkce().challenge,
            redirect: "http://127.0.0.1:5999/callback",
          }),
        );
        assert.equal((yield* pollStatus(first.status)).state, "replaced");
        const pending = (yield* latestSnapshot(server)).pending;
        assert.deepStrictEqual(
          pending.map((request) => [request.requestId, request.callbackPort]),
          [[second.requestId, 5999]],
        );
      }),
    ),
  );

  it.effect("keeps at most 5 waiting, and Deny all turns new ones away until resumed", () =>
    withServer((server) =>
      Effect.gen(function* () {
        // Fresh registrations are new agents, but they share the limits.
        for (let index = 0; index < 5; index++) {
          const clientId = yield* registerClient(server, `Agent ${index}`);
          yield* openSignIn(
            server,
            authorizeUrl(server, { clientId, challenge: pkce().challenge }),
          );
        }
        const sixth = yield* call(
          authorizeUrl(server, {
            clientId: yield* registerClient(server, "Agent 6"),
            challenge: pkce().challenge,
          }),
        );
        assert.equal(sixth.status, 429);
        assert.include(yield* Effect.promise(() => sixth.text()), '<section data-state="full">');

        yield* server.signIn.denyAll;
        const snapshot = yield* latestSnapshot(server);
        assert.lengthOf(snapshot.pending, 0);
        assert.isNotNull(snapshot.quietUntil);
        const quiet = yield* call(
          authorizeUrl(server, {
            clientId: yield* registerClient(server, "Agent 7"),
            challenge: pkce().challenge,
          }),
        );
        assert.equal(quiet.status, 403);
        assert.include(yield* Effect.promise(() => quiet.text()), '<section data-state="quiet">');

        yield* server.signIn.resumeRequests;
        assert.isNull((yield* latestSnapshot(server)).quietUntil);
        yield* openSignIn(
          server,
          authorizeUrl(server, {
            clientId: yield* registerClient(server, "Agent 8"),
            challenge: pkce().challenge,
          }),
        );

        // The quiet period also ends on its own after 10 minutes.
        yield* server.signIn.denyAll;
        yield* TestClock.adjust("10 minutes");
        assert.isNull((yield* latestSnapshot(server)).quietUntil);
      }),
    ),
  );

  it.effect("grants no more than the agent asked for, and expires after 5 minutes", () =>
    withServer((server) =>
      Effect.gen(function* () {
        const clientId = yield* registerClient(server);
        const { challenge } = pkce();
        const readOnly = yield* openSignIn(
          server,
          authorizeUrl(server, { clientId, challenge, scope: "threads:read" }),
        );
        assert.equal((yield* latestSnapshot(server)).pending[0]?.requestedAccess, "see");
        const tooMuch = yield* Effect.exit(
          server.signIn.approve({
            requestId: readOnly.requestId,
            access: "start",
            maxRuntimeMode: "approval-required",
            projectIds: null,
          }),
        );
        assert.isTrue(Exit.isFailure(tooMuch));

        yield* TestClock.adjust("5 minutes");
        const expired = yield* pollStatus(readOnly.status);
        assert.equal(expired.state, "expired");
        assert.equal(new URL(String(expired.redirect)).searchParams.get("error"), "access_denied");
        assert.lengthOf((yield* latestSnapshot(server)).pending, 0);

        const seeOnly = yield* signInAgent(server, { access: "see" });
        assert.equal(seeOnly.scope, "threads:read");
      }),
    ),
  );
});

describe("outside agents' connections", () => {
  it.effect("show in the Agents group as they change, and Change applies to the next call", () =>
    withServer((server) =>
      Effect.gen(function* () {
        const subscribed = yield* Deferred.make<void>();
        const seen = yield* server.signIn.changes.pipe(
          Stream.tap(() => Deferred.succeed(subscribed, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(subscribed);
        const clientId = yield* registerClient(server, "Codex");
        yield* openSignIn(server, authorizeUrl(server, { clientId, challenge: pkce().challenge }));
        const [empty, waiting] = yield* Fiber.join(seen).pipe(
          Effect.map((snapshots) => Array.from(snapshots)),
        );
        assert.deepStrictEqual(empty?.pending, []);
        assert.equal(empty?.address, `http://127.0.0.1:${server.port}/mcp/connect`);
        assert.deepStrictEqual(
          waiting?.pending.map((request) => [request.name, request.requestedAccess]),
          [["Codex", "start"]],
        );

        yield* signInAgent(server, { clientId, access: "start" });
        const [connection] = (yield* latestSnapshot(server)).connections;
        assert.isDefined(connection);
        yield* server.signIn.update({
          connectionId: connection!.connectionId,
          access: "see",
          maxRuntimeMode: "auto",
          projectIds: [ProjectId.make("project-1")],
        });
        assert.deepStrictEqual(yield* server.connections.grant(connection!.connectionId), {
          connectionId: connection!.connectionId,
          name: "Codex",
          access: "see",
          maxRuntimeMode: "auto",
          projectIds: [ProjectId.make("project-1")],
        });
      }),
    ),
  );
});

describe("outside agents' access tokens", () => {
  it.effect("work only for the resource they were issued for", () =>
    withServer((server) =>
      Effect.gen(function* () {
        const { token } = yield* signInAgent(server);
        assert.isNotNull(
          yield* server.connections.authenticate({ token, resource: server.resource }),
        );
        assert.isNull(
          yield* server.connections.authenticate({
            token,
            resource: `http://localhost:${server.port}/mcp/connect`,
          }),
        );
        assert.isNull(
          yield* server.connections.authenticate({
            token: `${token.slice(0, -2)}AA`,
            resource: server.resource,
          }),
        );
      }),
    ),
  );

  it.effect("stop at a new generation, a removal, or 90 days unused", () =>
    withServer((server) =>
      Effect.gen(function* () {
        const check = (token: string) =>
          server.connections.authenticate({ token, resource: server.resource });

        const bumped = yield* signInAgent(server, { name: "Codex" });
        yield* server.sql`UPDATE outside_agent_connections SET token_generation = 2 WHERE client_name = 'Codex'`;
        assert.isNull(yield* check(bumped.token));

        const removed = yield* signInAgent(server, { name: "Gemini CLI" });
        const connection = (yield* latestSnapshot(server)).connections.find(
          (entry) => entry.name === "Gemini CLI",
        );
        assert.isDefined(connection);
        yield* server.signIn.remove({ connectionId: connection!.connectionId });
        assert.isNull(yield* check(removed.token));
        assert.isNull(yield* server.connections.grant(connection!.connectionId));

        const idle = yield* signInAgent(server, { name: "Cursor" });
        assert.isNotNull(yield* check(idle.token));
        yield* TestClock.adjust("91 days");
        assert.isNull(yield* check(idle.token));
        const rows = yield* server.sql<{ readonly reason: string | null }>`
          SELECT removed_reason AS "reason" FROM outside_agent_connections WHERE client_name = 'Cursor'
        `;
        assert.deepStrictEqual(rows, [{ reason: "unused" }]);
      }),
    ),
  );

  it.effect("die when the same agent's new approval replaces its connection", () =>
    withServer((server) =>
      Effect.gen(function* () {
        const first = yield* signInAgent(server);
        // The approval dialog says which connection it replaces.
        const { verifier: _verifier, challenge } = pkce();
        yield* openSignIn(server, authorizeUrl(server, { clientId: first.clientId, challenge }));
        const waiting = yield* latestSnapshot(server);
        assert.equal(waiting.pending[0]?.replaces?.name, "Claude Code");
        assert.equal(
          waiting.pending[0]?.replaces?.connectionId,
          waiting.connections[0]?.connectionId,
        );

        const second = yield* signInAgent(server, { clientId: first.clientId });
        assert.isNull(
          yield* server.connections.authenticate({ token: first.token, resource: server.resource }),
        );
        assert.isNotNull(
          yield* server.connections.authenticate({
            token: second.token,
            resource: server.resource,
          }),
        );
        assert.lengthOf((yield* latestSnapshot(server)).connections, 1);
      }),
    ),
  );
});
