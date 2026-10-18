import { describe, expect, it } from "vite-plus/test";

import {
  capturePiTurn,
  makePiResumeCursor,
  parsePiResumeCursor,
  planPiFork,
  planPiRevert,
  type PiTurnPosition,
  unknownTurn,
} from "./PiCursor.ts";
import type { PiSessionEntry } from "./PiProtocol.ts";

const user = (id: string, parentId: string | null): PiSessionEntry => ({
  id,
  parentId,
  type: "message",
  message: { role: "user" },
});
const assistant = (id: string, parentId: string | null): PiSessionEntry => ({
  id,
  parentId,
  type: "message",
  message: { role: "assistant" },
});

const known = (turnId: string, first: string | null, leaf: string, start: string | null) =>
  ({
    turnId,
    known: true,
    startLeaf: start,
    firstUserEntryId: first,
    leafId: leaf,
  }) as PiTurnPosition;

describe("capturePiTurn", () => {
  it("takes the first user message on the path, ignoring other branches and list order", () => {
    // s0 <- u1 <- a1 <- u2(steer) <- a2 ; an abandoned branch hangs off u1.
    const entries = [
      assistant("a2", "u2"),
      user("x1", "u1"),
      user("u2", "a1"),
      assistant("a1", "u1"),
      user("u1", "s0"),
    ];
    expect(capturePiTurn({ turnId: "t1", startLeaf: "s0", entries, leafId: "a2" })).toEqual(
      known("t1", "u1", "a2", "s0"),
    );
    // A path that never reaches the start leaf is not guessed.
    expect(capturePiTurn({ turnId: "t1", startLeaf: "zz", entries, leafId: "a2" })).toBeUndefined();
  });

  it("records a turn with no user message (Pi woke itself)", () => {
    expect(
      capturePiTurn({
        turnId: "t2",
        startLeaf: "a1",
        entries: [assistant("a3", "a1")],
        leafId: "a3",
      }),
    ).toEqual(known("t2", null, "a3", "a1"));
  });
});

describe("planPiRevert and planPiFork", () => {
  const turns = [known("t1", "u1", "a1", "s0"), unknownTurn("t2"), known("t3", "u3", "a3", "a2")];

  it("reverts by forking before the first removed turn, and never guesses an unknown one", () => {
    expect(planPiRevert(turns, 0)).toEqual({ kind: "fork", entryId: "u1" });
    expect(planPiRevert(turns, 1)).toEqual({ kind: "unknown" });
    expect(planPiRevert(turns, 2)).toEqual({ kind: "fork", entryId: "u3" });
    expect(planPiRevert(turns, 3)).toEqual({ kind: "nothing" });
  });

  it("forks including a turn by cutting before the next one, and clones only an unchanged leaf", () => {
    expect(planPiFork({ turns, keep: 2, currentLeaf: "a3" })).toEqual({
      kind: "fork",
      entryId: "u3",
    });
    expect(planPiFork({ turns, keep: 1, currentLeaf: "a3" })).toEqual({ kind: "contextSeed" });
    expect(planPiFork({ turns, keep: 3, currentLeaf: "a3" })).toEqual({ kind: "clone" });
    expect(planPiFork({ turns, keep: 3, currentLeaf: "grew-outside" })).toEqual({
      kind: "contextSeed",
    });
  });
});

describe("parsePiResumeCursor", () => {
  it("round-trips, and treats half-written positions as unknown", () => {
    const cursor = makePiResumeCursor({
      sessionFile: "/s.jsonl",
      cwd: "/p",
      turns: [known("t1", "u1", "a1", null)],
    });
    expect(parsePiResumeCursor(JSON.parse(JSON.stringify(cursor)))).toEqual(cursor);
    const damaged = parsePiResumeCursor({
      schemaVersion: 1,
      sessionFile: "/s.jsonl",
      cwd: "/p",
      turns: [{ turnId: "t1", known: true, leafId: "a1" }],
    });
    expect(damaged?.turns[0]?.known).toBe(false);
    expect(parsePiResumeCursor({ schemaVersion: 2, sessionFile: "/s", cwd: "/p" })).toBeUndefined();
  });
});
