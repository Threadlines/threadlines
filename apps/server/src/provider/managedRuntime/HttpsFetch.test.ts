import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { makeHttpsFetch } from "./HttpsFetch.ts";

const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
/** Node's own proxy support for `http.Agent`: 24.5 and later, and 22.21 and later in the 22 line. */
const nodeReadsProxyEnv =
  nodeMajor === 22 ? nodeMinor >= 21 : nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 5);

describe("makeHttpsFetch", () => {
  const servers: Array<http.Server> = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  });

  /** A server on this machine, and its origin. */
  const serve = async (handler: http.RequestListener) => {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  it("follows redirects to the file, relative ones included", async () => {
    const seen: Array<string> = [];
    const origin = await serve((request, response) => {
      seen.push(`${request.url} ${request.headers["accept-encoding"]}`);
      if (request.url === "/start") {
        response.writeHead(302, { location: "/moved" }).end();
      } else if (request.url === "/moved") {
        response.writeHead(307, { location: `http://${request.headers.host}/file` }).end();
      } else {
        response.writeHead(200, { "content-length": "7" }).end("payload");
      }
    });

    const response = await makeHttpsFetch({ allowHttp: true, proxyEnv: {} })(`${origin}/start`, {
      headers: { "accept-encoding": "identity" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("7");
    expect(await response.text()).toBe("payload");
    expect(seen).toEqual(["/start identity", "/moved identity", "/file identity"]);
  });

  it("gives up after five redirects", async () => {
    let requests = 0;
    const origin = await serve((_request, response) => {
      requests += 1;
      response.writeHead(302, { location: "/again" }).end();
    });

    await expect(
      makeHttpsFetch({ allowHttp: true, proxyEnv: {} })(`${origin}/again`, {}),
    ).rejects.toThrow(/5 redirects/u);
    expect(requests).toBe(6);
  });

  it("refuses anything but https, on the first address and on a redirect", async () => {
    await expect(makeHttpsFetch()("http://127.0.0.1:9/file", {})).rejects.toThrow(/only https/u);
    await expect(makeHttpsFetch()("https://user:secret@example.com/file", {})).rejects.toThrow(
      /sign-in/u,
    );
    const origin = await serve((_request, response) => {
      response.writeHead(302, { location: "ftp://example.com/file" }).end();
    });
    await expect(
      makeHttpsFetch({ allowHttp: true, proxyEnv: {} })(`${origin}/start`, {}),
    ).rejects.toThrow(/only https/u);
  });

  it("fails, rather than waiting forever, when the server switches protocols", async () => {
    const server = net.createServer((socket) => {
      socket.once("data", () => {
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await expect(
        makeHttpsFetch({ allowHttp: true, proxyEnv: {} })(`${origin}/file`, {}),
      ).rejects.toThrow(/protocol switch/u);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  it.skipIf(!nodeReadsProxyEnv)("goes through the proxy the environment names", async () => {
    const proxied: Array<string | undefined> = [];
    const proxy = await serve((request, response) => {
      // A proxy is asked for the whole address, not just the path.
      proxied.push(request.url);
      response.writeHead(200).end("from the proxy");
    });

    const response = await makeHttpsFetch({ allowHttp: true, proxyEnv: { HTTP_PROXY: proxy } })(
      "http://downloads.invalid/file",
      {},
    );

    expect(await response.text()).toBe("from the proxy");
    expect(proxied).toEqual(["http://downloads.invalid/file"]);
  });
});
