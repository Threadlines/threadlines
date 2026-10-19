/**
 * The proxy browser pages use to reach another computer's `localhost`, and
 * the socket-shaped tunnel each of its connections becomes.
 *
 * Plain Node, no Electron: `PreviewLoopbackProxy.ts` points browser sessions
 * at it and carries each tunnel to the app window. Kept apart so it can be
 * driven with real HTTP clients in tests.
 *
 * Chromium speaks HTTP proxy to it: a plain `http:` request arrives with the
 * whole URL and is passed on over a pooled tunnel to that host; `https:`,
 * `ws:` and `wss:` arrive as CONNECT and get a tunnel of their own. Every
 * request must carry the proxy's password, or it is asked for one.
 */
import {
  PREVIEW_TUNNEL_CHUNK_BYTES,
  PREVIEW_TUNNEL_WINDOW_BYTES,
  type DesktopPreviewTunnelRequest,
} from "@threadlines/contracts";
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as Http from "node:http";
import type * as Net from "node:net";
import { Duplex, pipeline } from "node:stream";

/**
 * How long the far side may take to confirm it passed the page's end on. A
 * window that never answers would otherwise hold the connection open for good.
 */
const FINISH_TIMEOUT_MS = 30_000;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Where a tunnel's traffic goes: the app window, in the app. */
export interface TunnelHub {
  readonly post: (socket: TunnelSocket, request: DesktopPreviewTunnelRequest) => void;
  readonly forget: (socket: TunnelSocket) => void;
}

/**
 * One page connection, as a socket-shaped stream: what the page writes goes
 * to the window as `write`s, what the window sends back is what the page
 * reads. Shaped enough like a socket for Node's HTTP client to pool it.
 */
export class TunnelSocket extends Duplex {
  readonly tunnelId: string;
  private readonly hub: TunnelHub;
  private opened = false;
  /** The far side is gone, or this side let go: nothing more is sent either way. */
  private gone = false;
  /** Sent to the server and not yet acknowledged as written there. */
  private inFlight = 0;
  private heldWrite: ((error?: Error | null) => void) | null = null;
  private readonly beforeOpen: Array<{ chunk: Buffer; callback: (error?: Error | null) => void }> =
    [];
  /** Delivered bytes not yet credited, because the reader had stopped reading. */
  private owedCredit = 0;
  /** The page's end of sending, held until the far side has written everything before it. */
  private pendingFinal: ((error?: Error | null) => void) | null = null;
  private finishTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(tunnelId: string, hub: TunnelHub) {
    // Like a TCP socket's default: when the far side has finished, so has this
    // one. Node's HTTP agent counts on it to drop a pooled connection the
    // server closed, rather than handing it the next request.
    super({ allowHalfOpen: false });
    this.tunnelId = tunnelId;
    this.hub = hub;
  }

  onOpened(): void {
    if (this.opened || this.gone) return;
    this.opened = true;
    for (const { chunk, callback } of this.beforeOpen.splice(0)) {
      this.send(chunk, callback);
    }
    this.emit("connect");
  }

  onData(data: Uint8Array): void {
    if (this.gone) return;
    const chunk = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (this.push(chunk)) {
      this.hub.post(this, { type: "credit", tunnelId: this.tunnelId, bytes: chunk.length });
    } else {
      this.owedCredit += chunk.length;
    }
  }

  onEnd(): void {
    if (this.gone) return;
    this.push(null);
    // A pooled connection nobody is reading still has to notice it ended.
    if (this.readableLength === 0) this.read(0);
  }

  /** The far side wrote everything the page sent and passed its end on. */
  onFinished(): void {
    const callback = this.pendingFinal;
    this.pendingFinal = null;
    this.clearFinishTimer();
    callback?.();
  }

  private clearFinishTimer(): void {
    if (this.finishTimer !== null) clearTimeout(this.finishTimer);
    this.finishTimer = null;
  }

  /** Gives up on the tunnel from this side, telling the far side and the page why. */
  fail(message: string): void {
    this.destroy(new TunnelError(message, this.opened));
  }

  onWritten(bytes: number): void {
    this.inFlight = Math.max(0, this.inFlight - bytes);
    if (this.heldWrite !== null && this.inFlight < PREVIEW_TUNNEL_WINDOW_BYTES) {
      const callback = this.heldWrite;
      this.heldWrite = null;
      callback();
    }
  }

  /**
   * The far side is gone. With an error before it opened, the page is told
   * why; otherwise whatever was sent stays readable to the end.
   */
  onClosed(error: string | undefined): void {
    if (this.gone) return;
    this.gone = true;
    this.hub.forget(this);
    if (error !== undefined) {
      this.destroy(new TunnelError(error, this.opened));
      return;
    }
    this.push(null);
    this.heldWrite?.(new Error("The connection closed."));
    this.heldWrite = null;
    // Closed cleanly both ways, so whatever the page sent was taken.
    this.onFinished();
    if (!this.writableEnded) this.end();
  }

  get isOpen(): boolean {
    return this.opened;
  }

  private send(chunk: Buffer, callback: (error?: Error | null) => void): void {
    for (let offset = 0; offset < chunk.length; offset += PREVIEW_TUNNEL_CHUNK_BYTES) {
      const part = chunk.subarray(offset, offset + PREVIEW_TUNNEL_CHUNK_BYTES);
      this.hub.post(this, { type: "write", tunnelId: this.tunnelId, data: part });
      this.inFlight += part.length;
    }
    if (this.inFlight < PREVIEW_TUNNEL_WINDOW_BYTES) {
      callback();
    } else {
      this.heldWrite = callback;
    }
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.gone) {
      callback(new Error("The connection closed."));
    } else if (!this.opened) {
      this.beforeOpen.push({ chunk, callback });
    } else {
      this.send(chunk, callback);
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.gone) {
      callback();
      return;
    }
    // Finished only once the far side has the bytes: with the other half
    // already ended, finishing here lets the stream close itself, and closing
    // cancels the tunnel before its last writes land.
    this.pendingFinal = callback;
    this.finishTimer = setTimeout(
      () => this.fail("The other computer did not confirm the end of the connection."),
      FINISH_TIMEOUT_MS,
    );
    this.hub.post(this, { type: "end", tunnelId: this.tunnelId });
  }

  override _read(): void {
    if (this.owedCredit > 0 && !this.gone) {
      this.hub.post(this, { type: "credit", tunnelId: this.tunnelId, bytes: this.owedCredit });
      this.owedCredit = 0;
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.gone) {
      this.gone = true;
      this.hub.post(this, { type: "close", tunnelId: this.tunnelId });
      this.hub.forget(this);
    }
    // Every write and the end still waiting on the far side get their answer.
    const reason = error ?? new Error("The connection closed.");
    for (const { callback: write } of this.beforeOpen.splice(0)) write(reason);
    this.heldWrite?.(reason);
    this.heldWrite = null;
    this.pendingFinal?.(reason);
    this.pendingFinal = null;
    this.clearFinishTimer();
    callback(error);
  }

  // What Node's HTTP client and agent call on a pooled socket.
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  setTimeout(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

/** Why a tunnel failed, in words for whoever is looking at the page. */
export class TunnelError extends Error {
  readonly afterOpen: boolean;
  constructor(message: string, afterOpen: boolean) {
    super(message);
    this.afterOpen = afterOpen;
  }
}

/** Splits `host:port` or `[v6]:port` as CONNECT sends it. */
export function parseAuthority(authority: string): { host: string; port: number } | null {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(authority);
  const host = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);
  return host === undefined || !Number.isInteger(port) || port < 1 || port > 65_535
    ? null
    : { host, port };
}

/** Headers that belong to one hop, which a proxy must not pass on. */
export function endToEndRawHeaders(raw: ReadonlyArray<string>): string[] {
  const named = new Set<string>();
  for (let index = 0; index < raw.length; index += 2) {
    if (raw[index]?.toLowerCase() === "connection") {
      for (const token of (raw[index + 1] ?? "").split(",")) {
        named.add(token.trim().toLowerCase());
      }
    }
  }
  const kept: string[] = [];
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index] ?? "";
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || named.has(lower)) continue;
    kept.push(name, raw[index + 1] ?? "");
  }
  return kept;
}

/** A running proxy. Its password is what Chromium is given when it asks. */
export interface LoopbackProxyServer {
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly close: () => void;
}

/**
 * Starts a proxy on this machine's loopback whose connections are tunnels
 * made by `open`.
 */
export const startLoopbackProxyServer = (
  open: (host: string, port: number) => TunnelSocket,
): Promise<LoopbackProxyServer> =>
  new Promise((resolve, reject) => {
    const username = "threadlines";
    const password = randomBytes(24).toString("base64url");
    const authorization = Buffer.from(
      `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    );
    const authorized = (header: string | undefined) => {
      if (header === undefined) return false;
      const given = Buffer.from(header);
      return given.length === authorization.length && timingSafeEqual(given, authorization);
    };
    class TunnelAgent extends Http.Agent {
      override createConnection(options: Http.ClientRequestArgs): Duplex {
        return open(String(options.host ?? "localhost"), Number(options.port));
      }
    }
    const agent = new TunnelAgent({ keepAlive: true, maxSockets: 32 });
    const server = Http.createServer();

    // Plain http: Chromium sends the whole URL, and each request is passed
    // on over a pooled tunnel to that host.
    server.on("request", (request, response) => {
      if (!authorized(request.headers["proxy-authorization"])) {
        response.writeHead(407, { "proxy-authenticate": 'Basic realm="Threadlines"' });
        response.end();
        return;
      }
      let target: URL;
      try {
        target = new URL(request.url ?? "");
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (target.protocol !== "http:") {
        response.writeHead(400).end();
        return;
      }
      const upstream = Http.request({
        agent,
        host: target.hostname.replace(/^\[(.*)\]$/, "$1"),
        port: target.port === "" ? 80 : Number(target.port),
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers: endToEndRawHeaders(request.rawHeaders),
        setHost: false,
      });
      upstream.on("response", (answer) => {
        response.writeHead(
          answer.statusCode ?? 502,
          answer.statusMessage,
          endToEndRawHeaders(answer.rawHeaders),
        );
        // A response cut short ends the page's response too, rather than
        // leaving it waiting for bytes that will never come.
        pipeline(answer, response, () => {});
      });
      upstream.on("error", (error) => {
        if (!response.headersSent) {
          response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          response.end(`Threadlines could not open ${target.href}\n\n${error.message}\n`);
        } else {
          response.destroy();
        }
      });
      response.on("close", () => {
        if (!response.writableFinished) upstream.destroy();
      });
      request.pipe(upstream);
    });

    // https, ws and wss: a tunnel straight through to the host.
    server.on("connect", (request, client: Net.Socket, head: Buffer) => {
      if (!authorized(request.headers["proxy-authorization"])) {
        client.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Threadlines"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
        );
        return;
      }
      const authority = parseAuthority(request.url ?? "");
      if (authority === null) {
        client.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      const tunnel = open(authority.host, authority.port);
      tunnel.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) tunnel.write(head);
        tunnel.pipe(client);
        client.pipe(tunnel);
      });
      tunnel.on("error", (error) => {
        if (error instanceof TunnelError && !error.afterOpen) {
          const body = `${error.message}\n`;
          client.end(
            `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
          );
        } else {
          client.destroy();
        }
      });
      tunnel.on("close", () => {
        if (!client.writableEnded) client.end();
      });
      client.on("error", () => tunnel.destroy());
      client.on("close", () => tunnel.destroy());
    });
    server.on("clientError", (_error, socket) => socket.destroy());

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({
        port: (server.address() as Net.AddressInfo).port,
        username,
        password,
        close: () => {
          agent.destroy();
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
