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
 *   until its subagents reported, so its launches the records don't name
 *   show as done;
 * - a cancelled turn: Antigravity 1.5.10 stops every subagent on a cancel;
 * - the session's end (`end`): its process took the subagents with it.
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
  type AcpSubagentStatus,
  acpSubagentSettledEvents,
  acpSubagentSnapshotEvent,
  acpSubagentStartedEvents,
  describeAcpSubagentLaunches,
} from "./AcpSubagentEvents.ts";

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
}

interface Entry {
  readonly turnId: TurnId | undefined;
  readonly launch: AcpSubagentLaunch;
  status: AcpSubagentStatus;
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
  const running = () =>
    [...entries].flatMap(([id, entry]) => (entry.status === "running" ? [id] : []));

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

  const settle = (id: string, status: Exclude<AcpSubagentStatus, "running">, report?: string) =>
    Effect.gen(function* () {
      const entry = entries.get(id);
      if (entry === undefined || entry.status !== "running") return;
      entry.status = status;
      for (const event of acpSubagentSettledEvents(id, status, report)) {
        yield* input.emit(event, entry.turnId);
      }
      yield* emitSnapshot;
    });

  /**
   * Settles the running subagents the records say are done. With `ended`,
   * the launches of that turn the records don't name show as done too.
   */
  const read = (ended: TurnId | undefined) =>
    Effect.gen(function* () {
      const ids = running();
      if (ids.length === 0) return;
      const states = yield* input.subagents.states({
        sessionId: input.sessionId,
        launchCallIds: ids,
      });
      for (const id of ids) {
        const state = states?.get(id);
        if (state === undefined) {
          if (ended !== undefined && entries.get(id)?.turnId === ended)
            yield* settle(id, "completed");
          continue;
        }
        if (state.state === "working") continue;
        yield* settle(id, state.state === "killed" ? "interrupted" : "completed", state.report);
      }
    });

  // One read at a time; a request while one runs reads once more after it.
  let reading = false;
  let again: { ended: TurnId | undefined } | undefined;
  const requestRead = (ended: TurnId | undefined): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (running().length === 0) return Effect.void;
      if (reading) {
        again = { ended: ended ?? again?.ended };
        return Effect.void;
      }
      reading = true;
      const loop: Effect.Effect<void> = read(ended).pipe(
        Effect.ensuring(Effect.sync(() => (reading = false))),
        Effect.andThen(
          Effect.suspend(() => {
            const next = again;
            again = undefined;
            return next === undefined ? Effect.void : requestRead(next.ended);
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
        if (toolCall.status !== "completed" || entries.has(toolCall.toolCallId)) return;
        const launches = input.subagents.launches(toolCall);
        if (launches === undefined) return;
        const launch = describeAcpSubagentLaunches(launches);
        entries.set(toolCall.toolCallId, { turnId, launch, status: "running" });
        for (const event of acpSubagentStartedEvents(toolCall.toolCallId, launch)) {
          yield* input.emit(event, turnId);
        }
        yield* emitSnapshot;
      }),
    observe: (event) => {
      if (
        event.type === "thread.token-usage.updated" ||
        (event.type === "item.completed" && event.payload.itemType === "assistant_message")
      ) {
        return requestRead(undefined);
      }
      if (event.type !== "turn.completed") return Effect.void;
      if (event.payload.state === "cancelled") return stopAll;
      return requestRead(event.payload.state === "completed" ? event.turnId : undefined);
    },
    end: stopAll,
  };
}
