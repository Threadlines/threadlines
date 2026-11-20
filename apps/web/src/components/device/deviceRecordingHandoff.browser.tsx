import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { saveComposerDraftAttachments } from "~/composerDraftAttachmentSave";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  type ComposerAttachment,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { publishComposerImageSupport } from "../chat/composerImageSupport";
import type { DeviceRecorderResult } from "./deviceRecorder";
import { handOffDeviceRecording, useKeptDeviceRecordings } from "./deviceRecordingHandoff";

const threadRef = scopeThreadRef(EnvironmentId.make("env-rec"), ThreadId.make("thread-rec"));
const threadKey = scopedThreadKey(threadRef);

const general = {
  id: "general",
  label: "General",
  role: "Button",
  x: 0,
  y: 0.2,
  width: 1,
  height: 0.1,
};

/** A tap on "General", a press of Home, a frame after each, and a video. */
function result(frames: number): DeviceRecorderResult {
  const frame = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  return {
    durationMs: 12_000,
    inputs: [
      { at: 1_000, input: { type: "touch", phase: "begin", x: 0.5, y: 0.25 } },
      { at: 1_080, input: { type: "touch", phase: "end", x: 0.5, y: 0.25 } },
      { at: 3_000, input: { type: "button", button: "home" } },
    ],
    captures: Array.from({ length: frames }, (_, index) => ({
      requestedAt: index * 1_500,
      frame,
      hasFrame: true,
      elements: [general],
    })),
    video: {
      blob: new Blob([new Uint8Array(64)], { type: "video/webm" }),
      mimeType: "video/webm",
      tooBig: false,
    },
    videoMissing: null,
    endedEarly: null,
  };
}

function existingFile(id: string, bytes = 3): ComposerAttachment {
  const file = new File([new Uint8Array(bytes).fill(id.length)], `${id}.txt`, {
    type: "text/plain",
  });
  return {
    type: "file",
    kind: "text",
    id,
    name: file.name,
    mimeType: "text/plain",
    sizeBytes: file.size,
    file,
  };
}

const draft = () => useComposerDraftStore.getState().getComposerDraft(threadRef);

/** The attachment ids local storage holds for the thread's draft, after pending writes land. */
async function savedIds(): Promise<ReadonlyArray<string>> {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const raw = localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
  const stored = raw
    ? (JSON.parse(raw) as {
        state: { draftsByThreadKey: Record<string, { attachments?: Array<{ id: string }> }> };
      })
    : null;
  return (stored?.state.draftsByThreadKey[threadKey]?.attachments ?? []).map((entry) => entry.id);
}

describe("handOffDeviceRecording", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
    useKeptDeviceRecordings.setState({}, true);
    publishComposerImageSupport(threadKey, true);
  });

  afterEach(() => {
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
    localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
  });

  it("appends the step log, video and screenshots to the draft, keeping what was there", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadRef, "Look at this:");
    store.addAttachments(threadRef, [existingFile("notes")]);

    const handoff = await handOffDeviceRecording({
      threadKey,
      threadRef,
      result: result(3),
      context: "iPhone 17e (iOS 27.2)",
    });

    expect(handoff).toEqual({ steps: 2, frames: 3, video: true });
    const after = draft()!;
    expect(after.attachments.map((attachment) => attachment.type)).toEqual([
      "file",
      "file",
      "image",
      "image",
      "image",
    ]);
    expect(after.attachments[0]!.id).toBe("notes");
    expect(
      after.prompt.startsWith("Look at this:\n\nRecorded on iPhone 17e (iOS 27.2), 0:12."),
    ).toBe(true);
    expect(after.prompt).toMatch(/1\. Tapped button "General" → device-screen-02-\d{6}\.png/);
    expect(after.prompt).toMatch(/2\. Pressed Home → device-screen-03-\d{6}\.png/);
    expect(after.prompt).toMatch(/Video: device-recording-\d{6}\.webm/);
    expect(useKeptDeviceRecordings.getState()[threadKey]).toBeUndefined();
  });

  it("fills only the free slots, and takes no screenshots for a model without images", async () => {
    useComposerDraftStore
      .getState()
      .addAttachments(threadRef, ["a", "b", "c", "d", "e", "f"].map(existingFile));
    const handoff = await handOffDeviceRecording({
      threadKey,
      threadRef,
      result: result(3),
      context: "iPhone 17e (iOS 27.2)",
    });
    // Eight slots: six taken, one for the video, one screenshot.
    expect(handoff).toEqual({ steps: 2, frames: 1, video: true });
    expect(draft()!.attachments).toHaveLength(8);

    useComposerDraftStore.setState({ draftsByThreadKey: {} });
    publishComposerImageSupport(threadKey, false);
    const textOnly = await handOffDeviceRecording({
      threadKey,
      threadRef,
      result: result(3),
      context: "Pixel 9",
    });
    expect(textOnly).toEqual({ steps: 2, frames: 0, video: true });
    expect(draft()!.prompt).toContain("No screenshots: the selected model takes no images.");
  });

  it("keeps every video it could not attach for download, and one past the limit too", async () => {
    useComposerDraftStore
      .getState()
      .addAttachments(threadRef, ["a", "b", "c", "d", "e", "f", "g", "h"].map(existingFile));
    const full = await handOffDeviceRecording({
      threadKey,
      threadRef,
      result: result(2),
      context: "iPhone 17e (iOS 27.2)",
    });
    expect(full).toEqual({ steps: 2, frames: 0, video: false });
    expect(draft()!.attachments).toHaveLength(8);
    expect(draft()!.prompt).toContain('1. Tapped button "General"');

    // A second one before the first was downloaded keeps both.
    useComposerDraftStore.setState({ draftsByThreadKey: {} });
    const tooBig = result(0);
    await handOffDeviceRecording({
      threadKey,
      threadRef,
      result: { ...tooBig, video: { ...tooBig.video!, tooBig: true } },
      context: "iPhone 17e (iOS 27.2)",
    });
    expect(draft()!.attachments).toHaveLength(0);
    expect(draft()!.prompt).toContain("No video: it ran past the 10 MB attachment limit.");
    expect(useKeptDeviceRecordings.getState()[threadKey]?.map((kept) => kept.message)).toEqual([
      "No free slot in the draft for the video.",
      "The video ran past the 10 MB attachment limit.",
    ]);
  });

  it("saves what it added though the thread's composer is not on screen", async () => {
    await handOffDeviceRecording({
      threadKey,
      threadRef,
      result: result(2),
      context: "iPhone 17e (iOS 27.2)",
    });
    const attachments = draft()!.attachments.map((attachment) => attachment.id);
    expect(attachments).toHaveLength(3);
    expect(draft()!.nonPersistedAttachmentIds).toEqual([]);
    expect(await savedIds()).toEqual(attachments);
    expect(useKeptDeviceRecordings.getState()[threadKey]).toBeUndefined();
  });

  it("leaves the prompt exactly as it was, ahead of the step log", async () => {
    const prompt = "Look:  \n- a list item\t";
    useComposerDraftStore.getState().setPrompt(threadRef, prompt);
    await handOffDeviceRecording({
      threadKey,
      threadRef,
      result: result(0),
      context: "iPhone 17e (iOS 27.2)",
    });
    expect(draft()!.prompt.startsWith(`${prompt}\n\nRecorded on iPhone 17e`)).toBe(true);
  });

  it("never costs a saved attachment when the recording does not fit in storage", async () => {
    // About 2.7 million characters saved, then a video of 3.3 million: together
    // past the 5.2 million local storage holds.
    useComposerDraftStore.getState().addAttachments(threadRef, [existingFile("saved", 2_000_000)]);
    await saveComposerDraftAttachments(threadRef);
    expect(await savedIds()).toEqual(["saved"]);

    const big = result(0);
    await handOffDeviceRecording({
      threadKey,
      threadRef,
      result: {
        ...big,
        video: {
          ...big.video!,
          blob: new Blob([new Uint8Array(2_500_000)], { type: "video/webm" }),
        },
      },
      context: "iPhone 17e (iOS 27.2)",
    });
    expect(await savedIds()).toEqual(["saved"]);
    expect(draft()!.persistedAttachments.map((attachment) => attachment.id)).toEqual(["saved"]);
    expect(useKeptDeviceRecordings.getState()[threadKey]?.map((kept) => kept.message)).toEqual([
      "The draft cannot keep the video through a reload.",
    ]);
  });
});
