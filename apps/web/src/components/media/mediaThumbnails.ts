/**
 * Small pictures for grids of files: the Media tab's tiles and the Diff tab's
 * Before/After pairs.
 *
 * A picture's bytes only come whole (`projects.readFile` and the revision
 * reads send the file, up to 10 MB, over the one socket a phone also uses), so
 * the cost is bounded here instead: a tile asks only once it scrolls near the
 * screen, at most three files travel at a time, and what is kept is a copy
 * shrunk to tile size (a few dozen KB), never the file. Copies live in one
 * byte-budgeted cache shared by every grid; one a mounted tile shows is never
 * evicted from under it.
 */
import type { ProjectReadFileResult, ProjectRevisionFileResult } from "@threadlines/contracts";
import {
  type RefObject,
  useCallback,
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
} from "react";

/** Wide enough to stay sharp in a two-column tile on a 2x screen. */
const THUMBNAIL_WIDTH = 400;
const CACHE_BUDGET_BYTES = 32 * 1024 * 1024;
const MAX_CONCURRENT_LOADS = 3;
/** Small pictures already at tile size are kept as they are, not re-encoded. */
const KEEP_AS_IS_BYTES = 192 * 1024;
/** An SVG is shown as itself; one this big is not worth drawing in a tile. */
const MAX_SVG_BYTES = 2 * 1024 * 1024;

export type MediaThumbnailStatus = "idle" | "loading" | "ready" | "missing" | "unavailable";

export interface MediaThumbnail {
  readonly status: MediaThumbnailStatus;
  readonly url?: string | undefined;
  /** The picture's own size in pixels, when it could be measured. */
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  /** The file's size in bytes. */
  readonly size?: number | undefined;
}

type ReadResult = ProjectReadFileResult | ProjectRevisionFileResult;

interface CachedThumbnail {
  readonly url: string;
  readonly bytes: number;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly size: number;
  refs: number;
}

type Outcome = CachedThumbnail | "missing" | "unavailable";

// Map order is recency: a hit moves its entry to the end.
const cache = new Map<string, CachedThumbnail>();
let cachedBytes = 0;
// Failures are remembered for the session; a key names one version of a file.
const failures = new Map<string, "missing" | "unavailable">();
const inflight = new Map<string, Promise<Outcome | "skipped">>();
// How many mounted tiles want each key right now. A queued load nobody wants
// by the time its turn comes is skipped: scrolling fast past a hundred tiles
// does not download a hundred pictures.
const demand = new Map<string, number>();
const queue: Array<() => void> = [];
let running = 0;

function want(key: string, delta: 1 | -1): void {
  const next = (demand.get(key) ?? 0) + delta;
  if (next > 0) {
    demand.set(key, next);
  } else {
    demand.delete(key);
  }
}

function runQueued<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      running += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          running -= 1;
          queue.shift()?.();
        });
    };
    if (running < MAX_CONCURRENT_LOADS) {
      start();
    } else {
      queue.push(start);
    }
  });
}

/** Drops the least recently used unheld copies until the cache fits. */
function evict(): boolean {
  let evicted = false;
  for (const [key, entry] of cache) {
    if (cachedBytes <= CACHE_BUDGET_BYTES) {
      break;
    }
    if (entry.refs > 0) {
      continue;
    }
    cache.delete(key);
    cachedBytes -= entry.bytes;
    URL.revokeObjectURL(entry.url);
    evicted = true;
  }
  return evicted;
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  // Native where the browser has it (Chromium 140+, Safari 18.2+), many
  // times faster than decoding a string a character at a time.
  const typed = Uint8Array as { fromBase64?: (text: string) => Uint8Array<ArrayBuffer> };
  if (typeof typed.fromBase64 === "function") {
    return typed.fromBase64(base64);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function encodeCanvas(
  width: number,
  height: number,
  draw: (context: CanvasDrawImage) => void,
) {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    draw(context);
    return canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  draw(context);
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
}

/** The file as a tile-sized picture, or why there is none. */
async function shrink(result: ReadResult): Promise<Outcome> {
  if (result.kind === "missing") {
    return "missing";
  }
  if (result.kind === "document") {
    // A PDF's first page, drawn by the same pdf.js the file viewer uses.
    const { renderPdfFirstPage } = await import("../../lib/pdfThumbnail");
    const page = await renderPdfFirstPage({
      bytes: base64ToBytes(result.base64),
      width: THUMBNAIL_WIDTH,
    });
    return page
      ? {
          url: URL.createObjectURL(page.blob),
          bytes: page.blob.size,
          width: undefined,
          height: undefined,
          size: result.size,
          refs: 0,
        }
      : "unavailable";
  }
  if (result.kind !== "image") {
    return "unavailable";
  }
  const bytes = base64ToBytes(result.base64);
  const source = new Blob([bytes], { type: result.mimeType });
  const keep = (blob: Blob, width?: number, height?: number): CachedThumbnail => ({
    url: URL.createObjectURL(blob),
    bytes: blob.size,
    width,
    height,
    size: result.size,
    refs: 0,
  });
  if (result.mimeType === "image/svg+xml") {
    // Drawn by the browser at any size; there is nothing to shrink.
    return bytes.byteLength > MAX_SVG_BYTES ? "unavailable" : keep(source);
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    // A format this browser can't draw (HEIC on most), or a broken file.
    return "unavailable";
  }
  try {
    const { width, height } = bitmap;
    const scale = Math.min(1, THUMBNAIL_WIDTH / Math.max(1, width));
    if (scale === 1 && bytes.byteLength <= KEEP_AS_IS_BYTES) {
      return keep(source, width, height);
    }
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const blob = await encodeCanvas(targetWidth, targetHeight, (context) =>
      context.drawImage(bitmap, 0, 0, targetWidth, targetHeight),
    );
    return blob ? keep(blob, width, height) : "unavailable";
  } finally {
    bitmap.close();
  }
}

const listeners = new Set<() => void>();
// One stable snapshot per key, so subscribers re-render only when theirs changed.
const snapshots = new Map<string, MediaThumbnail>();
// Shared constants: a snapshot must be the same object until something changes.
const IDLE: MediaThumbnail = { status: "idle" };
const LOADING: MediaThumbnail = { status: "loading" };
const MISSING: MediaThumbnail = { status: "missing" };
const UNAVAILABLE: MediaThumbnail = { status: "unavailable" };

function notify(): void {
  snapshots.clear();
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshotFor(key: string, enabled: boolean, loads: boolean): MediaThumbnail {
  const failure = failures.get(key);
  if (failure) {
    return failure === "missing" ? MISSING : UNAVAILABLE;
  }
  const entry = cache.get(key);
  if (!entry) {
    return enabled && loads ? LOADING : IDLE;
  }
  let snapshot = snapshots.get(key);
  if (!snapshot) {
    snapshot = {
      status: "ready",
      url: entry.url,
      width: entry.width,
      height: entry.height,
      size: entry.size,
    };
    snapshots.set(key, snapshot);
  }
  return snapshot;
}

/**
 * Loads one key with the read that belongs to it: the caller passes the read
 * captured with that key, so a tile whose props have since moved on can never
 * file a newer picture under an older key.
 */
function loadThumbnail(key: string, read: () => Promise<ReadResult>): Promise<Outcome | "skipped"> {
  const pending = inflight.get(key);
  if (pending) {
    return pending;
  }
  const promise = runQueued(async (): Promise<Outcome | "skipped"> => {
    if (!demand.has(key)) {
      return "skipped";
    }
    try {
      return await shrink(await read());
    } catch {
      return "unavailable";
    }
  }).then((outcome) => {
    inflight.delete(key);
    if (outcome === "skipped") {
      return outcome;
    }
    if (typeof outcome === "string") {
      failures.set(key, outcome);
    } else {
      // Evicting waits for the next retain or release, so the tile that
      // asked for this one holds it before anything can take it away.
      cache.set(key, outcome);
      cachedBytes += outcome.bytes;
    }
    notify();
    return outcome;
  });
  inflight.set(key, promise);
  return promise;
}

function retain(key: string): boolean {
  const entry = cache.get(key);
  if (!entry) {
    return false;
  }
  entry.refs += 1;
  // Most recently used goes last.
  cache.delete(key);
  cache.set(key, entry);
  evict();
  return true;
}

function release(key: string): void {
  const entry = cache.get(key);
  if (entry) {
    entry.refs = Math.max(0, entry.refs - 1);
    if (evict()) {
      notify();
    }
  }
}

/**
 * A tile's picture. `key` must change whenever the file does (it carries the
 * turn and size the listing reports); `read` is only called on a miss, once
 * `enabled` (the tile is near the screen). A null `read` only shows what is
 * already kept under the key (a video's poster, filed when it played).
 */
export function useMediaThumbnail(input: {
  readonly key: string | null;
  readonly read: (() => Promise<ReadResult>) | null;
  readonly enabled: boolean;
}): MediaThumbnail {
  const { key, enabled } = input;
  const loads = input.read !== null;
  // The read of the render that produced `key`, taken when the effect for
  // that key runs, so the load and the key always describe the same file.
  const currentRead = useEffectEvent(() => input.read);
  // A poster filed after this tile mounted is picked up by the snapshot; the
  // tile holds it from its next visit.
  const thumbnail = useSyncExternalStore(
    subscribe,
    useCallback(
      () => (key === null ? UNAVAILABLE : snapshotFor(key, enabled, loads)),
      [enabled, key, loads],
    ),
  );

  useEffect(() => {
    if (key === null || !enabled || failures.has(key)) {
      return;
    }
    let held = retain(key);
    let pending = false;
    let cancelled = false;
    const read = currentRead();
    if (!held && read !== null) {
      pending = true;
      want(key, 1);
      void loadThumbnail(key, read).then(() => {
        if (cancelled) {
          return;
        }
        pending = false;
        want(key, -1);
        held = retain(key);
      });
    }
    return () => {
      cancelled = true;
      if (pending) {
        want(key, -1);
      }
      if (held) {
        release(key);
      }
    };
  }, [enabled, key]);

  return thumbnail;
}

/** The nearest ancestor that scrolls, which is what clips a tile in a panel. */
function scrollParent(element: Element): Element | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll") {
      return parent;
    }
  }
  return null;
}

/**
 * Whether the element is within `rootMargin` of what its scroll area shows.
 * The margin is measured against that scroll area (a panel), not the window:
 * a tile clipped by its panel never counts as on screen, margin or not. A tile
 * far off screen lets its picture go (it stays in the cache, evictable, and
 * comes back at once if it was not evicted), so a long gallery holds only
 * what is near the screen.
 */
export function useNearViewport(ref: RefObject<Element | null>, rootMargin = "600px"): boolean {
  // Without an observer to ask, every tile counts as near.
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries.at(-1);
        if (last) {
          setNear(last.isIntersecting);
        }
      },
      { root: scrollParent(element), rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, rootMargin]);
  return near;
}

/** Where a video's first frame is kept: one key for its tile and its player. */
export function videoPosterKey(
  environmentId: string,
  absolutePath: string,
  version: string,
): string {
  return `poster|${environmentId}|${absolutePath}|${version}`;
}

/**
 * Files a picture made elsewhere under `key`, as if a tile had loaded it: a
 * video's first frame, taken when it played, becomes its tile's poster.
 */
export function primeMediaThumbnail(
  key: string,
  picture: { readonly blob: Blob; readonly size: number },
): void {
  if (cache.has(key)) {
    return;
  }
  failures.delete(key);
  const entry: CachedThumbnail = {
    url: URL.createObjectURL(picture.blob),
    bytes: picture.blob.size,
    width: undefined,
    height: undefined,
    size: picture.size,
    refs: 0,
  };
  cache.set(key, entry);
  cachedBytes += entry.bytes;
  evict();
  notify();
}

/** Test-only: forget every cached picture. */
export function resetMediaThumbnailsForTests(): void {
  for (const entry of cache.values()) {
    URL.revokeObjectURL(entry.url);
  }
  cache.clear();
  failures.clear();
  inflight.clear();
  demand.clear();
  snapshots.clear();
  cachedBytes = 0;
}
