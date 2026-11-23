import {
  EventId,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import type { AcpExtensionRuntimeEvent, AcpSubagentState } from "./AcpProviderDescriptor.ts";
import { makeAcpSubagentRoster } from "./AcpSubagentRoster.ts";

const TURN = TurnId.make("turn-1");

type Reading =
  | { readonly byLaunch: ReadonlyMap<string, AcpSubagentState>; readonly complete: boolean }
  | undefined;

/** A roster whose records say whatever `records.next` holds, with every event it emits. */
function makeRoster() {
  const records: { next: Reading } = { next: undefined };
  const emitted: Array<AcpExtensionRuntimeEvent> = [];
  const roster = makeAcpSubagentRoster({
    subagents: {
      launches: (toolCall) => [{ role: "Researcher", prompt: `Work on ${toolCall.toolCallId}` }],
      states: () => Effect.succeed(records.next),
      transcript: () => Effect.succeed(undefined),
      unrecordedMessage: "not recorded",
    },
    sessionId: "session-1",
    emit: (event) => Effect.sync(() => void emitted.push(event)),
    // Reads run inline, so each step's effects are visible at once.
    fork: (effect) => effect,
  });
  const statuses = () =>
    emitted.flatMap((event) =>
      event.type === "subagent.metadata.updated" && event.payload.status !== undefined
        ? [`${event.payload.callId}:${event.payload.status}`]
        : [],
    );
  return { roster, records, emitted, statuses };
}

const launch = (id: string) => ({ toolCallId: id, status: "completed" as const, data: {} });

const turnCompleted = (state: "completed" | "cancelled"): ProviderRuntimeEvent => ({
  type: "turn.completed",
  eventId: EventId.make(`evt-${state}`),
  provider: ProviderDriverKind.make("antigravity"),
  threadId: ThreadId.make("thread-1"),
  createdAt: "2026-11-23T12:00:00.000Z",
  turnId: TURN,
  payload: { state },
});

const usageUpdated: ProviderRuntimeEvent = {
  type: "thread.token-usage.updated",
  eventId: EventId.make("evt-usage"),
  provider: ProviderDriverKind.make("antigravity"),
  threadId: ThreadId.make("thread-1"),
  createdAt: "2026-11-23T12:00:00.000Z",
  payload: { usage: { usedTokens: 10 } },
};

describe("AcpSubagentRoster", () => {
  it.effect("never marks a subagent done for want of a reading", () =>
    Effect.gen(function* () {
      const { roster, records, statuses } = makeRoster();
      yield* roster.noteToolCall(launch("call_a"), TURN);
      // The records can't be read when the turn ends: nothing is settled.
      records.next = undefined;
      yield* roster.observe(turnCompleted("completed"));
      expect(statuses()).toEqual(["call_a:running"]);
      // Nor when some record didn't read and this child isn't named.
      records.next = { byLaunch: new Map(), complete: false };
      yield* roster.observe(turnCompleted("completed"));
      expect(statuses()).toEqual(["call_a:running"]);
      // A later reading that names its report settles it, with the report.
      records.next = {
        byLaunch: new Map([["call_a", { state: "reported", report: "Found it." }]]),
        complete: true,
      };
      yield* roster.observe(usageUpdated);
      expect(statuses()).toEqual(["call_a:running", "call_a:completed"]);
      expect(roster.size()).toBe(0);
    }),
  );

  it.effect("lets a later reading correct a subagent guessed done at its turn's end", () =>
    Effect.gen(function* () {
      const { roster, records, statuses, emitted } = makeRoster();
      yield* roster.noteToolCall(launch("call_a"), TURN);
      // A complete reading that doesn't name it: its turn was held until it reported.
      records.next = { byLaunch: new Map(), complete: true };
      yield* roster.observe(turnCompleted("completed"));
      expect(statuses()).toEqual(["call_a:running", "call_a:completed"]);
      // The records then name it at work: it shows running again.
      records.next = { byLaunch: new Map([["call_a", { state: "working" }]]), complete: true };
      yield* roster.observe(usageUpdated);
      expect(statuses().at(-1)).toBe("call_a:running");
      // And its report settles it for good.
      records.next = {
        byLaunch: new Map([["call_a", { state: "reported", report: "Done." }]]),
        complete: true,
      };
      yield* roster.observe(usageUpdated);
      expect(statuses().at(-1)).toBe("call_a:completed");
      expect(
        emitted.findLast((event) => event.type === "subagent.metadata.updated")?.payload,
      ).toMatchObject({ resultBody: "Done." });
      expect(roster.size()).toBe(0);
    }),
  );

  it.effect("keeps only subagents still running or guessed, and shows a launch once", () =>
    Effect.gen(function* () {
      const { roster, records, statuses } = makeRoster();
      for (let index = 0; index < 50; index += 1) {
        yield* roster.noteToolCall(launch(`call_${index}`), TURN);
      }
      // A repeated update of a launch adds nothing.
      yield* roster.noteToolCall(launch("call_0"), TURN);
      expect(statuses().filter((status) => status === "call_0:running")).toHaveLength(1);
      expect(roster.size()).toBe(50);
      // Records settle ten; a complete reading guesses the rest done.
      records.next = {
        byLaunch: new Map(
          Array.from({ length: 10 }, (_, index) => [
            `call_${index}`,
            { state: index % 2 === 0 ? "reported" : "killed" } as const,
          ]),
        ),
        complete: true,
      };
      yield* roster.observe(turnCompleted("completed"));
      // Settled ones are gone, and guesses are capped.
      expect(roster.size()).toBe(32);
      yield* roster.end;
      expect(roster.size()).toBe(0);
    }),
  );

  it.effect("stops every running subagent with a cancelled turn", () =>
    Effect.gen(function* () {
      const { roster, statuses } = makeRoster();
      yield* roster.noteToolCall(launch("call_a"), TURN);
      yield* roster.observe(turnCompleted("cancelled"));
      expect(statuses()).toEqual(["call_a:running", "call_a:interrupted"]);
      expect(roster.size()).toBe(0);
    }),
  );

  it.effect(
    "guesses an unrecorded launch done on a later reading if the one at its turn's end failed",
    () =>
      Effect.gen(function* () {
        const { roster, records, statuses } = makeRoster();
        yield* roster.noteToolCall(launch("call_a"), TURN);
        records.next = undefined;
        yield* roster.observe(turnCompleted("completed"));
        expect(statuses()).toEqual(["call_a:running"]);
        // The next complete reading still knows its turn ended.
        records.next = { byLaunch: new Map(), complete: true };
        yield* roster.observe(usageUpdated);
        expect(statuses()).toEqual(["call_a:running", "call_a:completed"]);
      }),
  );

  it.effect("never shows a launch it still keeps twice, however many came after it", () =>
    Effect.gen(function* () {
      const { roster, records, statuses } = makeRoster();
      yield* roster.noteToolCall(launch("call_0"), TURN);
      for (let index = 1; index <= 600; index += 1) {
        yield* roster.noteToolCall(launch(`call_${index}`), TurnId.make("turn-2"));
      }
      // The first launch's completion comes again, from another turn.
      yield* roster.noteToolCall(launch("call_0"), TurnId.make("turn-3"));
      expect(statuses().filter((status) => status === "call_0:running")).toHaveLength(1);
      // It still belongs to its own turn: that turn's end settles it.
      records.next = { byLaunch: new Map(), complete: true };
      yield* roster.observe(turnCompleted("completed"));
      expect(statuses()).toContain("call_0:completed");
      expect(statuses()).not.toContain("call_1:completed");
    }),
  );
});
