/**
 * The `threadlines` commands for scripts and for agents that run shell
 * commands but don't speak MCP (docs/design/outside-agents.md, "The
 * `threadlines` command"). The command is one more outside agent: it signs in
 * with `connect`, the user approves it in Threadlines as "Threadlines
 * command", and every other command calls one of `/mcp/connect`'s tools
 * under the same rules as any agent.
 *
 * Every command takes `--json` (the tool's result as it came, one line per
 * result), `--dev` (the Threadlines a dev build runs) and `--base-dir`.
 * Exit codes are connectExit.ts's.
 */
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { AgentThreadStatusWord, RuntimeMode } from "@threadlines/contracts";
import packageJson from "../../package.json" with { type: "json" };
import {
  AgentsTool,
  OutsideThreadReadTool,
  OutsideThreadSendTool,
  OutsideThreadStartTool,
  OutsideThreadStopTool,
  ProjectsTool,
  THREAD_WAIT_MAX_SECONDS,
  ThreadsListTool,
  ThreadWaitTool,
  type ThreadWaitResult,
} from "../outsideAgents/connectTools.ts";
import { launchBrowser } from "../process/externalLauncher.ts";
import { baseDirFlag } from "./config.ts";
import { type ConnectClient, makeConnectClient } from "./connectClient.ts";
import {
  forgetAllConnectTokens,
  forgetConnectToken,
  readConnectCredential,
} from "./connectCredentials.ts";
import {
  CommandExit,
  ConnectError,
  EXIT,
  type ExitCode,
  exitCodeForConnectError,
  SIGNED_OUT_MESSAGE,
} from "./connectExit.ts";
import { findThreadlines, resolveConnectLocation } from "./connectLocation.ts";
import {
  describeRefusal,
  exitCodeForOutcome,
  exitCodeForThread,
  formatAgents,
  formatProjects,
  formatStart,
  formatStop,
  formatThreadList,
  formatThreadRead,
  formatWait,
} from "./connectOutput.ts";
import { signIn } from "./connectSignIn.ts";

const CLIENT_VERSION = packageJson.version;
const SETTINGS_PLACE = "Threadlines > Settings > Connections > Agents";

const sharedFlags = {
  baseDir: baseDirFlag,
  dev: Flag.boolean("dev").pipe(
    Flag.withDescription("Use the Threadlines a dev build runs (its `dev` data folder)."),
    Flag.withDefault(false),
  ),
  json: Flag.boolean("json").pipe(
    Flag.withDescription("Print each result as JSON on one line, as Threadlines sent it."),
    Flag.withDefault(false),
  ),
} as const;

interface SharedFlags {
  readonly baseDir: Option.Option<string>;
  readonly dev: boolean;
  readonly json: boolean;
}

const threadIdArgument = Argument.string("thread").pipe(
  Argument.withDescription("The thread's id, from thread start or thread list."),
);

const requestIdFlag = Flag.string("request-id").pipe(
  Flag.withDescription(
    "Any unique string. Running the same command again with it returns the first result instead of doing it twice.",
  ),
  Flag.optional,
);

const waitFlag = Flag.boolean("wait").pipe(
  Flag.withDescription("Then wait until the thread stops working, and print its reply."),
  Flag.withDefault(false),
);

const timeoutFlag = Flag.integer("timeout").pipe(
  Flag.withDescription("Give up waiting after this many seconds (exit code 3). Default: never."),
  Flag.optional,
);

/** Ends the command with `code`, its message on stderr first. */
const exitWith = (code: ExitCode, message?: string) =>
  Effect.gen(function* () {
    if (message !== undefined) yield* Console.error(message);
    return yield* new CommandExit({ code });
  });

/** A usage mistake the parser can't see (an empty prompt). */
const usageError = (message: string) => exitWith(EXIT.failed, message);

/** Prints why a call never got an answer, and exits with its code. */
const endOnConnectError = <A, E, R>(effect: Effect.Effect<A, E | ConnectError, R>) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is ConnectError => error instanceof ConnectError,
      (error) => exitWith(exitCodeForConnectError(error), error.message),
    ),
    Effect.provide(FetchHttpClient.layer),
  );

/**
 * Runs a command against `/mcp/connect` with this computer's sign-in. A 401
 * forgets the token (keeping the registration) and asks for a new sign-in.
 */
const withClient = <A, E, R>(
  flags: SharedFlags,
  use: (client: ConnectClient) => Effect.Effect<A, E | ConnectError, R>,
) =>
  Effect.gen(function* () {
    const location = yield* resolveConnectLocation(flags);
    const target = yield* findThreadlines(location);
    const credential = yield* readConnectCredential(location.credentialsPath, target.resource);
    if (credential?.accessToken === undefined) {
      return yield* new ConnectError({ reason: "signed_out", message: SIGNED_OUT_MESSAGE });
    }
    const client = yield* makeConnectClient({
      resource: target.resource,
      token: credential.accessToken,
      clientVersion: CLIENT_VERSION,
    });
    return yield* use(client).pipe(
      Effect.tapError((error) =>
        error instanceof ConnectError && error.reason === "signed_out"
          ? forgetConnectToken(location.credentialsPath, target.resource).pipe(Effect.ignore)
          : Effect.void,
      ),
    );
  }).pipe(endOnConnectError);

/** Prints one tool result: as JSON, or as `text`. */
const show = (flags: SharedFlags, result: unknown, text: string) =>
  flags.json ? Console.log(JSON.stringify(result)) : Console.log(text);

interface OutcomeResult {
  readonly outcome: string;
  readonly detail?: string | undefined;
  readonly retryAfterSeconds?: number | undefined;
}

/**
 * Prints a result whose outcome may be a refusal or a failure: the result
 * (or why it was refused, on stderr), then exits with the outcome's code
 * when it isn't a success.
 */
const answer = <R extends OutcomeResult>(
  flags: SharedFlags,
  result: R,
  format: (result: R) => string,
) =>
  Effect.gen(function* () {
    const code = exitCodeForOutcome(result.outcome);
    if (code === EXIT.done) return yield* show(flags, result, format(result));
    if (flags.json) yield* Console.log(JSON.stringify(result));
    return yield* exitWith(code, flags.json ? undefined : describeRefusal(result));
  });

/**
 * The prompt or message: the argument, or stdin when it's `-` or left out
 * with stdin piped.
 */
const readText = (value: Option.Option<string>, what: string) =>
  Effect.gen(function* () {
    if (Option.isSome(value) && value.value !== "-") {
      if (value.value.trim().length === 0) return yield* usageError(`The ${what} is empty.`);
      return value.value;
    }
    const stdio = yield* Stdio.Stdio;
    if (Option.isNone(value) && (yield* stdio.stdinIsTerminal)) {
      return yield* usageError(`Give the ${what}, or pipe it in.`);
    }
    const text = yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString, Effect.orDie);
    if (text.trim().length === 0) return yield* usageError(`The ${what} from stdin is empty.`);
    return text.trimEnd();
  });

/** Shortest gap between two waits, should a server answer `still_working` at once. */
const MIN_WAIT_GAP_MS = 1_000;

/**
 * Waits for a thread to stop working: `thread_wait` again and again until
 * it's done, or `timeoutSeconds` runs out (none: never). A call refused for
 * the call rate waits and tries again. Once Threadlines has answered, a
 * moment when it doesn't (a restart) is waited out for half a minute.
 */
const waitForThread = (
  client: ConnectClient,
  flags: SharedFlags,
  threadId: string,
  timeoutSeconds: Option.Option<number>,
) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const deadline = Option.map(timeoutSeconds, (seconds) => startedAt + seconds * 1_000);
    let last: ThreadWaitResult | null = null;
    while (true) {
      const now = yield* Clock.currentTimeMillis;
      const remainingMs = Option.match(deadline, {
        onNone: () => Number.POSITIVE_INFINITY,
        onSome: (at) => at - now,
      });
      if (remainingMs <= 0) {
        if (last !== null) yield* show(flags, last, formatWait(last));
        return yield* exitWith(EXIT.timedOut, flags.json ? undefined : "Stopped waiting.");
      }
      const seconds = Math.max(
        1,
        Math.min(THREAD_WAIT_MAX_SECONDS, Math.ceil(remainingMs / 1_000)),
      );
      const call = client.call(ThreadWaitTool, { threadId, seconds });
      const result: ThreadWaitResult = yield* last === null
        ? call
        : call.pipe(
            Effect.retry({
              schedule: Schedule.spaced("2 seconds"),
              times: 15,
              while: (error) => error.reason === "not_running",
            }),
          );
      if (result.outcome === "still_working") {
        last = result;
        const took = (yield* Clock.currentTimeMillis) - now;
        if (took < MIN_WAIT_GAP_MS) yield* Effect.sleep(MIN_WAIT_GAP_MS - took);
        continue;
      }
      if (result.outcome === "limit") {
        const backOffMs = Math.max(1, result.retryAfterSeconds ?? 5) * 1_000;
        yield* Effect.sleep(Math.min(backOffMs, remainingMs));
        continue;
      }
      if (result.outcome !== "done") return yield* answer(flags, result, formatWait);
      yield* show(flags, result, formatWait(result));
      const code = exitCodeForThread(result.thread);
      if (code !== EXIT.done) return yield* new CommandExit({ code });
      return;
    }
  });

/**
 * `--agent <instance>[/<model>]`: an instance alone runs on the user's
 * default model when that is the instance's, else its first.
 */
const resolveAgent = (client: ConnectClient, flags: SharedFlags, raw: string) =>
  Effect.gen(function* () {
    const slash = raw.indexOf("/");
    if (slash > 0) return { instanceId: raw.slice(0, slash), model: raw.slice(slash + 1) };
    const agents = yield* client.call(AgentsTool, { instanceId: raw });
    if (agents.outcome !== "ok")
      return yield* answer(flags, agents, formatAgents).pipe(Effect.as(null));
    const agent = agents.agents.find((candidate) => candidate.instanceId === raw);
    const model =
      agents.default?.instanceId === raw ? agents.default.model : agent?.models[0]?.model;
    if (agent === undefined || model === undefined) {
      return yield* exitWith(
        EXIT.refused,
        `No ready agent is called ${raw}. Run threadlines agents to see them.`,
      );
    }
    return { instanceId: raw, model };
  });

// ----- commands --------------------------------------------------------------------

export const connectCommand = Command.make("connect", {
  ...sharedFlags,
  noBrowser: Flag.boolean("no-browser").pipe(
    Flag.withDescription("Print the sign-in link instead of opening a browser."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Sign this command in to Threadlines. You allow it in the Threadlines app.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const location = yield* resolveConnectLocation(flags);
      const target = yield* findThreadlines(location);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const result = yield* signIn({
        target,
        credentialsPath: location.credentialsPath,
        clientVersion: CLIENT_VERSION,
        noBrowser: flags.noBrowser,
        openBrowser: (url) =>
          launchBrowser(url).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        say: (text) => Console.error(text),
      }).pipe(Effect.scoped);
      const canStart = result.scope.split(" ").includes("threads:start");
      yield* show(
        flags,
        { connected: true, resource: target.resource, scope: result.scope },
        `Connected. This command can see threads${canStart ? " and start them" : ""}. To change what it can do, open ${SETTINGS_PLACE}.`,
      );
    }).pipe(
      Effect.catchTag("SignInEnded", (ended) =>
        exitWith(ended.reason === "timed_out" ? EXIT.timedOut : EXIT.refused, ended.message),
      ),
      endOnConnectError,
    ),
  ),
);

export const disconnectCommand = Command.make("disconnect", sharedFlags).pipe(
  Command.withDescription(
    `Forget this command's sign-in on this computer. To remove its connection too, open ${SETTINGS_PLACE}.`,
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const location = yield* resolveConnectLocation(flags);
      const forgot = yield* forgetAllConnectTokens(location.credentialsPath);
      yield* show(
        flags,
        { disconnected: forgot },
        forgot
          ? `Forgot the sign-in on this computer. To remove its connection too, open ${SETTINGS_PLACE}.`
          : "This command wasn't connected.",
      );
    }),
  ),
);

export const projectsCommand = Command.make("projects", sharedFlags).pipe(
  Command.withDescription("List the projects this command may use."),
  Command.withHandler((flags) =>
    withClient(flags, (client) =>
      client
        .call(ProjectsTool, {})
        .pipe(Effect.flatMap((result) => answer(flags, result, formatProjects))),
    ),
  ),
);

export const agentsCommand = Command.make("agents", sharedFlags).pipe(
  Command.withDescription("List the agents and models a thread can run on, and the default."),
  Command.withHandler((flags) =>
    withClient(flags, (client) =>
      client
        .call(AgentsTool, {})
        .pipe(Effect.flatMap((result) => answer(flags, result, formatAgents))),
    ),
  ),
);

/** `--status` values: the status words, with `needs-user` for the one with spaces. */
const STATUS_CHOICES = ["working", "needs-user", "waiting", "failed", "idle", "wrapped"] as const;
const statusWord = (choice: (typeof STATUS_CHOICES)[number]): AgentThreadStatusWord =>
  choice === "needs-user" ? "needs the user" : choice;

const threadListCommand = Command.make("list", {
  ...sharedFlags,
  project: Flag.string("project").pipe(
    Flag.withDescription("Only this project (its id or name)."),
    Flag.optional,
  ),
  status: Flag.choice("status", STATUS_CHOICES).pipe(
    Flag.withDescription("Only threads with this status."),
    Flag.optional,
  ),
  mine: Flag.boolean("mine").pipe(
    Flag.withDescription("Only threads this command started."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("List threads, most recently active first."),
  Command.withHandler((flags) =>
    withClient(flags, (client) =>
      client
        .call(ThreadsListTool, {
          ...Option.match(flags.project, {
            onNone: () => ({}),
            onSome: (project) => ({ project }),
          }),
          ...Option.match(flags.status, {
            onNone: () => ({}),
            onSome: (status) => ({ status: statusWord(status) }),
          }),
          ...(flags.mine ? { mine: true } : {}),
        })
        .pipe(Effect.flatMap((result) => answer(flags, result, formatThreadList))),
    ),
  ),
);

const threadStartCommand = Command.make("start", {
  ...sharedFlags,
  project: Argument.string("project").pipe(
    Argument.withDescription("The project's id or name, from threadlines projects."),
  ),
  prompt: Argument.string("prompt").pipe(
    Argument.withDescription(
      "Everything the thread needs to do the work. `-` or left out with stdin piped: read from stdin.",
    ),
    Argument.optional,
  ),
  title: Flag.string("title").pipe(
    Flag.withDescription("A few words naming the work."),
    Flag.optional,
  ),
  agent: Flag.string("agent").pipe(
    Flag.withDescription("<instance>[/<model>] from threadlines agents. Default: the user's."),
    Flag.optional,
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Work in the project folder itself, not a new worktree."),
    Flag.withDefault(false),
  ),
  access: Flag.choice("access", RuntimeMode.literals).pipe(
    Flag.withDescription("The access to ask for. It gets at most what the user allowed."),
    Flag.optional,
  ),
  requestId: requestIdFlag,
  wait: waitFlag,
  timeout: timeoutFlag,
}).pipe(
  Command.withDescription("Start a thread in a project, as if the user started it in the app."),
  Command.withHandler((flags) =>
    withClient(flags, (client) =>
      Effect.gen(function* () {
        const prompt = yield* readText(flags.prompt, "prompt");
        const agent = Option.isSome(flags.agent)
          ? yield* resolveAgent(client, flags, flags.agent.value)
          : null;
        const result = yield* client.call(OutsideThreadStartTool, {
          project: flags.project,
          prompt,
          ...Option.match(flags.title, { onNone: () => ({}), onSome: (title) => ({ title }) }),
          ...(agent === null ? {} : { agent }),
          ...(flags.local ? { workspace: "project_folder" as const } : {}),
          ...Option.match(flags.access, { onNone: () => ({}), onSome: (access) => ({ access }) }),
          ...Option.match(flags.requestId, {
            onNone: () => ({}),
            onSome: (requestId) => ({ requestId }),
          }),
        } satisfies Tool.ParametersEncoded<typeof OutsideThreadStartTool>);
        yield* answer(flags, result, formatStart);
        if (flags.wait && result.thread !== undefined) {
          yield* waitForThread(client, flags, result.thread.threadId, flags.timeout);
        }
      }),
    ),
  ),
);

const threadSendCommand = Command.make("send", {
  ...sharedFlags,
  thread: threadIdArgument,
  message: Argument.string("message").pipe(
    Argument.withDescription(
      "What you want it to do or answer. `-` or left out with stdin piped: read from stdin.",
    ),
    Argument.optional,
  ),
  requestId: requestIdFlag,
  wait: waitFlag,
  timeout: timeoutFlag,
}).pipe(
  Command.withDescription(
    "Send a message to a thread this command started. It must not be working.",
  ),
  Command.withHandler((flags) =>
    withClient(flags, (client) =>
      Effect.gen(function* () {
        const message = yield* readText(flags.message, "message");
        const result = yield* client.call(OutsideThreadSendTool, {
          threadId: flags.thread,
          message,
          ...Option.match(flags.requestId, {
            onNone: () => ({}),
            onSome: (requestId) => ({ requestId }),
          }),
        });
        yield* answer(flags, result, () => "Sent.");
        if (flags.wait) yield* waitForThread(client, flags, flags.thread, flags.timeout);
      }),
    ),
  ),
);

const threadReadCommand = Command.make("read", {
  ...sharedFlags,
  thread: threadIdArgument,
  after: Flag.integer("after").pipe(
    Flag.withDescription("Only messages after this one (a read's `next`)."),
    Flag.optional,
  ),
  limit: Flag.integer("limit").pipe(
    Flag.withDescription("At most this many messages. Default: 20."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Read a thread: its status and its messages, oldest first."),
  Command.withHandler((flags) =>
    withClient(flags, (client) =>
      client
        .call(OutsideThreadReadTool, {
          threadId: flags.thread,
          ...Option.match(flags.after, { onNone: () => ({}), onSome: (after) => ({ after }) }),
          ...Option.match(flags.limit, { onNone: () => ({}), onSome: (limit) => ({ limit }) }),
        })
        .pipe(Effect.flatMap((result) => answer(flags, result, formatThreadRead))),
    ),
  ),
);

const threadWaitCommand = Command.make("wait", {
  ...sharedFlags,
  thread: threadIdArgument,
  timeout: timeoutFlag,
}).pipe(
  Command.withDescription(
    "Wait until a thread stops working, then print its status and newest reply.",
  ),
  Command.withHandler((flags) =>
    withClient(flags, (client) => waitForThread(client, flags, flags.thread, flags.timeout)),
  ),
);

const threadStopCommand = Command.make("stop", { ...sharedFlags, thread: threadIdArgument }).pipe(
  Command.withDescription("Stop the running turn in a thread this command started."),
  Command.withHandler((flags) =>
    withClient(flags, (client) =>
      client
        .call(OutsideThreadStopTool, { threadId: flags.thread })
        .pipe(Effect.flatMap((result) => answer(flags, result, formatStop))),
    ),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Start, follow, message and stop Threadlines threads."),
  Command.withSubcommands([
    threadListCommand,
    threadStartCommand,
    threadSendCommand,
    threadReadCommand,
    threadWaitCommand,
    threadStopCommand,
  ]),
);
