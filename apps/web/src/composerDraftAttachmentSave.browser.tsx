import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { saveComposerDraftAttachments } from "./composerDraftAttachmentSave";
import {
  COMPOSER_DRAFT_ATTACHMENT_MAX_SAVED_BYTES,
  COMPOSER_DRAFT_STORAGE_KEY,
  type ComposerAttachment,
  hydrateAttachmentsFromPersisted,
  useComposerDraftStore,
} from "./composerDraftStore";

const threadRef = scopeThreadRef(EnvironmentId.make("env-save"), ThreadId.make("thread-save"));

function file(id: string, bytes: number): ComposerAttachment {
  const data = new File([new Uint8Array(bytes)], `${id}.bin`, { type: "application/zip" });
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

async function savedIds(): Promise<ReadonlyArray<string>> {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const raw = localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
  const stored = raw
    ? (JSON.parse(raw) as {
        state: { draftsByThreadKey: Record<string, { attachments?: Array<{ id: string }> }> };
      })
    : null;
  return (stored?.state.draftsByThreadKey[scopedThreadKey(threadRef)]?.attachments ?? []).map(
    (entry) => entry.id,
  );
}

describe("saveComposerDraftAttachments", () => {
  afterEach(() => {
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
    localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
  });

  it("keeps an attachment saved before, though it is over the size new ones must fit", async () => {
    // 3.6 MB is 4.8 million characters as a data URL: it fit, and was saved
    // before the size rule existed.
    const saved = file("saved-big", 3_600_000);
    expect(saved.sizeBytes).toBeGreaterThan(COMPOSER_DRAFT_ATTACHMENT_MAX_SAVED_BYTES);
    const store = useComposerDraftStore.getState();
    store.addAttachments(threadRef, [saved]);
    const bytes = new Uint8Array(await saved.file.arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    await store.syncPersistedAttachments(threadRef, [
      {
        id: saved.id,
        name: saved.name,
        mimeType: saved.mimeType,
        sizeBytes: saved.sizeBytes,
        dataUrl: `data:${saved.mimeType};base64,${btoa(binary)}`,
      },
    ]);
    expect(await savedIds()).toEqual(["saved-big"]);

    // The composer saving again (a draft opened, another file added) keeps it.
    await saveComposerDraftAttachments(threadRef);
    expect(await savedIds()).toEqual(["saved-big"]);
    expect(
      useComposerDraftStore.getState().getComposerDraft(threadRef)?.nonPersistedAttachmentIds,
    ).toEqual([]);
  });

  it("does not try a new attachment too big to ever fit, and saves the rest", async () => {
    useComposerDraftStore
      .getState()
      .addAttachments(threadRef, [file("small", 1_000), file("huge", 4_000_000)]);
    await saveComposerDraftAttachments(threadRef);
    expect(await savedIds()).toEqual(["small"]);
    expect(
      useComposerDraftStore.getState().getComposerDraft(threadRef)?.nonPersistedAttachmentIds,
    ).toEqual(["huge"]);
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

  afterEach(() => {
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
    localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
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

  it("brings an empty file back after a reload", async () => {
    const store = useComposerDraftStore.getState();
    const empty = file("empty", 0);
    store.addAttachments(threadRef, [empty]);
    await saveComposerDraftAttachments(threadRef);
    await settle();

    // A reload: the draft comes back from storage alone.
    useComposerDraftStore.setState({ draftsByThreadKey: {} });
    await useComposerDraftStore.persist.rehydrate();

    const restored = useComposerDraftStore.getState().getComposerDraft(threadRef)?.attachments;
    expect(restored?.map((attachment) => [attachment.id, attachment.sizeBytes])).toEqual([
      ["empty", 0],
    ]);
    // A broken record of size 0 is still not a file.
    expect(
      hydrateAttachmentsFromPersisted([
        { id: "broken", name: "x", mimeType: "text/plain", sizeBytes: 0, dataUrl: "garbage," },
      ]),
    ).toEqual([]);
  });
});
