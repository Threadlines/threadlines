// @effect-diagnostics nodeBuiltinImport:off - raw sockets speak SOCKS5 to the proxy.
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { previewProxy, type ResolvedAddress } from "./previewProxy.ts";

// A public IPv4 address this machine holds, which no private range covers.
const OWN_PUBLIC_IPV4 = "198.51.100.7";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOS>();
  return {
    ...actual,
    networkInterfaces: () => ({
      ...actual.networkInterfaces(),
      "threadlines-test": [
        {
          address: OWN_PUBLIC_IPV4,
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: `${OWN_PUBLIC_IPV4}/24`,
        },
      ],
    }),
  };
});

const PUBLIC_IPV4 = { address: "93.184.215.14", family: 4 } as const;

/** Sends a SOCKS5 greeting and CONNECT, and resolves with the reply code and the open socket. */
const connectThrough = (proxyPort: number, target: Buffer, version = 5) =>
  Effect.callback<{ readonly code: number; readonly socket: NodeNet.Socket }>((resume) => {
    const socket = NodeNet.connect(proxyPort, "127.0.0.1", () => {
      socket.write(Buffer.from([5, 1, 0]));
      socket.write(Buffer.concat([Buffer.from([version, 1, 0]), target]));
    });
    // The proxy may reset a refused connection.
    socket.on("error", () => {});
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      // Method selection (2 bytes) then the 10-byte reply.
      if (received.length >= 12) {
        socket.off("data", onData);
        resume(Effect.succeed({ code: received[3]!, socket }));
      }
    };
    socket.on("data", onData);
    socket.on("close", () => resume(Effect.succeed({ code: received[3] ?? -1, socket })));
  });

/** Opens a tunnel and returns its reply code, closing the socket. */
const replyCode = (proxyPort: number, target: Buffer, version = 5) =>
  connectThrough(proxyPort, target, version).pipe(
    Effect.map(({ code, socket }) => {
      socket.destroy();
      return code;
    }),
  );

const ipv4Target = (address: string, port: number) => {
  const target = Buffer.alloc(7);
  target[0] = 1;
  address.split(".").forEach((octet, index) => (target[1 + index] = Number(octet)));
  target.writeUInt16BE(port, 5);
  return target;
};

const ipv6Target = (port: number) => {
  const target = Buffer.alloc(19);
  target[0] = 4;
  // 2606:4700::1111, a public resolver.
  target.writeUInt16BE(0x2606, 1);
  target.writeUInt16BE(0x4700, 3);
  target.writeUInt16BE(0x1111, 15);
  target.writeUInt16BE(port, 17);
  return target;
};

const domainTarget = (host: string, port: number) => {
  const name = Buffer.from(host, "latin1");
  const target = Buffer.alloc(4 + name.length);
  target[0] = 3;
  target[1] = name.length;
  name.copy(target, 2);
  target.writeUInt16BE(port, 2 + name.length);
  return target;
};

/** `a.b.c.d` as the two hex groups of an IPv6 address that embeds it. */
const toHexPair = (address: string) => {
  const [a = 0, b = 0, c = 0, d = 0] = address.split(".").map(Number);
  return `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
};

/** A TCP echo server on loopback for the life of the scope. */
const echoServer = Effect.acquireRelease(
  Effect.callback<NodeNet.Server>((resume) => {
    const server = NodeNet.createServer((socket) => {
      socket.on("error", () => {});
      socket.pipe(socket);
    });
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.map((server) => {
    const address = server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }),
);

describe("previewProxy", () => {
  it.effect("refuses hosts outside the allowlist and address targets without resolving them", () =>
    Effect.gen(function* () {
      const resolved: Array<string> = [];
      const port = yield* previewProxy({
        resolve: async (host) => {
          resolved.push(host);
          return [PUBLIC_IPV4];
        },
      });
      for (const target of [
        domainTarget("example.com", 443),
        domainTarget("cdn.jsdelivr.net.example.com", 443),
        domainTarget("evil-unpkg.com", 443),
        ipv4Target("1.1.1.1", 443),
        ipv6Target(443),
      ]) {
        expect(yield* replyCode(port, target)).toBe(2);
      }
      expect(resolved).toEqual([]);
      // Port 0 is not a connection target, and only SOCKS5 CONNECT is spoken.
      expect(yield* replyCode(port, domainTarget("unpkg.com", 0))).toBe(7);
      expect(yield* replyCode(port, domainTarget("unpkg.com", 443), 4)).toBe(7);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses an allowed host when any address it resolves to is local, in any form", () =>
    Effect.gen(function* () {
      const local = [
        { address: "127.0.0.1", family: 4 },
        { address: "10.1.2.3", family: 4 },
        { address: "100.64.0.1", family: 4 },
        { address: "169.254.169.254", family: 4 },
        { address: "192.168.1.1", family: 4 },
        { address: OWN_PUBLIC_IPV4, family: 4 },
        { address: "::1", family: 6 },
        { address: "fe80::1", family: 6 },
        { address: "fd00::1", family: 6 },
        // IPv6 forms that carry a local IPv4 address: mapped, IPv4-compatible,
        // NAT64, local-use NAT64, 6to4, and Teredo.
        { address: "::ffff:10.0.0.1", family: 6 },
        { address: `::ffff:${toHexPair(OWN_PUBLIC_IPV4)}`, family: 6 },
        { address: "::7f00:1", family: 6 },
        { address: "64:ff9b::7f00:1", family: 6 },
        { address: "64:ff9b::a00:1", family: 6 },
        { address: `64:ff9b::${toHexPair(OWN_PUBLIC_IPV4)}`, family: 6 },
        { address: "64:ff9b:1::1", family: 6 },
        { address: "2002:7f00:1::1", family: 6 },
        { address: "2001::1", family: 6 },
      ];
      let answer: ReadonlyArray<ResolvedAddress> = [];
      const port = yield* previewProxy({ resolve: async () => answer });
      for (const address of local) {
        // One local address among public ones is enough to refuse the host.
        answer = [PUBLIC_IPV4, address];
        expect({ address, code: yield* replyCode(port, domainTarget("esm.sh", 443)) }).toEqual({
          address,
          code: 2,
        });
      }
      // A name that does not resolve is refused too.
      answer = [];
      expect(yield* replyCode(port, domainTarget("esm.sh", 443))).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.live("tunnels to an allowed host through the addresses it checked, never re-resolving", () =>
    Effect.gen(function* () {
      const echoPort = yield* echoServer;
      // The first answer passes the check; a rebinding answer that came later
      // would point at the local network.
      const resolved: Array<string> = [];
      const port = yield* previewProxy({
        resolve: async (host) => {
          resolved.push(host);
          return resolved.length === 1
            ? [{ address: "127.0.0.1", family: 4 }]
            : [{ address: "10.66.0.1", family: 4 }];
        },
        // Stands in for a public address: tests cannot leave this machine.
        isReachable: (address) => address === "127.0.0.1",
      });

      const { code, socket } = yield* connectThrough(
        port,
        domainTarget("CDN.jsdelivr.net.", echoPort),
      );
      expect(code).toBe(0);
      const echoed = yield* Effect.callback<string>((resume) => {
        socket.once("data", (chunk) => resume(Effect.succeed(chunk.toString())));
        socket.write("hello through the tunnel");
      });
      socket.destroy();

      expect(echoed).toBe("hello through the tunnel");
      expect(resolved).toEqual(["cdn.jsdelivr.net"]);
    }).pipe(Effect.scoped),
  );

  it.effect("fails instead of crashing when it cannot listen", () =>
    Effect.gen(function* () {
      const exhausted = Object.assign(new Error("too many open files"), { code: "EMFILE" });
      const listen = vi
        .spyOn(NodeNet.Server.prototype, "listen")
        .mockImplementationOnce(function (this: NodeNet.Server) {
          process.nextTick(() => this.emit("error", exhausted));
          return this;
        });
      const error = yield* previewProxy().pipe(Effect.flip, Effect.scoped);
      listen.mockRestore();
      expect(error).toBe(exhausted);
    }),
  );

  it.effect("closes every connection when its scope closes", () =>
    Effect.gen(function* () {
      const socket = yield* Effect.scoped(
        Effect.gen(function* () {
          const port = yield* previewProxy();
          return yield* Effect.callback<NodeNet.Socket>((resume) => {
            // A client mid-handshake, which the proxy must not wait on; closing
            // resets it.
            const client = NodeNet.connect(port, "127.0.0.1", () => {
              client.write(Buffer.from([5, 1, 0]));
              resume(Effect.succeed(client));
            });
            client.on("error", () => {});
          });
        }),
      );
      yield* Effect.callback<void>((resume) => {
        if (socket.closed) return resume(Effect.void);
        socket.once("close", () => resume(Effect.void));
      });
      expect(socket.closed).toBe(true);
    }),
  );
});
