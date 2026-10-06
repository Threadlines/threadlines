// @effect-diagnostics nodeBuiltinImport:off - servers on this machine to fetch from
import type { LookupAddress, LookupOptions } from "node:dns";
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { isPublicAddress, makeHttpsFetch, publicAddressLookup } from "./HttpsFetch.ts";

const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
/** Node's own proxy support for `http.Agent`: 24.5 and later, and 22.21 and later in the 22 line. */
const nodeReadsProxyEnv =
  nodeMajor === 22 ? nodeMinor >= 21 : nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 5);

describe("isPublicAddress", () => {
  it("tells the public internet from this machine and private networks", () => {
    const cases: ReadonlyArray<readonly [address: string, isPublic: boolean]> = [
      ["8.8.8.8", true],
      ["1.1.1.1", true],
      ["223.255.255.255", true],
      // Just outside each private range.
      ["9.255.255.255", true],
      ["11.0.0.0", true],
      ["100.63.255.255", true],
      ["100.128.0.0", true],
      ["169.253.255.255", true],
      ["172.15.255.255", true],
      ["172.32.0.0", true],
      ["192.167.255.255", true],
      ["192.169.0.0", true],
      // What VPN and proxy apps answer with for public names.
      ["198.18.0.1", true],
      ["0.0.0.0", false],
      ["0.1.2.3", false],
      ["10.0.0.1", false],
      ["10.255.255.255", false],
      ["100.64.0.1", false],
      ["100.127.255.255", false],
      ["127.0.0.1", false],
      ["127.255.255.254", false],
      ["169.254.169.254", false],
      ["172.16.0.1", false],
      ["172.31.255.255", false],
      ["192.168.1.1", false],
      ["224.0.0.1", false],
      ["239.255.255.250", false],
      ["240.0.0.1", false],
      ["255.255.255.255", false],

      ["2606:4700:4700::1111", true],
      ["2001:4860:4860::8888", true],
      ["fbff::1", true],
      ["fe7f::1", true],
      ["::", false],
      ["::1", false],
      ["0:0:0:0:0:0:0:1", false],
      ["fc00::1", false],
      ["fd12:3456:789a::1", false],
      ["fe80::1", false],
      ["fe80::1%en0", false],
      ["febf::1", false],
      ["ff02::1", false],

      // IPv4 written as IPv6, in both spellings.
      ["::ffff:8.8.8.8", true],
      ["::ffff:808:808", true],
      ["::ffff:127.0.0.1", false],
      ["::ffff:7f00:1", false],
      ["::ffff:10.0.0.1", false],
      ["::ffff:a9fe:a9fe", false],
      ["::ffff:192.168.1.1", false],
      ["::ffff:0.0.0.0", false],
      ["::ffff:100.64.0.1", false],
      ["::ffff:224.0.0.1", false],
      ["::127.0.0.1", false],

      // Not addresses.
      ["", false],
      ["localhost", false],
      ["example.com", false],
      ["999.1.1.1", false],
      ["1.2.3", false],
    ];
    for (const [address, isPublic] of cases) {
      expect(isPublicAddress(address), address).toBe(isPublic);
    }
  });
});

describe("publicAddressLookup", () => {
  /** What a connection is told for a name that resolves to `addresses`. */
  const ask = (addresses: Array<LookupAddress>, options: LookupOptions) =>
    new Promise<{ error?: string; address?: unknown; family?: number | undefined }>((resolve) => {
      const lookup = publicAddressLookup((_hostname, _options, callback) =>
        callback(null, addresses),
      );
      lookup("downloads.example.com", options, (error, address, family) =>
        resolve(error ? { error: error.message } : { address, family }),
      );
    });

  it("answers with a name's addresses only when every one of them is public", async () => {
    const everywhere = [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::1", family: 6 },
    ];
    // Node asks for all of them, or for one.
    expect(await ask(everywhere, { all: true })).toEqual({ address: everywhere });
    expect(await ask(everywhere, {})).toEqual({ address: "93.184.216.34", family: 4 });

    // One address inside the network among public ones is enough to refuse.
    const { error } = await ask([...everywhere, { address: "10.0.0.5", family: 4 }], { all: true });
    expect(error).toMatch(/resolves to 10\.0\.0\.5, which is not on the public internet/u);
    expect((await ask([], { all: true })).error).toMatch(/has no address/u);
  });
});

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

  it("with publicAddressesOnly, never connects to this machine or to an IP address", async () => {
    const seen: Array<string | undefined> = [];
    const origin = await serve((request, response) => {
      seen.push(request.url);
      response.writeHead(200).end("inside");
    });
    const { port } = new URL(origin);
    const fetch = makeHttpsFetch({ allowHttp: true, proxyEnv: {}, publicAddressesOnly: true });

    // A name is judged by what it resolves to.
    await expect(fetch(`http://localhost:${port}/file`, {})).rejects.toThrow(
      /not on the public internet/u,
    );
    // An address is refused as such, a public one too.
    for (const url of [
      `${origin}/file`,
      `http://[::1]:${port}/file`,
      "https://93.184.216.34/file",
      "https://[2606:4700:4700::1111]/file",
    ]) {
      await expect(fetch(url, {})).rejects.toThrow(/an IP address, not a name/u);
    }
    expect(seen).toEqual([]);
  });

  it.skipIf(!nodeReadsProxyEnv)(
    "with publicAddressesOnly, a redirect can't lead back inside the network",
    async () => {
      const seen: Array<string | undefined> = [];
      const inside = await serve((request, response) => {
        seen.push(request.url);
        response.writeHead(200).end("inside");
      });
      const { port } = new URL(inside);
      // The first hop goes out through the proxy, which is trusted; what it
      // redirects to is reached directly.
      const proxy = await serve((request, response) => {
        const location = request.url?.endsWith("/to-a-name")
          ? `http://localhost:${port}/file`
          : `${inside}/file`;
        response.writeHead(302, { location }).end();
      });
      const fetch = makeHttpsFetch({
        allowHttp: true,
        proxyEnv: { HTTP_PROXY: proxy, NO_PROXY: "localhost,127.0.0.1" },
        publicAddressesOnly: true,
      });

      await expect(fetch("http://downloads.invalid/to-a-name", {})).rejects.toThrow(
        /not on the public internet/u,
      );
      await expect(fetch("http://downloads.invalid/to-an-address", {})).rejects.toThrow(
        /an IP address, not a name/u,
      );
      expect(seen).toEqual([]);
    },
  );

  it("with allowedHosts, refuses any other host, on the first address and on a redirect", async () => {
    const seen: Array<string | undefined> = [];
    const origin = await serve((request, response) => {
      seen.push(request.url);
      if (request.url === "/elsewhere") {
        response
          .writeHead(302, { location: `http://localhost:${new URL(origin).port}/file` })
          .end();
      } else {
        response.writeHead(200).end("payload");
      }
    });
    const fetch = makeHttpsFetch({ allowHttp: true, proxyEnv: {}, allowedHosts: ["127.0.0.1"] });

    expect(await (await fetch(`${origin}/file`, {})).text()).toBe("payload");
    await expect(fetch(`${origin}/elsewhere`, {})).rejects.toThrow(/only 127\.0\.0\.1 is allowed/u);
    await expect(fetch("https://downloads.invalid/file", {})).rejects.toThrow(
      /only 127\.0\.0\.1 is allowed/u,
    );
    expect(seen).toEqual(["/file", "/elsewhere"]);
  });
});
