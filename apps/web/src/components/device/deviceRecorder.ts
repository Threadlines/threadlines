// @effect-diagnostics globalTimers:off - Browser recording code: settle timers and MediaRecorder, no Effect runtime.
import {
  captureDeviceScreenshot,
  type DeviceAxElement,
  type DeviceHubTransport,
  fetchDeviceAxTree,
} from "@threadlines/client-runtime/device";
import { type DevicePlatform, PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@threadlines/contracts";

import {
  type DeviceInput,
  type DeviceRecordingCapture,
  pickKeyframes,
  type TimedDeviceInput,
} from "./deviceRecording.logic";

/** A recording ends on its own after this long. */
export const DEVICE_RECORDING_MAX_MS = 3 * 60_000;
/** How long input must stay quiet after a step before its screen is taken. */
const SETTLE_MS = 600;
// The stream repaints even when idle, so quiet video cannot say a launch or
// load finished. A second look replaces the first when the user keeps waiting.
const SETTLED_AGAIN_MS = 2_500;
// Bounds memory on long sessions; the handoff picks its frames from these, and
// a draft takes at most 8 attachments anyway.
const MAX_HELD_FRAMES = 16;
const THINNED_FRAMES = 12;
/**
 * The video's byte budget: one attachment, less room for the last chunk the
 * recorder flushes on stop and the container's own bytes.
 */
export const DEVICE_RECORDING_VIDEO_MAX_BYTES = PROVIDER_SEND_TURN_MAX_FILE_BYTES - 1024 * 1024;
/**
 * Chosen so the longest recording fits the budget: 3 minutes at 400 kbit/s is
 * about 9 MB. A busy screen can still run over; then the recording stops early.
 */
export const DEVICE_RECORDING_VIDEO_BITS_PER_SECOND = 400_000;
const VIDEO_FRAME_RATE = 30;
const VIDEO_MIME_TYPES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4",
] as const;

export interface DeviceRecorderCapture extends DeviceRecordingCapture {
  readonly frame: Blob | null;
}

export interface DeviceRecorderVideo {
  readonly blob: Blob;
  readonly mimeType: string;
}

export interface DeviceRecorderResult {
  readonly durationMs: number;
  readonly inputs: ReadonlyArray<TimedDeviceInput>;
  readonly captures: ReadonlyArray<DeviceRecorderCapture>;
  readonly video: DeviceRecorderVideo | null;
  /** Why there is no video, for the step log, when there is none. */
  readonly videoMissing: string | null;
  /** Why the recording ended before the user stopped it, if it did. */
  readonly endedEarly: "time" | "size" | null;
}

export interface DeviceRecorder {
  readonly record: (input: DeviceInput) => void;
  readonly stop: (endedEarly?: "time" | "size") => Promise<DeviceRecorderResult>;
}

/**
 * Collects input, and takes a screenshot (when `frames`) and the accessibility
 * tree at the start and after each step settles. Records the stream canvas as
 * video in the browser, so it works the same for every device. Interpreting
 * what it collected waits for `buildDeviceRecording`. `onVideoFull` fires once
 * when the video reaches its byte budget; the owner stops the recording then.
 */
export function startDeviceRecorder(options: {
  readonly transport: DeviceHubTransport;
  readonly platform: DevicePlatform;
  readonly deviceId: string;
  readonly frames: boolean;
  readonly videoSource: HTMLCanvasElement;
  readonly onVideoFull: () => void;
}): DeviceRecorder {
  const { transport, platform, deviceId } = options;
  const startedAt = performance.now();
  const now = () => performance.now() - startedAt;
  const abort = new AbortController();
  const inputs: TimedDeviceInput[] = [];
  const captures: DeviceRecorderCapture[] = [];
  let touching = false;
  let settleTimers: Array<ReturnType<typeof setTimeout>> = [];
  let inFlight: Promise<void> | null = null;
  let captureQueued = false;
  let stopped = false;
  const video = startCanvasVideo(options.videoSource, options.onVideoFull);

  const thinFrames = () => {
    const held = captures.flatMap((capture, index) => (capture.frame ? [index] : []));
    if (held.length <= MAX_HELD_FRAMES) return;
    const kept = pickKeyframes(held, THINNED_FRAMES);
    for (const index of held) {
      if (!kept.has(index)) captures[index] = { ...captures[index]!, frame: null, hasFrame: false };
    }
  };

  const capture = (): Promise<void> => {
    if (inFlight) {
      captureQueued = true;
      return inFlight;
    }
    const requestedAt = now();
    inFlight = Promise.allSettled([
      options.frames
        ? captureDeviceScreenshot(transport, { platform, deviceId })
        : Promise.resolve(null),
      fetchDeviceAxTree(transport, { platform, deviceId }, abort.signal),
    ]).then(([frame, tree]) => {
      inFlight = null;
      const elements: ReadonlyArray<DeviceAxElement> | null =
        tree.status === "fulfilled" && tree.value.errors.length === 0 ? tree.value.elements : null;
      const blob = frame.status === "fulfilled" ? frame.value : null;
      captures.push({ requestedAt, frame: blob, hasFrame: blob !== null, elements });
      thinFrames();
      if (captureQueued && !stopped) {
        captureQueued = false;
        return capture();
      }
    });
    return inFlight;
  };

  const clearSettle = () => {
    for (const timer of settleTimers) clearTimeout(timer);
    settleTimers = [];
  };

  const settle = () => {
    clearSettle();
    if (touching || stopped) return;
    settleTimers = [SETTLE_MS, SETTLED_AGAIN_MS].map((delay) =>
      setTimeout(() => void capture(), delay),
    );
  };

  void capture();

  return {
    record: (input) => {
      if (stopped) return;
      inputs.push({ at: now(), input });
      if (input.type === "touch") {
        if (input.phase === "move") return;
        touching = input.phase === "begin";
      }
      settle();
    },
    stop: async (endedEarly) => {
      stopped = true;
      captureQueued = false;
      clearSettle();
      const durationMs = now();
      const videoResult = video.recorder ? video.recorder.stop() : Promise.resolve(null);
      await inFlight;
      // The screen after the last step, unless a capture already followed it.
      const lastInput = inputs.at(-1)?.at ?? Number.NEGATIVE_INFINITY;
      const lastCapture = captures.at(-1)?.requestedAt ?? Number.NEGATIVE_INFINITY;
      if (lastInput >= lastCapture) await capture();
      abort.abort();
      const recorded = await videoResult;
      return {
        durationMs,
        inputs,
        captures,
        video: recorded !== null && "blob" in recorded ? recorded : null,
        videoMissing:
          recorded === null
            ? (video.unavailable ?? "the browser could not record the screen")
            : "missing" in recorded
              ? recorded.missing
              : null,
        endedEarly: endedEarly ?? null,
      };
    },
  };
}

/** Records the stream canvas at a fixed bitrate, stopping at the byte budget. */
function startCanvasVideo(
  canvas: HTMLCanvasElement,
  onFull: () => void,
): {
  readonly recorder: {
    readonly stop: () => Promise<DeviceRecorderVideo | { readonly missing: string }>;
  } | null;
  readonly unavailable: string | null;
} {
  if (typeof MediaRecorder === "undefined" || typeof canvas.captureStream !== "function") {
    return { recorder: null, unavailable: "this browser cannot record video" };
  }
  const mimeType = VIDEO_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) return { recorder: null, unavailable: "this browser records no known video type" };
  let stream: MediaStream;
  let recorder: MediaRecorder;
  try {
    stream = canvas.captureStream(VIDEO_FRAME_RATE);
    recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: DEVICE_RECORDING_VIDEO_BITS_PER_SECOND,
    });
  } catch {
    return { recorder: null, unavailable: "the browser could not record the screen" };
  }
  const chunks: Blob[] = [];
  let bytes = 0;
  let failed = false;
  let full = false;
  const finished = new Promise<void>((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
  });
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size === 0) return;
    chunks.push(event.data);
    bytes += event.data.size;
    if (bytes >= DEVICE_RECORDING_VIDEO_MAX_BYTES && !full) {
      full = true;
      onFull();
    }
  });
  recorder.addEventListener("error", () => {
    failed = true;
  });
  // A chunk every second, so the budget is checked while recording.
  recorder.start(1_000);
  return {
    unavailable: null,
    recorder: {
      stop: async () => {
        if (recorder.state !== "inactive") recorder.stop();
        await finished;
        for (const track of stream.getTracks()) track.stop();
        if (failed || bytes === 0) return { missing: "the browser could not record the screen" };
        const type = mimeType.split(";", 1)[0]!;
        const blob = new Blob(chunks, { type });
        return blob.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES
          ? { missing: "the video ran past the 10 MB attachment limit" }
          : { blob, mimeType: type };
      },
    },
  };
}
