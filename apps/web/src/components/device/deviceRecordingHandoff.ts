// @effect-diagnostics globalTimers:off - Browser code: a short watch on the draft's save, no Effect runtime.
/**
 * Puts a finished device recording into its thread's draft, unsent
 * (docs/design/devices.md, "Record a flow"): the step log is appended to the
 * prompt and the video and screenshots join the attachments, leaving what is
 * already there alone. Screenshots fill only the slots the draft has free
 * after the video, and none go to a model that takes no images. When the
 * video cannot be attached, or the draft cannot save it, the recording is
 * kept for the Device tab to offer as a download.
 */
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ScopedThreadRef,
} from "@threadlines/contracts";
import { create } from "zustand";

import {
  type ComposerAttachment,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { randomUUID } from "~/lib/utils";
import { composerAcceptsImages } from "../chat/composerImageSupport";
import type { DeviceRecorderResult } from "./deviceRecorder";
import {
  buildDeviceRecording,
  formatDeviceRecordingPrompt,
  formatRecordingDuration,
  limitRecordingFrames,
} from "./deviceRecording.logic";

/** Longest edge of an attached screenshot: legible, and a fraction of the PNG's bytes. */
const FRAME_MAX_EDGE = 1600;
const FRAME_JPEG_QUALITY = 0.85;
/** How long to watch for the draft failing to save the attachments. */
const SAVE_WATCH_MS = 10_000;

export interface DeviceRecordingHandoff {
  readonly steps: number;
  readonly frames: number;
  readonly video: boolean;
}

/** A recording the draft could not hold or save, offered as a download in the Device tab. */
export interface KeptDeviceRecording {
  readonly id: string;
  readonly fileName: string;
  readonly url: string;
  readonly message: string;
}

export const useKeptDeviceRecordings = create<Readonly<Record<string, KeptDeviceRecording>>>(
  () => ({}),
);

/** Keeps a recording's video for download from the thread's Device tab, replacing an older one. */
export function keepDeviceRecording(
  threadKey: string,
  video: Blob,
  fileName: string,
  message: string,
) {
  const previous = useKeptDeviceRecordings.getState()[threadKey];
  if (previous) URL.revokeObjectURL(previous.url);
  useKeptDeviceRecordings.setState({
    [threadKey]: { id: randomUUID(), fileName, url: URL.createObjectURL(video), message },
  });
}

export function dismissKeptDeviceRecording(threadKey: string, id: string) {
  const kept = useKeptDeviceRecordings.getState()[threadKey];
  if (!kept || kept.id !== id) return;
  URL.revokeObjectURL(kept.url);
  const { [threadKey]: _dismissed, ...rest } = useKeptDeviceRecordings.getState();
  useKeptDeviceRecordings.setState(rest, true);
}

/** A screenshot made small enough to attach and keep: JPEG, longest edge capped. */
async function prepareFrame(blob: Blob, name: string): Promise<File | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, FRAME_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const jpeg = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", FRAME_JPEG_QUALITY),
    );
    if (jpeg) return new File([jpeg], `${name}.jpg`, { type: "image/jpeg" });
  } catch {
    // Attach the PNG as it came.
  }
  return blob.size <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
    ? new File([blob], `${name}.png`, { type: "image/png" })
    : null;
}

/** A clock stamp for file names, so two recordings in one draft never share one. */
function stamp(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join("");
}

/**
 * Appends the recording to the thread's draft and says what made it in.
 * Keeps the video for download (see `keepDeviceRecording`) when it could not
 * be attached, or when the draft later fails to save it.
 */
export async function handOffDeviceRecording(input: {
  readonly threadKey: string;
  readonly threadRef: ScopedThreadRef;
  readonly result: DeviceRecorderResult;
  /** Where it was recorded: the device, its OS and the app in front. */
  readonly context: string;
}): Promise<DeviceRecordingHandoff> {
  const { result, threadRef, threadKey } = input;
  const store = useComposerDraftStore.getState();
  const taken = store.getComposerDraft(threadRef)?.attachments.length ?? 0;
  const freeSlots = Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - taken);
  const videoFits = result.video !== null && freeSlots > 0;
  const frameSlots = composerAcceptsImages(threadKey) ? freeSlots - (videoFits ? 1 : 0) : 0;
  const recording = limitRecordingFrames(
    buildDeviceRecording(result.inputs, result.captures),
    Math.max(0, frameSlots),
  );
  const suffix = stamp(new Date());

  const frameIndices = [
    ...(recording.initialFrame === null ? [] : [recording.initialFrame]),
    ...recording.steps.flatMap((step) => (step.frame === null ? [] : [step.frame])),
  ];
  const images = new Map<number, ComposerImageAttachment>();
  for (const [order, index] of frameIndices.entries()) {
    const blob = result.captures[index]?.frame;
    if (!blob) continue;
    const file = await prepareFrame(
      blob,
      `device-screen-${String(order + 1).padStart(2, "0")}-${suffix}`,
    );
    if (!file) continue;
    images.set(index, {
      type: "image",
      id: randomUUID(),
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl: URL.createObjectURL(file),
      file,
    });
  }
  const videoName = `device-recording-${suffix}.${result.video?.mimeType === "video/mp4" ? "mp4" : "webm"}`;
  const video: ComposerFileAttachment | null =
    result.video && videoFits
      ? {
          type: "file",
          kind: "other",
          id: randomUUID(),
          name: videoName,
          mimeType: result.video.mimeType,
          sizeBytes: result.video.blob.size,
          file: new File([result.video.blob], videoName, { type: result.video.mimeType }),
        }
      : null;

  const incoming: ComposerAttachment[] = [...(video ? [video] : []), ...images.values()];
  let accepted = new Set<string>();
  try {
    if (incoming.length > 0) store.addAttachments(threadRef, incoming);
    accepted = new Set(
      (useComposerDraftStore.getState().getComposerDraft(threadRef)?.attachments ?? []).map(
        (attachment) => attachment.id,
      ),
    );
  } catch {
    accepted = new Set();
  }
  for (const image of images.values()) {
    if (!accepted.has(image.id)) URL.revokeObjectURL(image.previewUrl);
  }
  const videoAttached = video !== null && accepted.has(video.id);
  const acceptedImages = [...images.values()].filter((image) => accepted.has(image.id));

  const notes: string[] = [];
  if (videoAttached) notes.push(`Video: ${videoName}`);
  else if (result.video) notes.push("No video: it could not be attached to this message.");
  else if (result.videoMissing) notes.push(`No video: ${result.videoMissing}.`);
  if (result.endedEarly === "time") notes.push("The recording stopped at its 3 minute limit.");
  if (result.endedEarly === "size") {
    notes.push("The recording stopped early: the video reached the 10 MB attachment limit.");
  }
  if (!composerAcceptsImages(threadKey) && result.captures.some((capture) => capture.hasFrame)) {
    notes.push("No screenshots: the selected model takes no images.");
  }
  const text = formatDeviceRecordingPrompt({
    header: [
      `Recorded on ${input.context}, ${formatRecordingDuration(result.durationMs)}.`,
      acceptedImages.length > 0
        ? "Each screenshot shows the screen once input paused after that step."
        : null,
    ]
      .filter(Boolean)
      .join(" "),
    recording,
    frameReference: (frame) => {
      const image = images.get(frame);
      return image && accepted.has(image.id) ? image.name : null;
    },
    notes,
  });
  const draft = useComposerDraftStore.getState();
  const existing = draft.getComposerDraft(threadRef)?.prompt.trimEnd() ?? "";
  draft.setPrompt(threadRef, existing ? `${existing}\n\n${text}` : text);

  if (result.video && !videoAttached) {
    keepDeviceRecording(
      threadKey,
      result.video.blob,
      videoName,
      freeSlots === 0
        ? "The draft has no free attachment slot for the video."
        : "The video could not be added to the draft.",
    );
  } else if (result.video && video && videoAttached) {
    watchDraftSave(threadKey, threadRef, video.id, result.video.blob, videoName);
  }
  return { steps: recording.steps.length, frames: acceptedImages.length, video: videoAttached };
}

/**
 * The draft saves its attachments in local storage; a video is often too big
 * for it, and the composer then marks it unsaved. Offer the download then, so
 * a reload does not lose the only copy.
 */
function watchDraftSave(
  threadKey: string,
  threadRef: ScopedThreadRef,
  videoId: string,
  blob: Blob,
  fileName: string,
) {
  const check = () =>
    useComposerDraftStore
      .getState()
      .getComposerDraft(threadRef)
      ?.nonPersistedAttachmentIds.includes(videoId) === true;
  let done = false;
  const finish = () => {
    done = true;
    unsubscribe();
    clearTimeout(timer);
  };
  const unsubscribe = useComposerDraftStore.subscribe(() => {
    if (done || !check()) return;
    finish();
    keepDeviceRecording(
      threadKey,
      blob,
      fileName,
      "The video is in the draft but too big to keep if the app reloads.",
    );
  });
  const timer = setTimeout(finish, SAVE_WATCH_MS);
}
