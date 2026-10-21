import {
  probeDirectRoutes as probeSharedDirectRoutes,
  SECURE_CHANNEL_OPEN,
  SecureChannel,
  type SecureRelayTarget,
  type SecureRoute,
  usableDirectRoutes as usableSharedDirectRoutes,
} from "@threadlines/shared/relaySecureSocket";

export {
  SECURE_CLOSE_CODE_NO_ROUTE,
  SECURE_CLOSE_CODE_PROTOCOL,
  SECURE_CLOSE_CODE_STALE,
  SECURE_OPEN_TIMEOUT_MS,
  type SecureRelayTarget,
  type SecureRoute,
} from "@threadlines/shared/relaySecureSocket";

const pageProtocol = () => globalThis.location?.protocol ?? "http:";

/**
 * Direct routes a page can use: an https page can't open `ws://` (mixed
 * content), so phones on the hosted app only get Tailscale HTTPS routes.
 */
export function usableDirectRoutes(
  routes: ReadonlyArray<string>,
  protocol: string = pageProtocol(),
): ReadonlyArray<string> {
  return usableSharedDirectRoutes(routes, protocol);
}

/**
 * Checks whether any direct route reaches the computer right now, without
 * opening a session there. Returns the route that answered, or null.
 */
export function probeDirectRoutes(target: SecureRelayTarget): Promise<string | null> {
  return probeSharedDirectRoutes(target, pageProtocol());
}

/**
 * A WebSocket look-alike for effect's socket layer over the shared
 * end-to-end encrypted channel (`@threadlines/shared/relaySecureSocket`):
 * route choice, the Noise KK handshake and keepalives live there; this only
 * turns its callbacks into DOM events.
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
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;

  private readonly channel: SecureChannel;

  constructor(
    url: string,
    options: {
      readonly resolveTarget: () => Promise<SecureRelayTarget>;
      readonly onRoute?: (route: SecureRoute) => void;
    },
  ) {
    super();
    this.url = url;
    this.channel = new SecureChannel({
      resolveTarget: options.resolveTarget,
      pageProtocol: pageProtocol(),
      handlers: {
        onOpen: (route) => {
          options.onRoute?.(route);
          this.dispatchEvent(new Event("open"));
        },
        onMessage: (text) => this.dispatchEvent(new MessageEvent("message", { data: text })),
        onClose: (code, reason) =>
          this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean: code === 1000 })),
      },
    });
  }

  get readyState(): WebSocket["readyState"] {
    return this.channel.readyState as WebSocket["readyState"];
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.channel.readyState !== SECURE_CHANNEL_OPEN) {
      throw new DOMException("The connection isn't open.", "InvalidStateError");
    }
    if (typeof data !== "string") return;
    this.channel.send(data);
  }

  close(code?: number, reason?: string): void {
    this.channel.close(code ?? 1000, reason ?? "");
  }
}
