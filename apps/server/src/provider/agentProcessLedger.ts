// @effect-diagnostics nodeBuiltinImport:off
/**
 * Proof that an agent's processes are gone (docs/design/fleet.md, Part 3b,
 * "Confirmed teardown"). A driver tracks each agent process it starts here,
 * by session key; its stop path calls `beforeStop` while the process still
 * lives, which notes every process it started (in any process group, so a
 * shell an agent put in a group of its own is found too); and
 * `confirmThreadStopped` asks `confirm`, which waits for the agent to exit,
 * ends what outlived it, and says whether everything is gone.
 *
 * On POSIX each tracked process leads its own process group (Effect's
 * spawner detaches by default, and the Claude driver spawns its CLI that
 * way), so the group is checked as a whole. Windows has no process groups
 * and no cheap process table: there the proof is that the agent's process
 * exited after its whole tree was killed (`taskkill /T`), which can miss a
 * process that left the tree.
 */
import { execFile } from "node:child_process";

import { listDescendantProcessIdsAsync } from "@threadlines/shared/processTree";
import { parseSessionKey } from "@threadlines/shared/threadParticipants";
import type { ThreadId } from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as Scope from "effect/Scope";

import type { ProviderStopConfirmation } from "./Services/ProviderAdapter.ts";

/** An agent process a driver started. */
export interface TrackedAgentProcess {
  readonly pid: number;
  /** Succeeds once the process exited (at once if it already has). */
  readonly exited: Effect.Effect<void>;
  /**
   * It leads a process group of its own (POSIX, spawned detached), so the
   * whole group is its. Default: true on POSIX.
   */
  readonly ownGroup?: boolean;
}

/** How the ledger looks at and signals processes; real by default, swapped in tests. */
export interface ProcessProbe {
  readonly platform: NodeJS.Platform;
  /** The process (or, with a negative pid, any process of the group) still exists. */
  readonly exists: (pid: number) => boolean;
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  /**
   * Every live descendant, from one snapshot of the process table, read off
   * the event loop. Null when the table couldn't be read in time.
   */
  readonly descendants: (pid: number) => Effect.Effect<ReadonlyArray<number> | null>;
  /** Windows: kills the process and its tree. */
  readonly killTree: (pid: number) => Effect.Effect<void>;
}

/** How long one look at the process table, or one tree kill, may take. */
const PROCESS_TABLE_TIMEOUT_MS = 2_000;

export const realProcessProbe: ProcessProbe = {
  platform: process.platform,
  exists: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      // Not ours to signal, but there.
      return (cause as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  signal: (pid, signal) => {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  },
  descendants: (pid) =>
    Effect.promise(() => listDescendantProcessIdsAsync(pid, PROCESS_TABLE_TIMEOUT_MS)),
  killTree: (pid) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          execFile(
            "taskkill",
            ["/pid", String(pid), "/T", "/F"],
            { timeout: PROCESS_TABLE_TIMEOUT_MS, windowsHide: true },
            () => resolve(),
          );
        }),
    ),
};

/**
 * A spawned process's exit as an effect that can't fail: its handle's own
 * exit, or, when that can't be read, its pid going away.
 */
export const processExit = <E>(
  pid: number,
  exitCode: Effect.Effect<unknown, E>,
  probe: ProcessProbe = realProcessProbe,
): Effect.Effect<void> =>
  exitCode.pipe(
    Effect.asVoid,
    Effect.catchCause(() =>
      Effect.gen(function* () {
        while (probe.exists(pid)) yield* Effect.sleep(Duration.millis(100));
      }),
    ),
  );

export interface AgentProcessLedger {
  /** A process started for `sessionKey`. Forgotten once it and all it started are gone. */
  readonly track: (sessionKey: ThreadId, agent: TrackedAgentProcess) => Effect.Effect<void>;
  /**
   * `sessionKey`'s runtime is about to stop for a move (ProviderService asks,
   * only for a thread its session fence holds): note what its processes
   * started, while they can still be told apart from anyone else's (once a
   * process dies its children belong to pid 1). Reads the process table off
   * the event loop, for at most 2 seconds.
   */
  readonly beforeStop: (sessionKey: ThreadId) => Effect.Effect<void>;
  /** Everything tracked for `threadId`'s session keys is gone, or why that can't be said. */
  readonly confirm: (threadId: ThreadId) => Effect.Effect<ProviderStopConfirmation>;
}

export interface AgentProcessLedgerOptions {
  readonly probe?: ProcessProbe;
  /** How long `confirm` waits for an agent to exit before killing it. */
  readonly exitWait?: Duration.Input;
  /** How long it waits for what it killed to be gone. */
  readonly settleWait?: Duration.Input;
  /**
   * How long after `beforeStop` a noted process may still be signalled. A
   * pid noted earlier than this could belong to someone else by now: it is
   * only reported, never signalled.
   */
  readonly trustWindow?: Duration.Input;
}

interface Entry {
  readonly sessionKey: ThreadId;
  readonly pid: number;
  readonly exited: Effect.Effect<void>;
  readonly ownGroup: boolean;
  leaderGone: boolean;
  /**
   * What it had started when its stop began, and when that was noted. Null:
   * the process table couldn't be read then, so what it left can't be known.
   */
  noted: ReadonlyArray<number> | null;
  notedAt: number;
}

const POLL = Duration.millis(50);

export const makeAgentProcessLedger = (
  options?: AgentProcessLedgerOptions,
): Effect.Effect<AgentProcessLedger, never, Scope.Scope> =>
  Effect.gen(function* () {
    const probe = options?.probe ?? realProcessProbe;
    const posix = probe.platform !== "win32";
    const exitWait = Duration.fromInputUnsafe(options?.exitWait ?? Duration.seconds(10));
    const settleWait = Duration.fromInputUnsafe(options?.settleWait ?? Duration.seconds(3));
    const trustWindowMs = Duration.toMillis(
      Duration.fromInputUnsafe(options?.trustWindow ?? Duration.minutes(2)),
    );
    const scope = yield* Effect.scope;
    const entries = new Set<Entry>();

    const groupAlive = (entry: Entry) =>
      posix && entry.ownGroup
        ? probe.exists(-entry.pid)
        : !entry.leaderGone && probe.exists(entry.pid);
    const notedAlive = (entry: Entry) => (entry.noted ?? []).filter((pid) => probe.exists(pid));
    // A stop whose process table couldn't be read left nothing known: the
    // entry stays, and confirm says so, rather than reading it as nothing.
    const settled = (entry: Entry) =>
      entry.noted !== null &&
      entry.leaderGone &&
      !groupAlive(entry) &&
      notedAlive(entry).length === 0;

    const track: AgentProcessLedger["track"] = (sessionKey, agent) =>
      Effect.gen(function* () {
        // Signalling pid 0 or below would reach this server's own group.
        if (!Number.isInteger(agent.pid) || agent.pid <= 0) return;
        const entry: Entry = {
          sessionKey,
          pid: agent.pid,
          exited: agent.exited,
          ownGroup: agent.ownGroup ?? posix,
          leaderGone: false,
          noted: [],
          notedAt: 0,
        };
        entries.add(entry);
        // A process that ends with nothing left behind needs no proof later.
        yield* agent.exited.pipe(
          Effect.andThen(
            Effect.sync(() => {
              entry.leaderGone = true;
              if (settled(entry)) entries.delete(entry);
            }),
          ),
          Effect.forkIn(scope),
        );
      });

    const beforeStop: AgentProcessLedger["beforeStop"] = (sessionKey) =>
      Effect.forEach(
        [...entries].filter((entry) => entry.sessionKey === sessionKey && !entry.leaderGone),
        (entry) =>
          probe.descendants(entry.pid).pipe(
            Effect.map((noted) => {
              entry.noted = noted;
              entry.notedAt = Date.now();
            }),
          ),
        { discard: true, concurrency: "unbounded" },
      );

    /** Waits for one tracked process and what it left; the problems that remain. */
    const settle = (entry: Entry) =>
      Effect.gen(function* () {
        const problems: string[] = [];
        if (Option.isNone(yield* entry.exited.pipe(Effect.timeoutOption(exitWait)))) {
          if (posix && entry.ownGroup) probe.signal(-entry.pid, "SIGKILL");
          else if (posix) probe.signal(entry.pid, "SIGKILL");
          else yield* probe.killTree(entry.pid);
          if (Option.isNone(yield* entry.exited.pipe(Effect.timeoutOption(settleWait)))) {
            problems.push(`its process ${entry.pid} didn't exit`);
            return problems;
          }
        }
        entry.leaderGone = true;
        const trusted = Date.now() - entry.notedAt <= trustWindowMs;
        if (groupAlive(entry)) probe.signal(-entry.pid, "SIGKILL");
        if (trusted) {
          for (const pid of notedAlive(entry)) {
            probe.signal(pid, "SIGKILL");
            // A shell that made a group of its own leads it.
            if (posix) probe.signal(-pid, "SIGKILL");
          }
        }
        const deadline = Date.now() + Duration.toMillis(settleWait);
        while (!settled(entry) && Date.now() < deadline) {
          yield* Effect.sleep(POLL);
        }
        if (groupAlive(entry)) {
          problems.push(`processes in its process group ${entry.pid} are still running`);
        }
        if (entry.noted === null) {
          problems.push("the process list couldn't be read when it stopped");
        }
        const left = notedAlive(entry);
        if (left.length > 0) {
          problems.push(
            trusted
              ? `${left.length} process${left.length === 1 ? "" : "es"} it started (${left.join(", ")}) are still running`
              : `${left.length} process${left.length === 1 ? "" : "es"} it started earlier (${left.join(", ")}) may still be running`,
          );
        }
        return problems;
      });

    const confirm: AgentProcessLedger["confirm"] = (threadId) =>
      Effect.gen(function* () {
        const mine = [...entries].filter(
          (entry) => parseSessionKey(entry.sessionKey).threadId === threadId,
        );
        const problems = yield* Effect.forEach(
          mine,
          (entry) =>
            settle(entry).pipe(
              Effect.tap((left) =>
                Effect.sync(() => {
                  if (left.length === 0) entries.delete(entry);
                }),
              ),
            ),
          { concurrency: "unbounded" },
        );
        const all = problems.flat();
        return all.length === 0
          ? ({ confirmed: true } as const)
          : ({ confirmed: false, reason: all.join("; ") } as const);
      });

    return { track, beforeStop, confirm } satisfies AgentProcessLedger;
  });
