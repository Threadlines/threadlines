/**
 * Browser pages of another computer's threads, reaching that computer's
 * `localhost`.
 *
 * When a thread runs on another computer, its agent's `http://localhost:5173`
 * is a dev server over there. The thread's browser runs here, where the user
 * is, so its profile is given a proxy for loopback addresses only: everything
 * else goes out directly as usual. The proxy is a small HTTP proxy on this
 * machine's loopback, one per remote computer, and each connection that
 * reaches it becomes a tunnel the app window carries to that computer's
 * server over the connection it already holds (`previewTunnel.ts` in
 * contracts). The window holds the connection, so the window carries the
 * bytes; this side only speaks HTTP proxy to Chromium.
 *
 * The proxy wants a password, answered from `app.on("login")` for its own
 * address only. Without one, any program on this machine, any other user's
 * included, could reach the other computer's loopback through it.
 */
import type {
  DesktopPreviewTunnelReply,
  DesktopPreviewTunnelRequest,
  EnvironmentId,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { app, ipcMain, type IpcMainEvent, type Session, type WebContents } from "electron";
import { randomUUID } from "node:crypto";

import * as IpcChannels from "../ipc/channels.ts";
import {
  startLoopbackProxyServer,
  TunnelSocket,
  type LoopbackProxyServer,
  type TunnelHub,
} from "./loopbackProxyServer.ts";

/**
 * Everything goes direct except loopback, which goes to the proxy. Chromium
 * never proxies loopback unless told to (`<-loopback>`), and that also takes
 * in link-local addresses, which are this machine's network and stay direct.
 */
export const LOOPBACK_PROXY_BYPASS_RULES = "*,<-loopback>,169.254.0.0/16,fe80::/10";

/** How long the window may take to say a tunnel opened before the page is told it didn't. */
const TUNNEL_OPEN_TIMEOUT_MS = 20_000;

export class PreviewLoopbackProxyError extends Schema.TaggedError<PreviewLoopbackProxyError>()(
  "PreviewLoopbackProxyError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to route the browser's localhost to the other computer.";
  }
}

export interface PreviewLoopbackProxyShape {
  /**
   * Sends a browser session's loopback traffic to an environment's computer,
   * or, given null, back to this one. Waits until the session uses it.
   */
  readonly route: (
    session: Session,
    environmentId: EnvironmentId | null,
  ) => Effect.Effect<void, PreviewLoopbackProxyError>;
}

export class PreviewLoopbackProxy extends Context.Service<
  PreviewLoopbackProxy,
  PreviewLoopbackProxyShape
>()("@threadlines/desktop/preview/PreviewLoopbackProxy") {}

/** A window carrying tunnels, and the ones it carries. */
interface Provider {
  readonly contents: WebContents;
  readonly tunnelIds: Set<string>;
}

const isReply = (value: unknown): value is DesktopPreviewTunnelReply =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string" &&
  typeof (value as { tunnelId?: unknown }).tunnelId === "string";

export const make = Effect.gen(function* PreviewLoopbackProxyMake() {
  /** Windows offering to carry tunnels; the last one carries new ones. */
  const providers: Provider[] = [];
  const watched = new WeakSet<WebContents>();
  const tunnels = new Map<string, { socket: TunnelSocket; provider: Provider }>();
  const listeners = new Map<EnvironmentId, Promise<LoopbackProxyServer>>();
  const listenerByPort = new Map<number, LoopbackProxyServer>();
  const routed = new WeakMap<Session, EnvironmentId | null>();

  const hub: TunnelHub = {
    post: (socket, request) => {
      const entry = tunnels.get(socket.tunnelId);
      if (entry === undefined || entry.provider.contents.isDestroyed()) return;
      entry.provider.contents.send(IpcChannels.PREVIEW_TUNNEL_REQUEST_CHANNEL, request);
    },
    forget: (socket) => {
      const entry = tunnels.get(socket.tunnelId);
      if (entry?.socket !== socket) return;
      tunnels.delete(socket.tunnelId);
      entry.provider.tunnelIds.delete(socket.tunnelId);
    },
  };

  /** A window went: its tunnels go with it, and the one before carries new ones. */
  const dropProvider = (contents: WebContents) => {
    const index = providers.findIndex((provider) => provider.contents === contents);
    if (index === -1) return;
    const [provider] = providers.splice(index, 1);
    for (const tunnelId of provider?.tunnelIds ?? []) {
      tunnels
        .get(tunnelId)
        ?.socket.onClosed("Threadlines' window closed, and with it the way to that computer.");
    }
  };

  const open = (environmentId: EnvironmentId, host: string, port: number): TunnelSocket => {
    const tunnelId = randomUUID();
    const socket = new TunnelSocket(tunnelId, hub);
    const provider = providers.at(-1);
    if (provider === undefined || provider.contents.isDestroyed()) {
      process.nextTick(() =>
        socket.fail(`Threadlines needs its window open to reach ${host}:${port}.`),
      );
      return socket;
    }
    tunnels.set(tunnelId, { socket, provider });
    provider.tunnelIds.add(tunnelId);
    provider.contents.send(IpcChannels.PREVIEW_TUNNEL_REQUEST_CHANNEL, {
      type: "open",
      tunnelId,
      environmentId,
      host,
      port,
    } satisfies DesktopPreviewTunnelRequest);
    // Failed from this side, so the window is told to drop it too: a tunnel
    // opening late would otherwise hold a slot on the other computer.
    const timer = setTimeout(() => {
      if (!socket.isOpen) socket.fail(`${host}:${port} did not answer in time.`);
    }, TUNNEL_OPEN_TIMEOUT_MS);
    socket.once("connect", () => clearTimeout(timer));
    socket.once("close", () => clearTimeout(timer));
    return socket;
  };

  const onServe = (event: IpcMainEvent, action: unknown) => {
    const contents = event.sender;
    // A page loading again in the same window is a new page: whatever the old
    // one carried died with it.
    dropProvider(contents);
    if (action !== "start") return;
    providers.push({ contents, tunnelIds: new Set() });
    if (!watched.has(contents)) {
      watched.add(contents);
      contents.once("destroyed", () => dropProvider(contents));
      contents.on("render-process-gone", () => dropProvider(contents));
      contents.on("did-start-navigation", (details) => {
        if (details.isMainFrame && !details.isSameDocument) dropProvider(contents);
      });
    }
  };

  const onReply = (event: IpcMainEvent, reply: unknown) => {
    if (!isReply(reply)) return;
    const entry = tunnels.get(reply.tunnelId);
    // Only the window that carries a tunnel speaks for it.
    if (entry === undefined || entry.provider.contents !== event.sender) return;
    switch (reply.type) {
      case "opened":
        entry.socket.onOpened();
        return;
      case "data":
        if (reply.data instanceof Uint8Array) entry.socket.onData(reply.data);
        return;
      case "end":
        entry.socket.onEnd();
        return;
      case "written":
        if (typeof reply.bytes === "number") entry.socket.onWritten(reply.bytes);
        return;
      case "finished":
        entry.socket.onFinished();
        return;
      case "closed":
        entry.socket.onClosed(typeof reply.error === "string" ? reply.error : undefined);
        return;
    }
  };

  const onLogin = (
    event: Electron.Event,
    _contents: WebContents | null,
    _details: unknown,
    authInfo: Electron.AuthInfo,
    callback: (username?: string, password?: string) => void,
  ) => {
    if (!authInfo.isProxy || authInfo.host !== "127.0.0.1") return;
    const listener = listenerByPort.get(authInfo.port);
    if (listener === undefined) return;
    event.preventDefault();
    callback(listener.username, listener.password);
  };

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      ipcMain.on(IpcChannels.PREVIEW_TUNNEL_SERVE_CHANNEL, onServe);
      ipcMain.on(IpcChannels.PREVIEW_TUNNEL_REPLY_CHANNEL, onReply);
      app.on("login", onLogin);
    }),
    () =>
      Effect.sync(() => {
        ipcMain.removeListener(IpcChannels.PREVIEW_TUNNEL_SERVE_CHANNEL, onServe);
        ipcMain.removeListener(IpcChannels.PREVIEW_TUNNEL_REPLY_CHANNEL, onReply);
        app.removeListener("login", onLogin);
        for (const listener of listenerByPort.values()) listener.close();
        for (const { socket } of tunnels.values()) socket.destroy();
      }),
  );

  const listenerFor = (environmentId: EnvironmentId) => {
    const existing = listeners.get(environmentId);
    if (existing !== undefined) return existing;
    const started = startLoopbackProxyServer((host, port) => open(environmentId, host, port)).then(
      (listener) => {
        listenerByPort.set(listener.port, listener);
        return listener;
      },
    );
    listeners.set(environmentId, started);
    // A listener that never started is tried again next time.
    started.catch(() => listeners.delete(environmentId));
    return started;
  };

  const route: PreviewLoopbackProxyShape["route"] = (session, environmentId) =>
    Effect.tryPromise({
      try: async () => {
        const current = routed.get(session);
        if (current === environmentId || (current === undefined && environmentId === null)) {
          return;
        }
        if (environmentId === null) {
          await session.setProxy({ mode: "system" });
        } else {
          const listener = await listenerFor(environmentId);
          await session.setProxy({
            proxyRules: `http://127.0.0.1:${listener.port}`,
            proxyBypassRules: LOOPBACK_PROXY_BYPASS_RULES,
          });
        }
        // Connections already open keep going where they went before.
        await session.closeAllConnections();
        routed.set(session, environmentId);
      },
      catch: (cause) => new PreviewLoopbackProxyError({ cause }),
    });

  return PreviewLoopbackProxy.of({ route });
});

export const layer = Layer.effect(PreviewLoopbackProxy, make);
