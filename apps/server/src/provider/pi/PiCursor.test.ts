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
const marker = (id: string, parentId: string | null, turnId: string) =>
  entry(id, parentId, { type: "custom", customType: PI_TURN_MARKER_TYPE, data: { turnId } });
const user = (id: string, parentId: string | null) =>
  entry(id, parentId, { type: "message", message: { role: "user" } });
const assistant = (id: string, parentId: string | null) =>
  entry(id, parentId, { type: "message", message: { role: "assistant" } });

// m1 u1 a1 | m2 u2 a2 u2s(steer) a2b | m3 (crashed: no message) | m4 u4 a4
// plus an abandoned branch off a1 that a revert left behind.
const entries = [
  marker("m1", null, "t1"),
  user("u1", "m1"),
  assistant("a1", "u1"),
  marker("old", "a1", "t-reverted"),
  user("uold", "old"),
  marker("m2", "a1", "t2"),
  user("u2", "m2"),
  assistant("a2", "u2"),
  user("u2s", "a2"),
  assistant("a2b", "u2s"),
  marker("m3", "a2b", "t3"),
  marker("m4", "m3", "t4"),
  user("u4", "m4"),
  assistant("a4", "u4"),
];
const boundaries = piTurnBoundaries(entries, "a4");

describe("piTurnBoundaries", () => {
  it("reads the active branch's turns from their markers; steers stay in their turn", () => {
    expect(boundaries).toEqual([
      { turnId: "t1", markerId: "m1", firstUserEntryId: "u1" },
      { turnId: "t2", markerId: "m2", firstUserEntryId: "u2" },
      { turnId: "t3", markerId: "m3", firstUserEntryId: null },
      { turnId: "t4", markerId: "m4", firstUserEntryId: "u4" },
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
    expect(planPiFork(boundaries, { lastTurnId: "t1" })).toEqual({ kind: "fork", entryId: "u2" });
    expect(planPiFork(boundaries, { lastTurnId: "t2" })).toEqual({ kind: "fork", entryId: "u4" });
    expect(planPiFork(boundaries, { lastTurnId: "t4" })).toEqual({ kind: "clone" });
    expect(planPiFork(boundaries, { beforeTurnId: "t4" })).toEqual({ kind: "fork", entryId: "u4" });
    expect(planPiFork(boundaries, {})).toEqual({ kind: "clone" });
    expect(planPiFork(boundaries, { lastTurnId: "missing" })).toEqual({ kind: "contextSeed" });
  });
});

describe("parsePiResumeCursor", () => {
  it("round-trips and rejects other versions", () => {
    const cursor = makePiResumeCursor({ sessionFile: "/s.jsonl", cwd: "/p" });
    expect(parsePiResumeCursor(JSON.parse(JSON.stringify(cursor)))).toEqual(cursor);
    expect(parsePiResumeCursor({ schemaVersion: 1, sessionFile: "/s", cwd: "/p" })).toBeUndefined();
  });
});
