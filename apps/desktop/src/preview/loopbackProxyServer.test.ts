import { randomUUID } from "node:crypto";
import * as Http from "node:http";
import * as Net from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  endToEndRawHeaders,
  parseAuthority,
  startLoopbackProxyServer,
  TunnelSocket,
  type LoopbackProxyServer,
  type TunnelHub,
} from "./loopbackProxyServer.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * Tunnels that go straight to this machine's loopback, standing in for the
 * app window and the other computer's server: what the proxy sends is what a
 * real tunnel would carry, and the far side answers as a real server would.
 */
function directTunnels(refuse?: string) {
  const opened: Array<{ host: string; port: number }> = [];
  const peers = new Map<string, Net.Socket>();
  const hub: TunnelHub = {
    post: (tunnel, request) => {
      const peer = peers.get(tunnel.tunnelId);
      if (peer === undefined) return;
      if (request.type === "write") {
        peer.write(request.data, () => tunnel.onWritten(request.data.length));
      } else if (request.type === "end") {
        peer.end(() => tunnel.onFinished());
      } else if (request.type === "close") {
        peer.destroy();
      }
    },
    forget: (tunnel) => peers.delete(tunnel.tunnelId),
  };
  const open = (host: string, port: number) => {
    opened.push({ host, port });
    const tunnel = new TunnelSocket(randomUUID(), hub);
    if (refuse !== undefined) {
      setImmediate(() => tunnel.onClosed(refuse));
      return tunnel;
    }
    const peer = Net.connect({ host: "127.0.0.1", port, allowHalfOpen: true });
    peers.set(tunnel.tunnelId, peer);
    peer.on("connect", () => tunnel.onOpened());
    peer.on("data", (data) => tunnel.onData(data));
    peer.on("end", () => tunnel.onEnd());
    peer.on("close", () => tunnel.onClosed(undefined));
    peer.on("error", (error) => tunnel.onClosed(error.message));
    return tunnel;
  };
  return { open, opened, live: () => peers.size };
}

async function startProxy(open: (host: string, port: number) => TunnelSocket) {
  const proxy = await startLoopbackProxyServer(open);
  cleanups.push(proxy.close);
  return proxy;
}

async function startServer(handler: Http.RequestListener) {
  const server = Http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return (server.address() as Net.AddressInfo).port;
}

const credentials = (proxy: LoopbackProxyServer) =>
  `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}`;

/** A plain http request the way Chromium sends one through a proxy. */
function getThrough(proxy: LoopbackProxyServer, url: string, authorization?: string) {
  return new Promise<{ status: number; headers: Http.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const request = Http.request({
        host: "127.0.0.1",
        port: proxy.port,
        path: url,
        // Chromium names the page's host, not the proxy's.
        headers: {
          host: new URL(url).host,
          ...(authorization === undefined ? {} : { "proxy-authorization": authorization }),
        },
      });
      request.on("response", (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      });
      request.on("error", reject);
      request.end();
    },
  );
}

/** A CONNECT the way Chromium opens one for https and WebSockets. */
function connectThrough(proxy: LoopbackProxyServer, authority: string, authorization?: string) {
  return new Promise<{ status: number; socket: Net.Socket; body: string }>((resolve, reject) => {
    const request = Http.request({
      host: "127.0.0.1",
      port: proxy.port,
      method: "CONNECT",
      path: authority,
      headers: authorization === undefined ? {} : { "proxy-authorization": authorization },
    });
    request.on("connect", (response, socket) => {
      let body = "";
      socket.on("data", (chunk) => (body += chunk.toString("utf8")));
      setTimeout(() => resolve({ status: response.statusCode ?? 0, socket, body }), 50);
    });
    request.on("error", reject);
    request.end();
  });
}

describe("parseAuthority", () => {
  it("reads names, addresses and bracketed IPv6", () => {
    expect(parseAuthority("localhost:5173")).toEqual({ host: "localhost", port: 5173 });
    expect(parseAuthority("127.0.0.1:443")).toEqual({ host: "127.0.0.1", port: 443 });
    expect(parseAuthority("[::1]:8080")).toEqual({ host: "::1", port: 8080 });
    expect(parseAuthority("localhost")).toBeNull();
    expect(parseAuthority("localhost:70000")).toBeNull();
  });
});

describe("endToEndRawHeaders", () => {
  it("drops headers that belong to one hop, including ones Connection names", () => {
    expect(
      endToEndRawHeaders([
        "Host",
        "localhost:5173",
        "Proxy-Authorization",
        "Basic x",
        "Connection",
        "keep-alive, X-Hop",
        "X-Hop",
        "1",
        "Set-Cookie",
        "a=1",
        "Set-Cookie",
        "b=2",
      ]),
    ).toEqual(["Host", "localhost:5173", "Set-Cookie", "a=1", "Set-Cookie", "b=2"]);
  });
});

describe("startLoopbackProxyServer", () => {
  it("asks for its password before passing anything on", async () => {
    const tunnels = directTunnels();
    const proxy = await startProxy(tunnels.open);
    const port = await startServer((_request, response) => response.end("ok"));

    expect((await getThrough(proxy, `http://localhost:${port}/`)).status).toBe(407);
    expect(
      (await getThrough(proxy, `http://localhost:${port}/`, "Basic d3Jvbmc6cGFzcw==")).status,
    ).toBe(407);
    const refused = await connectThrough(proxy, `localhost:${port}`);
    expect(refused.status).toBe(407);
    refused.socket.destroy();
    expect(tunnels.opened).toEqual([]);
  });

  it("passes plain http on, keeping the page's own headers and the server's", async () => {
    const tunnels = directTunnels();
    const proxy = await startProxy(tunnels.open);
    let seenHost: string | undefined;
    let sawProxyHeader = false;
    const port = await startServer((request, response) => {
      seenHost = request.headers.host;
      sawProxyHeader = request.headers["proxy-authorization"] !== undefined;
      response.setHeader("set-cookie", ["a=1", "b=2"]);
      response.end(`you asked for ${request.url}`);
    });

    const answer = await getThrough(proxy, `http://localhost:${port}/app?x=1`, credentials(proxy));
    expect(answer.status).toBe(200);
    expect(answer.body).toBe("you asked for /app?x=1");
    expect(answer.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
    expect(seenHost).toBe(`localhost:${port}`);
    expect(sawProxyHeader).toBe(false);
    expect(tunnels.opened).toEqual([{ host: "localhost", port }]);
  });

  it("lets go of a pooled connection the server closed, and opens a new one", async () => {
    const tunnels = directTunnels();
    const proxy = await startProxy(tunnels.open);
    const server = Http.createServer((_request, response) => response.end("ok"));
    // A dev server drops idle connections; the next request must not land on one.
    server.keepAliveTimeout = 50;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => {
      server.closeAllConnections();
      server.close();
    });
    const port = (server.address() as Net.AddressInfo).port;

    // Two at once, as a page and its favicon go out.
    const first = await Promise.all([
      getThrough(proxy, `http://localhost:${port}/a`, credentials(proxy)),
      getThrough(proxy, `http://localhost:${port}/favicon.ico`, credentials(proxy)),
    ]);
    expect(first.map((answer) => answer.body)).toEqual(["ok", "ok"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(tunnels.live()).toBe(0);
    expect((await getThrough(proxy, `http://localhost:${port}/b`, credentials(proxy))).body).toBe(
      "ok",
    );
    expect(tunnels.opened).toHaveLength(3);
  });

  it("opens a straight tunnel for CONNECT", async () => {
    const tunnels = directTunnels();
    const proxy = await startProxy(tunnels.open);
    const echo = Net.createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => echo.close());
    const port = (echo.address() as Net.AddressInfo).port;

    const { status, socket } = await connectThrough(proxy, `localhost:${port}`, credentials(proxy));
    expect(status).toBe(200);
    const echoed = new Promise<string>((resolve) =>
      socket.once("data", (data) => resolve(String(data))),
    );
    socket.write("ping");
    expect(await echoed).toBe("ping");
    socket.destroy();
  });

  it("tells the page why the far side could not be reached", async () => {
    const reason = "Nothing is listening on localhost:5999 on the Mac.";
    const proxy = await startProxy(directTunnels(reason).open);

    const page = await getThrough(proxy, "http://localhost:5999/", credentials(proxy));
    expect(page.status).toBe(502);
    expect(page.body).toContain(reason);

    const secure = await connectThrough(proxy, "localhost:5999", credentials(proxy));
    expect(secure.status).toBe(502);
    secure.socket.destroy();
  });
});
