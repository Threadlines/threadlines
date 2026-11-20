import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { saveComposerDraftAttachments } from "./composerDraftAttachmentSave";
import {
  COMPOSER_DRAFT_ATTACHMENT_MAX_SAVED_BYTES,
  COMPOSER_DRAFT_STORAGE_KEY,
  type ComposerAttachment,
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
});
