/**
 * MuseHost — one `muse serve` process and its Muse Session Protocol (MSP)
 * connection.
 *
 * The process is spawned through the Effect child-process spawner, so a
 * Windows `muse.cmd` launcher runs under cmd.exe (`planCliSpawn`), consoles
 * stay hidden, and closing the scope ends the whole process tree. The wire is
 * the official `@muse-code/sdk` `Connection` (NDJSON framing, request
 * correlation, idempotent `commandId`s), fed from the child's stdio.
 *
 * Closing the scope first ends the connection, which closes stdin: a healthy
 * host exits on EOF. One that does not is killed by the spawner.
 *
 * @module provider/muse/MuseHost
 */
import { Connection, MspError } from "@muse-code/sdk";
import type * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { hideWindowsConsole } from "@threadlines/shared/childProcess";

import { planCliSpawn } from "../../cliSpawn.ts";
import { isWindowsCommandNotFound } from "../../processRunner.ts";

const DEFAULT_STARTUP_TIMEOUT = Duration.seconds(20);
const DEFAULT_REQUEST_TIMEOUT = Duration.seconds(30);
const GRACEFUL_EXIT_TIMEOUT = Duration.seconds(10);
const FORCE_KILL_AFTER = Duration.seconds(3);
const STDERR_TAIL_CHARS = 4_000;
const encoder = new TextEncoder();

/** The MSP envelope version this driver speaks. */
export const MUSE_SCHEMA_VERSION = 1;

export class MuseHostError extends Data.TaggedError("MuseHostError")<{
  readonly operation: string;
  readonly detail: string;
  /** MSP error kind (`sessionInUse`, `commandRejected`, …) when the host answered with one. */
  readonly kind?: string | undefined;
  readonly code?: number | undefined;
  readonly retryable?: boolean | undefined;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.detail;
  }
}

/** How a host process ended, read from its exit code (MSP's exit contract). */
export type MuseHostExit =
  | { readonly kind: "clean" }
  | { readonly kind: "configError"; readonly code: number }
  | { readonly kind: "leaseUnavailable"; readonly code: number }
  | { readonly kind: "sdkDisabled"; readonly code: number }
  | { readonly kind: "usageError"; readonly code: number }
  | { readonly kind: "crash"; readonly code: number };

export function classifyMuseExit(code: number): MuseHostExit {
  switch (code) {
    case 0:
      return { kind: "clean" };
    case 2:
      return { kind: "usageError", code };
    case 3:
      return { kind: "configError", code };
    case 4:
      return { kind: "leaseUnavailable", code };
    case 5:
      return { kind: "sdkDisabled", code };
    default:
      return { kind: "crash", code };
  }
}

/** Plain words for an exit, for a turn or status message. */
export function describeMuseExit(exit: MuseHostExit, stderrTail: string): string {
  const reason = lastLine(stderrTail);
  const suffix = reason ? `: ${reason}` : ".";
  switch (exit.kind) {
    case "clean":
      return "Muse Code stopped.";
    case "configError":
      return `Muse Code could not start with its settings or sign-in${suffix}`;
    case "leaseUnavailable":
      return "Another Muse Code process is still using this conversation.";
    case "sdkDisabled":
      return "This Muse Code install has its app connection turned off (MUSE_EXPERIMENTAL_SDK_ENABLED=off).";
    case "usageError":
      return `Muse Code refused how Threadlines started it${suffix}`;
    case "crash":
      return `Muse Code exited unexpectedly (code ${exit.code})${suffix}`;
  }
}

function lastLine(text: string): string | undefined {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .findLast((line) => line.length > 0);
}

export interface MuseInitializeResult {
  readonly serverVersion: string | undefined;
  readonly grantedCapabilities: ReadonlyArray<string>;
  readonly experimentalApi: boolean;
  readonly museHome: string | undefined;
  readonly platformOs: string | undefined;
  /** `available` / `unavailable`; absent from hosts older than 1.4.7. */
  readonly sandboxAvailability: string | undefined;
  readonly sessionDurability: string | undefined;
}

export interface MuseNotification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface MuseServerRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface MuseHost {
  readonly initialize: MuseInitializeResult;
  /** A query (no `commandId`). */
  readonly request: (
    method: string,
    params?: Record<string, unknown>,
    options?: { readonly timeout?: Duration.Input },
  ) => Effect.Effect<Record<string, unknown>, MuseHostError>;
  /**
   * A command: the connection adds `commandId` (or uses the one given) and
   * retries a retryable refusal with the same id, so a retry never runs twice.
   */
  readonly command: (
    method: string,
    params: Record<string, unknown>,
    options?: {
      readonly commandId?: string;
      readonly maxAttempts?: number;
      readonly timeout?: Duration.Input;
    },
  ) => Effect.Effect<Record<string, unknown>, MuseHostError>;
  readonly mintCommandId: () => string;
  /** Every notification, in arrival order. One consumer. */
  readonly notifications: Stream.Stream<MuseNotification>;
  /** Server-to-client requests (`approval/request`, `userInput/request`); answered `{}`. */
  readonly serverRequests: Stream.Stream<MuseServerRequest>;
  /** Resolves once the process has exited. */
  readonly exited: Effect.Effect<MuseHostExit>;
  /** Whether the process has exited. */
  readonly hasExited: Effect.Effect<boolean>;
  readonly stderrTail: () => string;
}

export interface MuseHostOptions {
  readonly binaryPath: string;
  /** `serve` and its flags. */
  readonly args: ReadonlyArray<string>;
  /** The host's whole environment, already prepared (see `museHostEnvironment`). */
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd?: string | undefined;
  readonly clientName?: string | undefined;
  readonly experimentalApi?: boolean | undefined;
  readonly requestedCapabilities?: ReadonlyArray<string> | undefined;
  readonly startupTimeout?: Duration.Input | undefined;
  readonly requestTimeout?: Duration.Input | undefined;
  /** How long a closing host may drain before its process tree is killed. */
  readonly exitGrace?: Duration.Input | undefined;
}

/** The MSP error fields, when `cause` is one the host sent. */
export function mspErrorFields(cause: unknown): {
  readonly kind?: string;
  readonly code?: number;
  readonly retryable?: boolean;
  readonly data?: Readonly<Record<string, unknown>>;
} {
  if (cause instanceof MspError) {
    return {
      kind: cause.kind,
      code: cause.code,
      ...(cause.retryable !== undefined ? { retryable: cause.retryable } : {}),
      data: cause.data,
    };
  }
  return {};
}

const toHostError = (operation: string, cause: unknown): MuseHostError => {
  const fields = mspErrorFields(cause);
  const detail = cause instanceof Error && cause.message ? cause.message : String(cause);
  return new MuseHostError({
    operation,
    detail: `Muse ${operation} failed: ${detail}`,
    ...(fields.kind !== undefined ? { kind: fields.kind } : {}),
    ...(fields.code !== undefined ? { code: fields.code } : {}),
    ...(fields.retryable !== undefined ? { retryable: fields.retryable } : {}),
    cause,
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (record: Record<string, unknown>, key: string): string | undefined =>
  typeof record[key] === "string" ? (record[key] as string) : undefined;

function readInitializeResult(result: Record<string, unknown>): MuseInitializeResult {
  const serverInfo = isRecord(result.serverInfo) ? result.serverInfo : {};
  return {
    serverVersion: stringField(serverInfo, "version"),
    grantedCapabilities: Array.isArray(result.grantedCapabilities)
      ? result.grantedCapabilities.filter((entry): entry is string => typeof entry === "string")
      : [],
    experimentalApi: result.experimentalApi === true,
    museHome: stringField(result, "museHome"),
    platformOs: stringField(result, "platformOs"),
    sandboxAvailability: stringField(result, "sandboxAvailability"),
    sessionDurability: stringField(result, "sessionDurability"),
  };
}

/**
 * Starts one host tied to the caller's scope and completes the MSP handshake
 * (`initialize`, then `initialized`). Fails if the process exits first, the
 * handshake times out, or the host speaks another envelope version.
 */
export const startMuseHost = (
  options: MuseHostOptions,
): Effect.Effect<MuseHost, MuseHostError, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Scope.Scope;
    const plan = planCliSpawn(options.binaryPath, [...options.args], options.environment);
    const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done>();

    const child = yield* spawner
      .spawn(
        ChildProcess.make(
          plan.command,
          [...plan.args],
          hideWindowsConsole({
            ...(options.cwd ? { cwd: options.cwd } : {}),
            env: options.environment,
            ...plan.options,
            forceKillAfter: FORCE_KILL_AFTER,
            stdin: { stream: Stream.fromQueue(stdin) },
          }),
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new MuseHostError({
              operation: "spawn",
              detail: `Could not start ${options.binaryPath}: ${cause.message}`,
              cause,
            }),
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

    const exited = yield* Deferred.make<MuseHostExit>();
    yield* child.exitCode.pipe(
      Effect.map((code) => classifyMuseExit(Number(code))),
      Effect.orElseSucceed((): MuseHostExit => ({ kind: "crash", code: -1 })),
      Effect.flatMap((exit) => Deferred.succeed(exited, exit)),
      Effect.forkIn(scope),
    );

    const notifications = yield* Queue.unbounded<MuseNotification>();
    const serverRequests = yield* Queue.unbounded<MuseServerRequest>();

    const connection = new Connection({
      incoming: Stream.toAsyncIterable(child.stdout.pipe(Stream.decodeText())),
      write: (chunk) => {
        Queue.offerUnsafe(stdin, encoder.encode(chunk));
        return Promise.resolve();
      },
      close: () => {
        Queue.endUnsafe(stdin);
      },
    });
    connection.onNotification((notification) => {
      Queue.offerUnsafe(notifications, {
        method: notification.method,
        params: isRecord(notification.params) ? notification.params : {},
      });
    });
    // Receipts only: the matching notifications carry the same payload, and
    // decisions travel as `approval/decide` / `userInput/answer` commands.
    connection.onServerRequest(async (request) => {
      Queue.offerUnsafe(serverRequests, {
        method: request.method,
        params: isRecord(request.params) ? request.params : {},
      });
      return {};
    });
    connection.onProtocolError(() => {
      // Framing problems surface as request failures and the stream ending.
    });

    // Registered after the spawn, so it runs before the spawner's own kill:
    // end the connection (stdin EOF), give the host its drain window, and
    // only then let the spawner end the tree. The window bounds close() too:
    // it settles only once the host's output ends, which a host that ignores
    // EOF never does.
    yield* Scope.addFinalizer(
      scope,
      Effect.promise(() => connection.close().catch(() => undefined)).pipe(
        Effect.andThen(Deferred.await(exited)),
        Effect.timeoutOption(options.exitGrace ?? GRACEFUL_EXIT_TIMEOUT),
        Effect.andThen(Effect.sync(() => Queue.endUnsafe(stdin))),
        Effect.andThen(Queue.shutdown(notifications)),
        Effect.andThen(Queue.shutdown(serverRequests)),
        Effect.ignore,
      ),
    );

    const requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
    const withTimeout = <A>(
      operation: string,
      effect: Effect.Effect<A, MuseHostError>,
      timeout: Duration.Input,
    ) =>
      effect.pipe(
        Effect.timeoutOption(timeout),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new MuseHostError({
                  operation,
                  detail: `Muse did not answer ${operation} in time.`,
                  kind: "timeout",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );

    const request: MuseHost["request"] = (method, params, requestOptions) =>
      withTimeout(
        method,
        Effect.tryPromise({
          try: () => connection.request(method, params ?? {}),
          catch: (cause) => toHostError(method, cause),
        }),
        requestOptions?.timeout ?? requestTimeout,
      );

    const command: MuseHost["command"] = (method, params, commandOptions) =>
      withTimeout(
        method,
        Effect.tryPromise({
          try: () =>
            connection.command(method, params, {
              ...(commandOptions?.commandId ? { commandId: commandOptions.commandId } : {}),
              ...(commandOptions?.maxAttempts !== undefined
                ? { maxAttempts: commandOptions.maxAttempts }
                : {}),
            }),
          catch: (cause) => toHostError(method, cause),
        }),
        commandOptions?.timeout ?? requestTimeout,
      );

    const startupFailure = (detail: string) =>
      new MuseHostError({
        operation: "initialize",
        detail: stderrTail.trim() ? `${detail}\n\n${stderrTail.trim()}` : detail,
      });

    // A host that refuses to start (bad settings, no sign-in store) exits with
    // its reason on stderr; that reason beats "connection reached EOF".
    const exitFailure = (exit: MuseHostExit) =>
      exit.kind === "crash" && isWindowsCommandNotFound(exit.code, stderrTail)
        ? new MuseHostError({ operation: "spawn", detail: `spawn ${options.binaryPath} ENOENT` })
        : new MuseHostError({
            operation: "initialize",
            detail: describeMuseExit(exit, stderrTail),
          });
    const initializeResult = yield* Effect.raceFirst(
      Effect.tryPromise({
        try: () =>
          connection.request("initialize", {
            clientInfo: {
              name: options.clientName ?? "threadlines",
              title: "Threadlines",
              version: "1",
            },
            capabilities: {
              ...(options.experimentalApi ? { experimentalApi: true } : {}),
              ...(options.requestedCapabilities && options.requestedCapabilities.length > 0
                ? { requestedCapabilities: [...options.requestedCapabilities] }
                : {}),
            },
          }),
        catch: (cause) => toHostError("initialize", cause),
      }).pipe(
        Effect.catch((error) =>
          Deferred.await(exited).pipe(
            Effect.timeoutOption(Duration.seconds(2)),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(error),
                onSome: (exit) => Effect.fail(exitFailure(exit)),
              }),
            ),
          ),
        ),
      ),
      Deferred.await(exited).pipe(Effect.flatMap((exit) => Effect.fail(exitFailure(exit)))),
    ).pipe(
      Effect.timeoutOption(options.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(startupFailure("Muse Code did not answer in time.")),
          onSome: Effect.succeed,
        }),
      ),
    );

    const schema = isRecord(initializeResult.schema) ? initializeResult.schema : {};
    if (schema.version !== MUSE_SCHEMA_VERSION) {
      return yield* new MuseHostError({
        operation: "initialize",
        detail: `This Muse Code speaks session protocol version ${String(schema.version)}; Threadlines speaks ${MUSE_SCHEMA_VERSION}.`,
      });
    }
    connection.notify("initialized");

    return {
      initialize: readInitializeResult(initializeResult),
      request,
      command,
      mintCommandId: () => connection.mintCommandId(),
      notifications: Stream.fromQueue(notifications),
      serverRequests: Stream.fromQueue(serverRequests),
      exited: Deferred.await(exited),
      hasExited: Deferred.isDone(exited),
      stderrTail: () => stderrTail,
    } satisfies MuseHost;
  });
