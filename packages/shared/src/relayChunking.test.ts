import { describe, expect, it } from "vitest";

import {
  createRelayChunkReassembler,
  isRelayChunkFrame,
  RELAY_CHUNK_MAX_CHARS,
  RELAY_CHUNK_MAX_MESSAGE_CHARS,
  RELAY_CHUNK_PREFIX,
  splitRelayFrame,
} from "./relayChunking.ts";

function roundTrip(frame: string): string | null {
  const reassembler = createRelayChunkReassembler();
  let result: string | null = null;
  for (const part of splitRelayFrame(frame)) {
    result = reassembler.push(part);
  }
  return result;
}

describe("splitRelayFrame", () => {
  it("passes small frames through untouched", () => {
    const frame = JSON.stringify({ hello: "world" });
    expect(splitRelayFrame(frame)).toEqual([frame]);
  });

  it("splits oversized frames into chunk frames below the cap", () => {
    const frame = "a".repeat(RELAY_CHUNK_MAX_CHARS * 2 + 500);
    const parts = splitRelayFrame(frame);
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(isRelayChunkFrame(part)).toBe(true);
      expect(part.length).toBeLessThan(RELAY_CHUNK_MAX_CHARS + 200);
    }
  });

  it("never splits a surrogate pair across chunk boundaries", () => {
    // Fill so an astral character straddles the chunk boundary.
    const frame = `${"a".repeat(RELAY_CHUNK_MAX_CHARS - 1)}😀${"b".repeat(RELAY_CHUNK_MAX_CHARS)}`;
    const parts = splitRelayFrame(frame);
    for (const part of parts) {
      expect(part).not.toMatch(/[\uD800-\uDBFF]$/);
    }
    expect(roundTrip(frame)).toBe(frame);
  });
});

describe("createRelayChunkReassembler", () => {
  it("round-trips an oversized frame", () => {
    const frame = JSON.stringify({ payload: "x".repeat(RELAY_CHUNK_MAX_CHARS * 3) });
    expect(roundTrip(frame)).toBe(frame);
  });

  it("returns non-chunk frames as-is", () => {
    const reassembler = createRelayChunkReassembler();
    expect(reassembler.push('{"a":1}')).toBe('{"a":1}');
  });

  it("buffers intermediate chunks and completes on the last", () => {
    const frame = "z".repeat(RELAY_CHUNK_MAX_CHARS + 1);
    const [first, second] = splitRelayFrame(frame);
    const reassembler = createRelayChunkReassembler();
    expect(reassembler.push(first!)).toBeNull();
    expect(reassembler.push(second!)).toBe(frame);
  });

  it("drops a partial message when a new message starts", () => {
    const frameA = "a".repeat(RELAY_CHUNK_MAX_CHARS + 1);
    const frameB = "b".repeat(RELAY_CHUNK_MAX_CHARS + 1);
    const [firstA] = splitRelayFrame(frameA);
    const partsB = splitRelayFrame(frameB);
    const reassembler = createRelayChunkReassembler();
    expect(reassembler.push(firstA!)).toBeNull();
    let result: string | null = null;
    for (const part of partsB) {
      result = reassembler.push(part);
    }
    expect(result).toBe(frameB);
  });

  it("drops out-of-sequence chunks without corrupting later messages", () => {
    const frame = "c".repeat(RELAY_CHUNK_MAX_CHARS * 2 + 1);
    const [, second] = splitRelayFrame(frame);
    const reassembler = createRelayChunkReassembler();
    expect(reassembler.push(second!)).toBeNull();
    expect(roundTrip(frame)).toBe(frame);
  });

  it("drops malformed chunk frames", () => {
    const reassembler = createRelayChunkReassembler();
    expect(
      reassembler.push(`${RELAY_CHUNK_PREFIX}not-json${RELAY_CHUNK_PREFIX}payload`),
    ).toBeNull();
    expect(reassembler.push(`${RELAY_CHUNK_PREFIX}{"id":"x"}`)).toBeNull();
  });

  it("refuses messages beyond the reassembly size cap", () => {
    const reassembler = createRelayChunkReassembler();
    const hugeTotal = Math.ceil((RELAY_CHUNK_MAX_MESSAGE_CHARS + 1) / RELAY_CHUNK_MAX_CHARS) + 1;
    const payload = "d".repeat(RELAY_CHUNK_MAX_CHARS);
    let dropped = false;
    for (let seq = 0; seq < hugeTotal; seq += 1) {
      const header = JSON.stringify({ id: "big", seq, total: hugeTotal });
      const result = reassembler.push(
        `${RELAY_CHUNK_PREFIX}${header}${RELAY_CHUNK_PREFIX}${payload}`,
      );
      expect(result).toBeNull();
      if (seq * RELAY_CHUNK_MAX_CHARS > RELAY_CHUNK_MAX_MESSAGE_CHARS) {
        dropped = true;
      }
    }
    expect(dropped).toBe(true);
  });

  it("clears partial state on reset", () => {
    const frame = "e".repeat(RELAY_CHUNK_MAX_CHARS + 1);
    const [first, second] = splitRelayFrame(frame);
    const reassembler = createRelayChunkReassembler();
    expect(reassembler.push(first!)).toBeNull();
    reassembler.reset();
    expect(reassembler.push(second!)).toBeNull();
  });
});
