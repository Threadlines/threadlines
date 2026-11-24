/**
 * Binary storage for composer draft and prompt stash attachments in IndexedDB.
 *
 * `localStorage` gives the whole origin ~5 MB and only stores strings (base64
 * inflates files by a third), so screenshots and recordings overflow it easily.
 * Metadata (id, name, mime type, size) stays in the lightweight `localStorage`
 * stores while raw `Blob` bytes live here under owner-namespaced keys so
 * clearing a draft never deletes a stashed prompt's copy, or vice versa.
 */

const DATABASE_NAME = "threadlines-draft-attachments";
const DATABASE_VERSION = 1;
const STORE_NAME = "blobs";

/**
 * Minimum age before an unreferenced blob is eligible for startup garbage
 * collection, so one tab opening cannot sweep a blob another tab just wrote
 * before its debounced `localStorage` metadata flushed.
 */
export const ORPHAN_ATTACHMENT_BLOB_GRACE_MS = 10 * 60 * 1000;

export function draftAttachmentBlobKey(attachmentId: string): string {
  return `draft:${attachmentId}`;
}

export function stashAttachmentBlobKey(entryId: string, attachmentId: string): string {
  return `stash:${entryId}:${attachmentId}`;
}

export type AttachmentBlobReadResult =
  | { readonly status: "ok"; readonly blob: Blob }
  | { readonly status: "not-found" }
  | { readonly status: "error" };

export interface AttachmentBlobMeta {
  readonly id: string;
  readonly updatedAt: number;
}

export interface AttachmentBlobBackend {
  readonly put: (key: string, blob: Blob, updatedAt: number) => Promise<boolean>;
  readonly get: (key: string) => Promise<AttachmentBlobReadResult>;
  readonly deleteMany: (keys: ReadonlyArray<string>) => Promise<void>;
  readonly listMeta: () => Promise<ReadonlyArray<AttachmentBlobMeta> | null>;
  readonly clearAll?: () => Promise<void>;
}

interface StoredAttachmentBlobRecord {
  readonly id: string;
  readonly blob: Blob;
  readonly updatedAt: number;
}

let databasePromise: Promise<IDBDatabase | null> | null = null;
let testBackendOverride: AttachmentBlobBackend | null = null;

/**
 * Session-only fallback used only when a caller opts in (prompt stash when
 * IndexedDB fails) so restoring in the same tab still works while the UI warns
 * the user the attachments will not survive a reload.
 */
const memoryFallbackBlobs = new Map<string, Blob>();

/**
 * Serializes mutations (and lets reads observe preceding writes) so a quick
 * delete followed by a re-put for the same key (e.g. a failed send retry) can
 * never commit out of order.
 */
let mutationQueue: Promise<void> = Promise.resolve();

function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      });
      request.addEventListener("success", () => {
        const db = request.result;
        db.addEventListener("close", () => {
          databasePromise = null;
        });
        db.addEventListener("versionchange", () => {
          db.close();
          databasePromise = null;
        });
        resolve(db);
      });
      request.addEventListener("error", () => {
        databasePromise = null;
        resolve(null);
      });
      request.addEventListener("blocked", () => {
        databasePromise = null;
        resolve(null);
      });
    } catch {
      databasePromise = null;
      resolve(null);
    }
  });
  return databasePromise;
}

const indexedDbBackend: AttachmentBlobBackend = {
  put: async (key, blob, updatedAt) => {
    const db = await openDatabase();
    if (!db) return false;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      try {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const record: StoredAttachmentBlobRecord = { id: key, blob, updatedAt };
        const request = store.put(record);
        request.addEventListener("error", () => finish(false));
        transaction.addEventListener("complete", () => finish(true));
        transaction.addEventListener("error", () => finish(false));
        transaction.addEventListener("abort", () => finish(false));
      } catch {
        finish(false);
      }
    });
  },
  get: async (key) => {
    const db = await openDatabase();
    if (!db) return { status: "error" };
    return await new Promise<AttachmentBlobReadResult>((resolve) => {
      let settled = false;
      const finish = (result: AttachmentBlobReadResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        const transaction = db.transaction(STORE_NAME, "readonly");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(key);
        request.addEventListener("success", () => {
          const record = request.result as StoredAttachmentBlobRecord | undefined;
          if (record && record.blob instanceof Blob) {
            finish({ status: "ok", blob: record.blob });
            return;
          }
          finish({ status: "not-found" });
        });
        request.addEventListener("error", () => finish({ status: "error" }));
        transaction.addEventListener("error", () => finish({ status: "error" }));
        transaction.addEventListener("abort", () => finish({ status: "error" }));
      } catch {
        finish({ status: "error" });
      }
    });
  },
  deleteMany: async (keys) => {
    if (keys.length === 0) return;
    const db = await openDatabase();
    if (!db) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        for (const key of keys) {
          store.delete(key);
        }
        transaction.addEventListener("complete", finish);
        transaction.addEventListener("error", finish);
        transaction.addEventListener("abort", finish);
      } catch {
        finish();
      }
    });
  },
  listMeta: async () => {
    const db = await openDatabase();
    if (!db) return null;
    return await new Promise<ReadonlyArray<AttachmentBlobMeta> | null>((resolve) => {
      let settled = false;
      const finish = (entries: ReadonlyArray<AttachmentBlobMeta> | null) => {
        if (settled) return;
        settled = true;
        resolve(entries);
      };
      const results: AttachmentBlobMeta[] = [];
      try {
        const transaction = db.transaction(STORE_NAME, "readonly");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.openCursor();
        request.addEventListener("success", () => {
          const cursor = request.result;
          if (!cursor) {
            finish(results);
            return;
          }
          const value = cursor.value as Partial<StoredAttachmentBlobRecord> | undefined;
          if (typeof value?.id === "string") {
            results.push({
              id: value.id,
              updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
            });
          }
          cursor.continue();
        });
        request.addEventListener("error", () => finish(null));
        transaction.addEventListener("error", () => finish(null));
        transaction.addEventListener("abort", () => finish(null));
      } catch {
        finish(null);
      }
    });
  },
  clearAll: async () => {
    const db = await openDatabase();
    if (!db) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).clear();
        transaction.addEventListener("complete", finish);
        transaction.addEventListener("error", finish);
        transaction.addEventListener("abort", finish);
      } catch {
        finish();
      }
    });
  },
};

function activeBackend(): AttachmentBlobBackend {
  return testBackendOverride ?? indexedDbBackend;
}

/**
 * Stores raw binary bytes in IndexedDB. Returns true only after the IndexedDB
 * transaction commits durably.
 *
 * Pass `memoryFallbackOnFailure: true` when the caller wants the blob kept in
 * memory for the rest of this session if IndexedDB rejects the write (the
 * return value is still `false` so the caller knows it will not survive reload).
 */
export function putAttachmentBlob(
  key: string,
  blob: Blob,
  options?: { readonly memoryFallbackOnFailure?: boolean; readonly updatedAt?: number },
): Promise<boolean> {
  return enqueueMutation(async () => {
    const updatedAt = options?.updatedAt ?? Date.now();
    let persisted = false;
    try {
      persisted = await activeBackend().put(key, blob, updatedAt);
    } catch {
      persisted = false;
    }
    if (persisted) {
      memoryFallbackBlobs.delete(key);
      return true;
    }
    if (options?.memoryFallbackOnFailure) {
      memoryFallbackBlobs.set(key, blob);
    }
    return false;
  });
}

/**
 * Reads a stored blob, distinguishing a missing key (`not-found`) from a
 * transient storage failure (`error`) so callers never delete metadata on a
 * temporary read error.
 */
export async function readAttachmentBlob(key: string): Promise<AttachmentBlobReadResult> {
  await mutationQueue;
  const fallback = memoryFallbackBlobs.get(key);
  if (fallback) {
    return { status: "ok", blob: fallback };
  }
  try {
    return await activeBackend().get(key);
  } catch {
    return { status: "error" };
  }
}

/** Removes blobs from both IndexedDB and the session-only fallback map. */
export function deleteAttachmentBlobs(keys: ReadonlyArray<string>): Promise<void> {
  if (keys.length === 0) return Promise.resolve();
  const uniqueKeys = [...new Set(keys)];
  return enqueueMutation(async () => {
    for (const key of uniqueKeys) {
      memoryFallbackBlobs.delete(key);
    }
    try {
      await activeBackend().deleteMany(uniqueKeys);
    } catch {
      // Best-effort cleanup; startup orphan sweep catches anything left behind.
    }
  });
}

/**
 * Removes blobs that are no longer referenced by any draft or stashed prompt
 * and are older than `graceMs`. Evaluates `getLiveKeys` inside the mutation
 * queue right before deleting; returning `null` cancels the sweep safely.
 */
export function sweepOrphanedAttachmentBlobs(
  getLiveKeys: () => ReadonlySet<string> | null,
  options?: { readonly graceMs?: number; readonly now?: number },
): Promise<number> {
  return enqueueMutation(async () => {
    const meta = await activeBackend()
      .listMeta()
      .catch(() => null);
    if (!meta || meta.length === 0) return 0;
    const liveKeys = getLiveKeys();
    if (liveKeys === null) return 0;
    const graceMs = options?.graceMs ?? ORPHAN_ATTACHMENT_BLOB_GRACE_MS;
    const cutoff = (options?.now ?? Date.now()) - graceMs;
    const staleKeys = meta
      .filter((entry) => !liveKeys.has(entry.id) && entry.updatedAt <= cutoff)
      .map((entry) => entry.id);
    if (staleKeys.length === 0) return 0;
    await activeBackend()
      .deleteMany(staleKeys)
      .catch(() => undefined);
    return staleKeys.length;
  });
}

/** Test seam: swaps the backing IndexedDB implementation (pass `null` to restore). */
export function setAttachmentBlobBackendForTest(backend: AttachmentBlobBackend | null): void {
  testBackendOverride = backend;
}

/** Test seam: clears all stored blobs from memory and the active backend. */
export function clearAttachmentBlobsForTest(): Promise<void> {
  return enqueueMutation(async () => {
    memoryFallbackBlobs.clear();
    await activeBackend()
      .clearAll?.()
      .catch(() => undefined);
  });
}

/** Test helper: creates an in-memory backend with IndexedDB semantics for Node unit tests. */
export function createMemoryAttachmentBlobBackend(): AttachmentBlobBackend {
  const store = new Map<string, { blob: Blob; updatedAt: number }>();
  return {
    put: async (key, blob, updatedAt) => {
      store.set(key, { blob, updatedAt });
      return true;
    },
    get: async (key) => {
      const entry = store.get(key);
      return entry ? { status: "ok", blob: entry.blob } : { status: "not-found" };
    },
    deleteMany: async (keys) => {
      for (const key of keys) {
        store.delete(key);
      }
    },
    listMeta: async () =>
      Array.from(store.entries(), ([id, entry]) => ({ id, updatedAt: entry.updatedAt })),
    clearAll: async () => {
      store.clear();
    },
  };
}
