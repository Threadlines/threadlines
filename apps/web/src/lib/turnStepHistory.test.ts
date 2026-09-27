import { TurnId } from "@threadlines/contracts";
import { MAX_THREAD_ACTIVITIES } from "@threadlines/shared/threadLimits";
import { describe, expect, it } from "vite-plus/test";

import type { WorkLogEntry } from "~/session-logic";
import { mergeTurnStepHistory, turnsWithCutSteps } from "./turnStepHistory";

const turn = (value: string) => TurnId.make(value);
const at = (second: number) => `2026-09-27T10:00:${String(second).padStart(2, "0")}.000Z`;

function activities(count: number, turnId: string, second: number) {
  return Array.from({ length: count }, () => ({ turnId: turn(turnId), createdAt: at(second) }));
}

function reply(turnId: string, second: number) {
  return { role: "assistant", turnId: turn(turnId), createdAt: at(second) };
}

function step(id: string, turnId: string | null): WorkLogEntry {
  return {
    id,
    createdAt: at(1),
    label: id,
    tone: "tool",
    turnId: turnId === null ? null : turn(turnId),
  };
}

describe("turnsWithCutSteps", () => {
  it("cuts nothing while the live feed has room", () => {
    expect(
      turnsWithCutSteps({
        activities: activities(MAX_THREAD_ACTIVITIES - 1, "turn-2", 20),
        messages: [reply("turn-1", 10), reply("turn-2", 30)],
        activeTurnId: null,
      }),
    ).toEqual(new Set());
  });

  it("names the turn the feed starts in and every turn that replied before it", () => {
    const cut = turnsWithCutSteps({
      // Two pinned rows from an older turn, then a full window starting in turn-2.
      activities: [
        ...activities(2, "turn-1", 5),
        ...activities(10, "turn-2", 20),
        ...activities(MAX_THREAD_ACTIVITIES - 10, "turn-3", 40),
      ],
      messages: [
        { role: "user", createdAt: at(1) },
        reply("turn-1", 10),
        { role: "user", createdAt: at(15) },
        reply("turn-2", 30),
        { role: "user", createdAt: at(35) },
        reply("turn-3", 50),
        { role: "user", createdAt: at(55) },
        reply("turn-4", 58),
      ],
      activeTurnId: turn("turn-4"),
    });
    expect([...cut].toSorted()).toEqual([turn("turn-1"), turn("turn-2")]);
  });

  it("leaves the running turn to the live feed", () => {
    const cut = turnsWithCutSteps({
      activities: activities(MAX_THREAD_ACTIVITIES, "turn-2", 20),
      messages: [reply("turn-1", 10), reply("turn-2", 15)],
      activeTurnId: turn("turn-2"),
    });
    expect([...cut]).toEqual([turn("turn-1")]);
  });
});

describe("mergeTurnStepHistory", () => {
  it("tells a fetched turn whole and keeps every other live step", () => {
    const live = [step("cut-tail", "turn-1"), step("side", null), step("newer", "turn-2")];
    const history = new Map([
      [turn("turn-1"), [step("first", "turn-1"), step("cut-tail", "turn-1")]],
    ]);

    expect(mergeTurnStepHistory(live, history).map((entry) => entry.id)).toEqual([
      "first",
      "cut-tail",
      "side",
      "newer",
    ]);
  });
});
