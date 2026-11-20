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
export const DEVICE_RECORDING_VIDEO_MAX_BYTES = PROVIDER_SEND_TURN_MAX_FILE_BYTES - 512 * 1024;
/**
 * Chosen so the longest recording fits the budget: the encoder runs about 6%
 * over its target on a screen that never stops moving, so 3 minutes comes to
 * about 8.6 MB. Should one still run over, the recording stops early.
 */
export const DEVICE_RECORDING_VIDEO_BITS_PER_SECOND = 360_000;
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
  /** Past the attachment limit (the last chunks ran over): download only. */
  readonly tooBig: boolean;
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
  /** Hears each frame drawn on `videoSource`. */
  readonly observeFrames: (listener: () => void) => () => void;
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
  let stopped = false;
  const video = startCanvasVideo(options.videoSource, options.observeFrames, options.onVideoFull);

  const thinFrames = () => {
    const held = captures.flatMap((capture, index) => (capture.frame ? [index] : []));
    if (held.length <= MAX_HELD_FRAMES) return;
    const kept = pickKeyframes(held, THINNED_FRAMES);
    for (const index of held) {
      if (!kept.has(index)) captures[index] = { ...captures[index]!, frame: null, hasFrame: false };
    }
  };

  /**
   * One kind of capture, one at a time: a request while one runs is taken
   * once it ends. Screenshots and trees run apart, because a tree can take
   * seconds (longer while an app launches) and must not hold the screenshot
   * that shows the step.
   */
  const captureLoop = (take: (requestedAt: number) => Promise<void>) => {
    let inFlight: Promise<void> | null = null;
    let queued = false;
    const run = (): Promise<void> => {
      if (inFlight) {
        queued = true;
        return inFlight;
      }
      inFlight = take(now()).then(() => {
        inFlight = null;
        if (queued && !stopped) {
          queued = false;
          return run();
        }
      });
      return inFlight;
    };
    return {
      run,
      settled: () => {
        queued = false;
        return inFlight ?? Promise.resolve();
      },
    };
  };

  const frames = captureLoop(async (requestedAt) => {
    const frame = await captureDeviceScreenshot(transport, { platform, deviceId }).catch(
      () => null,
    );
    captures.push({ requestedAt, frame, hasFrame: frame !== null, elements: null });
    thinFrames();
  });
  const trees = captureLoop(async (requestedAt) => {
    const tree = await fetchDeviceAxTree(transport, { platform, deviceId }, abort.signal).catch(
      () => null,
    );
    const elements: ReadonlyArray<DeviceAxElement> | null =
      tree !== null && tree.errors.length === 0 ? tree.elements : null;
    if (elements) captures.push({ requestedAt, frame: null, hasFrame: false, elements });
  });
  const capture = () => {
    if (options.frames) void frames.run();
    void trees.run();
  };
  const lastFrameAt = () =>
    captures.findLast((entry) => entry.hasFrame)?.requestedAt ?? Number.NEGATIVE_INFINITY;

  const clearSettle = () => {
    for (const timer of settleTimers) clearTimeout(timer);
    settleTimers = [];
  };

  const settle = () => {
    clearSettle();
    if (touching || stopped) return;
    settleTimers = [SETTLE_MS, SETTLED_AGAIN_MS].map((delay) => setTimeout(capture, delay));
  };

  capture();

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
      clearSettle();
      const durationMs = now();
      const videoResult = video.recorder ? video.recorder.stop() : Promise.resolve(null);
      // Trees only name touches already made; the last one in flight is not waited for.
      abort.abort();
      await Promise.all([frames.settled(), trees.settled()]);
      // The screen after the last step, unless a screenshot already followed it.
      const lastInput = inputs.at(-1)?.at ?? Number.NEGATIVE_INFINITY;
      if (options.frames && lastInput >= lastFrameAt()) await frames.run();
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

/** Long enough for the capture to take a frame drawn just before stopping. */
const LAST_FRAME_SETTLE_MS = 120;
/**
 * The video's longest edge. A simulator's full size (2532 px tall) makes the
 * browser's encoder overshoot its bitrate several times on a moving screen;
 * at this size it keeps close to it, and the screen stays legible.
 */
const VIDEO_MAX_EDGE = 1280;

/**
 * Records the stream at a fixed bitrate on a smaller canvas of its own, copied
 * from the stream canvas each time that draws a frame (and once at the start
 * and the end, so a still screen still opens and closes the video). Stops at
 * the byte budget.
 */
function startCanvasVideo(
  source: HTMLCanvasElement,
  observeFrames: (listener: () => void) => () => void,
  onFull: () => void,
): {
  readonly recorder: {
    readonly stop: () => Promise<DeviceRecorderVideo | { readonly missing: string }>;
  } | null;
  readonly unavailable: string | null;
} {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (
    typeof MediaRecorder === "undefined" ||
    typeof canvas.captureStream !== "function" ||
    !context
  ) {
    return { recorder: null, unavailable: "this browser cannot record video" };
  }
  const mimeType = VIDEO_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) return { recorder: null, unavailable: "this browser records no known video type" };
  const draw = () => {
    if (source.width === 0 || source.height === 0) return;
    const scale = Math.min(1, VIDEO_MAX_EDGE / Math.max(source.width, source.height));
    // Encoders want even sizes.
    const width = Math.max(2, Math.round((source.width * scale) / 2) * 2);
    const height = Math.max(2, Math.round((source.height * scale) / 2) * 2);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.drawImage(source, 0, 0, width, height);
  };
  draw();
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
  const unobserve = observeFrames(draw);
  draw();
  return {
    unavailable: null,
    recorder: {
      stop: async () => {
        unobserve();
        if (recorder.state === "recording") {
          draw();
          await new Promise((resolve) => setTimeout(resolve, LAST_FRAME_SETTLE_MS));
        }
        if (recorder.state !== "inactive") recorder.stop();
        await finished;
        for (const track of stream.getTracks()) track.stop();
        if (failed || bytes === 0) return { missing: "the browser could not record the screen" };
        const type = mimeType.split(";", 1)[0]!;
        const blob = new Blob(chunks, { type });
        return { blob, mimeType: type, tooBig: blob.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES };
      },
    },
  };
}
