/**
 * PiRpc — one `pi --mode rpc` process and its JSONL wire.
 *
 * Pi's RPC is not JSON-RPC. Commands are `{ type, id, ... }`, replies are
 * `{ type: "response", id, command, success, data | error }`, and events
 * carry no id. Replies are matched by id, never by order: Pi handles commands
 * concurrently, and an extension command can hold its own ack on a dialog.
 *
 * Framing is strict JSONL (Pi's `rpc.md`): records split on LF only, with one
 * trailing CR stripped. Node's `readline` is never used, because it also
 * splits on U+2028 and U+2029, which are legal inside JSON strings. Stdout is
 * read continuously: Pi honours backpressure, so a stalled reader stalls Pi.
 * Stderr is diagnostics only and is kept as a short tail.
 *
 * The process is spawned through the Effect child-process spawner, as Muse
 * Code's host is: a Windows `pi.cmd` launcher runs under cmd.exe
 * (`planCliSpawn`), consoles stay hidden, and closing the scope ends the
 * whole process tree. Closing first ends stdin, which asks Pi to shut down in
 * order; one that does not is killed after a grace window.
 *
 * @module provider/pi/PiRpc
 */
import type * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { hideWindowsConsole } from "@threadlines/shared/childProcess";

import { planCliSpawn } from "../../cliSpawn.ts";
import { isWindowsCommandNotFound } from "../../processRunner.ts";

const DEFAULT_STARTUP_TIMEOUT = Duration.seconds(20);
const DEFAULT_REQUEST_TIMEOUT = Duration.seconds(15);
const GRACEFUL_EXIT_TIMEOUT = Duration.seconds(10);
const FORCE_KILL_AFTER = Duration.seconds(3);
const STDERR_TAIL_CHARS = 4_000;
/**
 * A record longer than this is dropped rather than held: Pi's records carry
 * whole messages (images included), but nothing legitimate comes near it.
 */
export const PI_MAX_RECORD_CHARS = 64 * 1024 * 1024;
const encoder = new TextEncoder();

export class PiRpcError extends Data.TaggedError("PiRpcError")<{
  readonly operation: string;
  readonly detail: string;
  /**
   * `rejected`: Pi answered `success: false` (the detail is Pi's error).
   * `timeout`: no answer in time. `exited`: the process ended first.
   * `startup`: it never became ready. `spawn`: it could not start.
   */
  readonly kind: "rejected" | "timeout" | "exited" | "startup" | "spawn";
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.detail;
  }
}

export interface PiExit {
  /** Null when the exit status could not be read. */
  readonly code: number | null;
}

/** One record Pi wrote that is not a reply: an event or an `extension_ui_request`. */
export type PiRecord = Readonly<Record<string, unknown>> & { readonly type: string };

export interface PiCommand {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface PiRpc {
  /** Pi's `get_state` answer from startup. */
  readonly initialState: Readonly<Record<string, unknown>>;
  /**
   * Sends one command and resolves to its reply's `data` (`undefined` when
   * the reply has none). `timeout: null` waits as long as the process lives:
   * for commands that run a model (`compact`) or whose ack an extension can
   * hold (`prompt`).
   */
  readonly request: (
    command: PiCommand,
    options?: { readonly timeout?: Duration.Input | null },
  ) => Effect.Effect<unknown, PiRpcError>;
  /** Writes one record that expects no reply (`extension_ui_response`). */
  readonly send: (record: Readonly<Record<string, unknown>>) => Effect.Effect<void>;
  /** Every event and extension UI request, in arrival order. One consumer. */
  readonly records: Stream.Stream<PiRecord>;
  /**
   * How many records have been queued so far. Lines are read in order, so a
   * reply that has resolved came after the records counted then: a caller
   * that has handled that many has seen everything Pi said before replying.
   */
  readonly recordCount: () => number;
  /** Resolves once the process has exited. */
  readonly exited: Effect.Effect<PiExit>;
  readonly hasExited: Effect.Effect<boolean>;
  readonly stderrTail: () => string;
}

export interface PiRpcOptions {
  /** The program to run: `pi`, or Node for a managed install. */
  readonly command: string;
  /** Everything after the program, `--mode rpc` included (see `PiLaunch`). */
  readonly args: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd?: string | undefined;
  readonly startupTimeout?: Duration.Input | undefined;
  readonly requestTimeout?: Duration.Input | undefined;
  /** How long a closing process may drain before its tree is killed. */
  readonly exitGrace?: Duration.Input | undefined;
}

/**
 * Splits a text stream into Pi's JSONL records: LF only, one trailing CR
 * stripped, empty lines skipped. Records over `maxChars` are dropped whole
 * (their text up to the next LF is discarded) and counted.
 */
export class PiLineSplitter {
  private buffer = "";
  private discarding = false;
  private readonly maxChars: number;
  dropped = 0;

  constructor(maxChars: number = PI_MAX_RECORD_CHARS) {
    this.maxChars = maxChars;
  }

  push(chunk: string): Array<string> {
    const lines: Array<string> = [];
    let from = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", from);
      if (newline < 0) break;
      const piece = chunk.slice(from, newline);
      from = newline + 1;
      if (this.discarding) {
        this.discarding = false;
        this.buffer = "";
        continue;
      }
      let line = this.buffer + piece;
      this.buffer = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) lines.push(line);
    }
    const rest = chunk.slice(from);
    if (this.discarding) return lines;
    if (this.buffer.length + rest.length > this.maxChars) {
      this.buffer = "";
      this.discarding = true;
      this.dropped += 1;
      return lines;
    }
    this.buffer += rest;
    return lines;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const lastLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .findLast((line) => line.length > 0);

/** Plain words for an exit, for a turn or status message. */
export function describePiExit(exit: PiExit, stderrTail: string): string {
  const reason = lastLine(stderrTail);
  if (exit.code === 0) return "Pi stopped.";
  const suffix = reason ? `: ${reason}` : ".";
  return exit.code === null
    ? `Pi exited unexpectedly${suffix}`
    : `Pi exited unexpectedly (code ${exit.code})${suffix}`;
}

/**
 * The message for a startup that never answered because an extension asked a
 * question first. Pi 1.3 reads stdin only after extensions finish starting,
 * so the question can never be answered.
 */
export const PI_STARTUP_QUESTION_MESSAGE =
  "A Pi extension asked a question while Pi was starting. Threadlines can't answer it yet. Turn that extension off for Threadlines, or update Pi.";

/**
 * Starts one Pi process tied to the caller's scope and waits until it answers
 * `get_state`. Fails if the process exits first or the answer never comes.
 */
export const startPiRpc = (
  options: PiRpcOptions,
): Effect.Effect<PiRpc, PiRpcError, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Scope.Scope;
    const plan = planCliSpawn(options.command, [...options.args], options.environment);
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
            new PiRpcError({
              operation: "spawn",
              kind: "spawn",
              detail: `Could not start ${options.command}: ${cause.message}`,
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

    const exited = yield* Deferred.make<PiExit>();
    yield* child.exitCode.pipe(
      Effect.map((code): PiExit => ({ code: Number(code) })),
      Effect.orElseSucceed((): PiExit => ({ code: null })),
      Effect.flatMap((exit) => Deferred.succeed(exited, exit)),
      Effect.forkIn(scope),
    );

    const records = yield* Queue.unbounded<PiRecord, Cause.Done>();
    const pending = new Map<string, Deferred.Deferred<Record<string, unknown>, PiRpcError>>();
    let nextId = 0;
    // Set when an extension asks a question before startup's `get_state`
    // answers: the reason startup then hangs.
    let startupQuestion = false;
    let ready = false;
    let recordCount = 0;

    const splitter = new PiLineSplitter();
    const handleLine = (line: string) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(value) || typeof value.type !== "string") return;
      if (value.type === "response") {
        const id = typeof value.id === "string" ? value.id : undefined;
        const waiter = id === undefined ? undefined : pending.get(id);
        if (id !== undefined && waiter) {
          pending.delete(id);
          Deferred.doneUnsafe(waiter, Effect.succeed(value));
        }
        return;
      }
      if (!ready && value.type === "extension_ui_request") startupQuestion = true;
      recordCount += 1;
      Queue.offerUnsafe(records, value as PiRecord);
    };
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          for (const line of splitter.push(chunk)) handleLine(line);
        }),
      ),
      Effect.ignore,
      Effect.andThen(Deferred.await(exited)),
      Effect.flatMap((exit) =>
        Effect.sync(() => {
          const error = new PiRpcError({
            operation: "request",
            kind: "exited",
            detail: describePiExit(exit, stderrTail),
          });
          for (const waiter of pending.values()) Deferred.doneUnsafe(waiter, Effect.fail(error));
          pending.clear();
          Queue.endUnsafe(records);
        }),
      ),
      Effect.forkIn(scope),
    );

    // Registered after the spawn, so it runs before the spawner's own kill:
    // end stdin (Pi's orderly shutdown), give it the grace window, and only
    // then let the spawner end the tree.
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => Queue.endUnsafe(stdin)).pipe(
        Effect.andThen(Deferred.await(exited)),
        Effect.timeoutOption(options.exitGrace ?? GRACEFUL_EXIT_TIMEOUT),
        Effect.andThen(Queue.shutdown(records)),
        Effect.ignore,
      ),
    );

    const write = (record: Readonly<Record<string, unknown>>) =>
      Effect.sync(() => {
        Queue.offerUnsafe(stdin, encoder.encode(`${JSON.stringify(record)}\n`));
      });

    const requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
    const request: PiRpc["request"] = (command, requestOptions) => {
      nextId += 1;
      const id = `tl-${nextId}`;
      return Effect.gen(function* () {
        if (yield* Deferred.isDone(exited)) {
          const exit = yield* Deferred.await(exited);
          return yield* new PiRpcError({
            operation: command.type,
            kind: "exited",
            detail: describePiExit(exit, stderrTail),
          });
        }
        const waiter = yield* Deferred.make<Record<string, unknown>, PiRpcError>();
        pending.set(id, waiter);
        yield* write({ ...command, id });
        const timeout =
          requestOptions?.timeout === undefined ? requestTimeout : requestOptions.timeout;
        const awaited = Deferred.await(waiter);
        const response =
          timeout === null
            ? yield* awaited
            : yield* awaited.pipe(
                Effect.timeoutOption(timeout),
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(
                        new PiRpcError({
                          operation: command.type,
                          kind: "timeout",
                          detail: `Pi did not answer ${command.type} in time.`,
                        }),
                      ),
                    onSome: Effect.succeed,
                  }),
                ),
              );
        if (response.success !== true) {
          const error = typeof response.error === "string" ? response.error : "Pi refused it.";
          return yield* new PiRpcError({
            operation: command.type,
            kind: "rejected",
            detail: error,
          });
        }
        return response.data;
        // A reply that never came (timeout, interruption) leaves no waiter behind.
      }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(id))));
    };

    const startupFailure = (detail: string) =>
      new PiRpcError({
        operation: "startup",
        kind: "startup",
        detail: stderrTail.trim() ? `${detail}\n\n${stderrTail.trim()}` : detail,
      });
    const exitFailure = (exit: PiExit) =>
      exit.code !== null && isWindowsCommandNotFound(exit.code, stderrTail)
        ? new PiRpcError({
            operation: "spawn",
            kind: "spawn",
            detail: `spawn ${options.command} ENOENT`,
          })
        : new PiRpcError({
            operation: "startup",
            kind: "startup",
            detail: describePiExit(exit, stderrTail),
          });

    const initialState = yield* Effect.raceFirst(
      request({ type: "get_state" }, { timeout: null }).pipe(
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
          onNone: () =>
            Effect.fail(
              startupFailure(
                startupQuestion ? PI_STARTUP_QUESTION_MESSAGE : "Pi did not answer in time.",
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
    ready = true;

    return {
      initialState: isRecord(initialState) ? initialState : {},
      request,
      send: write,
      records: Stream.fromQueue(records),
      recordCount: () => recordCount,
      exited: Deferred.await(exited),
      hasExited: Deferred.isDone(exited),
      stderrTail: () => stderrTail,
    } satisfies PiRpc;
  });
