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
import { saveComposerDraftAttachments } from "~/composerDraftAttachmentSave";
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

const NO_KEPT: ReadonlyArray<KeptDeviceRecording> = [];

/** Videos kept for download, by thread key, oldest first. */
export const useKeptDeviceRecordings = create<
  Readonly<Record<string, ReadonlyArray<KeptDeviceRecording>>>
>(() => ({}));

export function readKeptDeviceRecordings(threadKey: string): ReadonlyArray<KeptDeviceRecording> {
  return useKeptDeviceRecordings.getState()[threadKey] ?? NO_KEPT;
}

/** Keeps a recording's video for download from the thread's Device tab, beside any kept before. */
export function keepDeviceRecording(
  threadKey: string,
  video: Blob,
  fileName: string,
  message: string,
) {
  const kept: KeptDeviceRecording = {
    id: randomUUID(),
    fileName,
    url: URL.createObjectURL(video),
    message,
  };
  useKeptDeviceRecordings.setState((state) => ({
    [threadKey]: [...(state[threadKey] ?? NO_KEPT), kept],
  }));
}

export function dismissKeptDeviceRecording(threadKey: string, id: string) {
  const current = readKeptDeviceRecordings(threadKey);
  const kept = current.find((entry) => entry.id === id);
  if (!kept) return;
  URL.revokeObjectURL(kept.url);
  const rest = current.filter((entry) => entry.id !== id);
  useKeptDeviceRecordings.setState((state) => {
    const { [threadKey]: _dismissed, ...others } = state;
    return rest.length > 0 ? { ...others, [threadKey]: rest } : others;
  }, true);
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
  // A video the last chunks pushed past the limit can only be downloaded.
  const attachable = result.video && !result.video.tooBig ? result.video : null;
  const room = () => {
    const taken =
      useComposerDraftStore.getState().getComposerDraft(threadRef)?.attachments.length ?? 0;
    const free = Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - taken);
    const videoFits = attachable !== null && free > 0;
    const images = composerAcceptsImages(threadKey);
    return {
      free,
      videoFits,
      images,
      frames: images ? Math.max(0, free - (videoFits ? 1 : 0)) : 0,
    };
  };
  const planned = room();
  const built = limitRecordingFrames(
    buildDeviceRecording(result.inputs, result.captures),
    planned.frames,
  );
  const suffix = stamp(new Date());

  const frameIndices = (recording: typeof built) => [
    ...(recording.initialFrame === null ? [] : [recording.initialFrame]),
    ...recording.steps.flatMap((step) => (step.frame === null ? [] : [step.frame])),
  ];
  const images = new Map<number, ComposerImageAttachment>();
  for (const [order, index] of frameIndices(built).entries()) {
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
  // Converting screenshots takes a moment, in which the user may attach a
  // file or pick another model: count the room again before attaching.
  const current = room();
  const recording = limitRecordingFrames(built, current.frames);
  const keptFrames = new Set(frameIndices(recording));
  for (const [index, image] of images) {
    if (keptFrames.has(index)) continue;
    URL.revokeObjectURL(image.previewUrl);
    images.delete(index);
  }
  const videoName = `device-recording-${suffix}.${result.video?.mimeType === "video/mp4" ? "mp4" : "webm"}`;
  const video: ComposerFileAttachment | null =
    attachable && current.videoFits
      ? {
          type: "file",
          kind: "other",
          id: randomUUID(),
          name: videoName,
          mimeType: attachable.mimeType,
          sizeBytes: attachable.blob.size,
          file: new File([attachable.blob], videoName, { type: attachable.mimeType }),
        }
      : null;

  const incoming: ComposerAttachment[] = [...(video ? [video] : []), ...images.values()];
  let accepted = new Set<string>();
  try {
    if (incoming.length > 0) useComposerDraftStore.getState().addAttachments(threadRef, incoming);
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
  else if (result.video?.tooBig) notes.push("No video: it ran past the 10 MB attachment limit.");
  else if (result.video) notes.push("No video: it could not be attached to this message.");
  else if (result.videoMissing) notes.push(`No video: ${result.videoMissing}.`);
  if (result.endedEarly === "time") notes.push("The recording stopped at its 3 minute limit.");
  if (result.endedEarly === "size") {
    notes.push("The recording stopped early: the video reached the 10 MB attachment limit.");
  }
  if (!current.images && result.captures.some((capture) => capture.hasFrame)) {
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
  draft.setPrompt(threadRef, appendToPrompt(draft.getComposerDraft(threadRef)?.prompt ?? "", text));

  if (result.video && !videoAttached) {
    keepDeviceRecording(
      threadKey,
      result.video.blob,
      videoName,
      result.video.tooBig
        ? "The video ran past the 10 MB attachment limit."
        : current.free === 0
          ? "No free slot in the draft for the video."
          : "The video could not join the draft.",
    );
  }
  if (incoming.length > 0) {
    // Saved here, not by the thread's composer, which is not on screen if the
    // user left the thread while recording. Whatever is not saved by then
    // would go with a reload; the video stays downloadable.
    try {
      await saveComposerDraftAttachments(threadRef);
    } catch {
      // Judged below from what the draft says.
    }
    const unsaved = new Set(
      useComposerDraftStore.getState().getComposerDraft(threadRef)?.nonPersistedAttachmentIds ?? [],
    );
    if (video && videoAttached && attachable && unsaved.has(video.id)) {
      keepDeviceRecording(threadKey, attachable.blob, videoName, UNSAVED_VIDEO_MESSAGE);
    }
  }
  return { steps: recording.steps.length, frames: acceptedImages.length, video: videoAttached };
}

const UNSAVED_VIDEO_MESSAGE = "The draft cannot keep the video through a reload.";

/**
 * The prompt with the step log after it, separated by a blank line. What was
 * there stays exactly as it was, trailing spaces and line breaks included.
 */
export function appendToPrompt(existing: string, text: string): string {
  if (existing.length === 0) return text;
  const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${text}`;
}
