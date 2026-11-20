/**
 * Splits a `multipart/x-mixed-replace` MJPEG body into JPEG frames, for
 * painting serve-sim's MJPEG stream onto the canvas when this browser cannot
 * decode H.264. A part's `Content-Length` says where it ends; a part without
 * one ends at the JPEG end-of-image marker.
 */
const HEADER_END = [13, 10, 13, 10];
const MAX_HEADER_BYTES = 8 * 1024;
const latin1 = new TextDecoder("latin1");

function indexOfSequence(buffer: Uint8Array, sequence: ReadonlyArray<number>, from: number) {
  outer: for (let index = from; index + sequence.length <= buffer.length; index += 1) {
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (buffer[index + offset] !== sequence[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

export class MultipartJpegParser {
  private buffer = new Uint8Array(256 * 1024);
  private length = 0;
  /** Bytes of the current part's body, once its headers are read; null for "until EOI". */
  private expected: number | null | undefined = undefined;

  push(bytes: Uint8Array): Uint8Array[] {
    if (this.length + bytes.length > this.buffer.length) {
      let capacity = this.buffer.length;
      while (capacity < this.length + bytes.length) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(bytes, this.length);
    this.length += bytes.length;

    const frames: Uint8Array[] = [];
    const view = this.buffer.subarray(0, this.length);
    let offset = 0;
    for (;;) {
      if (this.expected === undefined) {
        const end = indexOfSequence(view, HEADER_END, offset);
        if (end < 0) {
          // A runaway header block is not a stream we can read; start over.
          if (this.length - offset > MAX_HEADER_BYTES) offset = this.length;
          break;
        }
        const headers = latin1.decode(view.subarray(offset, end));
        const length = /content-length:\s*(\d+)/i.exec(headers)?.[1];
        this.expected = length === undefined ? null : Number(length);
        offset = end + HEADER_END.length;
        continue;
      }
      let frameEnd: number;
      if (this.expected === null) {
        const eoi = indexOfSequence(view, [0xff, 0xd9], offset + 2);
        if (eoi < 0) break;
        frameEnd = eoi + 2;
      } else {
        if (this.length - offset < this.expected) break;
        frameEnd = offset + this.expected;
      }
      const frame = view.slice(offset, frameEnd);
      if (frame[0] === 0xff && frame[1] === 0xd8) frames.push(frame);
      offset = frameEnd;
      this.expected = undefined;
    }
    if (offset > 0) {
      this.buffer.copyWithin(0, offset, this.length);
      this.length -= offset;
    }
    return frames;
  }
}
