/**
 * Lazily loaded IndexedDB hydration, legacy `dataUrl` migration, and startup
 * orphan cleanup for composer drafts and stashed prompts. Kept outside the
 * startup bundle until a draft or stash actually needs blob I/O.
 */
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  LEGACY_COMPOSER_DRAFT_STORAGE_KEYS,
  collectDraftAttachmentBlobKeys,
  readComposerDraftRawStorageItem,
  useComposerDraftStore,
  type ComposerAttachment,
  type ComposerThreadDraftState,
  type PersistedComposerAttachment,
} from "../composerDraftStore";
import type { PromptStashEntry } from "../promptStashStore";
import {
  deleteAttachmentBlobs,
  draftAttachmentBlobKey,
  putAttachmentBlob,
  readAttachmentBlob,
  stashAttachmentBlobKey,
  sweepOrphanedAttachmentBlobs,
} from "./attachmentBlobStore";

export interface DraftHydrationContext {
  readonly storageKey: string;
  readonly storageVersion: number;
  readonly getRawStorageItem: (key: string) => string | null | Promise<string | null>;
  readonly setRawStorageItem: (key: string, value: string) => unknown;
  readonly retireLegacyKeys: () => void;
  readonly getDrafts: () => Record<string, ComposerThreadDraftState>;
  readonly partializeCurrentState: () => unknown;
  readonly normalizePersistedAttachment: (value: unknown) => PersistedComposerAttachment | null;
  readonly composerAttachmentFromFile: (input: {
    readonly id: string;
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly file: File;
  }) => ComposerAttachment;
  readonly hydratePersistedComposerAttachment: (
    attachment: PersistedComposerAttachment,
  ) => File | null;
  readonly revokePreviewUrl: (previewUrl: string | undefined) => void;
  readonly shouldRemoveDraft: (draft: ComposerThreadDraftState) => boolean;
  readonly updateDraftsInternally: (
    updater: (
      draftsByThreadKey: Record<string, ComposerThreadDraftState>,
    ) => Record<string, ComposerThreadDraftState> | null,
  ) => void;
}

function patchStoredDraftAttachmentsInStorage(
  ctx: DraftHydrationContext,
  transform: (
    threadKey: string,
    attachments: ReadonlyArray<PersistedComposerAttachment>,
  ) => PersistedComposerAttachment[] | null,
): boolean {
  try {
    const raw = ctx.getRawStorageItem(ctx.storageKey);
    if (typeof raw !== "string") {
      const serialized = JSON.stringify({
        state: ctx.partializeCurrentState(),
        version: ctx.storageVersion,
      });
      ctx.setRawStorageItem(ctx.storageKey, serialized);
      ctx.retireLegacyKeys();
      return true;
    }
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      state?: { draftsByThreadKey?: Record<string, Record<string, unknown>> };
    };
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== ctx.storageVersion ||
      !parsed.state ||
      typeof parsed.state !== "object" ||
      !parsed.state.draftsByThreadKey ||
      typeof parsed.state.draftsByThreadKey !== "object"
    ) {
      return false;
    }
    let changed = false;
    for (const [threadKey, draftRecord] of Object.entries(parsed.state.draftsByThreadKey)) {
      if (
        !draftRecord ||
        typeof draftRecord !== "object" ||
        !Array.isArray(draftRecord.attachments)
      ) {
        continue;
      }
      const normalized = draftRecord.attachments.flatMap((entry) => {
        const item = ctx.normalizePersistedAttachment(entry);
        return item ? [item] : [];
      });
      const updated = transform(threadKey, normalized);
      if (updated !== null) {
        draftRecord.attachments = updated;
        changed = true;
      }
    }
    if (!changed) {
      return false;
    }
    ctx.setRawStorageItem(ctx.storageKey, JSON.stringify(parsed));
    ctx.retireLegacyKeys();
    return true;
  } catch {
    return false;
  }
}

export async function runHydrateDraftAttachments(
  ctx: DraftHydrationContext,
  threadKey: string,
  options?: { readonly retryFailed?: boolean },
): Promise<void> {
  const initialDraft = ctx.getDrafts()[threadKey];
  if (!initialDraft) return;
  const idsToLoad = [
    ...initialDraft.hydratingAttachmentIds,
    ...(options?.retryFailed ? initialDraft.failedHydrationAttachmentIds : []),
  ];
  if (idsToLoad.length === 0) return;

  const uniqueIds = [...new Set(idsToLoad)];
  const metaById = new Map(
    initialDraft.persistedAttachments.map((attachment) => [attachment.id, attachment]),
  );

  const loadedById = new Map<string, ComposerAttachment>();
  const notFoundIds = new Set<string>();
  const errorIds = new Set<string>();
  const processedIds = new Set<string>(uniqueIds);

  await Promise.all(
    uniqueIds.map(async (id) => {
      const meta = metaById.get(id);
      if (!meta) return;
      const result = await readAttachmentBlob(draftAttachmentBlobKey(id));
      if (result.status === "ok") {
        const file = new File([result.blob], meta.name, { type: meta.mimeType });
        loadedById.set(
          id,
          ctx.composerAttachmentFromFile({
            id: meta.id,
            name: meta.name,
            mimeType: meta.mimeType,
            sizeBytes: meta.sizeBytes,
            file,
          }),
        );
        return;
      }
      if (result.status === "not-found") {
        notFoundIds.add(id);
        return;
      }
      errorIds.add(id);
    }),
  );

  const confirmedMissingIds = new Set<string>();
  ctx.updateDraftsInternally((draftsByThreadKey) => {
    const current = draftsByThreadKey[threadKey];
    if (!current) {
      for (const attachment of loadedById.values()) {
        ctx.revokePreviewUrl(attachment.previewUrl);
      }
      return null;
    }
    const expectedIds = new Set<string>([
      ...current.hydratingAttachmentIds,
      ...(options?.retryFailed ? current.failedHydrationAttachmentIds : []),
    ]);
    const existingAttachmentIds = new Set(current.attachments.map((attachment) => attachment.id));
    for (const [id, attachment] of loadedById) {
      if (!expectedIds.has(id) || existingAttachmentIds.has(id)) {
        ctx.revokePreviewUrl(attachment.previewUrl);
        loadedById.delete(id);
      }
    }
    for (const id of notFoundIds) {
      if (expectedIds.has(id) && !existingAttachmentIds.has(id)) {
        confirmedMissingIds.add(id);
      }
    }
    const confirmedErrorIds = new Set<string>();
    for (const id of errorIds) {
      if (expectedIds.has(id) && !existingAttachmentIds.has(id)) {
        confirmedErrorIds.add(id);
      }
    }

    const byId = new Map<string, ComposerAttachment>();
    for (const attachment of current.attachments) byId.set(attachment.id, attachment);
    for (const [id, attachment] of loadedById) byId.set(id, attachment);
    const orderedAttachments: ComposerAttachment[] = [];
    const placed = new Set<string>();
    for (const persisted of current.persistedAttachments) {
      const item = byId.get(persisted.id);
      if (item && !placed.has(item.id)) {
        orderedAttachments.push(item);
        placed.add(item.id);
      }
    }
    for (const attachment of current.attachments) {
      if (!placed.has(attachment.id)) {
        orderedAttachments.push(attachment);
        placed.add(attachment.id);
      }
    }

    const nextHydratingIds = current.hydratingAttachmentIds.filter((id) => !processedIds.has(id));
    const nextFailedIds = [
      ...new Set([
        ...current.failedHydrationAttachmentIds.filter((id) => !processedIds.has(id)),
        ...confirmedErrorIds,
      ]),
    ];
    const nextPersistedAttachments =
      confirmedMissingIds.size > 0
        ? current.persistedAttachments.filter(
            (attachment) => !confirmedMissingIds.has(attachment.id),
          )
        : current.persistedAttachments;

    const nextDraft: ComposerThreadDraftState = {
      ...current,
      attachments: orderedAttachments,
      persistedAttachments: nextPersistedAttachments,
      hydratingAttachmentIds: nextHydratingIds,
      failedHydrationAttachmentIds: nextFailedIds,
    };
    const nextDraftsByThreadKey = { ...draftsByThreadKey };
    if (ctx.shouldRemoveDraft(nextDraft)) {
      delete nextDraftsByThreadKey[threadKey];
    } else {
      nextDraftsByThreadKey[threadKey] = nextDraft;
    }
    return nextDraftsByThreadKey;
  });

  if (confirmedMissingIds.size > 0) {
    patchStoredDraftAttachmentsInStorage(ctx, (storedThreadKey, attachments) => {
      if (storedThreadKey !== threadKey) return null;
      const filtered = attachments.filter((attachment) => !confirmedMissingIds.has(attachment.id));
      return filtered.length === attachments.length ? null : filtered;
    });
  }
}

export async function runMigrateLegacyDraftAttachments(ctx: DraftHydrationContext): Promise<void> {
  const drafts = ctx.getDrafts();
  const migratedIdsByThreadKey = new Map<string, Set<string>>();

  for (const [threadKey, draft] of Object.entries(drafts)) {
    const legacy = draft.persistedAttachments.filter(
      (attachment) => typeof attachment.dataUrl === "string",
    );
    if (legacy.length === 0) continue;
    const liveById = new Map(draft.attachments.map((attachment) => [attachment.id, attachment]));
    for (const attachment of legacy) {
      const file =
        liveById.get(attachment.id)?.file ?? ctx.hydratePersistedComposerAttachment(attachment);
      if (!file) continue;
      let blob: Blob;
      try {
        const bytes = await file.arrayBuffer();
        blob = new Blob([bytes], {
          type: attachment.mimeType || file.type || "application/octet-stream",
        });
      } catch {
        continue;
      }
      const written = await putAttachmentBlob(draftAttachmentBlobKey(attachment.id), blob);
      if (!written) continue;

      const currentDraft = ctx.getDrafts()[threadKey];
      const stillReferenced =
        currentDraft?.attachments.some((item) => item.id === attachment.id) ||
        currentDraft?.persistedAttachments.some((item) => item.id === attachment.id);
      if (!stillReferenced) {
        void deleteAttachmentBlobs([draftAttachmentBlobKey(attachment.id)]);
        continue;
      }

      let migratedSet = migratedIdsByThreadKey.get(threadKey);
      if (!migratedSet) {
        migratedSet = new Set<string>();
        migratedIdsByThreadKey.set(threadKey, migratedSet);
      }
      migratedSet.add(attachment.id);
    }
  }

  if (migratedIdsByThreadKey.size === 0) return;

  ctx.updateDraftsInternally((draftsByThreadKey) => {
    let anyChanged = false;
    const nextDraftsByThreadKey = { ...draftsByThreadKey };
    for (const [threadKey, migratedIds] of migratedIdsByThreadKey) {
      const current = nextDraftsByThreadKey[threadKey];
      if (!current) continue;
      let draftChanged = false;
      const nextPersisted = current.persistedAttachments.map((attachment) => {
        if (attachment.dataUrl === undefined || !migratedIds.has(attachment.id)) {
          return attachment;
        }
        draftChanged = true;
        return {
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        };
      });
      if (draftChanged) {
        nextDraftsByThreadKey[threadKey] = { ...current, persistedAttachments: nextPersisted };
        anyChanged = true;
      }
    }
    return anyChanged ? nextDraftsByThreadKey : null;
  });

  patchStoredDraftAttachmentsInStorage(ctx, (threadKey, attachments) => {
    const migratedIds = migratedIdsByThreadKey.get(threadKey);
    if (!migratedIds) return null;
    let changed = false;
    const next = attachments.map((attachment) => {
      if (attachment.dataUrl === undefined || !migratedIds.has(attachment.id)) {
        return attachment;
      }
      changed = true;
      return {
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      };
    });
    return changed ? next : null;
  });
}

export interface PromptStashMigrationContext {
  readonly getEntries: () => ReadonlyArray<PromptStashEntry>;
  readonly setEntries: (
    updater: (entries: ReadonlyArray<PromptStashEntry>) => ReadonlyArray<PromptStashEntry> | null,
  ) => void;
  readonly readPersistedEntries: () => ReadonlyArray<PromptStashEntry> | null;
  readonly persistEntries: (entries: ReadonlyArray<PromptStashEntry>) => unknown;
  readonly hydratePersistedComposerAttachment: (
    attachment: PersistedComposerAttachment,
  ) => File | null;
  readonly collectLiveStashKeys: () => ReadonlySet<string> | null;
  readonly waitForDraftHydration: () => Promise<void>;
}

export async function runMigrateLegacyPromptStashAttachments(
  ctx: PromptStashMigrationContext,
): Promise<void> {
  const entries = ctx.getEntries();
  const migratedByEntryId = new Map<string, Set<string>>();

  for (const entry of entries) {
    const legacy = entry.attachments.filter((attachment) => typeof attachment.dataUrl === "string");
    if (legacy.length === 0) continue;
    for (const attachment of legacy) {
      const file = ctx.hydratePersistedComposerAttachment(attachment);
      if (!file) continue;
      let blob: Blob;
      try {
        const bytes = await file.arrayBuffer();
        blob = new Blob([bytes], {
          type: attachment.mimeType || file.type || "application/octet-stream",
        });
      } catch {
        continue;
      }
      const key = stashAttachmentBlobKey(entry.id, attachment.id);
      const written = await putAttachmentBlob(key, blob);
      if (!written) continue;

      const stillPresent = ctx
        .getEntries()
        .some(
          (candidate) =>
            candidate.id === entry.id &&
            candidate.attachments.some((item) => item.id === attachment.id),
        );
      if (!stillPresent) {
        void deleteAttachmentBlobs([key]);
        continue;
      }

      let migratedSet = migratedByEntryId.get(entry.id);
      if (!migratedSet) {
        migratedSet = new Set<string>();
        migratedByEntryId.set(entry.id, migratedSet);
      }
      migratedSet.add(attachment.id);
    }
  }

  if (migratedByEntryId.size === 0) return;

  const stripMigrated = (
    list: ReadonlyArray<PromptStashEntry>,
  ): { next: PromptStashEntry[]; changed: boolean } => {
    let changed = false;
    const next = list.map((entry) => {
      const migratedIds = migratedByEntryId.get(entry.id);
      if (!migratedIds) return entry;
      let entryChanged = false;
      const nextAttachments = entry.attachments.map((attachment) => {
        if (attachment.dataUrl === undefined || !migratedIds.has(attachment.id)) {
          return attachment;
        }
        entryChanged = true;
        return {
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        };
      });
      if (!entryChanged) return entry;
      changed = true;
      return { ...entry, attachments: nextAttachments };
    });
    return { next, changed };
  };

  const latestStored = ctx.readPersistedEntries();
  if (latestStored) {
    const { next: nextStored, changed } = stripMigrated(latestStored);
    if (changed) {
      ctx.persistEntries(nextStored);
    }
  }

  ctx.setEntries((current) => {
    const { next, changed } = stripMigrated(current);
    return changed ? next : null;
  });
}

function collectLiveComposerDraftBlobKeys(): ReadonlySet<string> | null {
  const keys = new Set<string>();
  for (const draft of Object.values(useComposerDraftStore.getState().draftsByThreadKey)) {
    for (const key of collectDraftAttachmentBlobKeys(draft)) {
      keys.add(key);
    }
  }
  const storageKeys = [COMPOSER_DRAFT_STORAGE_KEY, ...LEGACY_COMPOSER_DRAFT_STORAGE_KEYS];
  for (const storageKey of storageKeys) {
    let raw: string | null | Promise<string | null>;
    try {
      raw = readComposerDraftRawStorageItem(storageKey);
    } catch {
      return null;
    }
    if (typeof raw !== "string" || raw.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const draftsByThreadKey =
      parsed && typeof parsed === "object"
        ? ((parsed as { state?: { draftsByThreadKey?: unknown; draftsByThreadId?: unknown } }).state
            ?.draftsByThreadKey ??
          (parsed as { state?: { draftsByThreadId?: unknown } }).state?.draftsByThreadId)
        : null;
    if (!draftsByThreadKey || typeof draftsByThreadKey !== "object") continue;
    for (const draft of Object.values(draftsByThreadKey as Record<string, unknown>)) {
      if (!draft || typeof draft !== "object") continue;
      const attachments = (draft as { attachments?: unknown }).attachments;
      if (!Array.isArray(attachments)) continue;
      for (const entry of attachments) {
        const id = entry && typeof entry === "object" ? (entry as { id?: unknown }).id : null;
        if (typeof id === "string" && id.length > 0) {
          keys.add(draftAttachmentBlobKey(id));
        }
      }
    }
  }
  return keys;
}

export async function runPromptStashStartupMaintenance(
  ctx: PromptStashMigrationContext,
): Promise<void> {
  await runMigrateLegacyPromptStashAttachments(ctx);
  await ctx.waitForDraftHydration();
  await sweepOrphanedAttachmentBlobs(() => {
    const draftKeys = collectLiveComposerDraftBlobKeys();
    if (draftKeys === null) return null;
    const stashKeys = ctx.collectLiveStashKeys();
    if (stashKeys === null) return null;
    const combined = new Set<string>(draftKeys);
    for (const key of stashKeys) combined.add(key);
    return combined;
  });
}
