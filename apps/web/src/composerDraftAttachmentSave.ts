/**
 * Saving a draft's attachments to local storage, for the composer on screen
 * and for code that fills a draft whose composer is not mounted (a device
 * recording that ends after the user left its thread). The prompt and chips
 * save with the store on their own; attachments need their bytes read into
 * data URLs first, which is this.
 */
import {
  type ComposerAttachment,
  composerAttachmentFitsDraftStorage,
  type ComposerThreadTarget,
  type PersistedComposerAttachment,
  useComposerDraftStore,
} from "./composerDraftStore";

/** A file's bytes as a data URL, the way FileReader would give them. */
async function dataUrlOf(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return `data:${file.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

/**
 * Writes the draft's attachments to storage and resolves once the draft
 * says which made it (`nonPersistedAttachmentIds` lists the rest).
 *
 * An attachment already saved stays saved, whatever its size: it keeps the
 * data it was saved with. A new one is tried only if it could ever fit
 * (`composerAttachmentFitsDraftStorage`); a bigger one would only fail the
 * write.
 *
 * Reading files takes a while. If the draft's attachments changed meanwhile
 * (one removed, another pasted), this run's list is old: it writes nothing
 * and answers "stale", since the change that made the newer list saves it.
 * A caller that must know the outcome runs it again.
 */
export async function saveComposerDraftAttachments(
  target: ComposerThreadTarget,
  options: {
    /** The draft's attachments as the caller sees them; read from the draft when left out. */
    readonly attachments?: ReadonlyArray<ComposerAttachment>;
  } = {},
): Promise<"saved" | "stale"> {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(target);
  const attachments = options.attachments ?? draft?.attachments ?? [];
  if (!draft || attachments.length === 0) {
    store.clearPersistedAttachments(target);
    return "saved";
  }
  const listed = attachments.map((attachment) => attachment.id).join("\u0000");
  const unsaved = new Set(draft.nonPersistedAttachmentIds);
  const saved = new Map(
    draft.persistedAttachments
      .filter((attachment) => !unsaved.has(attachment.id))
      .map((attachment) => [attachment.id, attachment]),
  );
  const staged: PersistedComposerAttachment[] = [];
  for (const attachment of attachments) {
    const already = saved.get(attachment.id);
    if (already) {
      staged.push(already);
      continue;
    }
    if (!composerAttachmentFitsDraftStorage(attachment)) continue;
    try {
      staged.push({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        dataUrl: await dataUrlOf(attachment.file),
      });
    } catch {
      // Unreadable now: left unsaved.
    }
  }
  const now = useComposerDraftStore.getState().getComposerDraft(target);
  if ((now?.attachments ?? []).map((attachment) => attachment.id).join("\u0000") !== listed) {
    return "stale";
  }
  await useComposerDraftStore.getState().syncPersistedAttachments(target, staged);
  return "saved";
}
