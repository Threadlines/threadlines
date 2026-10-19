/**
 * TCP connections to this machine's loopback, for browser pages running on
 * another computer.
 *
 * A thread's browser can run on the computer the user is at while its agent
 * runs here. When that page asks for `localhost:5173` it means this machine's
 * dev server, so the client sends the connection here (see `previewTunnel.ts`
 * in contracts) and this opens it on our own loopback and passes the bytes.
 *
 * Every part is about staying a pipe and nothing more: only loopback, so no
 * client gets a way into the network this machine sits on; bytes in the order
 * the page wrote them, however the calls carrying them were scheduled; and no
 * more in flight than the page is reading, so a stalled page holds the dev
 * server up instead of filling this process with its output.
 */
import {
  PREVIEW_TUNNEL_CHUNK_BYTES,
  PREVIEW_TUNNEL_WINDOW_BYTES,
  PreviewTunnelError,
  type PreviewTunnelCredit,
  type PreviewTunnelEvent,
  type PreviewTunnelOpen,
  type PreviewTunnelWrite,
} from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Net from "node:net";

import { ServerConfig } from "../config.ts";

/** Tunnels one session may hold open at once; a busy page uses a few dozen. */
export const PREVIEW_TUNNEL_MAX_PER_SESSION = 256;
/** How long a connection may take to open before the page is told it can't. */
export const PREVIEW_TUNNEL_CONNECT_TIMEOUT_MS = 10_000;
/** Writes that may wait for one sent ahead of them before the tunnel is given up. */
const MAX_WRITES_OUT_OF_ORDER = 64;
/**
 * What the socket may hold unwritten. The client waits for each write's
 * answer once it has a window's worth out, so reaching this means it did not.
 */
const MAX_UNWRITTEN_BYTES = 8 * PREVIEW_TUNNEL_WINDOW_BYTES;

/**
 * The loopback addresses a host names on this machine, or null when it names
 * something else.
 *
 * Names are mapped here rather than resolved: `*.localhost` need not resolve
 * at all, and a resolver can be told `localhost` is anywhere. Browsers treat
 * all of these as this machine without asking DNS, and so does this.
 */
export function loopbackAddresses(host: string): ReadonlyArray<string> | null {
  const bare = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
  if (bare === "localhost" || bare.endsWith(".localhost")) {
    // Both families: a dev server on `localhost` may have bound either.
    return ["127.0.0.1", "::1"];
  }
  if (Net.isIPv4(bare)) {
    return bare.startsWith("127.") ? [bare] : null;
  }
  if (Net.isIPv6(bare)) {
    const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare)?.[1];
    if (mapped !== undefined) {
      return mapped.startsWith("127.") && Net.isIPv4(mapped) ? [mapped] : null;
    }
    return isIpv6Loopback(bare) ? ["::1"] : null;
  }
  return null;
}

function isIpv6Loopback(address: string): boolean {
  // `::1` in any of its spellings: every group zero but the last, which is one.
  const [head = "", tail] = address.split("::");
  const groups = [
    ...head.split(":").filter((group) => group !== ""),
    ...(tail === undefined ? [] : ["::"]),
    ...(tail ?? "").split(":").filter((group) => group !== ""),
  ];
  const explicit = groups.filter((group) => group !== "::");
  const last = explicit.at(-1);
  if (last === undefined || Number.parseInt(last, 16) !== 1) return false;
  return explicit.slice(0, -1).every((group) => Number.parseInt(group, 16) === 0);
}

interface PendingWrite {
  readonly data: Buffer | undefined;
  readonly end: boolean;
  readonly done: Deferred.Deferred<void, PreviewTunnelError>;
}

interface Tunnel {
  readonly socket: Net.Socket;
  /** Bytes sent down the tunnel that the client has not yet said it delivered. */
  unacknowledged: number;
  paused: boolean;
  nextSeq: number;
  writeEnded: boolean;
  /** Writes waiting for one sent ahead of them, by sequence number. */
  readonly waiting: Map<number, PendingWrite>;
  /** Writes handed to the socket and not yet flushed. */
  readonly writing: Set<Deferred.Deferred<void, PreviewTunnelError>>;
}

export interface PreviewTunnelShape {
  /**
   * Opens one connection and hands back what it sends. Scoped: the scope
   * closing -- the client unsubscribing, its socket dropping -- destroys it.
   * Fails when the host is not loopback or nothing answers there.
   */
  readonly open: (
    sessionId: string,
    input: PreviewTunnelOpen,
  ) => Effect.Effect<
    Stream.Stream<PreviewTunnelEvent, PreviewTunnelError>,
    PreviewTunnelError,
    Scope.Scope
  >;
  /** Writes the next bytes of a tunnel, in sequence order; done once written out. */
  readonly write: (
    sessionId: string,
    input: PreviewTunnelWrite,
  ) => Effect.Effect<void, PreviewTunnelError>;
  /** The client delivered more of a tunnel's bytes; reading resumes if it had stopped. */
  readonly credit: (sessionId: string, input: PreviewTunnelCredit) => Effect.Effect<void>;
}

export class PreviewTunnel extends Context.Service<PreviewTunnel, PreviewTunnelShape>()(
  "@threadlines/server/preview/PreviewTunnel",
) {}

const unreachable = (host: string, port: number, cause: unknown) => {
  const code = (cause as { code?: unknown } | null)?.code;
  return new PreviewTunnelError({
    reason: "unreachable",
    detail:
      code === "ECONNREFUSED"
        ? `Nothing is listening on ${host}:${port}.`
        : code === "ETIMEDOUT"
          ? `${host}:${port} did not answer.`
          : `Could not connect to ${host}:${port}: ${String((cause as Error | null)?.message ?? cause)}`,
  });
};

/** Why one connect attempt failed: the socket's own error, or no answer in time. */
type ConnectFailure = Error | { readonly code: "ETIMEDOUT" };

/** One attempt at one address, given up on timeout or interruption. */
const connectTo = (address: string, port: number) =>
  Effect.callback<Net.Socket, ConnectFailure>((resume) => {
    const socket = Net.connect({ host: address, port, allowHalfOpen: true });
    const timer = setTimeout(() => {
      socket.destroy();
      resume(Effect.fail({ code: "ETIMEDOUT" }));
    }, PREVIEW_TUNNEL_CONNECT_TIMEOUT_MS);
    const onConnectError = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      resume(Effect.fail(error));
    };
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeListener("error", onConnectError);
      // Until the tunnel's own listener is on: an error with no listener at
      // all would take the server down. The tunnel checks for one it missed.
      socket.on("error", () => {});
      resume(Effect.succeed(socket));
    });
    socket.once("error", onConnectError);
    return Effect.sync(() => {
      clearTimeout(timer);
      socket.destroy();
    });
  });

/**
 * The tunnels for one server. `ownPort` is the server's own port, which no
 * tunnel may open.
 */
export const makePreviewTunnel = (options: { readonly ownPort: number }) =>
  Effect.sync(() => makeTunnels(options));

const makeTunnels = (options: { readonly ownPort: number }): PreviewTunnelShape => {
  const tunnels = new Map<string, Tunnel>();
  const openBySession = new Map<string, number>();
  const keyOf = (sessionId: string, tunnelId: string) => `${sessionId}\u0000${tunnelId}`;

  /** Fails every write not yet answered: the connection they were for has gone. */
  const settleWaiting = (tunnel: Tunnel, error: PreviewTunnelError) => {
    for (const entry of tunnel.waiting.values()) {
      Deferred.doneUnsafe(entry.done, Exit.fail(error));
    }
    tunnel.waiting.clear();
    for (const done of tunnel.writing) {
      Deferred.doneUnsafe(done, Exit.fail(error));
    }
    tunnel.writing.clear();
  };

  /** Writes every write whose turn has come, in order. */
  const drain = (tunnel: Tunnel) => {
    for (;;) {
      const entry = tunnel.waiting.get(tunnel.nextSeq);
      if (entry === undefined) return;
      tunnel.waiting.delete(tunnel.nextSeq);
      tunnel.nextSeq += 1;
      if (tunnel.writeEnded || tunnel.socket.destroyed) {
        Deferred.doneUnsafe(
          entry.done,
          Exit.fail(
            new PreviewTunnelError({
              reason: "broken",
              detail: "The connection has already closed for writing.",
            }),
          ),
        );
        continue;
      }
      tunnel.writing.add(entry.done);
      const finish = (error: Error | null | undefined) => {
        tunnel.writing.delete(entry.done);
        Deferred.doneUnsafe(
          entry.done,
          error
            ? Exit.fail(new PreviewTunnelError({ reason: "broken", detail: error.message }))
            : Exit.void,
        );
      };
      if (entry.data !== undefined && entry.data.length > 0) {
        tunnel.socket.write(entry.data, finish);
      } else if (!entry.end) {
        finish(null);
      }
      if (entry.end) {
        tunnel.writeEnded = true;
        if (entry.data !== undefined && entry.data.length > 0) {
          tunnel.socket.end();
        } else {
          tunnel.socket.end(() => finish(null));
        }
      }
      if (tunnel.socket.writableLength > MAX_UNWRITTEN_BYTES) {
        const error = new PreviewTunnelError({
          reason: "limit",
          detail: "The page wrote far more than the connection was taking.",
        });
        settleWaiting(tunnel, error);
        tunnel.socket.destroy();
        return;
      }
    }
  };

  const open = Effect.fn("PreviewTunnel.open")(function* (
    sessionId: string,
    input: PreviewTunnelOpen,
  ) {
    const addresses = loopbackAddresses(input.host);
    if (addresses === null) {
      return yield* new PreviewTunnelError({
        reason: "notLoopback",
        detail: `${input.host} is not this computer, so the browser cannot reach it through Threadlines.`,
      });
    }
    // Threadlines' own port: a page has no business with it, and a page
    // reaching it from loopback must not look like this machine to it.
    if (input.port === options.ownPort) {
      return yield* new PreviewTunnelError({
        reason: "notLoopback",
        detail: `Port ${input.port} is Threadlines itself, which the browser does not open.`,
      });
    }
    const key = keyOf(sessionId, input.tunnelId);
    const held = openBySession.get(sessionId) ?? 0;
    if (tunnels.has(key) || held >= PREVIEW_TUNNEL_MAX_PER_SESSION) {
      return yield* new PreviewTunnelError({
        reason: "limit",
        detail: tunnels.has(key)
          ? "That tunnel is already open."
          : `Too many connections are open to this computer (${held}).`,
      });
    }
    // The slot is held from the first attempt, so a page opening hundreds at
    // once cannot get past the limit while they are all still connecting.
    openBySession.set(sessionId, held + 1);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        const remaining = (openBySession.get(sessionId) ?? 1) - 1;
        if (remaining <= 0) openBySession.delete(sessionId);
        else openBySession.set(sessionId, remaining);
      }),
    );

    let lastError: unknown = null;
    let socket: Net.Socket | null = null;
    for (const address of addresses) {
      const attempt = yield* Effect.exit(connectTo(address, input.port));
      if (Exit.isSuccess(attempt)) {
        socket = attempt.value;
        break;
      }
      lastError = Cause.squash(attempt.cause);
    }
    if (socket === null) {
      return yield* unreachable(input.host, input.port, lastError);
    }
    const connected = socket;
    const tunnel: Tunnel = {
      socket: connected,
      unacknowledged: 0,
      paused: false,
      nextSeq: 0,
      writeEnded: false,
      waiting: new Map(),
      writing: new Set(),
    };
    tunnels.set(key, tunnel);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (tunnels.get(key) === tunnel) tunnels.delete(key);
        settleWaiting(
          tunnel,
          new PreviewTunnelError({ reason: "broken", detail: "The tunnel was closed." }),
        );
        connected.destroy();
      }),
    );
    connected.setNoDelay(true);

    const queue = yield* Queue.unbounded<PreviewTunnelEvent, PreviewTunnelError | Cause.Done>();
    Queue.offerUnsafe(queue, { _tag: "opened" });

    connected.on("data", (chunk: Buffer) => {
      for (let offset = 0; offset < chunk.length; offset += PREVIEW_TUNNEL_CHUNK_BYTES) {
        const part = chunk.subarray(offset, offset + PREVIEW_TUNNEL_CHUNK_BYTES);
        Queue.offerUnsafe(queue, { _tag: "data", data: part.toString("base64") });
      }
      tunnel.unacknowledged += chunk.length;
      if (!tunnel.paused && tunnel.unacknowledged >= PREVIEW_TUNNEL_WINDOW_BYTES) {
        tunnel.paused = true;
        connected.pause();
      }
    });
    connected.on("end", () => {
      Queue.offerUnsafe(queue, { _tag: "end" });
    });
    connected.on("error", (error) => {
      const failure = new PreviewTunnelError({ reason: "broken", detail: error.message });
      settleWaiting(tunnel, failure);
      Queue.failCauseUnsafe(queue, Cause.fail(failure));
    });
    connected.on("close", () => {
      settleWaiting(
        tunnel,
        new PreviewTunnelError({ reason: "broken", detail: "The connection closed." }),
      );
      Queue.endUnsafe(queue);
    });

    // It may have broken while the listeners above were being put on.
    if (connected.destroyed) {
      Queue.failCauseUnsafe(
        queue,
        Cause.fail(new PreviewTunnelError({ reason: "broken", detail: "The connection closed." })),
      );
    }

    return Stream.fromQueue(queue);
  });

  const write = Effect.fn("PreviewTunnel.write")(function* (
    sessionId: string,
    input: PreviewTunnelWrite,
  ) {
    const tunnel = tunnels.get(keyOf(sessionId, input.tunnelId));
    if (tunnel === undefined) {
      return yield* new PreviewTunnelError({
        reason: "unknownTunnel",
        detail: "That tunnel is not open.",
      });
    }
    const data = input.data === undefined ? undefined : Buffer.from(input.data, "base64");
    if (
      input.seq < tunnel.nextSeq ||
      tunnel.waiting.has(input.seq) ||
      tunnel.waiting.size >= MAX_WRITES_OUT_OF_ORDER ||
      (data?.length ?? 0) > PREVIEW_TUNNEL_CHUNK_BYTES
    ) {
      const error = new PreviewTunnelError({
        reason: "limit",
        detail: "The tunnel's writes arrived out of all order.",
      });
      settleWaiting(tunnel, error);
      tunnel.socket.destroy();
      return yield* error;
    }
    const done = yield* Deferred.make<void, PreviewTunnelError>();
    tunnel.waiting.set(input.seq, { data, end: input.end === true, done });
    drain(tunnel);
    yield* Deferred.await(done);
  });

  const credit = (sessionId: string, input: PreviewTunnelCredit) =>
    Effect.sync(() => {
      const tunnel = tunnels.get(keyOf(sessionId, input.tunnelId));
      if (tunnel === undefined) return;
      tunnel.unacknowledged = Math.max(0, tunnel.unacknowledged - input.bytes);
      if (tunnel.paused && tunnel.unacknowledged < PREVIEW_TUNNEL_WINDOW_BYTES / 2) {
        tunnel.paused = false;
        tunnel.socket.resume();
      }
    });

  return PreviewTunnel.of({ open, write, credit });
};

export const layer = Layer.effect(
  PreviewTunnel,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return yield* makePreviewTunnel({ ownPort: config.port });
  }),
);
