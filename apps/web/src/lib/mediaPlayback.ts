/**
 * Fetches a video or sound file in pieces so the browser can play it.
 *
 * Everything reaches the app over its one connection to the computer (a
 * phone's goes through the relay), and a whole video is far too big for one
 * message, so the file comes in 4 MB pieces, two at a time, with progress.
 * It plays once it is all here: a browser can only stream a file it can ask
 * for by URL, and this one has none.
 *
 * The last few files loaded are kept for the session, so closing a video and
 * opening it again plays at once. Each is kept as its bytes, never as a URL:
 * a player makes its own URL and lets it go when it closes.
 */
import { type EnvironmentId, PROJECT_MEDIA_CHUNK_MAX_BYTES } from "@threadlines/contracts";

import { ensureEnvironmentApi } from "../environmentApi";

/** Files up to this size load as soon as they are opened; bigger ones wait for a click. */
export const MEDIA_AUTOLOAD_MAX_BYTES = 64 * 1024 * 1024;
/** Bigger files are not played here at all: the editor or the file manager can. */
export const MEDIA_PLAY_MAX_BYTES = 1024 * 1024 * 1024;

const CACHE_BUDGET_BYTES = 512 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 4;
const PARALLEL_PIECES = 2;

export type MediaLoadResult =
  | {
      readonly kind: "loaded";
      readonly blob: Blob;
      readonly size: number;
      /** The file's version (see the server's fileVersionOf), for what is made from it. */
      readonly version: string;
    }
  | { readonly kind: "missing" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "too-large"; readonly size: number };

interface KeptFile {
  readonly blob: Blob;
  readonly size: number;
  readonly version: string;
}

// Map order is recency.
const kept = new Map<string, KeptFile>();

function remember(key: string, entry: KeptFile): void {
  kept.delete(key);
  // One file bigger than the whole budget is played, not kept.
  if (entry.size > CACHE_BUDGET_BYTES) {
    return;
  }
  kept.set(key, entry);
  let total = 0;
  for (const item of kept.values()) total += item.size;
  for (const [oldKey, item] of kept) {
    if (kept.size <= CACHE_MAX_ENTRIES && total <= CACHE_BUDGET_BYTES) {
      break;
    }
    if (oldKey !== key) {
      kept.delete(oldKey);
      total -= item.size;
    }
  }
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

class MediaChangedError extends Error {
  constructor() {
    super("The file changed while it was loading.");
  }
}

/**
 * Loads the whole file. A kept copy is reused after one tiny read confirms
 * the file's version is unchanged. Rejects when a read fails or `signal`
 * aborts; the first failure stops every other read of the load, and no
 * progress is reported after it.
 */
export async function loadMediaFile(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly onProgress?: ((loadedBytes: number, totalBytes: number) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
  /** How big each piece is: the most the server sends, unless asked smaller. */
  readonly pieceBytes?: number | undefined;
}): Promise<MediaLoadResult> {
  const pieceBytes = Math.min(
    PROJECT_MEDIA_CHUNK_MAX_BYTES,
    Math.max(1, input.pieceBytes ?? PROJECT_MEDIA_CHUNK_MAX_BYTES),
  );
  const key = `${input.environmentId}\u0000${input.cwd}\u0000${input.relativePath}`;
  // Stops this load's own reads on its first failure, as well as on the caller's abort.
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const api = ensureEnvironmentApi(input.environmentId);
  const readPiece = async (offset: number, length = pieceBytes) => {
    stop.signal.throwIfAborted();
    const piece = await api.projects.readMediaChunk({
      cwd: input.cwd,
      relativePath: input.relativePath,
      offset,
      length,
    });
    stop.signal.throwIfAborted();
    return piece;
  };
  const report = (loadedBytes: number, totalBytes: number) => {
    if (!stop.signal.aborted) input.onProgress?.(loadedBytes, totalBytes);
  };

  try {
    const keptCopy = kept.get(key);
    if (keptCopy) {
      const probe = await readPiece(0, 0);
      if (probe.kind === "chunk" && probe.version === keptCopy.version) {
        remember(key, keptCopy);
        report(keptCopy.size, keptCopy.size);
        return { kind: "loaded", ...keptCopy };
      }
      kept.delete(key);
    }

    const first = await readPiece(0);
    if (first.kind !== "chunk") {
      return { kind: first.kind };
    }
    const { size, version } = first;
    if (size > MEDIA_PLAY_MAX_BYTES) {
      return { kind: "too-large", size };
    }
    // Each piece becomes a Blob as it lands, so its decoded bytes can go at
    // once and the whole file is never held twice while it is put together.
    const pieceCount = Math.max(1, Math.ceil(size / pieceBytes));
    const parts: Array<Blob | undefined> = Array.from({ length: pieceCount });
    const firstBytes = base64ToBytes(first.base64);
    parts[0] = new Blob([firstBytes]);
    let loadedBytes = firstBytes.byteLength;
    report(loadedBytes, size);

    let next = 1;
    const worker = async () => {
      while (next < pieceCount && !stop.signal.aborted) {
        const index = next;
        next += 1;
        const piece = await readPiece(index * pieceBytes);
        if (piece.kind !== "chunk" || piece.version !== version) {
          throw new MediaChangedError();
        }
        const bytes = base64ToBytes(piece.base64);
        parts[index] = new Blob([bytes]);
        loadedBytes += bytes.byteLength;
        report(loadedBytes, size);
      }
    };
    await Promise.all(
      Array.from({ length: PARALLEL_PIECES }, () =>
        worker().catch((error: unknown) => {
          stop.abort();
          throw error;
        }),
      ),
    );

    const blob = new Blob(
      parts.filter((part) => part !== undefined),
      { type: first.mimeType },
    );
    if (blob.size !== size) {
      throw new MediaChangedError();
    }
    remember(key, { blob, size, version });
    return { kind: "loaded", blob, size, version };
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    // Whatever happened, nothing more reads or reports for this load.
    stop.abort();
  }
}

/** Test-only: forget every kept file. */
export function resetMediaPlaybackForTests(): void {
  kept.clear();
}
