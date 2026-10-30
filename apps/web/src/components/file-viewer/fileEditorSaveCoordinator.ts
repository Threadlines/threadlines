/**
 * Debounced autosave pipeline for the file viewer's edit mode.
 *
 * Edits stream in per keystroke from the pierre editor; writes flow out to
 * `projects.writeFile` at most once per debounce window per file. The
 * react-query read cache is updated optimistically on every edit so tab
 * switches, the read-only view, and add-to-chat slicing always see the
 * latest buffer even while a write is pending. Save lifecycle is mirrored
 * into the file viewer store for the tab dirty dot and the footer status.
 *
 * Writes are conflict-safe: each carries the sha256 baseline of the content
 * this buffer was built on, and the server refuses stale writes with a
 * `conflict` result carrying the current disk state. A conflict latches the
 * buffer — autosave stops until the user picks "reload" (adopt disk,
 * discard buffer) or "overwrite" (write the buffer over the disk state).
 *
 * A file outside the project gets its original kept on the first save, and
 * `restoreFileOriginal` puts it back through this same pipeline, so a restore
 * never races a pending or in-flight save.
 */
import type { QueryClient } from "@tanstack/react-query";
import type {
  EnvironmentId,
  ProjectFileOriginal,
  ProjectReadFileResult,
} from "@threadlines/contracts";

import { ensureEnvironmentApi } from "../../environmentApi";
import { useFileViewerStore } from "../../fileViewerStore";
import { projectQueryKeys } from "../../lib/projectReactQuery";
import { failureNotice, toastManager } from "../ui/toast";

export const FILE_SAVE_DEBOUNCE_MS = 600;

export interface FileEditTarget {
  environmentId: EnvironmentId;
  cwd: string;
  /** Workspace-relative path, or absolute for a file outside the project. */
  path: string;
  /** Editing the source of a picture that is text underneath (SVG). */
  as?: "text" | undefined;
}

interface PendingFileSave extends FileEditTarget {
  queryClient: QueryClient;
  /** Latest buffer contents; always what the next write will persist. */
  contents: string;
  /**
   * sha256 of the content this buffer was built on (advanced after every
   * successful write). Sent as the write's `expectedContentHash`.
   */
  baselineHash: string;
  timer: ReturnType<typeof setTimeout> | null;
  inflight: Promise<void> | null;
  /** Disk state reported by a conflict; autosave is latched while set. */
  conflict: { content: string; contentHash: string; size: number } | null;
}

const pendingSaves = new Map<string, PendingFileSave>();
/**
 * Files with a restore on its way. Edits made meanwhile buffer without
 * saving, and are dropped when it lands: the editor reloads either way.
 */
const restoring = new Set<string>();

function saveKey(target: FileEditTarget): string {
  return `${target.environmentId} ${target.cwd} ${target.path}${target.as ? ` ${target.as}` : ""}`;
}

function readKey(target: FileEditTarget) {
  return projectQueryKeys.readFile(target.environmentId, target.cwd, target.path, target.as);
}

function utf8ByteLength(contents: string): number {
  return new TextEncoder().encode(contents).length;
}

/**
 * Puts `contents` in the read cache as the file's text. The kept original
 * rides along from the previous read unless `original` says otherwise (a save
 * that just kept one, or a restore that used it up: `null`).
 */
function cacheText(
  queryClient: QueryClient,
  target: FileEditTarget,
  contents: string,
  contentHash: string,
  original?: ProjectFileOriginal | null,
): void {
  queryClient.setQueryData<ProjectReadFileResult>(readKey(target), (previous) => {
    const kept =
      original === undefined
        ? previous?.kind === "text"
          ? previous.original
          : undefined
        : (original ?? undefined);
    return {
      kind: "text",
      relativePath: target.path,
      content: contents,
      size: utf8ByteLength(contents),
      truncated: false,
      contentHash,
      ...(kept ? { original: kept } : {}),
    };
  });
}

/** A saved SVG source changes the picture too. */
function refreshPictureOf(queryClient: QueryClient, target: FileEditTarget): void {
  if (target.as === undefined) return;
  void queryClient.invalidateQueries({
    queryKey: projectQueryKeys.readFile(target.environmentId, target.cwd, target.path),
    exact: true,
  });
}

/**
 * Record an edit: update the read cache, mark the tab dirty, and (re)arm the
 * debounced write. `baselineHash` seeds new buffers only — an existing
 * buffer keeps the baseline of its last successful write.
 */
export function queueFileEdit(
  input: FileEditTarget & { contents: string; baselineHash: string; queryClient: QueryClient },
): void {
  const key = saveKey(input);
  const existing = pendingSaves.get(key);
  const entry: PendingFileSave = existing ?? {
    environmentId: input.environmentId,
    cwd: input.cwd,
    path: input.path,
    as: input.as,
    queryClient: input.queryClient,
    contents: input.contents,
    baselineHash: input.baselineHash,
    timer: null,
    inflight: null,
    conflict: null,
  };
  entry.contents = input.contents;
  entry.queryClient = input.queryClient;
  pendingSaves.set(key, entry);

  // The buffer's hash is unknown client-side; reuse the baseline so a
  // remounted pane keeps asserting against the same disk state.
  cacheText(input.queryClient, input, input.contents, entry.baselineHash);

  if (entry.conflict) {
    // Latched: keep buffering keystrokes, never autosave over the conflict.
    useFileViewerStore.getState().setEditSaveState(input.path, "conflict");
    return;
  }
  if (restoring.has(key)) return;
  useFileViewerStore.getState().setEditSaveState(input.path, "pending");

  if (entry.timer !== null) {
    clearTimeout(entry.timer);
  }
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void performWrite(key);
  }, FILE_SAVE_DEBOUNCE_MS);
}

/**
 * Write a pending buffer immediately (Cmd+S, blur, pane unmount). Resolves
 * once the write settles; a no-op when nothing is pending or a conflict is
 * latched (conflicts resolve explicitly via `resolveFileConflict`).
 */
export async function flushFileEdits(target: FileEditTarget): Promise<void> {
  const key = saveKey(target);
  const entry = pendingSaves.get(key);
  if (!entry || entry.conflict) {
    return;
  }
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  await performWrite(key);
}

/**
 * Resolve a latched conflict.
 *
 * - `reload`: adopt the disk state — the buffer is discarded, the read cache
 *   is seeded with the conflict's content, and the active edit pane remounts.
 * - `overwrite`: write the buffer over the disk state, asserting against the
 *   conflict's hash so a further external change conflicts again instead of
 *   being clobbered.
 */
export async function resolveFileConflict(
  target: FileEditTarget,
  resolution: "reload" | "overwrite",
): Promise<void> {
  const key = saveKey(target);
  const entry = pendingSaves.get(key);
  if (!entry?.conflict) {
    return;
  }
  const conflict = entry.conflict;
  if (resolution === "reload") {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
    }
    pendingSaves.delete(key);
    cacheText(entry.queryClient, entry, conflict.content, conflict.contentHash);
    const store = useFileViewerStore.getState();
    store.setEditSaveState(entry.path, null);
    store.bumpEditReloadNonce();
    return;
  }
  entry.conflict = null;
  entry.baselineHash = conflict.contentHash;
  useFileViewerStore.getState().setEditSaveState(entry.path, "pending");
  await performWrite(key);
}

/** Whether a write is pending or in flight for the target. */
export function hasPendingFileEdits(target: FileEditTarget): boolean {
  return pendingSaves.has(saveKey(target));
}

async function performWrite(key: string): Promise<void> {
  const entry = pendingSaves.get(key);
  if (!entry || entry.conflict || restoring.has(key)) {
    return;
  }
  if (entry.inflight) {
    // A write is already running; it re-checks for newer contents when done.
    await entry.inflight;
    return;
  }
  const contents = entry.contents;
  useFileViewerStore.getState().setEditSaveState(entry.path, "saving");

  const write = (async () => {
    try {
      const api = ensureEnvironmentApi(entry.environmentId);
      const result = await api.projects.writeFile({
        cwd: entry.cwd,
        relativePath: entry.path,
        contents,
        // An empty baseline means the hash is unknown (response from a server
        // that predates content hashing) — write unguarded rather than
        // conflict on every save.
        ...(entry.baselineHash === "" ? {} : { expectedContentHash: entry.baselineHash }),
      });
      entry.inflight = null;
      if (result.kind === "conflict") {
        entry.conflict = {
          content: result.content,
          contentHash: result.contentHash,
          size: result.size,
        };
        if (entry.timer !== null) {
          clearTimeout(entry.timer);
          entry.timer = null;
        }
        useFileViewerStore.getState().setEditSaveState(entry.path, "conflict");
        return;
      }
      entry.baselineHash = result.contentHash;
      if (entry.contents === contents) {
        // Keep the cached read's hash aligned with the new disk state. When
        // the buffer already moved on, the follow-up write re-aligns it.
        cacheText(entry.queryClient, entry, contents, result.contentHash, result.original);
      }
      refreshPictureOf(entry.queryClient, entry);
      if (entry.contents === contents && entry.timer === null) {
        pendingSaves.delete(key);
        useFileViewerStore.getState().setEditSaveState(entry.path, null);
      } else if (entry.timer === null) {
        // Buffer moved on while writing; persist the newer contents now.
        await performWrite(key);
      }
    } catch (error) {
      entry.inflight = null;
      useFileViewerStore.getState().setEditSaveState(entry.path, "error");
      toastManager.add(
        failureNotice({
          title: `Couldn't save ${entry.path.split("/").at(-1) ?? entry.path}`,
          error,
        }),
      );
    }
  })();
  entry.inflight = write;
  await write;
}

/**
 * Put back the original kept before the first save over a file outside the
 * project. Unsaved edits are discarded (restoring is the way back), but only
 * after any save already on its way has landed, so the restore checks against
 * the file as it really is. Edits typed while it runs never save. A file that
 * changed under the editor, or has no original any more, reloads from disk
 * instead.
 */
export async function restoreFileOriginal(
  target: FileEditTarget & { queryClient: QueryClient },
): Promise<void> {
  const key = saveKey(target);
  if (restoring.has(key)) return;
  restoring.add(key);
  const store = useFileViewerStore.getState();
  try {
    const entry = pendingSaves.get(key);
    if (entry) {
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      if (entry.inflight) {
        await entry.inflight;
      }
    }
    store.setEditSaveState(target.path, null);
    const cached = target.queryClient.getQueryData<ProjectReadFileResult>(readKey(target));
    const baselineHash =
      entry?.conflict?.contentHash ??
      entry?.baselineHash ??
      (cached?.kind === "text" ? cached.contentHash : "");
    const api = ensureEnvironmentApi(target.environmentId);
    if (!api.projects.restoreOriginal || baselineHash === "") {
      throw new Error("The Threadlines on this file's computer is too old to restore originals.");
    }
    const result = await api.projects.restoreOriginal({
      cwd: target.cwd,
      relativePath: target.path,
      expectedContentHash: baselineHash,
    });
    if (result.kind === "restored") {
      dropEditsOf(key, target.path);
      cacheText(target.queryClient, target, result.content, result.contentHash, null);
      store.bumpEditReloadNonce();
      refreshPictureOf(target.queryClient, target);
      return;
    }
    await reloadFromDisk(key, target);
    toastManager.add(
      failureNotice({
        title: "Couldn't restore the original",
        reason:
          result.kind === "conflict"
            ? "The file changed on disk, so it's reloaded instead. Restore again if you still want the original."
            : "There's no original kept for this file any more.",
      }),
    );
  } catch (error) {
    await reloadFromDisk(key, target);
    toastManager.add(failureNotice({ title: "Couldn't restore the original", error }));
  } finally {
    restoring.delete(key);
  }
}

/** Forgets a file's unsaved buffer, timer and all. */
function dropEditsOf(key: string, path: string): void {
  const entry = pendingSaves.get(key);
  if (entry?.timer != null) clearTimeout(entry.timer);
  pendingSaves.delete(key);
  useFileViewerStore.getState().setEditSaveState(path, null);
}

/**
 * Shows the file as it is on disk. Edits typed while it reloads go too,
 * right before the editor remounts, so its closing flush has nothing to save.
 */
async function reloadFromDisk(key: string, target: FileEditTarget & { queryClient: QueryClient }) {
  await target.queryClient.invalidateQueries({ queryKey: readKey(target), exact: true });
  dropEditsOf(key, target.path);
  useFileViewerStore.getState().bumpEditReloadNonce();
}
