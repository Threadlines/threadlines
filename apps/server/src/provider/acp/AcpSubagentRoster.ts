/**
 * The subagents a session's tool calls launched (`AcpProviderDescriptor.
 * subagents`), as the thread shows them: running until the agent's records
 * say a child reported or was killed, or the session's turn or process ends.
 *
 * It keeps no part of a turn's hold. It learns what happened from the tool
 * calls and from the runtime events the adapter emits anyway:
 * - each reply message's end (`item.completed` for an assistant message)
 *   and each context update: read the records (a child's report wakes the
 *   agent, whose reply follows it);
 * - `turn.completed`: read the records; a turn that completed was held
 *   until its subagents reported, so its launches a complete reading doesn't
 *   name show as done (on that reading or any later complete one), as a
 *   guess a later reading can still correct;
 * - a cancelled turn: Antigravity 1.5.10 stops every subagent on a cancel;
 * - the session's end (`end`): its process took the subagents with it.
 *
 * A reading that isn't available changes nothing: "couldn't read" is never
 * "finished". Only running subagents and guessed ones are kept (a few dozen
 * at most); one the records settled has said all it will.
 *
 * @module provider/acp/AcpSubagentRoster
 */
import type { ProviderRuntimeEvent, TurnId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";

import type {
  AcpExtensionRuntimeEvent,
  AcpSubagentLaunch,
  AcpSubagents,
} from "./AcpProviderDescriptor.ts";
import type { AcpToolCallState } from "./AcpRuntimeModel.ts";
import {
  acpSubagentSettledEvents,
  acpSubagentSnapshotEvent,
  acpSubagentStartedEvents,
  describeAcpSubagentLaunches,
} from "./AcpSubagentEvents.ts";

/** Launch ids remembered so a repeated update never shows a launch twice. */
const SEEN_LAUNCH_LIMIT = 512;
/** Subagents shown as done on a guess, kept so a later reading can correct them. */
const GUESSED_LIMIT = 32;
/** Turns remembered as completed, for guessing their unrecorded launches done later. */
const ENDED_TURN_LIMIT = 64;

export interface AcpSubagentRoster {
  /** A tool call update: a launch that went through shows as a running subagent, once. */
  readonly noteToolCall: (
    toolCall: AcpToolCallState,
    turnId: TurnId | undefined,
  ) => Effect.Effect<void>;
  /** An event the adapter emitted for this session (see the module comment). */
  readonly observe: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  /** The session ended: every running subagent stopped with it. */
  readonly end: Effect.Effect<void>;
  /** How many subagents it still keeps (running or guessed done). */
  readonly size: () => number;
}

interface Entry {
  readonly turnId: TurnId | undefined;
  readonly launch: AcpSubagentLaunch;
  /** `guessed`: shown done because its turn ended; no record said so yet. */
  status: "running" | "guessed";
}

export function makeAcpSubagentRoster(input: {
  readonly subagents: AcpSubagents;
  readonly sessionId: string;
  /** Emits one of the roster's events, on the given turn. */
  readonly emit: (
    event: AcpExtensionRuntimeEvent,
    turnId: TurnId | undefined,
  ) => Effect.Effect<void>;
  /** Runs a records read in the session's scope, so the event that asked moves on. */
  readonly fork: (effect: Effect.Effect<void>) => Effect.Effect<void>;
}): AcpSubagentRoster {
  const entries = new Map<string, Entry>();
  const seen = new Set<string>();
  /**
   * Turns that completed. A launch of one that no complete reading names is
   * guessed done on whichever complete reading comes first, so a reading
   * that failed right at the turn's end doesn't leave it running for good.
   */
  const endedTurns = new Set<TurnId>();
  const running = () =>
    [...entries].flatMap(([id, entry]) => (entry.status === "running" ? [id] : []));

  const emitAll = (events: ReadonlyArray<AcpExtensionRuntimeEvent>, turnId: TurnId | undefined) =>
    Effect.forEach(events, (event) => input.emit(event, turnId), { discard: true });

  const emitSnapshot = Effect.suspend(() =>
    input.emit(
      acpSubagentSnapshotEvent(
        [...entries].flatMap(([launchCallId, entry]) =>
          entry.status === "running" ? [{ launchCallId, launch: entry.launch }] : [],
        ),
      ),
      undefined,
    ),
  );

  /** Ends a subagent for good: the records said so, or its session stopped it. */
  const settle = (id: string, status: "completed" | "interrupted", report?: string) =>
    Effect.gen(function* () {
      const entry = entries.get(id);
      if (entry === undefined) return;
      entries.delete(id);
      // A guess already showed it done; only a report adds anything.
      if (entry.status === "guessed" && status === "completed" && report === undefined) return;
      yield* emitAll(acpSubagentSettledEvents(id, status, report), entry.turnId);
      yield* emitSnapshot;
    });

  /** Shows a running subagent as done on its turn's end, keeping it to correct later. */
  const guessDone = (id: string) =>
    Effect.gen(function* () {
      const entry = entries.get(id);
      if (entry === undefined || entry.status !== "running") return;
      entry.status = "guessed";
      yield* emitAll(acpSubagentSettledEvents(id, "completed", undefined), entry.turnId);
      yield* emitSnapshot;
      const guessed = [...entries].filter(([, candidate]) => candidate.status === "guessed");
      for (const [oldest] of guessed.slice(0, Math.max(0, guessed.length - GUESSED_LIMIT))) {
        entries.delete(oldest);
      }
    });

  /** A guess the records contradict: the subagent is still at work. */
  const reopen = (id: string) =>
    Effect.gen(function* () {
      const entry = entries.get(id);
      if (entry === undefined || entry.status !== "guessed") return;
      entry.status = "running";
      yield* emitAll(acpSubagentStartedEvents(id, entry.launch), entry.turnId);
      yield* emitSnapshot;
    });

  /**
   * Brings the kept subagents in line with the records. Launches of a turn
   * that completed that a complete reading doesn't name are guessed done.
   */
  const read = () =>
    Effect.gen(function* () {
      const ids = [...entries.keys()];
      if (ids.length === 0) return;
      const reading = yield* input.subagents.states({
        sessionId: input.sessionId,
        launchCallIds: ids,
      });
      if (reading === undefined) return;
      for (const id of ids) {
        const state = reading.byLaunch.get(id);
        if (state === undefined) {
          const turnId = entries.get(id)?.turnId;
          if (reading.complete && turnId !== undefined && endedTurns.has(turnId)) {
            yield* guessDone(id);
          }
          continue;
        }
        if (state.state === "working") yield* reopen(id);
        else
          yield* settle(id, state.state === "killed" ? "interrupted" : "completed", state.report);
      }
    });

  // One read at a time; a request while one runs reads once more after it.
  let reading = false;
  let again = false;
  const requestRead = (): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (entries.size === 0) return Effect.void;
      if (reading) {
        again = true;
        return Effect.void;
      }
      reading = true;
      const loop: Effect.Effect<void> = read().pipe(
        Effect.ensuring(Effect.sync(() => (reading = false))),
        Effect.andThen(
          Effect.suspend(() => {
            if (!again) return Effect.void;
            again = false;
            return requestRead();
          }),
        ),
      );
      return input.fork(loop);
    });

  const stopAll = Effect.suspend(() =>
    Effect.forEach(running(), (id) => settle(id, "interrupted"), { discard: true }),
  );

  return {
    noteToolCall: (toolCall, turnId) =>
      Effect.gen(function* () {
        const id = toolCall.toolCallId;
        // A launch still kept is never shown again, however long ago it began.
        if (toolCall.status !== "completed" || seen.has(id) || entries.has(id)) return;
        const launches = input.subagents.launches(toolCall);
        if (launches === undefined) return;
        seen.add(id);
        if (seen.size > SEEN_LAUNCH_LIMIT) {
          const [oldest] = seen;
          if (oldest !== undefined) seen.delete(oldest);
        }
        const launch = describeAcpSubagentLaunches(launches);
        entries.set(id, { turnId, launch, status: "running" });
        yield* emitAll(acpSubagentStartedEvents(id, launch), turnId);
        yield* emitSnapshot;
      }),
    observe: (event) => {
      if (
        event.type === "thread.token-usage.updated" ||
        (event.type === "item.completed" && event.payload.itemType === "assistant_message")
      ) {
        return requestRead();
      }
      if (event.type !== "turn.completed") return Effect.void;
      if (event.payload.state === "cancelled") return stopAll;
      if (event.payload.state === "completed" && event.turnId !== undefined) {
        endedTurns.add(event.turnId);
        if (endedTurns.size > ENDED_TURN_LIMIT) {
          const [oldest] = endedTurns;
          if (oldest !== undefined) endedTurns.delete(oldest);
        }
      }
      return requestRead();
    },
    end: Effect.suspend(() => stopAll.pipe(Effect.andThen(Effect.sync(() => entries.clear())))),
    size: () => entries.size,
  };
}
