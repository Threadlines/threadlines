/**
 * Saving a draft's attachments to IndexedDB (binary bytes) and local storage
 * (lightweight metadata), for the composer on screen and for code that fills a
 * draft whose composer is not mounted (a device recording that ends after the
 * user left its thread).
 */
import {
  type ComposerAttachment,
  type ComposerThreadTarget,
  ensureDraftAttachmentsHydrated,
  type PersistedComposerAttachment,
  useComposerDraftStore,
} from "./composerDraftStore";
import {
  deleteAttachmentBlobs,
  draftAttachmentBlobKey,
  putAttachmentBlob,
} from "./lib/attachmentBlobStore";

/**
 * Writes the draft's attachments to IndexedDB and syncs their metadata to
 * local storage, resolving once the draft says which made it
 * (`nonPersistedAttachmentIds` lists the rest).
 *
 * An attachment already backed by IndexedDB stays saved without re-reading its
 * file. A legacy attachment with an inline `dataUrl` is migrated to IndexedDB
 * and only drops `dataUrl` once its blob transaction commits; if IndexedDB
 * rejects the write, its working legacy inline copy is kept intact.
 *
 * Reading files and writing IndexedDB are async. If the draft's attachments
 * changed meanwhile (one removed, another pasted), this run's list is old: it
 * cleans up any orphaned blobs it wrote, writes no metadata, and answers
 * "stale", since the change that made the newer list saves it.
 */
const inFlightByTarget = new Map<
  string,
  { readonly listed: string; readonly promise: Promise<"saved" | "stale"> }
>();

function targetKey(target: ComposerThreadTarget): string {
  return typeof target === "string" ? target : `${target.environmentId}\u0000${target.threadId}`;
}

function attachmentIdListKey(attachments: ReadonlyArray<{ readonly id: string }>): string {
  return attachments.map((attachment) => attachment.id).join("\u0000");
}

function persistedAttachmentsEqual(
  left: ReadonlyArray<PersistedComposerAttachment>,
  right: ReadonlyArray<PersistedComposerAttachment>,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (
      a.id !== b.id ||
      a.name !== b.name ||
      a.mimeType !== b.mimeType ||
      a.sizeBytes !== b.sizeBytes ||
      a.dataUrl !== b.dataUrl
    ) {
      return false;
    }
  }
  return true;
}

function stringListsEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export async function saveComposerDraftAttachments(
  target: ComposerThreadTarget,
  options: {
    /**
     * The draft's attachments as the caller saw them; checked against the live
     * store after hydration so a first-render empty snapshot never clears
     * attachments that finished hydrating meanwhile.
     */
    readonly attachments?: ReadonlyArray<ComposerAttachment>;
  } = {},
): Promise<"saved" | "stale"> {
  const preCheckDraft = useComposerDraftStore.getState().getComposerDraft(target);
  if (preCheckDraft && preCheckDraft.hydratingAttachmentIds.length > 0) {
    await ensureDraftAttachmentsHydrated(target);
  }

  const key = targetKey(target);
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(target);
  const currentAttachments = draft?.attachments ?? [];
  if (
    options.attachments !== undefined &&
    attachmentIdListKey(options.attachments) !== attachmentIdListKey(currentAttachments)
  ) {
    return "stale";
  }
  if (draft && draft.hydratingAttachmentIds.length > 0) {
    return "stale";
  }

  const attachments = currentAttachments;
  if (!draft || attachments.length === 0) {
    inFlightByTarget.delete(key);
    store.clearPersistedAttachments(target);
    return "saved";
  }
  const listed = attachmentIdListKey(attachments);
  // Deduplicate concurrent saves of the exact same attachment list (e.g., ChatComposer +
  // recording handoff) without blocking a newer list behind a stale slow file read.
  const existing = inFlightByTarget.get(key);
  if (existing && existing.listed === listed) {
    return existing.promise;
  }

  const entry: { readonly listed: string; promise: Promise<"saved" | "stale"> } = {
    listed,
    promise: Promise.resolve("stale"),
  };
  const run = async (): Promise<"saved" | "stale"> => {
    const unsaved = new Set(draft.nonPersistedAttachmentIds);
    const saved = new Map(
      draft.persistedAttachments
        .filter((attachment) => !unsaved.has(attachment.id))
        .map((attachment) => [attachment.id, attachment]),
    );
    const failedHydrationIds = new Set(draft.failedHydrationAttachmentIds);
    const staged: PersistedComposerAttachment[] = [];
    const newlyWrittenBlobIds: string[] = [];

    // Preserve metadata for attachments whose IndexedDB read hit a transient
    // error, so adding a new file never drops an older file's reference.
    for (const persisted of draft.persistedAttachments) {
      if (failedHydrationIds.has(persisted.id)) {
        staged.push(persisted);
      }
    }

    for (const attachment of attachments) {
      const already = saved.get(attachment.id);
      if (already && already.dataUrl === undefined) {
        staged.push(already);
        continue;
      }
      let blob: Blob;
      try {
        const bytes = await attachment.file.arrayBuffer();
        blob = new Blob([bytes], {
          type: attachment.mimeType || attachment.file.type || "application/octet-stream",
        });
      } catch {
        // Keep a working legacy inline copy if reading the live File failed.
        if (already?.dataUrl !== undefined) {
          staged.push(already);
        }
        continue;
      }

      const written = await putAttachmentBlob(draftAttachmentBlobKey(attachment.id), blob);
      if (written) {
        newlyWrittenBlobIds.push(attachment.id);
        staged.push({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        });
      } else if (already?.dataUrl !== undefined) {
        // IndexedDB failed: keep the working legacy inline copy intact.
        staged.push(already);
      }
    }

    if (inFlightByTarget.get(key) !== entry) {
      cleanupUnreferencedWrittenBlobs(target, newlyWrittenBlobIds);
      return "stale";
    }
    const now = useComposerDraftStore.getState().getComposerDraft(target);
    if (!now || attachmentIdListKey(now.attachments) !== listed) {
      cleanupUnreferencedWrittenBlobs(target, newlyWrittenBlobIds);
      return "stale";
    }

    // When every attachment is already durably persisted with identical
    // metadata (e.g. a composer mounting right after IndexedDB hydration),
    // skip syncing so we do not dirty `changedSinceWrite` and risk overwriting
    // a newer prompt saved by another tab.
    const stagedIdSet = new Set(staged.map((attachment) => attachment.id));
    const expectedUnsavedIds = now.attachments
      .map((attachment) => attachment.id)
      .filter((id) => !stagedIdSet.has(id));
    if (
      newlyWrittenBlobIds.length === 0 &&
      persistedAttachmentsEqual(now.persistedAttachments, staged) &&
      stringListsEqual(now.nonPersistedAttachmentIds, expectedUnsavedIds)
    ) {
      return "saved";
    }

    await useComposerDraftStore.getState().syncPersistedAttachments(target, staged);

    // If localStorage metadata persistence rejected any newly written blob,
    // remove its IndexedDB copy right away so failed saves do not leak blobs.
    if (newlyWrittenBlobIds.length > 0) {
      const after = useComposerDraftStore.getState().getComposerDraft(target);
      const afterUnsaved = new Set(after?.nonPersistedAttachmentIds ?? []);
      const orphanedKeys = newlyWrittenBlobIds
        .filter((id) => afterUnsaved.has(id))
        .map(draftAttachmentBlobKey);
      if (orphanedKeys.length > 0) {
        void deleteAttachmentBlobs(orphanedKeys);
      }
    }
    return "saved";
  };

  inFlightByTarget.set(key, entry);
  entry.promise = run().finally(() => {
    if (inFlightByTarget.get(key) === entry) inFlightByTarget.delete(key);
  });
  return entry.promise;
}

function cleanupUnreferencedWrittenBlobs(
  target: ComposerThreadTarget,
  newlyWrittenBlobIds: ReadonlyArray<string>,
): void {
  if (newlyWrittenBlobIds.length === 0) return;
  const now = useComposerDraftStore.getState().getComposerDraft(target);
  const liveIds = new Set<string>([
    ...(now?.attachments.map((attachment) => attachment.id) ?? []),
    ...(now?.persistedAttachments.map((attachment) => attachment.id) ?? []),
  ]);
  const droppedKeys = newlyWrittenBlobIds
    .filter((id) => !liveIds.has(id))
    .map(draftAttachmentBlobKey);
  if (droppedKeys.length > 0) {
    void deleteAttachmentBlobs(droppedKeys);
  }
}
