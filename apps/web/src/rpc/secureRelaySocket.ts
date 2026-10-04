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
} from "@threadlines/shared/relaySecure";

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
 * content), so phones on the hosted app only get Tailscale HTTPS routes.
 */
export function usableDirectRoutes(
  routes: ReadonlyArray<string>,
  pageProtocol: string = globalThis.location?.protocol ?? "http:",
): ReadonlyArray<string> {
  return routes.filter((route) => pageProtocol !== "https:" || route.startsWith("wss:"));
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
  onClose: (event: CloseEvent) => void;
}

/**
 * Opens one route and runs the device side of the Noise KK handshake on it.
 * Resolves with the open socket and transport, or rejects (closing the socket)
 * on timeout, abort, or any handshake failure. A rejection caused by the far
 * end closing carries its CloseEvent, so relay close codes survive.
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
    let closeEvent: CloseEvent | null = null;
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
      reject(closeEvent ?? reason);
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
    socket.addEventListener("message", (event: MessageEvent) => {
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
    socket.addEventListener("close", (event: CloseEvent) => {
      closeEvent = event;
      if (ready) ready.onClose(event);
      else fail(event);
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
export async function probeDirectRoutes(target: SecureRelayTarget): Promise<string | null> {
  const routes = usableDirectRoutes(target.directRoutes);
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

/**
 * A WebSocket look-alike for effect's socket layer that carries a "Connect a
 * device" connection end to end encrypted. It tries the computer's direct
 * routes first (a short budget), then the relay, runs the Noise KK handshake
 * with the key pinned at pairing, and only then reports `open`. App frames are
 * encrypted both ways; on the relay route the RPC heartbeat stays plaintext so
 * the relay's edge can answer it without waking up, and an encrypted keepalive
 * proves the computer itself is still there.
 */
export class SecureRelaySocket extends EventTarget implements WebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  readonly protocol = "";
  readonly extensions = "";
  readonly bufferedAmount = 0;
  binaryType: BinaryType = "arraybuffer";
  readyState: WebSocket["readyState"] = SecureRelaySocket.CONNECTING;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;

  private link: Link | null = null;
  private stream: SecureStream | null = null;
  private readonly abort = new AbortController();
  private lastAuthenticatedAt = 0;
  private keepaliveSentAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private closeDispatched = false;

  constructor(
    url: string,
    private readonly options: {
      readonly resolveTarget: () => Promise<SecureRelayTarget>;
      readonly onRoute?: (route: SecureRoute) => void;
    },
  ) {
    super();
    this.url = url;
    void this.connect();
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
      this.fail(SECURE_CLOSE_CODE_PROTOCOL, "This computer's keys are missing. Connect it again.");
      return;
    }
    if (!hostPublicKey) {
      this.fail(SECURE_CLOSE_CODE_PROTOCOL, "This computer's keys are missing. Connect it again.");
      return;
    }
    const prologue = securePrologue(target.hostId, target.deviceId);
    const common = { keyPair, hostPublicKey, prologue };

    let link: Link | null = null;
    const direct = usableDirectRoutes(target.directRoutes);
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
        if (error instanceof CloseEvent) {
          this.fail(error.code, error.reason);
        } else {
          this.fail(SECURE_CLOSE_CODE_PROTOCOL, "Couldn't set up a secure connection.");
        }
        return;
      }
    }
    if (!link) {
      this.fail(SECURE_CLOSE_CODE_NO_ROUTE, "Can't reach this computer right now.");
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
        this.deliver(text);
        return;
      }
      if (link.via === "relay" && text.startsWith(RELAY_RAW_CONTROL_PREFIX)) return;
      this.shutDown(SECURE_CLOSE_CODE_PROTOCOL, "Unexpected plaintext from the relay.");
    };
    link.onClose = (event) => this.finish(event.code, event.reason);
    for (const frame of link.early.splice(0)) stream.receiveFrame(frame);
    stream.sendRecord(SECURE_RECORD_CONFIRM, new Uint8Array([SECURE_CONFIRM_SESSION]));

    this.lastAuthenticatedAt = Date.now();
    this.watchdog = setInterval(() => this.checkLiveness(), WATCHDOG_INTERVAL_MS);
    this.readyState = SecureRelaySocket.OPEN;
    this.options.onRoute?.(link.via);
    this.dispatchEvent(new Event("open"));
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
      this.deliver(text);
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

  private deliver(text: string): void {
    this.dispatchEvent(new MessageEvent("message", { data: text }));
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== SecureRelaySocket.OPEN || !this.link || !this.stream) {
      throw new DOMException("The connection isn't open.", "InvalidStateError");
    }
    if (typeof data !== "string") return;
    // The relay's edge answers the plaintext heartbeat; a direct computer gets it encrypted.
    if (this.link.via === "relay" && data === RELAY_HEARTBEAT_PING_FRAME) {
      this.link.socket.send(data);
      return;
    }
    this.stream.sendText(data);
  }

  close(code?: number, reason?: string): void {
    this.shutDown(code ?? 1000, reason ?? "");
  }

  private shutDown(code: number, reason: string): void {
    if (this.readyState === SecureRelaySocket.CLOSED) return;
    this.readyState = SecureRelaySocket.CLOSING;
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
   * Ends a connection that never opened. Only a close event: an "error" first
   * makes effect's socket close us itself, and the close code (the relay's
   * reason, like access removed) would be lost.
   */
  private fail(code: number, reason: string): void {
    this.finish(code, reason);
  }

  private finish(code: number, reason: string): void {
    if (this.closeDispatched) return;
    this.closeDispatched = true;
    this.readyState = SecureRelaySocket.CLOSED;
    if (this.watchdog) clearInterval(this.watchdog);
    this.stream?.stop();
    this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean: code === 1000 }));
  }
}
