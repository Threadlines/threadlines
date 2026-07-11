// @effect-diagnostics globalRandom:off
// Frame chunking for the phone-link relay path.
//
// The relay runs on Cloudflare Workers, which reject any WebSocket message
// larger than 1 MiB. RPC frames carry inline base64 image attachments (and
// large diffs / file reads), so both relay peers split oversized text frames
// into chunk frames below that cap and reassemble them on the far side. The
// relay itself forwards raw frames verbatim and needs no knowledge of this.
//
// Chunk frame layout:
//   RELAY_CHUNK_PREFIX + JSON header + RELAY_CHUNK_PREFIX + payload slice
// The prefix is an ASCII unit separator, which no JSON app frame or relay
// control frame (RELAY_RAW_CONTROL_PREFIX, "\u001E") can start with.

export const RELAY_CHUNK_PREFIX = "\u001F";

// UTF-8 encodes a JS string at no more than 3 bytes per UTF-16 code unit
// (astral characters use two code units for four bytes), so 240k code units
// stay under ~720 KiB plus a small header — comfortably below Cloudflare's
// 1 MiB per-message cap.
export const RELAY_CHUNK_MAX_CHARS = 240_000;

// Reassembly refuses messages beyond this many chars so a misbehaving peer
// cannot grow the buffer without bound. Sized above the largest legitimate
// command payload (8 attachments at 14M data-url chars each).
export const RELAY_CHUNK_MAX_MESSAGE_CHARS = 128_000_000;

interface RelayChunkHeader {
  readonly id: string;
  readonly seq: number;
  readonly total: number;
}

let nextChunkMessageSerial = 0;

function nextChunkMessageId(): string {
  nextChunkMessageSerial += 1;
  return `${nextChunkMessageSerial.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isRelayChunkFrame(data: string): boolean {
  return data.startsWith(RELAY_CHUNK_PREFIX);
}

/**
 * Splits a text frame into relay-safe chunk frames. Frames at or below the
 * chunk size pass through untouched as a single-element array, so callers can
 * unconditionally `for (const part of splitRelayFrame(frame)) send(part)`.
 */
export function splitRelayFrame(frame: string): readonly string[] {
  if (frame.length <= RELAY_CHUNK_MAX_CHARS) {
    return [frame];
  }

  const id = nextChunkMessageId();
  const slices: string[] = [];
  let offset = 0;
  while (offset < frame.length) {
    let end = Math.min(offset + RELAY_CHUNK_MAX_CHARS, frame.length);
    // Never split a surrogate pair across chunks: a lone surrogate does not
    // survive the relay's string handling.
    if (end < frame.length) {
      const boundary = frame.charCodeAt(end - 1);
      if (boundary >= 0xd800 && boundary <= 0xdbff) {
        end -= 1;
      }
    }
    slices.push(frame.slice(offset, end));
    offset = end;
  }

  return slices.map(
    (payload, seq) =>
      `${RELAY_CHUNK_PREFIX}${JSON.stringify({ id, seq, total: slices.length } satisfies RelayChunkHeader)}${RELAY_CHUNK_PREFIX}${payload}`,
  );
}

function parseRelayChunkFrame(
  data: string,
): { readonly header: RelayChunkHeader; readonly payload: string } | null {
  const headerEnd = data.indexOf(RELAY_CHUNK_PREFIX, RELAY_CHUNK_PREFIX.length);
  if (headerEnd === -1) {
    return null;
  }
  let header: unknown;
  try {
    header = JSON.parse(data.slice(RELAY_CHUNK_PREFIX.length, headerEnd));
  } catch {
    return null;
  }
  if (typeof header !== "object" || header === null) {
    return null;
  }
  const record = header as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.seq !== "number" ||
    typeof record.total !== "number" ||
    !Number.isInteger(record.seq) ||
    !Number.isInteger(record.total) ||
    record.seq < 0 ||
    record.total < 1 ||
    record.seq >= record.total
  ) {
    return null;
  }
  return {
    header: { id: record.id, seq: record.seq, total: record.total },
    payload: data.slice(headerEnd + RELAY_CHUNK_PREFIX.length),
  };
}

export interface RelayChunkReassembler {
  /**
   * Feeds one received text frame through reassembly.
   *
   * Returns the frame itself when it is not a chunk frame, the reassembled
   * message when this frame completes one, and null while a message is still
   * accumulating or when a malformed / out-of-sequence chunk was dropped.
   */
  readonly push: (data: string) => string | null;
  /** Drops any partially accumulated message (call on disconnect). */
  readonly reset: () => void;
}

/**
 * Sequence-based reassembly for a single ordered peer stream. WebSocket
 * frames arrive in send order, so any gap or interleaving means the sender
 * reconnected mid-message; the partial message is dropped and the RPC layer's
 * own retries recover.
 */
export function createRelayChunkReassembler(): RelayChunkReassembler {
  let pendingId: string | null = null;
  let pendingTotal = 0;
  let pendingChars = 0;
  let parts: string[] = [];

  const reset = () => {
    pendingId = null;
    pendingTotal = 0;
    pendingChars = 0;
    parts = [];
  };

  const push = (data: string): string | null => {
    if (!isRelayChunkFrame(data)) {
      return data;
    }

    const chunk = parseRelayChunkFrame(data);
    if (!chunk) {
      reset();
      return null;
    }

    const { header, payload } = chunk;
    if (header.seq === 0) {
      reset();
      pendingId = header.id;
      pendingTotal = header.total;
    } else if (header.id !== pendingId || header.seq !== parts.length) {
      reset();
      return null;
    }

    pendingChars += payload.length;
    if (pendingChars > RELAY_CHUNK_MAX_MESSAGE_CHARS) {
      reset();
      return null;
    }

    parts.push(payload);
    if (parts.length < pendingTotal) {
      return null;
    }

    const message = parts.join("");
    reset();
    return message;
  };

  return { push, reset };
}
