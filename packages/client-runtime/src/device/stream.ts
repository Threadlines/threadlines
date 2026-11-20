// @effect-diagnostics globalTimers:off - This browser stream client runs without an Effect runtime.
/**
 * One device's live screen and input (docs/design/devices.md, "Transport").
 *
 * Ported from T3 Code's stream client (MIT, see NOTICE) with the 3D and
 * WebRTC paths removed, and every byte carried by a `DeviceHubTransport`
 * instead of hub URLs:
 *
 * - iOS: serve-sim's AVCC stream decoded with WebCodecs, input over its helper
 *   socket. Without WebCodecs (or a profile this browser cannot decode) its
 *   MJPEG stream is fetched and each JPEG painted to the canvas.
 * - Android: serve-emu's socket carries H.264 and takes input. Without
 *   WebCodecs the socket carries input only, and the screen is the
 *   screenshot route read about four times a second.
 *
 * - iPhone Duo: hinge and stance commands ride the iOS input socket as tagged
 *   messages, and with `setDuoPanels` the video comes from the fixed feed of
 *   the display in front (`/helper/<id>/panel/{1,3}/stream.avcc`), reopened
 *   on the other panel when the helper hands the display over. A helper that
 *   refuses fixed feeds falls back to the ordinary stream.
 *
 * Each retry opens a fresh request or socket and a fresh decoder that waits
 * for a keyframe; input that had not gone out is dropped, never replayed.
 */
import type { DevicePlatform } from "@threadlines/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  createDuoControl,
  type DuoCommand,
  type DuoControlState,
  type DuoPanelId,
} from "./duoControl.ts";
import { createCanvasFrameSink, type DeviceFrameSink } from "./frame.ts";
import {
  DEVICE_SOCKET_OPEN,
  type DeviceHubSocket,
  type DeviceHubTransport,
} from "./hubTransport.ts";
import { DEVICE_MAX_FRAME_BYTES, DeviceFrameTooLargeError } from "./frameLimit.ts";
import { MultipartJpegParser } from "./mjpeg.ts";
import { extractPng } from "./png.ts";

export type DeviceStreamStatus = "connecting" | "streaming" | "error";

/** How the screen reaches the canvas: decoded video, MJPEG frames, or polled stills. */
export type DeviceVideoMode = "video" | "mjpeg" | "stills";

export type DeviceOrientationName =
  | "portrait"
  | "portrait_upside_down"
  | "landscape_left"
  | "landscape_right";

export interface DeviceScreenSize {
  readonly width: number;
  readonly height: number;
  readonly orientation: DeviceOrientationName;
  /** iPhone Duo: the display in front, 1 the cover and 3 the inner screen. */
  readonly screenId?: number;
  /** The simulator has a hinge (iPhone Duo) and takes hinge commands. */
  readonly supportsHingeAngle?: boolean;
  readonly supportsPhysicalOrientation?: boolean;
  /** 0 closed to 180 open. */
  readonly hingeAngle?: number;
  readonly hingePose?: "closed" | "book" | "open" | "laptop" | "tent" | null;
  readonly tableMode?: boolean;
  /** Table mode can be turned on in the current stance. */
  readonly tableModeAvailable?: boolean;
}

const screenConfigSchema = Schema.Struct({
  width: Schema.Finite.check(Schema.isGreaterThan(0)),
  height: Schema.Finite.check(Schema.isGreaterThan(0)),
  orientation: Schema.Literals([
    "portrait",
    "portrait_upside_down",
    "landscape_left",
    "landscape_right",
  ]),
  inputUnavailable: Schema.optionalKey(Schema.Boolean),
  screenId: Schema.optionalKey(Schema.Number),
  supportsHingeAngle: Schema.optionalKey(Schema.Boolean),
  supportsPhysicalOrientation: Schema.optionalKey(Schema.Boolean),
  hingeAngle: Schema.optionalKey(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 180 })),
  ),
  hingePose: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["closed", "book", "open", "laptop", "tent"])),
  ),
  tableMode: Schema.optionalKey(Schema.Boolean),
  tableModeAvailable: Schema.optionalKey(Schema.Boolean),
});
const decodeScreenConfig = Schema.decodeUnknownOption(screenConfigSchema);
const decodeControlReply = Schema.decodeUnknownOption(
  Schema.Struct({
    requestId: Schema.Int,
    ok: Schema.Boolean,
    error: Schema.optionalKey(Schema.String),
  }),
);

/** Where a Duo's two fixed feeds draw: the cover's and the inner screen's own canvases. */
export interface DuoPanelSinks {
  readonly cover: DeviceFrameSink;
  readonly inner: DeviceFrameSink;
}

export interface DeviceStreamEvents {
  readonly onStatus: (status: DeviceStreamStatus, detail?: string) => void;
  readonly onScreen: (screen: DeviceScreenSize) => void;
  readonly onInputConnected: (connected: boolean, detail?: string) => void;
  readonly onVideoMode?: (mode: DeviceVideoMode) => void;
  /** iPhone Duo: the hinge command queue changed. */
  readonly onDuoControl?: (state: DuoControlState) => void;
  /** iPhone Duo: the fixed feeds are refused, so the ordinary stream is back. */
  readonly onDuoUnavailable?: (detail: string) => void;
  /** iPhone Duo: the display a panel feed draws changed (which feed is live). */
  readonly onDuoPanel?: (panel: DuoPanelId | null) => void;
}

export interface DeviceStreamTarget {
  readonly platform: DevicePlatform;
  readonly deviceId: string;
  readonly transport: DeviceHubTransport;
  /** A Duo display's fixed feed: video only, no input socket. */
  readonly panelId?: DuoPanelId;
}

export type DeviceHardwareButton = "home" | "back" | "recents" | "power" | "appSwitcher";

const RETRY_DELAY_MS = 1_000;
const FIRST_FRAME_TIMEOUT_MS = 15_000;
const PRIME_TIMEOUT_MS = 2_000;
/** Android without WebCodecs: one screenshot at a time, at most this often. */
export const STILL_FRAME_INTERVAL_MS = 250;
const STILL_FRAME_TIMEOUT_MS = 5_000;
const STILL_FRAME_MAX_FAILURES = 5;
const FRAME_DURATION_US = 16_667;
const SEMU_MAGIC = 0x53454d55;
const SEMU_HEADER_BYTES = 16;
const SEMU_FLAG_KEY = 1;
const SOFT_DECODE_QUEUE = 8;
// expo-device-hub serve-emu input.js MAX_TEXT_BYTES limits packets to 300 UTF-8 bytes.
const ANDROID_MAX_TEXT_BYTES = 300;
// The hub's queue depth is 128; the client does not read queue rejections.
const ANDROID_MAX_TEXT_CHUNKS = 64;

const IOS_MSG_TOUCH = 0x03;
const IOS_MSG_BUTTON = 0x04;
const IOS_MSG_KEY = 0x06;
const IOS_MSG_ORIENTATION = 0x07;
const IOS_MSG_DUO_CONTROL = 0x10;
const IOS_TAG_SCREEN_CONFIG = 0x82;
const IOS_TAG_INPUT_ADMITTED = 0x83;
const IOS_TAG_DUO_CONTROL_REPLY = 0x90;
/**
 * Statuses a helper answers a fixed Duo feed with when it has none: no such
 * route (400, 404, 405, 410), or a simulator without panels (409,
 * `panel_streams_unsupported`).
 */
const DUO_PANEL_REFUSED = new Set([400, 404, 405, 409, 410]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const isWebCodecsSupported = (): boolean =>
  typeof globalThis !== "undefined" &&
  "VideoDecoder" in globalThis &&
  "EncodedVideoChunk" in globalThis;

function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function taggedJson(tag: number, payload: unknown): Uint8Array<ArrayBuffer> {
  const json = encoder.encode(JSON.stringify(payload));
  const out = new Uint8Array(1 + json.length);
  out[0] = tag;
  out.set(json, 1);
  return out;
}

export function avcCodecString(bytes: Uint8Array): string {
  if (bytes.length < 4) return "avc1.42E01E";
  const hex = (byte: number) => byte.toString(16).padStart(2, "0");
  return `avc1.${hex(bytes[1]!)}${hex(bytes[2]!)}${hex(bytes[3]!)}`;
}

export function parseSemuPacket(raw: ArrayBuffer): {
  readonly data: Uint8Array;
  readonly isKey: boolean | null;
  readonly timestamp: number | null;
} {
  const bytes = new Uint8Array(raw);
  if (bytes.byteLength > SEMU_HEADER_BYTES) {
    const view = new DataView(raw, 0, SEMU_HEADER_BYTES);
    if (view.getUint32(0, false) === SEMU_MAGIC && view.getUint8(4) === 1) {
      const pts = view.getBigUint64(8, false);
      return {
        data: bytes.subarray(SEMU_HEADER_BYTES),
        isKey: (view.getUint8(5) & SEMU_FLAG_KEY) !== 0,
        timestamp: pts <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(pts) : null,
      };
    }
  }
  return { data: bytes, isKey: null, timestamp: null };
}

const isVideoSessionMessage = (text: string) => {
  try {
    const message = JSON.parse(text) as { type?: unknown };
    return message.type === "video-session";
  } catch {
    return false;
  }
};

export function scanAccessUnit(buf: Uint8Array): { isKey: boolean; sps: Uint8Array | null } {
  let isKey = false;
  let sps: Uint8Array | null = null;
  const len = buf.length;
  let i = 0;
  while (i + 2 < len) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      let codeLen = 0;
      if (buf[i + 2] === 1) codeLen = 3;
      else if (i + 3 < len && buf[i + 2] === 0 && buf[i + 3] === 1) codeLen = 4;
      if (codeLen) {
        const nalType = buf[i + codeLen]! & 0x1f;
        if (nalType === 7 && !sps) sps = buf.subarray(i + codeLen);
        if (nalType === 5) isKey = true;
        i += codeLen + 1;
        continue;
      }
    }
    i++;
  }
  return { isKey, sps };
}

export type AvccChunk = {
  readonly type: "description" | "keyframe" | "delta" | "seed";
  readonly payload: Uint8Array;
};

const AVCC_TAGS: Record<number, AvccChunk["type"] | undefined> = {
  1: "description",
  2: "keyframe",
  3: "delta",
  4: "seed",
};

/** Splits serve-sim's length-prefixed, tagged AVCC stream into chunks. */
export class AvccDemuxer {
  private buffer = new Uint8Array(64 * 1024);
  private length = 0;

  push(bytes: Uint8Array): AvccChunk[] {
    // One frame at the limit plus the chunk that completes it; more is never a valid stream.
    if (this.length + bytes.length > 2 * DEVICE_MAX_FRAME_BYTES) {
      throw new DeviceFrameTooLargeError("video buffer", this.length + bytes.length);
    }
    if (this.length + bytes.length > this.buffer.length) {
      let capacity = this.buffer.length;
      while (capacity < this.length + bytes.length) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(bytes, this.length);
    this.length += bytes.length;

    const chunks: AvccChunk[] = [];
    let offset = 0;
    while (this.length - offset >= 4) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, 4);
      const frameLength = view.getUint32(0, false);
      if (frameLength > DEVICE_MAX_FRAME_BYTES) {
        throw new DeviceFrameTooLargeError("video frame", frameLength);
      }
      if (this.length - offset - 4 < frameLength) break;
      if (frameLength >= 1) {
        const type = AVCC_TAGS[this.buffer[offset + 4]!];
        if (type) {
          chunks.push({ type, payload: this.buffer.slice(offset + 5, offset + 4 + frameLength) });
        }
      }
      offset += 4 + frameLength;
    }
    if (offset > 0) {
      this.buffer.copyWithin(0, offset, this.length);
      this.length -= offset;
    }
    return chunks;
  }
}

export interface DeviceStreamClient {
  readonly start: () => void;
  readonly stop: () => void;
  /** Normalized 0..1 coordinates in the displayed frame. */
  readonly sendTouch: (phase: "begin" | "move" | "end", x: number, y: number) => void;
  /** iOS: 0..1 in the display's own framebuffer, as the helper takes it (the Duo view maps its panels). */
  readonly sendRawTouch: (phase: "begin" | "move" | "end", x: number, y: number) => void;
  /** iPhone Duo: a hinge, stance, table mode or orientation command. */
  readonly controlDuo: (command: DuoCommand) => void;
  /**
   * iPhone Duo: draw each display into its own sink from its fixed feed
   * while the helper offers them, or back to the one canvas with null.
   */
  readonly setDuoPanels: (panels: DuoPanelSinks | null) => void;
  readonly sendKey: (event: KeyboardEvent, phase: "down" | "up") => void;
  /**
   * Types text. Android takes it as text; iOS input is HID key codes, so each
   * character a US keyboard has becomes key presses and the rest are skipped.
   */
  readonly sendText: (text: string) => void;
  readonly pressButton: (button: DeviceHardwareButton) => void;
  /** iOS only; Android rotates through the Tools drawer. */
  readonly rotate: () => void;
}

const HID_USAGE_BY_CODE: Readonly<Record<string, number>> = {
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  Delete: 0x4c,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  NumpadDivide: 0x54,
  NumpadMultiply: 0x55,
  NumpadSubtract: 0x56,
  NumpadAdd: 0x57,
  NumpadEnter: 0x58,
  Numpad1: 0x59,
  Numpad2: 0x5a,
  Numpad3: 0x5b,
  Numpad4: 0x5c,
  Numpad5: 0x5d,
  Numpad6: 0x5e,
  Numpad7: 0x5f,
  Numpad8: 0x60,
  Numpad9: 0x61,
  Numpad0: 0x62,
  NumpadDecimal: 0x63,
  NumpadEqual: 0x67,
  ControlLeft: 0xe0,
  ShiftLeft: 0xe1,
  AltLeft: 0xe2,
  MetaLeft: 0xe3,
  ControlRight: 0xe4,
  ShiftRight: 0xe5,
  AltRight: 0xe6,
  MetaRight: 0xe7,
};

function hidUsageForCode(code: string): number | null {
  if (/^Key[A-Z]$/.test(code)) return 0x04 + (code.charCodeAt(3) - 65);
  if (/^Digit[1-9]$/.test(code)) return 0x1e + (code.charCodeAt(5) - 49);
  if (code === "Digit0") return 0x27;
  return HID_USAGE_BY_CODE[code] ?? null;
}

/** US-layout punctuation: the key's code, and whether it needs shift. */
const US_PUNCTUATION: Readonly<Record<string, readonly [string, boolean]>> = {
  " ": ["Space", false],
  "\n": ["Enter", false],
  "\t": ["Tab", false],
  "-": ["Minus", false],
  _: ["Minus", true],
  "=": ["Equal", false],
  "+": ["Equal", true],
  "[": ["BracketLeft", false],
  "{": ["BracketLeft", true],
  "]": ["BracketRight", false],
  "}": ["BracketRight", true],
  "\\": ["Backslash", false],
  "|": ["Backslash", true],
  ";": ["Semicolon", false],
  ":": ["Semicolon", true],
  "'": ["Quote", false],
  '"': ["Quote", true],
  "`": ["Backquote", false],
  "~": ["Backquote", true],
  ",": ["Comma", false],
  "<": ["Comma", true],
  ".": ["Period", false],
  ">": ["Period", true],
  "/": ["Slash", false],
  "?": ["Slash", true],
  "!": ["Digit1", true],
  "@": ["Digit2", true],
  "#": ["Digit3", true],
  $: ["Digit4", true],
  "%": ["Digit5", true],
  "^": ["Digit6", true],
  "&": ["Digit7", true],
  "*": ["Digit8", true],
  "(": ["Digit9", true],
  ")": ["Digit0", true],
};

/**
 * The key presses that type `character` on a US keyboard, as HID usages and
 * shift, or null for a character no key types (the iOS input socket takes
 * keys, not text).
 */
export function iosKeystrokeForCharacter(
  character: string,
): { readonly usage: number; readonly shift: boolean } | null {
  if (/^[a-z]$/.test(character)) {
    return { usage: hidUsageForCode(`Key${character.toUpperCase()}`)!, shift: false };
  }
  if (/^[A-Z]$/.test(character)) return { usage: hidUsageForCode(`Key${character}`)!, shift: true };
  if (/^[0-9]$/.test(character))
    return { usage: hidUsageForCode(`Digit${character}`)!, shift: false };
  const punctuation = US_PUNCTUATION[character];
  if (!punctuation) return null;
  const usage = hidUsageForCode(punctuation[0]);
  return usage === null ? null : { usage, shift: punctuation[1] };
}

const ANDROID_KEYCODE_BY_KEY: Readonly<Record<string, number>> = {
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Tab: 61,
  Enter: 66,
  Backspace: 67,
  Delete: 112,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
};

const IOS_ORIENTATIONS: ReadonlyArray<DeviceOrientationName> = [
  "portrait",
  "landscape_left",
  "portrait_upside_down",
  "landscape_right",
];

/** The hub paths the viewer uses, so the server's allowlist can be checked against one list. */
export const deviceHubPaths = {
  iosVideo: (device: string) => `/vendor/serve-sim/helper/${device}/stream.avcc`,
  iosMjpeg: (device: string) => `/vendor/serve-sim/helper/${device}/stream.mjpeg`,
  iosPanelVideo: (device: string, panel: DuoPanelId) =>
    `/vendor/serve-sim/helper/${device}/panel/${panel}/stream.avcc`,
  iosInput: (device: string) => `/vendor/serve-sim/helper/ws?device=${device}`,
  androidSocket: (device: string, inputOnly: boolean) =>
    `/vendor/serve-emu/ws?device=${device}&${inputOnly ? "video=0" : "frame-meta=1"}`,
  screenshot: (platform: DevicePlatform, device: string) =>
    `/vendor/${platform === "ios" ? "serve-sim" : "serve-emu"}/api/screenshot?device=${device}`,
};

export function createDeviceStreamClient(
  target: DeviceStreamTarget,
  output: HTMLCanvasElement | DeviceFrameSink,
  events: DeviceStreamEvents,
): DeviceStreamClient {
  const { platform, deviceId, transport } = target;
  const sink = "present" in output ? output : createCanvasFrameSink(output);
  const ios = platform === "ios";
  const panelId = ios ? target.panelId : undefined;
  const device = encodeURIComponent(deviceId);
  const useWebCodecs = isWebCodecsSupported();

  let stopped = true;
  let socket: DeviceHubSocket | null = null;
  let controller: AbortController | null = null;
  const retryTimers = new Map<"video" | "input", ReturnType<typeof setTimeout>>();
  let primeController: AbortController | null = null;
  let stillsTimer: ReturnType<typeof setTimeout> | null = null;
  let videoDecoder: VideoDecoder | null = null;
  let decodedVideoGeneration: number | null = null;
  let iosInputAdmitted = false;
  let iosInputUnavailable = false;
  let timestamp = 0;
  let awaitingKeyframe = true;
  let screen: DeviceScreenSize | null = null;
  let firstFrame = false;
  let configuring = false;
  let mode: DeviceVideoMode = "video";
  let generation = 0;
  let decoderEpoch = 0;
  let frameTimer: ReturnType<typeof setTimeout> | null = null;
  let videoReadTimer: ReturnType<typeof setTimeout> | null = null;
  let videoGeneration = 0;
  // iPhone Duo: where the panels draw, the feed running now, and whether the helper refused them.
  let panelSinks: DuoPanelSinks | null = null;
  let panelFeed: { readonly panel: DuoPanelId; readonly client: DeviceStreamClient } | null = null;
  let panelsRefused = false;
  let mainVideo = false;
  let pendingOrientation: number | null = null;
  const duoControl = createDuoControl({
    send: (request) => {
      if (
        !iosInputAdmitted ||
        iosInputUnavailable ||
        socket?.readyState !== DEVICE_SOCKET_OPEN ||
        !screen?.supportsHingeAngle
      )
        return false;
      pendingOrientation = null;
      if (request.command.control === "orientation") {
        // The helper confirms an orientation with its next screen config, not a reply.
        pendingOrientation = request.requestId;
        socket.send(taggedJson(IOS_MSG_ORIENTATION, { orientation: request.command.value }));
      } else socket.send(taggedJson(IOS_MSG_DUO_CONTROL, request));
      return true;
    },
    onChange: (state) => {
      if (!state.pending) pendingOrientation = null;
      events.onDuoControl?.(state);
    },
  });

  const setStatus = (status: DeviceStreamStatus, detail?: string) => {
    if (!stopped) events.onStatus(status, detail);
  };

  const setMode = (next: DeviceVideoMode) => {
    if (mode === next) return;
    mode = next;
    events.onVideoMode?.(next);
  };

  const clearFrameTimer = () => {
    if (frameTimer !== null) clearTimeout(frameTimer);
    frameTimer = null;
  };

  const fail = (detail: string) => {
    if (stopped) return;
    stop();
    events.onInputConnected(false, detail);
    events.onStatus("error", detail);
  };

  const connecting = (detail?: string) => {
    firstFrame = false;
    if (frameTimer === null) {
      frameTimer = setTimeout(
        () => fail("No video came from the device. Reconnect to try again."),
        FIRST_FRAME_TIMEOUT_MS,
      );
    }
    setStatus("connecting", detail);
  };

  const frameReceived = () => {
    if (firstFrame) return;
    firstFrame = true;
    clearFrameTimer();
    setStatus("streaming");
  };

  const paint = (source: CanvasImageSource, width: number, height: number) => {
    if (stopped) return;
    if (!ios && (screen?.width !== width || screen.height !== height)) {
      screen = { width, height, orientation: width > height ? "landscape_left" : "portrait" };
      events.onScreen(screen);
    }
    if (!sink.present(source, width, height)) {
      fail("Could not show the device stream. Reconnect to try again.");
      return;
    }
    frameReceived();
  };

  /** Decodes an image and paints it, unless a newer frame or a stop came first. */
  const paintImage = async (blob: Blob, isCurrent: () => boolean) => {
    const bitmap = await createImageBitmap(blob);
    try {
      if (isCurrent()) paint(bitmap, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  };

  const closeDecoder = () => {
    decoderEpoch++;
    try {
      videoDecoder?.close();
    } catch {}
    videoDecoder = null;
    awaitingKeyframe = true;
  };

  const recoverDecoder = () => {
    if (ios) fallBackToMjpeg();
    else {
      closeDecoder();
      connecting("Video decoder restarted.");
      requestKeyframe();
    }
  };

  const makeDecoder = () => {
    const feedGeneration = videoGeneration;
    const created = new VideoDecoder({
      output: (frame) => {
        try {
          if (videoDecoder === created && (!ios || feedGeneration === videoGeneration)) {
            decodedVideoGeneration = feedGeneration;
            paint(frame, frame.displayWidth, frame.displayHeight);
          }
        } finally {
          frame.close();
        }
      },
      error: () => {
        if (stopped || videoDecoder !== created || (ios && feedGeneration !== videoGeneration))
          return;
        recoverDecoder();
      },
    });
    return created;
  };

  const configureDecoder = async (
    config: VideoDecoderConfig,
    isCurrent = () => !stopped,
  ): Promise<boolean> => {
    const epoch = decoderEpoch;
    const full: VideoDecoderConfig = { ...config, optimizeForLatency: true };
    const support = await VideoDecoder.isConfigSupported(full).catch(() => ({ supported: false }));
    if (!isCurrent() || epoch !== decoderEpoch) return false;
    if (!support.supported) {
      if (!ios) fail(`This browser cannot decode ${config.codec}.`);
      return false;
    }
    try {
      if (!videoDecoder || videoDecoder.state === "closed") videoDecoder = makeDecoder();
      videoDecoder.configure(full);
      return true;
    } catch (cause) {
      if (!ios) fail(`Video decoder: ${(cause as Error).message}`);
      return false;
    }
  };

  const decode = (isKey: boolean, data: Uint8Array, pts?: number | null) => {
    if (!videoDecoder || videoDecoder.state !== "configured") return;
    if (awaitingKeyframe) {
      if (!isKey) return;
      awaitingKeyframe = false;
    }
    if (videoDecoder.decodeQueueSize > SOFT_DECODE_QUEUE) {
      if (!ios) {
        recoverDecoder();
        return;
      }
      // Native IDRs are spaced by frame count, so an idle simulator may take
      // minutes to produce one. A new AVCC request forces a fresh IDR.
      controller?.abort();
      closeDecoder();
      return;
    }
    try {
      videoDecoder.decode(
        new EncodedVideoChunk({
          type: isKey ? "key" : "delta",
          timestamp: pts ?? timestamp,
          data,
        }),
      );
      timestamp += FRAME_DURATION_US;
    } catch {
      recoverDecoder();
    }
  };

  const requestKeyframe = () => {
    if (!ios && socket?.readyState === DEVICE_SOCKET_OPEN) {
      socket.send(JSON.stringify({ type: "reset-video", ack: false }));
    }
  };

  const scheduleRetry = (channel: "video" | "input", run: () => void) => {
    if (stopped || retryTimers.has(channel)) return;
    retryTimers.set(
      channel,
      setTimeout(() => {
        retryTimers.delete(channel);
        run();
      }, RETRY_DELAY_MS),
    );
  };

  /**
   * Reads one HTTP body to its end, with a watchdog: a stream that stops
   * producing for the first-frame timeout is aborted and retried.
   */
  const readBody = async (
    path: string,
    videoController: AbortController,
    isCurrent: () => boolean,
    onChunk: (bytes: Uint8Array) => Promise<boolean | void> | boolean | void,
  ): Promise<string | undefined> => {
    let retryDetail: string | undefined;
    try {
      const response = await transport.fetch(path, { signal: videoController.signal });
      if (!isCurrent()) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      if (panelId !== undefined && DUO_PANEL_REFUSED.has(response.status)) {
        await response.body?.cancel().catch(() => {});
        fail(`This simulator's helper has no fixed Duo display feeds (${response.status}).`);
        return;
      }
      if (!response.ok || !response.body) throw new Error(`Device stream ${response.status}`);
      const reader = response.body.getReader();
      for (;;) {
        const timer = setTimeout(() => {
          if (!isCurrent()) return;
          retryDetail = "The device stream stopped sending video. Reconnecting…";
          videoController.abort();
        }, FIRST_FRAME_TIMEOUT_MS);
        videoReadTimer = timer;
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } finally {
          clearTimeout(timer);
          if (videoReadTimer === timer) videoReadTimer = null;
        }
        if (!isCurrent()) return;
        if (result.done) break;
        if ((await onChunk(result.value)) === false) {
          await reader.cancel().catch(() => {});
          return;
        }
        if (!isCurrent()) return;
      }
    } catch (cause) {
      if (!isCurrent()) return;
      retryDetail ??= videoController.signal.aborted
        ? "The video decoder fell behind. Reconnecting…"
        : (cause as Error).message;
    }
    return retryDetail ?? "The device stream ended. Reconnecting…";
  };

  const readIosVideo = async () => {
    const lifecycle = generation;
    const feedGeneration = ++videoGeneration;
    const demuxer = new AvccDemuxer();
    const videoController = new AbortController();
    controller = videoController;
    const isCurrent = () =>
      !stopped &&
      mode === "video" &&
      generation === lifecycle &&
      videoGeneration === feedGeneration &&
      controller === videoController;
    const retryDetail = await readBody(
      panelId === undefined
        ? deviceHubPaths.iosVideo(device)
        : deviceHubPaths.iosPanelVideo(device, panelId),
      videoController,
      isCurrent,
      async (bytes) => {
        for (const chunk of demuxer.push(bytes)) {
          if (videoController.signal.aborted) return;
          switch (chunk.type) {
            case "seed":
              // A JPEG of the current screen, shown until the first decoded frame.
              void paintImage(
                new Blob([chunk.payload as BlobPart], { type: "image/jpeg" }),
                () => isCurrent() && decodedVideoGeneration !== feedGeneration,
              ).catch(() => {});
              break;
            case "description": {
              awaitingKeyframe = true;
              const configured = await configureDecoder(
                { codec: avcCodecString(chunk.payload), description: chunk.payload },
                isCurrent,
              );
              if (!isCurrent()) return false;
              if (!configured) {
                fallBackToMjpeg();
                return false;
              }
              break;
            }
            case "keyframe":
            case "delta":
              decode(chunk.type === "keyframe", chunk.payload);
              break;
          }
        }
      },
    );
    if (retryDetail !== undefined && isCurrent()) {
      controller = null;
      videoController.abort();
      closeDecoder();
      connecting(retryDetail);
      scheduleRetry("video", () => void readIosVideo());
    }
  };

  /** serve-sim's MJPEG stream, each JPEG painted to the canvas as it lands. */
  const readIosMjpeg = async () => {
    const lifecycle = generation;
    const videoController = new AbortController();
    controller = videoController;
    const parser = new MultipartJpegParser();
    let painting = false;
    let latest: Uint8Array | null = null;
    const isCurrent = () =>
      !stopped && mode === "mjpeg" && generation === lifecycle && controller === videoController;
    // Decoding is slower than arrival on a busy machine: keep only the newest frame waiting.
    const paintLatest = () => {
      if (painting || latest === null) return;
      const frame = latest;
      latest = null;
      painting = true;
      void paintImage(new Blob([frame as BlobPart], { type: "image/jpeg" }), isCurrent)
        .catch(() => {})
        .finally(() => {
          painting = false;
          paintLatest();
        });
    };
    const retryDetail = await readBody(
      deviceHubPaths.iosMjpeg(device),
      videoController,
      isCurrent,
      (bytes) => {
        const frames = parser.push(bytes);
        if (frames.length > 0) {
          latest = frames.at(-1)!;
          paintLatest();
        }
      },
    );
    if (retryDetail !== undefined && isCurrent()) {
      controller = null;
      videoController.abort();
      connecting(retryDetail);
      scheduleRetry("video", () => void readIosMjpeg());
    }
  };

  const fallBackToMjpeg = () => {
    // A Duo panel has no MJPEG feed; its owner goes back to the ordinary stream.
    if (panelId !== undefined) return fail("This browser cannot decode the Duo display's video.");
    if (stopped || mode === "mjpeg") return;
    setMode("mjpeg");
    controller?.abort();
    controller = null;
    closeDecoder();
    connecting();
    void readIosMjpeg();
  };

  /**
   * serve-sim's helper only accepts HID and pushes its screen config once
   * screen capture is running, and the AVCC stream does not reliably start
   * it. Touching the MJPEG endpoint does; one aborted request is enough.
   */
  const primeIosHelper = async (session: number) => {
    const prime = new AbortController();
    primeController = prime;
    const timeout = setTimeout(() => prime.abort(), PRIME_TIMEOUT_MS);
    try {
      const response = await transport.fetch(deviceHubPaths.iosMjpeg(device), {
        signal: prime.signal,
      });
      if (stopped || generation !== session) return;
      await response.body?.getReader().read();
    } catch {
    } finally {
      clearTimeout(timeout);
      prime.abort();
      if (primeController === prime) primeController = null;
    }
  };

  const connectIosInput = async () => {
    if (stopped) return;
    const session = generation;
    await primeIosHelper(session);
    if (stopped || generation !== session) return;
    const ws = transport.socket(deviceHubPaths.iosInput(device));
    socket = ws;
    iosInputAdmitted = false;
    iosInputUnavailable = false;
    ws.addEventListener("message", (event) => {
      if (stopped || socket !== ws) return;
      if (!(event.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(event.data);
      if (bytes.length < 1) return;
      if (bytes[0] === IOS_TAG_INPUT_ADMITTED) {
        iosInputAdmitted = true;
        events.onInputConnected(!iosInputUnavailable);
        return;
      }
      if (bytes[0] === IOS_TAG_DUO_CONTROL_REPLY) {
        try {
          const reply = decodeControlReply(JSON.parse(decoder.decode(bytes.subarray(1))));
          if (Option.isSome(reply)) duoControl.receive(reply.value);
        } catch {}
        return;
      }
      if (bytes[0] !== IOS_TAG_SCREEN_CONFIG) return;
      try {
        const config = decodeScreenConfig(JSON.parse(decoder.decode(bytes.subarray(1))));
        if (Option.isNone(config)) return;
        iosInputUnavailable = config.value.inputUnavailable === true;
        events.onInputConnected(
          iosInputAdmitted && !iosInputUnavailable,
          iosInputUnavailable ? "Simulator input is unavailable." : undefined,
        );
        screen = config.value;
        events.onScreen(screen);
        if (pendingOrientation !== null) {
          const requestId = pendingOrientation;
          pendingOrientation = null;
          duoControl.receive({ requestId, ok: true });
        }
        // A handoff moves the video to the panel now in front; input stays on this socket.
        chooseVideoSource();
      } catch {}
    });
    ws.addEventListener("close", (event) => {
      if (socket !== ws) return;
      socket = null;
      iosInputAdmitted = false;
      duoControl.clear();
      if (stopped) return;
      events.onInputConnected(false, event.reason || `closed ${event.code}`);
      scheduleRetry("input", () => void connectIosInput());
    });
  };

  /** Android without WebCodecs: the screenshot route, one at a time, about four a second. */
  const pollStills = async () => {
    const lifecycle = generation;
    const isCurrent = () => !stopped && generation === lifecycle && mode === "stills";
    let failures = 0;
    while (isCurrent()) {
      const started = Date.now();
      const request = new AbortController();
      controller = request;
      const timeout = setTimeout(() => request.abort(), STILL_FRAME_TIMEOUT_MS);
      try {
        const response = await transport.fetch(deviceHubPaths.screenshot(platform, device), {
          method: "POST",
          signal: request.signal,
        });
        if (!isCurrent()) {
          await response.body?.cancel().catch(() => {});
          return;
        }
        if (!response.ok) throw new Error(`Screenshot ${response.status}`);
        const png = extractPng(new Uint8Array(await response.arrayBuffer()));
        if (!png) throw new Error("The device sent an incomplete screenshot.");
        await paintImage(new Blob([png as BlobPart], { type: "image/png" }), isCurrent);
        failures = 0;
      } catch (cause) {
        if (!isCurrent()) return;
        failures += 1;
        if (failures >= STILL_FRAME_MAX_FAILURES) {
          fail(`Could not read the device screen: ${(cause as Error).message}`);
          return;
        }
      } finally {
        clearTimeout(timeout);
        if (controller === request) controller = null;
      }
      const wait = Math.max(0, STILL_FRAME_INTERVAL_MS - (Date.now() - started));
      await new Promise<void>((resolve) => {
        stillsTimer = setTimeout(() => {
          stillsTimer = null;
          resolve();
        }, wait);
      });
    }
  };

  /** `inputOnly` keeps a socket for input beside polled stills, so its reconnects leave them alone. */
  const connectAndroid = (inputOnly: boolean) => {
    if (stopped) return;
    const ws = transport.socket(deviceHubPaths.androidSocket(device, inputOnly));
    socket = ws;
    ws.addEventListener("open", () => {
      if (stopped || socket !== ws) return;
      if (!inputOnly) connecting();
      events.onInputConnected(true);
    });
    ws.addEventListener("message", (event) => {
      if (stopped || socket !== ws || inputOnly) return;
      if (typeof event.data === "string") {
        // The encoder restarts at a new size when the device rotates; the
        // next keyframe carries a fresh SPS, so the decoder is rebuilt from it.
        if (isVideoSessionMessage(event.data)) {
          closeDecoder();
          configuring = false;
          connecting();
          requestKeyframe();
        }
        return;
      }
      const packet = parseSemuPacket(event.data);
      const needsScan =
        packet.isKey === null ||
        (packet.isKey && (!videoDecoder || videoDecoder.state !== "configured"));
      const scanned = needsScan ? scanAccessUnit(packet.data) : null;
      const isKey = packet.isKey ?? scanned?.isKey ?? false;
      if (scanned?.sps && (!videoDecoder || videoDecoder.state !== "configured")) {
        if (configuring) return;
        configuring = true;
        const epoch = decoderEpoch;
        const isCurrent = () => !stopped && socket === ws;
        void configureDecoder({ codec: avcCodecString(scanned.sps) }, isCurrent).then(
          (configured) => {
            if (!isCurrent() || epoch !== decoderEpoch) return;
            configuring = false;
            awaitingKeyframe = true;
            if (configured) requestKeyframe();
          },
        );
        return;
      }
      if (!videoDecoder || videoDecoder.state !== "configured") {
        if (!isKey) requestKeyframe();
        return;
      }
      decode(isKey, packet.data, packet.timestamp);
    });
    ws.addEventListener("close", (event) => {
      if (socket !== ws) return;
      socket = null;
      if (!inputOnly) closeDecoder();
      if (stopped) return;
      events.onInputConnected(false, event.reason || `closed ${event.code}`);
      if (!inputOnly) {
        configuring = false;
        connecting(event.reason || undefined);
      }
      scheduleRetry("input", () => connectAndroid(inputOnly));
    });
  };

  /** The ordinary iOS video, AVCC or MJPEG, whichever this browser plays. */
  const startMainVideo = () => {
    mainVideo = true;
    if (mode === "mjpeg") void readIosMjpeg();
    else void readIosVideo();
  };

  const stopMainVideo = () => {
    mainVideo = false;
    videoGeneration++;
    controller?.abort();
    controller = null;
    closeDecoder();
    const retry = retryTimers.get("video");
    if (retry) clearTimeout(retry);
    retryTimers.delete("video");
    if (videoReadTimer !== null) clearTimeout(videoReadTimer);
    videoReadTimer = null;
  };

  const stopPanelFeed = () => {
    const feed = panelFeed;
    panelFeed = null;
    feed?.client.stop();
    if (feed) events.onDuoPanel?.(null);
  };

  /**
   * iPhone Duo: the fixed feed of the display in front while panels are
   * wanted and offered, the ordinary stream otherwise. The panel that went
   * out of front keeps its last picture in its own sink.
   */
  const chooseVideoSource = () => {
    if (stopped || !ios || panelId !== undefined) return;
    const panel: DuoPanelId = screen?.screenId === 1 ? 1 : 3;
    const sinks = panelSinks;
    if (!sinks || !screen?.supportsHingeAngle || panelsRefused || !useWebCodecs) {
      stopPanelFeed();
      if (!mainVideo) startMainVideo();
      return;
    }
    if (panelFeed?.panel === panel) return;
    if (mainVideo) stopMainVideo();
    stopPanelFeed();
    const output = panel === 1 ? sinks.cover : sinks.inner;
    const client = createDeviceStreamClient(
      { platform, deviceId, transport, panelId: panel },
      {
        present: (source, width, height) => {
          if (panelFeed?.client !== client) return true;
          if (!output.present(source, width, height)) return false;
          frameReceived();
          return true;
        },
      },
      {
        onStatus: (status, detail) => {
          if (status !== "error" || panelFeed?.client !== client) return;
          panelsRefused = true;
          stopPanelFeed();
          events.onDuoUnavailable?.(detail ?? "The Duo display feeds stopped.");
          chooseVideoSource();
        },
        onScreen: () => {},
        onInputConnected: () => {},
      },
    );
    panelFeed = { panel, client };
    events.onDuoPanel?.(panel);
    client.start();
  };

  const start = () => {
    if (!stopped) return;
    stopped = false;
    generation++;
    configuring = false;
    iosInputAdmitted = false;
    iosInputUnavailable = false;
    connecting();
    if (ios && panelId !== undefined) {
      // A Duo display's fixed feed: its owner holds the input socket.
      setMode("video");
      void readIosVideo();
    } else if (ios) {
      void connectIosInput();
      mainVideo = true;
      if (useWebCodecs) {
        setMode("video");
        void readIosVideo();
      } else {
        mode = "video";
        fallBackToMjpeg();
      }
    } else if (useWebCodecs) {
      setMode("video");
      connectAndroid(false);
    } else {
      setMode("stills");
      connectAndroid(true);
      void pollStills();
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    generation++;
    videoGeneration++;
    mainVideo = false;
    pendingOrientation = null;
    duoControl.clear();
    stopPanelFeed();
    // A refusal belongs to the helper this session reached; the next start asks again.
    panelsRefused = false;
    clearFrameTimer();
    if (videoReadTimer !== null) clearTimeout(videoReadTimer);
    videoReadTimer = null;
    if (stillsTimer !== null) clearTimeout(stillsTimer);
    stillsTimer = null;
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
    primeController?.abort();
    primeController = null;
    controller?.abort();
    controller = null;
    const discarded = socket;
    socket = null;
    discarded?.close();
    closeDecoder();
  };

  const send = (payload: Uint8Array<ArrayBuffer> | string) => {
    if (
      !stopped &&
      (!ios || (iosInputAdmitted && !iosInputUnavailable)) &&
      socket?.readyState === DEVICE_SOCKET_OPEN
    )
      socket.send(payload);
  };

  const rawPoint = (x: number, y: number) => {
    // serve-sim streams the raw framebuffer; rotated devices need input
    // remapped into that raw space.
    if (!ios || !screen || screen.width > screen.height) return { x, y };
    switch (screen.orientation) {
      case "landscape_left":
        return { x: y, y: 1 - x };
      case "landscape_right":
        return { x: 1 - y, y: x };
      case "portrait_upside_down":
        return { x: 1 - x, y: 1 - y };
      default:
        return { x, y };
    }
  };

  return {
    start,
    stop,
    sendRawTouch: (phase, x, y) => {
      if (ios) send(taggedJson(IOS_MSG_TOUCH, { type: phase, x, y }));
    },
    controlDuo: (command) => {
      if (ios && panelId === undefined) duoControl.enqueue(command);
    },
    setDuoPanels: (panels) => {
      if (!ios || panelId !== undefined || panelSinks === panels) return;
      panelSinks = panels;
      chooseVideoSource();
    },
    sendTouch: (phase, x, y) => {
      if (ios) {
        send(taggedJson(IOS_MSG_TOUCH, { type: phase, ...rawPoint(x, y) }));
        return;
      }
      const action = phase === "begin" ? "down" : phase === "move" ? "move" : "up";
      send(JSON.stringify({ type: "touch", action, x, y }));
    },
    sendKey: (event, phase) => {
      if (ios) {
        const usage = hidUsageForCode(event.code);
        if (usage !== null) send(taggedJson(IOS_MSG_KEY, { type: phase, usage }));
        return;
      }
      if (phase !== "down") return;
      if (event.key === "Escape") return send(JSON.stringify({ type: "back" }));
      const keycode = ANDROID_KEYCODE_BY_KEY[event.key];
      if (keycode !== undefined) return send(JSON.stringify({ type: "key", keycode }));
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
        send(JSON.stringify({ type: "text", text: event.key }));
      }
    },
    sendText: (text) => {
      if (ios) {
        // Typed as key presses: a phone's on-screen keyboard gives text, not keys.
        const shift = HID_USAGE_BY_CODE.ShiftLeft!;
        for (const character of text) {
          const stroke = iosKeystrokeForCharacter(character);
          if (!stroke) continue;
          if (stroke.shift) send(taggedJson(IOS_MSG_KEY, { type: "down", usage: shift }));
          send(taggedJson(IOS_MSG_KEY, { type: "down", usage: stroke.usage }));
          send(taggedJson(IOS_MSG_KEY, { type: "up", usage: stroke.usage }));
          if (stroke.shift) send(taggedJson(IOS_MSG_KEY, { type: "up", usage: shift }));
        }
        return;
      }
      let chunk = "";
      let chunkBytes = 0;
      let sentChunks = 0;
      for (const character of text) {
        const characterBytes = utf8ByteLength(character.codePointAt(0)!);
        if (chunkBytes + characterBytes > ANDROID_MAX_TEXT_BYTES) {
          send(JSON.stringify({ type: "text", text: chunk }));
          if (++sentChunks >= ANDROID_MAX_TEXT_CHUNKS) return;
          chunk = "";
          chunkBytes = 0;
        }
        chunk += character;
        chunkBytes += characterBytes;
      }
      if (chunk.length > 0) send(JSON.stringify({ type: "text", text: chunk }));
    },
    pressButton: (button) => {
      if (ios) {
        const name =
          button === "home"
            ? "home"
            : button === "appSwitcher" || button === "recents"
              ? "app_switcher"
              : button === "power"
                ? "lock"
                : null;
        if (name) send(taggedJson(IOS_MSG_BUTTON, { button: name }));
        return;
      }
      const type = button === "appSwitcher" ? "recents" : button;
      send(JSON.stringify({ type }));
    },
    rotate: () => {
      if (!ios) return;
      const current = screen?.orientation ?? "portrait";
      const next =
        IOS_ORIENTATIONS[(IOS_ORIENTATIONS.indexOf(current) + 1) % IOS_ORIENTATIONS.length]!;
      // A Duo takes orientation in turn with its hinge commands.
      if (screen?.supportsHingeAngle) duoControl.enqueue({ control: "orientation", value: next });
      else send(taggedJson(IOS_MSG_ORIENTATION, { orientation: next }));
    },
  };
}
