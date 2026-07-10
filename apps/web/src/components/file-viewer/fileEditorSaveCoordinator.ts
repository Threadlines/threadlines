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
 */
import type { QueryClient } from "@tanstack/react-query";
import type { EnvironmentId, ProjectReadFileResult } from "@threadlines/contracts";

import { ensureEnvironmentApi } from "../../environmentApi";
import { useFileViewerStore } from "../../fileViewerStore";
import { projectQueryKeys } from "../../lib/projectReactQuery";
import { toastManager } from "../ui/toast";

export const FILE_SAVE_DEBOUNCE_MS = 600;

export interface FileEditTarget {
  environmentId: EnvironmentId;
  cwd: string;
  /** Workspace-relative path. */
  path: string;
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

function saveKey(target: FileEditTarget): string {
  return `${target.environmentId} ${target.cwd} ${target.path}`;
}

function utf8ByteLength(contents: string): number {
  return new TextEncoder().encode(contents).length;
}

function textReadResult(
  path: string,
  contents: string,
  contentHash: string,
): ProjectReadFileResult {
  return {
    kind: "text",
    relativePath: path,
    content: contents,
    size: utf8ByteLength(contents),
    truncated: false,
    contentHash,
  };
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
  input.queryClient.setQueryData<ProjectReadFileResult>(
    projectQueryKeys.readFile(input.environmentId, input.cwd, input.path),
    textReadResult(input.path, input.contents, entry.baselineHash),
  );

  if (entry.conflict) {
    // Latched: keep buffering keystrokes, never autosave over the conflict.
    useFileViewerStore.getState().setEditSaveState(input.path, "conflict");
    return;
  }
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
    entry.queryClient.setQueryData<ProjectReadFileResult>(
      projectQueryKeys.readFile(entry.environmentId, entry.cwd, entry.path),
      textReadResult(entry.path, conflict.content, conflict.contentHash),
    );
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
  if (!entry || entry.conflict) {
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
        entry.queryClient.setQueryData<ProjectReadFileResult>(
          projectQueryKeys.readFile(entry.environmentId, entry.cwd, entry.path),
          textReadResult(entry.path, contents, result.contentHash),
        );
      }
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
      toastManager.add({
        type: "error",
        title: `Unable to save ${entry.path.split("/").at(-1) ?? entry.path}`,
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  })();
  entry.inflight = write;
  await write;
}
