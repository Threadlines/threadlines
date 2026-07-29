import * as Schema from "effect/Schema";
import { create } from "zustand";

import {
  PersistedComposerAttachment,
  PersistedFileSelectionContextDraft,
  PersistedPickedElementContextDraft,
  PersistedTerminalContextDraft,
  PersistedTranscriptHighlightContextDraft,
} from "./composerDraftStore";
import type { FileSelectionContextDraft } from "./lib/fileSelectionContext";
import type { PickedElementContextDraft } from "./lib/pickedElementContext";
import { createMemoryStorage, type StateStorage } from "./lib/storage";
import type { TerminalContextDraft } from "./lib/terminalContext";
import type { TranscriptHighlightContextDraft } from "./lib/transcriptHighlightContext";

export const PROMPT_STASH_STORAGE_KEY = "threadlines:prompt-stash:v1";
const PROMPT_STASH_STORAGE_VERSION = 1;

export const MAX_STASH_ENTRIES = 20;
/**
 * Budget for an entry's serialized attachment payload. localStorage is a
 * ~5MB origin-wide quota shared with the composer draft store, so oversized
 * attachments are dropped (tracked in `droppedAttachmentNames`) rather than
 * persisted.
 *
 * Sized to hold two images at the per-image compression budget
 * (`MAX_STASH_IMAGE_DATA_URL_CHARS`) so a typical before/after screenshot
 * pair survives intact.
 */
export const MAX_STASH_ENTRY_ATTACHMENT_CHARS = 2_700_000;

/**
 * Terminal chips carry their captured text in the stash, unlike the draft
 * store which persists only the selection range. A draft is reopened in the
 * same session against a live terminal, so it can re-read the buffer; a
 * stashed prompt is explicitly meant to be restored later, possibly in
 * another thread, where that terminal may be long gone. Without the snapshot
 * the restored chip would come back already expired.
 */
const StashTerminalContextDraft = Schema.Struct({
  ...PersistedTerminalContextDraft.fields,
  text: Schema.String,
});

/**
 * A stashed prompt carries the composer content that survives a move to
 * another thread: text, attachments, and the context chips the draft store
 * already knows how to persist. Deliberately no provider instance or model
 * selection — the point of stashing is to move a prompt into a different
 * thread or provider, so restoring must never drag the old model choice
 * along. Drawing contexts are excluded for the same reason drafts skip them:
 * a drawing is mostly its image, and one without a picture is a chip that
 * shows nothing.
 */
const StashEntrySchema = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  prompt: Schema.String,
  attachments: Schema.Array(PersistedComposerAttachment),
  /** Names of attachments that exceeded the entry budget and were not saved. */
  droppedAttachmentNames: Schema.Array(Schema.String),
  /**
   * Names of attachments that could not be read or re-encoded at all — a
   * distinct failure from exceeding the size budget, so the restore toast can
   * explain which actually happened. Optional: entries written before this
   * field existed decode without it.
   */
  unreadableAttachmentNames: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * Attachments still being encoded when the entry was written. The entry is
   * persisted before its attachments so a crash mid-encode cannot lose the
   * prompt; this field lets the popover show "N still saving" until
   * `finalizeEntryAttachments` lands, and flags entries orphaned by a reload.
   */
  pendingAttachmentCount: Schema.optionalKey(Schema.Number),
  terminalContexts: Schema.optionalKey(Schema.Array(StashTerminalContextDraft)),
  transcriptHighlightContexts: Schema.optionalKey(
    Schema.Array(PersistedTranscriptHighlightContextDraft),
  ),
  fileSelectionContexts: Schema.optionalKey(Schema.Array(PersistedFileSelectionContextDraft)),
  pickedElementContexts: Schema.optionalKey(Schema.Array(PersistedPickedElementContextDraft)),
});
export type PromptStashEntry = typeof StashEntrySchema.Type;

const PersistedPromptStashState = Schema.Struct({
  entries: Schema.Array(StashEntrySchema),
});

const decodePersistedPromptStashState = Schema.decodeUnknownSync(PersistedPromptStashState);

type StashEntryContexts = Pick<
  PromptStashEntry,
  | "terminalContexts"
  | "transcriptHighlightContexts"
  | "fileSelectionContexts"
  | "pickedElementContexts"
>;

/**
 * Narrows live composer chips to the fields the stash persists, dropping the
 * keys the schema does not declare. Keeping this beside the schema means a
 * new chip field is added in one place, not two.
 *
 * Empty lists are omitted entirely so an entry without chips stays as small
 * on disk as it was before chips existed.
 */
export function buildStashEntryContexts(input: {
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  transcriptHighlightContexts: ReadonlyArray<TranscriptHighlightContextDraft>;
  fileSelectionContexts: ReadonlyArray<FileSelectionContextDraft>;
  pickedElementContexts: ReadonlyArray<PickedElementContextDraft>;
}): StashEntryContexts {
  const contexts: { -readonly [K in keyof StashEntryContexts]: StashEntryContexts[K] } = {};
  if (input.terminalContexts.length > 0) {
    contexts.terminalContexts = input.terminalContexts.map((context) => ({
      id: context.id,
      threadId: context.threadId,
      createdAt: context.createdAt,
      terminalId: context.terminalId,
      terminalLabel: context.terminalLabel,
      lineStart: context.lineStart,
      lineEnd: context.lineEnd,
      text: context.text,
    }));
  }
  if (input.transcriptHighlightContexts.length > 0) {
    contexts.transcriptHighlightContexts = input.transcriptHighlightContexts.map((context) => ({
      id: context.id,
      threadId: context.threadId,
      createdAt: context.createdAt,
      sourceMessageId: context.sourceMessageId,
      sourceRole: context.sourceRole,
      selectedText: context.selectedText,
      note: context.note,
    }));
  }
  if (input.fileSelectionContexts.length > 0) {
    contexts.fileSelectionContexts = input.fileSelectionContexts.map((context) => ({
      id: context.id,
      threadId: context.threadId,
      createdAt: context.createdAt,
      relativePath: context.relativePath,
      startLine: context.startLine,
      endLine: context.endLine,
      selectedText: context.selectedText,
      ...(context.wholeFile === undefined ? {} : { wholeFile: context.wholeFile }),
    }));
  }
  if (input.pickedElementContexts.length > 0) {
    contexts.pickedElementContexts = input.pickedElementContexts.map((context) => ({
      id: context.id,
      threadId: context.threadId,
      createdAt: context.createdAt,
      note: context.note,
      styleChanges: context.styleChanges.map((change) => ({ ...change })),
      tagName: context.tagName,
      role: context.role,
      name: context.name,
      selector: context.selector,
      text: context.text,
      width: context.width,
      height: context.height,
      url: context.url,
    }));
  }
  return contexts;
}

/**
 * Turns an entry's chips back into live composer drafts. The `threadId` on
 * each is left as stashed: every store action that accepts these re-stamps it
 * for the thread being restored into, which is what makes a stash portable
 * across threads in the first place.
 */
export function stashEntryContextDrafts(entry: PromptStashEntry): {
  terminalContexts: TerminalContextDraft[];
  transcriptHighlightContexts: TranscriptHighlightContextDraft[];
  fileSelectionContexts: FileSelectionContextDraft[];
  pickedElementContexts: PickedElementContextDraft[];
} {
  return {
    terminalContexts: (entry.terminalContexts ?? []).map((context) => ({ ...context })),
    transcriptHighlightContexts: (entry.transcriptHighlightContexts ?? []).map((context) => ({
      ...context,
    })),
    fileSelectionContexts: (entry.fileSelectionContexts ?? []).map((context) => ({ ...context })),
    pickedElementContexts: (entry.pickedElementContexts ?? []).map((context) => ({
      ...context,
      styleChanges: context.styleChanges.map((change) => ({ ...change })),
    })),
  };
}

/** Total context chips carried by an entry, for the popover's summary. */
export function stashEntryChipCount(entry: PromptStashEntry): number {
  return (
    (entry.terminalContexts?.length ?? 0) +
    (entry.transcriptHighlightContexts?.length ?? 0) +
    (entry.fileSelectionContexts?.length ?? 0) +
    (entry.pickedElementContexts?.length ?? 0)
  );
}

/**
 * `pendingAttachmentCount` only has meaning within the session that wrote it:
 * the encode loop that would clear it does not survive a reload. Any entry
 * that comes back from storage still pending was orphaned by a closed tab or
 * a crash mid-encode, so the count is settled here — otherwise the entry
 * would be stuck showing "saving" and refuse to restore forever.
 *
 * The attachments are genuinely gone (they were never written), so they are
 * recorded as unreadable to keep the prompt itself restorable.
 */
function clearOrphanedPendingAttachments(
  entries: ReadonlyArray<PromptStashEntry>,
): ReadonlyArray<PromptStashEntry> {
  return entries.map((entry) => {
    if (!entry.pendingAttachmentCount) return entry;
    const lostCount = entry.pendingAttachmentCount;
    return {
      ...entry,
      pendingAttachmentCount: 0,
      unreadableAttachmentNames: [
        ...(entry.unreadableAttachmentNames ?? []),
        ...Array.from(
          { length: lostCount },
          (_, index) => `attachment ${index + 1} (not saved before reload)`,
        ),
      ],
    };
  });
}

/**
 * Splits candidate attachments into a persistable set within the entry
 * budget plus the names of any that had to be dropped. Attachments are
 * admitted in order so the earliest-added ones win.
 */
export function partitionStashAttachments(
  attachments: ReadonlyArray<PersistedComposerAttachment>,
): {
  kept: PersistedComposerAttachment[];
  droppedNames: string[];
} {
  const kept: PersistedComposerAttachment[] = [];
  const droppedNames: string[] = [];
  let usedChars = 0;
  for (const attachment of attachments) {
    if (usedChars + attachment.dataUrl.length > MAX_STASH_ENTRY_ATTACHMENT_CHARS) {
      droppedNames.push(attachment.name);
      continue;
    }
    usedChars += attachment.dataUrl.length;
    kept.push(attachment);
  }
  return { kept, droppedNames };
}

/**
 * Reading the `localStorage` property itself can throw `SecurityError` when
 * storage is blocked by policy or the page is a sandboxed iframe, so the
 * access has to be guarded, not just the get/set calls on it. Otherwise
 * importing this module would crash the app at load.
 *
 * `durable` is false for the in-memory fallback: writes there "succeed" but
 * vanish on reload, and callers clear the composer on the strength of a
 * successful stash, so they must be told the difference.
 */
function resolveBaseStorage(): { storage: StateStorage; durable: boolean } {
  try {
    if (typeof localStorage !== "undefined") {
      return { storage: localStorage, durable: true };
    }
  } catch {
    // Fall through to the in-memory store.
  }
  return { storage: createMemoryStorage(), durable: false };
}

let baseStashStorage: StateStorage;
let storageIsDurable: boolean;
{
  const resolved = resolveBaseStorage();
  baseStashStorage = resolved.storage;
  storageIsDurable = resolved.durable;
}

/**
 * Persists the queue, immediately rather than debounced. Stashing is a
 * deliberate, infrequent keystroke, not a per-character autosave, so there is
 * nothing to coalesce, and the caller clears the composer on the strength of
 * this write landing, which a debounce timer cannot honestly report.
 *
 * Returns whether the write will survive a reload: false on a quota rejection
 * or when only the in-memory fallback is available.
 */
function persistEntries(entries: ReadonlyArray<PromptStashEntry>): {
  /** The write succeeded (possibly only into the in-memory fallback). */
  written: boolean;
  /** The write will survive a reload. */
  durable: boolean;
} {
  try {
    baseStashStorage.setItem(
      PROMPT_STASH_STORAGE_KEY,
      JSON.stringify({
        version: PROMPT_STASH_STORAGE_VERSION,
        state: { entries },
      }),
    );
    return { written: true, durable: storageIsDurable };
  } catch (error) {
    console.error("[PROMPT-STASH] Could not persist stash (storage quota?).", error);
    return { written: false, durable: false };
  }
}

/** Reads the persisted queue, settling stale pending counts. */
function readPersistedEntries(): ReadonlyArray<PromptStashEntry> | null {
  try {
    const raw = baseStashStorage.getItem(PROMPT_STASH_STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0) return null;
    const parsed: unknown = JSON.parse(raw);
    const state = (parsed as { state?: unknown } | null)?.state;
    if (!state) return null;
    return clearOrphanedPendingAttachments(decodePersistedPromptStashState(state).entries);
  } catch {
    return null;
  }
}

interface PromptStashStoreState {
  entries: ReadonlyArray<PromptStashEntry>;
  /**
   * Prepends an entry to the queue, evicting the oldest entry past the cap.
   * Returns the evicted entry (for messaging) if any.
   */
  stashEntry: (entry: PromptStashEntry) => {
    evicted: PromptStashEntry | null;
    /** False when the write failed outright (e.g. quota); nothing was kept. */
    written: boolean;
    /**
     * False when the write will not survive a reload: either it failed, or it
     * landed only in the in-memory fallback because localStorage is blocked.
     */
    durable: boolean;
  };
  /**
   * Removes and returns an entry from the queue (restore + delete).
   * `durable` is false when the removal could not be persisted, meaning a
   * reload would resurrect the entry.
   */
  takeEntry: (entryId: string) => { entry: PromptStashEntry | null; durable: boolean };
  /**
   * Attaches the encoded attachments to an entry written earlier by
   * `stashEntry`, clearing its pending count. Returns attached=false when the
   * entry is gone (restored or deleted while encoding was still running) so
   * the caller can tell the user their files did not make it.
   */
  finalizeEntryAttachments: (
    entryId: string,
    attachments: {
      attachments: ReadonlyArray<PersistedComposerAttachment>;
      droppedAttachmentNames: ReadonlyArray<string>;
      unreadableAttachmentNames: ReadonlyArray<string>;
    },
  ) => { attached: boolean; durable: boolean };
}

export const usePromptStashStore = create<PromptStashStoreState>()((set, get) => ({
  entries: [],
  stashEntry: (entry) => {
    const nextEntries = [entry, ...get().entries];
    const evicted = nextEntries.length > MAX_STASH_ENTRIES ? (nextEntries.pop() ?? null) : null;
    const { written, durable } = persistEntries(nextEntries);
    // A rejected write must not leave the entry visible either: the caller
    // keeps the composer intact on failure, so a stashed copy would
    // duplicate the prompt. Eviction likewise only sticks on success.
    if (!written) {
      return { evicted: null, written: false, durable: false };
    }
    set(() => ({ entries: nextEntries }));
    return { evicted, written: true, durable };
  },
  takeEntry: (entryId) => {
    const entries = get().entries;
    const entry = entries.find((candidate) => candidate.id === entryId) ?? null;
    if (!entry) return { entry: null, durable: true };
    const nextEntries = entries.filter((candidate) => candidate.id !== entryId);
    const { durable } = persistEntries(nextEntries);
    set(() => ({ entries: nextEntries }));
    return { entry, durable };
  },
  finalizeEntryAttachments: (entryId, incoming) => {
    const entries = get().entries;
    const index = entries.findIndex((candidate) => candidate.id === entryId);
    const existing = index === -1 ? undefined : entries[index];
    // Restored or deleted mid-encode: nothing to attach to.
    if (!existing) return { attached: false, durable: true };
    const nextEntries = [...entries];
    nextEntries[index] = {
      ...existing,
      attachments: incoming.attachments,
      droppedAttachmentNames: incoming.droppedAttachmentNames,
      unreadableAttachmentNames: incoming.unreadableAttachmentNames,
      pendingAttachmentCount: 0,
    };
    const { durable } = persistEntries(nextEntries);
    set(() => ({ entries: nextEntries }));
    return { attached: true, durable };
  },
}));

// Hydrate once at startup. Like the app's other persisted stores, tabs are
// last-write-wins: no cross-tab merging or storage-event syncing.
{
  const persisted = readPersistedEntries();
  if (persisted) {
    usePromptStashStore.setState({ entries: persisted });
  }
}

/**
 * Test seam: seeds the persisted payload through the same storage the store
 * reads and rehydrates, without needing a real `localStorage` global.
 * Pass an empty string to clear.
 */
export function writePromptStashStorageForTest(raw: string): void {
  baseStashStorage.setItem(PROMPT_STASH_STORAGE_KEY, raw);
  usePromptStashStore.setState({ entries: readPersistedEntries() ?? [] });
}

/**
 * Test seam: swaps the backing storage so the quota-rejection path (a
 * `setItem` that throws) can be exercised. Pass `null` to restore the
 * environment's own storage.
 */
export function setPromptStashStorageForTest(
  storage: StateStorage | null,
  options?: { durable?: boolean },
): void {
  if (storage === null) {
    const resolved = resolveBaseStorage();
    baseStashStorage = resolved.storage;
    storageIsDurable = resolved.durable;
    return;
  }
  baseStashStorage = storage;
  storageIsDurable = options?.durable ?? true;
}
