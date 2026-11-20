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
  /^\/vendor\/serve-sim\/helper\/[^/]+\/(stream\.mjpeg|stream\.avcc|config|health|ax|foreground)$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/panel\/(1|3)\/stream\.avcc$/,
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

/**
 * Whether a client may open `path` this way. Segments that a URL parser
 * would rewrite (`.`, `..`, escapes, backslashes, empty) are refused outright,
 * so what is checked is what reaches the hub.
 */
export const isAllowedDevicePath = (kind: "GET" | "POST" | "ws", path: string): boolean => {
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

const oneEvent = (event: DeviceChannelEvent): Stream.Stream<DeviceChannelEvent> =>
  Stream.succeed(event);

const failure = (reason: DeviceChannelError["reason"], detail: string) =>
  new DeviceChannelError({ reason, detail });

/** Slices of at most DEVICE_CHANNEL_CHUNK_BYTES, base64. */
const toChunks = (bytes: Uint8Array): ReadonlyArray<string> => {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Array<string> = [];
  for (let offset = 0; offset < buffer.length; offset += DEVICE_CHANNEL_CHUNK_BYTES) {
    chunks.push(buffer.subarray(offset, offset + DEVICE_CHANNEL_CHUNK_BYTES).toString("base64"));
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
  /** Set for a ws channel. */
  readonly socket: WebSocket | null;
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
      onCredit: () => {
        if (channel.unacknowledged < DEVICE_CHANNEL_WINDOW_BYTES) Latch.openUnsafe(credited);
      },
      socket: null,
      nextSeq: 0,
      waiting: new Map(),
    };
    yield* register(connectionId, input.channelId, channel, () => Latch.openUnsafe(credited));

    // Waits for credit before each slice goes out: the body is pulled only as fast as the client takes it.
    const paced = (slices: Stream.Stream<string, DeviceChannelError>) =>
      slices.pipe(
        Stream.mapEffect((data) =>
          Effect.gen(function* () {
            yield* credited.await;
            // Exact decoded size: the client credits decoded bytes, so an estimate would drift.
            channel.unacknowledged += Buffer.byteLength(data, "base64");
            if (channel.unacknowledged >= DEVICE_CHANNEL_WINDOW_BYTES) Latch.closeUnsafe(credited);
            return { _tag: "data", data } as const;
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
    const url = `${hub.origin}${input.path}${upstreamSearch(input.query)}`;
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
    if (!isAllowedDevicePath("ws", input.path)) {
      return yield* failure("forbidden", "That device path is not available.");
    }
    const hub = yield* hubOrUnavailable;
    const url = `${hub.origin.replace(/^http/, "ws")}${input.path}${upstreamSearch(input.query)}`;
    const queue = yield* Queue.unbounded<DeviceChannelEvent, DeviceChannelError | Cause.Done>();
    let paused = false;
    // An `error` with no listener would take the server down: one is on from the start.
    const socket = new WebSocket(url, input.protocols ? [...input.protocols] : [], {
      headers: { authorization: `Bearer ${hub.token}` },
      handshakeTimeout: OPEN_TIMEOUT_MS,
      perMessageDeflate: false,
    });
    socket.binaryType = "nodebuffer";
    const channel: Channel = {
      unacknowledged: 0,
      onCredit: () => {
        if (paused && channel.unacknowledged < DEVICE_CHANNEL_WINDOW_BYTES / 2) {
          paused = false;
          socket.resume();
        }
      },
      socket,
      nextSeq: 0,
      waiting: new Map(),
    };
    const fail = (error: DeviceChannelError) => {
      settleWaiting(channel, error);
      Queue.failCauseUnsafe(queue, Cause.fail(error));
      socket.terminate();
    };
    socket.on("error", (error) => fail(failure("broken", error.message)));
    yield* register(connectionId, input.channelId, channel, () => socket.terminate());

    socket.on("message", (data: Buffer | ArrayBuffer | Array<Buffer>, isBinary: boolean) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      if (isBinary) {
        const parts = toChunks(bytes);
        parts.forEach((part, index) =>
          Queue.offerUnsafe(queue, {
            _tag: "message",
            data: part,
            binary: true,
            final: index === parts.length - 1,
          }),
        );
        if (parts.length === 0)
          Queue.offerUnsafe(queue, { _tag: "message", data: "", binary: true, final: true });
      } else {
        const text = bytes.toString("utf8");
        const step = DEVICE_CHANNEL_CHUNK_BYTES / 4;
        for (let offset = 0; offset < Math.max(text.length, 1); offset += step) {
          Queue.offerUnsafe(queue, {
            _tag: "message",
            data: text.slice(offset, offset + step),
            binary: false,
            final: offset + step >= text.length,
          });
        }
      }
      channel.unacknowledged += bytes.length;
      if (channel.unacknowledged > DEVICE_CHANNEL_WINDOW_BYTES + DEVICE_CHANNEL_SLOW_BYTES) {
        fail(failure("slow", "The device stream got too far ahead of this client."));
        return;
      }
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
      if (socket.readyState === WebSocket.OPEN) return resume(Effect.void);
      socket.once("open", () => resume(Effect.void));
      socket.once("unexpected-response", (_request, response) => {
        resume(
          Effect.fail(
            failure("unreachable", `The device hub refused the socket (${response.statusCode}).`),
          ),
        );
        socket.terminate();
      });
      socket.once("close", () =>
        resume(Effect.fail(failure("unreachable", "The device hub closed the socket."))),
      );
      socket.once("error", (error) => resume(Effect.fail(failure("unreachable", error.message))));
    });
    return Stream.fromQueue(queue);
  });

  const open: DeviceChannelsShape["open"] = (connectionId, input) =>
    input._tag === "http" ? openHttp(connectionId, input) : openWs(connectionId, input);

  const send: DeviceChannelsShape["send"] = (connectionId, input) =>
    Effect.gen(function* () {
      const channel = channels.get(keyOf(connectionId, input.channelId));
      if (channel === undefined || channel.socket === null) {
        return yield* failure("unknownChannel", "That device channel is not open.");
      }
      const socket = channel.socket;
      if (
        input.seq < channel.nextSeq ||
        channel.waiting.has(input.seq) ||
        channel.waiting.size >= MAX_SENDS_OUT_OF_ORDER
      ) {
        const error = failure("limit", "The channel's messages arrived out of all order.");
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
