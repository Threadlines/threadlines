/**
 * Async stash and restore orchestration for `ChatComposer`, loaded lazily on
 * user action so IndexedDB blob transfers stay out of the startup bundle.
 */
import { scopedThreadKey } from "@threadlines/client-runtime";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@threadlines/contracts";

import { collapseExpandedComposerCursor } from "../../composer-logic";
import {
  type ComposerAttachment,
  type ComposerThreadTarget,
  type PersistedComposerAttachment,
  composerAttachmentDedupKey,
  composerAttachmentFromFile,
  composerDraftAttachmentCount,
  ensureDraftAttachmentsHydrated,
  hydratePersistedComposerAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import {
  deleteAttachmentBlobs,
  draftAttachmentBlobKey,
  putAttachmentBlob,
  readAttachmentBlob,
  stashAttachmentBlobKey,
} from "../../lib/attachmentBlobStore";
import { pickedElementContextDedupKey } from "../../lib/pickedElementContext";
import { randomUUID } from "../../lib/utils";
import {
  buildStashEntryContexts,
  deleteStashEntryBlobs,
  isPromptStashStorageDurable,
  MAX_STASH_ENTRIES,
  stashEntryContextDrafts,
  usePromptStashStore,
  type PromptStashEntry,
} from "../../promptStashStore";
import { failureNotice, toastManager } from "../ui/toast";

export interface RestoreStashEntryContext {
  readonly entry: PromptStashEntry;
  readonly restoreTarget: ComposerThreadTarget;
  readonly restoreTargetKey: string;
  readonly getActiveDraftTargetKey: () => string;
  readonly getLivePrompt: () => string;
  readonly applyPromptOnActiveTarget: (nextPrompt: string, collapsedCursor: number) => void;
  readonly commitPickedElementsOnActiveTarget: (
    next: ReturnType<typeof stashEntryContextDrafts>["pickedElementContexts"],
  ) => void;
  readonly focusAfterWrite: (nextPrompt: string, placement: "end") => void;
}

export async function runRestoreStashEntry(ctx: RestoreStashEntryContext): Promise<void> {
  const { entry, restoreTarget, restoreTargetKey } = ctx;
  const draftStore = useComposerDraftStore.getState();
  const stashStore = usePromptStashStore.getState();

  await ensureDraftAttachmentsHydrated(restoreTarget);

  const liveEntry = usePromptStashStore
    .getState()
    .entries.find((candidate) => candidate.id === entry.id);
  if (!liveEntry) return;

  // Read all stash blobs before consuming the entry so a reload mid-read
  // or a transient storage read error leaves the stashed prompt intact.
  const loadedEntries: Array<{
    readonly meta: PersistedComposerAttachment;
    readonly file: File;
    readonly blob: Blob;
    readonly legacyDataUrl?: string;
  }> = [];
  const missingBlobNames: string[] = [];
  for (const attachment of liveEntry.attachments) {
    if (typeof attachment.dataUrl === "string") {
      const file = hydratePersistedComposerAttachment(attachment);
      if (!file) {
        missingBlobNames.push(attachment.name);
        continue;
      }
      loadedEntries.push({
        meta: attachment,
        file,
        blob: file,
        legacyDataUrl: attachment.dataUrl,
      });
      continue;
    }
    const read = await readAttachmentBlob(stashAttachmentBlobKey(liveEntry.id, attachment.id));
    if (read.status === "error") {
      toastManager.add({
        type: "error",
        title: "Couldn't restore stashed prompt",
        description:
          "Browser storage could not load one or more attached files. Try restoring again.",
        data: { hideCopyButton: true },
      });
      return;
    }
    if (read.status === "not-found") {
      missingBlobNames.push(attachment.name);
      continue;
    }
    const file = new File([read.blob], attachment.name, { type: attachment.mimeType });
    loadedEntries.push({ meta: attachment, file, blob: read.blob });
  }

  // Mint fresh attachment ids and pre-write destination draft blobs before
  // consuming the stash entry, so two drafts can never share a blob key and a
  // crash never loses the only copy.
  const prepared: Array<{
    readonly restored: ComposerAttachment;
    readonly meta: PersistedComposerAttachment;
    readonly legacyDataUrl?: string;
    readonly blobWritten: boolean;
  }> = [];
  for (const item of loadedEntries) {
    const freshId = randomUUID();
    const restored = composerAttachmentFromFile({
      id: freshId,
      name: item.meta.name,
      mimeType: item.meta.mimeType,
      sizeBytes: item.meta.sizeBytes,
      file: item.file,
      ...(item.legacyDataUrl !== undefined ? { previewUrl: item.legacyDataUrl } : {}),
    });
    const blobWritten = await putAttachmentBlob(draftAttachmentBlobKey(freshId), item.blob);
    prepared.push({
      restored,
      meta: item.meta,
      ...(item.legacyDataUrl !== undefined ? { legacyDataUrl: item.legacyDataUrl } : {}),
      blobWritten,
    });
  }

  const cleanupPrepared = (items: ReadonlyArray<(typeof prepared)[number]>) => {
    const keys: string[] = [];
    for (const item of items) {
      if (item.restored.previewUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(item.restored.previewUrl);
      }
      if (item.blobWritten) {
        keys.push(draftAttachmentBlobKey(item.restored.id));
      }
    }
    if (keys.length > 0) {
      void deleteAttachmentBlobs(keys);
    }
  };

  // Re-check that the entry is still present and compute live capacity
  // synchronously right at insertion so concurrent file adds while awaiting
  // IndexedDB cannot exceed the 8-attachment limit.
  const entryStillPresent = usePromptStashStore
    .getState()
    .entries.some((candidate) => candidate.id === liveEntry.id);
  if (!entryStillPresent) {
    cleanupPrepared(prepared);
    return;
  }

  const currentDraft = useComposerDraftStore.getState().getComposerDraft(restoreTarget);
  const existingAttachments = currentDraft?.attachments ?? [];
  const existingDedupKeys = new Set(
    existingAttachments.map((attachment) => composerAttachmentDedupKey(attachment)),
  );
  const capacity = Math.max(
    0,
    PROVIDER_SEND_TURN_MAX_ATTACHMENTS - composerDraftAttachmentCount(currentDraft),
  );
  const uniquePrepared: Array<(typeof prepared)[number]> = [];
  const duplicatePrepared: Array<(typeof prepared)[number]> = [];
  for (const item of prepared) {
    const dedupKey = composerAttachmentDedupKey(item.meta);
    if (existingDedupKeys.has(dedupKey)) {
      duplicatePrepared.push(item);
    } else {
      existingDedupKeys.add(dedupKey);
      uniquePrepared.push(item);
    }
  }
  const accepted = uniquePrepared.slice(0, capacity);
  const overflow = uniquePrepared.slice(capacity);
  const unrestoredAttachmentNames = overflow.map((item) => item.meta.name);
  cleanupPrepared([...duplicatePrepared, ...overflow]);

  const stillOnTarget = ctx.getActiveDraftTargetKey() === restoreTargetKey;
  const currentPrompt = stillOnTarget
    ? ctx.getLivePrompt()
    : (useComposerDraftStore.getState().getComposerDraft(restoreTarget)?.prompt ?? "");
  // An attachment-only or chip-only stash must not append blank lines to
  // whatever is already in the composer.
  const nextPrompt =
    liveEntry.prompt.length === 0
      ? currentPrompt
      : currentPrompt.trim().length
        ? `${currentPrompt.replace(/\s+$/, "")}\n\n${liveEntry.prompt}`
        : liveEntry.prompt;
  const promptChanged = nextPrompt !== currentPrompt;
  if (promptChanged) {
    if (stillOnTarget) {
      ctx.applyPromptOnActiveTarget(
        nextPrompt,
        collapseExpandedComposerCursor(nextPrompt, nextPrompt.length),
      );
    } else {
      draftStore.setPrompt(restoreTarget, nextPrompt);
    }
  }

  const restoredAttachments = accepted.map((item) => item.restored);
  if (restoredAttachments.length > 0) {
    draftStore.addAttachments(restoreTarget, restoredAttachments);
  }

  // Chips go back through the store's own add paths, so each one is
  // re-stamped for this thread and deduped against what is already there.
  const chips = stashEntryContextDrafts(liveEntry);
  if (chips.terminalContexts.length > 0) {
    draftStore.addTerminalContexts(restoreTarget, chips.terminalContexts);
  }
  if (chips.transcriptHighlightContexts.length > 0) {
    draftStore.addTranscriptHighlightContexts(restoreTarget, chips.transcriptHighlightContexts);
  }
  for (const context of chips.fileSelectionContexts) {
    draftStore.addFileSelectionContext(restoreTarget, context);
  }
  if (chips.pickedElementContexts.length > 0) {
    const existingPicked =
      useComposerDraftStore.getState().getComposerDraft(restoreTarget)?.pickedElementContexts ?? [];
    const existingKeys = new Set(
      existingPicked.map((context) => pickedElementContextDedupKey(context)),
    );
    const additions = chips.pickedElementContexts.filter((context) => {
      const key = pickedElementContextDedupKey(context);
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });
    if (additions.length > 0) {
      if (stillOnTarget) {
        ctx.commitPickedElementsOnActiveTarget([...existingPicked, ...additions]);
      } else {
        draftStore.setPickedElementContexts(restoreTarget, [...existingPicked, ...additions]);
      }
    }
  }

  // Persist destination draft metadata BEFORE consuming the stash entry so a
  // reload between steps never loses the only durable copy. When a legacy
  // inline stash could not be written to IndexedDB, keep its inline dataUrl on
  // the restored draft as a working fallback.
  let lostLegacyDurability = false;
  if (accepted.length > 0) {
    const latestDraft = useComposerDraftStore.getState().getComposerDraft(restoreTarget);
    const existingPersisted = latestDraft?.persistedAttachments ?? [];
    const existingPersistedIds = new Set(existingPersisted.map((item) => item.id));
    const nextPersisted: PersistedComposerAttachment[] = [...existingPersisted];
    for (const item of accepted) {
      if (existingPersistedIds.has(item.restored.id)) continue;
      if (item.blobWritten) {
        nextPersisted.push({
          id: item.restored.id,
          name: item.restored.name,
          mimeType: item.restored.mimeType,
          sizeBytes: item.restored.sizeBytes,
        });
      } else if (item.legacyDataUrl !== undefined) {
        nextPersisted.push({
          id: item.restored.id,
          name: item.restored.name,
          mimeType: item.restored.mimeType,
          sizeBytes: item.restored.sizeBytes,
          dataUrl: item.legacyDataUrl,
        });
      }
    }
    await useComposerDraftStore.getState().syncPersistedAttachments(restoreTarget, nextPersisted);
    const afterDraft = useComposerDraftStore.getState().getComposerDraft(restoreTarget);
    const afterUnsaved = new Set(afterDraft?.nonPersistedAttachmentIds ?? []);
    const failedDraftBlobKeys = accepted
      .filter((item) => item.blobWritten && afterUnsaved.has(item.restored.id))
      .map((item) => draftAttachmentBlobKey(item.restored.id));
    if (failedDraftBlobKeys.length > 0) {
      void deleteAttachmentBlobs(failedDraftBlobKeys);
    }
    lostLegacyDurability = accepted.some(
      (item) =>
        !item.blobWritten && item.legacyDataUrl !== undefined && afterUnsaved.has(item.restored.id),
    );
  }

  let taken: PromptStashEntry = liveEntry;
  if (lostLegacyDurability) {
    toastManager.add({
      type: "warning",
      title: "Stashed copy kept as backup",
      description:
        "Browser storage could not save the restored attachments to this draft, so the stashed entry was kept.",
      data: { hideCopyButton: true },
    });
  } else {
    const takeResult = stashStore.takeEntry(entry.id);
    if (takeResult.entry) {
      taken = takeResult.entry;
    }
    if (!takeResult.durable) {
      toastManager.add({
        type: "warning",
        title: "Restored prompt may reappear in the stash",
        description:
          "Browser storage rejected the update, so this entry could still be there after a reload.",
        data: { hideCopyButton: true },
      });
    } else if (takeResult.entry) {
      void deleteStashEntryBlobs(takeResult.entry);
    }
  }

  const missingReasons: string[] = [];
  if (taken.droppedAttachmentNames.length > 0) {
    missingReasons.push(
      `${taken.droppedAttachmentNames.join(", ")} exceeded the stash size limit when this prompt was saved.`,
    );
  }
  if (taken.unreadableAttachmentNames && taken.unreadableAttachmentNames.length > 0) {
    missingReasons.push(
      `${taken.unreadableAttachmentNames.join(", ")} could not be read when this prompt was saved.`,
    );
  }
  if (missingBlobNames.length > 0) {
    missingReasons.push(`${missingBlobNames.join(", ")} could not be loaded from browser storage.`);
  }
  if (unrestoredAttachmentNames.length > 0) {
    missingReasons.push(
      `${unrestoredAttachmentNames.join(", ")} could not be restored: the composer is at its ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}-attachment limit.`,
    );
  }
  if (missingReasons.length > 0) {
    toastManager.add({
      type: "warning",
      title: "Some attachments were not restored",
      description: missingReasons.join(" "),
    });
  }

  if (promptChanged && ctx.getActiveDraftTargetKey() === restoreTargetKey) {
    ctx.focusAfterWrite(nextPrompt, "end");
  }
}

export interface StashCurrentPromptContext {
  readonly stashTarget: ComposerThreadTarget;
  readonly getActiveDraftTargetKey: () => string;
  readonly getLivePrompt: () => string;
  readonly isAddMenuOpen: boolean;
  readonly closeAddMenu: () => void;
  readonly openStashList: () => void;
  readonly clearPromptUiOnActiveTarget: (capturedRawPrompt: string) => void;
}

export async function runStashCurrentPrompt(ctx: StashCurrentPromptContext): Promise<void> {
  const { stashTarget } = ctx;
  const stashTargetKey =
    typeof stashTarget === "string" ? stashTarget : scopedThreadKey(stashTarget);

  const initialDraft = useComposerDraftStore.getState().getComposerDraft(stashTarget);
  if (
    initialDraft &&
    (initialDraft.hydratingAttachmentIds.length > 0 ||
      initialDraft.failedHydrationAttachmentIds.length > 0)
  ) {
    await ensureDraftAttachmentsHydrated(stashTarget, { retryFailed: true });
  }
  const freshDraft = useComposerDraftStore.getState().getComposerDraft(stashTarget);
  if (freshDraft && freshDraft.failedHydrationAttachmentIds.length > 0) {
    toastManager.add({
      type: "error",
      title: "Couldn't load attached files",
      description:
        "Browser storage could not load one or more attached files. Remove or re-attach them before stashing.",
      data: { hideCopyButton: true },
    });
    return;
  }

  const capturedRawPrompt =
    freshDraft?.prompt ??
    (ctx.getActiveDraftTargetKey() === stashTargetKey ? ctx.getLivePrompt() : "");
  const stashedPrompt = capturedRawPrompt.trim();
  const attachments = [...(freshDraft?.attachments ?? [])];
  const capturedTerminalContexts = [...(freshDraft?.terminalContexts ?? [])];
  const capturedHighlightContexts = [...(freshDraft?.transcriptHighlightContexts ?? [])];
  const capturedFileSelectionContexts = [...(freshDraft?.fileSelectionContexts ?? [])];
  const capturedPickedElementContexts = [...(freshDraft?.pickedElementContexts ?? [])];
  const contexts = buildStashEntryContexts({
    terminalContexts: capturedTerminalContexts,
    transcriptHighlightContexts: capturedHighlightContexts,
    fileSelectionContexts: capturedFileSelectionContexts,
    pickedElementContexts: capturedPickedElementContexts,
  });
  const hasChips = Object.keys(contexts).length > 0;
  if (stashedPrompt.length === 0 && attachments.length === 0 && !hasChips) {
    if (ctx.isAddMenuOpen) {
      ctx.closeAddMenu();
    } else {
      ctx.openStashList();
    }
    return;
  }

  const unsavedDraftAttachmentIds = new Set(freshDraft?.nonPersistedAttachmentIds ?? []);
  const durableDraftAttachmentIds = new Set(
    (freshDraft?.persistedAttachments ?? [])
      .filter((attachment) => !unsavedDraftAttachmentIds.has(attachment.id))
      .map((attachment) => attachment.id),
  );
  const stashLocalStorageDurable = isPromptStashStorageDurable();

  const entryId = randomUUID();
  const persistedAttachments: PersistedComposerAttachment[] = [];
  const unreadableNames: string[] = [];
  const writtenBlobKeys: string[] = [];
  let allBlobsDurable = true;

  // Write stash blobs to IndexedDB before committing the entry and clearing
  // the composer so a reload mid-stash can never lose the only durable copy.
  for (const attachment of attachments) {
    const wasDurablySavedInDraft =
      stashLocalStorageDurable && durableDraftAttachmentIds.has(attachment.id);
    let blob: Blob;
    try {
      const bytes = await attachment.file.arrayBuffer();
      blob = new Blob([bytes], {
        type: attachment.mimeType || attachment.file.type || "application/octet-stream",
      });
    } catch {
      if (wasDurablySavedInDraft) {
        if (writtenBlobKeys.length > 0) {
          void deleteAttachmentBlobs(writtenBlobKeys);
        }
        toastManager.add(
          failureNotice({
            title: "Couldn't stash this prompt",
            reason: "An attached file could not be read, so the composer was left as-is.",
            data: { hideCopyButton: true },
          }),
        );
        return;
      }
      unreadableNames.push(attachment.name);
      continue;
    }
    const blobKey = stashAttachmentBlobKey(entryId, attachment.id);
    const blobDurable = await putAttachmentBlob(blobKey, blob, {
      memoryFallbackOnFailure: !wasDurablySavedInDraft,
    });
    if (!blobDurable) {
      if (wasDurablySavedInDraft) {
        // Never downgrade an already-saved draft attachment into a memory-only
        // stash copy and then delete the durable draft blob.
        if (writtenBlobKeys.length > 0) {
          void deleteAttachmentBlobs(writtenBlobKeys);
        }
        toastManager.add(
          failureNotice({
            title: "Couldn't stash this prompt",
            reason:
              "Browser storage rejected saving its attachments, so the composer was left as-is.",
            data: { hideCopyButton: true },
          }),
        );
        return;
      }
      allBlobsDurable = false;
    }
    writtenBlobKeys.push(blobKey);
    persistedAttachments.push({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    });
  }

  const { evicted, written, durable } = usePromptStashStore.getState().stashEntry({
    id: entryId,
    createdAt: new Date().toISOString(),
    prompt: stashedPrompt,
    attachments: persistedAttachments,
    droppedAttachmentNames: [],
    unreadableAttachmentNames: unreadableNames,
    pendingAttachmentCount: 0,
    ...contexts,
  });

  if (!written) {
    if (writtenBlobKeys.length > 0) {
      void deleteAttachmentBlobs(writtenBlobKeys);
    }
    toastManager.add(
      failureNotice({
        title: "Couldn't stash this prompt",
        reason:
          "Browser storage rejected the write, so the composer was left as-is. Free up site data and try again.",
        data: { hideCopyButton: true },
      }),
    );
    return;
  }

  // Clear only the content that was captured so edits typed or files attached
  // during the async blob writes stay intact. Drawings stay put.
  if (ctx.getActiveDraftTargetKey() === stashTargetKey) {
    ctx.clearPromptUiOnActiveTarget(capturedRawPrompt);
  }
  useComposerDraftStore.getState().clearStashableComposerContent(stashTarget, {
    prompt: capturedRawPrompt,
    attachmentIds: attachments.map((attachment) => attachment.id),
    terminalContextIds: capturedTerminalContexts.map((context) => context.id),
    transcriptHighlightContextIds: capturedHighlightContexts.map((context) => context.id),
    fileSelectionContextIds: capturedFileSelectionContexts.map((context) => context.id),
    pickedElementContextIds: capturedPickedElementContexts.map((context) => context.id),
  });

  if (evicted) {
    void deleteStashEntryBlobs(evicted);
    toastManager.add({
      type: "warning",
      title: "Oldest stashed prompt discarded",
      description: `The stash holds ${MAX_STASH_ENTRIES} prompts; the oldest was removed to make room.`,
      data: { hideCopyButton: true },
    });
  }

  if (!durable) {
    toastManager.add({
      type: "warning",
      title: "Stashed prompt won't survive a reload",
      description:
        "Browser storage is unavailable, so this stash is kept only until you close this page.",
      data: { hideCopyButton: true },
    });
  } else if (!allBlobsDurable && persistedAttachments.length > 0) {
    toastManager.add({
      type: "warning",
      title: "Stashed attachments weren't saved",
      description:
        "The prompt was stashed, but browser storage rejected its attachments. They will be missing if you reload.",
      data: { hideCopyButton: true },
    });
  }
}
