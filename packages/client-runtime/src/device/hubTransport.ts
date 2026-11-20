// @effect-diagnostics globalTimers:off - This browser transport runs without an Effect runtime, like the stream client it serves.
/**
 * The Device tab's way to the device hub (docs/design/devices.md, "Transport").
 *
 * Saved computers and the relay carry only the app's WS RPC connection, so the
 * viewer cannot fetch hub URLs or open sockets to them. This turns the device
 * channel RPCs into the two things the stream client needs: `fetch`, answering
 * a real `Response` whose body streams, and `socket`, a `WebSocket`-shaped
 * object. Paths are hub paths (`/vendor/serve-sim/...`) with an optional query.
 *
 * Flow control: a chunk is credited once its reader has taken it (a body read,
 * or its message listeners returning), never on arrival, so a stalled tab holds the hub
 * up instead of filling the server. Channels never resubscribe: when one
 * fails or the connection drops, the request errors or the socket closes, and
 * the caller opens a fresh one.
 */
import type {
  DeviceChannelCredit,
  DeviceChannelEvent,
  DeviceChannelOpen,
  DeviceChannelSend,
} from "@threadlines/contracts";

import { base64ToBytes, bytesToBase64 } from "./base64.ts";
import { DEVICE_MAX_FRAME_BYTES, DeviceFrameTooLargeError } from "./frameLimit.ts";

/** The three device channel RPCs, as the environment API exposes them. */
export interface DeviceChannelApi {
  /** Open until the returned call. `onClosed` comes once when it ends any other way. */
  readonly open: (
    input: DeviceChannelOpen,
    listener: (event: DeviceChannelEvent) => void,
    onClosed: (failure?: unknown) => void,
  ) => () => void;
  readonly send: (input: DeviceChannelSend) => Promise<void>;
  readonly credit: (input: DeviceChannelCredit) => Promise<void>;
}

export interface DeviceHubRequestInit {
  readonly method?: "GET" | "POST";
  readonly body?: Uint8Array | string;
  readonly contentType?: string;
  readonly signal?: AbortSignal;
}

export const DEVICE_SOCKET_CONNECTING = 0;
export const DEVICE_SOCKET_OPEN = 1;
export const DEVICE_SOCKET_CLOSING = 2;
export const DEVICE_SOCKET_CLOSED = 3;

export interface DeviceHubSocketCloseEvent {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

export interface DeviceHubSocketEventMap {
  readonly open: Record<string, never>;
  readonly message: { readonly data: ArrayBuffer | string };
  readonly close: DeviceHubSocketCloseEvent;
  readonly error: { readonly error: unknown };
}

type DeviceHubSocketListener<K extends keyof DeviceHubSocketEventMap> = (
  event: DeviceHubSocketEventMap[K],
) => void;

/** The part of `WebSocket` the stream client uses. Messages are `ArrayBuffer` or text. */
export interface DeviceHubSocket {
  readonly binaryType: "arraybuffer";
  readonly readyState: number;
  readonly protocol: string;
  readonly addEventListener: <K extends keyof DeviceHubSocketEventMap>(
    type: K,
    listener: DeviceHubSocketListener<K>,
  ) => void;
  readonly removeEventListener: <K extends keyof DeviceHubSocketEventMap>(
    type: K,
    listener: DeviceHubSocketListener<K>,
  ) => void;
  /** Dropped unless open: input from before a reconnect never reaches the new session. */
  readonly send: (data: string | ArrayBuffer | ArrayBufferView) => void;
  readonly close: (code?: number, reason?: string) => void;
}

export interface DeviceHubTransport {
  readonly fetch: (path: string, init?: DeviceHubRequestInit) => Promise<Response>;
  readonly socket: (path: string, protocols?: ReadonlyArray<string>) => DeviceHubSocket;
}

/** Credits go out in batches of at least this, or after `CREDIT_DELAY_MS`. */
const CREDIT_BATCH_BYTES = 64 * 1024;
const CREDIT_DELAY_MS = 40;
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

const textEncoder = new TextEncoder();

/** A random channel id; `crypto.randomUUID` is missing over plain-http LAN origins. */
function newChannelId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
  return `dc-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Splits `/a/b?x=1` into the hub path and its query, as the channel takes them. */
export function splitHubPath(path: string): {
  readonly path: string;
  readonly query?: Record<string, string>;
} {
  const mark = path.indexOf("?");
  if (mark < 0) return { path };
  const query: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(path.slice(mark + 1))) query[key] = value;
  return Object.keys(query).length === 0
    ? { path: path.slice(0, mark) }
    : { path: path.slice(0, mark), query };
}

/** Why a channel failed, as an `Error` the caller can show. */
function channelFailure(failure: unknown): Error {
  if (failure instanceof Error) return failure;
  const detail = (failure as { detail?: unknown } | null)?.detail;
  return new Error(typeof detail === "string" ? detail : "The device connection closed.");
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The request was aborted.", "AbortError");
}

function createCreditor(api: DeviceChannelApi, channelId: string) {
  let owed = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (closed || owed === 0) return;
    const bytes = owed;
    owed = 0;
    // A credit lost with the connection matters to nobody: the channel went too.
    void api.credit({ channelId, bytes }).catch(() => undefined);
  };
  return {
    take(bytes: number) {
      if (closed || bytes <= 0) return;
      owed += bytes;
      if (owed >= CREDIT_BATCH_BYTES) flush();
      else timer ??= setTimeout(flush, CREDIT_DELAY_MS);
    },
    close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/** The channel's unsubscribe, safe to call again. */
function once(stop: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    stop();
  };
}

function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  return data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function joinParts(parts: ReadonlyArray<Uint8Array>): ArrayBuffer {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined.buffer;
}

export function createDeviceHubTransport(
  api: DeviceChannelApi,
  options: { readonly channelId?: () => string } = {},
): DeviceHubTransport {
  const nextChannelId = options.channelId ?? newChannelId;

  const fetchThrough = (path: string, init: DeviceHubRequestInit = {}): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const { signal } = init;
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const channelId = nextChannelId();
      const creditor = createCreditor(api, channelId);
      const queue: Uint8Array[] = [];
      let waiting: ReadableStreamDefaultController<Uint8Array> | null = null;
      let ended = false;
      let failed: unknown = null;
      let opened = false;
      let done = false;
      let stop: () => void = () => {};

      // Hands one chunk to a waiting reader; that read is what earns the credit.
      const deliver = () => {
        const controller = waiting;
        if (controller === null) return;
        const chunk = queue.shift();
        if (chunk !== undefined) {
          waiting = null;
          controller.enqueue(chunk);
          creditor.take(chunk.byteLength);
          return;
        }
        if (failed !== null) {
          waiting = null;
          controller.error(failed);
        } else if (ended) {
          waiting = null;
          controller.close();
        }
      };

      const finish = () => {
        if (done) return;
        done = true;
        creditor.close();
        signal?.removeEventListener("abort", onAbort);
        stop();
      };

      const fail = (reason: unknown) => {
        if (!opened) {
          finish();
          reject(reason);
          return;
        }
        if (failed !== null || ended) return;
        failed = reason;
        queue.length = 0;
        finish();
        deliver();
      };

      function onAbort() {
        if (signal) fail(abortReason(signal));
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            waiting = controller;
            deliver();
          },
          cancel() {
            queue.length = 0;
            ended = true;
            finish();
          },
        },
        // Nothing is pulled ahead of a read, so a credit always means a reader took it.
        { highWaterMark: 0 },
      );

      const { path: hubPath, query } = splitHubPath(path);
      const bodyBytes =
        init.body === undefined
          ? undefined
          : typeof init.body === "string"
            ? textEncoder.encode(init.body)
            : init.body;
      stop = once(
        api.open(
          {
            _tag: "http",
            channelId,
            method: init.method ?? "GET",
            path: hubPath,
            ...(query ? { query } : {}),
            ...(bodyBytes ? { body: bytesToBase64(bodyBytes) } : {}),
            ...(init.contentType ? { contentType: init.contentType } : {}),
          },
          (event) => {
            if (done) return;
            switch (event._tag) {
              case "opened": {
                if (opened) return;
                const status = event.status ?? 200;
                if (status < 200 || status > 599) {
                  fail(new Error(`The device hub answered with status ${status}.`));
                  return;
                }
                opened = true;
                const headers = new Headers();
                if (event.contentType) headers.set("content-type", event.contentType);
                if (NULL_BODY_STATUSES.has(status)) {
                  resolve(new Response(null, { status, headers }));
                  ended = true;
                  finish();
                  return;
                }
                resolve(new Response(body, { status, headers }));
                return;
              }
              case "data": {
                const bytes = base64ToBytes(event.data);
                if (bytes.byteLength === 0) return;
                queue.push(bytes);
                deliver();
                return;
              }
              case "message":
                return;
              case "end": {
                if (!opened) {
                  fail(new Error("The device hub closed the request before answering."));
                  return;
                }
                ended = true;
                finish();
                deliver();
                return;
              }
            }
          },
          (failure) => {
            if (done) return;
            fail(
              failure === undefined
                ? new Error("The device connection closed.")
                : channelFailure(failure),
            );
          },
        ),
      );
      // `open` can fail synchronously into `onClosed`; drop the channel it never kept.
      if (done) stop();
    });

  const socket = (path: string, protocols?: ReadonlyArray<string>): DeviceHubSocket => {
    const channelId = nextChannelId();
    const creditor = createCreditor(api, channelId);
    let readyState = DEVICE_SOCKET_CONNECTING;
    let protocol = "";
    let seq = 0;
    let binaryParts: Uint8Array[] = [];
    let textParts: string[] = [];
    let partBytes = 0;
    let stop: () => void = () => {};
    const listeners: { [K in keyof DeviceHubSocketEventMap]: Set<DeviceHubSocketListener<K>> } = {
      open: new Set(),
      message: new Set(),
      close: new Set(),
      error: new Set(),
    };
    const dispatch = <K extends keyof DeviceHubSocketEventMap>(
      type: K,
      event: DeviceHubSocketEventMap[K],
    ) => {
      // A copy: a listener may remove itself while this runs.
      for (const listener of Array.from(listeners[type])) listener(event);
    };

    const closeWith = (event: DeviceHubSocketCloseEvent, error?: unknown) => {
      if (readyState === DEVICE_SOCKET_CLOSED) return;
      readyState = DEVICE_SOCKET_CLOSED;
      creditor.close();
      binaryParts = [];
      textParts = [];
      stop();
      if (error !== undefined) dispatch("error", { error });
      dispatch("close", event);
    };

    const handle: DeviceHubSocket = {
      binaryType: "arraybuffer",
      get readyState() {
        return readyState;
      },
      get protocol() {
        return protocol;
      },
      addEventListener(type, listener) {
        listeners[type].add(listener);
      },
      removeEventListener(type, listener) {
        listeners[type].delete(listener);
      },
      send(data) {
        if (readyState !== DEVICE_SOCKET_OPEN) return;
        const binary = typeof data !== "string";
        const message: DeviceChannelSend = {
          channelId,
          seq: seq++,
          binary,
          data: binary ? bytesToBase64(toBytes(data)) : data,
        };
        api.send(message).catch((failure: unknown) => {
          closeWith(
            { code: 1006, reason: channelFailure(failure).message, wasClean: false },
            failure,
          );
        });
      },
      close(code = 1000, reason = "") {
        if (readyState === DEVICE_SOCKET_CLOSED || readyState === DEVICE_SOCKET_CLOSING) return;
        readyState = DEVICE_SOCKET_CLOSING;
        creditor.close();
        stop();
        // Like a WebSocket, the close event follows the call instead of firing inside it.
        queueMicrotask(() => closeWith({ code, reason, wasClean: true }));
      },
    };

    const { path: hubPath, query } = splitHubPath(path);
    stop = once(
      api.open(
        {
          _tag: "ws",
          channelId,
          path: hubPath,
          ...(query ? { query } : {}),
          ...(protocols && protocols.length > 0 ? { protocols: [...protocols] } : {}),
        },
        (event) => {
          if (readyState === DEVICE_SOCKET_CLOSED || readyState === DEVICE_SOCKET_CLOSING) return;
          switch (event._tag) {
            case "opened":
              if (readyState !== DEVICE_SOCKET_CONNECTING) return;
              readyState = DEVICE_SOCKET_OPEN;
              protocol = event.protocol ?? "";
              dispatch("open", {});
              return;
            case "message": {
              if (event.binary) {
                const bytes = base64ToBytes(event.data);
                binaryParts.push(bytes);
                partBytes += bytes.byteLength;
              } else {
                textParts.push(event.data);
                partBytes += textEncoder.encode(event.data).byteLength;
              }
              if (partBytes > DEVICE_MAX_FRAME_BYTES) {
                // Parts that never end are a broken or hostile hub; stop holding them.
                const error = new DeviceFrameTooLargeError("message", partBytes);
                binaryParts = [];
                textParts = [];
                closeWith({ code: 1009, reason: error.message, wasClean: false }, error);
                return;
              }
              if (!event.final) return;
              const data = event.binary ? joinParts(binaryParts) : textParts.join("");
              const bytes = partBytes;
              binaryParts = [];
              textParts = [];
              partBytes = 0;
              try {
                dispatch("message", { data });
              } finally {
                // The listeners have taken the message (the decoder queued it), so it is credited.
                creditor.take(bytes);
              }
              return;
            }
            case "data":
              return;
            case "end":
              closeWith({ code: event.code ?? 1005, reason: event.reason ?? "", wasClean: true });
              return;
          }
        },
        (failure) => {
          if (readyState === DEVICE_SOCKET_CLOSED) return;
          const error = failure === undefined ? undefined : channelFailure(failure);
          closeWith(
            {
              code: 1006,
              reason: error?.message ?? "The device connection closed.",
              wasClean: false,
            },
            error ?? new Error("The device connection closed."),
          );
        },
      ),
    );
    if (readyState === DEVICE_SOCKET_CLOSED) stop();
    return handle;
  };

  return { fetch: fetchThrough, socket };
}
