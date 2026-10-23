/**
 * A tab's notice that a port its command wanted is taken, kept on the tab
 * while something still holds the port (docs/terminal.md, "When a port is
 * taken"). The terminal manager feeds it what tabs print (`check`) and tells
 * it when a tab's shell or command changes (`recheckSoon`); this module looks
 * the port up, keeps each notice true, and stops the holder when asked.
 *
 * Every lookup takes one lock, so chatty output never runs several port
 * queries at once, and a check batches every tab waiting when it runs.
 */
import {
  TerminalPortStillInUseError,
  type TerminalPortInUse,
  type TerminalSessionStatus,
} from "@threadlines/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import type { ListeningPortRow, ProcessRow } from "../diagnostics/ProcessDiagnostics.ts";
import {
  attributePortHolder,
  commandReachesElsewhere,
  listenerPidsOf,
  sameHolding,
  shellReachesElsewhere,
  type PortHolding,
  type PortInUseMention,
  type TerminalShell,
} from "./portInUse.ts";

/** How often a notice looks again: soon at first, then less often while nothing changes. */
const RECHECK_MIN_MS = 2_000;
const RECHECK_MAX_MS = 30_000;
/** Who holds a port is worked out again this often even when its listeners stay the same. */
const REATTRIBUTE_MS = 30_000;
/** A port or process query that takes longer tells nothing. */
const LOOKUP_TIMEOUT_MS = 5_000;
/** After Stop, how long and how often to wait for the port to come free. */
const STOP_WAIT_POLLS = 12;
const STOP_WAIT_POLL_MS = 250;

/** A tab's notice, with what was seen when its holders were last worked out. */
export interface PortNotice {
  readonly id: string;
  readonly port: number;
  readonly seenAt: string;
  readonly holding: PortHolding;
  readonly attributedAtMs: number;
}

/** What this module reads and writes on a terminal tab. */
export interface PortNoticeSession {
  readonly threadId: string;
  readonly terminalId: string;
  readonly pid: number | null;
  readonly status: TerminalSessionStatus;
  readonly commandGeneration: number;
  readonly commandRun: { readonly mode: "run" | "insert" } | null;
  /** Bumped whenever the tab's notice stops applying, so a lookup under way can't bring it back. */
  portRevision: number;
  portInUse: PortNotice | null;
}

/** Ports a tab's output named, with the tab as it was when it printed them. */
export interface PortCheck<S extends PortNoticeSession> {
  readonly session: S;
  readonly pid: number;
  readonly generation: number;
  readonly revision: number;
  readonly mentions: ReadonlyArray<PortInUseMention>;
  readonly seenAt: string;
  /** The line typed at the prompt that runs there, when known ("ssh web-1 npm start"). */
  readonly typedCommand: string | null;
}

export interface PortNoticesOptions<S extends PortNoticeSession> {
  /** Every tab the manager holds now. */
  readonly sessions: Effect.Effect<ReadonlyArray<S>>;
  readonly publishTabs: (threadId: string) => Effect.Effect<void>;
  readonly listeningPortReader: (
    ports: ReadonlyArray<number>,
  ) => Effect.Effect<ReadonlyArray<ListeningPortRow>, Error>;
  /** The process table as it is now (not a cached copy: a listener may be seconds old). */
  readonly processRowsReader: Effect.Effect<ReadonlyArray<ProcessRow>, Error>;
  /** A program's name where the process table may lack it (Windows), else null. */
  readonly processNameReader: (pid: number) => Effect.Effect<string | null>;
  /** Sends SIGINT to a process group, as Ctrl+C does to the job in front. */
  readonly interruptGroup: (pgid: number) => void;
  readonly serverPid: number;
  readonly scope: Scope.Scope;
}

const isSameTab = (session: PortNoticeSession, holder: TerminalShell) =>
  holder.threadId === session.threadId && holder.terminalId === session.terminalId;

const samePids = (left: ReadonlyArray<number>, right: ReadonlyArray<number>) =>
  left.length === right.length && left.every((pid, index) => pid === right[index]);

/** Drops a tab's notice for good: nothing under way may set it again. Whether it had one. */
export function dropPortNotice(session: PortNoticeSession): boolean {
  session.portRevision += 1;
  const had = session.portInUse !== null;
  session.portInUse = null;
  return had;
}

/** `TerminalTab.portInUse` for a tab. */
export function portInUseView(session: PortNoticeSession): TerminalPortInUse | null {
  const notice = session.portInUse;
  if (notice === null) return null;
  const [first] = notice.holding.holders;
  return {
    id: notice.id,
    port: notice.port,
    holders: notice.holding.holders,
    canStop:
      notice.holding.stoppable !== null && first?.kind === "terminal" && !isSameTab(session, first),
    seenAt: notice.seenAt,
  };
}

export const makePortNotices = <S extends PortNoticeSession>(options: PortNoticesOptions<S>) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const pending: Array<PortCheck<S>> = [];
    const stopping = new Set<string>();
    let watching = false;
    // A look asked for and not yet begun: more asks meanwhile join it.
    let recheckQueued = false;

    const timed = <A>(effect: Effect.Effect<A, Error>) =>
      effect.pipe(
        Effect.timeoutOption(Duration.millis(LOOKUP_TIMEOUT_MS)),
        Effect.catch(() => Effect.succeed(Option.none<A>())),
      );

    /** The listeners on `ports` and the process table, or null when either can't be read. */
    const lookUp = (ports: ReadonlyArray<number>) =>
      Effect.gen(function* () {
        const rows = yield* timed(options.listeningPortReader(ports));
        if (Option.isNone(rows)) return null;
        const listened = ports.some((port) => listenerPidsOf(rows.value, port).length > 0);
        if (!listened) return { rows: rows.value, processRows: [] as ReadonlyArray<ProcessRow> };
        const processRows = yield* timed(options.processRowsReader);
        if (Option.isNone(processRows)) return null;
        return { rows: rows.value, processRows: processRows.value };
      });

    const attribute = (
      port: number,
      found: {
        readonly rows: ReadonlyArray<ListeningPortRow>;
        readonly processRows: ReadonlyArray<ProcessRow>;
      },
      sessions: ReadonlyArray<S>,
    ) =>
      Effect.gen(function* () {
        const terminalShells = new Map<number, TerminalShell>();
        const wrapperShells = new Set<number>();
        for (const session of sessions) {
          if (session.status !== "running" || session.pid === null) continue;
          terminalShells.set(session.pid, {
            threadId: session.threadId,
            terminalId: session.terminalId,
          });
          if (session.commandRun?.mode === "run") wrapperShells.add(session.pid);
        }
        const holding = attributePortHolder({
          port,
          listeningRows: found.rows,
          processRows: found.processRows,
          terminalShells,
          wrapperShells,
          serverPid: options.serverPid,
        });
        if (holding === null) return null;
        const holders = yield* Effect.forEach(holding.holders, (holder) =>
          holder.kind === "process" && holder.name === null
            ? options
                .processNameReader(holder.pid)
                .pipe(Effect.map((name) => ({ ...holder, name: name ?? holder.name })))
            : Effect.succeed(holder),
        );
        return { ...holding, holders } satisfies PortHolding;
      });

    const newId = () => crypto.randomUUID();

    /**
     * Looks again at every notice: gone when nothing listens on its port any
     * more, worked out again when its listeners changed, a holder tab
     * restarted or closed, or a while has passed. A query that fails changes
     * nothing. Whether any notice is left, and whether one changed.
     */
    const recheckUnlocked: Effect.Effect<"none" | "same" | "changed"> = Effect.gen(function* () {
      const sessions = yield* options.sessions;
      const noticed = sessions.filter((session) => session.portInUse !== null);
      if (noticed.length === 0) return "none" as const;
      const ports = [...new Set(noticed.map((session) => session.portInUse!.port))];
      const rows = yield* timed(options.listeningPortReader(ports));
      if (Option.isNone(rows)) return "same" as const;
      const nowMs = yield* Clock.currentTimeMillis;
      let processRows: ReadonlyArray<ProcessRow> | null = null;
      const changed = new Set<string>();
      for (const session of noticed) {
        const notice = session.portInUse;
        if (notice === null) continue;
        const listenerPids = listenerPidsOf(rows.value, notice.port);
        let next: PortNotice | null = notice;
        if (listenerPids.length === 0) {
          next = null;
        } else {
          const holderTabGone = notice.holding.holderShellPids.some(
            (shellPid) =>
              !sessions.some((other) => other.pid === shellPid && other.status === "running"),
          );
          if (
            holderTabGone ||
            !samePids(listenerPids, notice.holding.listenerPids) ||
            nowMs - notice.attributedAtMs >= REATTRIBUTE_MS
          ) {
            if (processRows === null) {
              const read = yield* timed(options.processRowsReader);
              // Unreadable: this one stays as it was; the others still go out.
              if (Option.isNone(read)) continue;
              processRows = read.value;
            }
            const holding = yield* attribute(
              notice.port,
              { rows: rows.value, processRows },
              sessions,
            );
            next =
              holding === null
                ? null
                : {
                    ...notice,
                    id: sameHolding(holding, notice.holding) ? notice.id : newId(),
                    holding,
                    attributedAtMs: nowMs,
                  };
          }
        }
        // Dropped or replaced while this looked: what happened since wins.
        if (session.portInUse !== notice) continue;
        session.portInUse = next;
        if (next?.id !== notice.id) changed.add(session.threadId);
      }
      for (const threadId of changed) yield* options.publishTabs(threadId);
      return changed.size > 0 ? ("changed" as const) : ("same" as const);
    });
    const recheck = lock.withPermits(1)(recheckUnlocked);

    // Runs while any notice is up, and starts again if one came up as it ended.
    const watch: Effect.Effect<void> = Effect.gen(function* () {
      let delayMs = RECHECK_MIN_MS;
      while (true) {
        yield* Effect.sleep(Duration.millis(delayMs));
        const result = yield* recheck;
        if (result === "none") return;
        delayMs = result === "changed" ? RECHECK_MIN_MS : Math.min(delayMs * 2, RECHECK_MAX_MS);
      }
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          watching = false;
          const sessions = yield* options.sessions;
          if (sessions.some((session) => session.portInUse !== null)) yield* ensureWatch;
        }),
      ),
    );

    const ensureWatch: Effect.Effect<void> = Effect.suspend(() => {
      if (watching) return Effect.void;
      watching = true;
      return watch.pipe(
        Effect.ignoreCause({ log: true }),
        Effect.forkIn(options.scope),
        Effect.asVoid,
      );
    });

    const runChecks = lock.withPermits(1)(
      Effect.gen(function* () {
        const checks = pending.splice(0);
        if (checks.length === 0) return;
        const ports = [
          ...new Set(checks.flatMap((check) => check.mentions.map((mention) => mention.port))),
        ];
        const found = yield* lookUp(ports);
        if (found === null) return;
        const sessions = yield* options.sessions;
        const live = new Set<PortNoticeSession>(sessions);
        const nowMs = yield* Clock.currentTimeMillis;
        const changed = new Set<string>();
        for (const check of checks) {
          const session = check.session;
          // Still the tab, shell and command that printed it, with nothing
          // since that made the notice moot (a line, Clear, a restart).
          const current = () =>
            live.has(session) &&
            session.pid === check.pid &&
            session.status === "running" &&
            session.commandGeneration === check.generation &&
            session.portRevision === check.revision;
          if (!current()) continue;
          // Over ssh the port is another computer's; inside a container it is
          // the container's, unless Docker itself says it couldn't publish it.
          // A command that already ended is known by the line typed for it.
          const elsewhere =
            shellReachesElsewhere(found.processRows, check.pid) ??
            (check.typedCommand === null ? null : commandReachesElsewhere(check.typedCommand));
          if (elsewhere === "remote") continue;
          const mentions =
            elsewhere === "container"
              ? check.mentions.filter((mention) => mention.hostBinding)
              : check.mentions;
          // The latest message wins.
          for (const mention of mentions.toReversed()) {
            const holding = yield* attribute(mention.port, found, sessions);
            if (holding === null) continue;
            // Naming a program may have waited (Windows): look again.
            if (!current()) break;
            session.portInUse = {
              id: newId(),
              port: mention.port,
              seenAt: check.seenAt,
              holding,
              attributedAtMs: nowMs,
            };
            changed.add(session.threadId);
            break;
          }
        }
        for (const threadId of changed) yield* options.publishTabs(threadId);
        if (changed.size > 0) yield* ensureWatch;
      }),
    );

    /** Ports a tab's output named: looked up soon, with any others waiting. */
    const check = (input: PortCheck<S>): Effect.Effect<void> =>
      Effect.suspend(() => {
        pending.push(input);
        return runChecks.pipe(
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(options.scope),
          Effect.asVoid,
        );
      });

    /** A tab's shell or command changed: a notice naming it may no longer be true. */
    const recheckSoon: Effect.Effect<void> = Effect.gen(function* () {
      if (recheckQueued) return;
      const sessions = yield* options.sessions;
      if (!sessions.some((session) => session.portInUse !== null)) return;
      recheckQueued = true;
      yield* lock
        .withPermits(1)(
          Effect.sync(() => {
            recheckQueued = false;
          }).pipe(Effect.andThen(recheckUnlocked)),
        )
        .pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(options.scope));
    });

    /**
     * Dismisses a tab's notice, or stops the one job of another tab holding its
     * port. Stop interrupts that job's process group only after looking again
     * that the same job of the same shell still holds the port, then waits a
     * few seconds for the port to come free.
     */
    const resolve = (
      session: S,
      input: { readonly noticeId: string; readonly stop: boolean },
    ): Effect.Effect<void, TerminalPortStillInUseError> =>
      Effect.gen(function* () {
        const notice = session.portInUse;
        if (notice === null || notice.id !== input.noticeId) return;
        if (!input.stop) {
          dropPortNotice(session);
          yield* options.publishTabs(session.threadId);
          return;
        }
        const revision = session.portRevision;
        const pid = session.pid;
        const target = notice.holding.stoppable;
        const [holder] = notice.holding.holders;
        if (
          target === null ||
          holder?.kind !== "terminal" ||
          isSameTab(session, holder) ||
          stopping.has(notice.id)
        ) {
          return;
        }
        stopping.add(notice.id);
        yield* Effect.gen(function* () {
          const outcome = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              const found = yield* lookUp([notice.port]);
              if (found === null) return "unverified" as const;
              const sessions = yield* options.sessions;
              const holding = yield* attribute(notice.port, found, sessions);
              const [current] = holding?.holders ?? [];
              if (
                // What was clicked is still what the tab shows: no Clear,
                // dismissal, restart or newer notice came in meanwhile.
                session.portInUse !== notice ||
                session.portRevision !== revision ||
                !sessions.includes(session) ||
                session.status !== "running" ||
                session.pid !== pid ||
                holding?.stoppable?.pgid !== target.pgid ||
                holding.stoppable.shellPid !== target.shellPid ||
                current?.kind !== "terminal" ||
                current.threadId !== holder.threadId ||
                current.terminalId !== holder.terminalId
              ) {
                return "changed" as const;
              }
              options.interruptGroup(target.pgid);
              return "signaled" as const;
            }),
          );
          if (outcome !== "signaled") {
            yield* recheck;
            if (outcome === "unverified") {
              return yield* new TerminalPortStillInUseError({
                threadId: session.threadId,
                terminalId: session.terminalId,
                port: notice.port,
                reason: "unverified",
              });
            }
            return;
          }
          for (let poll = 0; poll < STOP_WAIT_POLLS; poll += 1) {
            yield* Effect.sleep(Duration.millis(STOP_WAIT_POLL_MS));
            const rows = yield* timed(options.listeningPortReader([notice.port]));
            if (
              Option.isSome(rows) &&
              !listenerPidsOf(rows.value, notice.port).some((pid) =>
                notice.holding.listenerPids.includes(pid),
              )
            ) {
              yield* recheck;
              return;
            }
          }
          yield* recheck;
          return yield* new TerminalPortStillInUseError({
            threadId: session.threadId,
            terminalId: session.terminalId,
            port: notice.port,
            reason: "stillListening",
          });
        }).pipe(Effect.ensuring(Effect.sync(() => stopping.delete(notice.id))));
      });

    return { check, recheckSoon, resolve };
  }).pipe(Effect.withSpan("makePortNotices"));
