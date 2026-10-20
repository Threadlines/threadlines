import {
  SECURE_CHANNEL_OPEN,
  SecureChannel,
  type SecureRelayTarget,
  type SecureRoute,
} from "@threadlines/shared/relaySecureSocket";

/** A close as effect's socket reads it: `code` and `reason` on the event. */
class PeerCloseEvent extends Event {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;

  constructor(code: number, reason: string) {
    super("close");
    this.code = code;
    this.reason = reason;
    this.wasClean = code === 1000;
  }
}

/**
 * The server's end of a computer link, as a WebSocket look-alike for
 * effect's socket layer: the shared end-to-end encrypted channel
 * (`@threadlines/shared/relaySecureSocket`, direct routes first, then the
 * relay) with its callbacks turned into the events effect listens for. Node
 * has no DOM `CloseEvent`, so closes carry their code on a plain Event.
 */
export class PeerSocket extends EventTarget {
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
  binaryType: "arraybuffer" | "blob" = "arraybuffer";
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;

  private readonly channel: SecureChannel;

  constructor(
    url: string,
    options: {
      readonly resolveTarget: () => Promise<SecureRelayTarget>;
      readonly onOpen?: (route: SecureRoute) => void;
      readonly onClose?: (code: number, reason: string) => void;
    },
  ) {
    super();
    this.url = url;
    this.channel = new SecureChannel({
      resolveTarget: options.resolveTarget,
      pageProtocol: "http:",
      handlers: {
        onOpen: (route) => {
          options.onOpen?.(route);
          this.dispatchEvent(new Event("open"));
        },
        onMessage: (text) => this.dispatchEvent(new MessageEvent("message", { data: text })),
        onClose: (code, reason) => {
          options.onClose?.(code, reason);
          this.dispatchEvent(new PeerCloseEvent(code, reason));
        },
      },
    });
  }

  get readyState(): number {
    return this.channel.readyState;
  }

  send(data: unknown): void {
    if (this.channel.readyState !== SECURE_CHANNEL_OPEN) {
      throw new Error("The connection isn't open.");
    }
    if (typeof data === "string") this.channel.send(data);
  }

  close(code?: number, reason?: string): void {
    this.channel.close(code ?? 1000, reason ?? "");
  }
}
