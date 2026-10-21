import {
  RELAY_HEARTBEAT_PING_FRAME,
  RELAY_HEARTBEAT_PONG_FRAME,
  RELAY_RAW_CONTROL_PREFIX,
} from "@threadlines/contracts/relay";

import {
  binaryFrameBytes,
  decodePublicKey,
  fromUtf8,
  handshakeFrame,
  kkMessageLength,
  loadStoredKeyPair,
  type NoiseKeyPair,
  readHandshakeFrame,
  SECURE_CONFIRM_PROBE,
  SECURE_CONFIRM_SESSION,
  SECURE_RECORD_ACK,
  SECURE_RECORD_APP,
  SECURE_RECORD_CONFIRM,
  SECURE_RECORD_KEEPALIVE,
  type SecureTransport,
  securePrologue,
  SecureStream,
  startKKInitiator,
  type StoredKeyPair,
} from "./relaySecure.ts";

/**
 * The device side of an end-to-end encrypted "Connect a device" connection,
 * shared by the web app (wrapped as a WebSocket look-alike) and the server
 * (computer links, where this server is a device of another computer). It
 * uses only the global WebSocket and WebCrypto: no DOM event classes, no
 * `location`, so it runs in Node and browsers alike.
 */

/** How a "Connect a device" connection can reach its computer right now. */
export interface SecureRelayTarget {
  readonly hostId: string;
  readonly deviceId: string;
  readonly hostPublicKey: string;
  readonly deviceKey: StoredKeyPair;
  readonly directRoutes: ReadonlyArray<string>;
  /** Null while the relay route is on hold (daily limit, relay busy). */
  readonly relay: { readonly url: string; readonly protocols: ReadonlyArray<string> } | null;
}

export type SecureRoute = "direct" | "relay";

/** Closes a connection that stopped hearing from its computer. */
export const SECURE_CLOSE_CODE_STALE = 4101;
/** Closes a connection whose far end broke the protocol (bad frame, failed handshake). */
export const SECURE_CLOSE_CODE_PROTOCOL = 4102;
/** No route worked and the relay is on hold. */
export const SECURE_CLOSE_CODE_NO_ROUTE = 4103;

const DIRECT_BUDGET_MS = 1_500;
const RELAY_HANDSHAKE_TIMEOUT_MS = 15_000;
/** Above relay handshake and direct budget; passed to effect's socket as its open timeout. */
export const SECURE_OPEN_TIMEOUT_MS = 20_000;
const KEEPALIVE_AFTER_MS = 60_000;
const STALE_AFTER_MS = 150_000;
const WATCHDOG_INTERVAL_MS = 15_000;

/**
 * Direct routes a page can use: an https page can't open `ws://` (mixed
 * content), so phones on the hosted app only get Tailscale HTTPS routes. A
 * server passes its own `http:` and keeps every route.
 */
export function usableDirectRoutes(
  routes: ReadonlyArray<string>,
  pageProtocol: string,
): ReadonlyArray<string> {
  return routes.filter((route) => pageProtocol !== "https:" || route.startsWith("wss:"));
}

/** A route closed before or during the handshake; keeps the far end's close code. */
export class SecureLinkClosedError extends Error {
  readonly code: number;
  readonly reason: string;

  constructor(code: number, reason: string) {
    super(reason || `Closed (${code}).`);
    this.code = code;
    this.reason = reason;
  }
}

interface CloseDetails {
  readonly code: number;
  readonly reason: string;
}

function closeDetails(event: unknown): CloseDetails {
  const candidate = event as { readonly code?: unknown; readonly reason?: unknown } | null;
  return {
    code: typeof candidate?.code === "number" ? candidate.code : 1006,
    reason: typeof candidate?.reason === "string" ? candidate.reason : "",
  };
}

interface Link {
  readonly url: string;
  readonly socket: WebSocket;
  readonly via: SecureRoute;
  readonly transport: SecureTransport;
  /** Frames that arrived after the handshake, before a stream took over. */
  readonly early: Array<Uint8Array>;
  /** Swapped in by whoever takes the link over. */
  onFrame: (frame: Uint8Array) => void;
  onText: (text: string) => void;
  onClose: (details: CloseDetails) => void;
}

/**
 * Opens one route and runs the device side of the Noise KK handshake on it.
 * Resolves with the open socket and transport, or rejects (closing the socket)
 * on timeout, abort, or any handshake failure. A rejection caused by the far
 * end closing is a {@link SecureLinkClosedError}, so relay close codes survive.
 */
function openLink(input: {
  readonly url: string;
  readonly protocols?: ReadonlyArray<string>;
  readonly via: SecureRoute;
  readonly keyPair: NoiseKeyPair;
  readonly hostPublicKey: Uint8Array;
  readonly prologue: Uint8Array;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}): Promise<Link> {
  return new Promise<Link>((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = input.protocols
        ? new WebSocket(input.url, [...input.protocols])
        : new WebSocket(input.url);
    } catch (error) {
      reject(error);
      return;
    }
    socket.binaryType = "arraybuffer";
    let phase: "handshake" | "finishing" | "ready" | "failed" = "handshake";
    let ready: Link | null = null;
    let initiator: Awaited<ReturnType<typeof startKKInitiator>> | null = null;
    let closedBy: SecureLinkClosedError | null = null;
    const early: Array<Uint8Array> = [];

    const fail = (reason: unknown) => {
      if (phase === "ready" || phase === "failed") return;
      phase = "failed";
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      reject(closedBy ?? reason);
    };
    const timer = setTimeout(() => fail(new Error("Timed out.")), input.timeoutMs);
    const onAbort = () => fail(new Error("Aborted."));
    input.signal.addEventListener("abort", onAbort);

    socket.addEventListener("open", () => {
      void (async () => {
        try {
          initiator = await startKKInitiator({
            staticKeyPair: input.keyPair,
            remoteStaticPublicKey: input.hostPublicKey,
            prologue: input.prologue,
          });
          const message1 = await initiator.writeMessage1();
          if (phase === "handshake") socket.send(handshakeFrame(message1));
        } catch (error) {
          fail(error);
        }
      })();
    });
    socket.addEventListener("message", (event: { readonly data: unknown }) => {
      if (typeof event.data === "string") {
        if (ready) {
          ready.onText(event.data);
        } else if (
          input.via !== "relay" ||
          (event.data !== RELAY_HEARTBEAT_PONG_FRAME &&
            !event.data.startsWith(RELAY_RAW_CONTROL_PREFIX))
        ) {
          fail(new Error("Unexpected plaintext."));
        }
        return;
      }
      const frame = binaryFrameBytes(event.data);
      if (!frame) return;
      if (ready) {
        ready.onFrame(frame);
        return;
      }
      if (phase === "finishing") {
        early.push(frame);
        return;
      }
      const reply = readHandshakeFrame(frame, kkMessageLength());
      if (phase !== "handshake" || !reply || !initiator) {
        fail(new Error("Bad handshake."));
        return;
      }
      phase = "finishing";
      void initiator.readMessage2(reply).then(
        ({ transport }) => {
          if (phase !== "finishing") return;
          phase = "ready";
          clearTimeout(timer);
          input.signal.removeEventListener("abort", onAbort);
          ready = {
            url: input.url,
            socket,
            via: input.via,
            transport,
            early,
            onFrame: (next) => early.push(next),
            onText: () => undefined,
            onClose: () => undefined,
          };
          resolve(ready);
        },
        (error: unknown) => fail(error),
      );
    });
    socket.addEventListener("close", (event: unknown) => {
      const details = closeDetails(event);
      closedBy = new SecureLinkClosedError(details.code, details.reason);
      if (ready) ready.onClose(details);
      else fail(closedBy);
    });
    socket.addEventListener("error", () => fail(new Error("Couldn't connect.")));
  });
}

/** The first link to succeed; losers are aborted and closed. */
async function firstLink(
  attempts: ReadonlyArray<(signal: AbortSignal) => Promise<Link>>,
): Promise<Link> {
  const controller = new AbortController();
  try {
    return await Promise.any(attempts.map((attempt) => attempt(controller.signal)));
  } finally {
    controller.abort();
  }
}

/**
 * Checks whether any direct route reaches the computer right now, without
 * opening a session there. Returns the route that answered, or null.
 */
export async function probeDirectRoutes(
  target: SecureRelayTarget,
  pageProtocol: string,
): Promise<string | null> {
  const routes = usableDirectRoutes(target.directRoutes, pageProtocol);
  const hostPublicKey = await decodePublicKey(target.hostPublicKey);
  if (routes.length === 0 || !hostPublicKey) return null;
  const keyPair = await loadStoredKeyPair(target.deviceKey);
  const prologue = securePrologue(target.hostId, target.deviceId);
  const winner = await firstLink(
    routes.map(
      (url) => (signal: AbortSignal) =>
        openLink({
          url,
          via: "direct",
          keyPair,
          hostPublicKey,
          prologue,
          timeoutMs: DIRECT_BUDGET_MS * 2,
          signal,
        }),
    ),
  ).catch(() => null);
  if (!winner) return null;
  // The computer acks a probe and closes; it never opens a session for one.
  return new Promise((resolve) => {
    let answered = false;
    const stream = new SecureStream({
      transport: winner.transport,
      sendFrame: (frame) => winner.socket.send(frame),
      onRecord: (type) => {
        answered = type === SECURE_RECORD_ACK;
        winner.socket.close();
      },
      onError: () => winner.socket.close(),
    });
    winner.onFrame = (frame) => stream.receiveFrame(frame);
    winner.onClose = () => resolve(answered ? winner.url : null);
    for (const frame of winner.early) stream.receiveFrame(frame);
    stream.sendRecord(SECURE_RECORD_CONFIRM, new Uint8Array([SECURE_CONFIRM_PROBE]));
    setTimeout(() => winner.socket.close(), DIRECT_BUDGET_MS * 2);
  });
}

/** What a {@link SecureChannel} tells its owner. Each is called at most once, except messages. */
export interface SecureChannelHandlers {
  readonly onOpen: (route: SecureRoute) => void;
  readonly onMessage: (text: string) => void;
  /** The channel ended (or never opened); `code` is the far end's or one of the SECURE_CLOSE_CODE_*. */
  readonly onClose: (code: number, reason: string) => void;
}

export interface SecureChannelOptions {
  readonly resolveTarget: () => Promise<SecureRelayTarget>;
  /** The page's protocol (browsers), or `http:` on a server: see usableDirectRoutes. */
  readonly pageProtocol: string;
  readonly handlers: SecureChannelHandlers;
}

export const SECURE_CHANNEL_CONNECTING = 0;
export const SECURE_CHANNEL_OPEN = 1;
export const SECURE_CHANNEL_CLOSING = 2;
export const SECURE_CHANNEL_CLOSED = 3;

/**
 * One end-to-end encrypted connection to a computer. It tries the computer's
 * direct routes first (a short budget), then the relay, runs the Noise KK
 * handshake with the key pinned at pairing, and only then reports open. App
 * text is encrypted both ways; on the relay route the RPC heartbeat stays
 * plaintext so the relay's edge can answer it without waking up, and an
 * encrypted keepalive proves the computer itself is still there.
 */
export class SecureChannel {
  readyState: number = SECURE_CHANNEL_CONNECTING;
  private link: Link | null = null;
  private stream: SecureStream | null = null;
  private readonly abort = new AbortController();
  private lastAuthenticatedAt = 0;
  private keepaliveSentAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private closeReported = false;
  private readonly options: SecureChannelOptions;

  constructor(options: SecureChannelOptions) {
    this.options = options;
    void this.connect();
  }

  /** The route this channel ended up on, once open. */
  get route(): SecureRoute | null {
    return this.link?.via ?? null;
  }

  private async connect(): Promise<void> {
    let target: SecureRelayTarget;
    let keyPair: NoiseKeyPair;
    let hostPublicKey: Uint8Array | null;
    try {
      target = await this.options.resolveTarget();
      keyPair = await loadStoredKeyPair(target.deviceKey);
      hostPublicKey = await decodePublicKey(target.hostPublicKey);
    } catch {
      this.finish(
        SECURE_CLOSE_CODE_PROTOCOL,
        "This computer's keys are missing. Connect it again.",
      );
      return;
    }
    if (!hostPublicKey) {
      this.finish(
        SECURE_CLOSE_CODE_PROTOCOL,
        "This computer's keys are missing. Connect it again.",
      );
      return;
    }
    if (this.abort.signal.aborted) return;
    const prologue = securePrologue(target.hostId, target.deviceId);
    const common = { keyPair, hostPublicKey, prologue };

    let link: Link | null = null;
    const direct = usableDirectRoutes(target.directRoutes, this.options.pageProtocol);
    if (direct.length > 0) {
      link = await firstLink(
        direct.map(
          (url) => (signal: AbortSignal) =>
            openLink({ ...common, url, via: "direct", timeoutMs: DIRECT_BUDGET_MS, signal }),
        ),
      ).catch(() => null);
    }
    if (!link && target.relay && !this.abort.signal.aborted) {
      const relay = target.relay;
      try {
        link = await openLink({
          ...common,
          url: relay.url,
          protocols: relay.protocols,
          via: "relay",
          timeoutMs: RELAY_HANDSHAKE_TIMEOUT_MS,
          signal: this.abort.signal,
        });
      } catch (error) {
        // Pass the relay's close code on (daily limit, access removed, ...).
        if (error instanceof SecureLinkClosedError) {
          this.finish(error.code, error.reason);
        } else {
          this.finish(SECURE_CLOSE_CODE_PROTOCOL, "Couldn't set up a secure connection.");
        }
        return;
      }
    }
    if (!link) {
      this.finish(SECURE_CLOSE_CODE_NO_ROUTE, "Can't reach this computer right now.");
      return;
    }
    if (this.abort.signal.aborted) {
      link.socket.close();
      return;
    }
    this.attach(link);
  }

  private attach(link: Link): void {
    this.link = link;
    const stream = new SecureStream({
      transport: link.transport,
      sendFrame: (frame) => {
        if (link.socket.readyState === WebSocket.OPEN) link.socket.send(frame);
      },
      onRecord: (type, body) => this.onRecord(type, body),
      onError: () => this.shutDown(SECURE_CLOSE_CODE_PROTOCOL, "The connection was tampered with."),
    });
    this.stream = stream;
    link.onFrame = (frame) => stream.receiveFrame(frame);
    link.onText = (text) => {
      if (link.via === "relay" && text === RELAY_HEARTBEAT_PONG_FRAME) {
        this.options.handlers.onMessage(text);
        return;
      }
      if (link.via === "relay" && text.startsWith(RELAY_RAW_CONTROL_PREFIX)) return;
      this.shutDown(SECURE_CLOSE_CODE_PROTOCOL, "Unexpected plaintext from the relay.");
    };
    link.onClose = (details) => this.finish(details.code, details.reason);
    for (const frame of link.early.splice(0)) stream.receiveFrame(frame);
    stream.sendRecord(SECURE_RECORD_CONFIRM, new Uint8Array([SECURE_CONFIRM_SESSION]));

    this.lastAuthenticatedAt = Date.now();
    this.watchdog = setInterval(() => this.checkLiveness(), WATCHDOG_INTERVAL_MS);
    this.readyState = SECURE_CHANNEL_OPEN;
    this.options.handlers.onOpen(link.via);
  }

  private onRecord(type: number, body: Uint8Array): void {
    this.lastAuthenticatedAt = Date.now();
    this.keepaliveSentAt = 0;
    if (type === SECURE_RECORD_APP) {
      let text: string;
      try {
        text = fromUtf8(body);
      } catch {
        this.shutDown(SECURE_CLOSE_CODE_PROTOCOL, "Bad message from the computer.");
        return;
      }
      this.options.handlers.onMessage(text);
      return;
    }
    if (type !== SECURE_RECORD_ACK) {
      this.shutDown(SECURE_CLOSE_CODE_PROTOCOL, "Unexpected message from the computer.");
    }
  }

  private checkLiveness(): void {
    const quiet = Date.now() - this.lastAuthenticatedAt;
    if (quiet > STALE_AFTER_MS) {
      this.shutDown(SECURE_CLOSE_CODE_STALE, "No answer from the computer.");
      return;
    }
    if (quiet > KEEPALIVE_AFTER_MS && this.keepaliveSentAt === 0) {
      this.keepaliveSentAt = Date.now();
      this.stream?.sendRecord(SECURE_RECORD_KEEPALIVE);
    }
  }

  /** Sends app text; false when the channel isn't open. */
  send(text: string): boolean {
    if (this.readyState !== SECURE_CHANNEL_OPEN || !this.link || !this.stream) return false;
    // The relay's edge answers the plaintext heartbeat; a direct computer gets it encrypted.
    if (this.link.via === "relay" && text === RELAY_HEARTBEAT_PING_FRAME) {
      this.link.socket.send(text);
      return true;
    }
    this.stream.sendText(text);
    return true;
  }

  close(code = 1000, reason = ""): void {
    this.shutDown(code, reason);
  }

  private shutDown(code: number, reason: string): void {
    if (this.readyState === SECURE_CHANNEL_CLOSED) return;
    this.readyState = SECURE_CHANNEL_CLOSING;
    this.abort.abort();
    this.stream?.stop();
    const socket = this.link?.socket;
    if (socket && socket.readyState <= WebSocket.OPEN) {
      try {
        socket.close(code >= 3000 && code <= 4999 ? code : 1000, reason.slice(0, 120));
      } catch {
        // Already closing.
      }
    }
    this.finish(code, reason);
  }

  /**
   * Ends the channel, open or not. Only a close is reported: an "error" first
   * would make effect's socket close it itself, and the close code (the
   * relay's reason, like access removed) would be lost.
   */
  private finish(code: number, reason: string): void {
    if (this.closeReported) return;
    this.closeReported = true;
    this.readyState = SECURE_CHANNEL_CLOSED;
    this.abort.abort();
    if (this.watchdog) clearInterval(this.watchdog);
    this.stream?.stop();
    this.options.handlers.onClose(code, reason);
  }
}
