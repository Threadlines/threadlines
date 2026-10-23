/**
 * `threadlines connect` (docs/design/outside-agents.md, "The `threadlines`
 * command" and "Sign-in"): signs the command in to this computer's
 * Threadlines as an ordinary OAuth client of `/mcp/connect`. Nothing on the
 * server is special for it; the user approves it in the app like any agent.
 *
 * 1. Discovery: the resource's metadata names the authorization server,
 *    whose metadata names the endpoints (RFC 9728, RFC 8414).
 * 2. A listener on a random loopback port for the callback.
 * 3. Registration (DCR) as "Threadlines command", the first time only. Later
 *    sign-ins reuse the kept `client_id`, so an approval replaces the
 *    command's old connection; a registered loopback redirect matches any
 *    port.
 * 4. PKCE S256, then the browser on the authorize page (or the link printed).
 * 5. Up to 5 minutes for the user to approve in Threadlines.
 * 6. The code exchanged for a token bound to the resource, stored with
 *    connectCredentials.ts.
 */
import { createHash, randomBytes } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off - NodeHttpServer.make takes a Node server
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import { OUTSIDE_AGENT_SCOPES } from "../outsideAgents/OutsideAgentConnections.ts";
import {
  keepConnectRegistration,
  readConnectCredential,
  writeConnectCredential,
} from "./connectCredentials.ts";
import { ConnectError, NOT_RUNNING_MESSAGE } from "./connectExit.ts";
import type { ConnectTarget } from "./connectLocation.ts";

export const CLI_CLIENT_NAME = "Threadlines command";
export const CLI_SOFTWARE_ID = "threadlines-cli";
const CALLBACK_PATH = "/callback";
const SCOPE = OUTSIDE_AGENT_SCOPES.join(" ");
/** As long as Threadlines keeps a sign-in waiting for the user. */
export const APPROVAL_WAIT = Duration.minutes(5);
/** Each request to Threadlines other than the wait for the user. */
const REQUEST_TIMEOUT = Duration.seconds(30);

const ProtectedResourceMetadata = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.Array(Schema.String),
});

const AuthorizationServerMetadata = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.optional(Schema.String),
  authorization_response_iss_parameter_supported: Schema.optional(Schema.Boolean),
});

const RegistrationResponse = Schema.Struct({ client_id: Schema.String });

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  scope: Schema.optional(Schema.String),
});

const OAuthErrorBody = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String),
});

/** How a sign-in ended without a token. */
export class SignInEnded extends Data.TaggedError("SignInEnded")<{
  /**
   * `denied`: the user (or Threadlines) said no. `timed_out`: nobody
   * answered within APPROVAL_WAIT.
   */
  readonly reason: "denied" | "timed_out";
  readonly message: string;
}> {}

export interface SignInResult {
  /** What the user allowed: `threads:read`, maybe with `threads:start`. */
  readonly scope: string;
}

const failed = (message: string) => new ConnectError({ reason: "failed", message });

const base64Url = (bytes: Buffer) => bytes.toString("base64url");

/** One GET or POST to Threadlines, its body decoded, or why not in plain words. */
const fetchJson = <S extends Schema.ConstraintCodec<unknown, unknown>>(
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
  what: string,
) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient.execute(HttpClientRequest.acceptJson(request)).pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError(
        () => new ConnectError({ reason: "not_running", message: NOT_RUNNING_MESSAGE }),
      ),
    );
    if (response.status >= 200 && response.status < 300) {
      return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.mapError(() => failed(`Threadlines sent ${what} this command can't read.`)),
      );
    }
    if (response.status === 404) {
      return yield* new ConnectError({
        reason: "not_running",
        message: "This Threadlines doesn't take agents. Update it, then try again.",
      });
    }
    const body = yield* HttpClientResponse.schemaBodyJson(OAuthErrorBody)(response).pipe(
      Effect.option,
    );
    const detail = Option.match(body, {
      onNone: () => `HTTP ${response.status}`,
      onSome: (error) => error.error_description ?? error.error,
    });
    return yield* failed(`Threadlines refused ${what}: ${detail}`);
  });

/** What the callback page says once the command knows how the sign-in ended. */
const callbackPage = (heading: string, text: string) => {
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/gu,
      (char) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
    );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Threadlines</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;color:#1f2328;background:#f6f7f9}@media(prefers-color-scheme:dark){body{color:#e6e8eb;background:#14161a}}main{max-width:420px;padding:24px}h1{font-size:16px;margin:0 0 6px}p{margin:0;color:inherit;opacity:1}</style></head><body><main><h1>${escape(heading)}</h1><p>${escape(text)}</p></main></body></html>`;
};

interface CallbackOutcome {
  readonly code: string | null;
  readonly error: string | null;
  readonly errorDescription: string | null;
  readonly issuer: string | null;
}

/**
 * The loopback listener the browser comes back to. A request without this
 * sign-in's `state` is answered and ignored, so another page can't end the
 * sign-in. The browser's page waits until `finish` says how it ended.
 */
const listenForCallback = Effect.fn("cli.connect.listenForCallback")(function* (state: string) {
  const arrived = yield* Deferred.make<CallbackOutcome>();
  const finished = yield* Deferred.make<{ readonly heading: string; readonly text: string }>();
  const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
    host: "127.0.0.1",
    port: 0,
    gracefulShutdownTimeout: Duration.seconds(2),
  });
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH) {
        return HttpServerResponse.text("Not found", { status: 404 });
      }
      if (url.searchParams.get("state") !== state) {
        return HttpServerResponse.html(
          callbackPage(
            "This isn't the sign-in this command started",
            "Run threadlines connect again.",
          ),
        ).pipe(HttpServerResponse.setStatus(400));
      }
      yield* Deferred.succeed(arrived, {
        code: url.searchParams.get("code"),
        error: url.searchParams.get("error"),
        errorDescription: url.searchParams.get("error_description"),
        issuer: url.searchParams.get("iss"),
      });
      const page = yield* Deferred.await(finished).pipe(
        Effect.timeoutOption(REQUEST_TIMEOUT),
        Effect.map(
          Option.getOrElse(() => ({
            heading: "Still finishing",
            text: "Check the terminal you ran threadlines connect in.",
          })),
        ),
      );
      return HttpServerResponse.html(callbackPage(page.heading, page.text)).pipe(
        HttpServerResponse.setHeader("connection", "close"),
        HttpServerResponse.setHeader("cache-control", "no-store"),
      );
    }),
  );
  if (server.address._tag !== "TcpAddress") {
    return yield* failed("Couldn't listen on this computer for the sign-in.");
  }
  return {
    redirectUri: `http://127.0.0.1:${server.address.port}${CALLBACK_PATH}`,
    arrived: Deferred.await(arrived),
    finish: (heading: string, text: string) =>
      Deferred.succeed(finished, { heading, text }).pipe(Effect.asVoid),
  };
});

/**
 * Signs in and stores the token. `openBrowser` opens the authorize page;
 * `say` prints progress (to stderr, so `--json` output stays clean).
 */
export const signIn = Effect.fn("cli.connect.signIn")(function* (input: {
  readonly target: ConnectTarget;
  readonly credentialsPath: string;
  readonly clientVersion: string;
  readonly noBrowser: boolean;
  /** Opens `url` in the user's browser; false when it couldn't. */
  readonly openBrowser: (url: string) => Effect.Effect<boolean>;
  readonly say: (text: string) => Effect.Effect<void>;
}) {
  const { origin, resource } = input.target;
  const resourceMetadata = yield* fetchJson(
    HttpClientRequest.get(`${origin}/.well-known/oauth-protected-resource/mcp/connect`),
    ProtectedResourceMetadata,
    "its agent address details",
  );
  const issuerUrl = resourceMetadata.authorization_servers[0];
  if (resourceMetadata.resource !== resource || issuerUrl === undefined) {
    return yield* failed("Threadlines described a different agent address than the one asked.");
  }
  const server = yield* fetchJson(
    HttpClientRequest.get(
      `${issuerUrl.replace(/\/+$/u, "")}/.well-known/oauth-authorization-server`,
    ),
    AuthorizationServerMetadata,
    "its sign-in details",
  );

  const state = base64Url(randomBytes(16));
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const callback = yield* listenForCallback(state);

  const kept = yield* readConnectCredential(input.credentialsPath, resource);
  let clientId = kept?.clientId;
  if (clientId === undefined) {
    if (server.registration_endpoint === undefined) {
      return yield* failed("This Threadlines doesn't let agents register. Update it.");
    }
    const registration = yield* fetchJson(
      HttpClientRequest.post(server.registration_endpoint).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          client_name: CLI_CLIENT_NAME,
          software_id: CLI_SOFTWARE_ID,
          software_version: input.clientVersion,
          redirect_uris: [callback.redirectUri],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: SCOPE,
        }),
      ),
      RegistrationResponse,
      "to register this command",
    );
    clientId = registration.client_id;
    // Kept at once: an abandoned sign-in still leaves this the same agent.
    yield* keepConnectRegistration(input.credentialsPath, resource, clientId);
  }

  const authorizeUrl = new URL(server.authorization_endpoint);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callback.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
    scope: SCOPE,
  })) {
    authorizeUrl.searchParams.set(name, value);
  }
  const link = authorizeUrl.toString();
  if (input.noBrowser) {
    yield* input.say(
      `Open this link in a browser on this computer, then allow the Threadlines command in Threadlines:\n${link}`,
    );
  } else {
    const opened = yield* input.openBrowser(link);
    yield* input.say(
      opened
        ? "Opened your browser. Check that its code matches the one Threadlines shows, then allow the Threadlines command there."
        : `Couldn't open a browser. Open this link on this computer, then allow the Threadlines command in Threadlines:\n${link}`,
    );
  }
  yield* input.say("Waiting for you to answer in Threadlines (up to 5 minutes).");

  const outcome = yield* callback.arrived.pipe(Effect.timeoutOption(APPROVAL_WAIT));
  if (Option.isNone(outcome)) {
    return yield* new SignInEnded({
      reason: "timed_out",
      message: "Nobody answered in 5 minutes. Run threadlines connect to try again.",
    });
  }
  const answer = outcome.value;
  // RFC 9207: the answer names who sent it, so another server's can't pass for this one's.
  const issuerExpected = server.authorization_response_iss_parameter_supported === true;
  if (
    (answer.issuer !== null && answer.issuer !== server.issuer) ||
    (answer.issuer === null && issuerExpected)
  ) {
    yield* callback.finish("Not connected", "The answer didn't come from this Threadlines.");
    return yield* failed("The sign-in answer didn't come from this Threadlines.");
  }
  if (answer.code === null) {
    const message = answer.errorDescription ?? "Threadlines didn't allow it.";
    yield* callback.finish("Not connected", `${message} You can close this tab.`);
    return yield* new SignInEnded({ reason: "denied", message });
  }

  const token = yield* fetchJson(
    HttpClientRequest.post(server.token_endpoint).pipe(
      HttpClientRequest.bodyUrlParams({
        grant_type: "authorization_code",
        code: answer.code,
        redirect_uri: callback.redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource,
      }),
    ),
    TokenResponse,
    "the sign-in",
  ).pipe(
    Effect.tapError(() =>
      callback.finish("Not connected", "Check the terminal you ran threadlines connect in."),
    ),
  );
  if (token.token_type.toLowerCase() !== "bearer") {
    yield* callback.finish("Not connected", "Check the terminal you ran threadlines connect in.");
    return yield* failed(`Threadlines gave a ${token.token_type} token this command can't use.`);
  }
  yield* writeConnectCredential(input.credentialsPath, resource, {
    clientId,
    accessToken: token.access_token,
    ...(token.scope === undefined ? {} : { scope: token.scope }),
  });
  yield* callback.finish("Connected", "You can close this tab.");
  return { scope: token.scope ?? OUTSIDE_AGENT_SCOPES[0] } satisfies SignInResult;
});
