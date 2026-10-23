// @effect-diagnostics-next-line nodeBuiltinImport:off - NodeHttpServer.layer takes a Node server
import * as NodeHttp from "node:http";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@threadlines/shared/Net";
import { OutsideAgentConnectionId, OutsideAgentRequestId } from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
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

import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { cli } from "../bin.ts";
import { ServerConfig } from "../config.ts";
import { browserApiCorsLayer } from "../http.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadBootstrap } from "../orchestration/Services/ThreadBootstrap.ts";
import {
  ConnectToolkit,
  McpConnectInvocation,
  type OutsideThreadStartResult,
  type OutsideThreadSummary,
  ProjectsTool,
  type ThreadWaitResult,
} from "../outsideAgents/connectTools.ts";
import * as McpConnectServer from "../outsideAgents/McpConnectServer.ts";
import { outsideAgentSignInRouteLayer } from "../outsideAgents/oauthHttp.ts";
import { OutsideAgentConnectionsLive } from "../outsideAgents/OutsideAgentConnectionsLive.ts";
import { OutsideAgentRequests } from "../outsideAgents/OutsideAgentRequests.ts";
import {
  OutsideAgentSignIn,
  type OutsideAgentSignInShape,
} from "../outsideAgents/OutsideAgentSignIn.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { makeConnectClient } from "./connectClient.ts";
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
  /** How long thread_wait takes to answer. */
  waitDelayMs: number;
}

/** What the stand-in saw. */
interface Seen {
  initializes: number;
  toolCalls: Array<{ readonly name: string; readonly params: unknown }>;
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
  waitDelayMs: 0,
});

/**
 * A stand-in for `/mcp/connect` whose tools answer from `script`: the real
 * MCP transport (Effect's McpServer, as the server mounts it) behind a bearer
 * check, so a test can choose how a thread ends and when a session is lost.
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
    thread_wait: (params) =>
      Effect.sleep(script.waitDelayMs).pipe(
        Effect.andThen(
          record("thread_wait", () =>
            script.waits.length > 1 ? script.waits.shift()! : script.waits[0]!,
          )(params),
        ),
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

  return mcp;
};

const newSeen = (): Seen => ({ initializes: 0, toolCalls: [] });

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

const unused = () => Effect.die("not used by this test");

/** What `/mcp/connect`'s tools read besides the connections: one project, nothing started. */
const toolStubs = Layer.mergeAll(
  Layer.succeed(OrchestrationEngineService, {
    dispatch: unused,
    getCommandReceipt: unused,
    subscribeDomainEvents: Effect.succeed(Stream.empty),
  } as never),
  Layer.succeed(ProjectionSnapshotQuery, {
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 0,
        projects: [
          { id: "project-web", kind: "workspace", title: "web", workspaceRoot: "/repo/web" },
        ],
        threads: [],
        updatedAt: "",
      }),
    getThreadShellById: () => Effect.succeed(Option.none()),
  } as never),
  Layer.succeed(ThreadBootstrap, { runTurnStart: unused, startChild: unused } as never),
  Layer.succeed(ProviderRegistry, { getProviders: Effect.succeed([]) } as never),
  Layer.succeed(GitVcsDriver, {} as never),
  Layer.succeed(OutsideAgentRequests, {} as never),
  ServerSettingsService.layerTest(),
);

/**
 * This computer's Threadlines as agents meet it: its own sign-in routes and
 * `/mcp/connect`, over real HTTP on loopback, with the connections kept in
 * an in-memory database.
 */
const serveThreadlines = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const port = (server.address as HttpServer.TcpAddress).port;
  const config = Layer.effect(
    ServerConfig,
    Effect.map(Effect.service(ServerConfig), (base) => ({ ...base, port })),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "threadlines-cli-" })));
  const services = yield* Layer.build(
    OutsideAgentConnectionsLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provide(ServerSecretStoreLive),
      Layer.provide(
        Layer.succeed(AnalyticsService, { record: () => Effect.void, flush: Effect.void }),
      ),
      Layer.provideMerge(config),
    ),
  );
  yield* HttpRouter.serve(
    Layer.mergeAll(
      outsideAgentSignInRouteLayer.pipe(Layer.provide(browserApiCorsLayer)),
      McpConnectServer.layer.pipe(Layer.provide(toolStubs)),
    ),
    { disableLogger: true, disableListenLog: true },
  ).pipe(Layer.provide(Layer.succeedContext(services)), Layer.build);
  return { port, signIn: Context.get(services, OutsideAgentSignIn) };
});

/**
 * The browser the command opens, and the user in the app: loads the waiting
 * page, allows (or denies) the sign-in in Threadlines, and follows the page
 * back to the command once Threadlines says where.
 */
const browserAndUser =
  (signInService: OutsideAgentSignInShape, answer: "allow" | "deny") => (url: string) =>
    Effect.gen(function* () {
      const page = yield* Effect.promise(() => fetch(url).then((response) => response.text()));
      const config = /<script type="application\/json" id="sign-in-config">(.*?)<\/script>/su.exec(
        page,
      );
      const status = new URL(
        String((JSON.parse(config?.[1] ?? "{}") as { status?: string }).status),
        url,
      );
      const requestId = OutsideAgentRequestId.make(status.searchParams.get("request") ?? "");
      yield* answer === "allow"
        ? signInService.approve({
            requestId,
            access: "start",
            maxRuntimeMode: "approval-required",
            projectIds: null,
          })
        : signInService.deny({ requestId });
      const polled = yield* Effect.promise(() =>
        fetch(status, { headers: { "sec-fetch-site": "same-origin" } }).then(
          (response) => response.json() as Promise<{ readonly redirect?: string }>,
        ),
      );
      yield* Effect.promise(() =>
        fetch(String(polled.redirect)).then((response) => response.text()),
      );
    }).pipe(Effect.orDie, Effect.forkDetach, Effect.as(true));

describe("threadlines connect", () => {
  it.live(
    "signs in to Threadlines' own sign-in as one agent, uses /mcp/connect, and asks to connect again once removed",
    () =>
      Effect.gen(function* () {
        const threadlines = yield* serveThreadlines;
        const base = dataFolder(threadlines.port, null);
        const credentialsPath = join(base, "userdata", "cli", "connections.json");
        const resource = `http://127.0.0.1:${threadlines.port}/mcp/connect`;
        const said: string[] = [];
        const connect = (answer: "allow" | "deny") =>
          signIn({
            target: { origin: `http://127.0.0.1:${threadlines.port}`, resource },
            credentialsPath,
            clientVersion: "0.0.0",
            noBrowser: false,
            openBrowser: browserAndUser(threadlines.signIn, answer),
            say: (text) => Effect.sync(() => void said.push(text)),
          }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer));
        const connections = Stream.runHead(threadlines.signIn.changes).pipe(
          Effect.map((snapshot) => Option.getOrThrow(snapshot).connections),
        );

        assert.equal((yield* connect("allow")).scope, "threads:read threads:start");
        const first = readCredentials(base).resources[resource];
        assert.equal(statSync(credentialsPath).mode & 0o777, 0o600);
        assert.equal(statSync(join(base, "userdata", "cli")).mode & 0o777, 0o700);
        const listed = yield* run(["projects", "--base-dir", base]);
        assert.equal(listed.code, EXIT.done);
        assert.equal(listed.stdout, "web  /repo/web  project-web");

        // Again, from a new loopback port: the same registration, so the
        // approval replaces the connection instead of adding one.
        yield* connect("allow");
        const second = readCredentials(base).resources[resource];
        assert.equal(second?.clientId, first?.clientId);
        assert.notEqual(second?.accessToken, first?.accessToken);
        const [connection, ...others] = yield* connections;
        assert.equal(connection?.name, "Threadlines command");
        assert.deepEqual(others, []);
        assert.isFalse(said.join("\n").includes(second?.accessToken ?? "-"));

        // Denied: the stored sign-in stays as it was.
        const denied = yield* connect("deny").pipe(Effect.flip);
        assert.equal(denied._tag, "SignInEnded");
        assert.deepEqual(readCredentials(base).resources[resource], second);

        // Removed in the app: the next call is refused, the token forgotten,
        // the registration kept for the next sign-in.
        yield* threadlines.signIn.remove({ connectionId: connection!.connectionId });
        const refused = yield* run(["projects", "--base-dir", base]);
        assert.equal(refused.code, EXIT.notConnected);
        assert.include(refused.stderr, "Run threadlines connect");
        assert.deepEqual(readCredentials(base).resources[resource], {
          clientId: second?.clientId ?? "",
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
            NodeServices.layer,
          ),
        ),
        Effect.scoped,
      ),
  );
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

  it.live(
    "takes a reply sent as server-sent events as it comes, though the stream stays open",
    () =>
      Effect.gen(function* () {
        // A server that answers tools/call over SSE, a notification first, and
        // then keeps the stream open.
        const server = NodeHttp.createServer((request, response) => {
          let body = "";
          request.on("data", (chunk) => (body += chunk));
          request.on("end", () => {
            const message = JSON.parse(body) as { readonly id?: number; readonly method: string };
            if (message.id === undefined) return void response.writeHead(202).end();
            if (message.method === "initialize") {
              response.writeHead(200, {
                "content-type": "application/json",
                "mcp-session-id": "s",
              });
              return void response.end(
                JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }),
              );
            }
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(
              'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\n',
            );
            const result = { structuredContent: { outcome: "ok", projects: [] } };
            response.write(
              `event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\r\n\r\n`,
            );
          });
        });
        const port = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<number>((resolve) =>
                server.listen(0, "127.0.0.1", () =>
                  resolve((server.address() as { readonly port: number }).port),
                ),
              ),
          ),
          () =>
            Effect.sync(() => {
              server.closeAllConnections();
              server.close();
            }),
        );
        const client = yield* makeConnectClient({
          resource: `http://127.0.0.1:${port}/mcp/connect`,
          token: TOKEN,
          clientVersion: "0.0.0",
        }).pipe(Effect.provide(FetchHttpClient.layer));
        const result = yield* client.call(ProjectsTool, {}).pipe(Effect.timeout("5 seconds"));
        assert.deepEqual(result, { outcome: "ok", projects: [] });
      }).pipe(Effect.scoped),
  );

  it.live("gives up at --timeout even when a call hasn't answered", () => {
    const script = defaultScript();
    return withStandIn(script, newSeen(), (port) =>
      Effect.gen(function* () {
        script.waitDelayMs = 20_000;
        const startedAt = Date.now();
        const result = yield* run([
          "thread",
          "wait",
          "thread-1",
          "--base-dir",
          dataFolder(port, TOKEN),
          "--timeout",
          "1",
        ]);
        assert.equal(result.code, EXIT.timedOut);
        assert.isBelow(Date.now() - startedAt, 5_000);
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
