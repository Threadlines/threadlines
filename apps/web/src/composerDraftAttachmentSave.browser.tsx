import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { saveComposerDraftAttachments } from "./composerDraftAttachmentSave";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  type ComposerAttachment,
  ensureDraftAttachmentsHydrated,
  hydrateAttachmentsFromPersisted,
  useComposerDraftStore,
  waitForComposerDraftHydration,
} from "./composerDraftStore";
import {
  clearAttachmentBlobsForTest,
  createMemoryAttachmentBlobBackend,
  draftAttachmentBlobKey,
  putAttachmentBlob,
  readAttachmentBlob,
  setAttachmentBlobBackendForTest,
  sweepOrphanedAttachmentBlobs,
} from "./lib/attachmentBlobStore";

const threadRef = scopeThreadRef(EnvironmentId.make("env-save"), ThreadId.make("thread-save"));
const threadKey = scopedThreadKey(threadRef);

function file(id: string, bytes: number, mimeType = "application/zip"): ComposerAttachment {
  const data = new File([new Uint8Array(bytes).fill(id.charCodeAt(0) & 0xff)], `${id}.bin`, {
    type: mimeType,
  });
  return {
    type: "file",
    kind: "other",
    id,
    name: data.name,
    mimeType: data.type,
    sizeBytes: data.size,
    file: data,
  };
}

function imageFile(id: string, bytes: number): ComposerAttachment {
  const data = new File([new Uint8Array(bytes).fill(7)], `${id}.png`, { type: "image/png" });
  return {
    type: "image",
    id,
    name: data.name,
    mimeType: data.type,
    sizeBytes: data.size,
    previewUrl: URL.createObjectURL(data),
    file: data,
  };
}

async function savedEntries(): Promise<
  ReadonlyArray<{ id: string; dataUrl?: string; sizeBytes: number }>
> {
  await new Promise((resolve) => setTimeout(resolve, 400));
  const raw = localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
  const stored = raw
    ? (JSON.parse(raw) as {
        state: {
          draftsByThreadKey: Record<
            string,
            { attachments?: Array<{ id: string; dataUrl?: string; sizeBytes: number }> }
          >;
        };
      })
    : null;
  return stored?.state.draftsByThreadKey[threadKey]?.attachments ?? [];
}

async function savedIds(): Promise<ReadonlyArray<string>> {
  return (await savedEntries()).map((entry) => entry.id);
}

describe("saveComposerDraftAttachments", () => {
  afterEach(async () => {
    setAttachmentBlobBackendForTest(null);
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
    localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
    localStorage.removeItem("t3code:composer-drafts:v1");
    await clearAttachmentBlobsForTest();
  });

  it("saves large multi-MB attachments in IndexedDB without storing base64 in localStorage, and restores them after reload", async () => {
    // Two 4 MB images (8 MB total): would overflow both the old 3.5 MB cap and
    // the ~5 MB origin localStorage quota.
    const first = imageFile("retina-1", 4_000_000);
    const second = imageFile("retina-2", 4_000_000);
    useComposerDraftStore.getState().addAttachments(threadRef, [first, second]);

    expect(await saveComposerDraftAttachments(threadRef)).toBe("saved");
    expect(
      useComposerDraftStore.getState().getComposerDraft(threadRef)?.nonPersistedAttachmentIds,
    ).toEqual([]);

    const entries = await savedEntries();
    expect(entries.map((entry) => entry.id)).toEqual(["retina-1", "retina-2"]);
    expect(entries.every((entry) => entry.dataUrl === undefined)).toBe(true);
    // localStorage only holds lightweight metadata.
    expect((localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? "").length).toBeLessThan(2_000);

    // Simulate a full page reload: clear memory, rehydrate from localStorage + IndexedDB.
    useComposerDraftStore.setState({ draftsByThreadKey: {} });
    await useComposerDraftStore.persist.rehydrate();
    await waitForComposerDraftHydration();

    const restored = useComposerDraftStore.getState().getComposerDraft(threadRef)?.attachments;
    expect(restored?.map((attachment) => [attachment.id, attachment.sizeBytes])).toEqual([
      ["retina-1", 4_000_000],
      ["retina-2", 4_000_000],
    ]);
    expect(restored?.[0]?.type === "image" && restored[0].previewUrl.startsWith("blob:")).toBe(
      true,
    );
  });

  it("marks attachments unsaved when IndexedDB rejects the write, while preserving a working legacy inline copy", async () => {
    const legacy = file("legacy-inline", 16, "text/plain");
    const fresh = file("fresh-file", 1_000);
    const store = useComposerDraftStore.getState();
    store.addAttachments(threadRef, [legacy]);
    await store.syncPersistedAttachments(threadRef, [
      {
        id: legacy.id,
        name: legacy.name,
        mimeType: legacy.mimeType,
        sizeBytes: legacy.sizeBytes,
        dataUrl: `data:text/plain;base64,${btoa("0123456789abcdef")}`,
      },
    ]);

    // Simulate IndexedDB being unavailable or over quota.
    setAttachmentBlobBackendForTest({
      put: async () => false,
      get: async () => ({ status: "error" }),
      deleteMany: async () => {},
      listMeta: async () => null,
    });

    store.addAttachments(threadRef, [fresh]);
    await saveComposerDraftAttachments(threadRef);

    // Legacy inline copy stays intact; only the new file is flagged unsaved.
    const entries = await savedEntries();
    expect(entries.map((entry) => entry.id)).toEqual(["legacy-inline"]);
    expect(entries[0]?.dataUrl).toContain("data:text/plain;base64,");
    expect(
      useComposerDraftStore.getState().getComposerDraft(threadRef)?.nonPersistedAttachmentIds,
    ).toEqual(["fresh-file"]);
  });

  it("migrates legacy inline dataUrl drafts (including t3code legacy key) into IndexedDB and retires the legacy key", async () => {
    const legacyPayload = JSON.stringify({
      version: 6,
      state: {
        draftsByThreadKey: {
          [threadKey]: {
            prompt: "keep my prompt",
            attachments: [
              {
                id: "legacy-shot",
                name: "shot.png",
                mimeType: "image/png",
                sizeBytes: 4,
                dataUrl: `data:image/png;base64,${btoa("PNG!")}`,
              },
            ],
          },
        },
        draftThreadsByThreadKey: {},
        logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      },
    });
    localStorage.setItem("t3code:composer-drafts:v1", legacyPayload);

    useComposerDraftStore.setState({ draftsByThreadKey: {} });
    await useComposerDraftStore.persist.rehydrate();
    await waitForComposerDraftHydration();

    // Primary key now holds compact metadata without dataUrl, and legacy key is retired.
    const entries = await savedEntries();
    expect(entries).toEqual([
      { id: "legacy-shot", name: "shot.png", mimeType: "image/png", sizeBytes: 4 },
    ]);
    expect(localStorage.getItem("t3code:composer-drafts:v1")).toBeNull();
    const blob = await readAttachmentBlob(draftAttachmentBlobKey("legacy-shot"));
    expect(blob.status).toBe("ok");
  });

  it("never lets a stale empty mount snapshot clear IndexedDB attachments that are hydrating", async () => {
    const item = file("hydrated-file", 256);
    useComposerDraftStore.getState().addAttachments(threadRef, [item]);
    await saveComposerDraftAttachments(threadRef);

    // Delay IndexedDB reads so a mount effect fires with attachments: [] mid-hydration.
    let releaseRead: () => void = () => {};
    const readBlocked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const backing = createMemoryAttachmentBlobBackend();
    await backing.put(
      draftAttachmentBlobKey("hydrated-file"),
      new Blob([new Uint8Array(256).fill(1)], { type: "application/zip" }),
      Date.now(),
    );
    setAttachmentBlobBackendForTest({
      ...backing,
      get: async (key) => {
        await readBlocked;
        return backing.get(key);
      },
    });

    useComposerDraftStore.setState({ draftsByThreadKey: {} });
    await useComposerDraftStore.persist.rehydrate();
    // Simulate ChatComposer mounting before IDB finishes: passes stale empty list.
    const mountSave = saveComposerDraftAttachments(threadRef, { attachments: [] });
    releaseRead();

    expect(await mountSave).toBe("stale");
    await waitForComposerDraftHydration();
    expect(await savedIds()).toEqual(["hydrated-file"]);
    expect(
      useComposerDraftStore
        .getState()
        .getComposerDraft(threadRef)
        ?.attachments.map((a) => a.id),
    ).toEqual(["hydrated-file"]);
  });

  it("preserves metadata on transient IndexedDB read errors and recovers on retry, while pruning missing blobs", async () => {
    const kept = file("transient-error", 128);
    const gone = file("truly-missing", 64);
    useComposerDraftStore.getState().addAttachments(threadRef, [kept, gone]);
    await saveComposerDraftAttachments(threadRef);

    let failReads = true;
    const backing = createMemoryAttachmentBlobBackend();
    await backing.put(
      draftAttachmentBlobKey("transient-error"),
      new Blob([new Uint8Array(128).fill(9)], { type: "application/zip" }),
      Date.now(),
    );
    // `truly-missing` is intentionally absent from backing.
    setAttachmentBlobBackendForTest({
      ...backing,
      get: async (key) => {
        if (key === draftAttachmentBlobKey("transient-error") && failReads) {
          return { status: "error" };
        }
        return backing.get(key);
      },
    });

    useComposerDraftStore.setState({ draftsByThreadKey: {} });
    await useComposerDraftStore.persist.rehydrate();
    await waitForComposerDraftHydration();

    const afterFirstHydrate = useComposerDraftStore.getState().getComposerDraft(threadRef);
    // Missing blob metadata was pruned; transient error metadata was preserved.
    expect(afterFirstHydrate?.persistedAttachments.map((a) => a.id)).toEqual(["transient-error"]);
    expect(afterFirstHydrate?.failedHydrationAttachmentIds).toEqual(["transient-error"]);

    // Once IndexedDB recovers, retry loads the preserved attachment.
    failReads = false;
    await ensureDraftAttachmentsHydrated(threadRef, { retryFailed: true });
    const recovered = useComposerDraftStore.getState().getComposerDraft(threadRef);
    expect(recovered?.failedHydrationAttachmentIds).toEqual([]);
    expect(recovered?.attachments.map((a) => a.id)).toEqual(["transient-error"]);
  });

  it("never writes a list older than the draft's own when the draft changed during its reads", async () => {
    let release: () => void = () => {};
    const slow = file("recording", 1_000);
    const realRead = slow.file.arrayBuffer.bind(slow.file);
    Object.defineProperty(slow.file, "arrayBuffer", {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          release = () => void realRead().then(resolve);
        }),
    });
    const store = useComposerDraftStore.getState();
    store.addAttachments(threadRef, [slow]);
    const first = saveComposerDraftAttachments(threadRef);

    // While it reads: the user removes it and pastes another file, which saves.
    store.removeAttachment(threadRef, "recording");
    store.addAttachments(threadRef, [file("pasted", 1_000)]);
    expect(await saveComposerDraftAttachments(threadRef)).toBe("saved");

    release();
    expect(await first).toBe("stale");
    expect(await savedIds()).toEqual(["pasted"]);
    expect(
      useComposerDraftStore.getState().getComposerDraft(threadRef)?.nonPersistedAttachmentIds,
    ).toEqual([]);
    // Stale blob was cleaned up rather than leaked in IndexedDB.
    expect((await readAttachmentBlob(draftAttachmentBlobKey("recording"))).status).toBe(
      "not-found",
    );
  });

  it("reuses an in-flight save when called concurrently for the same attachment list", async () => {
    let reads = 0;
    const item = file("shared", 1_000);
    const realRead = item.file.arrayBuffer.bind(item.file);
    Object.defineProperty(item.file, "arrayBuffer", {
      value: () => {
        reads += 1;
        return realRead();
      },
    });
    useComposerDraftStore.getState().addAttachments(threadRef, [item]);
    const [a, b] = await Promise.all([
      saveComposerDraftAttachments(threadRef),
      saveComposerDraftAttachments(threadRef),
    ]);
    expect([a, b]).toEqual(["saved", "saved"]);
    expect(reads).toBe(1);
    expect(await savedIds()).toEqual(["shared"]);
  });

  it("sweeps only unreferenced IndexedDB blobs past the grace period", async () => {
    const now = Date.now();
    await putAttachmentBlob("draft:old-orphan", new Blob(["old"]), {
      updatedAt: now - 20 * 60_000,
    });
    await putAttachmentBlob("draft:fresh-orphan", new Blob(["fresh"]), { updatedAt: now - 30_000 });
    await putAttachmentBlob("draft:live-item", new Blob(["live"]), {
      updatedAt: now - 20 * 60_000,
    });

    const swept = await sweepOrphanedAttachmentBlobs(() => new Set(["draft:live-item"]), {
      graceMs: 10 * 60_000,
      now,
    });
    expect(swept).toBe(1);
    expect((await readAttachmentBlob("draft:old-orphan")).status).toBe("not-found");
    expect((await readAttachmentBlob("draft:fresh-orphan")).status).toBe("ok");
    expect((await readAttachmentBlob("draft:live-item")).status).toBe("ok");
  });
});

describe("drafts kept across tabs and reloads", () => {
  const otherThread = scopeThreadRef(EnvironmentId.make("env-save"), ThreadId.make("thread-other"));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 500));
  const storedDrafts = () =>
    (
      JSON.parse(localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? "{}") as {
        state?: { draftsByThreadKey?: Record<string, { prompt: string }> };
      }
    ).state?.draftsByThreadKey ?? {};

  afterEach(async () => {
    setAttachmentBlobBackendForTest(null);
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
    localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
    await clearAttachmentBlobsForTest();
  });

  /** Another tab's write: it changes storage and leaves its own writer stamp. */
  function writeFromAnotherTab(edit: (drafts: Record<string, { prompt: string }>) => void) {
    const raw = JSON.parse(localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? "{}") as {
      state: { draftsByThreadKey: Record<string, { prompt: string }> };
    };
    edit(raw.state.draftsByThreadKey);
    localStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify(raw));
    localStorage.setItem(`${COMPOSER_DRAFT_STORAGE_KEY}:writer`, "another-tab:1");
  }

  it("keeps a draft another tab changed when this tab saves a different one", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadRef, "first draft, from this tab");
    store.setPrompt(otherThread, "second draft, from this tab");
    await settle();

    // Another tab edits the first draft and writes every draft it holds. No
    // storage event is needed: this tab sees the other writer's stamp.
    writeFromAnotherTab((drafts) => {
      drafts[scopedThreadKey(threadRef)]!.prompt = "first draft, other tab";
    });

    // This tab still holds its old copy of the first draft, and edits the second.
    store.setPrompt(otherThread, "second draft, edited here");
    await settle();

    const drafts = storedDrafts();
    expect(drafts[scopedThreadKey(threadRef)]?.prompt).toBe("first draft, other tab");
    expect(drafts[scopedThreadKey(otherThread)]?.prompt).toBe("second draft, edited here");
  });

  it("keeps a draft another tab filled when this tab cleans it up as empty", async () => {
    const store = useComposerDraftStore.getState();
    // Empty here: only a mode, which is kept but holds nothing the user wrote.
    store.setRuntimeMode(threadRef, "full-access");
    store.setPrompt(otherThread, "unrelated");
    await settle();

    writeFromAnotherTab((drafts) => {
      drafts[scopedThreadKey(threadRef)]!.prompt = "typed in the other tab";
    });

    // This tab drops the draft it sees as empty (as starting a new thread does).
    useComposerDraftStore.setState((state) => {
      const { [scopedThreadKey(threadRef)]: _dropped, ...rest } = state.draftsByThreadKey;
      return { draftsByThreadKey: rest };
    });
    store.setPrompt(otherThread, "unrelated, edited");
    await settle();

    expect(storedDrafts()[scopedThreadKey(threadRef)]?.prompt).toBe("typed in the other tab");
  });

  it("does not overwrite another tab's newer prompt when background hydration completes", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadRef, "initial prompt");
    store.addAttachments(threadRef, [file("pic", 32)]);
    await saveComposerDraftAttachments(threadRef);
    await settle();

    // Hold hydration so another tab edits the same draft's prompt while we hydrate.
    let releaseRead: () => void = () => {};
    const readHeld = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const backing = createMemoryAttachmentBlobBackend();
    await backing.put(
      draftAttachmentBlobKey("pic"),
      new Blob([new Uint8Array(32)], { type: "application/zip" }),
      Date.now(),
    );
    setAttachmentBlobBackendForTest({
      ...backing,
      get: async (key) => {
        await readHeld;
        return backing.get(key);
      },
    });

    useComposerDraftStore.setState({ draftsByThreadKey: {} });
    await useComposerDraftStore.persist.rehydrate();

    writeFromAnotherTab((drafts) => {
      drafts[threadKey]!.prompt = "newer prompt from other tab";
    });

    releaseRead();
    await waitForComposerDraftHydration();
    // Simulate a mounted composer effect calling saveComposerDraftAttachments
    // right after hydration completes: already-persisted attachments must not
    // mark the draft dirty and overwrite the other tab's newer prompt.
    const hydratedAttachments =
      useComposerDraftStore.getState().getComposerDraft(threadRef)?.attachments ?? [];
    expect(
      await saveComposerDraftAttachments(threadRef, { attachments: hydratedAttachments }),
    ).toBe("saved");
    // Edit a different thread in this tab; the hydrated draft must NOT be marked dirty.
    store.setPrompt(otherThread, "unrelated edit");
    await settle();

    expect(storedDrafts()[threadKey]?.prompt).toBe("newer prompt from other tab");
  });

  it("brings an empty file back after a reload", async () => {
    const store = useComposerDraftStore.getState();
    const empty = file("empty", 0);
    store.addAttachments(threadRef, [empty]);
    await saveComposerDraftAttachments(threadRef);
    await settle();

    // A reload: the draft comes back from storage + IndexedDB.
    useComposerDraftStore.setState({ draftsByThreadKey: {} });
    await useComposerDraftStore.persist.rehydrate();
    await waitForComposerDraftHydration();

    const restored = useComposerDraftStore.getState().getComposerDraft(threadRef)?.attachments;
    expect(restored?.map((attachment) => [attachment.id, attachment.sizeBytes])).toEqual([
      ["empty", 0],
    ]);
    // A broken legacy record of size 0 is still not a file.
    expect(
      hydrateAttachmentsFromPersisted([
        { id: "broken", name: "x", mimeType: "text/plain", sizeBytes: 0, dataUrl: "garbage," },
      ]),
    ).toEqual([]);
  });
});
