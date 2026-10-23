// @effect-diagnostics-next-line nodeBuiltinImport:off - NodeHttpServer.layer takes a Node server
import * as NodeHttp from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@threadlines/shared/Net";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type * as Types from "effect/Types";
import * as TestConsole from "effect/testing/TestConsole";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import { Command } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import { cli } from "../bin.ts";
import {
  ConnectToolkit,
  McpConnectInvocation,
  type OutsideThreadStartResult,
  type OutsideThreadSummary,
  type ThreadWaitResult,
} from "../outsideAgents/connectTools.ts";
import { OutsideAgentConnectionId } from "@threadlines/contracts";
import { ProjectsTool } from "../outsideAgents/connectTools.ts";
import { findJsonRpcReply, makeConnectClient } from "./connectClient.ts";
import { CommandExit, EXIT } from "./connectExit.ts";
import { signIn } from "./connectSignIn.ts";

const TOKEN = "tlc1.connection.1.mac";

/** What the stand-in answers; each test sets what it needs. */
interface Script {
  start: OutsideThreadStartResult;
  /** Answered in order; the last one again once they run out. */
  waits: ThreadWaitResult[];
  /** The token `/mcp/connect` takes; any other gets a 401. */
  token: string;
  /** Forget the session after this many tool calls (a restart). */
  forgetSessionAfterCalls: number | null;
  /** How authorize answers: approve, or deny. */
  approve: boolean;
}

/** What the stand-in saw. */
interface Seen {
  initializes: number;
  toolCalls: Array<{ readonly name: string; readonly params: unknown }>;
  registrations: Array<Record<string, unknown>>;
  authorizeClientIds: string[];
  tokenRequests: Array<Record<string, string>>;
}

const thread = (overrides: Partial<OutsideThreadSummary> = {}): OutsideThreadSummary => ({
  threadId: "thread-1",
  title: "Fix the login bug",
  status: "idle",
  branch: "fix/login",
  model: "gpt-6-sol",
  attached: false,
  startedBy: null,
  projectId: "project-web",
  project: "web",
  access: "approval-required",
  lastTurn: { turnId: "turn-1", state: "completed" },
  ...overrides,
});

const done = (
  overrides: Partial<OutsideThreadSummary> = {},
  reply = "Fixed it.",
): ThreadWaitResult => ({
  outcome: "done",
  thread: thread(overrides),
  reply,
});

const stillWorking: ThreadWaitResult = {
  outcome: "still_working",
  thread: thread({ status: "working", lastTurn: { turnId: "turn-1", state: "running" } }),
  reply: null,
};

const started: OutsideThreadStartResult = {
  outcome: "started",
  thread: {
    threadId: "thread-1",
    title: "Fix the login bug",
    model: "gpt-6-sol",
    workspace: "worktree",
    access: "approval-required",
  },
};

const defaultScript = (): Script => ({
  start: started,
  waits: [done()],
  token: TOKEN,
  forgetSessionAfterCalls: null,
  approve: true,
});

/**
 * A stand-in for this computer's Threadlines: the real MCP transport at
 * `/mcp/connect` (Effect's McpServer, as the server mounts it) with the
 * connect tools answering from `script`, behind a bearer check, plus the
 * OAuth endpoints the sign-in uses, answering as the plan says.
 */
const standIn = (script: Script, seen: Seen) => {
  const forgotten = new Set<string>();
  const authenticate = Effect.succeed(
    Effect.fn(function* (
      handler: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        Types.unhandled,
        McpConnectInvocation
      >,
    ) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.headers.authorization !== `Bearer ${script.token}`) {
        return HttpServerResponse.empty({ status: 401 });
      }
      const session = request.headers["mcp-session-id"];
      if (session !== undefined && forgotten.has(session)) {
        return HttpServerResponse.empty({ status: 404 });
      }
      const body = yield* request.text;
      if (body.includes('"initialize"')) seen.initializes += 1;
      const response = yield* handler.pipe(
        Effect.provideService(McpConnectInvocation, {
          connectionId: OutsideAgentConnectionId.make("connection-1"),
          name: "Threadlines command",
        }),
      );
      if (
        session !== undefined &&
        script.forgetSessionAfterCalls !== null &&
        seen.toolCalls.length >= script.forgetSessionAfterCalls
      ) {
        script.forgetSessionAfterCalls = null;
        forgotten.add(session);
      }
      return response;
    }),
  );
  const record =
    <A>(name: string, answer: (params: never) => A) =>
    (params: unknown) =>
      Effect.sync(() => {
        seen.toolCalls.push({ name, params });
        return answer(params as never);
      });
  const handlers = ConnectToolkit.toLayer({
    projects: record("projects", () => ({
      outcome: "ok" as const,
      projects: [{ projectId: "project-web", name: "web", folder: "/repo/web" }],
    })),
    agents: record("agents", () => ({
      outcome: "ok" as const,
      agents: [],
      default: null,
      unavailable: [],
    })),
    threads_list: record("threads_list", () => ({ outcome: "ok" as const, threads: [thread()] })),
    thread_read: record("thread_read", () => ({
      outcome: "ok" as const,
      messages: [],
      next: null,
      more: false,
    })),
    thread_wait: record("thread_wait", () =>
      script.waits.length > 1 ? script.waits.shift()! : script.waits[0]!,
    ),
    thread_start: record("thread_start", () => script.start),
    thread_send: record("thread_send", () => ({ outcome: "sent" as const, threadId: "thread-1" })),
    thread_stop: record("thread_stop", () => ({
      outcome: "stopped" as const,
      threadId: "thread-1",
    })),
  });
  const mcp = McpServer.toolkit(ConnectToolkit).pipe(
    Layer.provide(handlers),
    Layer.provideMerge(
      McpServer.layerHttp({
        name: "threadlines-connect",
        version: "1",
        path: "/mcp/connect",
        protocols: [McpProtocol.v2025_06_18],
      }).pipe(
        Layer.provide(
          HttpRouter.middleware<{ provides: McpConnectInvocation }>()(authenticate).layer,
        ),
      ),
    ),
  );

  const originOf = (request: HttpServerRequest.HttpServerRequest) =>
    `http://${request.headers.host}`;
  const challenges = new Map<string, string>();
  const oauth = Layer.mergeAll(
    HttpRouter.add("GET", "/.well-known/oauth-protected-resource/mcp/connect", (request) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe({
          resource: `${originOf(request)}/mcp/connect`,
          authorization_servers: [originOf(request)],
        }),
      ),
    ),
    HttpRouter.add("GET", "/.well-known/oauth-authorization-server", (request) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe({
          issuer: originOf(request),
          authorization_endpoint: `${originOf(request)}/oauth/authorize`,
          token_endpoint: `${originOf(request)}/oauth/token`,
          registration_endpoint: `${originOf(request)}/oauth/register`,
        }),
      ),
    ),
    HttpRouter.add("POST", "/oauth/register", (request) =>
      Effect.gen(function* () {
        const body = (yield* request.json) as Record<string, unknown>;
        seen.registrations.push(body);
        return HttpServerResponse.jsonUnsafe(
          { client_id: `client-${seen.registrations.length}` },
          { status: 201 },
        );
      }),
    ),
    HttpRouter.add("GET", "/oauth/authorize", (request) =>
      Effect.sync(() => {
        const url = new URL(request.url, originOf(request));
        const params = url.searchParams;
        seen.authorizeClientIds.push(params.get("client_id") ?? "");
        const redirect = new URL(params.get("redirect_uri") ?? "");
        redirect.searchParams.set("state", params.get("state") ?? "");
        redirect.searchParams.set("iss", originOf(request));
        if (script.approve && params.get("code_challenge_method") === "S256") {
          challenges.set("code-1", params.get("code_challenge") ?? "");
          redirect.searchParams.set("code", "code-1");
        } else {
          redirect.searchParams.set("error", "access_denied");
          redirect.searchParams.set("error_description", "You denied it in Threadlines.");
        }
        return HttpServerResponse.redirect(redirect.toString(), { status: 302 });
      }),
    ),
    HttpRouter.add("POST", "/oauth/token", (request) =>
      Effect.gen(function* () {
        const form = Object.fromEntries(new URLSearchParams(yield* request.text));
        seen.tokenRequests.push(form);
        const verified =
          createHash("sha256")
            .update(form.code_verifier ?? "")
            .digest("base64url") === challenges.get(form.code ?? "");
        if (!verified || form.resource !== `${originOf(request)}/mcp/connect`) {
          return HttpServerResponse.jsonUnsafe({ error: "invalid_grant" }, { status: 400 });
        }
        return HttpServerResponse.jsonUnsafe({
          access_token: TOKEN,
          token_type: "Bearer",
          scope: "threads:read threads:start",
        });
      }),
    ),
  );
  return Layer.mergeAll(mcp, oauth);
};

const newSeen = (): Seen => ({
  initializes: 0,
  toolCalls: [],
  registrations: [],
  authorizeClientIds: [],
  tokenRequests: [],
});

/** A data folder whose runtime state names `port`, signed in with `token` when given. */
function dataFolder(port: number, token: string | null): string {
  const base = mkdtempSync(join(tmpdir(), "threadlines-cli-connect-"));
  const state = join(base, "userdata");
  mkdirSync(join(state, "cli"), { recursive: true });
  writeFileSync(
    join(state, "server-runtime.json"),
    JSON.stringify({
      version: 1,
      pid: process.pid,
      port,
      origin: `http://127.0.0.1:${port}`,
      startedAt: new Date().toISOString(),
    }),
  );
  if (token !== null) {
    writeFileSync(
      join(state, "cli", "connections.json"),
      JSON.stringify({
        version: 1,
        resources: {
          [`http://127.0.0.1:${port}/mcp/connect`]: { clientId: "client-1", accessToken: token },
        },
      }),
    );
  }
  return base;
}

const readCredentials = (base: string) =>
  JSON.parse(readFileSync(join(base, "userdata", "cli", "connections.json"), "utf8")) as {
    resources: Record<string, { clientId: string; accessToken?: string; scope?: string }>;
  };

const CliLayer = Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer);

/** Runs the command; its exit code, stdout and stderr. */
const run = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const exit = yield* Command.runWith(cli, { version: "0.0.0" })(args).pipe(Effect.exit);
    const stdout = (yield* TestConsole.logLines).map(String).join("\n");
    const stderr = (yield* TestConsole.errorLines).map(String).join("\n");
    if (Exit.isSuccess(exit)) return { code: 0, stdout, stderr };
    const error = Cause.squash(exit.cause);
    if (error instanceof CommandExit) return { code: error.code as number, stdout, stderr };
    return { code: -1, stdout, stderr, error };
  }).pipe(Effect.provide(CliLayer));

/** Serves the stand-in on loopback and runs `body` with its port. */
const withStandIn = <A, E, R>(
  script: Script,
  seen: Seen,
  body: (port: number) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* HttpRouter.serve(standIn(script, seen), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
        ),
        Layer.build,
      );
      const server = yield* HttpServer.HttpServer.pipe(Effect.provide(context));
      return yield* body((server.address as HttpServer.TcpAddress).port);
    }),
  );

describe("threadlines connect", () => {
  it.live("signs in once as the same agent, and keeps the token only for the user", () => {
    const script = defaultScript();
    const seen = newSeen();
    return withStandIn(script, seen, (port) =>
      Effect.gen(function* () {
        const base = dataFolder(port, null);
        const credentialsPath = join(base, "userdata", "cli", "connections.json");
        const said: string[] = [];
        const target = {
          origin: `http://127.0.0.1:${port}`,
          resource: `http://127.0.0.1:${port}/mcp/connect`,
        };
        const signInOnce = signIn({
          target,
          credentialsPath,
          clientVersion: "0.0.0",
          noBrowser: false,
          // The browser: follows the authorize page's redirect back to the command.
          openBrowser: (url) =>
            Effect.promise(() => fetch(url)).pipe(
              Effect.flatMap((response) => Effect.promise(() => response.text())),
              Effect.forkDetach,
              Effect.as(true),
            ),
          say: (text) => Effect.sync(() => void said.push(text)),
        }).pipe(
          Effect.scoped,
          Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer)),
        );

        const first = yield* signInOnce;
        assert.equal(first.scope, "threads:read threads:start");
        const second = yield* signInOnce;
        assert.equal(second.scope, "threads:read threads:start");

        // One registration, as "Threadlines command"; both sign-ins used it.
        assert.equal(seen.registrations.length, 1);
        assert.equal(seen.registrations[0]?.client_name, "Threadlines command");
        assert.equal(seen.registrations[0]?.software_id, "threadlines-cli");
        assert.deepEqual(seen.authorizeClientIds, ["client-1", "client-1"]);
        assert.equal(seen.tokenRequests[1]?.resource, target.resource);

        const credentials = readCredentials(base);
        assert.deepEqual(credentials.resources[target.resource], {
          clientId: "client-1",
          accessToken: TOKEN,
          scope: "threads:read threads:start",
        });
        assert.equal(statSync(credentialsPath).mode & 0o777, 0o600);
        assert.equal(statSync(join(base, "userdata", "cli")).mode & 0o777, 0o700);
        assert.isFalse(said.join("\n").includes(TOKEN));

        // Denied: the registration and the earlier token stay as they were.
        script.approve = false;
        const denied = yield* signInOnce.pipe(Effect.flip);
        assert.equal(denied._tag, "SignInEnded");
        assert.equal(readCredentials(base).resources[target.resource]?.accessToken, TOKEN);
      }),
    );
  });
});

describe("threadlines thread", () => {
  it.live("starts a thread, waits for it, and exits with how its newest turn ended", () => {
    const script = defaultScript();
    const seen = newSeen();
    return withStandIn(script, seen, (port) =>
      Effect.gen(function* () {
        const base = dataFolder(port, TOKEN);
        const start = ["thread", "start", "web", "Fix the login bug", "--base-dir", base, "--wait"];

        script.waits = [stillWorking, done()];
        const finished = yield* run(start);
        assert.equal(finished.code, EXIT.done);
        assert.include(finished.stdout, "Started Fix the login bug (thread-1) in its own worktree");
        assert.include(finished.stdout, "Fixed it.");
        const startCall = seen.toolCalls.find((call) => call.name === "thread_start");
        assert.deepEqual(startCall?.params, { project: "web", prompt: "Fix the login bug" });

        script.waits = [done({ lastTurn: { turnId: "turn-2", state: "interrupted" } }, "")];
        assert.equal((yield* run(start)).code, EXIT.failed);

        script.waits = [done({ status: "needs the user" }, "")];
        script.waits[0] = { ...script.waits[0]!, waitingOn: "approval" };
        const needsUser = yield* run(start);
        assert.equal(needsUser.code, EXIT.needsUser);
        assert.include(needsUser.stdout, "It's waiting for an approval in Threadlines.");

        script.start = {
          outcome: "not_allowed",
          detail: "This connection can only see threads.",
        };
        const refused = yield* run([...start, "--json"]);
        assert.equal(refused.code, EXIT.refused);
        assert.deepEqual(JSON.parse(refused.stdout), script.start);

        script.start = started;
        script.waits = [stillWorking];
        const timedOut = yield* run([
          "thread",
          "wait",
          "thread-1",
          "--base-dir",
          base,
          "--timeout",
          "1",
        ]);
        assert.equal(timedOut.code, EXIT.timedOut);
      }),
    );
  });

  it.live("initializes again when Threadlines forgets the session", () => {
    const script = defaultScript();
    const seen = newSeen();
    return withStandIn(script, seen, (port) =>
      Effect.gen(function* () {
        script.forgetSessionAfterCalls = 1;
        const client = yield* makeConnectClient({
          resource: `http://127.0.0.1:${port}/mcp/connect`,
          token: TOKEN,
          clientVersion: "0.0.0",
        }).pipe(Effect.provide(FetchHttpClient.layer));
        const first = yield* client.call(ProjectsTool, {});
        const second = yield* client.call(ProjectsTool, {});
        assert.equal(first.projects[0]?.name, "web");
        assert.equal(second.projects[0]?.name, "web");
        assert.equal(seen.initializes, 2);
        assert.equal(seen.toolCalls.length, 2);
      }),
    );
  });

  it("reads a reply sent as server-sent events, after a notification", () => {
    const body = [
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
      'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}',
      "",
    ].join("\n\n");
    assert.deepEqual(findJsonRpcReply(body, "text/event-stream", 7)?.result, { ok: true });
    assert.isNull(findJsonRpcReply(body, "text/event-stream", 8));
  });

  it.live("forgets the token on a 401 and asks to connect again, keeping its registration", () => {
    const script = defaultScript();
    const seen = newSeen();
    return withStandIn(script, seen, (port) =>
      Effect.gen(function* () {
        const base = dataFolder(port, "tlc1.removed.1.mac");
        const result = yield* run(["projects", "--base-dir", base]);
        assert.equal(result.code, EXIT.notConnected);
        assert.include(result.stderr, "Run threadlines connect");
        assert.deepEqual(readCredentials(base).resources[`http://127.0.0.1:${port}/mcp/connect`], {
          clientId: "client-1",
        });
      }),
    );
  });

  it.live("says Threadlines isn't running when nothing answers", () =>
    Effect.gen(function* () {
      // A port the stand-in held, now closed.
      const port = yield* withStandIn(defaultScript(), newSeen(), (port) => Effect.succeed(port));
      const result = yield* run(["thread", "list", "--base-dir", dataFolder(port, TOKEN)]);
      assert.equal(result.code, EXIT.notConnected);
      assert.include(result.stderr, "Threadlines isn't running");
    }),
  );

  it.effect("rejects a start without a project, and an unknown status", () =>
    Effect.gen(function* () {
      const missing = yield* Command.runWith(cli, { version: "0.0.0" })(["thread", "start"]).pipe(
        Effect.provide(CliLayer),
        Effect.flip,
      );
      assert.isTrue(CliError.isCliError(missing) && missing._tag === "ShowHelp");
      const status = yield* Command.runWith(cli, { version: "0.0.0" })([
        "thread",
        "list",
        "--status",
        "busy",
      ]).pipe(Effect.provide(CliLayer), Effect.flip);
      assert.isTrue(CliError.isCliError(status) && status._tag === "ShowHelp");
    }),
  );
});
