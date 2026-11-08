/**
 * Frame timing for browser tests. Use it to check what the screen did between a
 * test's steps (a jump, a bounce, a flash), not only where it ended up: read the
 * values that matter after every drawn frame, then assert on the whole run.
 *
 *   const tops: number[] = [];
 *   const stop = readAfterEachPaint(() => tops.push(body.getBoundingClientRect().top));
 *   ...steps...
 *   stop();
 *   expect(largestDrop(tops)).toBeLessThanOrEqual(1);
 */

/** Waits for `count` frames to be drawn. */
export async function nextFrames(count = 1): Promise<void> {
  for (let frame = 0; frame < count; frame++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

/**
 * Calls `read` once per frame, after that frame is drawn: a task posted from a
 * frame's callbacks runs after the frame paints and, in Chromium, before work
 * queued while painting it. Sampling in the frame callback itself would miss a
 * bounce that a late correction undoes before the next frame. Returns a stop;
 * calling it again does nothing.
 */
export function readAfterEachPaint(read: () => void): () => void {
  const channel = new MessageChannel();
  channel.port1.addEventListener("message", read);
  channel.port1.start();
  let frame = requestAnimationFrame(function post() {
    channel.port2.postMessage(null);
    frame = requestAnimationFrame(post);
  });
  return () => {
    cancelAnimationFrame(frame);
    channel.port1.close();
  };
}

/** The largest step down between consecutive positions (negative when nothing moved down). */
export function largestDrop(positions: ReadonlyArray<number>): number {
  return Math.max(...positions.slice(1).map((top, index) => top - positions[index]!));
}
