import { describe, expect, it } from "vite-plus/test";

import {
  makePiResumeCursor,
  parsePiResumeCursor,
  PI_TURN_MARKER_TYPE,
  piTurnBoundaries,
  planPiFork,
  planPiRevert,
} from "./PiCursor.ts";
import type { PiSessionEntry } from "./PiProtocol.ts";

const entry = (id: string, parentId: string | null, extra: Record<string, unknown>) =>
  ({ id, parentId, ...extra }) as unknown as PiSessionEntry;
const marker = (
  id: string,
  parentId: string | null,
  turnId: string,
  mark: { readonly end?: true; readonly late?: true } = {},
) =>
  entry(id, parentId, {
    type: "custom",
    customType: PI_TURN_MARKER_TYPE,
    data: { turnId, ...mark },
  });
const user = (id: string, parentId: string | null) =>
  entry(id, parentId, { type: "message", message: { role: "user" } });
const assistant = (id: string, parentId: string | null) =>
  entry(id, parentId, { type: "message", message: { role: "assistant" } });

// m1 u1 a1 e1 | m2 u2 a2 u2s(steer) a2b e2 | m3 (crashed: no message) | m4 u4 a4 e4
// plus an abandoned branch off e1 that a revert left behind.
const entries = [
  marker("m1", null, "t1"),
  user("u1", "m1"),
  assistant("a1", "u1"),
  marker("e1", "a1", "t1", { end: true }),
  marker("old", "e1", "t-reverted"),
  user("uold", "old"),
  marker("m2", "e1", "t2"),
  user("u2", "m2"),
  assistant("a2", "u2"),
  user("u2s", "a2"),
  assistant("a2b", "u2s"),
  marker("e2", "a2b", "t2", { end: true }),
  marker("m3", "e2", "t3"),
  marker("m4", "m3", "t4"),
  user("u4", "m4"),
  assistant("a4", "u4"),
  marker("e4", "a4", "t4", { end: true }),
];
const boundaries = piTurnBoundaries(entries, "e4");
const fork = (
  leafId: string,
  request: { beforeTurnId?: string; lastTurnId?: string },
  extra = [],
) => planPiFork([...entries, ...extra], leafId, request);

describe("piTurnBoundaries", () => {
  it("reads the active branch's turns from their markers; steers stay in their turn", () => {
    expect(
      boundaries.map(({ turnId, firstUserEntryId, endMarkerId }) => [
        turnId,
        firstUserEntryId,
        endMarkerId,
      ]),
    ).toEqual([
      ["t1", "u1", "e1"],
      ["t2", "u2", "e2"],
      ["t3", null, null],
      ["t4", "u4", "e4"],
    ]);
  });
});

describe("planPiRevert and planPiFork", () => {
  it("reverts by cutting before a turn's first message, and never guesses", () => {
    expect(planPiRevert(boundaries, "t2")).toEqual({ kind: "fork", entryId: "u2" });
    expect(planPiRevert(boundaries, "t3")).toEqual({ kind: "unknown" });
    expect(planPiRevert(boundaries, "t-reverted")).toEqual({ kind: "unknown" });
  });

  it("forks through a turn by cutting before the next turn that has a message", () => {
    expect(fork("e4", { lastTurnId: "t1" })).toEqual({ kind: "fork", entryId: "u2" });
    expect(fork("e4", { lastTurnId: "t2" })).toEqual({ kind: "fork", entryId: "u4" });
    expect(fork("e4", { lastTurnId: "t4" })).toEqual({ kind: "clone" });
    expect(fork("e4", { beforeTurnId: "t4" })).toEqual({ kind: "fork", entryId: "u4" });
    expect(fork("e4", {})).toEqual({ kind: "clone" });
    expect(fork("e4", { lastTurnId: "missing" })).toEqual({ kind: "contextSeed" });
    // A turn that never ended has no place that is exactly "through it".
    expect(fork("e4", { lastTurnId: "t3" })).toEqual({ kind: "contextSeed" });
  });

  it("recaps instead of copying what came after a turn without Threadlines' markers", () => {
    // Said in Pi after Threadlines' last turn ended.
    const outside = [user("x1", "e4"), assistant("x2", "x1")];
    expect(fork("x2", { lastTurnId: "t4" }, outside as never)).toEqual({ kind: "contextSeed" });
    // A turn Pi started itself, marked once running: counted, never cut at.
    const late = [
      user("p1", "e4"),
      marker("mp", "p1", "tp", { late: true }),
      assistant("p2", "mp"),
    ];
    expect(fork("p2", { lastTurnId: "t4" }, late as never)).toEqual({ kind: "contextSeed" });
    expect(planPiRevert(piTurnBoundaries([...entries, ...late], "p2"), "tp")).toEqual({
      kind: "unknown",
    });
  });
});

describe("parsePiResumeCursor", () => {
  it("round-trips and rejects other versions", () => {
    const cursor = makePiResumeCursor({ sessionFile: "/s.jsonl", cwd: "/p" });
    expect(parsePiResumeCursor(JSON.parse(JSON.stringify(cursor)))).toEqual(cursor);
    expect(parsePiResumeCursor({ schemaVersion: 1, sessionFile: "/s", cwd: "/p" })).toBeUndefined();
  });
});
