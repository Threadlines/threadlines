/**
 * OpenCodeServer — start or reach one OpenCode 2 HTTP server.
 *
 * Threadlines runs a private server per provider instance with
 * `opencode serve --stdio --port 0`. That mode prints its URL as a single JSON
 * line and exits when its stdin closes, so the server cannot outlive this
 * process, even when this process crashes. The password is random per launch
 * and only ever travels in the child's environment. A private server also
 * never runs OpenCode's restart sweep, which belongs to the user's shared
 * background service.
 *
 * An external server (settings `serverUrl`) is reached as-is and never
 * stopped.
 *
 * @module provider/opencode/OpenCodeServer
 */
import { randomBytes } from "node:crypto";

import { hideWindowsConsole } from "@threadlines/shared/childProcess";
import { compareSemverVersions } from "@threadlines/shared/semver";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { planCliSpawn } from "../../cliSpawn.ts";
import { isWindowsCommandNotFound } from "../../processRunner.ts";
import { isCommandMissingCause } from "../providerSnapshot.ts";
import {
  makeOpenCodeClient,
  type OpenCodeClient,
  OpenCodeError,
  openCodeErrorDetail,
  openCodeErrorStatus,
  runOpenCode,
} from "./OpenCodeClient.ts";

/**
 * The oldest OpenCode the driver is tested against (the live suite passes on
 * 2.0.20, which Homebrew core ships as `opencode`).
 */
export const MINIMUM_OPENCODE_VERSION = "2.0.20";

const STARTUP_TIMEOUT = Duration.seconds(30);
const GRACEFUL_EXIT_TIMEOUT = Duration.seconds(3);
/** After SIGTERM, how long a server may linger before SIGKILL. */
const FORCE_KILL_AFTER = Duration.seconds(2);
const STDERR_TAIL_CHARS = 4_000;

export interface OpenCodeServer {
  readonly url: string;
  readonly client: OpenCodeClient;
  readonly version: string;
  /** Reached through settings `serverUrl`; Threadlines does not own it. */
  readonly external: boolean;
  /** Resolves when an owned server process exits, for any reason. Never resolves for external servers. */
  readonly exited: Effect.Effect<void>;
}

/**
 * `opencode --version` prints `opencode v2.0.22` on 2.x and a bare `1.18.32`
 * on 1.x.
 */
export function parseOpenCodeVersion(output: string): string | undefined {
  return /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(output)?.[1];
}

export function isSupportedOpenCodeVersion(version: string): boolean {
  return compareSemverVersions(version, MINIMUM_OPENCODE_VERSION) >= 0;
}

/** OpenCode 1.x: a separate line that moves to 2 by a fresh install, not an update. */
export function isOpenCodeOneVersion(version: string): boolean {
  return compareSemverVersions(version, "2.0.0") < 0;
}

/**
 * The child's environment: our password replaces any inherited one (OpenCode
 * 2 prefers `OPENCODE_PASSWORD` over the 1.x `OPENCODE_SERVER_PASSWORD`, and a
 * stale one of either would lock us out), and the client id names us in
 * OpenCode's outbound requests.
 */
export function openCodeServerEnvironment(
  base: NodeJS.ProcessEnv,
  password: string,
): NodeJS.ProcessEnv {
  const { OPENCODE_PASSWORD: _password, OPENCODE_SERVER_PASSWORD: _legacyPassword, ...rest } = base;
  return { ...rest, OPENCODE_PASSWORD: password, OPENCODE_CLIENT: "threadlines" };
}

function parseUrlLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && "url" in parsed) {
      const url = (parsed as { url: unknown }).url;
      return typeof url === "string" && url.length > 0 ? url : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * `GET /api/info` is the only route that proves an OpenCode 2 server: every
 * non-API path serves the web UI's HTML with a 200, and 1.x has no `/api`.
 * While booting it answers 503, so it is retried until the deadline.
 */
const readServerInfo = (client: OpenCodeClient, operation: string) =>
  runOpenCode(operation, (signal) => client.server.info({ signal })).pipe(
    Effect.retry({
      while: (error) => openCodeErrorStatus(error) === 503,
      schedule: Schedule.spaced(Duration.millis(250)),
    }),
    Effect.flatMap((info) =>
      typeof info?.version === "string"
        ? Effect.succeed(info.version)
        : Effect.fail(
            new OpenCodeError({
              operation,
              detail:
                "The server did not answer like an OpenCode 2 server (no version in /api/info).",
            }),
          ),
    ),
  );

const requireSupportedVersion = (version: string, operation: string) =>
  isSupportedOpenCodeVersion(version)
    ? Effect.void
    : Effect.fail(
        new OpenCodeError({
          operation,
          detail: `OpenCode ${version} is too old. Threadlines needs OpenCode ${MINIMUM_OPENCODE_VERSION} or newer.`,
        }),
      );

/**
 * Start a private server tied to the caller's scope. Closing the scope closes
 * the server's stdin, which stops it; a server that ignores that is killed.
 */
export const startOpenCodeServer = (input: {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd?: string;
}): Effect.Effect<
  OpenCodeServer,
  OpenCodeError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const operation = "opencode serve";
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Scope.Scope;
    const password = randomBytes(32).toString("base64url");
    const closeStdin = yield* Deferred.make<void>();
    const environment = openCodeServerEnvironment(input.environment, password);
    // npm installs a `.cmd` shim on Windows, which only cmd.exe runs.
    const plan = planCliSpawn(input.binaryPath, ["serve", "--stdio", "--port", "0"], environment);

    const child = yield* spawner
      .spawn(
        ChildProcess.make(
          plan.command,
          [...plan.args],
          hideWindowsConsole({
            ...(input.cwd ? { cwd: input.cwd } : {}),
            env: environment,
            ...plan.options,
            forceKillAfter: FORCE_KILL_AFTER,
            // The server lives exactly as long as this stream: completing it
            // closes stdin, and OpenCode exits on EOF.
            stdin: { stream: Stream.fromEffect(Deferred.await(closeStdin)).pipe(Stream.drain) },
          }),
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new OpenCodeError({
              operation,
              detail: `Could not start ${input.binaryPath}: ${openCodeErrorDetail(cause)}`,
              cause,
            }),
        ),
      );

    const exited = yield* Deferred.make<number>();
    yield* child.exitCode.pipe(
      Effect.map(Number),
      Effect.orElseSucceed(() => -1),
      Effect.flatMap((code) => Deferred.succeed(exited, code)),
      Effect.forkIn(scope),
    );

    // Registered after the spawn, so it runs before the spawner's own kill:
    // ask politely first, then let the spawner finish the job.
    yield* Scope.addFinalizer(
      scope,
      Deferred.succeed(closeStdin, undefined).pipe(
        Effect.andThen(Deferred.await(exited).pipe(Effect.timeoutOption(GRACEFUL_EXIT_TIMEOUT))),
        Effect.ignore,
      ),
    );

    let stderrTail = "";
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
        }),
      ),
      Effect.ignore,
      Effect.forkIn(scope),
    );

    // The first stdout line is the URL; the rest is drained so the pipe never
    // fills and stalls the server.
    const urlLine = yield* Deferred.make<string>();
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => {
        const url = parseUrlLine(line);
        return url ? Deferred.succeed(urlLine, url) : Effect.void;
      }),
      Effect.ignore,
      Effect.forkIn(scope),
    );

    const startupFailure = (detail: string) =>
      new OpenCodeError({
        operation,
        detail: stderrTail.trim() ? `${detail}\n\n${stderrTail.trim()}` : detail,
      });

    const url = yield* Effect.raceFirst(
      Deferred.await(urlLine),
      Deferred.await(exited).pipe(
        Effect.flatMap((code) =>
          Effect.fail(
            isWindowsCommandNotFound(code, stderrTail)
              ? new OpenCodeError({ operation, detail: `spawn ${input.binaryPath} ENOENT` })
              : startupFailure(`OpenCode exited before it was ready (code ${code}).`),
          ),
        ),
      ),
    ).pipe(
      Effect.timeoutOption(STARTUP_TIMEOUT),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              startupFailure(
                `OpenCode did not report its address within ${Duration.toSeconds(STARTUP_TIMEOUT)}s.`,
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

    const client = makeOpenCodeClient({ url, password });
    const version = yield* readServerInfo(client, operation).pipe(
      Effect.timeoutOption(STARTUP_TIMEOUT),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(startupFailure("OpenCode never finished booting.")),
          onSome: Effect.succeed,
        }),
      ),
    );
    yield* requireSupportedVersion(version, operation);

    return {
      url,
      client,
      version,
      external: false,
      exited: Deferred.await(exited).pipe(Effect.asVoid),
    } satisfies OpenCodeServer;
  });

/** Reach a server the user runs themselves. */
export const connectOpenCodeServer = (input: {
  readonly url: string;
  readonly password: string | undefined;
}): Effect.Effect<OpenCodeServer, OpenCodeError> =>
  Effect.gen(function* () {
    const operation = "connect to OpenCode server";
    const client = makeOpenCodeClient(input);
    const version = yield* readServerInfo(client, operation).pipe(
      Effect.timeoutOption(Duration.seconds(10)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new OpenCodeError({ operation, detail: `No answer from ${input.url} in 10s.` }),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.mapError((error) =>
        openCodeErrorStatus(error) === 401
          ? new OpenCodeError({
              operation,
              detail: `${input.url} refused the server password.`,
              cause: error,
            })
          : error,
      ),
    );
    yield* requireSupportedVersion(version, operation);
    return { url: input.url, client, version, external: true, exited: Effect.never };
  });

/** `opencode --version`, without starting a server. */
export const probeOpenCodeVersion = (input: {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.Effect<
  { readonly version: string | undefined; readonly output: string },
  OpenCodeError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const plan = planCliSpawn(input.binaryPath, ["--version"], input.environment);
    const child = yield* spawner.spawn(
      ChildProcess.make(
        plan.command,
        [...plan.args],
        hideWindowsConsole({
          env: input.environment,
          ...plan.options,
          forceKillAfter: FORCE_KILL_AFTER,
        }),
      ),
    );
    const [stdout, stderr, code] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    if (isWindowsCommandNotFound(code, stderr)) {
      return yield* new OpenCodeError({
        operation: "opencode --version",
        detail: `spawn ${input.binaryPath} ENOENT`,
      });
    }
    const output = `${stdout}\n${stderr}`.trim();
    return { version: parseOpenCodeVersion(output), output };
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(Duration.seconds(15)),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new OpenCodeError({
              operation: "opencode --version",
              detail: `${input.binaryPath} --version did not finish within 15s.`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
    Effect.mapError((cause) =>
      OpenCodeError.is(cause)
        ? cause
        : new OpenCodeError({
            operation: "opencode --version",
            detail: openCodeErrorDetail(cause),
            cause,
          }),
    ),
  );

/**
 * Whether a failure means the binary was not found at all: the spawner says
 * `NotFound`/`ENOENT`, Windows' shell says "not recognized".
 */
export function isOpenCodeNotInstalledError(error: OpenCodeError): boolean {
  return isCommandMissingCause({ message: error.detail }) || /not recognized/i.test(error.detail);
}
