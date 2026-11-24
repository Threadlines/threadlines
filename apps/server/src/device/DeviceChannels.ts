/**
 * The device channel (docs/design/devices.md, "Transport"): every byte
 * between a Device tab and the hub rides the client's WS RPC connection, so
 * the desktop app, a browser, a phone and a saved computer over the relay all
 * reach the hub the same way. Modeled on PreviewTunnel.
 *
 * The hub is never reachable from a client directly. A channel opens only on
 * a path the allowlist below names, with the hub's token added here (clients
 * never see it) and nothing of the client's but the path, query and body.
 * serve-sim's `/api` body carries the token of its shell-exec route, so
 * neither `/vendor/serve-sim/api` nor `/vendor/serve-emu/api` is allowed.
 *
 * Flow control, so a suspended phone cannot pile video up in the server:
 * events carry at most DEVICE_CHANNEL_CHUNK_BYTES; at most
 * DEVICE_CHANNEL_WINDOW_BYTES may be sent and not yet credited. An http body
 * then simply stops being read (the hub's socket backs up). A ws upstream is
 * paused; when more than DEVICE_CHANNEL_SLOW_BYTES queue up past the window
 * anyway, the channel fails with `slow` and the client opens a fresh one.
 */
import {
  DEVICE_CHANNEL_CHUNK_BYTES,
  DEVICE_CHANNEL_WINDOW_BYTES,
  type DeviceChannelCredit,
  DeviceChannelError,
  type DeviceChannelEvent,
  type DeviceChannelOpen,
  type DeviceChannelSend,
} from "@threadlines/contracts";
import { WebSocket } from "@effect/platform-node/NodeWS";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import { DeviceService } from "./DeviceService.ts";
import { repeatStillFrame } from "./mjpegStillFrame.ts";

/** Channels one connection may hold open: a Device tab uses two or three. */
export const DEVICE_CHANNEL_MAX_PER_CONNECTION = 16;
/** What a paused ws upstream may still queue past the window before the channel fails `slow`. */
export const DEVICE_CHANNEL_SLOW_BYTES = 4 * 1024 * 1024;
const OPEN_TIMEOUT_MS = 10_000;
const MAX_SENDS_OUT_OF_ORDER = 64;

/** Read routes and stream routes, for GET. */
const GET_PATHS: ReadonlyArray<RegExp> = [
  /^\/api\/devices$/,
  /^\/vendor\/serve-sim\/api\/screenshot$/,
  /^\/vendor\/serve-sim\/api\/event-log(\/events)?$/,
  /^\/vendor\/serve-sim\/helper\/[A-Za-z0-9._-]+\/(stream\.mjpeg|stream\.avcc|config|health|ax|foreground)$/,
  /^\/vendor\/serve-sim\/helper\/[A-Za-z0-9._-]+\/panel\/(1|3)\/stream\.avcc$/,
  /^\/vendor\/serve-sim\/appstate$/,
  /^\/vendor\/serve-emu\/api\/(devices|screenshot|stream-mode|stream-settings|accessibility|fold)$/,
  /^\/vendor\/serve-emu\/health$/,
];

/** The few routes that take a POST: screenshot capture and stream tuning. */
const POST_PATHS: ReadonlyArray<RegExp> = [
  /^\/vendor\/serve-sim\/api\/screenshot$/,
  /^\/vendor\/serve-emu\/api\/(screenshot|stream-mode|stream-settings|fold)$/,
];

/** Sockets: the device list, iOS input, and Android's video and input. */
const WS_PATHS: ReadonlyArray<RegExp> = [
  /^\/api\/devices\/ws$/,
  /^\/vendor\/serve-sim\/helper\/ws$/,
  /^\/vendor\/serve-emu\/ws$/,
];

const SCREENSHOT_PATHS = new Set([
  "/vendor/serve-sim/api/screenshot",
  "/vendor/serve-emu/api/screenshot",
]);

/** RFC 6455 subprotocol token: ASCII visible non-separator characters. */
const WS_PROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const areValidProtocols = (protocols: ReadonlyArray<string> | undefined): boolean => {
  if (protocols === undefined || protocols.length === 0) return true;
  const seen = new Set<string>();
  for (const protocol of protocols) {
    if (!WS_PROTOCOL_TOKEN.test(protocol) || seen.has(protocol)) return false;
    seen.add(protocol);
  }
  return true;
};

/**
 * Whether a client may open `path` this way. Control characters, whitespace,
 * query/fragment markers, and segments a URL parser would rewrite (`.`, `..`,
 * escapes, backslashes, empty) are refused outright, so what is checked is
 * what reaches the hub.
 */
export const isAllowedDevicePath = (kind: "GET" | "POST" | "ws", path: string): boolean => {
  if (!path.startsWith("/") || /[\x00-\x1f\x7f?#\s]/.test(path)) return false;
  const segments = path.split("/").slice(1);
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.includes("%") ||
        segment.includes("\\"),
    )
  ) {
    return false;
  }
  const patterns = kind === "ws" ? WS_PATHS : kind === "POST" ? POST_PATHS : GET_PATHS;
  return patterns.some((pattern) => pattern.test(path));
};

/** The query a client sent, without anything that could carry a token of its own. */
const upstreamSearch = (query: Readonly<Record<string, string>> | undefined) => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query ?? {})) {
    if (name.toLowerCase() === "token") continue;
    params.append(name, value);
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
};

/** Builds a hub URL and verifies WHATWG URL normalization left `path` unchanged. */
const canonicalHubUrl = (
  origin: string,
  path: string,
  query: Readonly<Record<string, string>> | undefined,
): Effect.Effect<string, DeviceChannelError> =>
  Effect.try({
    try: () => {
      const url = `${origin}${path}${upstreamSearch(query)}`;
      const parsed = new URL(url);
      if (parsed.pathname !== path) {
        throw new Error("Path changed under URL normalization.");
      }
      return url;
    },
    catch: () => failure("forbidden", "That device path is not available."),
  });

const oneEvent = (event: DeviceChannelEvent): Stream.Stream<DeviceChannelEvent> =>
  Stream.succeed(event);

const failure = (reason: DeviceChannelError["reason"], detail: string) =>
  new DeviceChannelError({ reason, detail });

interface Chunk {
  /** base64 */
  readonly data: string;
  /** Exact decoded byte count: what the client credits back. */
  readonly bytes: number;
}

/** Slices of at most DEVICE_CHANNEL_CHUNK_BYTES, base64. */
const toChunks = (bytes: Uint8Array): ReadonlyArray<Chunk> => {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Array<Chunk> = [];
  for (let offset = 0; offset < buffer.length; offset += DEVICE_CHANNEL_CHUNK_BYTES) {
    const slice = buffer.subarray(offset, offset + DEVICE_CHANNEL_CHUNK_BYTES);
    chunks.push({ data: slice.toString("base64"), bytes: slice.length });
  }
  return chunks;
};

interface PendingSend {
  readonly data: Buffer | string;
  readonly done: Deferred.Deferred<void, DeviceChannelError>;
}

interface Channel {
  /** Bytes sent down the channel that the client has not yet credited. */
  unacknowledged: number;
  /** Credit arrived: let a waiting http body continue, or resume a paused socket. */
  readonly onCredit: () => void;
  /** Set for a ws channel once the upstream socket is created. */
  socket: WebSocket | null;
  nextSeq: number;
  readonly waiting: Map<number, PendingSend>;
}

export interface DeviceChannelsShape {
  /** Opens one channel. Scoped: the subscription ending closes it. */
  readonly open: (
    connectionId: string,
    input: DeviceChannelOpen,
  ) => Effect.Effect<
    Stream.Stream<DeviceChannelEvent, DeviceChannelError>,
    DeviceChannelError,
    Scope.Scope
  >;
  /** One ws message for the hub, in `seq` order; done once written to the hub's socket. */
  readonly send: (
    connectionId: string,
    input: DeviceChannelSend,
  ) => Effect.Effect<void, DeviceChannelError>;
  /** The client's decoder took more of a channel's data. */
  readonly credit: (connectionId: string, input: DeviceChannelCredit) => Effect.Effect<void>;
  /** The connection went away: every channel it held closes. */
  readonly releaseConnection: (connectionId: string) => Effect.Effect<void>;
}

export class DeviceChannels extends Context.Service<DeviceChannels, DeviceChannelsShape>()(
  "@threadlines/server/device/DeviceChannels",
) {}

export const make = Effect.gen(function* () {
  const devices = yield* DeviceService;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const channels = new Map<string, Channel>();
  /** Every channel's closer, by connection, for `releaseConnection`. */
  const closers = new Map<string, Map<string, () => void>>();
  const keyOf = (connectionId: string, channelId: string) => `${connectionId}\u0000${channelId}`;

  const settleWaiting = (channel: Channel, error: DeviceChannelError) => {
    for (const pending of channel.waiting.values())
      Deferred.doneUnsafe(pending.done, Exit.fail(error));
    channel.waiting.clear();
  };

  /** Holds the connection's slot and the channel's entry until the scope closes. */
  const register = (connectionId: string, channelId: string, channel: Channel, close: () => void) =>
    Effect.gen(function* () {
      const key = keyOf(connectionId, channelId);
      const held = closers.get(connectionId) ?? new Map<string, () => void>();
      if (channels.has(key)) return yield* failure("limit", "That channel is already open.");
      if (held.size >= DEVICE_CHANNEL_MAX_PER_CONNECTION) {
        return yield* failure("limit", `Too many device channels are open (${held.size}).`);
      }
      held.set(channelId, close);
      closers.set(connectionId, held);
      channels.set(key, channel);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (channels.get(key) === channel) channels.delete(key);
          held.delete(channelId);
          if (held.size === 0 && closers.get(connectionId) === held) closers.delete(connectionId);
          settleWaiting(channel, failure("broken", "The channel closed."));
          close();
        }),
      );
    });

  const hubOrUnavailable = devices.currentHub.pipe(
    Effect.flatMap((hub) =>
      hub
        ? Effect.succeed(hub)
        : Effect.fail(failure("unavailable", "The device hub is not running.")),
    ),
  );

  const openHttp = Effect.fn("DeviceChannels.openHttp")(function* (
    connectionId: string,
    input: Extract<DeviceChannelOpen, { _tag: "http" }>,
  ) {
    if (!isAllowedDevicePath(input.method, input.path)) {
      return yield* failure("forbidden", "That device path is not available.");
    }
    const credited = yield* Latch.make(true);
    const channel: Channel = {
      unacknowledged: 0,
      // The sender checks again whether its slice fits; a credit only wakes it.
      onCredit: () => Latch.openUnsafe(credited),
      socket: null,
      nextSeq: 0,
      waiting: new Map(),
    };
    yield* register(connectionId, input.channelId, channel, () => Latch.openUnsafe(credited));

    // Waits for credit before each slice goes out: the body is pulled only as fast as the client takes it.
    // A slice goes out only when it fits in the window whole (or nothing is outstanding).
    const paced = (slices: Stream.Stream<Chunk, DeviceChannelError>) =>
      slices.pipe(
        Stream.mapEffect((chunk) =>
          Effect.gen(function* () {
            while (
              channel.unacknowledged > 0 &&
              channel.unacknowledged + chunk.bytes > DEVICE_CHANNEL_WINDOW_BYTES
            ) {
              Latch.closeUnsafe(credited);
              yield* credited.await;
            }
            channel.unacknowledged += chunk.bytes;
            return { _tag: "data", data: chunk.data } as const;
          }),
        ),
      );

    // A screenshot asked for by device is the server's own, checked to be one PNG.
    const screenshotDevice = input.query?.device;
    if (SCREENSHOT_PATHS.has(input.path) && screenshotDevice) {
      const shot = yield* devices
        .screenshot(screenshotDevice)
        .pipe(Effect.mapError((error) => failure("unreachable", error.message)));
      return Stream.concat(
        oneEvent({ _tag: "opened", status: 200, contentType: "image/png" }),
        Stream.concat(paced(Stream.fromIterable(toChunks(shot.png))), oneEvent({ _tag: "end" })),
      );
    }

    const hub = yield* hubOrUnavailable;
    const url = yield* canonicalHubUrl(hub.origin, input.path, input.query);
    const request = (
      input.method === "POST" ? HttpClientRequest.post(url) : HttpClientRequest.get(url)
    ).pipe(
      HttpClientRequest.bearerToken(hub.token),
      HttpClientRequest.setHeader("accept-encoding", "identity"),
      input.body === undefined
        ? (self) => self
        : HttpClientRequest.bodyUint8Array(
            Buffer.from(input.body, "base64"),
            input.contentType ?? "application/octet-stream",
          ),
    );
    const response = yield* httpClient.execute(request).pipe(
      Effect.timeout(OPEN_TIMEOUT_MS),
      Effect.mapError(() => failure("unreachable", "The device hub did not answer.")),
    );
    const contentType = response.headers["content-type"];
    // A multipart MJPEG body re-sends its last frame once the screen goes still.
    const body = contentType?.startsWith("multipart/x-mixed-replace")
      ? repeatStillFrame(response.stream)
      : response.stream;
    const slices = body.pipe(
      Stream.mapError(() => failure("broken", "The device hub stopped sending.")),
      Stream.flatMap((bytes) => Stream.fromIterable(toChunks(bytes))),
    );
    return Stream.concat(
      oneEvent({
        _tag: "opened",
        status: response.status,
        ...(contentType ? { contentType } : {}),
      }),
      Stream.concat(paced(slices), oneEvent({ _tag: "end" })),
    );
  });

  const openWs = Effect.fn("DeviceChannels.openWs")(function* (
    connectionId: string,
    input: Extract<DeviceChannelOpen, { _tag: "ws" }>,
  ) {
    if (!isAllowedDevicePath("ws", input.path) || !areValidProtocols(input.protocols)) {
      return yield* failure("forbidden", "That device path is not available.");
    }
    const hub = yield* hubOrUnavailable;
    const url = yield* canonicalHubUrl(hub.origin.replace(/^http/, "ws"), input.path, input.query);
    const queue = yield* Queue.unbounded<DeviceChannelEvent, DeviceChannelError | Cause.Done>();
    let paused = false;
    const channel: Channel = {
      unacknowledged: 0,
      onCredit: () => {
        if (paused && channel.unacknowledged < DEVICE_CHANNEL_WINDOW_BYTES / 2) {
          paused = false;
          channel.socket?.resume();
        }
      },
      socket: null,
      nextSeq: 0,
      waiting: new Map(),
    };
    // The slot first: a channel refused for the limit or a reused id never reaches the hub.
    yield* register(connectionId, input.channelId, channel, () => channel.socket?.terminate());
    // An `error` with no listener would take the server down: one is on from the start.
    const socket = yield* Effect.try({
      try: () =>
        new WebSocket(url, input.protocols ? [...input.protocols] : [], {
          headers: { authorization: `Bearer ${hub.token}` },
          handshakeTimeout: OPEN_TIMEOUT_MS,
          perMessageDeflate: false,
        }),
      catch: (error) =>
        failure("forbidden", error instanceof Error ? error.message : "Invalid device socket."),
    });
    socket.binaryType = "nodebuffer";
    channel.socket = socket;
    const fail = (error: DeviceChannelError) => {
      settleWaiting(channel, error);
      Queue.failCauseUnsafe(queue, Cause.fail(error));
      socket.terminate();
    };
    socket.on("error", (error) => fail(failure("broken", error.message)));

    socket.on("message", (data: Buffer | ArrayBuffer | Array<Buffer>, isBinary: boolean) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      // Paused, the socket may still hand over what it had read: past the cap, the client is gone.
      if (
        channel.unacknowledged + bytes.length >
        DEVICE_CHANNEL_WINDOW_BYTES + DEVICE_CHANNEL_SLOW_BYTES
      ) {
        fail(failure("slow", "The device stream got too far ahead of this client."));
        return;
      }
      if (isBinary) {
        const parts = toChunks(bytes);
        parts.forEach((part, index) =>
          Queue.offerUnsafe(queue, {
            _tag: "message",
            data: part.data,
            binary: true,
            final: index === parts.length - 1,
          }),
        );
        if (parts.length === 0)
          Queue.offerUnsafe(queue, { _tag: "message", data: "", binary: true, final: true });
      } else {
        const text = bytes.toString("utf8");
        const step = DEVICE_CHANNEL_CHUNK_BYTES / 4;
        if (text.length === 0) {
          Queue.offerUnsafe(queue, { _tag: "message", data: "", binary: false, final: true });
        } else {
          for (let offset = 0; offset < text.length;) {
            let end = Math.min(offset + step, text.length);
            // Keep UTF-16 surrogate pairs together so JSON chunks stay valid UTF-8 and credit stays exact.
            if (end < text.length) {
              const last = text.charCodeAt(end - 1);
              if (last >= 0xd800 && last <= 0xdbff && end - offset > 1) end -= 1;
            }
            Queue.offerUnsafe(queue, {
              _tag: "message",
              data: text.slice(offset, end),
              binary: false,
              final: end >= text.length,
            });
            offset = end;
          }
        }
      }
      channel.unacknowledged += bytes.length;
      if (!paused && channel.unacknowledged >= DEVICE_CHANNEL_WINDOW_BYTES) {
        paused = true;
        socket.pause();
      }
    });
    socket.on("close", (code: number, reason: Buffer) => {
      settleWaiting(channel, failure("broken", "The device socket closed."));
      const text = reason.toString("utf8");
      Queue.offerUnsafe(queue, { _tag: "end", code, ...(text ? { reason: text } : {}) });
      Queue.endUnsafe(queue);
    });
    socket.once("open", () => {
      Queue.offerUnsafe(queue, {
        _tag: "opened",
        ...(socket.protocol ? { protocol: socket.protocol } : {}),
      });
    });
    yield* Effect.callback<void, DeviceChannelError>((resume) => {
      if (socket.readyState === WebSocket.OPEN) {
        resume(Effect.void);
        return;
      }
      if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
        resume(Effect.fail(failure("unreachable", "The device hub closed the socket.")));
        return;
      }
      const cleanup = () => {
        socket.off("open", onOpen);
        socket.off("unexpected-response", onUnexpected);
        socket.off("close", onClose);
        socket.off("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resume(Effect.void);
      };
      const onUnexpected = (_request: unknown, response: { readonly statusCode?: number }) => {
        cleanup();
        resume(
          Effect.fail(
            failure("unreachable", `The device hub refused the socket (${response.statusCode}).`),
          ),
        );
        socket.terminate();
      };
      const onClose = () => {
        cleanup();
        resume(Effect.fail(failure("unreachable", "The device hub closed the socket.")));
      };
      const onError = (error: Error) => {
        cleanup();
        resume(Effect.fail(failure("unreachable", error.message)));
      };
      socket.once("open", onOpen);
      socket.once("unexpected-response", onUnexpected);
      socket.once("close", onClose);
      socket.once("error", onError);
      return Effect.sync(cleanup);
    });
    return Stream.fromQueue(queue);
  });

  const open: DeviceChannelsShape["open"] = (connectionId, input) =>
    input._tag === "http" ? openHttp(connectionId, input) : openWs(connectionId, input);

  const send: DeviceChannelsShape["send"] = (connectionId, input) =>
    Effect.gen(function* () {
      const channel = channels.get(keyOf(connectionId, input.channelId));
      if (
        channel === undefined ||
        channel.socket === null ||
        channel.socket.readyState === WebSocket.CONNECTING
      ) {
        return yield* failure("unknownChannel", "That device channel is not open.");
      }
      const socket = channel.socket;
      if (
        input.seq < channel.nextSeq ||
        channel.waiting.has(input.seq) ||
        (input.seq !== channel.nextSeq && channel.waiting.size >= MAX_SENDS_OUT_OF_ORDER)
      ) {
        const error = failure("limit", "The channel's messages arrived out of all order.");
        settleWaiting(channel, error);
        socket.terminate();
        return yield* error;
      }
      if (socket.bufferedAmount > DEVICE_CHANNEL_WINDOW_BYTES) {
        const error = failure("slow", "The device hub stopped accepting input.");
        settleWaiting(channel, error);
        socket.terminate();
        return yield* error;
      }
      const done = yield* Deferred.make<void, DeviceChannelError>();
      channel.waiting.set(input.seq, {
        data: input.binary ? Buffer.from(input.data, "base64") : input.data,
        done,
      });
      // Writes every message whose turn has come, in order.
      for (;;) {
        const next = channel.waiting.get(channel.nextSeq);
        if (next === undefined) break;
        channel.waiting.delete(channel.nextSeq);
        channel.nextSeq += 1;
        if (socket.readyState !== WebSocket.OPEN) {
          Deferred.doneUnsafe(next.done, Exit.fail(failure("broken", "The device socket closed.")));
          continue;
        }
        socket.send(next.data, { binary: typeof next.data !== "string" }, (error) =>
          Deferred.doneUnsafe(
            next.done,
            error ? Exit.fail(failure("broken", error.message)) : Exit.void,
          ),
        );
      }
      yield* Deferred.await(done);
    });

  const credit: DeviceChannelsShape["credit"] = (connectionId, input) =>
    Effect.sync(() => {
      const channel = channels.get(keyOf(connectionId, input.channelId));
      if (channel === undefined) return;
      channel.unacknowledged = Math.max(0, channel.unacknowledged - input.bytes);
      channel.onCredit();
    });

  const releaseConnection: DeviceChannelsShape["releaseConnection"] = (connectionId) =>
    Effect.sync(() => {
      const held = closers.get(connectionId);
      if (!held) return;
      for (const close of held.values()) close();
    });

  return DeviceChannels.of({ open, send, credit, releaseConnection });
});

export const layer = Layer.effect(DeviceChannels, make);
